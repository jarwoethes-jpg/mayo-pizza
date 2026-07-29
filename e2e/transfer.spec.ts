import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { signalingUrl } from "./target";

const HIGH_WATERMARK = 8 * 1024 * 1024;
const LOW_THRESHOLD = 1 * 1024 * 1024;
const FRAME_SIZE = 16 * 1024;
const BASELINE_BYTES = 64 * 1024 * 1024;
const MEMORY_LIMIT = 200 * 1024 * 1024;
const testFile = process.env.MAYO_TEST_FILE;

const measureRawBaseline = (page: Page): Promise<number> =>
  page.evaluate(
    async ({ baselineBytes, frameSize, highWatermark, lowThreshold }) => {
      const sender = new RTCPeerConnection({ iceServers: [] });
      const receiver = new RTCPeerConnection({ iceServers: [] });
      const data = sender.createDataChannel("baseline", { ordered: true });
      data.binaryType = "arraybuffer";
      data.bufferedAmountLowThreshold = lowThreshold;

      const pendingForSender: RTCIceCandidate[] = [];
      const pendingForReceiver: RTCIceCandidate[] = [];
      let senderRemoteReady = false;
      let receiverRemoteReady = false;
      let receiverChannel: RTCDataChannel | undefined;
      let startedAt = 0;
      let sentBytes = 0;
      let receivedBytes = 0;
      let settled = false;
      let resolveResult: (bytesPerSec: number) => void = () => {};
      let rejectResult: (error: Error) => void = () => {};

      const result = new Promise<number>((resolve, reject) => {
        resolveResult = resolve;
        rejectResult = reject;
      });
      const timeout = window.setTimeout(() => {
        fail(new Error("Raw WebRTC baseline timed out."));
      }, 90_000);

      const cleanup = (): void => {
        window.clearTimeout(timeout);
        data.close();
        receiverChannel?.close();
        sender.close();
        receiver.close();
      };
      const fail = (reason: unknown): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        rejectResult(
          reason instanceof Error ? reason : new Error(String(reason)),
        );
      };
      const succeed = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        const elapsedSeconds = Math.max(
          (performance.now() - startedAt) / 1_000,
          0.001,
        );
        cleanup();
        resolveResult(baselineBytes / elapsedSeconds);
      };
      const addCandidate = (
        target: RTCPeerConnection,
        pending: RTCIceCandidate[],
        remoteReady: boolean,
        candidate: RTCIceCandidate,
      ): void => {
        if (!remoteReady) {
          pending.push(candidate);
          return;
        }
        void target.addIceCandidate(candidate).catch(fail);
      };
      const flushCandidates = async (
        target: RTCPeerConnection,
        pending: RTCIceCandidate[],
      ): Promise<void> => {
        const candidates = pending.splice(0);
        await Promise.all(
          candidates.map((candidate) => target.addIceCandidate(candidate)),
        );
      };

      const sendMore = (): void => {
        if (settled) {
          return;
        }
        try {
          while (
            sentBytes < baselineBytes &&
            data.bufferedAmount < highWatermark
          ) {
            const length = Math.min(frameSize, baselineBytes - sentBytes);
            data.send(new Uint8Array(length));
            sentBytes += length;
          }
        } catch (error) {
          fail(error);
        }
      };

      data.addEventListener("bufferedamountlow", sendMore);
      receiver.ondatachannel = (event) => {
        receiverChannel = event.channel;
        receiverChannel.binaryType = "arraybuffer";
        receiverChannel.addEventListener("message", (message) => {
          if (settled) {
            return;
          }
          const payload = message.data as ArrayBuffer;
          receivedBytes += payload.byteLength;
          if (receivedBytes >= baselineBytes) {
            succeed();
          }
        });
      };
      sender.onicecandidate = (event) => {
        if (event.candidate !== null) {
          addCandidate(
            receiver,
            pendingForReceiver,
            receiverRemoteReady,
            event.candidate,
          );
        }
      };
      receiver.onicecandidate = (event) => {
        if (event.candidate !== null) {
          addCandidate(
            sender,
            pendingForSender,
            senderRemoteReady,
            event.candidate,
          );
        }
      };
      sender.onconnectionstatechange = () => {
        if (sender.connectionState === "failed") {
          fail(new Error("Raw WebRTC baseline sender connection failed."));
        }
      };
      receiver.onconnectionstatechange = () => {
        if (receiver.connectionState === "failed") {
          fail(new Error("Raw WebRTC baseline receiver connection failed."));
        }
      };
      data.addEventListener("open", () => {
        startedAt = performance.now();
        sendMore();
      });

      try {
        await sender.setLocalDescription(await sender.createOffer());
        await receiver.setRemoteDescription(
          sender.localDescription as RTCSessionDescriptionInit,
        );
        receiverRemoteReady = true;
        await flushCandidates(receiver, pendingForReceiver);
        await receiver.setLocalDescription(await receiver.createAnswer());
        await sender.setRemoteDescription(
          receiver.localDescription as RTCSessionDescriptionInit,
        );
        senderRemoteReady = true;
        await flushCandidates(sender, pendingForSender);
      } catch (error) {
        fail(error);
      }

      return result;
    },
    {
      baselineBytes: BASELINE_BYTES,
      frameSize: FRAME_SIZE,
      highWatermark: HIGH_WATERMARK,
      lowThreshold: LOW_THRESHOLD,
    },
  );

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

