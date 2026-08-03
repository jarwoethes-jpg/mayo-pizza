/**
 * Records the last blob download before its memory-heavy construction because
 * an OOM kill emits no catchable event.
 */

export const OOM_MARKER_KEY = "mayo.blobOom";

export interface OomMarker {
  name: string;
  totalBytes: number;
}

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const getSessionStorage = (): StorageLike | undefined => {
  try {
    if (typeof sessionStorage === "undefined") {
      return undefined;
    }
    return sessionStorage;
  } catch {
    return undefined;
  }
};

/** Writes a pending blob download marker without allowing storage failures to interrupt it. */
export const writeOomMarker = (
  marker: OomMarker,
  storage: StorageLike | undefined = getSessionStorage(),
): void => {
  try {
    storage?.setItem(OOM_MARKER_KEY, JSON.stringify(marker));
  } catch {
    // Storage can be unavailable even when the download itself can proceed.
  }
};

/** Clears the pending blob download marker without allowing storage failures to interrupt cleanup. */
export const clearOomMarker = (
  storage: StorageLike | undefined = getSessionStorage(),
): void => {
  try {
    storage?.removeItem(OOM_MARKER_KEY);
  } catch {
    // Storage can be unavailable even when the download itself can proceed.
  }
};

/** Reads and validates the pending blob download marker, returning nothing for untrusted data. */
export const readOomMarker = (
  storage: StorageLike | undefined = getSessionStorage(),
): OomMarker | undefined => {
  try {
    const raw = storage?.getItem(OOM_MARKER_KEY);
    if (raw === null || raw === undefined) {
      return undefined;
    }
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return undefined;
    }
    const candidate = parsed as {
      name?: unknown;
      totalBytes?: unknown;
    };
    if (
      typeof candidate.name !== "string" ||
      typeof candidate.totalBytes !== "number" ||
      !Number.isFinite(candidate.totalBytes) ||
      candidate.totalBytes < 0
    ) {
      return undefined;
    }
    return {
      name: candidate.name,
      totalBytes: candidate.totalBytes,
    };
  } catch {
    return undefined;
  }
};

/** Returns whether a validated marker identifies exactly the requested download. */
export const matchesOomMarker = (
  marker: OomMarker | undefined,
  name: string,
  totalBytes: number,
): boolean => marker?.name === name && marker.totalBytes === totalBytes;
