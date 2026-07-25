import { expect, test } from "@playwright/test";

test("renders the wordmark", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByText("mayo.pizza")).toBeVisible();
});
