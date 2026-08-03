import type { Sink } from "./index";
import { SINK_STALL_ABORT_MS } from "./manager";

export const DOWNLOAD_SERVICE_WORKER = "/download.sw.js";
export const DOWNLOAD_PATH_PREFIX = "/__mayo-dl/";
export const SW_CREDIT_BYTES = 8 * 1024 * 1024;
export const SW_PROTOCOL_VERSION = 2;
export const SW_REQUEST_PARKING_PROTOCOL_VERSION = SW_PROTOCOL_VERSION;
const SW_MESSAGE_TIMEOUT_MS = 30_000;
const SW_STARTED_TIMEOUT_MS = 10_000;
const SW_HELLO_TIMEOUT_MS = 5_000;
const SW_PING_INTERVAL_MS = 20_000;
const SW_LIVENESS_TIMEOUT_MS = 45_000;

export type SwPageMessage =
  | { t: "hello" }
  | {
      t: "init";
      id: string;
      name: string;
      totalBytes: number;
      creditBytes: number;
    }
  | {
      t: "chunk";
      id: string;
      sequence: number;
      buffer: ArrayBuffer;
    }
  | { t: "close"; id: string }
  | { t: "cancel"; id: string; reason: string }
  | { t: "ping"; id: string };

export type SwWorkerMessage =
  | { t: "hello-ack"; protocol: number }
  | { t: "ready"; id: string; creditBytes: number }
  | { t: "started"; id: string }
  | { t: "credit"; id: string; sequence: number; bytes: number }
  | { t: "closed"; id: string }
  | { t: "error"; id: string; message: string }
  | { t: "pong"; id: string };

export interface SwCreditState {
  availableBytes: number;
}

export const createSwCreditState = (availableBytes: number): SwCreditState => ({
  availableBytes,
});

export const consumeSwCredit = (
  state: SwCreditState,
  byteLength: number,
): boolean => {
  if (byteLength < 0 || byteLength > state.availableBytes) {
    return false;
  }
  state.availableBytes -= byteLength;
  return true;
};

export const releaseSwCredit = (
  state: SwCreditState,
  byteLength: number,
): void => {
  state.availableBytes += byteLength;
};

export const isNextSwSequence = (
  expectedSequence: number,
  receivedSequence: number,
): boolean => expectedSequence === receivedSequence;

