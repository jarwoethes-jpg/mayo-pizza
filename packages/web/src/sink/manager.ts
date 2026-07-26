import type { Sink } from "./index";

export const SINK_QUEUE_HIGH_WATERMARK = 8 * 1024 * 1024;
export const SINK_WRITE_TIMEOUT_MS = 30_000;

interface PendingWrite {
  bytes: Uint8Array;
  resolve: () => void;
  reject: (reason: unknown) => void;
}

const asError = (reason: unknown): Error =>
  reason instanceof Error ? reason : new Error(String(reason));

const withTimeout = async <T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<T> => {
  let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = globalThis.setTimeout(
      () => reject(new Error("The download sink stopped responding.")),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([operation, timeoutPromise]);
  } finally {
    if (timeout !== undefined) {
      globalThis.clearTimeout(timeout);
    }
  }
};

/** Serializes sink writes and converts a stuck or failed write into a transfer error. */
export class SinkManager {
  private readonly queue: PendingWrite[] = [];
  private queuedBytes = 0;
  private active: PendingWrite | undefined;
  private processing = false;
  private closeRequested = false;
  private closePromise: Promise<void> | undefined;
  private resolveClose: (() => void) | undefined;
  private rejectClose: ((reason: unknown) => void) | undefined;
  private failure: Error | undefined;
  private cancelled = false;

  public constructor(
    private readonly sink: Sink,
    private readonly highWatermark = SINK_QUEUE_HIGH_WATERMARK,
  ) {}

  public write(bytes: Uint8Array): Promise<void> {
    if (this.failure !== undefined) {
      return Promise.reject(this.failure);
    }
    if (this.cancelled || this.closeRequested) {
      return Promise.reject(
        new Error("The download sink is not accepting data."),
      );
    }
    const pendingBytes =
      (this.active?.bytes.byteLength ?? 0) + this.queuedBytes;
    if (
      pendingBytes > 0 &&
      pendingBytes + bytes.byteLength > this.highWatermark
    ) {
      return Promise.reject(
        new Error("The download sink write queue exceeded its safe limit."),
      );
    }
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ bytes, resolve, reject });
      this.queuedBytes += bytes.byteLength;
      void this.processNext();
    });
  }

  public close(): Promise<void> {
    if (this.closePromise !== undefined) {
      return this.closePromise;
    }
    if (this.failure !== undefined) {
      return Promise.reject(this.failure);
    }
    this.closeRequested = true;
    this.closePromise = new Promise<void>((resolve, reject) => {
      this.resolveClose = resolve;
      this.rejectClose = reject;
      void this.processNext();
      this.finishCloseIfReady();
    });
    return this.closePromise;
  }

  public cancel(reason: string): void {
    if (this.cancelled) {
      return;
    }
    this.cancelled = true;
    const error = new Error(reason);
    this.failure = error;
    for (const pending of this.queue.splice(0)) {
      pending.reject(error);
    }
    this.queuedBytes = 0;
    this.active?.reject(error);
    this.rejectClose?.(error);
    this.resolveClose = undefined;
    this.rejectClose = undefined;
    void Promise.resolve(this.sink.cancel(reason)).catch(() => undefined);
  }

  private async processNext(): Promise<void> {
    if (this.processing || this.cancelled || this.failure !== undefined) {
      return;
    }
    const next = this.queue.shift();
    if (next === undefined) {
      this.finishCloseIfReady();
      return;
    }
    this.queuedBytes -= next.bytes.byteLength;
    this.active = next;
    this.processing = true;
    try {
      await withTimeout(
        Promise.resolve(this.sink.write(next.bytes)),
        SINK_WRITE_TIMEOUT_MS,
      );
      if (!this.cancelled && this.failure === undefined) {
        next.resolve();
      }
    } catch (error) {
      const sinkError = asError(error);
      next.reject(sinkError);
      this.fail(sinkError);
    } finally {
      this.active = undefined;
      this.processing = false;
      void this.processNext();
      this.finishCloseIfReady();
    }
  }

  private finishCloseIfReady(): void {
    if (
      !this.closeRequested ||
      this.processing ||
      this.queue.length > 0 ||
      this.resolveClose === undefined
    ) {
      return;
    }
    const resolveClose = this.resolveClose;
    const rejectClose = this.rejectClose;
    this.resolveClose = undefined;
    this.rejectClose = undefined;
    void withTimeout(Promise.resolve(this.sink.close()), SINK_WRITE_TIMEOUT_MS)
      .then(resolveClose)
      .catch((error: unknown) => {
        const sinkError = asError(error);
        rejectClose?.(sinkError);
        this.fail(sinkError);
      });
  }

  private fail(error: Error): void {
    if (this.failure !== undefined) {
      return;
    }
    this.failure = error;
    for (const pending of this.queue.splice(0)) {
      pending.reject(error);
    }
    this.queuedBytes = 0;
    this.rejectClose?.(error);
    this.resolveClose = undefined;
    this.rejectClose = undefined;
  }
}
