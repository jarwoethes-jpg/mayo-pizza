/// <reference path="./global.d.ts" />

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import {
  type Browser,
  type BrowserContext,
  expect,
  type Page,
  test,
} from "@playwright/test";

const signalingUrl = "ws://127.0.0.1:3100/ws";
let fixtureDir: string;
let smallFile: string;
let transferFile: string;

const addBaseInitScript = async (
  context: BrowserContext,
  options: { slowSink?: boolean } = {},
): Promise<void> => {
  await context.addInitScript(
    ({ slowSink, url }) => {
      window.__MAYO_SIGNALING_URL__ = url;
      window.__MAYO_E2E__ = true;
      window.__MAYO_FORCE_RELAY__ = false;
      window.__MAYO_CORRUPT_FRAME__ = false;
      if (slowSink) {
        window.__MAYO_SINK__ = {
          strategy: "null",
          autoAccept: false,
          factory: () => ({
            strategy: "null",
            write: () =>
              new Promise<void>((resolve) => window.setTimeout(resolve, 20)),
            close: () => undefined,
            cancel: () => undefined,
          }),
        };
      }
    },
    { slowSink: options.slowSink ?? false, url: signalingUrl },
  );
};

const expectA11y = async (page: Page, state: string): Promise<void> => {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations, `${state} has axe violations`).toEqual([]);
};

const contrastAudit = async (page: Page): Promise<void> => {
  const violations = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const resolveColor = (value: string): string => {
      const probe = document.createElement("span");
      probe.style.color = value;
      document.body.append(probe);
      const resolved = getComputedStyle(probe).color;
      probe.remove();
      return resolved;
    };
    const gold = resolveColor(root.getPropertyValue("--mp-gold"));
    const purple = resolveColor(root.getPropertyValue("--mp-purple"));
    const found: string[] = [];
    for (const element of Array.from(
      document.querySelectorAll<HTMLElement>("*"),
    )) {
      const styles = getComputedStyle(element);
      if (styles.color === gold) {
        found.push(`gold text: ${element.tagName.toLowerCase()}`);
      }
      if (styles.color === purple && Number.parseFloat(styles.fontSize) < 24) {
        found.push(`small purple text: ${element.tagName.toLowerCase()}`);
      }
    }
    return found;
  });
  expect(violations).toEqual([]);
};

const openConnectedPair = async (
  browser: Browser,
  slowSink = false,
): Promise<{
  contextA: BrowserContext;
  contextB: BrowserContext;
  sender: Page;
  receiver: Page;
}> => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  await addBaseInitScript(contextA);
  await addBaseInitScript(contextB, { slowSink });
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