const makeId = (): string => {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

const makeDownloadPath = (id: string): string =>
  `${DOWNLOAD_PATH_PREFIX}${encodeURIComponent(id)}`;

interface PendingWrite {
  sequence: number;
  bytes: Uint8Array;
  resolve: () => void;
  reject: (reason: unknown) => void;
}

const asError = (reason: unknown): Error =>
  reason instanceof Error ? reason : new Error(String(reason));

const registrationPromises = new WeakMap<
  ServiceWorkerContainer,
  Promise<ServiceWorkerRegistration>
>();
const negotiatedProtocols = new WeakMap<ServiceWorkerContainer, number>();
const warmupPromises = new WeakMap<ServiceWorkerContainer, Promise<void>>();

const hasSinkOverride = (): boolean =>
  typeof window !== "undefined" &&
  (window.__MAYO_SINK__ !== undefined ||
    window.__MAYO_SINK_STRATEGY__ !== undefined);

const getServiceWorkerContainer = (): ServiceWorkerContainer | undefined =>
  typeof navigator === "undefined" || navigator.serviceWorker === undefined
    ? undefined
    : navigator.serviceWorker;

const getRegistration = (
  serviceWorker: ServiceWorkerContainer,
): Promise<ServiceWorkerRegistration> => {
  const cached = registrationPromises.get(serviceWorker);
  if (cached !== undefined) {
    return cached;
  }
  let registration: Promise<ServiceWorkerRegistration>;
  try {
    registration = Promise.resolve(
      serviceWorker.register(DOWNLOAD_SERVICE_WORKER, {
        scope: "/",
        type: "classic",
      }),
    );
  } catch (error) {
    registration = Promise.reject(error);
  }
  const cachedRegistration = registration.catch((error: unknown) => {
    registrationPromises.delete(serviceWorker);
    throw error;
  });
  registrationPromises.set(serviceWorker, cachedRegistration);
  return cachedRegistration;
};

const waitForActive = async (
  serviceWorker: ServiceWorkerContainer,
  registration: ServiceWorkerRegistration,
): Promise<ServiceWorker | null> => {
  if (registration.active !== null) {
    return registration.active;
  }
  const ready = await serviceWorker.ready;
  return ready.active ?? serviceWorker.controller;
};

const negotiateProtocol = (
  serviceWorker: ServiceWorkerContainer,
  active: ServiceWorker,
): Promise<number | undefined> =>
  new Promise((resolve) => {
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    const finish = (protocol: number | undefined): void => {
      if (timer !== undefined) {
        globalThis.clearTimeout(timer);
      }
      serviceWorker.removeEventListener("message", onMessage);
      resolve(protocol);
    };
    const onMessage = (event: MessageEvent<SwWorkerMessage>): void => {
      const message = event.data;
      if (
        message?.t !== "hello-ack" ||
        !Number.isInteger(message.protocol) ||
        message.protocol < 1
      ) {
        return;
      }
      finish(message.protocol);
    };
    serviceWorker.addEventListener("message", onMessage);
    timer = globalThis.setTimeout(() => finish(undefined), SW_HELLO_TIMEOUT_MS);
    try {
      active.postMessage({ t: "hello" } satisfies SwPageMessage);
    } catch {
      finish(undefined);
    }
  });

/** Starts the service-worker registration and protocol handshake early. */
export const warmUpSwServiceWorker = (): Promise<void> => {
  const serviceWorker = getServiceWorkerContainer();
  if (serviceWorker === undefined || hasSinkOverride()) {
    return Promise.resolve();
  }
  const cached = warmupPromises.get(serviceWorker);
  if (cached !== undefined) {
    return cached;
  }
  const warmup = (async (): Promise<void> => {
    try {
      const registration = await getRegistration(serviceWorker);
      const active = await waitForActive(serviceWorker, registration);
      if (active === null) {
        return;
      }
      const protocol = await negotiateProtocol(serviceWorker, active);
      if (protocol !== undefined) {
        negotiatedProtocols.set(serviceWorker, protocol);
      }
    } catch {
      // Warm-up is opportunistic. Sink creation retains the legacy path.
    }
  })();
  warmupPromises.set(serviceWorker, warmup);
  return warmup;
};

export const supportsSwRequestParking = (
  serviceWorker?: ServiceWorkerContainer,
): boolean => {
  const container = serviceWorker ?? getServiceWorkerContainer();
  return (
    container !== undefined &&
    negotiatedProtocols.get(container) === SW_REQUEST_PARKING_PROTOCOL_VERSION
  );
};

/** Streams committed chunks to a browser download through the service worker. */
export class SwStreamSink implements Sink {
  public readonly strategy = "sw" as const;
  private readonly id = makeId();
  private readonly credit = createSwCreditState(0);
  private readonly pending: PendingWrite[] = [];
  private readonly pendingBySequence = new Map<number, PendingWrite>();
  private readonly onMessage = (event: MessageEvent<SwWorkerMessage>): void => {
    const message = event.data;
    if (message?.t === "hello-ack") {
      return;
    }
    if (message?.id !== this.id) {
      return;
    }
    if (message.t === "ready") {
      releaseSwCredit(this.credit, message.creditBytes);
      if (this.readyTimer !== undefined) {
        window.clearTimeout(this.readyTimer);
        this.readyTimer = undefined;
      }
      this.resolveReady?.();
      this.resolveReady = undefined;
      this.flush();
      return;
    }
    if (message.t === "started") {
      if (this.startedTimer !== undefined) {
        window.clearTimeout(this.startedTimer);
        this.startedTimer = undefined;
      }
      this.resolveStarted?.();
      this.resolveStarted = undefined;
      return;
    }
    if (message.t === "credit") {
      if (!isNextSwSequence(this.nextCreditSequence, message.sequence)) {
        this.fail(
          new Error(
            "The download service worker returned credits out of order.",
          ),
        );
        return;
      }
      const pending = this.pendingBySequence.get(message.sequence);
      if (pending === undefined) {
        this.fail(
          new Error("The download service worker returned an unknown chunk."),
        );
        return;
      }
      this.pendingBySequence.delete(message.sequence);
      this.nextCreditSequence += 1;
      releaseSwCredit(this.credit, message.bytes);
      pending.resolve();
      this.armCloseWatchdog();
      this.flush();
      return;
    }
    if (message.t === "closed") {
      this.clearCloseWatchdog();
      this.resolveClosed?.();
      this.resolveClosed = undefined;
      this.cleanup();
      return;
    }
    if (message.t === "error") {
      this.fail(new Error(message.message));
      return;
    }
    if (message.t === "pong") {
      this.lastPongAt = Date.now();
    }
  };
  private readonly serviceWorker: ServiceWorkerContainer;
  private readonly registrationPromise: Promise<ServiceWorkerRegistration>;
  private readonly name: string;
  private readonly totalBytes: number;
  private sequence = 0;
  private nextCreditSequence = 0;
  private closed = false;
  private failedError: Error | undefined;
  private iframe: HTMLIFrameElement | undefined;
  private pingTimer: number | undefined;
  private lastPingAt: number | undefined;
  private lastPongAt: number | undefined;
  private readyTimer: number | undefined;
  private startedTimer: number | undefined;
  private resolveReady: (() => void) | undefined;
  private rejectReady: ((reason: unknown) => void) | undefined;
  private resolveStarted: (() => void) | undefined;
  private rejectStarted: ((reason: unknown) => void) | undefined;
  private resolveClosed: (() => void) | undefined;
  private rejectClosed: ((reason: unknown) => void) | undefined;
  private closeTimer: number | undefined;

  public constructor(name: string, totalBytes: number) {
    if (
      typeof navigator === "undefined" ||
      navigator.serviceWorker === undefined
    ) {
      throw new Error(
        "Service-worker downloads are unavailable in this browser.",
      );
    }
    this.name = name;
    this.totalBytes = totalBytes;
    this.serviceWorker = navigator.serviceWorker;
    this.serviceWorker.addEventListener("message", this.onMessage);
    // register() is intentionally started by the constructor, before the first await
    // in createSwSink, so acceptTransfer can begin it from a click handler.
    this.registrationPromise = getRegistration(this.serviceWorker);
  }

  public async start(): Promise<void> {
    try {
      await this.startInternal();
    } catch (error) {
      this.fail(asError(error));
      throw error;
    }
  }

  private async startInternal(): Promise<void> {
    const controller = this.serviceWorker.controller;
    if (controller !== null && supportsSwRequestParking(this.serviceWorker)) {
      const started = this.waitForStarted();
      const ready = this.postInit(controller);
      this.appendIframe();
      await Promise.all([ready, started]);
    } else {
      const registration = await this.registrationPromise;
      const active = await waitForActive(this.serviceWorker, registration);
      if (active === null) {
        throw new Error("The download service worker did not become active.");
      }
      await this.postInit(active);
      this.appendIframe();
      await this.waitForStarted();
    }
    this.pingTimer = window.setInterval(() => {
      this.lastPingAt = Date.now();
      this.post({ t: "ping", id: this.id });
    }, SW_PING_INTERVAL_MS);
  }

  /** Reports whether the service worker has answered its recent liveness pings. */
  public isResponsive(): boolean {
    if (this.lastPingAt === undefined) {
      return true;
    }
    return (
      this.lastPongAt !== undefined &&
      Date.now() - this.lastPongAt < SW_LIVENESS_TIMEOUT_MS
    );
  }

  public write(bytes: Uint8Array): Promise<void> {
    // The stream remains open during same-session reconnects; only committed
    // writes consume SW credit, so the resumed data channel starts at the next
    // durable byte instead of truncating or duplicating the download.
    if (this.closed) {
      return Promise.reject(new Error("The file sink is already closed."));
    }
    if (this.failedError !== undefined) {
      return Promise.reject(this.failedError);
    }
    return new Promise<void>((resolve, reject) => {
      this.pending.push({
        sequence: this.sequence,
        bytes,
        resolve,
        reject,
      });
      this.sequence += 1;
      this.flush();
    });
  }

  public close(): Promise<void> {
    if (this.closed) {
      return Promise.resolve();
    }
    this.closed = true;
    if (this.failedError !== undefined) {
      return Promise.reject(this.failedError);
    }
    return new Promise<void>((resolve, reject) => {
      this.resolveClosed = resolve;
      this.rejectClosed = reject;
      this.armCloseWatchdog();
      this.flush();
      this.maybeClose();
    });
  }

  public cancel(reason: string): void {
    if (
      this.closed &&
      this.failedError === undefined &&
      this.resolveClosed === undefined
    ) {
      return;
    }
    this.closed = true;
    this.post({ t: "cancel", id: this.id, reason });
    this.fail(new Error(reason));
    this.cleanup();
  }

  private postInit(active: ServiceWorker): Promise<void> {
    const ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.readyTimer = window.setTimeout(() => {
      this.rejectReady?.(
        new Error("The download service worker did not respond."),
      );
    }, SW_MESSAGE_TIMEOUT_MS);
    try {
      active.postMessage({
        t: "init",
        id: this.id,
        name: this.name,
        totalBytes: this.totalBytes,
        creditBytes: SW_CREDIT_BYTES,
      } satisfies SwPageMessage);
    } catch (error) {
      if (this.readyTimer !== undefined) {
        window.clearTimeout(this.readyTimer);
        this.readyTimer = undefined;
      }
      throw error;
    }
    return ready;
  }

  private appendIframe(): void {
    const iframe = document.createElement("iframe");
    iframe.hidden = true;
    iframe.title = "mayo.pizza download";
    iframe.src = makeDownloadPath(this.id);
    document.body.append(iframe);
    this.iframe = iframe;
  }

  private waitForStarted(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.resolveStarted = resolve;
      this.rejectStarted = reject;
      this.startedTimer = window.setTimeout(() => {
        const controller =
          navigator.serviceWorker.controller === null ? "null" : "active";
        reject(
          new Error(
            `The download service worker never received the download request (controller=${controller}, path=${makeDownloadPath(this.id)}). The hidden download frame was most likely refused by X-Frame-Options: DENY after falling through to the server.`,
          ),
        );
      }, SW_STARTED_TIMEOUT_MS);
    });
  }

  private flush(): void {
    while (this.pending.length > 0) {
      const next = this.pending[0];
      if (
        next === undefined ||
        !consumeSwCredit(this.credit, next.bytes.byteLength)
      ) {
        return;
      }
      this.pending.shift();
      this.pendingBySequence.set(next.sequence, next);
      const buffer =
        next.bytes.byteOffset === 0 &&
        next.bytes.byteLength === next.bytes.buffer.byteLength
          ? (next.bytes.buffer as ArrayBuffer)
          : (next.bytes.slice().buffer as ArrayBuffer);
      try {
        this.post(
          {
            t: "chunk",
            id: this.id,
            sequence: next.sequence,
            buffer,
          },
          [buffer],
        );
      } catch (error) {
        this.fail(asError(error));
        return;
      }
    }
    this.maybeClose();
  }

  private maybeClose(): void {
    if (
      !this.closed ||
      this.pending.length > 0 ||
      this.pendingBySequence.size > 0 ||
      this.resolveClosed === undefined
    ) {
      return;
    }
    this.post({ t: "close", id: this.id });
  }

  private armCloseWatchdog(): void {
    if (this.resolveClosed === undefined) {
      return;
    }
    if (this.closeTimer !== undefined) {
      window.clearTimeout(this.closeTimer);
    }
    this.closeTimer = window.setTimeout(() => {
      this.closeTimer = undefined;
      if (this.resolveClosed !== undefined) {
        this.fail(
          new Error(
            "The download service worker stopped responding while closing the download.",
          ),
        );
      }
    }, SINK_STALL_ABORT_MS);
  }

  private clearCloseWatchdog(): void {
    if (this.closeTimer !== undefined) {
      window.clearTimeout(this.closeTimer);
      this.closeTimer = undefined;
    }
  }

  private post(message: SwPageMessage, transfer: Transferable[] = []): void {
    const registration = this.registrationPromise;
    void registration
      .then((value) => {
        const active = value.active ?? navigator.serviceWorker.controller;
        if (active === null) {
          throw new Error("The download service worker is unavailable.");
        }
        active.postMessage(message, transfer);
      })
      .catch((error: unknown) => this.fail(asError(error)));
  }

  private fail(error: Error): void {
    if (this.failedError !== undefined) {
      return;
    }
    this.failedError = error;
    for (const pending of this.pending.splice(0)) {
      pending.reject(error);
    }
    for (const pending of this.pendingBySequence.values()) {
      pending.reject(error);
    }
    this.pendingBySequence.clear();
    this.rejectReady?.(error);
    this.resolveReady = undefined;
    this.rejectReady = undefined;
    this.rejectStarted?.(error);
    this.resolveStarted = undefined;
    this.rejectStarted = undefined;
    this.rejectClosed?.(error);
    this.resolveClosed = undefined;
    this.rejectClosed = undefined;
    this.clearCloseWatchdog();
    this.cleanup();
  }

  private cleanup(): void {
    this.serviceWorker.removeEventListener("message", this.onMessage);
    if (this.readyTimer !== undefined) {
      window.clearTimeout(this.readyTimer);
      this.readyTimer = undefined;
    }
    if (this.startedTimer !== undefined) {
      window.clearTimeout(this.startedTimer);
      this.startedTimer = undefined;
    }
    if (this.pingTimer !== undefined) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
    this.clearCloseWatchdog();
    this.iframe?.remove();
    this.iframe = undefined;
  }
}

export const createSwSink = (
  name: string,
  totalBytes: number,
): Promise<Sink> => {
  const sink = new SwStreamSink(name, totalBytes);
  return sink.start().then(() => sink);
};
