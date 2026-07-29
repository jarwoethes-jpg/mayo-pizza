import { createHash } from "node:crypto";
import { createReadStream, constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  stat,
  statfs,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ONE_GIB = 1_073_741_824;
const ONE_HUNDRED_MIB = 100 * 1024 * 1024;
const SIX_HUNDRED_MIB = 600 * 1024 * 1024;
const SLOW_FILE_BYTES = 64 * 1024 * 1024;
const ZIP64_SPARSE_BYTES = 4_600_000_000;
const WRITE_CHUNK_BYTES = 1024 * 1024;
const POSIX_BLOCK_BYTES = 512;
const MAX_SPARSE_ALLOCATED_BYTES = 8 * 1024 * 1024;

const DEFAULT_PATHS = Object.freeze({
  MAYO_TEST_FILE: "/tmp/mayo-test-file.bin",
  MAYO_TEST_FILE_SW_FIREFOX: "/tmp/mayo-test-file-sw-firefox.bin",
  MAYO_TEST_FILE_100M: "/tmp/mayo-test-file-100m.bin",
  MAYO_TEST_FILE_600M: "/tmp/mayo-test-file-600m.bin",
  MAYO_TEST_FILE_SLOW: "/tmp/mayo-test-file-slow.bin",
  MAYO_TREE: "/tmp/mayo-tree",
  MAYO_TREE_SKIP: "/tmp/mayo-tree-skip",
  MAYO_TREE_ZIP64: "/tmp/mayo-tree-zip64",
});

const SYSTEM_FILE_NAMES = new Set([".DS_Store", "Thumbs.db"]);

const makeTextFile = (relativePath, text) => ({
  relativePath,
  kind: "text",
  content: Buffer.from(text, "utf8"),
});

const makeSparseFile = (relativePath, size) => ({
  relativePath,
  kind: "sparse",
  size,
});

const resolveFixturePath = (environment, name) =>
  resolve(environment[name] ?? DEFAULT_PATHS[name]);

const makeTree = (environment, name, expectedRootName, files, directories) => {
  const root = resolveFixturePath(environment, name);
  if (basename(root) !== expectedRootName) {
    throw new Error(
      `${name} must name its directory ${expectedRootName}; received ${root}.`,
    );
  }
  return { name, root, expectedRootName, files, directories };
};

const makeSingleFile = (environment, name, size, seed) => ({
  name,
  path: resolveFixturePath(environment, name),
  kind: "binary",
  size,
  seed,
});

const flattenRecords = (plan) => {
  const records = [
    ...plan.singleFiles,
    ...plan.trees.flatMap((tree) =>
      tree.files.map((file) => ({
        ...file,
        path: join(tree.root, file.relativePath),
        tree,
      })),
    ),
  ];
  const seen = new Set();
  for (const record of records) {
    if (seen.has(record.path)) {
      throw new Error(
        `Fixture target is configured more than once: ${record.path}`,
      );
    }
    seen.add(record.path);
  }
  return records;
};

/** Builds the deterministic fixture manifest for the selected generation tier. */
export const buildFixturePlan = ({
  full = false,
  environment = process.env,
} = {}) => {
  const singleFiles = [
    makeSingleFile(
      environment,
      "MAYO_TEST_FILE_SW_FIREFOX",
      ONE_GIB,
      0x51f15e7,
    ),
    makeSingleFile(
      environment,
      "MAYO_TEST_FILE_100M",
      ONE_HUNDRED_MIB,
      0x100ab1e,
    ),
    makeSingleFile(
      environment,
      "MAYO_TEST_FILE_600M",
      SIX_HUNDRED_MIB,
      0x600ab1e,
    ),
    makeSingleFile(
      environment,
      "MAYO_TEST_FILE_SLOW",
      SLOW_FILE_BYTES,
      0x5a0f11e,
    ),
  ];
  if (full) {
    singleFiles.unshift(
      makeSingleFile(environment, "MAYO_TEST_FILE", ONE_GIB, 0x51f11e),
    );
  }

  const mainTree = makeTree(
    environment,
    "MAYO_TREE",
    "mayo-tree",
    [
      makeTextFile(
        "a/b/naïve — file.txt",
        "Mayo folder fixture: naïve file.\n",
      ),
      makeTextFile(
        "deep/level-one/level-two/level-three/leaf-file.txt",
        "Mayo folder fixture: the deliberately deep leaf.\n",
      ),
      makeTextFile("a/b/notes.txt", "Mayo folder fixture: notes.\n"),
      makeTextFile("root-file.txt", "Mayo folder fixture: root file.\n"),
    ],
    ["empty"],
  );
  const skipTree = makeTree(
    environment,
    "MAYO_TREE_SKIP",
    "mayo-tree-skip",
    [
      makeTextFile(".DS_Store", "system\n"),
      makeTextFile("keep/Thumbs.db", "system\n"),
      makeTextFile("__MACOSX/resource.dat", "system\n"),
      makeTextFile(".git/objects/abc123", "system\n"),
      makeTextFile("keep/real.txt", "Mayo folder fixture: real one.\n"),
      makeTextFile("keep/sub/real2.txt", "Mayo folder fixture: real two.\n"),
    ],
    [],
  );
  const zip64Tree = makeTree(
    environment,
    "MAYO_TREE_ZIP64",
    "mayo-tree-zip64",
    [
      makeSparseFile("huge-sparse.bin", ZIP64_SPARSE_BYTES),
      makeTextFile("companion.txt", "Mayo ZIP64 companion fixture.\n"),
    ],
    [],
  );
  const trees = [mainTree, skipTree, zip64Tree];
  const plan = { full, singleFiles, trees };
  plan.records = flattenRecords(plan);
  return plan;
};

const parseArguments = (argumentsList) => {
  const options = {
    full: false,
    force: false,
    printExports: false,
    verify: false,
  };
  for (const argument of argumentsList) {
    if (argument === "--") {
      continue;
    }
    if (argument === "--full") {
      options.full = true;
    } else if (argument === "--force") {
      options.force = true;
    } else if (argument === "--print-exports") {
      options.printExports = true;
    } else if (argument === "--verify") {
      options.verify = true;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown option ${argument}. Use --help for usage.`);
    }
  }
  if (options.force && (options.printExports || options.verify)) {
    throw new Error(
      "--force cannot be combined with --verify or --print-exports.",
    );
  }
  return options;
};

const usage = () => `Usage: node scripts/e2e-fixtures.mjs [options]

  --full            include the 1 GiB MAYO_TEST_FILE fixture
  --force           recreate selected fixture files
  --verify          verify selected fixtures without writing
  --print-exports   verify selected fixtures and print shell exports
`;

const formatBytes = (bytes) => {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(2)} KiB`;
  }
  return `${bytes} B`;
};

const isMissing = (error) => error?.code === "ENOENT";

const readPathState = async (path) => {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) {
      return { kind: "symlink" };
    }
    if (stats.isFile()) {
      return { kind: "file", size: stats.size };
    }
    if (stats.isDirectory()) {
      return { kind: "directory" };
    }
    return { kind: "other" };
  } catch (error) {
    if (isMissing(error)) {
      return { kind: "missing" };
    }
    throw error;
  }
};

