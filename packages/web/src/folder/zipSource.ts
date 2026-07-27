import { makeZip } from "client-zip";
import type { FolderEntry } from "./entries";
import { makeZipPlan } from "./zipPlan";

export interface ZipSlice {
  buffer: ArrayBuffer;
  done: boolean;
}

export interface ZipStreamSource {
  readSlice: (maxBytes: number) => Promise<ZipSlice>;
  reset: () => Promise<void>;
  cancel: () => Promise<void>;
}

/** Creates the bounded, demand-driven ZIP reader used by the sender worker. */
export const createZipStreamSource = (
  entries: readonly FolderEntry[],
  directoryLastModified: number,
): ZipStreamSource => {
  let reader = makeZip(makeZipPlan(entries, directoryLastModified)).getReader();
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let streamDone = false;

  const clearPending = (): void => {
    pending = [];
    pendingBytes = 0;
    streamDone = false;
  };

  const open = (): void => {
    clearPending();
    reader = makeZip(makeZipPlan(entries, directoryLastModified)).getReader();
  };

  const readSlice = async (maxBytes: number): Promise<ZipSlice> => {
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
      throw new Error("ZIP slice size must be a positive integer.");
    }
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    while (byteLength < maxBytes) {
      const chunk = pending[0];
      if (chunk !== undefined) {
        const take = Math.min(maxBytes - byteLength, chunk.byteLength);
        chunks.push(chunk.subarray(0, take));
        byteLength += take;
        pendingBytes -= take;
        if (take === chunk.byteLength) {
          pending.shift();
        } else {
          pending[0] = chunk.subarray(take);
        }
        continue;
      }
      if (streamDone) {
        break;
      }
      const result = await reader.read();
      if (result.done) {
        streamDone = true;
        continue;
      }
      if (result.value.byteLength > 0) {
        pending.push(result.value);
        pendingBytes += result.value.byteLength;
      }
    }

    const output = new Uint8Array(byteLength);
    let outputOffset = 0;
    for (const chunk of chunks) {
      output.set(chunk, outputOffset);
      outputOffset += chunk.byteLength;
    }
    return {
      buffer: output.buffer,
      done: streamDone && pendingBytes === 0,
    };
  };

  return {
    readSlice,
    reset: async () => {
      await reader.cancel();
      open();
    },
    cancel: async () => {
      await reader.cancel();
      clearPending();
    },
  };
};
