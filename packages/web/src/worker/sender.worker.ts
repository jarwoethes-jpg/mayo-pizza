import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { SenderWorkerCommand, SenderWorkerEvent } from "./messages";

const READ_SLICE = 4 * 1024 * 1024;

interface SenderWorkerScope {
  onmessage: ((event: MessageEvent<SenderWorkerCommand>) => void) | null;
  postMessage: (message: SenderWorkerEvent, transfer?: Transferable[]) => void;
}

const workerScope = self as unknown as SenderWorkerScope;

let file: File | undefined;
let totalBytes = 0;
let cursor = 0;
let hasher = sha256.create();
let cancelled = false;
let busy = false;
let startedAt = 0;
let lastProgressAt = 0;
let operationId = 0;
const snapshots: Array<{
  offset: number;
  state: ReturnType<typeof sha256.create>;
}> = [];

const sendProgress = (force = false): void => {
  const now = performance.now();
  if (!force && now - lastProgressAt < 250) {
    return;
  }
  lastProgressAt = now;
  const elapsedSeconds = Math.max((now - startedAt) / 1000, 0.001);
  workerScope.postMessage({
    t: "progress",
    bytesDone: cursor,
    totalBytes,
    bytesPerSec: cursor / elapsedSeconds,
  });
};

const sendError = (message: string): void => {
  workerScope.postMessage({ t: "error", message });
};

const readNextSlice = async (
  requestedOffset: number,
  currentOperation: number,
): Promise<void> => {
  if (busy || cancelled || file === undefined) {
    return;
  }
  if (requestedOffset !== cursor) {
    sendError("Sender slice request is out of order.");
    return;
  }

  busy = true;
  try {
    const end = Math.min(cursor + READ_SLICE, file.size);
    const buffer = await file.slice(cursor, end).arrayBuffer();
    if (cancelled || currentOperation !== operationId) {
      return;
    }

    hasher.update(new Uint8Array(buffer));
    cursor = end;
    snapshots.push({ offset: cursor, state: hasher.clone() });
    const done = cursor >= file.size;
    const event: SenderWorkerEvent = {
      t: "slice",
      buffer,
      bytesDone: cursor,
      totalBytes,
      done,
      ...(done ? { sha256: bytesToHex(hasher.clone().digest()) } : {}),
    };
    workerScope.postMessage(event, [buffer]);
    sendProgress(done);
  } catch (error) {
    sendError(
      error instanceof Error ? error.message : "Could not read the file.",
    );
  } finally {
    if (currentOperation === operationId) {
      busy = false;
    }
  }
};

const resumeFrom = async (offset: number): Promise<void> => {
  if (file === undefined || offset < 0 || offset > file.size) {
    sendError("The sender resume offset is outside the selected file.");
    return;
  }
  const currentOperation = ++operationId;
  cancelled = false;
  busy = true;
  try {
    let seedOffset = 0;
    let seedState = sha256.create();
    for (const snapshot of snapshots) {
      if (snapshot.offset > offset) {
        break;
      }
      seedOffset = snapshot.offset;
      seedState = snapshot.state.clone();
    }
    hasher = seedState;
    cursor = seedOffset;
    while (cursor < offset) {
      const end = Math.min(cursor + READ_SLICE, offset);
      const buffer = await file.slice(cursor, end).arrayBuffer();
      if (cancelled || currentOperation !== operationId) {
        return;
      }
      hasher.update(new Uint8Array(buffer));
      cursor = end;
    }
    // The sender hash always covers 0..cursor exactly, including an arbitrary
    // mid-slice resume offset. Buffers used for re-seeding are never posted.
    workerScope.postMessage({ t: "resumed", offset });
  } catch (error) {
    sendError(
      error instanceof Error ? error.message : "Could not resume the file.",
    );
  } finally {
    if (currentOperation === operationId) {
      busy = false;
    }
  }
};

workerScope.onmessage = (event) => {
  const command = event.data;
  if (command.t === "cancel") {
    cancelled = true;
    operationId += 1;
    file = undefined;
    return;
  }
  if (command.t === "start") {
    if (command.offset !== 0) {
      sendError("Only offset zero is supported for a new transfer.");
      return;
    }
    file = command.file;
    totalBytes = command.totalBytes;
    cursor = command.offset;
    hasher = sha256.create();
    snapshots.length = 0;
    snapshots.push({ offset: 0, state: hasher.clone() });
    cancelled = false;
    busy = false;
    operationId += 1;
    startedAt = performance.now();
    lastProgressAt = 0;
    return;
  }
  if (command.t === "read") {
    void readNextSlice(command.offset, operationId);
    return;
  }
  if (command.t === "resume") {
    void resumeFrom(command.offset);
  }
};
