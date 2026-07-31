/// <reference path="./global.d.ts" />

import { execFile as execFileCallback, spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";

const execFile = promisify(execFileCallback);
const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const SERVER_DIR = join(REPO_ROOT, "packages/server");
const SERVER_ENTRY = join(SERVER_DIR, "dist/index.js");
const DEDICATED_SERVER_PORT = 3_101;
const ROOM_TTL_MS = 5_000;
const ROOM_REAPER_INTERVAL_MS = 60_000;
const EXPIRY_ASSERTION_WAIT_MS = ROOM_TTL_MS + ROOM_REAPER_INTERVAL_MS + 25_000;
const HEARTBEAT_DISABLED_INTERVAL_MS = 2 * EXPIRY_ASSERTION_WAIT_MS;
const HEARTBEAT_INTERVAL_MS = 2_000;
const SLUG_ASSERTION_INTERVAL_MS = 1_000;
const TEST_TIMEOUT_MS = 150_000;
const HEALTHCHECK_TIMEOUT_MS = 120_000;
const STALE_LINK_COPY = "That link has gone stale.";

let expiryServer: ReturnType<typeof spawn> | undefined;

const delay = (durationMs: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });

const ensureServerBuild = async (): Promise<void> => {
  try {
    await access(SERVER_ENTRY);
    return;
  } catch {
    // The shared Playwright webServer normally builds this artifact first.
  }

  try {
    await execFile("pnpm", ["--filter", "server", "build"], {
      cwd: REPO_ROOT,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`The dedicated signaling server build failed: ${message}`);
  }

  try {
    await access(SERVER_ENTRY);
  } catch {
    throw new Error(
      `The dedicated signaling server build completed without creating ${SERVER_ENTRY}.`,
    );
  }
};

const describeServerOutput = (output: readonly string[]): string => {
  const text = output.join("").trim();
  return text === "" ? "" : `\nServer output:\n${text}`;
};

const waitForHealthz = async (
  server: ReturnType<typeof spawn>,
  port: number,
  output: readonly string[],
  startupError: () => Error | undefined,
): Promise<void> => {
  const deadline = Date.now() + HEALTHCHECK_TIMEOUT_MS;
  let lastFailure = "no response";
  while (Date.now() < deadline) {
    const error = startupError();
    if (error !== undefined) {
      throw new Error(
        `The dedicated signaling server failed to start: ${error.message}${describeServerOutput(output)}`,
      );
    }
    if (server.exitCode !== null) {
      throw new Error(
        `The dedicated signaling server exited with code ${server.exitCode}.${describeServerOutput(output)}`,
      );
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) {
        return;
      }
      lastFailure = `HTTP ${response.status}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    await delay(100);
  }
  throw new Error(
    `The dedicated signaling server did not become healthy: ${lastFailure}${describeServerOutput(output)}`,
  );
};

const stopServer = async (server: ReturnType<typeof spawn>): Promise<void> => {
  if (server.exitCode !== null || server.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolve) => {
    const forceKillTimer = setTimeout(() => {
      server.kill("SIGKILL");
      resolve();
    }, 5_000);
    server.once("exit", () => {
      clearTimeout(forceKillTimer);
      resolve();
    });
    server.kill("SIGTERM");
  });
};

const startDedicatedServer = async (): Promise<void> => {
  await ensureServerBuild();
  const output: string[] = [];
  const server = spawn(process.execPath, ["dist/index.js"], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(DEDICATED_SERVER_PORT),
      HOST: "127.0.0.1",
      ROOM_TTL_MS: String(ROOM_TTL_MS),
      TURN_STATIC_SECRET: "playwright-turn-secret",
      STUN_HOST: "127.0.0.1",
      TURN_HOST: "127.0.0.1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  server.stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  let processError: Error | undefined;
  server.once("error", (error) => {
    processError = error;
  });
  expiryServer = server;
  try {
    await waitForHealthz(
      server,
      DEDICATED_SERVER_PORT,
      output,
      () => processError,
    );
  } catch (error) {
    await stopServer(server);
    expiryServer = undefined;
    const message = error instanceof Error ? error.message : String(error);
    const startupOutput = output.join("");
    if (
      /EADDR(?:INUSE|NOTAVAIL)|EACCES|EPERM|address already in use/i.test(
        `${message}\n${startupOutput}`,
      )
    ) {
      throw new Error(
        `The dedicated signaling server could not bind to 127.0.0.1:${DEDICATED_SERVER_PORT}. ` +
          `Port ${DEDICATED_SERVER_PORT} must match the preview CSP allowlist in ` +
          `infra/header-source.mjs.${describeServerOutput(output)}`,
      );
    }
    throw error;
  }
};

const addExpiryInitScript = async (
  context: BrowserContext,
  heartbeatIntervalMs: number,
): Promise<void> => {
  await context.addInitScript(
    ({ heartbeatInterval, signalingUrl, staleCopy }) => {
      window.__MAYO_SIGNALING_URL__ = signalingUrl;
      window.__MAYO_HEARTBEAT_INTERVAL_MS__ = heartbeatInterval;
      window.__MAYO_E2E__ = true;

      const markStaleLink = (): void => {
        document.documentElement.dataset.mayoStaleLinkSeen = "true";
      };
      const containsStaleCopy = (node: Node): boolean =>
        (node.textContent ?? "").includes(staleCopy);
      const observer = new MutationObserver((records) => {
        if (
          records.some(
            (record) =>
              (record.type === "characterData" &&
                containsStaleCopy(record.target)) ||
              Array.from(record.addedNodes).some(containsStaleCopy),
          )
        ) {
          markStaleLink();
        }
      });
      observer.observe(document, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      if (containsStaleCopy(document)) {
        markStaleLink();
      }
    },
    {
      heartbeatInterval: heartbeatIntervalMs,
      signalingUrl: `ws://127.0.0.1:${DEDICATED_SERVER_PORT}/ws`,
      staleCopy: STALE_LINK_COPY,
    },
  );
};

