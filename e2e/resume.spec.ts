/// <reference path="./global.d.ts" />

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
import { baseURL, signalingUrl } from "./target";

const testFile = process.env.MAYO_TEST_FILE;
const expectedHash = process.env.MAYO_TEST_FILE_SHA256;
if (testFile !== undefined && expectedHash === undefined) {
  throw new Error(
    "MAYO_TEST_FILE_SHA256 is required when MAYO_TEST_FILE is set. Run `pnpm e2e:fixtures -- --full --print-exports`.",
  );
}
const totalBytes = 1_073_741_824;

const addBaseInitScript = async (context: BrowserContext): Promise<void> => {
  await context.addInitScript(
    ({ url }) => {
      window.__MAYO_SIGNALING_URL__ = url;
      window.__MAYO_SINK__ = "null";
      // The app is served from a production preview build; this marker opts
      // only this test page into the deterministic drop hook.
      window.__MAYO_E2E__ = true;
    },
    { url: signalingUrl },
  );
};

const addFsaInitScript = async (context: BrowserContext): Promise<void> => {
  await context.addInitScript(() => {
    window.showSaveFilePicker = async ({ suggestedName } = {}) => {
      const name = `mayo-resume-${crypto.randomUUID()}-${suggestedName ?? "download.bin"}`;
      window.__MAYO_OPFS_FILE__ = name;
      const root = await navigator.storage.getDirectory();
      return root.getFileHandle(name, { create: true });
    };
    window.__MAYO_SINK__ = { strategy: "fsa", autoAccept: true };
  });
};

const readProgressBytes = async (page: Page): Promise<number> => {
  const text = await page.getByTestId("progress").textContent();
  return Number(text?.match(/^(\d+)/)?.[1] ?? 0);
};

const dropAndRestore = async (
  context: BrowserContext,
  receiver: Page,
  before: number,
): Promise<void> => {
  let minimumObserved = before;
  const sampleProgress = async (): Promise<number> => {
    const current = await readProgressBytes(receiver);
    minimumObserved = Math.min(minimumObserved, current);
    return current;
  };

  await context.setOffline(true);
  for (let elapsed = 0; elapsed < 5_000; elapsed += 250) {
    await receiver.waitForTimeout(250);
    await sampleProgress();
  }
  const after = await sampleProgress();
  // Loopback WebRTC can survive Playwright's offline emulation. In that case
  // use the preview-enabled e2e hook so this spec verifies the real
  // reconnect/resume path.
  if (after > before + totalBytes * 0.02) {
    await receiver.evaluate(() => window.__MAYO_DEBUG_DROP__?.());
    await expect(receiver.getByTestId("session-status")).toHaveText(
      /reconnecting|resuming/,
      { timeout: 15_000 },
    );
  }
  expect(
    after <= before + totalBytes * 0.02 ||
      (await receiver.getByTestId("session-status").textContent()) !==
        "connected",
  ).toBe(true);
  await context.setOffline(false);

  await expect
    .poll(
      async () => {
        await sampleProgress();
        return (
          (await receiver.getByTestId("session-status").textContent()) ?? ""
        );
      },
      { timeout: 120_000 },
    )
    .toMatch(/connected|resuming/);

  // A restart from zero must be visible during recovery. The durable sink
  // can rewind only the bounded in-flight queue, never the committed prefix.
  expect(minimumObserved).toBeGreaterThanOrEqual(before - totalBytes * 0.05);
  await expect
    .poll(sampleProgress, { timeout: 15_000 })
    .toBeGreaterThanOrEqual(before - totalBytes * 0.03);
  expect(minimumObserved).toBeGreaterThanOrEqual(before - totalBytes * 0.05);
};

const openPairWithFsa = async (
  browser: Browser,
): Promise<{
  contextA: BrowserContext;
  contextB: BrowserContext;
  sender: Page;
  receiver: Page;
  userDataDir: string;
}> => {
  const contextA = await browser.newContext();
  const userDataDir = await mkdtemp(join(tmpdir(), "mayo-resume-"));
  const contextB = await chromium.launchPersistentContext(userDataDir, {
    baseURL,
  });
  await addBaseInitScript(contextA);
  await addBaseInitScript(contextB);
  await addFsaInitScript(contextB);
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
  return { contextA, contextB, sender, receiver, userDataDir };
};

const runResumeTransfer = async (
  browser: Browser,
  dropTargets: readonly number[],
  file: string,
  hash: string,
): Promise<void> => {
  const { contextA, contextB, sender, receiver, userDataDir } =
    await openPairWithFsa(browser);
  try {
    await sender.getByTestId("file-input").setInputFiles(file);
    for (const target of dropTargets) {
      await expect
        .poll(() => readProgressBytes(receiver), { timeout: 300_000 })
        .toBeGreaterThanOrEqual(Math.floor(totalBytes * target));
      const before = await readProgressBytes(receiver);
      await dropAndRestore(contextB, receiver, before);
    }
    await expect(receiver.getByTestId("transfer-result")).toContainText(
      `verified=true sha256=${hash}`,
      { timeout: 600_000 },
    );
    const fileName = await receiver.evaluate(() => window.__MAYO_OPFS_FILE__);
    if (fileName === undefined) {
      throw new Error("The resume test did not record its OPFS file name.");
    }
    expect(await readOpfsSha256(receiver, fileName)).toBe(hash);
  } finally {
    await contextA.close();
    await contextB.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
};

test.describe("same-session transfer resume", () => {
  test.describe.configure({ mode: "serial", timeout: 1_200_000 });

  test("resumes a 1 GiB transfer after a network drop", async ({
    browser,
    browserName,
  }) => {
    test.skip(
      testFile === undefined,
      "MAYO_TEST_FILE is required for resume e2e.",
    );
    test.skip(browserName !== "chromium", "FSA resume uses Chromium OPFS.");
    if (testFile === undefined || expectedHash === undefined) {
      return;
    }
    await runResumeTransfer(browser, [0.4], testFile, expectedHash);
  });

  test("survives three drops without restarting the transfer", async ({
    browser,
    browserName,
  }) => {
    test.skip(
      testFile === undefined,
      "MAYO_TEST_FILE is required for resume e2e.",
    );
    test.skip(browserName !== "chromium", "FSA resume uses Chromium OPFS.");
    if (testFile === undefined || expectedHash === undefined) {
      return;
    }
    await runResumeTransfer(browser, [0.25, 0.5, 0.75], testFile, expectedHash);
  });
});
