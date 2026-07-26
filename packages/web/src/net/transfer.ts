import type { TransferMessage } from "shared";
import type {
  ReceiverWorkerCommand,
  ReceiverWorkerEvent,
  SenderWorkerCommand,
  SenderWorkerEvent,
} from "../worker/messages";
import type { PeerConnection } from "./peer";

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

export interface TransferControllerOptions {
  onProgress?: (progress: TransferProgress) => void;
  onResult?: (result: TransferResult) => void;
  onError?: (error: Error) => void;
  onCancelled?: (reason: string) => void;
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
  private receiverTotalBytes = 0;
  private receiverForwardedBytes = 0;
  private receiverStarted = false;
  private receiverFinishRequested = false;
  private receiverDoneMessage:
    | Extract<TransferMessage, { t: "done" }>
    | undefined;
  private destroyed = false;
  private ctrlOpen = false;
  private resolveChannels: (() => void) | undefined;
  private readonly channelsReady: Promise<void>;

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
        this.ctrlOpen = true;
        this.resolveIfChannelsReady();
      }),
      peer.on("data-open", () => {
        this.attachDataChannel();
        this.resolveIfChannelsReady();
      }),
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
    this.ctrlOpen = peer.ctrl?.readyState === "open";
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
    this.receiverTotalBytes = message.totalBytes;
    this.receiverForwardedBytes = 0;
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
    this.sendCtrl({
      t: "request",
      transferId: message.transferId,
      offset: 0,
    });
  }

  private handleRequest(
    message: Extract<TransferMessage, { t: "request" }>,
  ): void {
    if (this.role !== "uploader" || message.offset !== 0) {
      return;
    }
    if (
      this.transferId !== message.transferId ||
      this.senderFile === undefined
    ) {
      this.fail("The transfer request does not match the selected file.");
      return;
    }
    const worker = this.createSenderWorker();
    const dataChannel = this.peer.data;
    if (dataChannel === undefined) {
      this.fail("The data channel is unavailable.");
      return;
    }
    this.senderPump = new WatermarkFramePump(dataChannel, {
      frameSize: Math.min(FRAME_SIZE, this.peer.maxMessageSize ?? FRAME_SIZE),
      corruptFirstFrame: isCorruptionRequested(),
      onDrained: () => {
        if (this.senderLastSlice) {
          this.sendSenderDone();
        } else {
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
    worker.postMessage({
      t: "start",
      file: this.senderFile,
      offset: message.offset,
      totalBytes: this.senderFile.size,
    });
    this.requestNextSenderSlice();
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
    worker.onerror = (event) =>
      this.fail(event.message || "Sender worker failed.");
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
    worker.onmessage = (event) => this.handleReceiverWorkerEvent(event.data);
    worker.onerror = (event) =>
      this.fail(event.message || "Receiver worker failed.");
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
    this.senderReadPending = false;
    this.senderCursor = event.bytesDone;
    this.senderLastSlice = event.done;
    this.senderSha256 = event.sha256 ?? this.senderSha256;
    this.reportProgress({
      bytesDone: event.bytesDone,
      totalBytes: event.totalBytes,
      bytesPerSec: 0,
      side: "sender",
    });
    this.senderPump?.push(event.buffer);
  }

  private handleReceiverWorkerEvent(event: ReceiverWorkerEvent): void {
    if (this.destroyed) {
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
    if (event.t === "ack") {
      if (this.transferId !== undefined) {
        this.sendCtrl({ t: "ack", receivedBytes: event.receivedBytes });
      }
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
      this.senderLastSlice
    ) {
      return;
    }
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
    if (dataChannel === undefined || this.dataChannelCleanup !== undefined) {
      return;
    }
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
    this.resolveIfChannelsReady();
  }

  private maybeFinishReceiver(): void {
    if (
      this.role !== "downloader" ||
      this.receiverWorker === undefined ||
      this.receiverDoneMessage === undefined ||
      this.receiverForwardedBytes < this.receiverTotalBytes ||
      this.receiverFinishRequested === true
    ) {
      return;
    }
    this.receiverFinishRequested = true;
    this.receiverWorker.postMessage({ t: "finish" });
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
      this.peer.ctrl?.readyState === "open" &&
      this.peer.data?.readyState === "open"
    ) {
      this.resolveChannels?.();
      this.resolveChannels = undefined;
    }
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
    this.receiverTotalBytes = 0;
    this.receiverForwardedBytes = 0;
    this.receiverStarted = false;
    this.receiverFinishRequested = false;
    this.receiverDoneMessage = undefined;
  }
}

export const createTransferController = (
  role: "uploader" | "downloader",
  peer: PeerConnection,
  options: TransferControllerOptions = {},
): TransferController => new TransferController(role, peer, options);
