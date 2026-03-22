import { describe, expect, it } from "vitest";

const d = process.env.CF_WORKERS === "1" ? describe : describe.skip;

async function readSseJson(res: Response): Promise<any> {
  const txt = await res.text();
  const m = txt.match(/data: (.+)\n/);
  if (!m) throw new Error(`Unexpected response: ${txt.slice(0, 200)}`);
  return JSON.parse(m[1]);
}

async function toolCall(selfFetch: typeof fetch, name: string, args: Record<string, unknown>) {
  const res = await selfFetch("http://example.com/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const msg = await readSseJson(res);
  const text = msg?.result?.content?.[0]?.text;
  return typeof text === "string" ? JSON.parse(text) : msg;
}

d("weight-management-mcp", () => {
  it("dedupes weight_log_meal_from_text by telegram sourceRef", async () => {
    const { SELF, env } = await import("cloudflare:test");

    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS wm_profiles (
        scope_id TEXT PRIMARY KEY,
        scope_json TEXT,
        profile_json TEXT,
        updated_at INTEGER
      )`,
    ).run();

    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS wm_meal_analyses (
        id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL,
        at_ms INTEGER NOT NULL,
        model TEXT,
        summary TEXT,
        raw_json TEXT,
        image_ref_json TEXT,
        telegram_chat_id TEXT,
        telegram_message_id INTEGER,
        created_at INTEGER
      )`,
    ).run();

    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS wm_food_entries (
        id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL,
        at_ms INTEGER NOT NULL,
        meal TEXT,
        text TEXT,
        calories REAL,
        protein_g REAL,
        carbs_g REAL,
        fat_g REAL,
        fiber_g REAL,
        sugar_g REAL,
        sodium_mg REAL,
        source TEXT,
        telegram_chat_id TEXT,
        telegram_message_id INTEGER,
        analysis_id TEXT,
        image_url TEXT,
        created_at INTEGER
      )`,
    ).run();

    const scope = { accountAddress: "acct_cust_casey" };
    const profile = await toolCall(SELF.fetch, "weight_profile_upsert", { scope, profile: {} });
    const sid = profile?.scope_id;
    expect(typeof sid).toBe("string");

    await env.DB.prepare(
      `INSERT INTO wm_food_entries (id, scope_id, at_ms, meal, text, calories, source, telegram_chat_id, telegram_message_id, analysis_id, created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`,
    )
      .bind(
        "food_existing",
        sid,
        123,
        "breakfast",
        "existing meal",
        500,
        "meal_text",
        "chat1",
        101,
        "analysis_existing",
        123,
      )
      .run();

    const out = await toolCall(SELF.fetch, "weight_log_meal_from_text", {
      scope,
      text: "Breakfast: 2 eggs",
      atISO: "2026-03-20T15:00:00Z",
      tzName: "America/Denver",
      sourceRef: { chatId: "chat1", messageId: 101 },
    });

    expect(out.ok).toBe(true);
    expect(out.deduped).toBe(true);
    expect(out.foodEntryId).toBe("food_existing");
    expect(out.analysisId).toBe("analysis_existing");
  });
});

