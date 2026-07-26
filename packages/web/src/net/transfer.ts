import type { TransferMessage } from "shared";
import { createSink, type Sink, type SinkFactory, SinkManager } from "../sink";
import type {
  ReceiverWorkerCommand,
  ReceiverWorkerEvent,
  SenderWorkerCommand,
  SenderWorkerEvent,
} from "../worker/messages";
import type { PeerConnection } from "./peer";
import type { CtrlProtocol } from "./protocol";

export const FRAME_SIZE = 16_384;
export const READ_SLICE = 4 * 1024 * 1024;
export const HIGH_WATERMARK = 8 * 1024 * 1024;
export const ACK_INTERVAL = 4 * 1024 * 1024;
const BUFFERED_AMOUNT_REPORT_INTERVAL = 200;

export type TransferSide = "sender" | "receiver";

export interface TransferProgress {
  bytesDone: number;
  totalBytes: number;
  bytesPerSec: number;
  side: TransferSide;
}

export interface TransferResult {
  transferId: string;
  verified: boolean;
  sha256: string;
  expectedSha256?: string;
}

export type TransferManifestInfo = Extract<TransferMessage, { t: "manifest" }>;

export interface TransferControllerOptions {
  onManifest?: (manifestInfo: TransferManifestInfo) => void;
  onProgress?: (progress: TransferProgress) => void;
  onResult?: (result: TransferResult) => void;
  onError?: (error: Error) => void;
  onCancelled?: (reason: string) => void;
  onResumeRequested?: () => void;
  onBufferedAmount?: (
    bufferedAmount: number,
    maxBufferedAmount: number,
  ) => void;
  senderWorkerFactory?: () => WorkerLike<
    SenderWorkerCommand,
    SenderWorkerEvent
  >;
  receiverWorkerFactory?: () => WorkerLike<
    ReceiverWorkerCommand,
    ReceiverWorkerEvent
  >;
  sinkFactory?: SinkFactory;
}

export interface WorkerLike<Command, Event> {
  onmessage: ((event: MessageEvent<Event>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: Command, transfer?: Transferable[]): void;
  terminate(): void;
}

export interface DataChannelPumpTarget {
  bufferedAmount: number;
  send(data: ArrayBufferView): void;
  addEventListener(type: "bufferedamountlow", listener: () => void): void;
  removeEventListener(type: "bufferedamountlow", listener: () => void): void;
}

export interface WatermarkFramePumpOptions {
  frameSize?: number;
  highWatermark?: number;
  onDrained: () => void;
  onBufferedAmount?: (
    bufferedAmount: number,
    maxBufferedAmount: number,
  ) => void;
  corruptFirstFrame?: boolean;
}

/** Splits a byte buffer into ordered views without adding per-frame headers. */
export const splitBuffer = (
  buffer: ArrayBuffer,
  frameSize = FRAME_SIZE,
): Uint8Array[] => {
  const frames: Uint8Array[] = [];
  for (let offset = 0; offset < buffer.byteLength; offset += frameSize) {
    frames.push(
      new Uint8Array(
        buffer,
        offset,
        Math.min(frameSize, buffer.byteLength - offset),
      ),
    );
  }
  return frames;
};

export const joinFrames = (frames: readonly Uint8Array[]): Uint8Array => {
  const totalBytes = frames.reduce(
    (total, frame) => total + frame.byteLength,
    0,
  );
  const joined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const frame of frames) {
    joined.set(frame, offset);
    offset += frame.byteLength;
  }
  return joined;
};

/** Event-driven data-channel pump used by the sender worker integration. */
export class WatermarkFramePump {
  private readonly channel: DataChannelPumpTarget;
  private readonly frameSize: number;
  private readonly highWatermark: number;
  private readonly onDrained: () => void;
  private readonly onBufferedAmount:
    | ((bufferedAmount: number, maxBufferedAmount: number) => void)
    | undefined;
  private readonly corruptFirstFrame: boolean;
  private readonly onBufferedAmountLow = (): void => {
    this.reportBufferedAmount();
    this.pump();
  };
  private currentBuffer: Uint8Array | undefined;
  private currentOffset = 0;
  private waitingForLow = false;
  private pumping = false;
  private corrupted = false;
  private maxBufferedAmount = 0;
  private lastBufferedAmountReportAt = Number.NEGATIVE_INFINITY;
  private cancelled = false;

