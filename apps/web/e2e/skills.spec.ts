import { test, expect } from "@playwright/test";

test("skills panel loads capabilities", async ({ page }) => {
  await page.goto("/chat");
  await page.getByRole("button", { name: "Skills" }).click();
  await expect(page.getByText("Exercise (Strava)")).toBeVisible();
  await expect(page.getByText("Weight + meals")).toBeVisible();
});

