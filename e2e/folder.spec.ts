/// <reference path="./global.d.ts" />

import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from "@playwright/test";
import { startTransferFailureMonitor } from "./transferFailureMonitor";

const execFile = promisify(execFileCallback);
const signalingUrl = "ws://127.0.0.1:3100/ws";
const mainTree = process.env.MAYO_TREE ?? "/tmp/mayo-tree";
const skipTree = process.env.MAYO_TREE_SKIP ?? "/tmp/mayo-tree-skip";
const zip64Tree = process.env.MAYO_TREE_ZIP64 ?? "/tmp/mayo-tree-zip64";
const MEMORY_LIMIT = 200 * 1024 * 1024;
const SMALL_ARCHIVE_LIMIT = 8 * 1024 * 1024;

interface MemorySampler {
  stop: () => Promise<number[]>;
}

const startMemorySampler = async (
  page: Page,
  browserName: string,
): Promise<MemorySampler> => {
  const cdp =
    browserName === "chromium"
      ? await page.context().newCDPSession(page)
      : undefined;
  const samples: number[] = [];
  const sample = async (): Promise<void> => {
    let measured: number | undefined;
    try {
      measured = await page.evaluate(async () => {
        const performanceWithMemory = performance as Performance & {
          measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }>;
        };
        return performanceWithMemory.measureUserAgentSpecificMemory ===
          undefined
          ? undefined
          : (await performanceWithMemory.measureUserAgentSpecificMemory())
              .bytes;
      });
    } catch {
      measured = undefined;
    }
    if (measured !== undefined) {
      samples.push(measured);
      return;
    }
    if (cdp !== undefined) {
      const heap = await cdp.send("Runtime.getHeapUsage");
      samples.push(heap.usedSize);
    }
  };

  await sample();
  const interval = setInterval(() => void sample(), 2_000);
  return {
    stop: async () => {
      clearInterval(interval);
      await sample();
      return samples;
    },
  };
};

const addBaseInitScript = async (context: BrowserContext): Promise<void> => {
  await context.addInitScript(
    ({ url }) => {
      window.__MAYO_SIGNALING_URL__ = url;
      window.__MAYO_FORCE_RELAY__ = false;
      window.__MAYO_CORRUPT_FRAME__ = false;
      window.__MAYO_E2E__ = true;
    },
    { url: signalingUrl },
  );
};

const addFsaInitScript = async (context: BrowserContext): Promise<void> => {
  await context.addInitScript(() => {
    window.showSaveFilePicker = async ({ suggestedName } = {}) => {
      const name = `mayo-folder-${crypto.randomUUID()}-${suggestedName ?? "download.bin"}`;
      window.__MAYO_OPFS_FILE__ = name;
      const root = await navigator.storage.getDirectory();
      return root.getFileHandle(name, { create: true });
    };
    window.__MAYO_SINK__ = { strategy: "fsa", autoAccept: false };
  });
};

const addFirefoxSinkInitScript = async (
  context: BrowserContext,
): Promise<void> => {
  await context.addInitScript(() => {
    window.__MAYO_SINK__ = { strategy: "sw", autoAccept: false };
  });
};

const openPair = async (
  browser: Browser,
  receiverContext: BrowserContext,
): Promise<{
  contextA: BrowserContext;
  contextB: BrowserContext;
  sender: Page;
  receiver: Page;
}> => {
  const contextA = await browser.newContext();
  await addBaseInitScript(contextA);
  await addBaseInitScript(receiverContext);
  const sender = await contextA.newPage();
  await sender.goto("/");
  const slug = (await sender.getByTestId("slug").textContent())?.trim();
  if (slug === undefined || slug === "") {
    throw new Error("The folder sender did not render a room slug.");
  }
  const receiver = await receiverContext.newPage();
  await receiver.goto(`/${encodeURIComponent(slug)}`);
  await Promise.all([
    expect(sender.getByTestId("connection-state")).toHaveText("connected", {
      timeout: 15_000,
    }),
    expect(receiver.getByTestId("connection-state")).toHaveText("connected", {
      timeout: 15_000,
    }),
  ]);
  return { contextA, contextB: receiverContext, sender, receiver };
};

const findBackingFileBySize = async (
  userDataDir: string,
  expectedSize: number,
): Promise<string> => {
  const fileSystemDir = join(userDataDir, "Default", "File System");
  const { stdout } = await execFile("find", [fileSystemDir, "-type", "f"]);
  const candidates = stdout
    .split("\n")
    .map((path) => path.trim())
    .filter((path) => path !== "" && !path.endsWith("/.usage"));
  const sized = await Promise.all(
    candidates.map(async (path) => ({ path, size: (await stat(path)).size })),
  );
  const match = sized.find(({ size }) => size === expectedSize);
  if (match === undefined) {
    throw new Error(
      `No OPFS backing file under ${fileSystemDir} has the expected size ${expectedSize} bytes.`,
    );
  }
  return match.path;
};

