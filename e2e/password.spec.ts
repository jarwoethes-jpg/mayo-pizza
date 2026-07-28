import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const signalingUrl = "ws://127.0.0.1:3100/ws";

const expectA11y = async (
  page: import("@playwright/test").Page,
  state: string,
): Promise<void> => {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations, `${state} has axe violations`).toEqual([]);
};

const addPasswordInitScript = async (
  context: import("@playwright/test").BrowserContext,
): Promise<void> => {
  await context.addInitScript(
    ({ url }) => {
      window.__MAYO_SIGNALING_URL__ = url;
      window.__MAYO_E2E__ = true;
      window.__MAYO_SINK__ = { strategy: "null", autoAccept: false };
    },
    { url: signalingUrl },
  );
};

const createProtectedRoom = async (
  browser: import("@playwright/test").Browser,
  password: string,
): Promise<{
  senderContext: import("@playwright/test").BrowserContext;
  receiverContext: import("@playwright/test").BrowserContext;
  sender: import("@playwright/test").Page;
  receiver: import("@playwright/test").Page;
  slug: string;
}> => {
  const senderContext = await browser.newContext();
  const receiverContext = await browser.newContext();
  await addPasswordInitScript(senderContext);
  await addPasswordInitScript(receiverContext);
  const sender = await senderContext.newPage();
  await sender.goto("/");
  const initialSlug = (await sender.getByTestId("slug").textContent())?.trim();
  if (initialSlug === undefined || initialSlug === "") {
    throw new Error("The password sender did not render a room slug.");
  }
  await sender.getByTestId("password-panel").locator("summary").click();
  await sender.getByTestId("password-input").fill(password);
  await sender.getByTestId("password-commit").click();
  await expect(sender.getByTestId("slug")).not.toHaveText(initialSlug, {
    timeout: 15_000,
  });
  const slug = (await sender.getByTestId("slug").textContent())?.trim();
  if (slug === undefined || slug === "") {
    throw new Error("The protected room did not render its replacement slug.");
  }
  const receiver = await receiverContext.newPage();
  await receiver.goto(`/${encodeURIComponent(slug)}`);
  await expect(receiver.getByTestId("password-prompt")).toBeVisible({
    timeout: 15_000,
  });
  await expectA11y(receiver, "password prompt");
  return { senderContext, receiverContext, sender, receiver, slug };
};

test.describe("password rooms", () => {
  test.describe.configure({ mode: "serial" });

  test("prompts before the manifest and transfers after the right password", async ({
    browser,
    browserName,
  }) => {
    test.skip(
      browserName !== "chromium",
      "Password flow gate is Chromium-only.",
    );
    const room = await createProtectedRoom(browser, "secret-crust");
    try {
      await room.sender.getByTestId("file-input").setInputFiles({
        name: "secret.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("a private slice"),
      });
      await expect(room.receiver.locator("body")).not.toContainText(
        "secret.txt",
      );
      await expect(room.receiver.getByTestId("manifest-preview")).toBeHidden();

      await room.receiver.getByTestId("password-input").fill("secret-crust");
      await room.receiver.getByTestId("password-input").press("Enter");
      await expect(room.receiver.getByTestId("manifest-preview")).toBeVisible({
        timeout: 15_000,
      });
      await room.receiver.getByTestId("accept-transfer").click();
      await expect(room.receiver.getByTestId("transfer-result")).toContainText(
        "verified=true",
        { timeout: 30_000 },
      );

      await expect(room.sender.url()).not.toContain("password");
      await expect(room.sender.locator(".room-link__value")).not.toContainText(
        "password",
      );
      // E2E serves from 127.0.0.1:5173, so the production domain is absent; the room slug is stable.
      await expect(
        room.sender.locator("svg").getAttribute("aria-label"),
      ).resolves.toContain(room.slug);
      await expect(
        room.sender.locator("svg").getAttribute("aria-label"),
      ).resolves.not.toContain("password");
    } finally {
      await room.senderContext.close();
      await room.receiverContext.close();
    }
  });

  test("locks after five submitted wrong passwords", async ({
    browser,
    browserName,
  }) => {
    test.skip(
      browserName !== "chromium",
      "Password flow gate is Chromium-only.",
    );
    const room = await createProtectedRoom(browser, "secret-crust");
    try {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await room.receiver
          .getByTestId("password-input")
          .fill(`wrong-${attempt}`);
        await room.receiver.getByTestId("password-submit").click();
        if (attempt < 4) {
          await expect(
            room.receiver.getByTestId("password-prompt"),
          ).toContainText(`${4 - attempt}`);
        }
      }
      await expect(room.receiver.getByTestId("password-prompt")).toContainText(
        /fresh room/i,
      );
      await expect(room.receiver.getByTestId("password-submit")).toHaveCount(0);
      await expectA11y(room.receiver, "password locked");

      await room.receiver.reload();
      await expect(room.receiver.getByTestId("password-prompt")).toContainText(
        /fresh room/i,
        { timeout: 15_000 },
      );
      await expect(room.receiver.getByTestId("password-submit")).toHaveCount(0);
      await expectA11y(room.receiver, "password locked after reload");
    } finally {
      await room.senderContext.close();
      await room.receiverContext.close();
    }
  });
});
