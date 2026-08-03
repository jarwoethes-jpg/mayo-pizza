import type { Sink } from "./index";

export const SINK_QUEUE_HIGH_WATERMARK = 8 * 1024 * 1024;
export const SINK_STALL_NOTICE_MS = 30_000;
export const SINK_SW_NO_CONSUMER_STALL_MS = 45_000;
export const SINK_SW_NO_CONSUMER_MAX_COMMITTED_BYTES = 32 * 1024 * 1024;
export const SINK_STALL_ABORT_MS = 600_000;
export const SINK_START_TIMEOUT_MS = 60_000;

export interface SinkStall {
  stalled: boolean;
  sinceMs: number;
  reason?: "sw-no-consumer";
}

/** Identifies the service-worker stall that can be recovered by restarting on blob. */
export class SwNoConsumerStallError extends Error {
  public readonly recoverable = true;

  public constructor() {
    super(
      "The service-worker download stalled because no download consumer attached.",
    );
    this.name = "SwNoConsumerStallError";
  }
}

/** Checks whether a sink failure is the recoverable service-worker no-consumer stall. */
export const isSwNoConsumerStallError = (
  error: unknown,
): error is SwNoConsumerStallError => error instanceof SwNoConsumerStallError;

export interface SinkManagerOptions {
  highWatermark?: number;
  onStallChange?: (stall: SinkStall | undefined) => void;
}

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

/** Serializes sink writes and makes prolonged backpressure observable and bounded. */
export class SinkManager {
  private readonly queue: PendingWrite[] = [];
  private readonly highWatermark: number;
  private readonly onStallChange:
    | ((stall: SinkStall | undefined) => void)
    | undefined;
  private queuedBytes = 0;
  private active: PendingWrite | undefined;
  private hasCompletedWrite = false;
  private committedBytes = 0;
  private processing = false;
  private closeRequested = false;
  private closePromise: Promise<void> | undefined;
  private resolveClose: (() => void) | undefined;
  private rejectClose: ((reason: unknown) => void) | undefined;
  private failure: Error | undefined;
  private cancelled = false;
  private stallNoticeTimer:
    | ReturnType<typeof globalThis.setTimeout>
    | undefined;
  private stallAbortTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  private stalledSinceMs: number | undefined;

  public constructor(
    private readonly sink: Sink,
    highWatermarkOrOptions: number | SinkManagerOptions = {},
  ) {
    if (typeof highWatermarkOrOptions === "number") {
      this.highWatermark = highWatermarkOrOptions;
      this.onStallChange = undefined;
    } else {
      this.highWatermark =
        highWatermarkOrOptions.highWatermark ?? SINK_QUEUE_HIGH_WATERMARK;
      this.onStallChange = highWatermarkOrOptions.onStallChange;
    }
  }

  public write(bytes: Uint8Array): Promise<void> {
    // A network drop does not cancel this queue: the peer generation can be
    // replaced while local sink writes keep draining toward the durable cursor.
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
    this.clearWriteTimers();
    this.onStallChange?.(undefined);
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
    this.armWriteTimers(next);
    try {
      await Promise.resolve(this.sink.write(next.bytes));
      if (!this.cancelled && this.failure === undefined) {
        this.committedBytes += next.bytes.byteLength;
        this.hasCompletedWrite = true;
        next.resolve();
      }
    } catch (error) {
      const sinkError = asError(error);
      next.reject(sinkError);
      this.fail(sinkError);
    } finally {
      this.clearWriteTimers(true);
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
    void withTimeout(Promise.resolve(this.sink.close()), SINK_STALL_ABORT_MS)
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
    this.clearWriteTimers();
    this.onStallChange?.(undefined);
    for (const pending of this.queue.splice(0)) {
      pending.reject(error);
    }
    this.queuedBytes = 0;
    this.rejectClose?.(error);
    this.resolveClose = undefined;
    this.rejectClose = undefined;
  }

  private armWriteTimers(pending: PendingWrite): void {
    this.clearWriteTimers();
    const useSwNoConsumerBudget =
      this.sink.strategy === "sw" &&
      this.hasCompletedWrite &&
      this.committedBytes <= SINK_SW_NO_CONSUMER_MAX_COMMITTED_BYTES &&
      this.sink.isResponsive?.() !== false;
    this.stallNoticeTimer = globalThis.setTimeout(() => {
      if (
        this.active !== pending ||
        this.cancelled ||
        this.failure !== undefined
      ) {
        return;
      }
      const sinceMs = Date.now();
      this.stalledSinceMs = sinceMs;
      this.onStallChange?.({ stalled: true, sinceMs });
    }, SINK_STALL_NOTICE_MS);
    this.stallAbortTimer = globalThis.setTimeout(
      () => {
        if (
          this.active !== pending ||
          this.cancelled ||
          this.failure !== undefined
        ) {
          return;
        }
        // WHY: liveness pings that still get answers are positive evidence that
        // the worker is alive while credits have stopped. That isolates the
        // Chromium lost-user-activation failure to the missing download
        // consumer. A dead worker must retain its own message and long budget.
        const isSwNoConsumerStall =
          this.sink.strategy === "sw" &&
          this.hasCompletedWrite &&
          this.committedBytes <= SINK_SW_NO_CONSUMER_MAX_COMMITTED_BYTES &&
          this.sink.isResponsive?.() !== false;
        if (isSwNoConsumerStall) {
          this.onStallChange?.({
            stalled: true,
            sinceMs: this.stalledSinceMs ?? Date.now(),
            reason: "sw-no-consumer",
          });
        }
        const message = this.hasCompletedWrite
          ? isSwNoConsumerStall
            ? new SwNoConsumerStallError()
            : this.sink.isResponsive?.() === false
              ? "The download service worker stopped responding."
              : "The download has been paused for too long. Your browser stopped accepting data."
          : "The download never started — your browser did not begin saving the file. Check for a blocked or dismissed download prompt, then try again.";
        const error = message instanceof Error ? message : new Error(message);
        pending.reject(error);
        this.fail(error);
      },
      useSwNoConsumerBudget
        ? SINK_SW_NO_CONSUMER_STALL_MS
        : this.hasCompletedWrite
          ? SINK_STALL_ABORT_MS
          : SINK_START_TIMEOUT_MS,
    );
  }

  private clearWriteTimers(reportRecovery = false): void {
    if (this.stallNoticeTimer !== undefined) {
      globalThis.clearTimeout(this.stallNoticeTimer);
      this.stallNoticeTimer = undefined;
    }
    if (this.stallAbortTimer !== undefined) {
      globalThis.clearTimeout(this.stallAbortTimer);
      this.stallAbortTimer = undefined;
    }
    if (this.stalledSinceMs !== undefined) {
      const sinceMs = this.stalledSinceMs;
      this.stalledSinceMs = undefined;
      if (reportRecovery) {
        this.onStallChange?.({ stalled: false, sinceMs });
      }
    }
  }
}
