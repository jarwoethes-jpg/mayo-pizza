import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from "@playwright/test";
import { readOpfsSha256 } from "./inPageHash";
import { startTransferFailureMonitor } from "./transferFailureMonitor";

const HIGH_WATERMARK = 8 * 1024 * 1024;
const MEMORY_LIMIT = 200 * 1024 * 1024;
const testFile = process.env.MAYO_TEST_FILE;
const expectedHash = process.env.MAYO_TEST_FILE_SHA256;
const swFirefoxFile = process.env.MAYO_TEST_FILE_SW_FIREFOX;
const swFirefoxHash = process.env.MAYO_TEST_FILE_SW_FIREFOX_SHA256;
const blobFile = process.env.MAYO_TEST_FILE_100M;
const blobHash = process.env.MAYO_TEST_FILE_100M_SHA256;
const blobLargeFile = process.env.MAYO_TEST_FILE_600M;
const slowFile = process.env.MAYO_TEST_FILE_SLOW;
const signalingUrl = "ws://127.0.0.1:3100/ws";

const sha256File = (path: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk: Buffer) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(hash.digest("hex")));
  });

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
    try {
      const used = await page.evaluate(() => {
        const performanceWithMemory = performance as Performance & {
          memory?: { usedJSHeapSize: number };
        };
        return performanceWithMemory.memory?.usedJSHeapSize;
      });
      if (used !== undefined) {
        samples.push(used);
        return;
      }
    } catch {
      // The page may have navigated the download iframe.
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
    },
    { url: signalingUrl },
  );
};

const addFsaInitScript = async (context: BrowserContext): Promise<void> => {
  await context.addInitScript(() => {
    window.showSaveFilePicker = async ({ suggestedName } = {}) => {
      const name = `mayo-${crypto.randomUUID()}-${suggestedName ?? "download.bin"}`;
      window.__MAYO_OPFS_FILE__ = name;
      const root = await navigator.storage.getDirectory();
      return root.getFileHandle(name, { create: true });
    };
  });
};

const addStrategyInitScript = async (
  context: BrowserContext,
  strategy: "sw" | "blob",
): Promise<void> => {
  await context.addInitScript(
    ({ selectedStrategy }) => {
      if (selectedStrategy === "sw") {
        try {
          Object.defineProperty(window, "showSaveFilePicker", {
            configurable: true,
            value: undefined,
          });
        } catch {
          // The browser may not expose the API as a configurable property.
        }
      }
      window.__MAYO_SINK__ = { strategy: selectedStrategy, autoAccept: false };
    },
    { selectedStrategy: strategy },
  );
};

const addSlowSinkInitScript = async (
  context: BrowserContext,
): Promise<void> => {
  await context.addInitScript(() => {
    window.__MAYO_SINK__ = {
      strategy: "null",
      autoAccept: false,
      factory: () => ({
        strategy: "null",
        write: () =>
          new Promise<void>((resolve) => window.setTimeout(resolve, 50)),
        close: () => undefined,
        cancel: () => undefined,
      }),
    };
  });
};

const openPair = async (
  browser: Browser,
  receiverSetup?: (context: BrowserContext) => Promise<void>,
  receiverContext?: BrowserContext,
): Promise<{
  contextA: BrowserContext;
  contextB: BrowserContext;
  sender: Page;
  receiver: Page;
}> => {
  const contextA = await browser.newContext();
  const contextB = receiverContext ?? (await browser.newContext());
  await addBaseInitScript(contextA);
  await addBaseInitScript(contextB);
  await receiverSetup?.(contextB);
  const sender = await contextA.newPage();
  await sender.goto("/");
  const slug = (await sender.getByTestId("slug").textContent())?.trim();
  if (slug === undefined || slug === "") {
    throw new Error("The sender did not render a room slug.");
  }
  const receiver = await contextB.newPage();
  await receiver.goto(`/${encodeURIComponent(slug)}`);
  await Promise.all([
    expect(sender.getByTestId("connection-state")).toHaveText("connected", {
      timeout: 15_000,
    }),
    expect(receiver.getByTestId("connection-state")).toHaveText("connected", {
      timeout: 15_000,
    }),
  ]);
  return { contextA, contextB, sender, receiver };
};

const transferToReceiver = async (
  sender: Page,
  receiver: Page,
  path: string,
): Promise<void> => {
  await sender.getByTestId("file-input").setInputFiles(path);
  await expect(receiver.getByTestId("accept-transfer")).toBeVisible({
    timeout: 15_000,
  });
  await receiver.getByTestId("accept-transfer").click();
};