  public constructor(
    channel: DataChannelPumpTarget,
    options: WatermarkFramePumpOptions,
  ) {
    this.channel = channel;
    this.frameSize = Math.max(1, options.frameSize ?? FRAME_SIZE);
    this.highWatermark = options.highWatermark ?? HIGH_WATERMARK;
    this.onDrained = options.onDrained;
    this.onBufferedAmount = options.onBufferedAmount;
    this.corruptFirstFrame = options.corruptFirstFrame ?? false;
    channel.addEventListener("bufferedamountlow", this.onBufferedAmountLow);
    this.reportBufferedAmount();
  }

  public get maxBufferedAmountSeen(): number {
    return this.maxBufferedAmount;
  }

  public get hasPendingBuffer(): boolean {
    return this.currentBuffer !== undefined;
  }

  /** Flushes the latest observable state without changing peak tracking. */
  public flushReport(): void {
    this.reportBufferedAmount(true);
  }

  public push(buffer: ArrayBuffer): void {
    if (this.cancelled) {
      return;
    }
    if (this.currentBuffer !== undefined) {
      throw new Error("A sender slice is already being pumped.");
    }
    this.currentBuffer = new Uint8Array(buffer);
    this.currentOffset = 0;
    this.pump();
  }

  public cancel(): void {
    this.cancelled = true;
    this.currentBuffer = undefined;
    this.currentOffset = 0;
    this.channel.removeEventListener(
      "bufferedamountlow",
      this.onBufferedAmountLow,
    );
  }

  private pump(): void {
    if (this.cancelled || this.pumping) {
      return;
    }
    this.pumping = true;
    try {
      while (
        this.currentBuffer !== undefined &&
        this.currentOffset < this.currentBuffer.byteLength &&
        this.channel.bufferedAmount < this.highWatermark
      ) {
        const frameLength = Math.min(
          this.frameSize,
          this.currentBuffer.byteLength - this.currentOffset,
        );
        const frame = this.currentBuffer.subarray(
          this.currentOffset,
          this.currentOffset + frameLength,
        );
        if (this.corruptFirstFrame && !this.corrupted && frame.byteLength > 0) {
          const firstByte = frame[0];
          if (firstByte !== undefined) {
            frame[0] = firstByte ^ 1;
          }
          this.corrupted = true;
        }
        this.channel.send(frame);
        this.currentOffset += frameLength;
        this.trackBufferedAmount();
      }

      if (
        this.currentBuffer !== undefined &&
        this.currentOffset >= this.currentBuffer.byteLength
      ) {
        this.currentBuffer = undefined;
        this.currentOffset = 0;
        if (this.channel.bufferedAmount < this.highWatermark) {
          this.onDrained();
        } else {
          this.waitingForLow = true;
        }
      }

      if (
        this.waitingForLow &&
        this.currentBuffer === undefined &&
        this.channel.bufferedAmount < this.highWatermark
      ) {
        this.waitingForLow = false;
        this.onDrained();
      }
      this.reportBufferedAmount();
    } finally {
      this.pumping = false;
    }
  }

  private trackBufferedAmount(): void {
    this.maxBufferedAmount = Math.max(
      this.maxBufferedAmount,
      this.channel.bufferedAmount,
    );
  }

  private reportBufferedAmount(force = false): void {
    this.trackBufferedAmount();
    const now = performance.now();
    if (
      !force &&
      now - this.lastBufferedAmountReportAt < BUFFERED_AMOUNT_REPORT_INTERVAL
    ) {
      return;
    }
    this.lastBufferedAmountReportAt = now;
    this.onBufferedAmount?.(
      this.channel.bufferedAmount,
      this.maxBufferedAmount,
    );
  }
}