const inspectPlan = async (plan, force) => {
  const states = new Map();
  const needsWrite = new Map();
  let logicalBytes = 0;
  let additionalBytes = 0;
  for (const record of plan.records) {
    const expectedSize =
      record.kind === "text" ? record.content.byteLength : record.size;
    const state = await readPathState(record.path);
    states.set(record.path, state);
    logicalBytes += expectedSize;
    if (state.kind === "missing") {
      needsWrite.set(record.path, true);
      additionalBytes += record.kind === "sparse" ? 0 : expectedSize;
    } else if (state.kind === "file" && state.size !== expectedSize) {
      if (!force) {
        throw new Error(
          `${record.path} exists at ${state.size} bytes; use --force to recreate it.`,
        );
      }
      needsWrite.set(record.path, true);
      additionalBytes += record.kind === "sparse" ? 0 : expectedSize;
    } else if (state.kind === "file" && force) {
      needsWrite.set(record.path, true);
      additionalBytes += record.kind === "sparse" ? 0 : expectedSize;
    } else if (state.kind !== "file" && state.kind !== "missing") {
      throw new Error(`${record.path} is not a regular fixture file.`);
    }
  }
  return { states, needsWrite, logicalBytes, additionalBytes };
};

const findExistingParent = async (path) => {
  let candidate = dirname(path);
  for (;;) {
    const state = await readPathState(candidate);
    if (state.kind === "directory") {
      return candidate;
    }
    if (state.kind !== "missing") {
      throw new Error(`Fixture parent ${candidate} is not a directory.`);
    }
    const next = dirname(candidate);
    if (next === candidate) {
      throw new Error(`Could not find an existing parent for ${path}.`);
    }
    candidate = next;
  }
};

