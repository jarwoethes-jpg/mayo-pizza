import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { ReceiverWorkerCommand, ReceiverWorkerEvent } from "./messages";

const ACK_INTERVAL = 4 * 1024 * 1024;

interface ReceiverSink {
  write(bytes: Uint8Array): void;
  close(): void;
  cancel(reason: string): void;
}

class DiscardSink implements ReceiverSink {
  public write(_bytes: Uint8Array): void {}
  public close(): void {}
  public cancel(_reason: string): void {}
}

interface ReceiverWorkerScope {
  onmessage: ((event: MessageEvent<ReceiverWorkerCommand>) => void) | null;
  postMessage: (message: ReceiverWorkerEvent) => void;
}

const workerScope = self as unknown as ReceiverWorkerScope;
const sink: ReceiverSink = new DiscardSink();

let totalBytes = 0;
let bytesDone = 0;
let nextAckAt = ACK_INTERVAL;
let hasher = sha256.create();
let startedAt = 0;
let lastProgressAt = 0;
let cancelled = false;
let finished = false;

const sendProgress = (force = false): void => {
  const now = performance.now();
  if (!force && now - lastProgressAt < 250) {
    return;
  }
  lastProgressAt = now;
  const elapsedSeconds = Math.max((now - startedAt) / 1000, 0.001);
  workerScope.postMessage({
    t: "progress",
    bytesDone,
    totalBytes,
    bytesPerSec: bytesDone / elapsedSeconds,
  });
};

const handleData = (buffer: ArrayBuffer): void => {
  if (cancelled || finished) {
    return;
  }
  const bytes = new Uint8Array(buffer);
  bytesDone += bytes.byteLength;
  hasher.update(bytes);
  sink.write(bytes);
  while (bytesDone >= nextAckAt) {
    workerScope.postMessage({ t: "ack", receivedBytes: nextAckAt });
    nextAckAt += ACK_INTERVAL;
  }
  sendProgress();
};

workerScope.onmessage = (event) => {
  const command = event.data;
  if (command.t === "cancel") {
    cancelled = true;
    sink.cancel("Transfer cancelled.");
    return;
  }
  if (command.t === "init") {
    totalBytes = command.totalBytes;
    bytesDone = command.offset;
    nextAckAt = Math.max(command.offset + ACK_INTERVAL, ACK_INTERVAL);
    hasher = sha256.create();
    startedAt = performance.now();
    lastProgressAt = 0;
    cancelled = false;
    finished = false;
    return;
  }
  if (command.t === "data") {
    handleData(command.buffer);
    return;
  }
  if (command.t === "finish") {
    if (cancelled || finished) {
      return;
    }
    finished = true;
    sink.close();
    sendProgress(true);
    workerScope.postMessage({
      t: "done",
      bytesDone,
      sha256: bytesToHex(hasher.digest()),
    });
    return;
  }
};