const makeTransferId = (): string => {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

const makeSenderWorker = (): WorkerLike<
  SenderWorkerCommand,
  SenderWorkerEvent
> =>
  new Worker(new URL("../worker/sender.worker.ts", import.meta.url), {
    type: "module",
  }) as unknown as WorkerLike<SenderWorkerCommand, SenderWorkerEvent>;

const makeReceiverWorker = (): WorkerLike<
  ReceiverWorkerCommand,
  ReceiverWorkerEvent
> =>
  new Worker(new URL("../worker/receiver.worker.ts", import.meta.url), {
    type: "module",
  }) as unknown as WorkerLike<ReceiverWorkerCommand, ReceiverWorkerEvent>;

const isCorruptionRequested = (): boolean =>
  typeof window !== "undefined" && window.__MAYO_CORRUPT_FRAME__ === true;

export class TransferController {
  private readonly peer: PeerConnection;
  private readonly options: TransferControllerOptions;
  private readonly unsubs: Array<() => void> = [];
  private dataChannelCleanup: (() => void) | undefined;
  private senderWorker:
    | WorkerLike<SenderWorkerCommand, SenderWorkerEvent>
    | undefined;
  private receiverWorker:
    | WorkerLike<ReceiverWorkerCommand, ReceiverWorkerEvent>
    | undefined;
  private senderPump: WatermarkFramePump | undefined;
  private transferId: string | undefined;
  private senderFile: File | undefined;
  private senderCursor = 0;
  private senderReadPending = false;
  private senderLastSlice = false;
  private senderSha256 = "";
  private senderDoneSent = false;
  private senderAckedBytes = 0;
  private senderWaitingForAck = false;
  private senderSliceDrained = false;
  private senderResuming = false;
  private pendingSenderRequest:
    | Extract<TransferMessage, { t: "request" }>
    | undefined;
  private receiverTotalBytes = 0;
  private receiverForwardedBytes = 0;
  private receiverSinkForwardedBytes = 0;
  private receiverCommittedBytes = 0;
  private receiverInFlightCommits = 0;
  private receiverResumeCtrl: CtrlProtocol | undefined;
  private receiverResumeData: RTCDataChannel | undefined;
  private receiverStarted = false;
  private receiverFinishRequested = false;
  private receiverSinkManager: SinkManager | undefined;
  private receiverManifest: TransferManifestInfo | undefined;
  private receiverAcceptPending = false;
  private receiverDoneMessage:
    | Extract<TransferMessage, { t: "done" }>
    | undefined;
  private destroyed = false;
  private ctrlOpen = false;
  private dataOpen = false;
  private ctrlOpenCount = 0;
  private currentCtrl: CtrlProtocol | undefined;
  private currentData: RTCDataChannel | undefined;
  private resolveChannels: (() => void) | undefined;
  private channelsReady: Promise<void>;

  public constructor(
    private readonly role: "uploader" | "downloader",
    peer: PeerConnection,
    options: TransferControllerOptions = {},
  ) {
    this.peer = peer;
    this.options = options;
    this.channelsReady = new Promise((resolve) => {
      this.resolveChannels = resolve;
    });
    this.unsubs.push(
      peer.on("ctrl-open", () => {
        this.refreshChannelGeneration();
        this.ctrlOpen = true;
        this.ctrlOpenCount += 1;
        this.resolveIfChannelsReady();
        this.maybeResumeReceiver();
      }),
      peer.on("data-open", () => {
        this.attachDataChannel();
        this.refreshChannelGeneration();
        this.dataOpen = true;
        this.resolveIfChannelsReady();
        this.maybeResumeReceiver();
      }),
      peer.on("exhausted", () =>
        this.fail("The connection was lost and could not be recovered."),
      ),
      peer.onCtrl("manifest", (message) => this.handleManifest(message)),
      peer.onCtrl("request", (message) => this.handleRequest(message)),
      peer.onCtrl("start", (message) => this.handleStart(message)),
      peer.onCtrl("done", (message) => this.handleDone(message)),
      peer.onCtrl("ack", (message) => this.handleAck(message)),
      peer.onCtrl("complete", (message) => this.handleComplete(message)),
      peer.onCtrl("error", (message) => this.handleRemoteError(message)),
      peer.onCtrl("cancel", (message) => this.handleCancel(message)),
    );
    this.attachDataChannel();
    this.refreshChannelGeneration();
    this.ctrlOpen = peer.ctrl?.readyState === "open";
    this.dataOpen = peer.data?.readyState === "open";
    this.resolveIfChannelsReady();
  }

  public async startSend(file: File): Promise<void> {
    if (this.role !== "uploader") {
      throw new Error("Only the uploader can start a file transfer.");
    }
    if (this.destroyed) {
      throw new Error("The transfer controller is closed.");
    }
    this.teardownActiveTransfer();
    await this.channelsReady;
    if (this.destroyed) {
      return;
    }

    const transferId = makeTransferId();
    this.transferId = transferId;
    this.senderFile = file;
    this.senderCursor = 0;
    this.senderReadPending = false;
    this.senderLastSlice = false;
    this.senderSha256 = "";
    this.senderDoneSent = false;
    this.senderAckedBytes = 0;
    this.senderWaitingForAck = false;
    this.senderSliceDrained = false;
    this.sendCtrl({
      t: "manifest",
      transferId,
      mode: "single",
      items: [
        {
          path: file.name,
          size: file.size,
          lastModified: file.lastModified,
        },
      ],
      totalBytes: file.size,
      suggestedName: file.name,
    });
  }

  public cancel(reason = "Transfer cancelled."): void {
    if (this.destroyed) {
      return;
    }
    if (this.transferId !== undefined) {
      this.trySendCtrl({ t: "cancel", reason });
    }
    this.destroy();
    this.options.onCancelled?.(reason);
  }

  /** Accepts the current manifest and starts sink creation from the caller's gesture. */
  public acceptTransfer(): void {
    if (
      this.role !== "downloader" ||
      this.transferId === undefined ||
      this.receiverSinkManager !== undefined ||
      this.receiverAcceptPending
    ) {
      return;
    }
    const transferId = this.transferId;
    const manifest = this.receiverManifest;
    if (manifest === undefined) {
      return;
    }
    this.receiverAcceptPending = true;
    let sinkResult: Sink | Promise<Sink>;
    try {
      // Do not move this call below an await: FSA needs the original click gesture.
      sinkResult = createSink(
        manifest.suggestedName,
        manifest.totalBytes,
        this.options.sinkFactory,
      );
    } catch (error) {
      this.fail(
        this.errorMessage(error, "Could not prepare the download sink."),
      );
      return;
    }
    void Promise.resolve(sinkResult)
      .then((sink) => {
        if (this.destroyed || this.transferId !== transferId) {
          void Promise.resolve(
            sink.cancel("The transfer is no longer active."),
          ).catch(() => undefined);
          return;
        }
        this.receiverAcceptPending = false;
        this.receiverSinkManager = new SinkManager(sink);
        this.sendCtrl({
          t: "request",
          transferId,
          offset: 0,
        });
      })
      .catch((error: unknown) => {
        this.receiverAcceptPending = false;
        this.fail(
          this.errorMessage(error, "Could not prepare the download sink."),
        );
      });
  }

  /** Rejects the current manifest while leaving the peer available for another transfer. */
  public rejectTransfer(reason = "The receiver rejected the transfer."): void {
    if (this.role !== "downloader" || this.transferId === undefined) {
      return;
    }
    this.trySendCtrl({ t: "cancel", reason });
    this.teardownActiveTransfer();
    this.options.onCancelled?.(reason);
  }

  public destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.teardownActiveTransfer();
    this.dataChannelCleanup?.();
    this.dataChannelCleanup = undefined;
    for (const unsubscribe of this.unsubs.splice(0)) {
      unsubscribe();
    }
    this.resolveChannels?.();
  }

  private handleManifest(
    message: Extract<TransferMessage, { t: "manifest" }>,
  ): void {
    if (this.role !== "downloader") {
      return;
    }
    if (
      message.mode !== "single" ||
      message.items.length !== 1 ||
      message.items[0]?.size !== message.totalBytes
    ) {
      this.fail("Only a single-file manifest is supported.");
      return;
    }
    this.teardownActiveTransfer();
    this.transferId = message.transferId;
    this.receiverManifest = message;
    this.receiverTotalBytes = message.totalBytes;
    this.receiverForwardedBytes = 0;
    this.receiverCommittedBytes = 0;
    this.receiverInFlightCommits = 0;
    this.receiverResumeCtrl = undefined;
    this.receiverResumeData = undefined;
    this.receiverStarted = false;
    this.receiverFinishRequested = false;
    this.receiverDoneMessage = undefined;
    const worker = this.createReceiverWorker();
    worker.postMessage({
      t: "init",
      transferId: message.transferId,
      offset: 0,
      totalBytes: message.totalBytes,
    });
    try {
      this.options.onManifest?.(message);
    } catch (error) {
      this.fail(
        this.errorMessage(error, "Could not handle the transfer manifest."),
      );
    }
  }

  private handleRequest(
    message: Extract<TransferMessage, { t: "request" }>,
  ): void {
    if (this.role !== "uploader") {
      return;
    }
    if (
      this.transferId !== message.transferId ||
      this.senderFile === undefined
    ) {
      // A stale request can arrive after the sender has completed or replaced
      // a transfer. It is harmless and must not tear down a healthy session.
      return;
    }
    if (
      message.offset > this.senderFile.size ||
      (message.offset > 0 && this.senderResuming)
    ) {
      return;
    }
    const dataChannel = this.peer.data;
    if (dataChannel === undefined || dataChannel.readyState !== "open") {
      this.pendingSenderRequest = message;
      return;
    }
    this.pendingSenderRequest = undefined;
    this.senderPump?.cancel();
    const hadWorker = this.senderWorker !== undefined;
    const worker = this.senderWorker ?? this.createSenderWorker();
    this.senderResuming = message.offset > 0;
    this.senderCursor = message.offset;
    this.senderReadPending = false;
    this.senderLastSlice = false;
    this.senderSha256 = "";
    this.senderDoneSent = false;
    this.senderAckedBytes = message.offset;
    this.senderWaitingForAck = false;
    this.senderSliceDrained = false;
    this.senderPump = new WatermarkFramePump(dataChannel, {
      frameSize: Math.min(FRAME_SIZE, this.peer.maxMessageSize ?? FRAME_SIZE),
      corruptFirstFrame: isCorruptionRequested(),
      onDrained: () => {
        this.senderSliceDrained = true;
        if (this.senderLastSlice) {
          this.sendSenderDone();
        } else {
          this.senderWaitingForAck = true;
          this.requestNextSenderSlice();
        }
      },
      onBufferedAmount: (bufferedAmount, maxBufferedAmount) => {
        this.reportBufferedAmount(bufferedAmount, maxBufferedAmount);
      },
    });
    this.sendCtrl({
      t: "start",
      transferId: message.transferId,
      offset: message.offset,
    });
    if (!hadWorker || message.offset === 0) {
      // Offset zero can also be a reconnect before the first durable byte;
      // reset the existing worker rather than continuing its old hash state.
      worker.postMessage({
        t: "start",
        file: this.senderFile,
        offset: 0,
        totalBytes: this.senderFile.size,
      });
    }
    if (message.offset > 0) {
      // The worker re-seeds from its nearest 4 MiB hash snapshot and reads at
      // most one slice to reach the exact durable receiver offset.
      worker.postMessage({ t: "resume", offset: message.offset });
    } else {
      this.requestNextSenderSlice();
    }
  }

  private handleStart(message: Extract<TransferMessage, { t: "start" }>): void {
    if (this.role === "downloader" && message.transferId === this.transferId) {
      this.receiverStarted = true;
      this.maybeFinishReceiver();
    }
  }

  private handleDone(message: Extract<TransferMessage, { t: "done" }>): void {
    if (this.role !== "downloader" || message.transferId !== this.transferId) {
      return;
    }
    this.receiverDoneMessage = message;
    this.maybeFinishReceiver();
  }

  private handleAck(message: Extract<TransferMessage, { t: "ack" }>): void {
    if (this.role === "uploader" && this.transferId !== undefined) {
      this.senderAckedBytes = Math.max(
        this.senderAckedBytes,
        message.receivedBytes,
      );
      if (this.senderWaitingForAck) {
        this.senderWaitingForAck = false;
        this.requestNextSenderSlice();
      }
      console.debug("[mayo.transfer.ack]", message.receivedBytes);
    }
  }

  private handleComplete(
    message: Extract<TransferMessage, { t: "complete" }>,
  ): void {
    if (this.role !== "uploader" || message.transferId !== this.transferId) {
      return;
    }
    this.senderPump?.flushReport();
    this.options.onResult?.({
      transferId: message.transferId,
      verified: message.verified,
      sha256: this.senderSha256,
    });
    this.teardownActiveTransfer();
  }

  private handleRemoteError(
    message: Extract<TransferMessage, { t: "error" }>,
  ): void {
    this.fail(`${message.code}: ${message.message}`, false);
  }

  private handleCancel(
    message: Extract<TransferMessage, { t: "cancel" }>,
  ): void {
    this.destroy();
    this.options.onCancelled?.(message.reason);
  }

  private createSenderWorker(): WorkerLike<
    SenderWorkerCommand,
    SenderWorkerEvent
  > {
    this.senderWorker?.terminate();
    const worker = this.options.senderWorkerFactory?.() ?? makeSenderWorker();
    this.senderWorker = worker;
    worker.onmessage = (event) => this.handleSenderWorkerEvent(event.data);
    worker.onerror = (event) => {
      this.fail(event.message || "Sender worker failed.");
    };
    return worker;
  }

  private createReceiverWorker(): WorkerLike<
    ReceiverWorkerCommand,
    ReceiverWorkerEvent
  > {
    this.receiverWorker?.terminate();
    const worker =
      this.options.receiverWorkerFactory?.() ?? makeReceiverWorker();
    this.receiverWorker = worker;
    worker.onmessage = (event) =>
      this.handleReceiverWorkerEvent(event.data, worker);
    worker.onerror = (event) => {
      if (this.receiverWorker !== worker) {
        return;
      }
      this.fail(event.message || "Receiver worker failed.");
    };
    return worker;
  }

  private handleSenderWorkerEvent(event: SenderWorkerEvent): void {
    if (this.destroyed) {
      return;
    }
    if (event.t === "error") {
      this.fail(event.message);
      return;
    }
    if (event.t === "progress") {
      this.reportProgress({ ...event, side: "sender" });
      return;
    }
    if (event.t === "resumed") {
      this.senderResuming = false;
      this.senderReadPending = false;
      this.senderCursor = event.offset;
      this.senderLastSlice = false;
      this.senderSha256 = "";
      // Resume has no buffered slice in the new pump; the next read is safe
      // as soon as the worker confirms the hash covers 0..offset.
      this.senderSliceDrained = true;
      this.requestNextSenderSlice();
      return;
    }
    if (this.senderResuming) {
      // A slice read by the previous channel generation may still be queued
      // when the resume command arrives; it belongs to the cancelled pump.
      return;
    }
    this.senderReadPending = false;
    this.senderCursor = event.bytesDone;
    this.senderLastSlice = event.done;
    this.senderSha256 = event.sha256 ?? this.senderSha256;
    this.senderSliceDrained = false;
    this.reportProgress({
      bytesDone: event.bytesDone,
      totalBytes: event.totalBytes,
      bytesPerSec: 0,
      side: "sender",
    });
    this.senderPump?.push(event.buffer);
  }

  private handleReceiverWorkerEvent(
    event: ReceiverWorkerEvent,
    worker: WorkerLike<ReceiverWorkerCommand, ReceiverWorkerEvent>,
  ): void {
    if (this.destroyed || this.receiverWorker !== worker) {
      return;
    }
    if (event.t === "error") {
      this.fail(event.message);
      return;
    }
    if (event.t === "progress") {
      this.reportProgress({ ...event, side: "receiver" });
      return;
    }
    if (event.t === "chunk") {
      const sinkManager = this.receiverSinkManager;
      const worker = this.receiverWorker;
      if (sinkManager === undefined || worker === undefined) {
        this.fail("The receiver sink is not ready.");
        return;
      }
      this.receiverSinkForwardedBytes += event.buffer.byteLength;
      if (this.receiverSinkForwardedBytes > this.receiverTotalBytes) {
        this.fail("The receiver worker exceeded the manifest size.");
        return;
      }
      this.receiverInFlightCommits += 1;
      void sinkManager
        .write(new Uint8Array(event.buffer))
        .then(() => {
          this.receiverInFlightCommits = Math.max(
            0,
            this.receiverInFlightCommits - 1,
          );
          if (this.destroyed || this.receiverWorker !== worker) {
            return;
          }
          this.receiverCommittedBytes += event.buffer.byteLength;
          worker.postMessage({ t: "commit", chunkId: event.chunkId });
          this.maybeResumeReceiver();
        })
        .catch((error: unknown) => {
          this.receiverInFlightCommits = Math.max(
            0,
            this.receiverInFlightCommits - 1,
          );
          if (this.destroyed || this.receiverWorker !== worker) {
            return;
          }
          const message = this.errorMessage(error, "The download sink failed.");
          try {
            worker.postMessage({ t: "sink-error", message });
          } catch {
            // The worker may already be terminating after the sink failure.
          }
          this.fail(message);
        });
      this.maybeFinishReceiver();
      return;
    }
    if (event.t === "ack") {
      if (this.transferId !== undefined) {
        this.sendCtrl({ t: "ack", receivedBytes: event.receivedBytes });
      }
      return;
    }
    if (event.t !== "done") {
      this.fail("The receiver worker sent an invalid terminal event.");
      return;
    }
    if (
      !this.receiverFinishRequested ||
      !this.receiverStarted ||
      this.receiverSinkManager === undefined ||
      this.receiverCommittedBytes < this.receiverTotalBytes
    ) {
      this.fail("The receiver worker finished before the sink was drained.");
      return;
    }
    const doneMessage = this.receiverDoneMessage;
    const verified =
      doneMessage !== undefined &&
      this.receiverStarted &&
      event.bytesDone === this.receiverTotalBytes &&
      event.sha256 === doneMessage.sha256;
    const result: TransferResult = {
      transferId: this.transferId ?? "",
      verified,
      sha256: event.sha256,
      ...(doneMessage === undefined
        ? {}
        : { expectedSha256: doneMessage.sha256 }),
    };
    if (this.transferId !== undefined) {
      this.sendCtrl({
        t: "complete",
        transferId: this.transferId,
        verified,
      });
    }
    this.options.onResult?.(result);
    this.teardownActiveTransfer();
  }

  private requestNextSenderSlice(): void {
    if (
      this.senderWorker === undefined ||
      this.senderReadPending ||
      this.senderLastSlice ||
      (this.senderCursor > 0 &&
        (!this.senderSliceDrained || this.senderAckedBytes < this.senderCursor))
    ) {
      return;
    }
    this.senderWaitingForAck = false;
    this.senderReadPending = true;
    this.senderWorker.postMessage({ t: "read", offset: this.senderCursor });
  }

  private sendSenderDone(): void {
    if (this.senderDoneSent || this.transferId === undefined) {
      return;
    }
    if (this.senderSha256 === "") {
      this.fail("The sender hash is not ready.");
      return;
    }
    this.senderDoneSent = true;
    this.sendCtrl({
      t: "done",
      transferId: this.transferId,
      sha256: this.senderSha256,
    });
  }

  private attachDataChannel(): void {
    const dataChannel = this.peer.data;
    if (dataChannel === undefined || this.currentData === dataChannel) {
      return;
    }
    this.dataChannelCleanup?.();
    this.dataChannelCleanup = undefined;
    this.currentData = dataChannel;
    this.receiverForwardedBytes = this.receiverCommittedBytes;
    const onMessage = (event: MessageEvent<unknown>): void => {
      if (this.role !== "downloader" || this.receiverWorker === undefined) {
        return;
      }
      if (!(event.data instanceof ArrayBuffer)) {
        this.fail("The data channel delivered a non-binary frame.");
        return;
      }
      this.receiverForwardedBytes += event.data.byteLength;
      if (this.receiverForwardedBytes > this.receiverTotalBytes) {
        this.fail("The data stream exceeded the manifest size.");
        return;
      }
      this.receiverWorker.postMessage({ t: "data", buffer: event.data }, [
        event.data,
      ]);
      this.maybeFinishReceiver();
    };
    dataChannel.addEventListener("message", onMessage);
    this.dataChannelCleanup = () => {
      dataChannel.removeEventListener("message", onMessage);
    };
    this.refreshChannelGeneration();
    this.resolveIfChannelsReady();
    if (this.pendingSenderRequest !== undefined) {
      this.handleRequest(this.pendingSenderRequest);
    }
  }

  private maybeResumeReceiver(): void {
    if (
      this.role !== "downloader" ||
      this.ctrlOpenCount < 2 ||
      !this.ctrlOpen ||
      !this.dataOpen ||
      this.peer.ctrl?.readyState !== "open" ||
      this.peer.data?.readyState !== "open" ||
      this.transferId === undefined ||
      this.receiverSinkManager === undefined ||
      this.receiverWorker === undefined ||
      this.receiverCommittedBytes >= this.receiverTotalBytes
    ) {
      return;
    }
    if (
      this.receiverResumeCtrl === this.peer.ctrl &&
      this.receiverResumeData === this.peer.data
    ) {
      return;
    }
    if (this.receiverInFlightCommits > 0) {
      return;
    }
    this.receiverResumeCtrl = this.peer.ctrl;
    this.receiverResumeData = this.peer.data;
    const worker = this.receiverWorker;
    worker.postMessage({ t: "resume-seed" });
    try {
      this.sendCtrl({
        t: "request",
        transferId: this.transferId,
        offset: this.receiverCommittedBytes,
      });
      this.options.onResumeRequested?.();
    } catch (error) {
      this.receiverResumeCtrl = undefined;
      this.receiverResumeData = undefined;
      this.fail(this.errorMessage(error, "The resume channel is not ready."));
    }
  }

  private maybeFinishReceiver(): void {
    if (
      this.role !== "downloader" ||
      this.receiverWorker === undefined ||
      this.receiverSinkManager === undefined ||
      this.receiverDoneMessage === undefined ||
      !this.receiverStarted ||
      this.receiverForwardedBytes < this.receiverTotalBytes ||
      this.receiverSinkForwardedBytes < this.receiverTotalBytes ||
      this.receiverFinishRequested === true
    ) {
      return;
    }
    this.receiverFinishRequested = true;
    const worker = this.receiverWorker;
    void this.receiverSinkManager
      .close()
      .then(() => {
        if (this.destroyed || this.receiverWorker !== worker) {
          return;
        }
        worker.postMessage({ t: "finish" });
      })
      .catch((error: unknown) => {
        this.fail(
          this.errorMessage(error, "The download sink failed to close."),
        );
      });
  }

  private sendCtrl(message: TransferMessage): void {
    const ctrl = this.peer.ctrl;
    if (ctrl === undefined || ctrl.readyState !== "open") {
      throw new Error("The ctrl channel is not open.");
    }
    ctrl.send(message);
  }

  private trySendCtrl(message: TransferMessage): void {
    try {
      this.sendCtrl(message);
    } catch {
      // The peer may already be gone during cancellation.
    }
  }

  private resolveIfChannelsReady(): void {
    if (
      this.ctrlOpen &&
      this.dataOpen &&
      this.peer.ctrl?.readyState === "open" &&
      this.peer.data?.readyState === "open"
    ) {
      this.resolveChannels?.();
      this.resolveChannels = undefined;
    }
  }

  private refreshChannelGeneration(): void {
    const ctrl = this.peer.ctrl;
    const data = this.peer.data;
    if (ctrl === this.currentCtrl && data === this.currentData) {
      return;
    }
    this.currentCtrl = ctrl;
    this.currentData = data;
    this.ctrlOpen = ctrl?.readyState === "open";
    this.dataOpen = data?.readyState === "open";
    this.channelsReady = new Promise((resolve) => {
      this.resolveChannels = resolve;
    });
  }

  private reportProgress(progress: TransferProgress): void {
    console.debug("[mayo.transfer.progress]", progress);
    this.options.onProgress?.(progress);
  }

  private reportBufferedAmount(
    bufferedAmount: number,
    maxBufferedAmount: number,
  ): void {
    if (typeof window !== "undefined") {
      window.__MAYO_TRANSFER_STATS__ = {
        bufferedAmount,
        maxBufferedAmount,
      };
    }
    console.debug("[mayo.transfer.bufferedAmount]", bufferedAmount);
    this.options.onBufferedAmount?.(bufferedAmount, maxBufferedAmount);
  }

  private fail(message: string, sendRemote = true): void {
    if (this.destroyed) {
      return;
    }
    const error = new Error(message);
    if (sendRemote) {
      this.trySendCtrl({
        t: "error",
        code: "TRANSFER_FAILED",
        message,
      });
    }
    this.destroy();
    this.options.onError?.(error);
  }

  private teardownActiveTransfer(): void {
    this.receiverSinkManager?.cancel("Transfer cancelled.");
    this.receiverSinkManager = undefined;
    this.receiverAcceptPending = false;
    this.senderPump?.cancel();
    this.senderPump = undefined;
    if (this.senderWorker !== undefined) {
      this.senderWorker.onmessage = null;
      this.senderWorker.onerror = null;
      try {
        this.senderWorker.postMessage({ t: "cancel" });
      } catch {
        // The worker may already have exited.
      }
      this.senderWorker.terminate();
      this.senderWorker = undefined;
    }
    if (this.receiverWorker !== undefined) {
      this.receiverWorker.onmessage = null;
      this.receiverWorker.onerror = null;
      try {
        this.receiverWorker.postMessage({ t: "cancel" });
      } catch {
        // The worker may already have exited.
      }
      this.receiverWorker.terminate();
      this.receiverWorker = undefined;
    }
    this.transferId = undefined;
    this.senderFile = undefined;
    this.senderCursor = 0;
    this.senderReadPending = false;
    this.senderLastSlice = false;
    this.senderSha256 = "";
    this.senderDoneSent = false;
    this.senderAckedBytes = 0;
    this.senderWaitingForAck = false;
    this.senderSliceDrained = false;
    this.senderResuming = false;
    this.pendingSenderRequest = undefined;
    this.receiverTotalBytes = 0;
    this.receiverForwardedBytes = 0;
    this.receiverSinkForwardedBytes = 0;
    this.receiverCommittedBytes = 0;
    this.receiverInFlightCommits = 0;
    this.receiverResumeCtrl = undefined;
    this.receiverResumeData = undefined;
    this.receiverStarted = false;
    this.receiverFinishRequested = false;
    this.receiverDoneMessage = undefined;
    this.receiverManifest = undefined;
  }

  private errorMessage(reason: unknown, fallback: string): string {
    return reason instanceof Error && reason.message !== ""
      ? reason.message
      : fallback;
  }
}

export const createTransferController = (
  role: "uploader" | "downloader",
  peer: PeerConnection,
  options: TransferControllerOptions = {},
): TransferController => new TransferController(role, peer, options);