test.describe("single-file transfer", () => {
  test.describe.configure({ mode: "serial", timeout: 420_000 });

  let baselineBytesPerSec: number | undefined;

  test.beforeAll(async ({ browser, browserName }) => {
    if (testFile === undefined) {
      return;
    }
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      baselineBytesPerSec = await measureRawBaseline(page);
      if (!Number.isFinite(baselineBytesPerSec) || baselineBytesPerSec <= 0) {
        throw new Error("Raw WebRTC baseline returned an invalid rate.");
      }
      console.log(
        `[baseline:${browserName}] ${(baselineBytesPerSec / (1024 * 1024)).toFixed(2)} MiB/s`,
      );
    } finally {
      await context.close();
    }
  });

  test("transfers, verifies, and stays below the memory/backpressure limits", async ({
    browser,
    browserName,
  }) => {
    test.skip(
      testFile === undefined,
      "MAYO_TEST_FILE is required for transfer e2e.",
    );
    test.setTimeout(420_000);
    if (testFile === undefined) {
      return;
    }
    if (baselineBytesPerSec === undefined) {
      throw new Error("Raw WebRTC baseline was not measured.");
    }

    const expectedHash = await sha256File(testFile);
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const forceRelay = process.env.MAYO_FORCE_RELAY === "1";
    for (const context of [contextA, contextB]) {
      await context.addInitScript(
        ({ corrupt, forceRelay: shouldForceRelay, url }) => {
          window.__MAYO_SIGNALING_URL__ = url;
          window.__MAYO_FORCE_RELAY__ = shouldForceRelay;
          window.__MAYO_CORRUPT_FRAME__ = corrupt;
          window.__MAYO_SINK__ = "null";
        },
        { corrupt: false, forceRelay, url: signalingUrl },
      );
    }

    try {
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
        expect(receiver.getByTestId("connection-state")).toHaveText(
          "connected",
          {
            timeout: 15_000,
          },
        ),
      ]);

      const senderMemory = await startMemorySampler(sender, browserName);
      const receiverMemory = await startMemorySampler(receiver, browserName);
      const startedAt = Date.now();
      await sender.getByTestId("file-input").setInputFiles(testFile);
      await expect(receiver.getByTestId("transfer-result")).toContainText(
        `verified=true sha256=${expectedHash}`,
        { timeout: 360_000 },
      );
      const elapsedSeconds = Math.max((Date.now() - startedAt) / 1_000, 0.001);
      const fileBytes = statSync(testFile).size;
      const appBytesPerSec = fileBytes / elapsedSeconds;
      console.log(
        `[transfer:${browserName}] app ${(appBytesPerSec / (1024 * 1024)).toFixed(2)} MiB/s; baseline ${(baselineBytesPerSec / (1024 * 1024)).toFixed(2)} MiB/s`,
      );
      const progress = await receiver.getByTestId("progress").textContent();
      const reportedBytesPerSec = Number(
        progress?.match(/· (\d+) B\/s/)?.[1] ?? 0,
      );
      console.log(
        `[transfer:${browserName}] receiver-reported ${(reportedBytesPerSec / (1024 * 1024)).toFixed(2)} MiB/s`,
      );

      const stats = await sender.evaluate(() => window.__MAYO_TRANSFER_STATS__);
      expect(stats?.maxBufferedAmount ?? 0).toBeLessThanOrEqual(
        HIGH_WATERMARK * 1.5,
      );

      const [senderSamples, receiverSamples] = await Promise.all([
        senderMemory.stop(),
        receiverMemory.stop(),
      ]);
      for (const samples of [senderSamples, receiverSamples]) {
        if (samples.length > 0) {
          expect(Math.max(...samples)).toBeLessThan(MEMORY_LIMIT);
          expect(Math.max(...samples) - samples[0]).toBeLessThan(MEMORY_LIMIT);
        }
      }

      // Absolute floor approved by Mayo 2026-07-28, replacing the app/raw ratio.
      //
      // WHY the ratio was abandoned: the app is CPU-bound (double SHA-256, per-frame worker
      // hops, two-page topology) while the raw baseline is channel-bound, so a FASTER host
      // lowers the ratio. On 2026-07-28 the same commit scored 0.805 on a loaded host and
      // 0.574 on a quiet one, where the baseline had doubled to 21 MiB/s but the app gained
      // only 46%. The ratio had already been recalibrated once for Firefox (0.30) for the
      // same reason. It punishes good hardware instead of catching regressions.
      //
      // The floors sit ~30% under the slowest app throughput ever measured on this host
      // (chromium 8.36 MiB/s, firefox 4.87 MiB/s). Broken framing or absent backpressure
      // lands an order of magnitude below this, which is what the gate exists to catch.
      // The raw baseline is still measured and logged above as a diagnostic.
      const throughputFloor = (browserName === "firefox" ? 3 : 6) * 1024 * 1024;
      expect(appBytesPerSec).toBeGreaterThanOrEqual(throughputFloor);
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  test("refuses a corrupted outgoing frame", async ({ browser }) => {
    test.skip(
      testFile === undefined,
      "MAYO_TEST_FILE is required for transfer e2e.",
    );
    test.setTimeout(420_000);
    if (testFile === undefined) {
      return;
    }

    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const forceRelay = process.env.MAYO_FORCE_RELAY === "1";
    await contextA.addInitScript(
      ({ forceRelay: shouldForceRelay, url }) => {
        window.__MAYO_SIGNALING_URL__ = url;
        window.__MAYO_FORCE_RELAY__ = shouldForceRelay;
        window.__MAYO_CORRUPT_FRAME__ = true;
        window.__MAYO_SINK__ = "null";
      },
      { forceRelay, url: signalingUrl },
    );
    await contextB.addInitScript(
      ({ forceRelay: shouldForceRelay, url }) => {
        window.__MAYO_SIGNALING_URL__ = url;
        window.__MAYO_FORCE_RELAY__ = shouldForceRelay;
        window.__MAYO_CORRUPT_FRAME__ = false;
        window.__MAYO_SINK__ = "null";
      },
      { forceRelay, url: signalingUrl },
    );

    try {
      const sender = await contextA.newPage();
      await sender.goto("/");
      const slug = (await sender.getByTestId("slug").textContent())?.trim();
      if (slug === undefined || slug === "") {
        throw new Error("The sender did not render a room slug.");
      }
      const receiver = await contextB.newPage();
      await receiver.goto(`/${encodeURIComponent(slug)}`);
      await expect(receiver.getByTestId("connection-state")).toHaveText(
        "connected",
        {
          timeout: 15_000,
        },
      );
      await sender.getByTestId("file-input").setInputFiles(testFile);
      await expect(receiver.getByTestId("transfer-result")).toContainText(
        "verified=false",
        { timeout: 360_000 },
      );
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });
});
