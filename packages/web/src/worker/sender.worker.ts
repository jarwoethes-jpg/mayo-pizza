import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  createZipStreamSource,
  type ZipStreamSource,
} from "../folder/zipSource";
import type { SenderWorkerCommand, SenderWorkerEvent } from "./messages";

const READ_SLICE = 4 * 1024 * 1024;

interface SenderWorkerScope {
  onmessage: ((event: MessageEvent<SenderWorkerCommand>) => void) | null;
  postMessage: (message: SenderWorkerEvent, transfer?: Transferable[]) => void;
}

const workerScope = self as unknown as SenderWorkerScope;

let file: File | undefined;
let zipSource: ZipStreamSource | undefined;
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

const cancelZipSource = (): void => {
  const source = zipSource;
  zipSource = undefined;
  if (source !== undefined) {
    void source.cancel().catch(() => undefined);
  }
};

const readNextSlice = async (
  requestedOffset: number,
  currentOperation: number,
): Promise<void> => {
  if (busy || cancelled || (file === undefined && zipSource === undefined)) {
    return;
  }
  if (requestedOffset !== cursor) {
    sendError("Sender slice request is out of order.");
    return;
  }

  busy = true;
  try {
    let buffer: ArrayBuffer;
    let done: boolean;
    if (zipSource !== undefined) {
      const slice = await zipSource.readSlice(READ_SLICE);
      buffer = slice.buffer;
      done = slice.done;
      if (buffer.byteLength === 0 && !done) {
        throw new Error("The ZIP stream ended before the predicted size.");
      }
    } else {
      const sourceFile = file;
      if (sourceFile === undefined) {
        return;
      }
      const end = Math.min(cursor + READ_SLICE, sourceFile.size);
      buffer = await sourceFile.slice(cursor, end).arrayBuffer();
      done = end >= sourceFile.size;
    }
    if (cancelled || currentOperation !== operationId) {
      return;
    }

    hasher.update(new Uint8Array(buffer));
    cursor += buffer.byteLength;
    if (zipSource === undefined) {
      snapshots.push({ offset: cursor, state: hasher.clone() });
    }
    if (cursor > totalBytes || (done && cursor !== totalBytes)) {
      throw new Error(
        `The ZIP stream produced ${cursor} bytes; predicted ${totalBytes}.`,
      );
    }
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
  const maximumOffset = zipSource === undefined ? file?.size : totalBytes;
  if (maximumOffset === undefined || offset < 0 || offset > maximumOffset) {
    sendError("The sender resume offset is outside the selected file.");
    return;
  }
  const currentOperation = ++operationId;
  cancelled = false;
  busy = true;
  try {
    if (zipSource !== undefined) {
      await zipSource.reset();
      if (cancelled || currentOperation !== operationId) {
        return;
      }
      hasher = sha256.create();
      cursor = 0;
      while (cursor < offset) {
        const slice = await zipSource.readSlice(
          Math.min(READ_SLICE, offset - cursor),
        );
        const buffer = new Uint8Array(slice.buffer);
        if (buffer.byteLength === 0) {
          throw new Error("The ZIP stream ended before the resume offset.");
        }
        hasher.update(buffer);
        cursor += buffer.byteLength;
        if (slice.done && cursor < offset) {
          throw new Error("The ZIP stream ended before the resume offset.");
        }
        if (cancelled || currentOperation !== operationId) {
          return;
        }
      }
      // Rebuilding is O(offset) for v1 because a stream has no random-access
      // hash snapshots; discarded buffers never cross the worker boundary.
      workerScope.postMessage({ t: "resumed", offset });
      return;
    }

    const sourceFile = file;
    if (sourceFile === undefined) {
      return;
    }
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
      const buffer = await sourceFile.slice(cursor, end).arrayBuffer();
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
    cancelZipSource();
    file = undefined;
    return;
  }
  if (command.t === "start") {
    if (command.offset !== 0) {
      sendError("Only offset zero is supported for a new transfer.");
      return;
    }
    cancelZipSource();
    file = command.file;
    if (command.folder !== undefined) {
      file = undefined;
      zipSource = createZipStreamSource(
        command.folder.entries,
        command.folder.directoryLastModified,
      );
    }
    totalBytes = command.totalBytes;
    cursor = command.offset;
    hasher = sha256.create();
    snapshots.length = 0;
    if (zipSource === undefined) {
      snapshots.push({ offset: 0, state: hasher.clone() });
    }
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