test.describe("streaming download sinks", () => {
  test.describe.configure({ mode: "serial", timeout: 600_000 });

  test("FSA streams a large file into OPFS with bounded heap", async ({
    browser,
    browserName,
  }) => {
    test.setTimeout(1_200_000);
    test.skip(
      testFile === undefined || expectedHash === undefined,
      "MAYO_TEST_FILE and MAYO_TEST_FILE_SHA256 are required.",
    );
    if (testFile === undefined || expectedHash === undefined) {
      return;
    }
    test.skip(browserName !== "chromium", "FSA is gated to Chromium.");
    const userDataDir = await mkdtemp(join(tmpdir(), "mayo-fsa-"));
    let contextA: BrowserContext | undefined;
    let contextB: BrowserContext | undefined;
    let memory: MemorySampler | undefined;
    try {
      contextB = await chromium.launchPersistentContext(userDataDir, {
        baseURL: "http://127.0.0.1:5173",
      });
      const pair = await openPair(browser, addFsaInitScript, contextB);
      contextA = pair.contextA;
      const { sender, receiver } = pair;
      memory = await startMemorySampler(receiver, browserName);
      const failure = startTransferFailureMonitor(receiver);
      try {
        await transferToReceiver(sender, receiver, testFile);
        await Promise.race([
          expect(receiver.getByTestId("transfer-result")).toContainText(
            `verified=true sha256=${expectedHash}`,
            { timeout: 1_080_000 },
          ),
          failure.promise,
        ]);
        const fileName = await receiver.evaluate(
          () => window.__MAYO_OPFS_FILE__,
        );
        if (fileName === undefined) {
          throw new Error("The FSA test did not record its OPFS file name.");
        }
        expect(await readOpfsSha256(receiver, fileName)).toBe(expectedHash);
      } finally {
        failure.stop();
      }
    } finally {
      try {
        const samples = await memory?.stop();
        if (samples !== undefined && samples.length > 0) {
          expect(Math.max(...samples)).toBeLessThan(MEMORY_LIMIT);
        }
      } finally {
        await contextA?.close();
        await contextB?.close();
        await rm(userDataDir, { recursive: true, force: true });
      }
    }
  });

  test("service-worker streaming downloads a large file in Chromium and Firefox", async ({
    browser,
    browserName,
  }) => {
    test.setTimeout(1_200_000);
    // Firefox delays the download event until a >2 GiB SW stream ends; its portal
    // save path can then close the target, so Firefox stays on the verified 1 GiB gate.
    const swFile = browserName === "firefox" ? swFirefoxFile : testFile;
    const swHash = browserName === "firefox" ? swFirefoxHash : expectedHash;
    test.skip(
      swFile === undefined || swHash === undefined,
      browserName === "firefox"
        ? "MAYO_TEST_FILE_SW_FIREFOX and MAYO_TEST_FILE_SW_FIREFOX_SHA256 are required."
        : "MAYO_TEST_FILE and MAYO_TEST_FILE_SHA256 are required.",
    );
    if (swFile === undefined || swHash === undefined) {
      return;
    }
    const { contextA, contextB, sender, receiver } = await openPair(
      browser,
      async (context) => addStrategyInitScript(context, "sw"),
    );
    const failure = startTransferFailureMonitor(receiver);
    try {
      const downloadPromise = receiver.waitForEvent("download");
      await transferToReceiver(sender, receiver, swFile);
      const download = await Promise.race([downloadPromise, failure.promise]);
      const downloadPath = await download.path();
      if (downloadPath === null) {
        throw new Error("The service-worker download has no temporary path.");
      }
      expect(await sha256File(downloadPath)).toBe(swHash);
      await Promise.race([
        expect(receiver.getByTestId("transfer-result")).toContainText(
          `verified=true sha256=${swHash}`,
          { timeout: 1_080_000 },
        ),
        failure.promise,
      ]);
    } finally {
      failure.stop();
      await contextA.close();
      await contextB.close();
    }
  });

  test("blob fallback downloads 100 MiB and refuses 600 MiB before transfer", async ({
    browser,
  }) => {
    test.skip(
      blobFile === undefined ||
        blobHash === undefined ||
        blobLargeFile === undefined,
      "MAYO_TEST_FILE_100M, MAYO_TEST_FILE_100M_SHA256, and MAYO_TEST_FILE_600M are required.",
    );
    if (
      blobFile === undefined ||
      blobHash === undefined ||
      blobLargeFile === undefined
    ) {
      return;
    }
    const first = await openPair(browser, async (context) =>
      addStrategyInitScript(context, "blob"),
    );
    try {
      const downloadPromise = first.receiver.waitForEvent("download");
      await transferToReceiver(first.sender, first.receiver, blobFile);
      const download = await downloadPromise;
      const downloadPath = await download.path();
      if (downloadPath === null) {
        throw new Error("The blob download has no temporary path.");
      }
      expect(await sha256File(downloadPath)).toBe(blobHash);
    } finally {
      await first.contextA.close();
      await first.contextB.close();
    }

    const second = await openPair(browser, async (context) =>
      addStrategyInitScript(context, "blob"),
    );
    try {
      await second.sender
        .getByTestId("file-input")
        .setInputFiles(blobLargeFile);
      await expect(second.receiver.getByTestId("accept-transfer")).toBeVisible({
        timeout: 15_000,
      });
      await second.receiver.getByTestId("accept-transfer").click();
      await expect(second.receiver.getByTestId("log")).toContainText(
        /too large/i,
      );
      await expect(second.receiver.getByTestId("sink-strategy")).toBeVisible();
    } finally {
      await second.contextA.close();
      await second.contextB.close();
    }
  });

  test("slow sink commits keep sender bufferedAmount bounded", async ({
    browser,
  }) => {
    test.skip(slowFile === undefined, "MAYO_TEST_FILE_SLOW is required.");
    if (slowFile === undefined) {
      return;
    }
    const { contextA, contextB, sender, receiver } = await openPair(
      browser,
      addSlowSinkInitScript,
    );
    try {
      await transferToReceiver(sender, receiver, slowFile);
      await expect(receiver.getByTestId("transfer-result")).toContainText(
        "verified=true",
        { timeout: 240_000 },
      );
      const stats = await sender.evaluate(() => window.__MAYO_TRANSFER_STATS__);
      expect(stats?.maxBufferedAmount ?? 0).toBeLessThanOrEqual(
        HIGH_WATERMARK * 1.5,
      );
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });
});