const checkDiskSpace = async (plan, inspection) => {
  const byDevice = new Map();
  for (const record of plan.records) {
    const expectedSize =
      record.kind === "text" ? record.content.byteLength : record.size;
    if (
      !inspection.needsWrite.get(record.path) ||
      inspection.additionalBytes === 0
    ) {
      continue;
    }
    const parent = await findExistingParent(record.path);
    const [filesystem, parentStats] = await Promise.all([
      statfs(parent, { bigint: true }),
      stat(parent, { bigint: true }),
    ]);
    const device = parentStats.dev.toString();
    const required = record.kind === "sparse" ? 0n : BigInt(expectedSize);
    const current = byDevice.get(device);
    if (current === undefined) {
      byDevice.set(device, {
        available: filesystem.bavail * filesystem.bsize,
        required,
        parent,
      });
    } else {
      current.required += required;
    }
  }
  for (const { available, required, parent } of byDevice.values()) {
    if (required > available) {
      throw new Error(
        `Insufficient disk space at ${parent}: need ${formatBytes(Number(required))}, have ${formatBytes(Number(available))}.`,
      );
    }
  }
};

const ensureDirectory = async (path) => {
  const state = await readPathState(path);
  if (state.kind === "missing") {
    await mkdir(path, { recursive: true });
    return;
  }
  if (state.kind !== "directory") {
    throw new Error(`${path} must be a real directory, not ${state.kind}.`);
  }
};

const ensureTreeDirectories = async (tree) => {
  await ensureDirectory(tree.root);
  const directories = new Set(tree.directories);
  for (const file of tree.files) {
    const parts = file.relativePath.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      directories.add(parts.slice(0, index).join("/"));
    }
  }
  for (const directory of [...directories].sort(
    (left, right) => left.length - right.length,
  )) {
    await ensureDirectory(join(tree.root, directory));
  }
};

const nextXorShift32 = (state) => {
  let next = state ^ (state << 13);
  next >>>= 0;
  next ^= next >>> 17;
  next >>>= 0;
  next ^= next << 5;
  return next >>> 0;
};

const fillDeterministicBuffer = (buffer, state) => {
  let next = state;
  for (let index = 0; index < buffer.length; index += 1) {
    next = nextXorShift32(next);
    buffer[index] = next & 0xff;
  }
  return next;
};

const writeBuffer = async (handle, buffer, position) => {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const result = await handle.write(
      buffer,
      offset,
      buffer.byteLength - offset,
      position + offset,
    );
    if (result.bytesWritten === 0) {
      throw new Error("The fixture file write made no progress.");
    }
    offset += result.bytesWritten;
  }
};

