import type { FolderEntry } from "./entries";

/** DOS timestamps are two-second precision, so this fixed instant is stable across runs. */
export const ZIP_DIRECTORY_LAST_MODIFIED = Date.UTC(2020, 0, 1, 0, 0, 0);

export type ZipPlanEntry =
  | { input: File; name: string }
  | { name: string; lastModified: number };

const encodePath = (path: string): Uint8Array => new TextEncoder().encode(path);

const compareBytes = (left: Uint8Array, right: Uint8Array): number => {
  const length = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return left.byteLength - right.byteLength;
};

/** Throws when two paths would encode to the same ZIP filename bytes. */
export const assertUniquePathBytes = (
  entries: readonly FolderEntry[],
): void => {
  const seen = new Map<string, string>();
  for (const entry of entries) {
    const encoded = encodePath(entry.path);
    const key = Array.from(encoded, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const previous = seen.get(key);
    if (previous !== undefined) {
      throw new Error(
        `Folder paths collide after UTF-8 encoding: "${previous}" and "${entry.path}".`,
      );
    }
    seen.set(key, entry.path);
  }
};

/** Creates the one ordered metadata list shared by prediction and ZIP generation. */
export const makeZipPlan = (
  entries: readonly FolderEntry[],
  directoryLastModified = ZIP_DIRECTORY_LAST_MODIFIED,
): ZipPlanEntry[] => {
  assertUniquePathBytes(entries);
  const ordered = entries
    .map((entry) => ({ entry, bytes: encodePath(entry.path) }))
    .sort((left, right) => compareBytes(left.bytes, right.bytes));
  return ordered.map(({ entry }) =>
    entry.file === undefined
      ? { name: entry.path, lastModified: directoryLastModified }
      : { input: entry.file, name: entry.path },
  );
};