const captureReceivedZip = async (
  page: Page,
  userDataDir: string,
): Promise<string> => {
  const opfsFile = await page.evaluate(async (smallArchiveLimit) => {
    const fileName = window.__MAYO_OPFS_FILE__;
    if (fileName === undefined) {
      throw new Error("The FSA override did not record the OPFS filename.");
    }
    const root = await navigator.storage.getDirectory();
    const file = await (await root.getFileHandle(fileName)).getFile();
    if (file.size >= smallArchiveLimit) {
      return { size: file.size };
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let offset = 0; offset < bytes.byteLength; offset += 32 * 1024) {
      binary += String.fromCharCode(
        ...bytes.subarray(offset, offset + 32 * 1024),
      );
    }
    return { size: file.size, base64: btoa(binary) };
  }, SMALL_ARCHIVE_LIMIT);

  if (opfsFile.base64 !== undefined) {
    const archiveDir = await mkdtemp(join(tmpdir(), "mayo-folder-archive-"));
    const archivePath = join(archiveDir, "received.zip");
    const archive = Buffer.from(opfsFile.base64, "base64");
    if (archive.byteLength !== opfsFile.size) {
      throw new Error(
        `The in-page OPFS capture decoded to ${archive.byteLength} bytes; expected ${opfsFile.size}.`,
      );
    }
    await writeFile(archivePath, archive);
    return archivePath;
  }

  return findBackingFileBySize(userDataDir, opfsFile.size);
};

const listFiles = async (root: string): Promise<string[]> => {
  const { stdout } = await execFile("find", [root, "-type", "f"]);
  return stdout
    .split("\n")
    .map((path) => path.trim())
    .filter((path) => path !== "")
    .map((path) => relative(root, path));
};

const runArchiveChecks = async (
  archivePath: string,
  sourceRoot: string,
  expectedRootName: string,
): Promise<void> => {
  const { stdout: listing } = await execFile("unzip", ["-l", archivePath]);
  for (const file of await listFiles(sourceRoot)) {
    expect(listing).toContain(`${expectedRootName}/${file}`);
  }
  const longPath = (await listFiles(sourceRoot)).find((path) =>
    path.includes("leaf-file"),
  );
  if (longPath !== undefined) {
    expect(listing).toContain(`${expectedRootName}/${longPath}`);
  }
  if (sourceRoot === mainTree) {
    expect(listing).toContain(`${expectedRootName}/a/b/naïve — file.txt`);
    // File inputs cannot expose truly empty directories; the drag path is
    // covered by the unit walk gate, while this input gate checks all files.
  }

  const extracted = await mkdtemp(join(tmpdir(), "mayo-folder-unzip-"));
  try {
    await execFile("unzip", ["-q", archivePath, "-d", extracted]);
    const diffArgs = [
      "-r",
      ...(sourceRoot === mainTree ? ["--exclude=empty"] : []),
      sourceRoot,
      join(extracted, expectedRootName),
    ];
    const { stdout: diff } = await execFile("diff", diffArgs, {
      maxBuffer: 1024 * 1024,
    });
    expect(diff).toBe("");
    const { stdout: verbose } = await execFile("unzip", ["-v", archivePath]);
    expect(verbose).toContain("Stored");
    expect(verbose).not.toMatch(/Defl:N|Defl:X/);
  } finally {
    await rm(extracted, { recursive: true, force: true });
  }
};

const stageAndAccept = async (
  sender: Page,
  receiver: Page,
  folderPath: string,
  expectedFileCount: string,
): Promise<void> => {
  await sender.getByTestId("folder-input").setInputFiles(folderPath);
  await expect(receiver.getByTestId("manifest-file-count")).toHaveText(
    expectedFileCount,
    { timeout: 15_000 },
  );
  await receiver.getByTestId("accept-transfer").click();
};

