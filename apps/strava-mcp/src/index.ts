import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export type Env = {
  MCP_API_KEY?: string;
  DB: D1Database;
  STRAVA_CLIENT_ID?: string;
  STRAVA_CLIENT_SECRET?: string;
  STRAVA_REFRESH_TOKEN?: string;
};

function nowISO() {
  return new Date().toISOString();
}

function jsonText(obj: unknown) {
  return JSON.stringify(obj, null, 2);
}

async function requireApiKey(request: Request, env: Env) {
  const want = (env.MCP_API_KEY ?? "").trim();
  if (!want) return;
  const got = (request.headers.get("x-api-key") ?? "").trim();
  if (got !== want) throw new Error("Unauthorized (bad x-api-key)");
}

type StravaActivity = {
  id: number;
  type: string;
  sport_type?: string;
  start_date: string;
  elapsed_time: number;
  distance?: number;
  kilojoules?: number | null;
  name?: string;
};

async function getStravaAccessToken(env: Env): Promise<string> {
  const clientId = (env.STRAVA_CLIENT_ID ?? "").trim();
  const clientSecret = (env.STRAVA_CLIENT_SECRET ?? "").trim();
  const refreshToken = (env.STRAVA_REFRESH_TOKEN ?? "").trim();
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Missing STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET / STRAVA_REFRESH_TOKEN");
  }
  const res = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; message?: string };
  if (!res.ok || !data.access_token) {
    throw new Error(data.message ?? `Strava token failed: ${res.status}`);
  }
  return data.access_token;
}

async function fetchStravaActivities(accessToken: string, afterUnix: number): Promise<StravaActivity[]> {
  const url = `https://www.strava.com/api/v3/athlete/activities?after=${afterUnix}&per_page=100`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = (await res.json().catch(() => null)) as StravaActivity[] | { message?: string; errors?: unknown };
  if (!Array.isArray(data)) {
    const msg =
      typeof data === "object" && data !== null && "message" in data
        ? String((data as { message?: string }).message)
        : res.statusText;
    const detail =
      typeof data === "object" && data !== null && "errors" in data
        ? ` ${JSON.stringify((data as { errors?: unknown }).errors)}`
        : "";
    throw new Error(
      `Strava activities: ${msg}${detail}. If you see activity:read_permission, re-authorize with scope activity:read_all and update STRAVA_REFRESH_TOKEN.`,
    );
  }
  if (!res.ok) throw new Error(`Strava activities HTTP ${res.status}`);
  return data;
}

function stravaActivityToWorkoutRow(a: StravaActivity) {
  const startedAt = a.start_date ?? "";
  const elapsed = typeof a.elapsed_time === "number" ? a.elapsed_time : 0;
  const endDate = startedAt ? new Date(new Date(startedAt).getTime() + elapsed * 1000).toISOString() : startedAt;
  const kcal = a.kilojoules != null ? Math.round(a.kilojoules * 0.239) : null;
  return {
    workout_id: `strava-${a.id}`,
    source: "strava",
    device: "strava",
    event_type: "workout.completed",
    activity_type: (a.type || a.sport_type || "Workout").trim() || "Workout",
    started_at_iso: startedAt,
    ended_at_iso: endDate,
    duration_seconds: elapsed,
    distance_meters: a.distance != null ? Number(a.distance) : null,
    active_energy_kcal: kcal,
    metadata_json: JSON.stringify({ name: a.name ?? null, sport_type: a.sport_type ?? null }),
  };
}

async function getLastSync(env: Env): Promise<Date | null> {
  const row = await env.DB.prepare(`SELECT last_sync_at_iso FROM strava_sync_state WHERE id = 1`).first<{ last_sync_at_iso: string }>();
  if (!row?.last_sync_at_iso) return null;
  const d = new Date(row.last_sync_at_iso);
  return isNaN(d.getTime()) ? null : d;
}

async function setLastSync(env: Env) {
  await env.DB.prepare(`INSERT OR REPLACE INTO strava_sync_state (id, last_sync_at_iso) VALUES (1, ?)`).bind(nowISO()).run();
}

