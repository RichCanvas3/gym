import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export type Env = {
  MCP_API_KEY?: string;
  DB: D1Database;
  STRAVA_CLIENT_ID?: string;
  STRAVA_CLIENT_SECRET?: string;
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

type StravaOAuthTokenResponse = {
  token_type?: string;
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
  expires_in?: number;
  scope?: string;
  athlete?: unknown;
  message?: string;
  errors?: unknown;
};

function scopeIdForTelegramUserId(telegramUserId: string): string {
  const clean = String(telegramUserId ?? "").trim();
  if (!clean) throw new Error("Missing telegramUserId");
  return `tg:${clean}`;
}

async function ensureSchema(env: Env): Promise<void> {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS workouts (
      workout_id TEXT PRIMARY KEY,
      scope_id TEXT,
      source TEXT NOT NULL,
      device TEXT,
      event_type TEXT NOT NULL,
      activity_type TEXT NOT NULL,
      started_at_iso TEXT NOT NULL,
      ended_at_iso TEXT NOT NULL,
      duration_seconds INTEGER NOT NULL,
      distance_meters REAL,
      active_energy_kcal REAL,
      metadata_json TEXT,
      created_at_iso TEXT NOT NULL
    )`,
  ).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_workouts_ended_at ON workouts(ended_at_iso DESC)`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_workouts_activity_type ON workouts(activity_type)`).run();

  // New tables are safe to create idempotently.
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS strava_tokens (
      telegram_user_id TEXT PRIMARY KEY,
      refresh_token TEXT NOT NULL,
      scope TEXT,
      athlete_json TEXT,
      updated_at_iso TEXT NOT NULL
    )`,
  ).run();

  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS strava_sync_state_v2 (
      scope_id TEXT PRIMARY KEY,
      last_sync_at_iso TEXT NOT NULL
    )`,
  ).run();

  // Backing table existed without scope_id; add it if missing.
  const cols = await env.DB.prepare(`PRAGMA table_info(workouts)`).all<{ name?: string }>();
  const names = new Set((cols.results ?? []).map((r) => String(r?.name ?? "")));
  if (names.size && !names.has("scope_id")) {
    await env.DB.prepare(`ALTER TABLE workouts ADD COLUMN scope_id TEXT`).run();
  }

  // Only create the scoped index after we know the column exists.
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_workouts_scope_ended_at ON workouts(scope_id, ended_at_iso DESC)`).run();
}

async function exchangeStravaAuthCode(env: Env, code: string, redirectUri: string): Promise<StravaOAuthTokenResponse> {
  const clientId = (env.STRAVA_CLIENT_ID ?? "").trim();
  const clientSecret = (env.STRAVA_CLIENT_SECRET ?? "").trim();
  if (!clientId || !clientSecret) throw new Error("Missing STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET");
  const res = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const data = (await res.json().catch(() => ({}))) as StravaOAuthTokenResponse;
  if (!res.ok || !data.refresh_token || !data.access_token) {
    const msg = typeof data.message === "string" && data.message ? data.message : `Strava oauth/token failed: ${res.status}`;
    const detail = data && typeof data === "object" && "errors" in data && data.errors ? ` ${JSON.stringify(data.errors)}` : "";
    throw new Error(`${msg}${detail}`);
  }
  return data;
}

