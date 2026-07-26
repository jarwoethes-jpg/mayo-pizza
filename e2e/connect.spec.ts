import { expect, test } from "@playwright/test";

test("connects two browser contexts and completes ctrl ping/pong", async ({
  browser,
}) => {
  const signalingUrl = "ws://127.0.0.1:3100/ws";
  const forceRelay = process.env.MAYO_FORCE_RELAY === "1";
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
