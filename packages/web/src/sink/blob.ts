import type { Sink } from "./index";

/** Blob fallback is deliberately capped because it retains the whole download in memory. */
export const BLOB_MAX_BYTES = 500 * 1024 * 1024;

export const createBlobSink = (name: string, totalBytes: number): Sink => {
  if (totalBytes > BLOB_MAX_BYTES) {
    throw new Error(
      "This file is too large for the in-memory download fallback. Enable File System Access or service-worker downloads.",
    );
  }

  const chunks: BlobPart[] = [];
  let closed = false;
  let objectUrl: string | undefined;

  return {
    strategy: "blob",
    write(bytes: Uint8Array): void {
      if (closed) {
        throw new Error("The file sink is already closed.");
      }
      chunks.push(bytes.slice().buffer as ArrayBuffer);
    },
    close(): void {
      if (closed) {
        return;
      }
      closed = true;
      const blob = new Blob(chunks, { type: "application/octet-stream" });
      objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = name;
      link.hidden = true;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => {
        if (objectUrl !== undefined) {
          URL.revokeObjectURL(objectUrl);
          objectUrl = undefined;
        }
      }, 30_000);
    },
    cancel(): void {
      closed = true;
      chunks.length = 0;
      if (objectUrl !== undefined) {
        URL.revokeObjectURL(objectUrl);
        objectUrl = undefined;
      }
    },
  } satisfies Sink;
};
