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

  public clear(): void {
    this.pending.length = 0;
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
  "peer-gone": { peerId: string };
  reconnecting: undefined;
  resuming: undefined;
  exhausted: { error?: Error };
  pong: Extract<CtrlMessage, { t: "pong" }>;
  error: PeerError;
}

type PeerEventName = keyof PeerEventMap;
type PeerEventListener<K extends PeerEventName> = (
  payload: PeerEventMap[K],
) => void;

interface RegisteredCtrlHandler {
  type: CtrlMessageType;
  handler: CtrlHandler<CtrlMessageType>;
  unsubscribeCurrent?: () => void;
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
  /** Test-only hook for forcing the same recovery path as a broken network. */
  debugDrop(): void;
  /** Returns the current peer stats for best-effort route reporting. */
  getStats(): Promise<RTCStatsReport>;
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

const isRebuildPayload = (payload: unknown): boolean =>
  typeof payload === "object" &&
  payload !== null &&
  (payload as { mayo?: unknown }).mayo === "rebuild";

const makeNonce = (): string => {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

/**
 * Owns one WebRTC generation and its recovery ladder. A disconnected ICE
 * state gets three seconds to heal; failed ICE first tries an ICE restart,
 * then replaces the entire peer connection. Five consecutive restart/rebuild
 * failures are terminal so a partial transfer can be discarded by its owner.
 */
class PeerConnectionImpl implements PeerConnection {
  private readonly eventListeners: {
    [K in PeerEventName]: Set<PeerEventListener<K>>;
  } = {
    "ctrl-open": new Set(),
    "data-open": new Set(),
    "peer-gone": new Set(),
    reconnecting: new Set(),
    resuming: new Set(),
    exhausted: new Set(),
    pong: new Set(),
    error: new Set(),
  };
  private readonly signalingUnsubscribers: Array<() => void> = [];
  private readonly registeredCtrlHandlers: RegisteredCtrlHandler[] = [];
  private remoteCandidates = new RemoteIceCandidateQueue();
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
  private configuration: RTCConfiguration | undefined;
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
  private signalingOpen = false;
  private disconnectedTimer:
    | ReturnType<typeof globalThis.setTimeout>
    | undefined;
  private recoveryTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  private recoveryAttempt = 0;
  private recoveryInFlight = false;
  private rebuildPending = false;
  private rebuildInFlight = false;
  private rebuildAgainPending = false;
  private rebuildAgainSignal = false;
  private rebuildPromise: Promise<void> | undefined;

  public readonly connectionState = this.connectionStateValue;
  public readonly iceConnectionState = this.iceConnectionStateValue;
  public readonly ready: Promise<void>;

  public constructor(role: PeerRole, signaling: SignalingClient) {
    this.role = role;
    this.signaling = signaling;
    this.signalingOpen = signaling.isOpen;
    this.signalingUnsubscribers.push(
      signaling.on("open", () => {
        this.signalingOpen = true;
      }),
      signaling.on("close", () => {
        this.signalingOpen = false;
        if (!this.closed) {
          this.rebuildPending = true;
          this.emit("reconnecting", undefined);
        }
      }),
      signaling.on("room-resumed", () => {
        if (this.closed) {
          return;
        }
        // Peer ids change on rejoin; always re-derive the remote id from the
        // next peer-joined/signal event instead of reusing the stale id.
        this.remotePeerId = undefined;
        this.rebuildPending = true;
        this.emit("resuming", undefined);
      }),
      signaling.on("peer-joined", (message) => {
        this.setRemotePeer(message.peerId);
        void this.maybeCreateOffer().catch((error: unknown) =>
          this.emitError(error),
        );
      }),
      signaling.on("signal", (message) => {
        if (this.peerConnection === undefined || this.rebuildPending) {
          this.bufferedSignals.push(message);
          return;
        }
        this.remotePeerId ??= message.from;
        this.signalChain = this.signalChain
          .then(() => this.processSignal(message.from, message.payload))
          .catch((error: unknown) => this.emitError(error));
      }),
      signaling.on("peer-left", (message) => {
        if (message.peerId === this.remotePeerId) {
          this.clearRecoveryTimers();
          this.recoveryAttempt = 0;
          this.recoveryInFlight = false;
          this.ctrlProtocol?.dispose();
          this.peerConnection?.close();
          this.peerConnection = undefined;
          this.ctrlProtocol = undefined;
          this.ctrlChannel = undefined;
          this.dataChannel = undefined;
          this.remoteDescriptionSet = false;
          this.remoteCandidates = new RemoteIceCandidateQueue();
          this.localCandidates = [];
          this.offerStarted = false;
          this.connectionStateValue.value = "connecting";
          this.iceConnectionStateValue.value = "new";
          this.remotePeerId = undefined;
          this.rebuildPending = true;
          this.emit("peer-gone", { peerId: message.peerId });
          this.emit("reconnecting", undefined);
        }
      }),
      signaling.on("transport-error", ({ error }) => this.emitError(error)),
      signaling.on("protocol-error", ({ message }) =>
        this.emitError(new Error(message)),
      ),
      signaling.on("error", (message) => {
        if (message.code === "BAD_SLUG") {
          const error = new Error(`${message.code}: ${message.message}`);
          this.emitError(error);
          this.emitExhausted(error);
          return;
        }
        this.emitError(new Error(`${message.code}: ${message.message}`));
      }),
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
    const registered: RegisteredCtrlHandler = {
      type,
      handler: handler as unknown as CtrlHandler<CtrlMessageType>,
    };
    this.registeredCtrlHandlers.push(registered);
    if (this.ctrlProtocol !== undefined) {
      registered.unsubscribeCurrent = this.ctrlProtocol.on(type, handler);
    }
    return () => {
      registered.unsubscribeCurrent?.();
      const index = this.registeredCtrlHandlers.indexOf(registered);
      if (index !== -1) {
        this.registeredCtrlHandlers.splice(index, 1);
      }
    };
  }

  public sendPing(nonce = makeNonce()): string {
    if (this.ctrlProtocol === undefined || this.ctrlProtocolReady() === false) {
      throw new Error("The ctrl data channel is not open.");
    }
    this.ctrlProtocol.send({ t: "ping", nonce });
    return nonce;
  }

  public debugDrop(): void {
    this.peerConnection?.close();
  }

  public async getStats(): Promise<RTCStatsReport> {
    if (this.peerConnection === undefined) {
      return new Map() as RTCStatsReport;
    }
    return this.peerConnection.getStats();
  }

  public close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.clearRecoveryTimers();
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

    this.configuration = {
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
    await this.replacePeerConnection(false, true);
  }

  private async replacePeerConnection(
    sendRebuildSignal: boolean,
    createInitialOffer: boolean,
  ): Promise<void> {
    if (this.closed || this.configuration === undefined) {
      return;
    }
    const previous = this.peerConnection;
    previous?.close();
    this.ctrlProtocol?.dispose();
    this.peerConnection = undefined;
    this.ctrlProtocol = undefined;
    this.ctrlChannel = undefined;
    this.dataChannel = undefined;
    this.remoteDescriptionSet = false;
    this.remoteCandidates = new RemoteIceCandidateQueue();
    this.localCandidates = [];
    this.offerStarted = false;
    this.connectionStateValue.value = "connecting";
    this.iceConnectionStateValue.value = "new";

    const peerConnection = new RTCPeerConnection(this.configuration);
    this.peerConnection = peerConnection;
    peerConnection.onconnectionstatechange = () => {
      if (this.peerConnection !== peerConnection) {
        return;
      }
      this.connectionStateValue.value = peerConnection.connectionState;
      if (peerConnection.connectionState === "connected") {
        this.resetRecovery();
      } else if (
        peerConnection.connectionState === "disconnected" ||
        peerConnection.connectionState === "failed"
      ) {
        this.handleConnectionDrop(peerConnection.connectionState);
      }
    };
    peerConnection.oniceconnectionstatechange = () => {
      if (this.peerConnection !== peerConnection) {
        return;
      }
      this.iceConnectionStateValue.value = peerConnection.iceConnectionState;
      if (
        peerConnection.iceConnectionState === "connected" ||
        peerConnection.iceConnectionState === "completed"
      ) {
        this.resetRecovery();
      } else if (peerConnection.iceConnectionState === "disconnected") {
        this.startDisconnectedTimer(peerConnection);
      } else if (peerConnection.iceConnectionState === "failed") {
        this.handleConnectionDrop("failed");
      }
    };
    peerConnection.onicecandidate = (event) => {
      if (this.peerConnection !== peerConnection || event.candidate === null) {
        return;
      }
      this.sendLocalCandidate(event.candidate.toJSON());
    };
    peerConnection.ondatachannel = (event) => {
      if (this.peerConnection === peerConnection) {
        this.attachDataChannel(event.channel);
      }
    };

    if (this.role === "uploader") {
      this.attachCtrlChannel(
        peerConnection.createDataChannel("ctrl", { ordered: true }),
      );
      this.attachDataChannel(
        peerConnection.createDataChannel("data", { ordered: true }),
      );
    }

    if (sendRebuildSignal && this.remotePeerId !== undefined) {
      try {
        await this.signaling.sendSignal(this.remotePeerId, { mayo: "rebuild" });
      } catch (error) {
        this.signalingOpen = false;
        this.emitError(error);
      }
    }
    const bufferedSignals = this.bufferedSignals.splice(0);
    for (const signal of bufferedSignals) {
      await this.processSignal(signal.from, signal.payload);
    }
    if (createInitialOffer || sendRebuildSignal) {
      await this.maybeCreateOffer();
    }
  }

  private attachDataChannel(channel: RTCDataChannel): void {
    if (channel.label === "ctrl") {
      this.attachCtrlChannel(channel);
      return;
    }
    if (channel.label !== "data") {
      return;
    }
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = LOW_THRESHOLD;
    this.dataChannel = channel;
    let announced = false;
    const onOpen = (): void => {
      if (announced || this.dataChannel !== channel) {
        return;
      }
      announced = true;
      this.emit("data-open", undefined);
    };
    const onClose = (): void => {
      if (this.dataChannel === channel && !this.closed) {
        this.handleConnectionDrop("failed");
      }
    };
    channel.addEventListener("open", onOpen);
    channel.addEventListener("close", onClose);
    if (channel.readyState === "open") {
      onOpen();
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
    for (const registered of this.registeredCtrlHandlers) {
      registered.unsubscribeCurrent?.();
      registered.unsubscribeCurrent = this.ctrlProtocol.on(
        registered.type,
        registered.handler,
      );
    }

    let announced = false;
    const onOpen = (): void => {
      if (announced || this.ctrlChannel !== channel) {
        return;
      }
      announced = true;
      this.emit("ctrl-open", undefined);
    };
    const onClose = (): void => {
      if (this.ctrlChannel === channel && !this.closed) {
        this.handleConnectionDrop("failed");
      }
    };
    channel.addEventListener("open", onOpen);
    channel.addEventListener("close", onClose);
    if (channel.readyState === "open") {
      onOpen();
    }
  }

  private ctrlProtocolReady(): boolean {
    return (
      this.ctrlProtocol !== undefined && this.ctrlChannel?.readyState === "open"
    );
  }

  private setRemotePeer(peerId: string): void {
    const changed =
      this.remotePeerId !== undefined && this.remotePeerId !== peerId;
    this.remotePeerId = peerId;
    const candidates = this.localCandidates.splice(0);
    for (const candidate of candidates) {
      void this.signaling
        .sendSignal(peerId, candidate)
        .catch((error: unknown) => this.emitError(error));
    }
    if (this.rebuildPending || changed) {
      this.rebuildPending = false;
      void this.rebuildPeerConnection(true).catch((error: unknown) =>
        this.emitError(error),
      );
    }
  }

  private sendLocalCandidate(candidate: RTCIceCandidateInit): void {
    if (this.remotePeerId === undefined || !this.signalingOpen) {
      this.localCandidates.push(candidate);
      return;
    }
    void this.signaling
      .sendSignal(this.remotePeerId, candidate)
      .catch((error: unknown) => {
        this.signalingOpen = false;
        this.emitError(error);
        this.rebuildPending = true;
      });
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
    if (isRebuildPayload(payload)) {
      // This can run while replacePeerConnection is draining buffered signals.
      // Queue the next pass instead of awaiting the promise that owns this
      // drain; awaiting it would make the rebuild wait for itself.
      this.queueRebuild(false);
      return;
    }
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

  private handleConnectionDrop(state: "disconnected" | "failed"): void {
    if (this.closed) {
      return;
    }
    this.emit("reconnecting", undefined);
    if (state === "disconnected") {
      this.startDisconnectedTimer(this.peerConnection);
      return;
    }
    if (!this.signalingOpen || !this.signaling.isOpen) {
      this.rebuildPending = true;
      return;
    }
    void this.tryIceRestart();
  }

  private startDisconnectedTimer(
    peerConnection: RTCPeerConnection | undefined,
  ): void {
    if (this.disconnectedTimer !== undefined || peerConnection === undefined) {
      return;
    }
    this.disconnectedTimer = globalThis.setTimeout(() => {
      this.disconnectedTimer = undefined;
      if (
        this.peerConnection === peerConnection &&
        (peerConnection.iceConnectionState === "disconnected" ||
          peerConnection.connectionState === "disconnected")
      ) {
        this.handleConnectionDrop("failed");
      }
    }, 3_000);
  }

  private async tryIceRestart(): Promise<void> {
    if (
      this.closed ||
      this.recoveryInFlight ||
      this.peerConnection === undefined
    ) {
      return;
    }
    if (this.recoveryAttempt >= 5) {
      this.emitExhausted();
      return;
    }
    this.recoveryAttempt += 1;
    this.recoveryInFlight = true;
    const peerConnection = this.peerConnection;
    try {
      peerConnection.restartIce();
      if (this.role === "uploader") {
        const offer = await peerConnection.createOffer({ iceRestart: true });
        await peerConnection.setLocalDescription(offer);
        await this.sendLocalDescription();
      }
      this.recoveryTimer = globalThis.setTimeout(() => {
        this.recoveryTimer = undefined;
        if (this.peerConnection === peerConnection) {
          this.recoveryInFlight = false;
          void this.scheduleRebuild();
        }
      }, 10_000);
    } catch (error) {
      this.recoveryInFlight = false;
      this.emitError(error);
      await this.scheduleRebuild();
    }
  }

  private async scheduleRebuild(): Promise<void> {
    if (this.closed) {
      return;
    }
    if (this.rebuildInFlight) {
      this.rebuildAgainPending = true;
      this.rebuildAgainSignal = true;
      return;
    }
    if (this.recoveryAttempt >= 5) {
      this.emitExhausted();
      return;
    }
    this.recoveryAttempt += 1;
    this.recoveryInFlight = true;
    this.emit("reconnecting", undefined);
    const delay = Math.min(8_000, 250 * 2 ** (this.recoveryAttempt - 1));
    await new Promise<void>((resolve) => {
      this.recoveryTimer = globalThis.setTimeout(() => {
        this.recoveryTimer = undefined;
        resolve();
      }, delay);
    });
    if (this.closed) {
      return;
    }
    this.queueRebuild(true);
    const rebuildPromise = this.rebuildPromise;
    if (rebuildPromise !== undefined) {
      await rebuildPromise;
    }
    const rebuiltPeer = this.peerConnection;
    if (
      rebuiltPeer !== undefined &&
      rebuiltPeer.connectionState !== "connected" &&
      this.signalingOpen &&
      this.signaling.isOpen
    ) {
      this.recoveryTimer = globalThis.setTimeout(() => {
        this.recoveryTimer = undefined;
        if (
          this.peerConnection === rebuiltPeer &&
          rebuiltPeer.connectionState !== "connected"
        ) {
          void this.scheduleRebuild();
        }
      }, 10_000);
    }
  }

  private async rebuildPeerConnection(
    sendRebuildSignal: boolean,
  ): Promise<void> {
    if (this.closed || this.configuration === undefined) {
      return;
    }
    this.queueRebuild(sendRebuildSignal);
    const rebuildPromise = this.rebuildPromise;
    if (rebuildPromise !== undefined) {
      await rebuildPromise;
    }
  }

  /**
   * Starts or coalesces a rebuild. A rebuild signal can arrive while the
   * current pass is draining buffered signals, so a second pass is recorded
   * and run only after the current pass has fully replaced its peer.
   */
  private queueRebuild(sendRebuildSignal: boolean): void {
    if (this.closed || this.configuration === undefined) {
      return;
    }
    if (this.rebuildInFlight) {
      this.rebuildAgainPending = true;
      this.rebuildAgainSignal = sendRebuildSignal;
      return;
    }

    this.rebuildInFlight = true;
    const rebuild = this.runRebuildPass(sendRebuildSignal)
      .catch((error: unknown) => this.emitError(error))
      .finally(() => {
        this.rebuildInFlight = false;
        this.rebuildPromise = undefined;
        this.recoveryInFlight = false;
      });
    this.rebuildPromise = rebuild;
  }

  private async runRebuildPass(sendRebuildSignal: boolean): Promise<void> {
    let nextSendRebuildSignal = sendRebuildSignal;
    do {
      this.rebuildAgainPending = false;
      this.rebuildAgainSignal = false;
      await this.replacePeerConnection(
        nextSendRebuildSignal,
        this.role === "uploader",
      );
      nextSendRebuildSignal = this.rebuildAgainSignal;
    } while (this.rebuildAgainPending && !this.closed);
  }

  private resetRecovery(): void {
    this.clearRecoveryTimers();
    this.recoveryAttempt = 0;
    this.recoveryInFlight = false;
    this.rebuildPending = false;
  }

  private clearRecoveryTimers(): void {
    if (this.disconnectedTimer !== undefined) {
      globalThis.clearTimeout(this.disconnectedTimer);
      this.disconnectedTimer = undefined;
    }
    if (this.recoveryTimer !== undefined) {
      globalThis.clearTimeout(this.recoveryTimer);
      this.recoveryTimer = undefined;
    }
  }

  private emitExhausted(error?: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.clearRecoveryTimers();
    this.ctrlProtocol?.dispose();
    this.peerConnection?.close();
    this.emit("exhausted", error === undefined ? {} : { error });
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