const writeRecordToTemp = async (record, tempPath) => {
  const handle = await open(
    tempPath,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
    0o644,
  );
  try {
    if (record.kind === "sparse") {
      await handle.truncate(record.size);
      return;
    }
    if (record.kind === "text") {
      await writeBuffer(handle, record.content, 0);
      return;
    }
    const buffer = Buffer.allocUnsafe(WRITE_CHUNK_BYTES);
    let state = record.seed;
    let offset = 0;
    while (offset < record.size) {
      const length = Math.min(buffer.byteLength, record.size - offset);
      state = fillDeterministicBuffer(buffer.subarray(0, length), state);
      await writeBuffer(handle, buffer.subarray(0, length), offset);
      offset += length;
    }
  } finally {
    await handle.close();
  }
};

const recreateRecord = async (record, force) => {
  const state = await readPathState(record.path);
  const expectedSize =
    record.kind === "text" ? record.content.byteLength : record.size;
  if (state.kind === "file" && state.size === expectedSize && !force) {
    console.log(`Leaving existing fixture at expected size: ${record.path}`);
    return;
  }
  if (state.kind !== "missing" && state.kind !== "file") {
    throw new Error(`${record.path} is not a regular fixture file.`);
  }
  const parent = dirname(record.path);
  await ensureDirectory(parent);
  const tempPath = `${record.path}.mayo-fixtures.tmp`;
  const tempState = await readPathState(tempPath);
  if (tempState.kind !== "missing") {
    throw new Error(
      `Refusing to touch an existing temporary path: ${tempPath}`,
    );
  }
  try {
    await writeRecordToTemp(record, tempPath);
    await rename(tempPath, record.path);
  } catch (error) {
    const leftover = await readPathState(tempPath);
    if (leftover.kind === "file") {
      await unlink(tempPath);
    }
    throw error;
  }
  console.log(
    `${force && state.kind === "file" ? "Recreated" : "Created"} fixture: ${record.path}`,
  );
};

const generatePlan = async (plan, force) => {
  for (const tree of plan.trees) {
    await ensureTreeDirectories(tree);
  }
  for (const record of plan.records) {
    await recreateRecord(record, force);
  }
};

const verifyRecordContent = async (record) => {
  const hash = createHash("sha256");
  const stream = createReadStream(record.path);
  const zeroBuffer = Buffer.alloc(WRITE_CHUNK_BYTES);
  let offset = 0;
  let state = record.seed;
  for await (const chunk of stream) {
    const expected =
      record.kind === "text"
        ? record.content.subarray(offset, offset + chunk.byteLength)
        : record.kind === "sparse"
          ? zeroBuffer.subarray(0, chunk.byteLength)
          : (() => {
              const generated = Buffer.allocUnsafe(chunk.byteLength);
              state = fillDeterministicBuffer(generated, state);
              return generated;
            })();
    if (
      expected.byteLength !== chunk.byteLength ||
      !Buffer.from(chunk).equals(expected)
    ) {
      throw new Error(`Deterministic content mismatch in ${record.path}.`);
    }
    hash.update(chunk);
    offset += chunk.byteLength;
  }
  const expectedSize =
    record.kind === "text" ? record.content.byteLength : record.size;
  if (offset !== expectedSize) {
    throw new Error(
      `Unexpected end of fixture ${record.path} at ${offset} bytes.`,
    );
  }
  return hash.digest("hex");
};

const hashZeroContent = (size) => {
  const hash = createHash("sha256");
  const zeroBuffer = Buffer.alloc(WRITE_CHUNK_BYTES);
  for (let remaining = size; remaining > 0; remaining -= WRITE_CHUNK_BYTES) {
    hash.update(zeroBuffer.subarray(0, Math.min(remaining, WRITE_CHUNK_BYTES)));
  }
  return hash.digest("hex");
};

