import { type SignalingMessage, signalingMessageSchema } from "shared";

export type SignalingServerMessage =
  | Extract<SignalingMessage, { t: "created" }>
  | Extract<SignalingMessage, { t: "joined" }>
  | Extract<SignalingMessage, { t: "peer-joined" }>
  | Extract<SignalingMessage, { t: "peer-left" }>
  | Extract<SignalingMessage, { t: "signal"; from: string }>
  | Extract<SignalingMessage, { t: "ice-config"; iceServers: unknown[] }>
  | Extract<SignalingMessage, { t: "error" }>;

export type SignalingClientMessage =
  | Extract<SignalingMessage, { t: "create" }>
  | Extract<SignalingMessage, { t: "join" }>
  | Extract<SignalingMessage, { t: "signal"; to: string }>
  | Extract<SignalingMessage, { t: "ice-config" }>
  | Extract<SignalingMessage, { t: "close" }>;

export interface SignalingProtocolError {
  message: string;
  raw: unknown;
}

export interface SignalingTransportError {
  error: Event;
}

export interface SignalingCloseEvent {
  code: number;
  reason: string;
  wasClean: boolean;
}

export interface SignalingEventMap {
  open: undefined;
  close: SignalingCloseEvent;
  "room-resumed": undefined;
  created: Extract<SignalingServerMessage, { t: "created" }>;
  joined: Extract<SignalingServerMessage, { t: "joined" }>;
  "peer-joined": Extract<SignalingServerMessage, { t: "peer-joined" }>;
  "peer-left": Extract<SignalingServerMessage, { t: "peer-left" }>;
  signal: Extract<SignalingServerMessage, { t: "signal" }>;
  "ice-config": Extract<SignalingServerMessage, { t: "ice-config" }>;
  error: Extract<SignalingServerMessage, { t: "error" }>;
  "protocol-error": SignalingProtocolError;
  "transport-error": SignalingTransportError;
}

type EventName = keyof SignalingEventMap;
type EventListener<K extends EventName> = (
  payload: SignalingEventMap[K],
) => void;

type WebSocketFactory = (url: string) => WebSocket;

export interface SignalingClientOptions {
  url?: string;
  webSocketFactory?: WebSocketFactory;
  random?: () => number;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
}

interface RoomSession {
  slug: string;
  password?: string;
  uploaderToken?: string;
  role: "uploader" | "downloader";
}

const MAX_RECONNECT_DELAY = 30_000;
const INITIAL_RECONNECT_DELAY = 1_000;
const WEBSOCKET_OPEN = 1;

/** Returns an exponential reconnect delay with bounded +/-20% jitter. */
export const getReconnectDelay = (
  attempt: number,
  random: () => number = Math.random,
): number => {
  const normalizedAttempt = Math.max(0, Math.floor(attempt));
  const baseDelay = Math.min(
    MAX_RECONNECT_DELAY,
    INITIAL_RECONNECT_DELAY * 2 ** normalizedAttempt,
  );
  const jitter = 0.8 + Math.min(1, Math.max(0, random())) * 0.4;
  return Math.min(MAX_RECONNECT_DELAY, Math.round(baseDelay * jitter));
};

const getDefaultSignalingUrl = (): string => {
  if (typeof window === "undefined") {
    return "ws://localhost/ws";
  }

  const runtimeOverride = window.__MAYO_SIGNALING_URL__;
  if (runtimeOverride !== undefined) {
    return runtimeOverride;
  }

  const buildTimeUrl = import.meta.env.VITE_SIGNALING_URL;
  if (buildTimeUrl !== undefined && buildTimeUrl !== "") {
    return buildTimeUrl;
  }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
};

const isServerMessage = (
  message: SignalingMessage,
): message is SignalingServerMessage => {
  if (message.t === "signal") {
    return "from" in message;
  }
  if (message.t === "ice-config") {
    return "iceServers" in message;
  }
  return (
    message.t !== "create" && message.t !== "join" && message.t !== "close"
  );
};

