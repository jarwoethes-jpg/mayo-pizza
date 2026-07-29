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
  type Locator,
  type Page,
  test,
} from "@playwright/test";
// @ts-expect-error -- plain-JS infra module shared with the Caddy generator; typed via JSDoc.
import { buildHeaders } from "../infra/header-source.mjs";
import { readOpfsSha256 } from "./inPageHash";
import { baseURL, signalingUrl } from "./target";

// Compare against the composed PREVIEW policy, not raw headers.json: production and preview
// share one core string but differ in connect-src, and the anti-drift guarantee is that both
// come from the same composer (see infra/header-source.mjs).
const canonicalHeaders = buildHeaders("preview") as Record<
  string,
  string | null
>;

interface CSPViolation {
  violatedDirective: string;
  blockedURI: string;
  sourceFile: string;
}

interface PageErrorMonitor {
  getViolations: () => Promise<CSPViolation[]>;
  consoleErrors: string[];
  pageErrors: string[];
}

/**
 * Reads the progress bar's inline width as a number of percent.
 *
 * React writes fractional widths (`width: 33.33%`), so this parses the value rather than
 * pattern-matching whole numbers — a regex demanding `%` straight after the integer part
 * silently fails on every real mid-transfer width.
 */
const inlineWidthPercent = async (locator: Locator): Promise<number> => {
  const style = (await locator.getAttribute("style")) ?? "";
  const match = /width:\s*([\d.]+)%/.exec(style);
  return match === null ? 0 : Number.parseFloat(match[1]);
};

const sha256File = (path: string): Promise<string> =>
  new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk: Buffer) => hash.update(chunk));
    stream.once("error", rejectPromise);
    stream.once("end", () => resolvePromise(hash.digest("hex")));
  });

const configureContext = async (
  context: BrowserContext,
  sinkStrategy?: "fsa" | "sw" | "blob",
): Promise<void> => {
  await context.addInitScript(
    ({ url, strategy }) => {
      window.__MAYO_SIGNALING_URL__ = url;
      window.__MAYO_FORCE_RELAY__ = false;
      window.__MAYO_CORRUPT_FRAME__ = false;
      window.__MAYO_E2E__ = true;

      if (strategy === "fsa") {
        window.showSaveFilePicker = async ({ suggestedName } = {}) => {
          const name = `mayo-${crypto.randomUUID()}-${suggestedName ?? "download.bin"}`;
          window.__MAYO_OPFS_FILE__ = name;
          const root = await navigator.storage.getDirectory();
          return root.getFileHandle(name, { create: true });
        };
      } else if (strategy === "sw" || strategy === "blob") {
        if (strategy === "sw") {
          try {
            Object.defineProperty(window, "showSaveFilePicker", {
              configurable: true,
              value: undefined,
            });
          } catch {
            // Browsers may define non-configurable property descriptors on window.
          }
        }
        window.__MAYO_SINK__ = { strategy, autoAccept: false };
      }

      window.__cspViolations = [];
      window.addEventListener("securitypolicyviolation", (event) => {
        window.__cspViolations.push({
          violatedDirective: event.violatedDirective,
          blockedURI: event.blockedURI,
          sourceFile: event.sourceFile,
        });
      });
    },
    { url: signalingUrl, strategy: sinkStrategy },
  );
};

const setupPageSecurityMonitoring = async (
  page: Page,
): Promise<PageErrorMonitor> => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      consoleErrors.push(`[${page.url()}] console.error: ${msg.text()}`);
    }
  });

  page.on("pageerror", (error) => {
    pageErrors.push(`[${page.url()}] pageerror: ${error.message}`);
  });

  return {
    getViolations: async () => {
      return await page.evaluate(() => {
        return (
          (window as unknown as { __cspViolations?: CSPViolation[] })
            .__cspViolations ?? []
        );
      });
    },
    consoleErrors,
    pageErrors,
  };
};

