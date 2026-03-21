import { test, expect } from "@playwright/test";

test("calendar week loads via agent", async ({ page }) => {
  await page.goto("/calendar");
  await expect(page.getByText("Class calendar")).toBeVisible();
  await expect(page.getByText("Pickleball (drop-in)")).toBeVisible();
});