const readInitialSlug = async (page: Page): Promise<string> => {
  const slug = page.getByTestId("slug");
  await expect(slug).toHaveText(/\S+/, { timeout: 15_000 });
  const value = (await slug.textContent())?.trim();
  if (value === undefined || value === "") {
    throw new Error("The expiry gate did not render an initial room slug.");
  }
  return value;
};

const closeContext = async (context: BrowserContext): Promise<void> => {
  await context.close();
};

test.describe("room expiry", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    await startDedicatedServer();
  });

  test.afterAll(async () => {
    const server = expiryServer;
    expiryServer = undefined;
    if (server !== undefined) {
      await stopServer(server);
    }
  });

  test("heartbeat keeps an uploader room alive beyond its TTL", async ({
    browser,
    browserName,
  }) => {
    test.skip(
      browserName !== "chromium",
      "Room expiry is a Chromium-only gate.",
    );
    test.setTimeout(TEST_TIMEOUT_MS);
    const context = await browser.newContext();
    try {
      await addExpiryInitScript(context, HEARTBEAT_INTERVAL_MS);
      const page = await context.newPage();
      await page.goto("/");
      const initialSlug = await readInitialSlug(page);
      const expiryDeadline = Date.now() + EXPIRY_ASSERTION_WAIT_MS;

      while (Date.now() < expiryDeadline) {
        const currentSlug = (
          await page.getByTestId("slug").textContent()
        )?.trim();
        expect(
          currentSlug,
          `The uploader room slug changed before expiry: expected ${initialSlug}, got ${currentSlug ?? "<missing>"}.`,
        ).toBe(initialSlug);
        await delay(
          Math.min(SLUG_ASSERTION_INTERVAL_MS, expiryDeadline - Date.now()),
        );
      }

      await expect(page.getByTestId("slug")).toHaveText(initialSlug, {
        timeout: 5_000,
      });
      await expect(page.getByTestId("session-status")).not.toHaveText(
        "failed",
        {
          timeout: 5_000,
        },
      );
      await expect(page.getByText(STALE_LINK_COPY, { exact: true })).toBeHidden(
        { timeout: 5_000 },
      );
    } finally {
      await closeContext(context);
    }
  });

  test("an expired uploader room is silently re-minted", async ({
    browser,
    browserName,
  }) => {
    test.skip(
      browserName !== "chromium",
      "Room expiry is a Chromium-only gate.",
    );
    test.setTimeout(TEST_TIMEOUT_MS);
    const context = await browser.newContext();
    try {
      await addExpiryInitScript(context, HEARTBEAT_DISABLED_INTERVAL_MS);
      const page = await context.newPage();
      await page.goto("/");
      const initialSlug = await readInitialSlug(page);
      const staleCopy = page.getByText(STALE_LINK_COPY, { exact: true });

      await expect
        .poll(
          async () => (await page.getByTestId("slug").textContent())?.trim(),
          {
            timeout: EXPIRY_ASSERTION_WAIT_MS + 15_000,
            intervals: [SLUG_ASSERTION_INTERVAL_MS],
          },
        )
        .not.toBe(initialSlug);

      const remintedSlug = (
        await page.getByTestId("slug").textContent()
      )?.trim();
      expect(remintedSlug).toBeTruthy();
      expect(remintedSlug).not.toBe(initialSlug);
      expect(
        await page.evaluate(
          () => document.documentElement.dataset.mayoStaleLinkSeen,
        ),
      ).toBeUndefined();
      await expect(staleCopy).toBeHidden({ timeout: 5_000 });
      await expect(page.getByTestId("session-status")).not.toHaveText(
        "failed",
        {
          timeout: 5_000,
        },
      );
    } finally {
      await closeContext(context);
    }
  });
});