const openMonitoredPair = async (
  browser: Browser,
  sinkStrategy?: "fsa" | "sw" | "blob",
  receiverContextOverride?: BrowserContext,
): Promise<{
  contextA: BrowserContext;
  contextB: BrowserContext;
  sender: Page;
  receiver: Page;
  senderMonitor: PageErrorMonitor;
  receiverMonitor: PageErrorMonitor;
}> => {
  const contextA = await browser.newContext();
  const contextB = receiverContextOverride ?? (await browser.newContext());
  await configureContext(contextA, sinkStrategy);
  await configureContext(contextB, sinkStrategy);

  const sender = await contextA.newPage();
  const senderMonitor = await setupPageSecurityMonitoring(sender);
  await sender.goto("/");

  const slug = (await sender.getByTestId("slug").textContent())?.trim();
  if (slug === undefined || slug === "") {
    throw new Error("The sender did not render a room slug.");
  }

  const receiver = await contextB.newPage();
  const receiverMonitor = await setupPageSecurityMonitoring(receiver);
  await receiver.goto(`/${encodeURIComponent(slug)}`);

  await Promise.all([
    expect(sender.getByTestId("connection-state")).toHaveText("connected", {
      timeout: 15_000,
    }),
    expect(receiver.getByTestId("connection-state")).toHaveText("connected", {
      timeout: 15_000,
    }),
  ]);

  return {
    contextA,
    contextB,
    sender,
    receiver,
    senderMonitor,
    receiverMonitor,
  };
};

const transferPayloadToReceiver = async (
  sender: Page,
  receiver: Page,
  payload: { name: string; mimeType: string; buffer: Buffer },
): Promise<void> => {
  await sender.getByTestId("file-input").setInputFiles(payload);
  await expect(receiver.getByTestId("accept-transfer")).toBeVisible({
    timeout: 15_000,
  });
  await receiver.getByTestId("accept-transfer").click();
};

const assertNoSecurityViolations = async (
  senderMonitor: PageErrorMonitor,
  receiverMonitor: PageErrorMonitor,
): Promise<void> => {
  const senderViolations = await senderMonitor.getViolations();
  const receiverViolations = await receiverMonitor.getViolations();
  const allViolations = [...senderViolations, ...receiverViolations];

  expect(
    allViolations,
    `Content Security Policy violations recorded during transfer:\n${JSON.stringify(allViolations, null, 2)}`,
  ).toEqual([]);

  expect(
    senderMonitor.pageErrors,
    `Uncaught page errors recorded on sender:\n${senderMonitor.pageErrors.join("\n")}`,
  ).toEqual([]);

  expect(
    receiverMonitor.pageErrors,
    `Uncaught page errors recorded on receiver:\n${receiverMonitor.pageErrors.join("\n")}`,
  ).toEqual([]);
};

