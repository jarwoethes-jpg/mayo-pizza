import { expect, test } from "@playwright/test";
import { isRemoteTarget, signalingUrl } from "./target";

test("connects two browser contexts and completes ctrl ping/pong", async ({
  browser,
}) => {
  const forceRelay = process.env.MAYO_FORCE_RELAY === "1";
  test.skip(
    isRemoteTarget && forceRelay,
    "The forced-relay test needs the local coturn.",
  );
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();

  await contextA.addInitScript(
    ({ forceRelay: shouldForceRelay, signalingUrl: url }) => {
      window.__MAYO_SIGNALING_URL__ = url;
      window.__MAYO_FORCE_RELAY__ = shouldForceRelay;
    },
    { forceRelay, signalingUrl },
  );
  await contextB.addInitScript(
    ({ forceRelay: shouldForceRelay, signalingUrl: url }) => {
      window.__MAYO_SIGNALING_URL__ = url;
      window.__MAYO_FORCE_RELAY__ = shouldForceRelay;
    },
    { forceRelay, signalingUrl },
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

    await Promise.all([
      expect(sender.getByTestId("connection-state")).toHaveText("connected", {
        timeout: 15_000,
      }),
      expect(receiver.getByTestId("connection-state")).toHaveText("connected", {
        timeout: 15_000,
      }),
    ]);

    await expect(sender.getByTestId("ping")).toBeEnabled({ timeout: 5_000 });
    const previousPong = await sender.getByTestId("last-pong").textContent();
    const startedAt = Date.now();
    await sender.getByTestId("ping").click();
    await expect(sender.getByTestId("last-pong")).not.toHaveText(
      previousPong ?? "—",
      {
        timeout: 5_000,
      },
    );
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  } finally {
    await contextA.close();
    await contextB.close();
  }
});

test("shows a manifest when the file is picked before the receiver opens the link", async ({
  browser,
  browserName,
}) => {
  test.setTimeout(45_000);
  test.skip(
    browserName !== "chromium",
    "The ordering regression is Chromium-only.",
  );

  const senderContext = await browser.newContext();
  const receiverContext = await browser.newContext();
  const configureContext = async (
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

  await configureContext(senderContext);
  await configureContext(receiverContext);

  try {
    const sender = await senderContext.newPage();
    await sender.goto("/");
    const slug = (await sender.getByTestId("slug").textContent())?.trim();
    if (slug === undefined || slug === "") {
      throw new Error("The sender did not render a room slug.");
    }

    await sender.getByTestId("file-input").setInputFiles({
      name: "secret.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("a private slice"),
    });

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
    await expect(receiver.getByTestId("manifest-preview")).toBeVisible({
      timeout: 15_000,
    });
  } finally {
    await senderContext.close();
    await receiverContext.close();
  }
});