async function syncStrava(env: Env, lookbackDays: number) {
  const afterUnix = Math.floor(Date.now() / 1000) - Math.max(1, lookbackDays) * 24 * 60 * 60;
  const accessToken = await getStravaAccessToken(env);
  const activities = await fetchStravaActivities(accessToken, afterUnix);
  let inserted = 0;
  const ts = nowISO();
  for (const a of activities) {
    const row = stravaActivityToWorkoutRow(a);
    const existing = await env.DB.prepare(`SELECT 1 FROM workouts WHERE workout_id = ?`).bind(row.workout_id).first();
    if (existing) continue;
    await env.DB.prepare(
      `INSERT INTO workouts (
        workout_id, source, device, event_type, activity_type, started_at_iso, ended_at_iso,
        duration_seconds, distance_meters, active_energy_kcal, metadata_json, created_at_iso
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        row.workout_id,
        row.source,
        row.device,
        row.event_type,
        row.activity_type,
        row.started_at_iso,
        row.ended_at_iso,
        row.duration_seconds,
        row.distance_meters,
        row.active_energy_kcal,
        row.metadata_json,
        ts,
      )
      .run();
    inserted += 1;
  }
  await setLastSync(env);
  return { ok: true, synced: activities.length, inserted };
}

function createServer(env: Env) {
  const server = new McpServer({ name: "Strava MCP (D1)", version: "0.1.0" });

  server.tool(
    "strava_sync",
    "Sync recent Strava activities into D1 workouts table.",
    { lookbackDays: z.number().int().positive().max(365).optional() },
    async (args) => {
      const p = z.object({ lookbackDays: z.number().int().positive().max(365).optional() }).parse(args);
      const result = await syncStrava(env, p.lookbackDays ?? 30);
      const last = await getLastSync(env);
      return { content: [{ type: "text", text: jsonText({ ...result, lastSyncAtISO: last?.toISOString() ?? null }) }] };
    },
  );

  server.tool(
    "strava_list_workouts",
    "List synced workouts (most recent first).",
    { limit: z.number().int().positive().max(200).optional() },
    async (args) => {
      const p = z.object({ limit: z.number().int().positive().max(200).optional() }).parse(args);
      const res = await env.DB.prepare(
        `SELECT workout_id, source, device, event_type, activity_type, started_at_iso, ended_at_iso,
         duration_seconds, distance_meters, active_energy_kcal, metadata_json, created_at_iso
         FROM workouts ORDER BY ended_at_iso DESC LIMIT ?`,
      )
        .bind(p.limit ?? 50)
        .all();
      return { content: [{ type: "text", text: jsonText({ workouts: res.results ?? [] }) }] };
    },
  );

  server.tool(
    "strava_get_workout",
    "Get a single synced workout by workoutId (e.g. strava-123).",
    { workoutId: z.string().min(1) },
    async (args) => {
      const p = z.object({ workoutId: z.string().min(1) }).parse(args);
      const row = await env.DB.prepare(
        `SELECT workout_id, source, device, event_type, activity_type, started_at_iso, ended_at_iso,
         duration_seconds, distance_meters, active_energy_kcal, metadata_json, created_at_iso
         FROM workouts WHERE workout_id = ? LIMIT 1`,
      )
        .bind(p.workoutId)
        .first();
      return { content: [{ type: "text", text: jsonText({ workout: row ?? null }) }] };
    },
  );

  server.tool("strava_latest_workout", "Get most recent workout.", {}, async () => {
    const row = await env.DB.prepare(
      `SELECT workout_id, source, device, event_type, activity_type, started_at_iso, ended_at_iso,
       duration_seconds, distance_meters, active_energy_kcal, metadata_json, created_at_iso
       FROM workouts ORDER BY ended_at_iso DESC LIMIT 1`,
    ).first();
    return { content: [{ type: "text", text: jsonText({ workout: row ?? null }) }] };
  });

  return server;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    try {
      await requireApiKey(request, env);
    } catch {
      return new Response("Unauthorized", { status: 401 });
    }
    const server = createServer(env);
    return createMcpHandler(server, { route: "/mcp" })(request, env, ctx);
  },
};
