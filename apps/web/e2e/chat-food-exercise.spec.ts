import { test, expect } from "@playwright/test";

test("chat: meals past week", async ({ page }) => {
  await page.goto("/chat");
  const input = page.getByPlaceholder("Ask a question…");
  await expect(input).toBeEditable();
  await input.fill("what have i eaten in past week");
  const send = page.getByRole("button", { name: "Send" });
  await expect(send).toBeEnabled();
  await send.click();
  await expect(page.getByText("Meals for the past 7 days")).toBeVisible();
});

test("chat: workouts past few days", async ({ page }) => {
  await page.goto("/chat");
  const input = page.getByPlaceholder("Ask a question…");
  await expect(input).toBeEditable();
  await input.fill("what exercises have i done in past few days");
  const send = page.getByRole("button", { name: "Send" });
  await expect(send).toBeEnabled();
  await send.click();
  await expect(page.getByText("Workouts (last 3 days)")).toBeVisible();
});

