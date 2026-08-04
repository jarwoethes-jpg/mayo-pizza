import { expect, test } from "@playwright/test";
import { signalingUrl } from "./target";

test("waits for the sender after the sender closes their page", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const senderContext = await browser.newContext();
  const receiverContext = await browser.newContext();

  const configureContext = async (
    context: import("@playwright/test").BrowserContext,
  ): Promise<void> => {
    await context.addInitScript(
      ({ url }) => {
        window.__MAYO_SIGNALING_URL__ = url;
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

    await sender.close();
    await expect(receiver.getByTestId("connection-state")).toHaveText(
      "connecting",
      { timeout: 10_000 },
    );
    await expect(receiver.getByTestId("session-status")).toHaveText(
      "reconnecting",
      { timeout: 10_000 },
    );
    await receiver.waitForTimeout(60_000);
    await expect(receiver.getByTestId("session-status")).not.toHaveText(
      "failed",
    );
    await expect(receiver.getByTestId("log")).not.toHaveText(
      "Slice dropped. We couldn’t recover the connection.",
    );
  } finally {
    await senderContext.close();
    await receiverContext.close();
  }
});
