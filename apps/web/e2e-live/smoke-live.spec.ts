import { test, expect } from "@playwright/test";

function looksLikeError(s: string) {
  const t = (s || "").toLowerCase();
  return (
    t.includes("missing langgraph_deployment_url") ||
    t.includes("missing langsmith_api_key") ||
    t.includes("request failed") ||
    t.includes("unauthorized") ||
    t.includes("error:")
  );
}

test("live: chat meals past week returns non-error", async ({ page }) => {
  await page.goto("/chat");
  const input = page.getByPlaceholder("Ask a question…");
  await expect(input).toBeEditable();
  await input.fill("what have i eaten in past week");
  const send = page.getByRole("button", { name: "Send" });
  await expect(send).toBeEnabled();
  await send.click();

  // We can't assert exact phrasing; assert we got an assistant message that isn't an obvious config error.
  const lastAssistant = page.locator("main >> text=/./").last();
  await expect(lastAssistant).toBeVisible();
  const text = (await lastAssistant.textContent()) || "";
  expect(looksLikeError(text)).toBe(false);
});

test("live: chat workouts past few days returns non-error", async ({ page }) => {
  await page.goto("/chat");
  const input = page.getByPlaceholder("Ask a question…");
  await expect(input).toBeEditable();
  await input.fill("what exercises have i done in past few days");
  const send = page.getByRole("button", { name: "Send" });
  await expect(send).toBeEnabled();
  await send.click();

  const lastAssistant = page.locator("main >> text=/./").last();
  await expect(lastAssistant).toBeVisible();
  const text = (await lastAssistant.textContent()) || "";
  expect(looksLikeError(text)).toBe(false);
});

