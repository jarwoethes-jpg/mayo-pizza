import type { CtrlMessage } from "shared";
import {
  type CtrlHandler,
  type CtrlMessageType,
  type CtrlProtocol,
  createCtrlProtocol,
} from "./protocol";
import type { SignalingClient } from "./signaling";

export const LOW_THRESHOLD = 1 * 1024 * 1024;

export type PeerRole = "uploader" | "downloader";

export interface Observable<T> {
  readonly value: T;
  subscribe(listener: (value: T) => void): () => void;
}

class ObservableValue<T> implements Observable<T> {
  private currentValue: T;
  private readonly listeners = new Set<(value: T) => void>();

  public constructor(initialValue: T) {
    this.currentValue = initialValue;
  }

  public get value(): T {
    return this.currentValue;
  }

  public set value(nextValue: T) {
    if (Object.is(this.currentValue, nextValue)) {
      return;
    }
    this.currentValue = nextValue;
    for (const listener of this.listeners) {
      listener(nextValue);
    }
  }

  public subscribe(listener: (value: T) => void): () => void {
    this.listeners.add(listener);
    listener(this.currentValue);
    return () => this.listeners.delete(listener);
  }
}

export class RemoteIceCandidateQueue {
  private readonly pending: RTCIceCandidateInit[] = [];

  public get size(): number {
    return this.pending.length;
  }

  public enqueue(candidate: RTCIceCandidateInit): void {
    this.pending.push(candidate);
  }

  public async flush(
    addCandidate: (candidate: RTCIceCandidateInit) => Promise<void> | void,
  ): Promise<void> {
    const candidates = this.pending.splice(0);
    for (const candidate of candidates) {
      await addCandidate(candidate);
    }
  }
}

export interface PeerError {
  error: Error;
}

export interface PeerEventMap {
  "ctrl-open": undefined;
  "data-open": undefined;
  pong: Extract<CtrlMessage, { t: "pong" }>;
  error: PeerError;
}

type PeerEventName = keyof PeerEventMap;
type PeerEventListener<K extends PeerEventName> = (
  payload: PeerEventMap[K],
) => void;

interface PendingCtrlHandler {
  type: CtrlMessageType;
  handler: CtrlHandler<CtrlMessageType>;
}

export interface PeerConnection {
  readonly connectionState: Observable<RTCPeerConnectionState>;
  readonly iceConnectionState: Observable<RTCIceConnectionState>;
  readonly ctrl: CtrlProtocol | undefined;
  readonly data: RTCDataChannel | undefined;
  readonly maxMessageSize: number | undefined;
  readonly ready: Promise<void>;
  on<K extends PeerEventName>(
    event: K,
    listener: PeerEventListener<K>,
  ): () => void;
  onCtrl<T extends CtrlMessageType>(
    type: T,
    handler: CtrlHandler<T>,
  ): () => void;
  sendPing(nonce?: string): string;
  close(): void;
}

const isForceRelayEnabled = (): boolean =>
  (typeof window !== "undefined" && window.__MAYO_FORCE_RELAY__ === true) ||
  import.meta.env.VITE_MAYO_FORCE_RELAY === "1";

const isCandidatePayload = (
  payload: unknown,
): payload is RTCIceCandidateInit => {
  if (typeof payload !== "object" || payload === null) {
    return false;
  }
  const candidate = payload as { candidate?: unknown };
  return typeof candidate.candidate === "string";
};

const getDescription = (
  payload: unknown,
): RTCSessionDescriptionInit | undefined => {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }
  const candidate = payload as { type?: unknown; sdp?: unknown };
  if (
    (candidate.type !== "offer" && candidate.type !== "answer") ||
    typeof candidate.sdp !== "string"
  ) {
    return undefined;
  }
  return { type: candidate.type, sdp: candidate.sdp };
};

