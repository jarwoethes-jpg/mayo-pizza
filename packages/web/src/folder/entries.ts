import { assertUniquePathBytes } from "./zipPlan";

/** A file entry has a File; a directory entry is represented by an absent File. */
export interface FolderEntry {
  path: string;
  file?: File;
}

export interface FolderCollection {
  entries: FolderEntry[];
  rootName: string;
  skippedCount: number;
}

const isSkippedPath = (path: string): boolean => {
  const segments = path.split("/").filter((segment) => segment !== "");
  const basename = segments.at(-1);
  return (
    basename === ".DS_Store" ||
    basename === "Thumbs.db" ||
    segments.includes("__MACOSX") ||
    segments.includes(".git")
  );
};

const getFile = (entry: FileSystemFileEntry): Promise<File> =>
  new Promise((resolve, reject) => {
    entry.file(resolve, reject);
  });

const readEntries = (
  reader: FileSystemDirectoryReader,
): Promise<FileSystemEntry[]> =>
  new Promise((resolve, reject) => {
    reader.readEntries(resolve, reject);
  });

const walkEntryAt = async function* (
  entry: FileSystemEntry,
  prefix: string,
): AsyncGenerator<FolderEntry> {
  const path = `${prefix}${entry.name}`;
  if (entry.isFile) {
    const file = await getFile(entry as FileSystemFileEntry);
    yield { path, file };
    return;
  }
  if (!entry.isDirectory) {
    throw new Error(`Unsupported dropped entry "${path}".`);
  }

  yield { path: `${path}/` };
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  for (;;) {
    // Directory readers return an empty batch only after all entries have been
    // read; consuming batches is required for Chromium's two-call pattern.
    const batch = await readEntries(reader);
    if (batch.length === 0) {
      return;
    }
    for (const child of batch) {
      yield* walkEntryAt(child, `${path}/`);
    }
  }
};

/** Recursively yields a dropped file tree, including directory entries. */
export async function* walkEntry(
  entry: FileSystemEntry,
): AsyncIterable<FolderEntry> {
  yield* walkEntryAt(entry, "");
}

const rootNameFromPath = (path: string): string => {
  const slash = path.indexOf("/");
  const rootName = slash === -1 ? path : path.slice(0, slash);
  if (rootName === "") {
    throw new Error("The selected folder has no root name.");
  }
  return rootName;
};

const finishCollection = (
  rawEntries: readonly FolderEntry[],
  rootName: string,
  skippedCount: number,
): FolderCollection => {
  const entries = rawEntries.filter((entry) => !isSkippedPath(entry.path));
  assertUniquePathBytes(entries);
  if (entries.length === 0) {
    throw new Error("There is nothing to send in this folder.");
  }
  return { entries, rootName, skippedCount };
};

/** Collects a dropped tree, applies the shared skip list, and validates paths. */
export const collectDroppedFolder = async (
  entry: FileSystemEntry,
): Promise<FolderCollection> => {
  const rawEntries: FolderEntry[] = [];
  let skippedCount = 0;
  for await (const candidate of walkEntry(entry)) {
    // Directory entries are structural and are not counted as system files;
    // this keeps the UI count aligned with the files users expect to ignore.
    if (isSkippedPath(candidate.path) && candidate.file !== undefined) {
      skippedCount += 1;
    }
    rawEntries.push(candidate);
  }
  return finishCollection(rawEntries, entry.name, skippedCount);
};

/** Maps `webkitdirectory` files into the same file and directory entry shape. */
export const mapInputFiles = (files: Iterable<File>): FolderCollection => {
  const rawFiles = Array.from(files);
  if (rawFiles.length === 0) {
    throw new Error("There is nothing to send in this folder.");
  }

  const rawEntries: FolderEntry[] = [];
  const directories = new Map<string, FolderEntry>();
  let skippedCount = 0;
  let rootName: string | undefined;

  for (const file of rawFiles) {
    // `webkitdirectory` exposes files but no handles for truly empty folders,
    // so this input path preserves only directories implied by file paths.
    const path = file.webkitRelativePath || file.name;
    rootName ??= rootNameFromPath(path);
    if (isSkippedPath(path)) {
      skippedCount += 1;
      continue;
    }
    rawEntries.push({ path, file });
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      const directoryPath = `${segments.slice(0, index).join("/")}/`;
      directories.set(directoryPath, { path: directoryPath });
    }
  }

  for (const directory of directories.values()) {
    rawEntries.push(directory);
  }
  return finishCollection(rawEntries, rootName ?? "", skippedCount);
};