async function refreshStravaAccessToken(env: Env, refreshToken: string): Promise<string> {
  const clientId = (env.STRAVA_CLIENT_ID ?? "").trim();
  const clientSecret = (env.STRAVA_CLIENT_SECRET ?? "").trim();
  const rt = String(refreshToken ?? "").trim();
  if (!clientId || !clientSecret || !rt) {
    throw new Error("Missing STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET / refreshToken");
  }
  const res = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: rt,
      grant_type: "refresh_token",
    }),
  });
  const data = (await res.json().catch(() => ({}))) as StravaOAuthTokenResponse;
  if (!res.ok || !data.access_token) {
    throw new Error((typeof data.message === "string" && data.message) || `Strava token failed: ${res.status}`);
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

async function fetchStravaAthlete(accessToken: string): Promise<unknown> {
  const res = await fetch("https://www.strava.com/api/v3/athlete", { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      typeof data === "object" && data !== null && "message" in data ? String((data as any).message) : `Strava athlete HTTP ${res.status}`;
    throw new Error(msg);
  }
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

async function getLastSync(env: Env, scopeId: string): Promise<Date | null> {
  const row = await env.DB.prepare(`SELECT last_sync_at_iso FROM strava_sync_state_v2 WHERE scope_id = ?`).bind(scopeId).first<{
    last_sync_at_iso: string;
  }>();
  if (!row?.last_sync_at_iso) return null;
  const d = new Date(row.last_sync_at_iso);
  return isNaN(d.getTime()) ? null : d;
}

async function setLastSync(env: Env, scopeId: string) {
  await env.DB.prepare(`INSERT OR REPLACE INTO strava_sync_state_v2 (scope_id, last_sync_at_iso) VALUES (?, ?)`)
    .bind(scopeId, nowISO())
    .run();
}

async function getRefreshTokenForTelegramUserId(env: Env, telegramUserId: string): Promise<string> {
  const clean = String(telegramUserId ?? "").trim();
  if (!clean) throw new Error("Missing telegramUserId");
  const row = await env.DB.prepare(`SELECT refresh_token FROM strava_tokens WHERE telegram_user_id = ?`).bind(clean).first<{
    refresh_token?: string;
  }>();
  const rt = String(row?.refresh_token ?? "").trim();
  if (!rt) throw new Error("Strava not connected for this telegramUserId");
  return rt;
}

async function upsertRefreshToken(env: Env, telegramUserId: string, refreshToken: string, scope: string | null, athlete: unknown) {
  const clean = String(telegramUserId ?? "").trim();
  const rt = String(refreshToken ?? "").trim();
  if (!clean) throw new Error("Missing telegramUserId");
  if (!rt) throw new Error("Missing refreshToken");
  await env.DB.prepare(
    `INSERT OR REPLACE INTO strava_tokens (telegram_user_id, refresh_token, scope, athlete_json, updated_at_iso)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(clean, rt, scope, athlete ? JSON.stringify(athlete) : null, nowISO())
    .run();
}

async function syncStrava(env: Env, telegramUserId: string, lookbackDays: number) {
  const scopeId = scopeIdForTelegramUserId(telegramUserId);
  const afterUnix = Math.floor(Date.now() / 1000) - Math.max(1, lookbackDays) * 24 * 60 * 60;
  const refreshToken = await getRefreshTokenForTelegramUserId(env, telegramUserId);
  const accessToken = await refreshStravaAccessToken(env, refreshToken);
  const activities = await fetchStravaActivities(accessToken, afterUnix);
  let inserted = 0;
  const ts = nowISO();
  for (const a of activities) {
    const row = stravaActivityToWorkoutRow(a);
    const existing = await env.DB.prepare(`SELECT 1 FROM workouts WHERE workout_id = ? AND scope_id = ?`)
      .bind(row.workout_id, scopeId)
      .first();
    if (existing) continue;
    await env.DB.prepare(
      `INSERT INTO workouts (
        workout_id, scope_id, source, device, event_type, activity_type, started_at_iso, ended_at_iso,
        duration_seconds, distance_meters, active_energy_kcal, metadata_json, created_at_iso
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        row.workout_id,
        scopeId,
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
  await setLastSync(env, scopeId);
  return { ok: true, synced: activities.length, inserted };
}

function createServer(env: Env) {
  const server = new McpServer({ name: "Strava MCP (D1)", version: "0.1.0" });

  server.tool(
    "strava_connect",
    "Exchange Strava OAuth code and store refresh token for a telegramUserId.",
    { telegramUserId: z.string().min(1), code: z.string().min(1), redirectUri: z.string().url() },
    async (args) => {
      await ensureSchema(env);
      const p = z.object({ telegramUserId: z.string().min(1), code: z.string().min(1), redirectUri: z.string().url() }).parse(args);
      const tok = await exchangeStravaAuthCode(env, p.code, p.redirectUri);
      await upsertRefreshToken(env, p.telegramUserId, String(tok.refresh_token), typeof tok.scope === "string" ? tok.scope : null, tok.athlete);
      return {
        content: [
          {
            type: "text",
            text: jsonText({
              ok: true,
              telegramUserId: p.telegramUserId,
              scope: tok.scope ?? null,
              expiresAt: tok.expires_at ?? null,
              athlete: tok.athlete ?? null,
            }),
          },
        ],
      };
    },
  );

  server.tool(
    "strava_get_me",
    "Fetch Strava athlete profile for a telegramUserId (requires Strava connected).",
    { telegramUserId: z.string().min(1) },
    async (args) => {
      await ensureSchema(env);
      const p = z.object({ telegramUserId: z.string().min(1) }).parse(args);
      const refreshToken = await getRefreshTokenForTelegramUserId(env, p.telegramUserId);
      const accessToken = await refreshStravaAccessToken(env, refreshToken);
      const athlete = await fetchStravaAthlete(accessToken);
      return { content: [{ type: "text", text: jsonText({ ok: true, telegramUserId: p.telegramUserId, athlete }) }] };
    },
  );

  server.tool(
    "strava_sync",
    "Sync recent Strava activities into D1 workouts table.",
    { telegramUserId: z.string().min(1), lookbackDays: z.number().int().positive().max(365).optional() },
    async (args) => {
      await ensureSchema(env);
      const p = z
        .object({ telegramUserId: z.string().min(1), lookbackDays: z.number().int().positive().max(365).optional() })
        .parse(args);
      const result = await syncStrava(env, p.telegramUserId, p.lookbackDays ?? 30);
      const last = await getLastSync(env, scopeIdForTelegramUserId(p.telegramUserId));
      return {
        content: [
          { type: "text", text: jsonText({ ...result, telegramUserId: p.telegramUserId, lastSyncAtISO: last?.toISOString() ?? null }) },
        ],
      };
    },
  );

  server.tool(
    "strava_list_workouts",
    "List synced workouts (most recent first).",
    { telegramUserId: z.string().min(1), limit: z.number().int().positive().max(200).optional() },
    async (args) => {
      await ensureSchema(env);
      const p = z.object({ telegramUserId: z.string().min(1), limit: z.number().int().positive().max(200).optional() }).parse(args);
      const scopeId = scopeIdForTelegramUserId(p.telegramUserId);
      const res = await env.DB.prepare(
        `SELECT workout_id, source, device, event_type, activity_type, started_at_iso, ended_at_iso,
         duration_seconds, distance_meters, active_energy_kcal, metadata_json, created_at_iso
         FROM workouts WHERE scope_id = ? ORDER BY ended_at_iso DESC LIMIT ?`,
      )
        .bind(scopeId, p.limit ?? 50)
        .all();
      return { content: [{ type: "text", text: jsonText({ ok: true, telegramUserId: p.telegramUserId, workouts: res.results ?? [] }) }] };
    },
  );

  server.tool(
    "strava_get_workout",
    "Get a single synced workout by workoutId (e.g. strava-123).",
    { telegramUserId: z.string().min(1), workoutId: z.string().min(1) },
    async (args) => {
      await ensureSchema(env);
      const p = z.object({ telegramUserId: z.string().min(1), workoutId: z.string().min(1) }).parse(args);
      const scopeId = scopeIdForTelegramUserId(p.telegramUserId);
      const row = await env.DB.prepare(
        `SELECT workout_id, source, device, event_type, activity_type, started_at_iso, ended_at_iso,
         duration_seconds, distance_meters, active_energy_kcal, metadata_json, created_at_iso
         FROM workouts WHERE workout_id = ? AND scope_id = ? LIMIT 1`,
      )
        .bind(p.workoutId, scopeId)
        .first();
      return { content: [{ type: "text", text: jsonText({ ok: true, telegramUserId: p.telegramUserId, workout: row ?? null }) }] };
    },
  );

  server.tool("strava_latest_workout", "Get most recent workout for a telegramUserId.", { telegramUserId: z.string().min(1) }, async (args) => {
    await ensureSchema(env);
    const p = z.object({ telegramUserId: z.string().min(1) }).parse(args);
    const scopeId = scopeIdForTelegramUserId(p.telegramUserId);
    const row = await env.DB.prepare(
      `SELECT workout_id, source, device, event_type, activity_type, started_at_iso, ended_at_iso,
       duration_seconds, distance_meters, active_energy_kcal, metadata_json, created_at_iso
       FROM workouts WHERE scope_id = ? ORDER BY ended_at_iso DESC LIMIT 1`,
    )
      .bind(scopeId)
      .first();
    return { content: [{ type: "text", text: jsonText({ ok: true, telegramUserId: p.telegramUserId, workout: row ?? null }) }] };
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
