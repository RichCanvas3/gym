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

d("weight-management-mcp ingestion + trends", () => {
  it("dedupes weight_ingest_telegram_message when food already exists", async () => {
    const { SELF, env } = await import("cloudflare:test");

    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS wm_events (
        id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL,
        type TEXT NOT NULL,
        at_ms INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
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

    const scope = { telegramUserId: "6105195555" };
    const sid = "tg:6105195555";
    await env.DB.prepare(
      `INSERT INTO wm_food_entries (id, scope_id, at_ms, meal, text, calories, source, telegram_chat_id, telegram_message_id, analysis_id, image_url, created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)`,
    )
      .bind("food_existing", sid, 123, "snack", "ice cream", 200, "telegram_text", "-100", 201, "a1", "https://img.example/x.jpg", 123)
      .run();

    const out = await toolCall(SELF.fetch, "weight_ingest_telegram_message", {
      scope,
      tzName: "America/Denver",
      chatId: "-100",
      messageId: 201,
      atMs: 123,
      text: "bowl of ice cream snack",
    });

    expect(out.ok).toBe(true);
    expect(out.deduped).toBe(true);
    expect(out.kind).toBe("food");
    expect(out.foodEntryId).toBe("food_existing");
  });

  it("parses weight text without calling vision", async () => {
    const { SELF, env } = await import("cloudflare:test");

    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS wm_events (
        id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL,
        type TEXT NOT NULL,
        at_ms INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
    ).run();

    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS wm_weights (
        id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL,
        at_ms INTEGER NOT NULL,
        weight_kg REAL,
        bodyfat_pct REAL,
        notes TEXT,
        source TEXT,
        telegram_chat_id TEXT,
        telegram_message_id INTEGER,
        created_at INTEGER NOT NULL
      )`,
    ).run();

    const out = await toolCall(SELF.fetch, "weight_ingest_telegram_message", {
      scope: { telegramUserId: "6105195555" },
      tzName: "America/Denver",
      chatId: "-100",
      messageId: 300,
      atISO: "2026-03-22T12:00:00Z",
      text: "weight 182.4",
    });

    expect(out.ok).toBe(true);
    expect(out.kind).toBe("weight");
    const inner = out.result ?? {};
    expect(inner.ok).toBe(true);
    expect(typeof inner.weight_kg).toBe("number");
  });

  it("buckets trend days by timezone and returns top foods", async () => {
    const { SELF, env } = await import("cloudflare:test");
    const sid = "tg:6105195555";

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

    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS wm_food_items (
        id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL,
        food_entry_id TEXT NOT NULL,
        at_ms INTEGER NOT NULL,
        meal TEXT,
        name TEXT NOT NULL,
        portion_g REAL,
        calories REAL,
        protein_g REAL,
        carbs_g REAL,
        fat_g REAL,
        fiber_g REAL,
        source TEXT,
        created_at INTEGER NOT NULL
      )`,
    ).run();

    const at1 = Date.parse("2026-03-22T05:30:00Z"); // 23:30 previous day in Denver (MDT)
    const at2 = Date.parse("2026-03-22T15:30:00Z"); // morning in Denver
    await env.DB.prepare(
      `INSERT INTO wm_food_entries (id, scope_id, at_ms, meal, text, calories, source, image_url, created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`,
    )
      .bind("f1", sid, at1, "snack", "late snack", 100, "test", null, at1)
      .run();
    await env.DB.prepare(
      `INSERT INTO wm_food_entries (id, scope_id, at_ms, meal, text, calories, source, image_url, created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`,
    )
      .bind("f2", sid, at2, "breakfast", "eggs", 300, "test", "https://img.example/b.jpg", at2)
      .run();

    await env.DB.prepare(
      `INSERT INTO wm_food_items (id, scope_id, food_entry_id, at_ms, meal, name, calories, source, created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`,
    )
      .bind("i1", sid, "f2", at2, "breakfast", "eggs", 300, "test", at2)
      .run();

    const out = await toolCall(SELF.fetch, "weight_meal_trends", {
      scope: { telegramUserId: "6105195555" },
      tzName: "America/Denver",
      fromISO: "2026-03-21T00:00:00Z",
      toISO: "2026-03-23T00:00:00Z",
      topN: 5,
    });

    expect(out.ok).toBe(true);
    expect(Array.isArray(out.days)).toBe(true);
    const days = out.days as any[];
    // at1 should land on 2026-03-21 local in Denver, not 2026-03-22.
    expect(days.some((d) => d?.dateISO === "2026-03-21")).toBe(true);
    expect(days.some((d) => d?.dateISO === "2026-03-22")).toBe(true);
    expect(out.topFoods?.breakfast?.[0]?.name).toBe("eggs");
  });

  it("day summary includes exercise_kcal and net_calories", async () => {
    const { SELF, env } = await import("cloudflare:test");
    const sid = "tg:6105195555";

    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS wm_weights (
        id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL,
        at_ms INTEGER NOT NULL,
        weight_kg REAL,
        bodyfat_pct REAL,
        notes TEXT,
        source TEXT,
        telegram_chat_id TEXT,
        telegram_message_id INTEGER,
        created_at INTEGER NOT NULL
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
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS wm_photos (
        id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL,
        at_ms INTEGER NOT NULL,
        kind TEXT NOT NULL,
        caption TEXT,
        tags_json TEXT NOT NULL,
        telegram_chat_id TEXT,
        telegram_message_id INTEGER,
        telegram_file_id TEXT,
        telegram_file_unique_id TEXT,
        photo_url TEXT,
        created_at INTEGER NOT NULL
      )`,
    ).run();
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS wm_water_log (
        id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL,
        at_ms INTEGER NOT NULL,
        amount_ml REAL NOT NULL,
        source TEXT,
        telegram_chat_id TEXT,
        telegram_message_id INTEGER,
        created_at INTEGER NOT NULL
      )`,
    ).run();
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS wm_meal_analyses (
        id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL,
        at_ms INTEGER NOT NULL,
        model TEXT,
        summary TEXT,
        raw_json TEXT NOT NULL,
        image_ref_json TEXT,
        telegram_chat_id TEXT,
        telegram_message_id INTEGER,
        created_at INTEGER NOT NULL
      )`,
    ).run();
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS wm_daily_targets (
        scope_id TEXT PRIMARY KEY,
        targets_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    ).run();
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS wm_exercise_entries (
        id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL,
        at_ms INTEGER NOT NULL,
        source TEXT NOT NULL,
        workout_id TEXT NOT NULL,
        activity_type TEXT,
        duration_seconds INTEGER,
        distance_meters REAL,
        active_energy_kcal REAL,
        raw_json TEXT,
        created_at INTEGER NOT NULL
      )`,
    ).run();

    const day = "2026-03-22";
    const dayStart = Date.parse(`${day}T00:00:00.000Z`);
    await env.DB.prepare(
      `INSERT INTO wm_food_entries (id, scope_id, at_ms, meal, text, calories, source, created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`,
    )
      .bind("f", sid, dayStart + 1000, "lunch", "sandwich", 600, "test", dayStart + 1000)
      .run();
    await env.DB.prepare(
      `INSERT INTO wm_exercise_entries (id, scope_id, at_ms, source, workout_id, active_energy_kcal, created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7)`,
    )
      .bind("e", sid, dayStart + 2000, "strava", "strava-1", 250, dayStart + 2000)
      .run();

    const out = await toolCall(SELF.fetch, "weight_day_summary", { scope: { telegramUserId: "6105195555" }, dateISO: day });
    expect(out.ok).toBe(true);
    expect(out.totals.calories).toBe(600);
    expect(out.totals.exercise_kcal).toBe(250);
    expect(out.totals.net_calories).toBe(350);
  });
});

