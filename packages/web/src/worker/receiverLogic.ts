import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { ReceiverWorkerCommand, ReceiverWorkerEvent } from "./messages";

export const RECEIVER_ACK_INTERVAL = 4 * 1024 * 1024;

export type ReceiverEventPoster = (
  message: ReceiverWorkerEvent,
  transfer?: Transferable[],
) => void;

/** Hashes received bytes and releases acknowledgements only after sink commits. */
export class ReceiverProcessor {
  private totalBytes = 0;
  private bytesDone = 0;
  private committedBytes = 0;
  private nextAckAt = RECEIVER_ACK_INTERVAL;
  private hasher = sha256.create();
  private startedAt = 0;
  private lastProgressAt = 0;
  private cancelled = false;
  private finished = false;
  private finishRequested = false;
  private nextChunkId = 0;
  private readonly pendingChunks = new Map<string, number>();

  public constructor(private readonly postMessage: ReceiverEventPoster) {}

  public handle(command: ReceiverWorkerCommand): void {
    if (command.t === "init") {
      this.init(command);
      return;
    }
    if (command.t === "cancel") {
      this.cancelled = true;
      this.pendingChunks.clear();
      return;
    }
    if (command.t === "sink-error") {
      this.cancelled = true;
      this.pendingChunks.clear();
      this.sendError(command.message);
      return;
    }
    if (command.t === "data") {
      this.handleData(command.buffer);
      return;
    }
    if (command.t === "commit") {
      this.handleCommit(command.chunkId);
      return;
    }
    if (command.t === "finish") {
      if (this.cancelled || this.finished) {
        return;
      }
      this.finishRequested = true;
      this.finishIfDrained();
    }
  }

  private init(command: Extract<ReceiverWorkerCommand, { t: "init" }>): void {
    this.totalBytes = command.totalBytes;
    this.bytesDone = command.offset;
    this.committedBytes = command.offset;
    this.nextAckAt = Math.max(
      command.offset + RECEIVER_ACK_INTERVAL,
      RECEIVER_ACK_INTERVAL,
    );
    this.hasher = sha256.create();
    this.startedAt = performance.now();
    this.lastProgressAt = 0;
    this.cancelled = false;
    this.finished = false;
    this.finishRequested = false;
    this.nextChunkId = 0;
    this.pendingChunks.clear();
  }

  private handleData(buffer: ArrayBuffer): void {
    if (this.cancelled || this.finished) {
      return;
    }
    const bytes = new Uint8Array(buffer);
    this.bytesDone += bytes.byteLength;
    this.hasher.update(bytes);
    const chunkId = `${this.nextChunkId}`;
    this.nextChunkId += 1;
    this.pendingChunks.set(chunkId, bytes.byteLength);
    this.postMessage(
      {
        t: "chunk",
        chunkId,
        buffer,
        bytesDone: this.bytesDone,
        totalBytes: this.totalBytes,
      },
      [buffer],
    );
    this.sendProgress();
  }

  private handleCommit(chunkId: string): void {
    if (this.cancelled || this.finished) {
      return;
    }
    const byteLength = this.pendingChunks.get(chunkId);
    if (byteLength === undefined) {
      this.sendError("The receiver sink committed an unknown chunk.");
      return;
    }
    this.pendingChunks.delete(chunkId);
    this.committedBytes += byteLength;
    while (this.committedBytes >= this.nextAckAt) {
      this.postMessage({ t: "ack", receivedBytes: this.nextAckAt });
      this.nextAckAt += RECEIVER_ACK_INTERVAL;
    }
    this.finishIfDrained();
  }

  private finishIfDrained(): void {
    if (
      !this.finishRequested ||
      this.cancelled ||
      this.finished ||
      this.pendingChunks.size > 0
    ) {
      return;
    }
    this.finished = true;
    this.sendProgress(true);
    this.postMessage({
      t: "done",
      bytesDone: this.bytesDone,
      sha256: bytesToHex(this.hasher.digest()),
    });
  }

  private sendProgress(force = false): void {
    const now = performance.now();
    if (!force && now - this.lastProgressAt < 250) {
      return;
    }
    this.lastProgressAt = now;
    const elapsedSeconds = Math.max((now - this.startedAt) / 1000, 0.001);
    this.postMessage({
      t: "progress",
      bytesDone: this.bytesDone,
      totalBytes: this.totalBytes,
      bytesPerSec: this.bytesDone / elapsedSeconds,
    });
  }

  private sendError(message: string): void {
    this.postMessage({ t: "error", message });
  }
}
