import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { makeZip, predictLength } from "client-zip";
import { describe, expect, it } from "vitest";
import {
  collectDroppedFolder,
  type FolderEntry,
  mapInputFiles,
  walkEntry,
} from "../src/folder/entries";
import {
  makeZipPlan,
  ZIP_DIRECTORY_LAST_MODIFIED,
} from "../src/folder/zipPlan";
import { createZipStreamSource } from "../src/folder/zipSource";

const fileEntry = (name: string, file: File): FileSystemFileEntry =>
  ({
    isFile: true,
    isDirectory: false,
    name,
    fullPath: `/${name}`,
    file: (resolve: (file: File) => void) => resolve(file),
  }) as FileSystemFileEntry;

const directoryEntry = (
  name: string,
  batches: FileSystemEntry[][],
): FileSystemDirectoryEntry => {
  let batchIndex = 0;
  return {
    isFile: false,
    isDirectory: true,
    name,
    fullPath: `/${name}`,
    createReader: () =>
      ({
        readEntries: (
          resolve: (entries: FileSystemEntry[]) => void,
          _reject?: (error: DOMException) => void,
        ) => resolve(batches[batchIndex++] ?? []),
      }) as FileSystemDirectoryReader,
  } as FileSystemDirectoryEntry;
};

const makeFile = (
  bytes: string | Uint8Array,
  name: string,
  lastModified = 1_700_000_000_000,
): File => new File([bytes], name, { lastModified });

const withRelativePath = (file: File, path: string): File => {
  Object.defineProperty(file, "webkitRelativePath", { value: path });
  return file;
};

const readStream = async (
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) {
      break;
    }
    chunks.push(result.value);
    total += result.value.byteLength;
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
};

const collectSource = async (
  source: ReturnType<typeof createZipStreamSource>,
  sliceSize = 19,
): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const slice = await source.readSlice(sliceSize);
    const bytes = new Uint8Array(slice.buffer);
    if (bytes.byteLength > 0) {
      chunks.push(bytes);
      total += bytes.byteLength;
    }
    if (slice.done) {
      break;
    }
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
};

const sourceEntries: FolderEntry[] = [
  { path: "mayo-tree/", file: undefined },
  { path: "mayo-tree/empty/", file: undefined },
  {
    path: "mayo-tree/a/zero.bin",
    file: makeFile(new Uint8Array(), "zero.bin", 11),
  },
  {
    path: "mayo-tree/a/naïve — file.txt",
    file: makeFile("hello", "naïve — file.txt", 12),
  },
  {
    path: "mayo-tree/a/b/c/deep.txt",
    file: makeFile("deep", "deep.txt", 13),
  },
];