const collectTreeEntries = async (
  root,
  currentPath = "",
  currentBytes = Buffer.alloc(0),
) => {
  const directory = join(root, currentPath);
  const entries = await readdir(directory, {
    encoding: "buffer",
    withFileTypes: true,
  });
  const files = [];
  const directories = [];
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name);
    const name = nameBytes.toString("utf8");
    const relativeBytes =
      currentBytes.length === 0
        ? nameBytes
        : Buffer.concat([currentBytes, Buffer.from("/"), nameBytes]);
    const relativePath = relativeBytes.toString("utf8");
    const childPath = join(directory, name);
    if (entry.isSymbolicLink()) {
      throw new Error(
        `Symlinks are not allowed in fixture trees: ${childPath}`,
      );
    }
    if (entry.isDirectory()) {
      directories.push({ path: relativePath, bytes: relativeBytes });
      const nested = await collectTreeEntries(
        root,
        join(currentPath, name),
        relativeBytes,
      );
      files.push(...nested.files);
      directories.push(...nested.directories);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Unsupported entry in fixture tree: ${childPath}`);
    }
    const stats = await stat(childPath);
    files.push({ path: relativePath, bytes: relativeBytes, size: stats.size });
  }
  return { files, directories };
};

const expectedDirectoryPaths = (tree) => {
  const directories = new Set(tree.directories);
  for (const file of tree.files) {
    const parts = file.relativePath.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      directories.add(parts.slice(0, index).join("/"));
    }
  }
  return [...directories].sort();
};

const compareLists = (actual, expected, label) => {
  const actualText = [...actual].sort().join("\n");
  const expectedText = [...expected].sort().join("\n");
  if (actualText !== expectedText) {
    throw new Error(
      `${label} mismatch.\nExpected:\n${expectedText}\nActual:\n${actualText}`,
    );
  }
};

const isSystemPath = (path) => {
  const segments = path.split("/").filter((segment) => segment !== "");
  return (
    SYSTEM_FILE_NAMES.has(segments.at(-1)) ||
    segments.includes("__MACOSX") ||
    segments.includes(".git")
  );
};

const verifyTree = async (tree) => {
  if (basename(tree.root) !== tree.expectedRootName) {
    throw new Error(`${tree.name} basename changed: ${tree.root}`);
  }
  const rootState = await readPathState(tree.root);
  if (rootState.kind !== "directory") {
    throw new Error(`${tree.name} is missing its directory: ${tree.root}`);
  }
  const actual = await collectTreeEntries(tree.root);
  const expectedFiles = tree.files.map((file) => file.relativePath);
  compareLists(
    actual.files.map((file) => file.path),
    expectedFiles,
    `${tree.name} files`,
  );
  compareLists(
    actual.directories.map((directory) => directory.path),
    expectedDirectoryPaths(tree),
    `${tree.name} directories`,
  );

  if (tree.name === "MAYO_TREE") {
    if (actual.files.length !== 4) {
      throw new Error(
        `MAYO_TREE must contain exactly 4 files; found ${actual.files.length}.`,
      );
    }
    const naivePath = "a/b/naïve — file.txt";
    const naive = actual.files.find((file) => file.path === naivePath);
    if (
      naive === undefined ||
      !naive.bytes.equals(Buffer.from(naivePath, "utf8"))
    ) {
      throw new Error("MAYO_TREE is missing the byte-exact naïve filename.");
    }
    if (!actual.files.some((file) => file.path.includes("leaf-file"))) {
      throw new Error("MAYO_TREE is missing a path containing leaf-file.");
    }
    if (
      actual.files.some(
        (file) => file.path === "empty" || file.path.startsWith("empty/"),
      )
    ) {
      throw new Error("MAYO_TREE's empty directory contains a regular file.");
    }
  }
  if (tree.name === "MAYO_TREE_SKIP") {
    const skipped = actual.files.filter((file) => isSystemPath(file.path));
    if (skipped.length !== 4) {
      throw new Error(
        `MAYO_TREE_SKIP must contain exactly 4 skipped files; found ${skipped.length}.`,
      );
    }
    const realFiles = actual.files
      .filter((file) => !isSystemPath(file.path))
      .map((file) => file.path);
    compareLists(
      realFiles,
      ["keep/real.txt", "keep/sub/real2.txt"],
      "MAYO_TREE_SKIP real files",
    );
  }
  if (tree.name === "MAYO_TREE_ZIP64") {
    if (actual.files.length !== 2) {
      throw new Error(
        `MAYO_TREE_ZIP64 must contain exactly 2 files; found ${actual.files.length}.`,
      );
    }
  }
};

const verifySparseRecord = async (record) => {
  const stats = await stat(record.path);
  if (stats.size !== ZIP64_SPARSE_BYTES) {
    throw new Error(
      `${record.path} must be exactly ${ZIP64_SPARSE_BYTES} bytes; found ${stats.size}.`,
    );
  }
  if (typeof stats.blocks !== "number") {
    throw new Error(`Cannot verify sparse allocation for ${record.path}.`);
  }
  const allocatedBytes = stats.blocks * POSIX_BLOCK_BYTES;
  if (
    allocatedBytes > MAX_SPARSE_ALLOCATED_BYTES ||
    allocatedBytes * 1000 >= ZIP64_SPARSE_BYTES
  ) {
    throw new Error(
      `${record.path} is not sparse enough: ${allocatedBytes} allocated bytes for ${stats.size} apparent bytes.`,
    );
  }
  console.log(
    `Verified sparse allocation: ${record.path} uses ${allocatedBytes} allocated bytes for ${stats.size} apparent bytes.`,
  );
  return stats.blocks;
};

/** Verifies fixture structure, exact sizes, sparse allocation, and SHA-256 values. */
export const verifyFixturePlan = async (plan) => {
  for (const tree of plan.trees) {
    await verifyTree(tree);
  }
  const hashes = new Map();
  for (const record of plan.records) {
    const state = await readPathState(record.path);
    const expectedSize =
      record.kind === "text" ? record.content.byteLength : record.size;
    if (state.kind !== "file" || state.size !== expectedSize) {
      throw new Error(
        `${record.path} has size ${state.size ?? "missing"}; expected ${expectedSize}.`,
      );
    }
    if (record.kind === "sparse") {
      const allocatedBlocks = await verifySparseRecord(record);
      if (allocatedBlocks === 0) {
        hashes.set(record.path, hashZeroContent(record.size));
        continue;
      }
    }
    hashes.set(record.path, await verifyRecordContent(record));
  }
  return hashes;
};

const shellQuote = (value) => `'${value.replaceAll("'", "'\"'\"'")}'`;

