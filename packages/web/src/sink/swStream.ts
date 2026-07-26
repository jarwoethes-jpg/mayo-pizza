import type { Sink } from "./index";

export const DOWNLOAD_SERVICE_WORKER = "/download.sw.js";
export const DOWNLOAD_PATH_PREFIX = "/__mayo-dl/";
export const SW_CREDIT_BYTES = 8 * 1024 * 1024;
const SW_MESSAGE_TIMEOUT_MS = 30_000;

export type SwPageMessage =
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
  | { t: "ready"; id: string; creditBytes: number }
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

/** Streams committed chunks to a browser download through the service worker. */
export class SwStreamSink implements Sink {
  public readonly strategy = "sw" as const;
  private readonly id = makeId();
  private readonly credit = createSwCreditState(0);
  private readonly pending: PendingWrite[] = [];
  private readonly pendingBySequence = new Map<number, PendingWrite>();
  private readonly onMessage = (event: MessageEvent<SwWorkerMessage>): void => {
    const message = event.data;
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
      this.flush();
      return;
    }
    if (message.t === "closed") {
      this.resolveClosed?.();
      this.resolveClosed = undefined;
      this.cleanup();
      return;
    }
    if (message.t === "error") {
      this.fail(new Error(message.message));
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
  private readyTimer: number | undefined;
  private resolveReady: (() => void) | undefined;
  private rejectReady: ((reason: unknown) => void) | undefined;
  private resolveClosed: (() => void) | undefined;
  private rejectClosed: ((reason: unknown) => void) | undefined;

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
    this.registrationPromise = this.serviceWorker.register(
      DOWNLOAD_SERVICE_WORKER,
      {
        scope: "/",
        type: "classic",
      },
    );
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
    const registration = await this.registrationPromise;
    const active = (await this.waitForActive(registration)).active;
    if (active === null) {
      throw new Error("The download service worker did not become active.");
    }
    await new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
      active.postMessage({
        t: "init",
        id: this.id,
        name: this.name,
        totalBytes: this.totalBytes,
        creditBytes: SW_CREDIT_BYTES,
      } satisfies SwPageMessage);
      this.readyTimer = window.setTimeout(() => {
        reject(new Error("The download service worker did not respond."));
      }, SW_MESSAGE_TIMEOUT_MS);
    });
    const iframe = document.createElement("iframe");
    iframe.hidden = true;
    iframe.title = "mayo.pizza download";
    iframe.src = makeDownloadPath(this.id);
    document.body.append(iframe);
    this.iframe = iframe;
    this.pingTimer = window.setInterval(() => {
      this.post({ t: "ping", id: this.id });
    }, 20_000);
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

  private async waitForActive(
    registration: ServiceWorkerRegistration,
  ): Promise<ServiceWorkerRegistration> {
    if (registration.active !== null) {
      return registration;
    }
    return navigator.serviceWorker.ready;
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
    this.rejectClosed?.(error);
    this.resolveClosed = undefined;
    this.rejectClosed = undefined;
    this.cleanup();
  }

  private cleanup(): void {
    this.serviceWorker.removeEventListener("message", this.onMessage);
    if (this.readyTimer !== undefined) {
      window.clearTimeout(this.readyTimer);
      this.readyTimer = undefined;
    }
    if (this.pingTimer !== undefined) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
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
