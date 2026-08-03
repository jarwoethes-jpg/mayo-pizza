import type { Sink } from "./index";

/** Blob fallback is deliberately capped because it retains the whole download in memory. */
export const BLOB_MAX_BYTES = 500 * 1024 * 1024;

/** iOS has an undocumented, RAM-dependent ceiling; this is an unverified estimate. */
export const BLOB_MAX_BYTES_IOS = 150 * 1024 * 1024;

interface BlobLimitEnvironment {
  userAgent?: string;
  platform?: string;
  maxTouchPoints?: number;
}

const browserBlobLimitFeatures = (): BlobLimitEnvironment =>
  typeof navigator === "undefined"
    ? {}
    : {
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        maxTouchPoints: navigator.maxTouchPoints,
      };

/**
 * Returns the in-memory download ceiling for the current platform.
 *
 * iPadOS 13+ reports itself as `MacIntel`, so touch points are what separate it
 * from a real Mac.
 *
 * @param environment - Platform signals; defaults to the live browser navigator.
 * @returns The maximum number of bytes the blob sink will accept.
 */
export const blobMaxBytes = (
  environment: BlobLimitEnvironment = browserBlobLimitFeatures(),
): number => {
  const userAgent = environment.userAgent ?? "";
  const isIos =
    /iPad|iPhone|iPod/.test(userAgent) ||
    (environment.platform === "MacIntel" &&
      (environment.maxTouchPoints ?? 0) > 1);
  return isIos ? BLOB_MAX_BYTES_IOS : BLOB_MAX_BYTES;
};

export const createBlobSink = (name: string, totalBytes: number): Sink => {
  const maxBytes = blobMaxBytes();
  if (totalBytes > maxBytes) {
    const maxMegabytes = maxBytes / (1024 * 1024);
    throw new Error(
      `This file is too large for this browser's in-memory download limit of ${maxMegabytes} MB. Open this link in Chrome or Firefox on a desktop to receive it.`,
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
      // The Blob constructor copies every part, so keeping both doubles peak memory.
      chunks.length = 0;
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