const printReport = (plan, hashes) => {
  console.log("SHA-256 values for every selected regular fixture file:");
  for (const record of plan.records) {
    const hash = hashes.get(record.path);
    console.log(
      `  ${record.tree === undefined ? record.name : relative(record.tree.root, record.path)}: ${hash}`,
    );
  }
  console.log("");
  console.log("Exports:");
  for (const record of plan.singleFiles) {
    const hash = hashes.get(record.path);
    console.log(`export ${record.name}=${shellQuote(record.path)}`);
    console.log(`export ${record.name}_SHA256=${hash}`);
  }
  for (const tree of plan.trees) {
    console.log(`export ${tree.name}=${shellQuote(tree.root)}`);
  }
};

/** Runs generation, verification, or export printing according to CLI options. */
export const runFixtureCommand = async (options, environment = process.env) => {
  const plan = buildFixturePlan({ full: options.full, environment });
  if (options.verify || options.printExports) {
    const hashes = await verifyFixturePlan(plan);
    printReport(plan, hashes);
    return;
  }
  const inspection = await inspectPlan(plan, options.force);
  console.log(
    `Planned total byte count: ${inspection.logicalBytes} bytes (${formatBytes(inspection.logicalBytes)} logical; ${inspection.additionalBytes} bytes of new dense disk data).`,
  );
  await checkDiskSpace(plan, inspection);
  await generatePlan(plan, options.force);
  const hashes = await verifyFixturePlan(plan);
  printReport(plan, hashes);
};

const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMainModule) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
    } else {
      await runFixtureCommand(options);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
