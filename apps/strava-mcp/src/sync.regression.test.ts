import { describe, expect, it, vi } from "vitest";

const d = process.env.CF_WORKERS === "1" ? describe : describe.skip;

async function readMcpResult(res: Response): Promise<any> {
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return await res.json();
  const txt = await res.text();
  const m = txt.match(/data: (.+)\n/);
  if (!m) throw new Error(`Unexpected MCP response: ${txt.slice(0, 200)}`);
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
  const msg = await readMcpResult(res);
  const text = msg?.result?.content?.[0]?.text;
  return typeof text === "string" ? JSON.parse(text) : msg;
}

d("strava-mcp", () => {
  it("syncs activities into workouts table", async () => {
    const { SELF, env } = await import("cloudflare:test");

    env.STRAVA_CLIENT_ID = "1";
    env.STRAVA_CLIENT_SECRET = "2";
    env.STRAVA_REFRESH_TOKEN = "3";

    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS workouts (
        workout_id TEXT PRIMARY KEY,
        source TEXT,
        device TEXT,
        event_type TEXT,
        activity_type TEXT,
        started_at_iso TEXT,
        ended_at_iso TEXT,
        duration_seconds INTEGER,
        distance_meters REAL,
        active_energy_kcal REAL,
        metadata_json TEXT,
        created_at_iso TEXT
      )`,
    ).run();
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS strava_sync_state (
        id INTEGER PRIMARY KEY,
        last_sync_at_iso TEXT
      )`,
    ).run();

    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input?.url;
      if (typeof url === "string" && url.includes("https://www.strava.com/oauth/token")) {
        return new Response(JSON.stringify({ access_token: "tok" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (typeof url === "string" && url.includes("https://www.strava.com/api/v3/athlete/activities")) {
        return new Response(
          JSON.stringify([
            {
              id: 123,
              type: "Run",
              start_date: "2026-03-20T15:00:00Z",
              elapsed_time: 3000,
              distance: 10000,
              kilojoules: 1000,
              name: "Test Run",
            },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return originalFetch(input, init);
    });

    try {
      const sync = await toolCall(SELF.fetch, "strava_sync", { lookbackDays: 30 });
      expect(sync.ok).toBe(true);
      expect(sync.inserted).toBe(1);

      const listed = await toolCall(SELF.fetch, "strava_list_workouts", { limit: 10 });
      expect(Array.isArray(listed.workouts)).toBe(true);
      expect(listed.workouts.length).toBe(1);
      expect(listed.workouts[0].workout_id).toBe("strava-123");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