const makeNonce = (): string => {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

class PeerConnectionImpl implements PeerConnection {
  private readonly eventListeners: {
    [K in PeerEventName]: Set<PeerEventListener<K>>;
  } = {
    "ctrl-open": new Set(),
    "data-open": new Set(),
    pong: new Set(),
    error: new Set(),
  };
  private readonly signalingUnsubscribers: Array<() => void> = [];
  private readonly remoteCandidates = new RemoteIceCandidateQueue();
  private readonly pendingCtrlHandlers: PendingCtrlHandler[] = [];
  private readonly bufferedSignals: Array<{
    from: string;
    payload?: unknown;
  }> = [];
  private readonly connectionStateValue =
    new ObservableValue<RTCPeerConnectionState>("new");
  private readonly iceConnectionStateValue =
    new ObservableValue<RTCIceConnectionState>("new");
  private readonly role: PeerRole;
  private readonly signaling: SignalingClient;
  private peerConnection: RTCPeerConnection | undefined;
  private ctrlProtocol: CtrlProtocol | undefined;
  private ctrlChannel: RTCDataChannel | undefined;
  private dataChannel: RTCDataChannel | undefined;
  private remotePeerId: string | undefined;
  private remoteDescriptionSet = false;
  private localCandidates: RTCIceCandidateInit[] = [];
  private offerStarted = false;
  private startPromise: Promise<void> | undefined;
  private signalChain = Promise.resolve();
  private closed = false;

  public readonly connectionState = this.connectionStateValue;
  public readonly iceConnectionState = this.iceConnectionStateValue;
  public readonly ready: Promise<void>;

  public constructor(role: PeerRole, signaling: SignalingClient) {
    this.role = role;
    this.signaling = signaling;
    this.signalingUnsubscribers.push(
      signaling.on("peer-joined", (message) => {
        this.setRemotePeer(message.peerId);
        void this.maybeCreateOffer();
      }),
      signaling.on("signal", (message) => {
        this.remotePeerId ??= message.from;
        if (this.peerConnection === undefined) {
          this.bufferedSignals.push(message);
          return;
        }
        this.signalChain = this.signalChain
          .then(() => this.processSignal(message.from, message.payload))
          .catch((error: unknown) => this.emitError(error));
      }),
      signaling.on("peer-left", (message) => {
        if (message.peerId === this.remotePeerId) {
          this.close();
        }
      }),
      signaling.on("transport-error", ({ error }) => this.emitError(error)),
      signaling.on("protocol-error", ({ message }) =>
        this.emitError(new Error(message)),
      ),
      signaling.on("error", (message) =>
        this.emitError(new Error(`${message.code}: ${message.message}`)),
      ),
    );
    this.ready = this.start();
    void this.ready.catch(() => undefined);
  }

  public get ctrl(): CtrlProtocol | undefined {
    return this.ctrlProtocol;
  }

  public get data(): RTCDataChannel | undefined {
    return this.dataChannel;
  }

  public get maxMessageSize(): number | undefined {
    return this.peerConnection?.sctp?.maxMessageSize;
  }

  public start(): Promise<void> {
    if (this.startPromise !== undefined) {
      return this.startPromise;
    }
    this.startPromise = this.initialize();
    return this.startPromise;
  }

  public on<K extends PeerEventName>(
    event: K,
    listener: PeerEventListener<K>,
  ): () => void {
    const listeners = this.eventListeners[event] as Set<PeerEventListener<K>>;
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  public onCtrl<T extends CtrlMessageType>(
    type: T,
    handler: CtrlHandler<T>,
  ): () => void {
    if (this.ctrlProtocol === undefined) {
      const pending: PendingCtrlHandler = {
        type,
        handler: handler as unknown as CtrlHandler<CtrlMessageType>,
      };
      this.pendingCtrlHandlers.push(pending);
      return () => {
        const index = this.pendingCtrlHandlers.indexOf(pending);
        if (index !== -1) {
          this.pendingCtrlHandlers.splice(index, 1);
        }
      };
    }
    return this.ctrlProtocol.on(type, handler);
  }

  public sendPing(nonce = makeNonce()): string {
    if (this.ctrlProtocol === undefined || this.ctrlProtocolReady() === false) {
      throw new Error("The ctrl data channel is not open.");
    }
    this.ctrlProtocol.send({ t: "ping", nonce });
    return nonce;
  }

  public close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const unsubscribe of this.signalingUnsubscribers) {
      unsubscribe();
    }
    this.ctrlProtocol?.dispose();
    this.peerConnection?.close();
    this.connectionStateValue.value = "closed";
  }

  private async initialize(): Promise<void> {
    const iceServers = await this.signaling.requestIceConfig();
    if (this.closed) {
      return;
    }

    const configuration: RTCConfiguration = {
      iceServers: iceServers.map((server) => ({
        urls: server.urls,
        ...(server.username === undefined ? {} : { username: server.username }),
        ...(server.credential === undefined
          ? {}
          : { credential: server.credential }),
      })),
      ...(isForceRelayEnabled()
        ? { iceTransportPolicy: "relay" as const }
        : {}),
    };
    const peerConnection = new RTCPeerConnection(configuration);
    this.peerConnection = peerConnection;
    peerConnection.onconnectionstatechange = () => {
      this.connectionStateValue.value = peerConnection.connectionState;
    };
    peerConnection.oniceconnectionstatechange = () => {
      this.iceConnectionStateValue.value = peerConnection.iceConnectionState;
    };
    peerConnection.onicecandidate = (event) => {
      if (event.candidate === null) {
        return;
      }
      this.sendLocalCandidate(event.candidate.toJSON());
    };
    peerConnection.ondatachannel = (event) => {
      this.attachDataChannel(event.channel);
    };

    if (this.role === "uploader") {
      const ctrl = peerConnection.createDataChannel("ctrl", { ordered: true });
      const data = peerConnection.createDataChannel("data", { ordered: true });
      this.attachCtrlChannel(ctrl);
      this.attachDataChannel(data);
    }

    const bufferedSignals = this.bufferedSignals.splice(0);
    for (const signal of bufferedSignals) {
      await this.processSignal(signal.from, signal.payload);
    }
    await this.maybeCreateOffer();
  }

  private attachDataChannel(channel: RTCDataChannel): void {
    if (channel.label === "ctrl") {
      this.attachCtrlChannel(channel);
      return;
    }
    if (channel.label === "data") {
      channel.binaryType = "arraybuffer";
      channel.bufferedAmountLowThreshold = LOW_THRESHOLD;
      this.dataChannel = channel;
      const onOpen = (): void => this.emit("data-open", undefined);
      channel.addEventListener("open", onOpen);
      if (channel.readyState === "open") {
        onOpen();
      }
    }
  }

  private attachCtrlChannel(channel: RTCDataChannel): void {
    if (channel.label !== "ctrl") {
      return;
    }
    this.ctrlProtocol?.dispose();
    this.ctrlChannel = channel;
    this.ctrlProtocol = createCtrlProtocol(channel, {
      onInvalidFrame: (raw) =>
        this.emitError(new Error(`Invalid ctrl frame: ${String(raw)}`)),
    });
    this.ctrlProtocol.on("ping", ({ nonce }) => {
      if (this.ctrlProtocolReady()) {
        this.ctrlProtocol?.send({ t: "pong", nonce });
      }
    });
    this.ctrlProtocol.on("pong", (message) => this.emit("pong", message));
    const pendingHandlers = this.pendingCtrlHandlers.splice(0);
    for (const pending of pendingHandlers) {
      this.ctrlProtocol.on(pending.type, pending.handler);
    }

    const onOpen = (): void => this.emit("ctrl-open", undefined);
    channel.addEventListener("open", onOpen);
    if (channel.readyState === "open") {
      onOpen();
    }
  }

  private ctrlProtocolReady(): boolean {
    return (
      this.ctrlProtocol !== undefined &&
      this.getCtrlChannel()?.readyState === "open"
    );
  }

  private getCtrlChannel(): RTCDataChannel | undefined {
    return this.ctrlChannel;
  }

  private setRemotePeer(peerId: string): void {
    this.remotePeerId = peerId;
    const candidates = this.localCandidates.splice(0);
    for (const candidate of candidates) {
      void this.signaling
        .sendSignal(peerId, candidate)
        .catch((error: unknown) => this.emitError(error));
    }
  }

  private sendLocalCandidate(candidate: RTCIceCandidateInit): void {
    if (this.remotePeerId === undefined) {
      this.localCandidates.push(candidate);
      return;
    }
    void this.signaling
      .sendSignal(this.remotePeerId, candidate)
      .catch((error: unknown) => this.emitError(error));
  }

  private async maybeCreateOffer(): Promise<void> {
    if (
      this.role !== "uploader" ||
      this.offerStarted ||
      this.peerConnection === undefined ||
      this.remotePeerId === undefined
    ) {
      return;
    }
    this.offerStarted = true;
    const offer = await this.peerConnection.createOffer();
    await this.peerConnection.setLocalDescription(offer);
    await this.sendLocalDescription();
  }

  private async processSignal(from: string, payload: unknown): Promise<void> {
    const peerConnection = this.peerConnection;
    if (peerConnection === undefined) {
      this.bufferedSignals.push({ from, payload });
      return;
    }
    this.remotePeerId ??= from;
    if (isCandidatePayload(payload)) {
      if (!this.remoteDescriptionSet) {
        this.remoteCandidates.enqueue(payload);
      } else {
        await peerConnection.addIceCandidate(payload);
      }
      return;
    }

    const description = getDescription(payload);
    if (description === undefined) {
      throw new Error("The peer sent an invalid SDP or ICE payload.");
    }
    await peerConnection.setRemoteDescription(description);
    this.remoteDescriptionSet = true;
    await this.remoteCandidates.flush((candidate) =>
      peerConnection.addIceCandidate(candidate),
    );

    if (this.role === "downloader" && description.type === "offer") {
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      await this.sendLocalDescription();
    }
  }

  private async sendLocalDescription(): Promise<void> {
    const peerConnection = this.peerConnection;
    if (peerConnection === undefined || this.remotePeerId === undefined) {
      throw new Error(
        "Cannot signal a local description before a peer is known.",
      );
    }
    const description = peerConnection.localDescription;
    if (description === null) {
      throw new Error("The local description is missing.");
    }
    await this.signaling.sendSignal(this.remotePeerId, {
      type: description.type,
      sdp: description.sdp,
    });
  }

  private emitError(error: unknown): void {
    const normalized =
      error instanceof Error ? error : new Error(String(error));
    this.emit("error", { error: normalized });
  }

  private emit<K extends PeerEventName>(
    event: K,
    payload: PeerEventMap[K],
  ): void {
    const listeners = this.eventListeners[event] as Set<PeerEventListener<K>>;
    for (const listener of listeners) {
      listener(payload);
    }
  }
}

export const createPeer = (
  role: PeerRole,
  signaling: SignalingClient,
): PeerConnection => new PeerConnectionImpl(role, signaling);