test.describe("mayo.pizza UI gate", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    fixtureDir = await mkdtemp(join("/tmp", "mayo-ui-"));
    smallFile = join(fixtureDir, "small-slice.txt");
    transferFile = join(fixtureDir, "transfer-slice.bin");
    await writeFile(smallFile, "a warm little slice");
    await writeFile(transferFile, Buffer.alloc(2 * 1024 * 1024, 7));
    await mkdir(join(process.cwd(), "test-results", "ui-matrix"), {
      recursive: true,
    });
  });

  test.afterAll(async () => {
    await rm(fixtureDir, { recursive: true, force: true });
  });

  test("has zero axe violations on the uploader idle view", async ({
    page,
    browserName,
  }) => {
    test.skip(
      browserName !== "chromium",
      "UI rendering gate is Chromium-only.",
    );
    await addBaseInitScript(page.context());
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Send a slice" }),
    ).toBeVisible();
    await expectA11y(page, "uploader idle");
    await contrastAudit(page);
  });

  test("has zero axe violations on the privacy and terms routes", async ({
    page,
    browserName,
  }) => {
    test.skip(
      browserName !== "chromium",
      "UI rendering gate is Chromium-only.",
    );
    await addBaseInitScript(page.context());
    for (const route of ["/privacy", "/terms"]) {
      await page.goto(route);
      await expect(page.getByRole("heading")).toBeVisible();
      await expectA11y(page, route);
      await contrastAudit(page);
    }
  });

  test("has zero axe violations on the uploader staged view", async ({
    page,
    browserName,
  }) => {
    test.skip(
      browserName !== "chromium",
      "UI rendering gate is Chromium-only.",
    );
    await addBaseInitScript(page.context());
    await page.goto("/");
    await page.getByTestId("file-input").setInputFiles(smallFile);
    await expect(page.locator(".staged-card")).toBeVisible();
    await expectA11y(page, "uploader staged");
    await contrastAudit(page);
  });

  test("has zero axe violations on the receiver manifest view", async ({
    browser,
    browserName,
  }) => {
    test.skip(
      browserName !== "chromium",
      "UI rendering gate is Chromium-only.",
    );
    const pair = await openConnectedPair(browser);
    try {
      await pair.sender.getByTestId("file-input").setInputFiles(smallFile);
      await expect(pair.receiver.getByTestId("manifest-preview")).toBeVisible({
        timeout: 15_000,
      });
      await expectA11y(pair.receiver, "receiver manifest");
      await contrastAudit(pair.receiver);
    } finally {
      await pair.contextA.close();
      await pair.contextB.close();
    }
  });

  test("has zero axe violations during transfer and after completion", async ({
    browser,
    browserName,
  }) => {
    test.skip(
      browserName !== "chromium",
      "UI rendering gate is Chromium-only.",
    );
    const pair = await openConnectedPair(browser, true);
    try {
      await pair.sender.getByTestId("file-input").setInputFiles(transferFile);
      await expect(pair.receiver.getByTestId("accept-transfer")).toBeVisible({
        timeout: 15_000,
      });
      await pair.receiver.getByTestId("accept-transfer").click();
      await expect(pair.receiver.getByTestId("progress")).toContainText(
        "bytes",
        {
          timeout: 15_000,
        },
      );
      await expectA11y(pair.receiver, "transfer in progress");
      await contrastAudit(pair.receiver);
      await expect(pair.receiver.getByTestId("transfer-result")).toContainText(
        "verified=true",
        { timeout: 120_000 },
      );
      await expectA11y(pair.receiver, "transfer complete");
      await contrastAudit(pair.receiver);
    } finally {
      await pair.contextA.close();
      await pair.contextB.close();
    }
  });

  test("keeps the file picker and receive CTA on the keyboard path", async ({
    page,
    browser,
    browserName,
  }) => {
    test.setTimeout(90_000);
    test.skip(
      browserName !== "chromium",
      "UI rendering gate is Chromium-only.",
    );
    await addBaseInitScript(page.context());
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Send a slice" }),
    ).toBeFocused();
    await page.keyboard.press("Tab");
    const picker = page.getByTestId("file-picker-label");
    await expect(picker).toBeFocused();
    await page.evaluate(() => {
      document
        .querySelector<HTMLInputElement>('[data-testid="file-input"]')
        ?.addEventListener("click", () => {
          document.body.dataset.mayoPickerClicked = "true";
        });
    });
    const chooser = page.waitForEvent("filechooser");
    await picker.press("Enter");
    await chooser;
    await expect
      .poll(() => page.evaluate(() => document.body.dataset.mayoPickerClicked))
      .toBe("true");
    await page.keyboard.press("Tab");
    await expect(page.getByText("Choose folder")).toBeFocused();
    await page.getByTestId("file-input").setInputFiles(smallFile);
    await expect(
      page.getByRole("heading", { name: "Send a slice" }),
    ).toBeFocused();
    await expect(
      page.getByRole("button", { name: "Copy room link" }),
    ).toBeVisible({
      timeout: 15_000,
    });
    await page.getByRole("button", { name: "Copy room link" }).focus();
    await expect(
      page.getByRole("button", { name: "Copy room link" }),
    ).toBeFocused();

    const pair = await openConnectedPair(browser, true);
    try {
      await pair.sender.getByTestId("file-input").setInputFiles(smallFile);
      await expect(pair.receiver.getByTestId("accept-transfer")).toBeVisible({
        timeout: 15_000,
      });
      await pair.receiver.getByTestId("accept-transfer").focus();
      await expect(pair.receiver.getByTestId("accept-transfer")).toBeFocused();
      await pair.receiver.keyboard.press("Enter");
      await expect(pair.receiver.getByTestId("transfer-result")).toContainText(
        "verified=true",
        { timeout: 30_000 },
      );
    } finally {
      await pair.contextA.close();
      await pair.contextB.close();
    }
  });

  test("renders the screenshot matrix without horizontal overflow", async ({
    page,
    browserName,
  }, testInfo) => {
    test.skip(
      browserName !== "chromium",
      "UI rendering gate is Chromium-only.",
    );
    await addBaseInitScript(page.context());
    const widths = [320, 768, 1440, 2560];
    const schemes = ["light", "dark"] as const;
    for (const scheme of schemes) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const width of widths) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto("/");
        await expect(
          page.getByRole("heading", { name: "Send a slice" }),
        ).toBeVisible();
        await expect
          .poll(() =>
            page.evaluate(
              () => document.documentElement.scrollWidth <= window.innerWidth,
            ),
          )
          .toBe(true);
        await page.screenshot({
          path: join(
            testInfo.project.outputDir,
            "ui-matrix",
            `idle-${scheme}-${width}.png`,
          ),
          fullPage: true,
        });
        await page.getByTestId("file-input").setInputFiles(smallFile);
        await expect(page.locator(".staged-card")).toBeVisible();
        await expect
          .poll(() =>
            page.evaluate(
              () => document.documentElement.scrollWidth <= window.innerWidth,
            ),
          )
          .toBe(true);
        await page.screenshot({
          path: join(
            testInfo.project.outputDir,
            "ui-matrix",
            `staged-${scheme}-${width}.png`,
          ),
          fullPage: true,
        });
      }
    }
  });

  test("uses the olive surface and cream text in dark mode", async ({
    page,
    browserName,
  }) => {
    test.skip(
      browserName !== "chromium",
      "UI rendering gate is Chromium-only.",
    );
    await addBaseInitScript(page.context());
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/");
    const colors = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const resolveColor = (
        value: string,
        property: "backgroundColor" | "color",
      ): string => {
        const probe = document.createElement("span");
        probe.style[property] = value;
        document.body.append(probe);
        const resolved = getComputedStyle(probe)[property];
        probe.remove();
        return resolved;
      };
      return {
        bodyBackground: getComputedStyle(document.body).backgroundColor,
        bodyText: getComputedStyle(document.body).color,
        olive: resolveColor(
          root.getPropertyValue("--mp-olive"),
          "backgroundColor",
        ),
        cream: resolveColor(root.getPropertyValue("--mp-cream"), "color"),
      };
    });
    expect(colors.bodyBackground).toBe(colors.olive);
    expect(colors.bodyText).toBe(colors.cream);
  });
});