const parseServerMessage = (
  raw: unknown,
): SignalingServerMessage | undefined => {
  const parsed = signalingMessageSchema.safeParse(raw);
  if (!parsed.success || !isServerMessage(parsed.data)) {
    return undefined;
  }
  return parsed.data;
};

interface PendingRequest {
  event: "created" | "joined" | "ice-config";
  resolve: (message: SignalingServerMessage) => void;
  reject: (error: Error) => void;
}

interface PendingRequestHandle<T extends SignalingServerMessage> {
  promise: Promise<T>;
  cancel: () => void;
}

export class SignalingClient {
  private readonly listeners: {
    [K in EventName]: Set<EventListener<K>>;
  } = {
    open: new Set(),
    close: new Set(),
    "room-resumed": new Set(),
    created: new Set(),
    joined: new Set(),
    "peer-joined": new Set(),
    "peer-left": new Set(),
    signal: new Set(),
    "ice-config": new Set(),
    error: new Set(),
    "protocol-error": new Set(),
    "transport-error": new Set(),
  };

  private readonly webSocketFactory: WebSocketFactory;
  private readonly random: () => number;
  private readonly setTimer: typeof globalThis.setTimeout;
  private readonly clearTimer: typeof globalThis.clearTimeout;
  private readonly url: string;
  private socket: WebSocket | undefined;
  private connectionPromise: Promise<void> | undefined;
  private resolveConnection: (() => void) | undefined;
  private rejectConnection: ((error: Error) => void) | undefined;
  private reconnectTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  private reconnectAttempt = 0;
  private manuallyClosed = false;
  private resumeOnOpen = false;
  private resumeInFlight = false;
  private roomResumePromise: Promise<void> | undefined;
  private roomSession: RoomSession | undefined;
  private readonly onlineListener = (): void => {
    if (this.manuallyClosed) {
      return;
    }
    if (this.reconnectTimer !== undefined) {
      this.clearTimer(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    void this.connect().catch(() => undefined);
  };
  private readonly pendingRequests: PendingRequest[] = [];

  public constructor(options: SignalingClientOptions = {}) {
    this.url = options.url ?? getDefaultSignalingUrl();
    this.webSocketFactory =
      options.webSocketFactory ?? ((url) => new WebSocket(url));
    this.random = options.random ?? Math.random;
    this.setTimer = options.setTimeout ?? globalThis.setTimeout;
    this.clearTimer = options.clearTimeout ?? globalThis.clearTimeout;
    if (typeof window !== "undefined") {
      window.addEventListener("online", this.onlineListener);
    }
  }

  /** Reports whether the signaling transport is currently open. */
  public get isOpen(): boolean {
    return this.socket?.readyState === WEBSOCKET_OPEN;
  }

  public on<K extends EventName>(
    event: K,
    listener: EventListener<K>,
  ): () => void {
    const listeners = this.listeners[event] as Set<EventListener<K>>;
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  public connect(): Promise<void> {
    this.manuallyClosed = false;
    if (this.socket?.readyState === WEBSOCKET_OPEN) {
      return Promise.resolve();
    }
    if (this.connectionPromise !== undefined) {
      return this.connectionPromise;
    }

    if (this.reconnectTimer !== undefined) {
      this.clearTimer(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    this.connectionPromise = new Promise<void>((resolve, reject) => {
      this.resolveConnection = resolve;
      this.rejectConnection = reject;
      this.openSocket();
    });
    return this.connectionPromise;
  }

  public async send(message: SignalingClientMessage): Promise<void> {
    await this.connect();
    await this.roomResumePromise;
    if (this.socket?.readyState !== WEBSOCKET_OPEN) {
      throw new Error("The signaling socket is not open.");
    }
    this.socket.send(JSON.stringify(message));
  }

  public async create(
    password?: string,
  ): Promise<Extract<SignalingServerMessage, { t: "created" }>> {
    const response = this.waitFor("created");
    const message: Extract<SignalingClientMessage, { t: "create" }> =
      password === undefined ? { t: "create" } : { t: "create", password };
    try {
      await this.send(message);
      const created = await response.promise;
      this.roomSession = {
        slug: created.slug,
        ...(password === undefined ? {} : { password }),
        uploaderToken: created.uploaderToken,
        role: "uploader",
      };
      return created;
    } catch (error) {
      response.cancel();
      throw error;
    }
  }

  public async join(
    slug: string,
    password?: string,
    uploaderToken?: string,
  ): Promise<Extract<SignalingServerMessage, { t: "joined" }>> {
    const response = this.waitFor("joined");
    const message: Extract<SignalingClientMessage, { t: "join" }> = {
      t: "join",
      slug,
      ...(password === undefined ? {} : { password }),
      ...(uploaderToken === undefined ? {} : { uploaderToken }),
    };
    try {
      await this.send(message);
      const joined = await response.promise;
      this.roomSession = {
        slug,
        ...(password === undefined ? {} : { password }),
        ...(uploaderToken === undefined ? {} : { uploaderToken }),
        role: joined.role,
      };
      return joined;
    } catch (error) {
      response.cancel();
      throw error;
    }
  }

  public async requestIceConfig(): Promise<
    Extract<SignalingServerMessage, { t: "ice-config" }>["iceServers"]
  > {
    const response = this.waitFor("ice-config");
    try {
      await this.send({ t: "ice-config" });
      return (await response.promise).iceServers;
    } catch (error) {
      response.cancel();
      throw error;
    }
  }

  public sendSignal(to: string, payload: unknown): Promise<void> {
    return this.send({ t: "signal", to, payload });
  }

  public close(): void {
    this.manuallyClosed = true;
    if (this.reconnectTimer !== undefined) {
      this.clearTimer(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.rejectPending(new Error("The signaling client was closed."));
    this.roomSession = undefined;
    this.roomResumePromise = undefined;
    if (typeof window !== "undefined") {
      window.removeEventListener("online", this.onlineListener);
    }
    const socket = this.socket;
    this.socket = undefined;
    if (socket !== undefined) {
      socket.close(1000, "Closed by client");
    }
    this.rejectConnection?.(new Error("The signaling client was closed."));
    this.resolveConnection = undefined;
    this.rejectConnection = undefined;
    this.connectionPromise = undefined;
  }

  private waitFor<K extends PendingRequest["event"]>(
    event: K,
  ): PendingRequestHandle<Extract<SignalingServerMessage, { t: K }>> {
    let pendingRequest: PendingRequest | undefined;
    const promise = new Promise<Extract<SignalingServerMessage, { t: K }>>(
      (resolve, reject) => {
        pendingRequest = {
          event,
          resolve: (message) =>
            resolve(message as Extract<SignalingServerMessage, { t: K }>),
          reject,
        };
        this.pendingRequests.push(pendingRequest);
      },
    );
    return {
      promise,
      cancel: () => {
        if (pendingRequest === undefined) {
          return;
        }
        const index = this.pendingRequests.indexOf(pendingRequest);
        if (index !== -1) {
          this.pendingRequests.splice(index, 1);
        }
      },
    };
  }

  private openSocket(): void {
    let socket: WebSocket;
    try {
      socket = this.webSocketFactory(this.url);
    } catch (error) {
      this.failConnection(error);
      this.scheduleReconnect();
      return;
    }

    this.socket = socket;
    let opened = false;
    socket.onopen = () => {
      if (this.socket !== socket) {
        return;
      }
      opened = true;
      this.reconnectAttempt = 0;
      this.resolveConnection?.();
      this.resolveConnection = undefined;
      this.rejectConnection = undefined;
      this.connectionPromise = undefined;
      this.emit("open", undefined);
      const shouldResume = this.resumeOnOpen;
      this.resumeOnOpen = false;
      if (shouldResume) {
        this.roomResumePromise = this.resumeRoom();
        void this.roomResumePromise.catch(() => undefined);
      }
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) {
        return;
      }
      this.handleInbound(event.data);
    };
    socket.onerror = (error) => {
      if (this.socket === socket) {
        this.emit("transport-error", { error });
      }
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) {
        return;
      }
      this.socket = undefined;
      if (!opened) {
        this.failConnection(
          new Error("The signaling socket closed before opening."),
        );
      }
      this.emit("close", {
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
      });
      if (!this.manuallyClosed) {
        this.resumeOnOpen = this.roomSession !== undefined;
        this.rejectPending(new Error("The signaling socket closed."));
        this.scheduleReconnect();
      }
    };
  }

  private handleInbound(rawData: unknown): void {
    let raw: unknown;
    try {
      raw = typeof rawData === "string" ? JSON.parse(rawData) : rawData;
    } catch {
      this.emitProtocolError(rawData);
      return;
    }

    const message = parseServerMessage(raw);
    if (message === undefined) {
      this.emitProtocolError(raw);
      return;
    }

    this.emit(message.t, message);
    if (message.t === "error") {
      this.rejectPending(new Error(`${message.code}: ${message.message}`));
      if (this.resumeInFlight && message.code === "BAD_SLUG") {
        this.manuallyClosed = true;
        if (this.reconnectTimer !== undefined) {
          this.clearTimer(this.reconnectTimer);
          this.reconnectTimer = undefined;
        }
        this.socket?.close(1000, "Room expired");
      }
      return;
    }

    if (
      message.t === "created" ||
      message.t === "joined" ||
      message.t === "ice-config"
    ) {
      const index = this.pendingRequests.findIndex(
        (request) => request.event === message.t,
      );
      const pending =
        index === -1 ? undefined : this.pendingRequests.splice(index, 1)[0];
      pending?.resolve(message);
    }
  }

  private emitProtocolError(raw: unknown): void {
    this.emit("protocol-error", {
      message: "The signaling server sent an invalid frame.",
      raw,
    });
  }

  private failConnection(error: unknown): void {
    const connectionError =
      error instanceof Error
        ? error
        : new Error("The signaling connection failed.");
    this.rejectConnection?.(connectionError);
    this.resolveConnection = undefined;
    this.rejectConnection = undefined;
    this.connectionPromise = undefined;
  }

  private rejectPending(error: Error): void {
    const pending = this.pendingRequests.splice(0);
    for (const request of pending) {
      request.reject(error);
    }
  }

  private scheduleReconnect(): void {
    if (this.manuallyClosed || this.reconnectTimer !== undefined) {
      return;
    }
    const delay = getReconnectDelay(this.reconnectAttempt, this.random);
    this.reconnectAttempt += 1;
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = undefined;
      if (!this.manuallyClosed) {
        void this.connect().catch(() => undefined);
      }
    }, delay);
  }

  private async resumeRoom(): Promise<void> {
    const session = this.roomSession;
    if (session === undefined || this.manuallyClosed || this.resumeInFlight) {
      return;
    }
    this.resumeInFlight = true;
    const response = this.waitFor("joined");
    try {
      const message: Extract<SignalingClientMessage, { t: "join" }> = {
        t: "join",
        slug: session.slug,
        ...(session.password === undefined
          ? {}
          : { password: session.password }),
        ...(session.uploaderToken === undefined
          ? {}
          : { uploaderToken: session.uploaderToken }),
      };
      if (!this.isOpen) {
        throw new Error("The signaling socket is not open.");
      }
      this.socket?.send(JSON.stringify(message));
      const joined = await response.promise;
      this.roomSession = { ...session, role: joined.role };
      this.emit("room-resumed", undefined);
    } catch (error) {
      response.cancel();
      if (error instanceof Error && error.message.startsWith("BAD_SLUG:")) {
        this.manuallyClosed = true;
      }
      throw error;
    } finally {
      this.resumeInFlight = false;
    }
  }

  private emit<K extends EventName>(
    event: K,
    payload: SignalingEventMap[K],
  ): void {
    const listeners = this.listeners[event] as Set<EventListener<K>>;
    for (const listener of listeners) {
      listener(payload);
    }
  }
}

export const createSignalingClient = (
  options: SignalingClientOptions = {},
): SignalingClient => new SignalingClient(options);