test.describe("folder ZIP transfers", () => {
  test.describe.configure({ mode: "serial", timeout: 1_800_000 });

  test("streams the main tree into a persistent OPFS ZIP", async ({
    browser,
    browserName,
  }) => {
    test.skip(
      browserName !== "chromium",
      "Persistent OPFS capture is Chromium-only.",
    );
    const userDataDir = await mkdtemp(join(tmpdir(), "mayo-folder-"));
    const contextB = await chromium.launchPersistentContext(userDataDir, {
      baseURL: "http://127.0.0.1:5173",
    });
    let contextA: BrowserContext | undefined;
    let memory: MemorySampler | undefined;
    let archivePath: string | undefined;
    try {
      await addFsaInitScript(contextB);
      const pair = await openPair(browser, contextB);
      contextA = pair.contextA;
      memory = await startMemorySampler(pair.sender, browserName);
      await stageAndAccept(pair.sender, pair.receiver, mainTree, "4");
      await expect(pair.receiver.getByTestId("transfer-result")).toContainText(
        "verified=true",
        { timeout: 1_500_000 },
      );
      archivePath = await captureReceivedZip(pair.receiver, userDataDir);
      await runArchiveChecks(archivePath, mainTree, "mayo-tree");
    } finally {
      const samples = await memory?.stop();
      if (samples !== undefined && samples.length > 0) {
        expect(Math.max(...samples)).toBeLessThan(MEMORY_LIMIT);
      }
      await contextA?.close();
      await contextB.close();
      await rm(userDataDir, { recursive: true, force: true });
      if (archivePath !== undefined) {
        await rm(dirname(archivePath), { recursive: true, force: true });
      }
    }
  });

  test("skips system files and reports the skipped count", async ({
    browser,
    browserName,
  }) => {
    test.skip(
      browserName !== "chromium",
      "Persistent OPFS capture is Chromium-only.",
    );
    const userDataDir = await mkdtemp(join(tmpdir(), "mayo-folder-skip-"));
    const contextB = await chromium.launchPersistentContext(userDataDir, {
      baseURL: "http://127.0.0.1:5173",
    });
    let contextA: BrowserContext | undefined;
    let archivePath: string | undefined;
    try {
      await addFsaInitScript(contextB);
      const pair = await openPair(browser, contextB);
      contextA = pair.contextA;
      await pair.sender.getByTestId("folder-input").setInputFiles(skipTree);
      await expect(pair.sender.getByTestId("skipped-count")).toHaveText(
        "Skipped 4 system files",
      );
      await expect(pair.receiver.getByTestId("manifest-file-count")).toHaveText(
        "2",
      );
      await pair.receiver.getByTestId("accept-transfer").click();
      await expect(pair.receiver.getByTestId("transfer-result")).toContainText(
        "verified=true",
        { timeout: 300_000 },
      );
      archivePath = await captureReceivedZip(pair.receiver, userDataDir);
      const { stdout: listing } = await execFile("unzip", ["-l", archivePath]);
      expect(listing).toContain("mayo-tree-skip/keep/real.txt");
      expect(listing).toContain("mayo-tree-skip/keep/sub/real2.txt");
      expect(listing).not.toMatch(/\.DS_Store|Thumbs\.db|__MACOSX|\.git/);
    } finally {
      await contextA?.close();
      await contextB.close();
      await rm(userDataDir, { recursive: true, force: true });
      if (archivePath !== undefined) {
        await rm(dirname(archivePath), { recursive: true, force: true });
      }
    }
  });

  test("streams the ZIP64 sparse tree with bounded heap", async ({
    browser,
    browserName,
  }) => {
    test.skip(browserName !== "chromium", "ZIP64 heap gate is Chromium-only.");
    const userDataDir = await mkdtemp(join(tmpdir(), "mayo-folder-zip64-"));
    const contextB = await chromium.launchPersistentContext(userDataDir, {
      baseURL: "http://127.0.0.1:5173",
    });
    let contextA: BrowserContext | undefined;
    let memory: MemorySampler | undefined;
    let archivePath: string | undefined;
    try {
      await addFsaInitScript(contextB);
      const pair = await openPair(browser, contextB);
      contextA = pair.contextA;
      memory = await startMemorySampler(pair.sender, browserName);
      await stageAndAccept(pair.sender, pair.receiver, zip64Tree, "2");
      await expect(pair.receiver.getByTestId("transfer-result")).toContainText(
        "verified=true",
        { timeout: 1_700_000 },
      );
      archivePath = await captureReceivedZip(pair.receiver, userDataDir);
      await execFile("unzip", ["-t", archivePath], { maxBuffer: 1024 * 1024 });
      const { stdout: listing } = await execFile("unzip", ["-l", archivePath]);
      expect(listing).toContain("mayo-tree-zip64/huge-sparse.bin");
      expect(listing).toMatch(/\b4600000000\b/);
    } finally {
      const samples = await memory?.stop();
      if (samples !== undefined && samples.length > 0) {
        expect(Math.max(...samples)).toBeLessThan(MEMORY_LIMIT);
      }
      await contextA?.close();
      await contextB.close();
      await rm(userDataDir, { recursive: true, force: true });
      if (archivePath !== undefined) {
        await rm(dirname(archivePath), { recursive: true, force: true });
      }
    }
  });

  test("transfers the small tree in Firefox through the service-worker sink", async ({
    browser,
    browserName,
  }) => {
    test.skip(browserName !== "firefox", "This is the Firefox folder gate.");
    const contextB = await browser.newContext();
    let contextA: BrowserContext | undefined;
    try {
      await addFirefoxSinkInitScript(contextB);
      const pair = await openPair(browser, contextB);
      contextA = pair.contextA;
      const downloadPromise = pair.receiver.waitForEvent("download");
      const failureMonitor = startTransferFailureMonitor(pair.receiver);
      try {
        await stageAndAccept(pair.sender, pair.receiver, mainTree, "4");
        const download = await Promise.race([
          downloadPromise,
          failureMonitor.promise,
        ]);
        const downloadPath = await download.path();
        if (downloadPath === null) {
          throw new Error(
            "Firefox did not provide a folder ZIP download path.",
          );
        }
        await Promise.race([
          expect(pair.receiver.getByTestId("transfer-result")).toContainText(
            "verified=true",
            { timeout: 300_000 },
          ),
          failureMonitor.promise,
        ]);
        await runArchiveChecks(downloadPath, mainTree, "mayo-tree");
      } finally {
        failureMonitor.stop();
      }
    } finally {
      await contextA?.close();
      await contextB.close();
    }
  });
});