test.describe("Content Security Policy and HTTP security headers", () => {
  test("serves a Content-Security-Policy byte-identical to the composed preview policy", async ({
    page,
  }) => {
    const response = await page.goto("/");
    expect(response).not.toBeNull();
    const servedCsp = await response?.headerValue("content-security-policy");
    const expectedCsp = canonicalHeaders["Content-Security-Policy"];

    // Guard the fixture itself: if the canonical set ever loses its CSP entry, a plain
    // equality check would pass against an equally-absent served header.
    expect(
      typeof expectedCsp,
      "infra/headers.json must define a Content-Security-Policy string.",
    ).toBe("string");
    expect(servedCsp).toBe(expectedCsp);
  });

  test("serves all canonical security headers defined in infra/headers.json", async ({
    page,
  }) => {
    const response = await page.goto("/");
    expect(response).not.toBeNull();

    for (const [headerName, expectedValue] of Object.entries(
      canonicalHeaders,
    )) {
      const servedValue = await response?.headerValue(headerName);

      // A null entry in the canonical set means the header must be suppressed, not sent
      // with the literal value "null" — Caddy's `header -Server` removes it entirely.
      if (expectedValue === null) {
        expect(
          servedValue,
          `Header '${headerName}' must be suppressed but was served as '${servedValue}'.`,
        ).toBeNull();
        continue;
      }

      expect(
        servedValue,
        `Header '${headerName}' did not match canonical infra/headers.json configuration.`,
      ).toBe(expectedValue);
    }
  });

  // React applies inline styles (like style={{ width }}) via CSSOM element.style properties rather than string HTML injection.
  // CSP 'style-src 'self'' restricts <style> tags and inline style="" HTML attributes, but permits CSSOM property assignments.
  // We explicitly verify that the progress bar element reaches a non-zero inline width during transfer without triggering style-src violations.
  test("FSA sink completes file transfer without CSP violations", async ({
    browser,
    browserName,
  }) => {
    test.skip(
      browserName !== "chromium",
      "File System Access (FSA) API is Chromium-only.",
    );

    const userDataDir = await mkdtemp(join(tmpdir(), "mayo-csp-fsa-"));
    let contextA: BrowserContext | undefined;
    let contextB: BrowserContext | undefined;

    try {
      contextB = await chromium.launchPersistentContext(userDataDir, {
        baseURL,
      });
      const pair = await openMonitoredPair(browser, "fsa", contextB);
      contextA = pair.contextA;
      const { sender, receiver, senderMonitor, receiverMonitor } = pair;

      const payload = {
        name: "csp-fsa-test.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("fsa-csp-test-content-payload-bytes"),
      };
      const expectedHash = createHash("sha256")
        .update(payload.buffer)
        .digest("hex");

      await transferPayloadToReceiver(sender, receiver, payload);

      const progressFill = receiver.locator(".progress-fill").first();
      await expect(progressFill).toBeVisible({ timeout: 15_000 });
      await expect
        .poll(async () => await inlineWidthPercent(progressFill))
        .toBeGreaterThan(0);

      await expect(receiver.getByTestId("transfer-result")).toContainText(
        `verified=true sha256=${expectedHash}`,
        { timeout: 15_000 },
      );

      const fileName = await receiver.evaluate(() => window.__MAYO_OPFS_FILE__);
      if (fileName === undefined) {
        throw new Error("FSA test did not record the OPFS file name.");
      }
      expect(await readOpfsSha256(receiver, fileName)).toBe(expectedHash);

      await assertNoSecurityViolations(senderMonitor, receiverMonitor);
    } finally {
      await contextA?.close();
      await contextB?.close();
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  test("Service Worker stream sink completes file transfer without CSP violations", async ({
    browser,
  }) => {
    const {
      contextA,
      contextB,
      sender,
      receiver,
      senderMonitor,
      receiverMonitor,
    } = await openMonitoredPair(browser, "sw");

    try {
      const payload = {
        name: "csp-sw-test.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("sw-stream-csp-test-content-payload-bytes"),
      };
      const expectedHash = createHash("sha256")
        .update(payload.buffer)
        .digest("hex");

      const downloadPromise = receiver.waitForEvent("download");
      await transferPayloadToReceiver(sender, receiver, payload);

      const progressFill = receiver.locator(".progress-fill").first();
      await expect(progressFill).toBeVisible({ timeout: 15_000 });
      await expect
        .poll(async () => await inlineWidthPercent(progressFill))
        .toBeGreaterThan(0);

      const download = await downloadPromise;
      const downloadPath = await download.path();
      if (downloadPath === null) {
        throw new Error(
          "Service Worker download did not produce a temporary path.",
        );
      }

      const downloadedHash = await sha256File(downloadPath);
      expect(downloadedHash).toBe(expectedHash);

      await expect(receiver.getByTestId("transfer-result")).toContainText(
        `verified=true sha256=${expectedHash}`,
        { timeout: 15_000 },
      );

      await assertNoSecurityViolations(senderMonitor, receiverMonitor);
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  test("Blob fallback sink completes file transfer without CSP violations", async ({
    browser,
  }) => {
    const {
      contextA,
      contextB,
      sender,
      receiver,
      senderMonitor,
      receiverMonitor,
    } = await openMonitoredPair(browser, "blob");

    try {
      const payload = {
        name: "csp-blob-test.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("blob-csp-test-content-payload-bytes"),
      };
      const expectedHash = createHash("sha256")
        .update(payload.buffer)
        .digest("hex");

      const downloadPromise = receiver.waitForEvent("download");
      await transferPayloadToReceiver(sender, receiver, payload);

      const progressFill = receiver.locator(".progress-fill").first();
      await expect(progressFill).toBeVisible({ timeout: 15_000 });
      await expect
        .poll(async () => await inlineWidthPercent(progressFill))
        .toBeGreaterThan(0);

      const download = await downloadPromise;
      const downloadPath = await download.path();
      if (downloadPath === null) {
        throw new Error("Blob download did not produce a temporary path.");
      }

      const downloadedHash = await sha256File(downloadPath);
      expect(downloadedHash).toBe(expectedHash);

      await expect(receiver.getByTestId("transfer-result")).toContainText(
        `verified=true sha256=${expectedHash}`,
        { timeout: 15_000 },
      );

      await assertNoSecurityViolations(senderMonitor, receiverMonitor);
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });
});