describe("folder intake", () => {
  it("walks nested files, empty directories, and reader batches", async () => {
    const deepFile = makeFile("deep", "deep.txt");
    const empty = directoryEntry("empty", [[], []]);
    const nested = directoryEntry("b", [[fileEntry("deep.txt", deepFile)], []]);
    const root = directoryEntry("mayo-tree", [
      [directoryEntry("a", [[nested, empty], []])],
      [],
    ]);

    const entries: FolderEntry[] = [];
    for await (const entry of walkEntry(root)) {
      entries.push(entry);
    }

    expect(entries.map((entry) => entry.path)).toEqual([
      "mayo-tree/",
      "mayo-tree/a/",
      "mayo-tree/a/b/",
      "mayo-tree/a/b/deep.txt",
      "mayo-tree/a/empty/",
    ]);
    expect(entries[3]?.file).toBe(deepFile);
  });

  it("skips exactly the four system files in the skip-list shape", async () => {
    const root = directoryEntry("mayo-tree-skip", [
      [
        fileEntry(".DS_Store", makeFile("x", ".DS_Store")),
        directoryEntry("keep", [
          [
            fileEntry("Thumbs.db", makeFile("x", "Thumbs.db")),
            fileEntry("one.txt", makeFile("one", "one.txt")),
          ],
          [fileEntry("two.txt", makeFile("two", "two.txt"))],
          [],
        ]),
        directoryEntry("__MACOSX", [
          [fileEntry("resource.dat", makeFile("x", "resource.dat"))],
          [],
        ]),
        directoryEntry(".git", [
          [
            directoryEntry("objects", [
              [fileEntry("abc123", makeFile("x", "abc123"))],
              [],
            ]),
          ],
          [],
        ]),
      ],
      [],
    ]);

    const result = await collectDroppedFolder(root);
    expect(result.skippedCount).toBe(4);
    expect(result.entries.map((entry) => entry.path)).toEqual([
      "mayo-tree-skip/",
      "mayo-tree-skip/keep/",
      "mayo-tree-skip/keep/one.txt",
      "mayo-tree-skip/keep/two.txt",
    ]);
  });

  it("maps webkitdirectory paths and derives only implied directories", () => {
    const files = [
      withRelativePath(makeFile("deep", "deep.txt"), "mayo-tree/a/deep.txt"),
      withRelativePath(makeFile("top", "top.txt"), "mayo-tree/top.txt"),
    ];
    const result = mapInputFiles(files);

    expect(result.rootName).toBe("mayo-tree");
    expect(result.skippedCount).toBe(0);
    expect(result.entries.map((entry) => entry.path).sort()).toEqual([
      "mayo-tree/",
      "mayo-tree/a/",
      "mayo-tree/a/deep.txt",
      "mayo-tree/top.txt",
    ]);
  });

  it("rejects paths that collide after UTF-8 encoding", () => {
    const first = { path: "root/\ud800.txt", file: makeFile("a", "a") };
    const second = { path: "root/\ud801.txt", file: makeFile("b", "b") };
    expect(() => makeZipPlan([first, second])).toThrow(/UTF-8 encoding/);
  });

  it("rejects a folder with no post-skip entries", () => {
    const root = directoryEntry(".git", [
      [fileEntry(".DS_Store", makeFile("x", ".DS_Store"))],
      [],
    ]);
    return expect(collectDroppedFolder(root)).rejects.toThrow(
      /nothing to send/i,
    );
  });
});

describe("folder ZIP plan and streaming source", () => {
  it.each([
    [sourceEntries],
    [
      [
        { path: "only-dirs/", file: undefined },
        { path: "only-dirs/one/", file: undefined },
      ],
    ],
  ])("predicts the exact stream length", async (entries) => {
    const plan = makeZipPlan(entries);
    const bytes = await readStream(makeZip(plan));
    expect(BigInt(bytes.byteLength)).toBe(predictLength(plan));
    expect(Number(predictLength(plan))).toBe(bytes.byteLength);

    const source = createZipStreamSource(entries, ZIP_DIRECTORY_LAST_MODIFIED);
    expect(Number(predictLength(plan))).toBe(
      (await collectSource(source)).byteLength,
    );
    await source.cancel();
  });

  it("regenerates byte-identical ZIP output", async () => {
    const first = await readStream(makeZip(makeZipPlan(sourceEntries)));
    const second = await readStream(makeZip(makeZipPlan(sourceEntries)));
    expect(second).toEqual(first);
  });

  it("resumes at an arbitrary offset and returns the exact suffix", async () => {
    const source = createZipStreamSource(
      sourceEntries,
      ZIP_DIRECTORY_LAST_MODIFIED,
    );
    const full = await collectSource(source, 7);
    const offset = 31;
    await source.reset();
    const reseeded = sha256.create();
    let consumed = 0;
    while (consumed < offset) {
      const slice = await source.readSlice(Math.min(7, offset - consumed));
      const bytes = new Uint8Array(slice.buffer);
      reseeded.update(bytes);
      consumed += bytes.byteLength;
    }

    const suffix = await collectSource(source, 7);
    expect(suffix).toEqual(full.subarray(offset));
    expect(bytesToHex(reseeded.digest())).toBe(
      bytesToHex(sha256(full.subarray(0, offset))),
    );
    await source.cancel();
  });
});
