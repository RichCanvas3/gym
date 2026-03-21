import { test, expect } from "@playwright/test";

test("chat cartActions navigates to cart and adds item", async ({ page }) => {
  await page.goto("/chat");
  await page.getByPlaceholder("Ask a question…").fill("add day pass to cart");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page).toHaveURL(/\/cart$/);
  await expect(page.getByText("DAY_PASS")).toBeVisible();
});

