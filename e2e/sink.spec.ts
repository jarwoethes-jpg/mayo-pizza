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

interface TransferFailureMonitor {
  promise: Promise<never>;
  stop: () => void;
}

const startTransferFailureMonitor = (page: Page): TransferFailureMonitor => {
  let active = true;
  let interval: ReturnType<typeof setInterval> | undefined;
  let rejectFailure: (reason: Error) => void = () => undefined;
  const promise = new Promise<never>((_, reject) => {
    rejectFailure = reject;
  });
  const stop = (): void => {
    active = false;
    if (interval !== undefined) {
      clearInterval(interval);
    }
  };
  const check = async (): Promise<void> => {
    if (!active) {
      return;
    }
    try {
      const log = await page.getByTestId("log").textContent({ timeout: 1_000 });
      if (active && /fail|error|quota/i.test(log ?? "")) {
        const error = new Error(`Transfer failed: ${log ?? ""}`);
        stop();
        rejectFailure(error);
      }
    } catch {
      // The page can be closing after the transfer result is observed.
    }
  };
  interval = setInterval(() => void check(), 500);
  void check();
  return { promise, stop };
};

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

const readOpfsSha256 = async (
  page: Page,
  fileName: string,
): Promise<string> => {
  return page.evaluate(async (name) => {
    const roundRight = (value: number, bits: number): number =>
      (value >>> bits) | (value << (32 - bits));
    const constants = [
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
      0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
      0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
      0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
      0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
      0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
      0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
      0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
      0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];
    const at = (values: ArrayLike<number>, index: number): number =>
      values[index] ?? 0;
    class Sha256 {
      private readonly state = new Uint32Array([
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
        0x1f83d9ab, 0x5be0cd19,
      ]);
      private readonly words = new Uint32Array(64);
      private readonly buffer = new Uint8Array(64);
      private bufferLength = 0;
      private byteLength = 0;

      public update(input: Uint8Array): void {
        this.byteLength += input.byteLength;
        let offset = 0;
        if (this.bufferLength > 0) {
          const copied = Math.min(64 - this.bufferLength, input.byteLength);
          this.buffer.set(input.subarray(0, copied), this.bufferLength);
          this.bufferLength += copied;
          offset += copied;
          if (this.bufferLength === 64) {
            this.compress(this.buffer);
            this.bufferLength = 0;
          }
        }
        while (offset + 64 <= input.byteLength) {
          this.compress(input.subarray(offset, offset + 64));
          offset += 64;
        }
        if (offset < input.byteLength) {
          this.buffer.set(input.subarray(offset));
          this.bufferLength = input.byteLength - offset;
        }
      }

      public digest(): string {
        const paddedLength = Math.floor((this.bufferLength + 9 + 63) / 64) * 64;
        const padded = new Uint8Array(paddedLength);
        padded.set(this.buffer.subarray(0, this.bufferLength));
        padded[this.bufferLength] = 0x80;
        const bitLength = this.byteLength * 8;
        const view = new DataView(padded.buffer);
        view.setUint32(
          paddedLength - 8,
          Math.floor(bitLength / 0x1_0000_0000),
          false,
        );
        view.setUint32(paddedLength - 4, bitLength >>> 0, false);
        for (let offset = 0; offset < paddedLength; offset += 64) {
          this.compress(padded.subarray(offset, offset + 64));
        }
        return Array.from(this.state, (word) =>
          word.toString(16).padStart(8, "0"),
        ).join("");
      }

      private compress(block: Uint8Array): void {
        for (let index = 0; index < 16; index += 1) {
          const offset = index * 4;
          this.words[index] =
            ((at(block, offset) << 24) |
              (at(block, offset + 1) << 16) |
              (at(block, offset + 2) << 8) |
              at(block, offset + 3)) >>>
            0;
        }
        for (let index = 16; index < 64; index += 1) {
          const first = at(this.words, index - 15);
          const second = at(this.words, index - 2);
          const smallSigma0 =
            roundRight(first, 7) ^ roundRight(first, 18) ^ (first >>> 3);
          const smallSigma1 =
            roundRight(second, 17) ^ roundRight(second, 19) ^ (second >>> 10);
          this.words[index] =
            (at(this.words, index - 16) +
              smallSigma0 +
              at(this.words, index - 7) +
              smallSigma1) >>>
            0;
        }

        let a = at(this.state, 0);
        let b = at(this.state, 1);
        let c = at(this.state, 2);
        let d = at(this.state, 3);
        let e = at(this.state, 4);
        let f = at(this.state, 5);
        let g = at(this.state, 6);
        let h = at(this.state, 7);
        for (let index = 0; index < 64; index += 1) {
          const bigSigma1 =
            roundRight(e, 6) ^ roundRight(e, 11) ^ roundRight(e, 25);
          const choice = (e & f) ^ (~e & g);
          const first =
            (h +
              bigSigma1 +
              choice +
              at(constants, index) +
              at(this.words, index)) >>>
            0;
          const bigSigma0 =
            roundRight(a, 2) ^ roundRight(a, 13) ^ roundRight(a, 22);
          const majority = (a & b) ^ (a & c) ^ (b & c);
          const second = (bigSigma0 + majority) >>> 0;
          h = g;
          g = f;
          f = e;
          e = (d + first) >>> 0;
          d = c;
          c = b;
          b = a;
          a = (first + second) >>> 0;
        }
        this.state[0] = (at(this.state, 0) + a) >>> 0;
        this.state[1] = (at(this.state, 1) + b) >>> 0;
        this.state[2] = (at(this.state, 2) + c) >>> 0;
        this.state[3] = (at(this.state, 3) + d) >>> 0;
        this.state[4] = (at(this.state, 4) + e) >>> 0;
        this.state[5] = (at(this.state, 5) + f) >>> 0;
        this.state[6] = (at(this.state, 6) + g) >>> 0;
        this.state[7] = (at(this.state, 7) + h) >>> 0;
      }
    }

    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(name);
    const file = await handle.getFile();
    const hash = new Sha256();
    const sliceSize = 64 * 1024 * 1024;
    for (let offset = 0; offset < file.size; offset += sliceSize) {
      const bytes = await file.slice(offset, offset + sliceSize).arrayBuffer();
      hash.update(new Uint8Array(bytes));
    }
    return hash.digest();
  }, fileName);
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
