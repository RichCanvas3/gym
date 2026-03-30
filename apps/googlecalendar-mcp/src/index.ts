import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export type Env = {
  MCP_API_KEY?: string;
  DB: D1Database;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  OAUTH_REDIRECT_URL?: string; // e.g. https://<worker>.workers.dev/oauth/callback
  WEB_SUCCESS_REDIRECT_URL?: string; // e.g. https://<web>/chat?connected=google
  TOKEN_ENCRYPTION_KEY_B64?: string; // base64(32 bytes)
  /** If set, create/update/list use this calendar (e.g. myclaw calendar id); else "primary". */
  TARGET_CALENDAR_ID?: string;
};

function nowISO() {
  return new Date().toISOString();
}

/** Calendar to use for create/list/update when TARGET_CALENDAR_ID is set (e.g. "myclaw" calendar). */
function getTargetCalendarId(env: Env): string {
  const id = (env.TARGET_CALENDAR_ID ?? "").trim();
  return id || "primary";
}

/**
 * Path segment for Calendar API: encode once. If TARGET_CALENDAR_ID was pasted URL-encoded
 * (foo%40group.calendar.google.com), decode once first to avoid double-encoding → 404.
 */
function calendarIdForApiPath(raw: string): string {
  let id = raw.trim();
  if (!id) return encodeURIComponent("primary");
  try {
    if (id.includes("%")) {
      const once = decodeURIComponent(id);
      if (once !== id) id = once;
    }
  } catch {
    // use raw
  }
  return encodeURIComponent(id);
}

function googleApiErrorHint(status: number, json: unknown, op: string): string {
  const j = json as { error?: { message?: string } };
  const msg = j?.error?.message ?? JSON.stringify(json);
  if (status === 404) {
    return `${op} failed (404 Not Found): ${msg}. If using TARGET_CALENDAR_ID: use the calendar **id** from googlecalendar_list_calendars (e.g. xxxxx@group.calendar.google.com), not the display name "myclaw". For updates: eventId must be on that same calendar (events from primary won’t exist on another calendar).`;
  }
  return `${op} failed (${status}): ${msg}`;
}

function jsonText(obj: unknown) {
  return JSON.stringify(obj, null, 2);
}

async function ensureEventCacheTables(env: Env): Promise<void> {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS google_calendar_events (
      account_address TEXT NOT NULL,
      telegram_user_id TEXT,
      calendar_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      start_iso TEXT,
      end_iso TEXT,
      start_ms INTEGER,
      end_ms INTEGER,
      summary TEXT,
      description TEXT,
      status TEXT,
      updated_at_iso TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      PRIMARY KEY (account_address, calendar_id, event_id)
    )`,
  ).run();
  await env.DB.prepare(
    `CREATE INDEX IF NOT EXISTS idx_google_calendar_events_start ON google_calendar_events(account_address, start_ms)`,
  ).run();
  await env.DB.prepare(
    `CREATE INDEX IF NOT EXISTS idx_google_calendar_events_tg_start ON google_calendar_events(telegram_user_id, start_ms)`,
  ).run();
}

function eventStartIso(e: any): string | null {
  const dt = e?.start?.dateTime;
  if (typeof dt === "string" && dt.trim()) return dt.trim();
  const d = e?.start?.date;
  if (typeof d === "string" && d.trim()) return d.trim();
  return null;
}

function eventEndIso(e: any): string | null {
  const dt = e?.end?.dateTime;
  if (typeof dt === "string" && dt.trim()) return dt.trim();
  const d = e?.end?.date;
  if (typeof d === "string" && d.trim()) return d.trim();
  return null;
}

function isoToMs(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

async function requireApiKey(request: Request, env: Env) {
  const want = (env.MCP_API_KEY ?? "").trim();
  if (!want) return;
  const got = (request.headers.get("x-api-key") ?? "").trim();
  if (got !== want) throw new Error("Unauthorized (bad x-api-key)");
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const buf = new ArrayBuffer(bin.length);
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function asArrayBuffer(u8: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(u8.byteLength);
  new Uint8Array(buf).set(u8);
  return buf;
}

async function getAesKey(env: Env): Promise<CryptoKey> {
  const b64 = (env.TOKEN_ENCRYPTION_KEY_B64 ?? "").trim();
  if (!b64) throw new Error("Missing TOKEN_ENCRYPTION_KEY_B64");
  const raw = base64ToBytes(b64);
  if (raw.byteLength !== 32) throw new Error("TOKEN_ENCRYPTION_KEY_B64 must be 32 bytes base64");
  return crypto.subtle.importKey("raw", asArrayBuffer(raw), "AES-GCM", false, ["encrypt", "decrypt"]);
}

function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

async function ensureSchema(env: Env): Promise<void> {
  // Best-effort lightweight migrations. D1/SQLite doesn't support ADD COLUMN IF NOT EXISTS.
  const stmts = [
    `CREATE TABLE IF NOT EXISTS google_oauth_states (state TEXT PRIMARY KEY, account_address TEXT NOT NULL, telegram_user_id TEXT, created_at_iso TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_google_oauth_states_created ON google_oauth_states(created_at_iso)`,
    `CREATE TABLE IF NOT EXISTS google_calendar_connections (account_address TEXT PRIMARY KEY, telegram_user_id TEXT, google_sub TEXT, google_email TEXT, refresh_token_enc TEXT NOT NULL, scope TEXT, token_type TEXT, access_token TEXT, expiry_date_ms INTEGER, created_at_iso TEXT NOT NULL, updated_at_iso TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_google_calendar_connections_tg ON google_calendar_connections(telegram_user_id)`,
    // Add columns to existing tables if they predate telegram support.
    `ALTER TABLE google_oauth_states ADD COLUMN telegram_user_id TEXT`,
    `ALTER TABLE google_calendar_connections ADD COLUMN telegram_user_id TEXT`,
    `ALTER TABLE google_calendar_events ADD COLUMN telegram_user_id TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_google_calendar_events_tg_start ON google_calendar_events(telegram_user_id, start_ms)`,
  ];
  for (const sql of stmts) {
    try {
      await env.DB.prepare(sql).run();
    } catch {
      // ignore (already exists / cannot alter)
    }
  }
}

async function encryptToken(env: Env, plaintext: string): Promise<string> {
  const key = await getAesKey(env);
  const iv = new Uint8Array(asArrayBuffer(crypto.getRandomValues(new Uint8Array(12))));
  const pt = new TextEncoder().encode(plaintext);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, pt));
  return `v1:${bytesToB64(iv)}:${bytesToB64(ct)}`;
}

async function decryptToken(env: Env, enc: string): Promise<string> {
  const parts = (enc || "").split(":");
  if (parts.length !== 3 || parts[0] !== "v1") throw new Error("Unsupported token encoding");
  const key = await getAesKey(env);
  const iv = new Uint8Array(asArrayBuffer(base64ToBytes(parts[1])));
  const ct = base64ToBytes(parts[2]);
  const pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, asArrayBuffer(ct)));
  return new TextDecoder().decode(pt);
}

async function googleTokenExchange(env: Env, code: string) {
  const clientId = (env.GOOGLE_CLIENT_ID ?? "").trim();
  const clientSecret = (env.GOOGLE_CLIENT_SECRET ?? "").trim();
  const redirectUri = (env.OAUTH_REDIRECT_URL ?? "").trim();
  if (!clientId || !clientSecret || !redirectUri) throw new Error("Missing GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/OAUTH_REDIRECT_URL");

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const json = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new Error(`Token exchange failed: ${JSON.stringify(json)}`);
  return json as {
    access_token?: string;
    refresh_token?: string;
    scope?: string;
    token_type?: string;
    expires_in?: number;
    id_token?: string;
  };
}

async function googleTokenRefresh(env: Env, refreshToken: string) {
  const clientId = (env.GOOGLE_CLIENT_ID ?? "").trim();
  const clientSecret = (env.GOOGLE_CLIENT_SECRET ?? "").trim();
  if (!clientId || !clientSecret) throw new Error("Missing GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const json = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new Error(`Token refresh failed: ${JSON.stringify(json)}`);
  return json as { access_token?: string; scope?: string; token_type?: string; expires_in?: number };
}

async function googleUserInfo(accessToken: string) {
  const res = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const json = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new Error(`userinfo failed: ${JSON.stringify(json)}`);
  return json as { sub?: string; email?: string };
}

async function getAccessTokenForAccount(env: Env, accountAddress: string): Promise<string> {
  const row = await env.DB.prepare(
    `SELECT refresh_token_enc, access_token, expiry_date_ms FROM google_calendar_connections WHERE account_address = ? LIMIT 1`,
  )
    .bind(accountAddress)
    .first();
  if (!row) throw new Error("No Google Calendar connection for accountAddress");
  const refreshEnc = String((row as any).refresh_token_enc ?? "");
  const refreshToken = await decryptToken(env, refreshEnc);
  const accessToken = (row as any).access_token ? String((row as any).access_token) : "";
  const expiryMs = (row as any).expiry_date_ms ? Number((row as any).expiry_date_ms) : 0;
  const now = Date.now();
  const needsRefresh = !accessToken || !Number.isFinite(expiryMs) || expiryMs <= now + 60_000;
  if (!needsRefresh) return accessToken;

  const refreshed = await googleTokenRefresh(env, refreshToken);
  const newAccess = String(refreshed.access_token ?? "");
  const expiresIn = Number(refreshed.expires_in ?? 0);
  const newExpiry = now + Math.max(0, expiresIn) * 1000;
  await env.DB.prepare(`UPDATE google_calendar_connections SET access_token = ?, expiry_date_ms = ?, updated_at_iso = ? WHERE account_address = ?`)
    .bind(newAccess, newExpiry, nowISO(), accountAddress)
    .run();
  if (!newAccess) throw new Error("Failed to refresh access token");
  return newAccess;
}

async function accountAddressForTelegramUserId(env: Env, telegramUserId: string): Promise<string> {
  const tg = String(telegramUserId ?? "").trim();
  if (!tg) throw new Error("Missing telegramUserId");
  const row = await env.DB.prepare(
    `SELECT account_address FROM google_calendar_connections WHERE telegram_user_id = ? LIMIT 1`,
  )
    .bind(tg)
    .first<{ account_address: string }>();
  const acct = row?.account_address ? String(row.account_address) : "";
  if (!acct) throw new Error("No Google Calendar connection for telegramUserId");
  return acct;
}

async function resolveAccountAddress(env: Env, args: { accountAddress?: string; telegramUserId?: string }): Promise<{ accountAddress: string; telegramUserId: string | null }> {
  const acct = (args.accountAddress ?? "").trim();
  const tg = (args.telegramUserId ?? "").trim();
  if (acct) {
    const row = await env.DB.prepare(`SELECT telegram_user_id FROM google_calendar_connections WHERE account_address = ? LIMIT 1`)
      .bind(acct)
      .first<{ telegram_user_id: string | null }>();
    const tg2 = row?.telegram_user_id ? String(row.telegram_user_id) : "";
    return { accountAddress: acct, telegramUserId: tg2 || null };
  }
  if (tg) {
    try {
      const accountAddress = await accountAddressForTelegramUserId(env, tg);
      return { accountAddress, telegramUserId: tg };
    } catch {
      // Back-compat: older connections were stored only by accountAddress.
      // If there's exactly one connection in the DB, assume it's for this user and bind telegram_user_id.
      const all = await env.DB.prepare(`SELECT account_address FROM google_calendar_connections LIMIT 2`).all<{ account_address: string }>();
      const rows = (all.results ?? []) as Array<{ account_address: string }>;
      if (rows.length === 1 && rows[0]?.account_address) {
        const accountAddress = String(rows[0].account_address);
        await env.DB.prepare(`UPDATE google_calendar_connections SET telegram_user_id = ? WHERE account_address = ?`)
          .bind(tg, accountAddress)
          .run();
        return { accountAddress, telegramUserId: tg };
      }
      throw new Error("No Google Calendar connection for telegramUserId (reconnect to bind telegram id).");
    }
  }
  throw new Error("Provide accountAddress or telegramUserId");
}

function createServer(env: Env) {
  const server = new McpServer({ name: "Google Calendar MCP", version: "0.1.0" });

  server.tool("googlecalendar_ping", "Health check", {}, async () => {
    return { content: [{ type: "text", text: jsonText({ ok: true, asOfISO: nowISO() }) }] };
  });

  server.tool(
    "googlecalendar_get_connection_status",
    "Check whether an accountAddress has connected Google Calendar.",
    { accountAddress: z.string().min(3).optional(), telegramUserId: z.string().min(3).optional() },
    async (args) => {
      await ensureSchema(env);
      const p = z.object({ accountAddress: z.string().min(3).optional(), telegramUserId: z.string().min(3).optional() }).parse(args);
      const resolved = await resolveAccountAddress(env, { accountAddress: p.accountAddress, telegramUserId: p.telegramUserId }).catch(() => null);
      const accountAddress = resolved?.accountAddress ?? (p.accountAddress ?? "").trim();
      const row = await env.DB.prepare(
        `SELECT account_address, telegram_user_id, google_email, google_sub, scope, updated_at_iso FROM google_calendar_connections WHERE account_address = ? LIMIT 1`,
      )
        .bind(accountAddress)
        .first();
      const connected = Boolean(row);
      return {
        content: [
          {
            type: "text",
            text: jsonText({
              connected,
              accountAddress: accountAddress || null,
              telegramUserId: row ? (String((row as any).telegram_user_id ?? "") || null) : null,
              googleEmail: row ? ((row as any).google_email ? String((row as any).google_email) : null) : null,
              googleSub: row ? ((row as any).google_sub ? String((row as any).google_sub) : null) : null,
              scope: row ? ((row as any).scope ? String((row as any).scope) : null) : null,
              updatedAtISO: row ? String((row as any).updated_at_iso ?? "") : null,
            }),
          },
        ],
      };
    },
  );

  server.tool(
    "googlecalendar_disconnect",
    "Disconnect Google Calendar for an account (deletes stored refresh token + cached events).",
    { accountAddress: z.string().min(3).optional(), telegramUserId: z.string().min(3).optional(), clearCachedEvents: z.boolean().optional() },
    async (args) => {
      await ensureSchema(env);
      await ensureEventCacheTables(env);
      const p = z
        .object({ accountAddress: z.string().min(3).optional(), telegramUserId: z.string().min(3).optional(), clearCachedEvents: z.boolean().optional() })
        .parse(args);
      const acctRaw = (p.accountAddress ?? "").trim();
      const acct = acctRaw || (await resolveAccountAddress(env, { telegramUserId: p.telegramUserId })).accountAddress;
      const ts = nowISO();
      await env.DB.prepare(`DELETE FROM google_calendar_connections WHERE account_address = ?`).bind(acct).run();
      if (p.clearCachedEvents !== false) {
        await env.DB.prepare(`DELETE FROM google_calendar_events WHERE account_address = ?`).bind(acct).run();
      }
      return { content: [{ type: "text", text: jsonText({ ok: true, accountAddress: acct, disconnectedAtISO: ts, clearedEvents: p.clearCachedEvents !== false }) }] };
    },
  );

  server.tool(
    "googlecalendar_freebusy",
    "Get free/busy blocks for the user's primary calendar.",
    {
      accountAddress: z.string().min(3),
      timeMinISO: z.string().min(10),
      timeMaxISO: z.string().min(10),
    },
    async (args) => {
      const p = z
        .object({ accountAddress: z.string().min(3), timeMinISO: z.string().min(10), timeMaxISO: z.string().min(10) })
        .parse(args);
      const accessToken = await getAccessTokenForAccount(env, p.accountAddress);
      const res = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          timeMin: p.timeMinISO,
          timeMax: p.timeMaxISO,
          items: [{ id: "primary" }],
        }),
      });
      const json = (await res.json().catch(() => ({}))) as any;
      if (!res.ok) throw new Error(`freebusy failed: ${JSON.stringify(json)}`);
      return { content: [{ type: "text", text: jsonText({ asOfISO: nowISO(), freebusy: json }) }] };
    },
  );

  server.tool(
    "googlecalendar_list_calendars",
    "List the user's calendars (id, summary). Use this to find the calendar id for a named calendar like 'myclaw' so you can set TARGET_CALENDAR_ID.",
    { accountAddress: z.string().min(3).optional(), telegramUserId: z.string().min(3).optional() },
    async (args) => {
      await ensureSchema(env);
      const p = z.object({ accountAddress: z.string().min(3).optional(), telegramUserId: z.string().min(3).optional() }).parse(args);
      const resolved = await resolveAccountAddress(env, { accountAddress: p.accountAddress, telegramUserId: p.telegramUserId });
      const accessToken = await getAccessTokenForAccount(env, resolved.accountAddress);
      const res = await fetch("https://www.googleapis.com/calendar/v3/users/me/calendarList", {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      const json = (await res.json().catch(() => ({}))) as any;
      if (!res.ok) throw new Error(`calendarList.list failed: ${JSON.stringify(json)}`);
      const items = (json.items ?? []).map((c: any) => ({ id: c.id, summary: c.summary ?? c.id }));
      return { content: [{ type: "text", text: jsonText({ asOfISO: nowISO(), calendars: items }) }] };
    },
  );

  server.tool(
    "googlecalendar_list_events",
    "List events on the target calendar (primary, or TARGET_CALENDAR_ID if set, e.g. myclaw) in a time window.",
    {
      accountAddress: z.string().min(3).optional(),
      telegramUserId: z.string().min(3).optional(),
      timeMinISO: z.string().min(10),
      timeMaxISO: z.string().min(10),
      q: z.string().optional(),
      maxResults: z.number().int().positive().max(50).optional(),
    },
    async (args) => {
      await ensureSchema(env);
      const p = z
        .object({
          accountAddress: z.string().min(3).optional(),
          telegramUserId: z.string().min(3).optional(),
          timeMinISO: z.string().min(10),
          timeMaxISO: z.string().min(10),
          q: z.string().optional(),
          maxResults: z.number().int().positive().max(50).optional(),
        })
        .parse(args);
      const resolved = await resolveAccountAddress(env, { accountAddress: p.accountAddress, telegramUserId: p.telegramUserId });
      const accessToken = await getAccessTokenForAccount(env, resolved.accountAddress);
      const calendarId = calendarIdForApiPath(getTargetCalendarId(env));
      const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`);
      url.searchParams.set("timeMin", p.timeMinISO);
      url.searchParams.set("timeMax", p.timeMaxISO);
      url.searchParams.set("singleEvents", "true");
      url.searchParams.set("orderBy", "startTime");
      url.searchParams.set("maxResults", String(p.maxResults ?? 20));
      if (p.q && p.q.trim()) url.searchParams.set("q", p.q.trim());
      const res = await fetch(url.toString(), { headers: { authorization: `Bearer ${accessToken}` } });
      const json = (await res.json().catch(() => ({}))) as any;
      if (!res.ok) throw new Error(googleApiErrorHint(res.status, json, "events.list"));
      return { content: [{ type: "text", text: jsonText({ asOfISO: nowISO(), events: json.items ?? [] }) }] };
    },
  );

  server.tool(
    "googlecalendar_sync_events",
    "Fetch events from Google and upsert them into D1 for cached retrieval.",
    {
      accountAddress: z.string().min(3).optional(),
      telegramUserId: z.string().min(3).optional(),
      timeMinISO: z.string().min(10),
      timeMaxISO: z.string().min(10),
      q: z.string().optional(),
      maxResults: z.number().int().positive().max(2500).optional(),
    },
    async (args) => {
      const p = z
        .object({
          accountAddress: z.string().min(3).optional(),
          telegramUserId: z.string().min(3).optional(),
          timeMinISO: z.string().min(10),
          timeMaxISO: z.string().min(10),
          q: z.string().optional(),
          maxResults: z.number().int().positive().max(2500).optional(),
        })
        .parse(args);
      await ensureSchema(env);
      await ensureEventCacheTables(env);
      const resolved = await resolveAccountAddress(env, { accountAddress: p.accountAddress, telegramUserId: p.telegramUserId });
      const accessToken = await getAccessTokenForAccount(env, resolved.accountAddress);
      const calendarIdRaw = getTargetCalendarId(env);
      const calendarId = calendarIdForApiPath(calendarIdRaw);
      const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`);
      url.searchParams.set("timeMin", p.timeMinISO);
      url.searchParams.set("timeMax", p.timeMaxISO);
      url.searchParams.set("singleEvents", "true");
      url.searchParams.set("orderBy", "startTime");
      url.searchParams.set("maxResults", String(p.maxResults ?? 250));
      if (p.q && p.q.trim()) url.searchParams.set("q", p.q.trim());
      const res = await fetch(url.toString(), { headers: { authorization: `Bearer ${accessToken}` } });
      const json = (await res.json().catch(() => ({}))) as any;
      if (!res.ok) throw new Error(googleApiErrorHint(res.status, json, "events.list(sync)"));
      const items: any[] = Array.isArray(json?.items) ? json.items : [];
      const ts = nowISO();
      let upserted = 0;
      for (const e of items) {
        const eventId = typeof e?.id === "string" ? e.id.trim() : "";
        if (!eventId) continue;
        const startIso = eventStartIso(e);
        const endIso = eventEndIso(e);
        const startMs = isoToMs(startIso);
        const endMs = isoToMs(endIso);
        await env.DB.prepare(
          `INSERT INTO google_calendar_events (
            account_address, telegram_user_id, calendar_id, event_id,
            start_iso, end_iso, start_ms, end_ms,
            summary, description, status,
            updated_at_iso, raw_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(account_address, calendar_id, event_id) DO UPDATE SET
            telegram_user_id=excluded.telegram_user_id,
            start_iso=excluded.start_iso,
            end_iso=excluded.end_iso,
            start_ms=excluded.start_ms,
            end_ms=excluded.end_ms,
            summary=excluded.summary,
            description=excluded.description,
            status=excluded.status,
            updated_at_iso=excluded.updated_at_iso,
            raw_json=excluded.raw_json`,
        )
          .bind(
            resolved.accountAddress,
            resolved.telegramUserId,
            calendarIdRaw,
            eventId,
            startIso,
            endIso,
            startMs,
            endMs,
            typeof e?.summary === "string" ? e.summary : null,
            typeof e?.description === "string" ? e.description : null,
            typeof e?.status === "string" ? e.status : null,
            ts,
            JSON.stringify(e ?? {}),
          )
          .run();
        upserted += 1;
      }
      return { content: [{ type: "text", text: jsonText({ asOfISO: ts, calendarId: calendarIdRaw, upserted, fetched: items.length }) }] };
    },
  );

  server.tool(
    "googlecalendar_list_events_cached",
    "List cached events from D1 (populated via googlecalendar_sync_events).",
    {
      accountAddress: z.string().min(3).optional(),
      telegramUserId: z.string().min(3).optional(),
      timeMinISO: z.string().min(10),
      timeMaxISO: z.string().min(10),
      q: z.string().optional(),
      maxResults: z.number().int().positive().max(200).optional(),
    },
    async (args) => {
      const p = z
        .object({
          accountAddress: z.string().min(3).optional(),
          telegramUserId: z.string().min(3).optional(),
          timeMinISO: z.string().min(10),
          timeMaxISO: z.string().min(10),
          q: z.string().optional(),
          maxResults: z.number().int().positive().max(200).optional(),
        })
        .parse(args);
      await ensureSchema(env);
      await ensureEventCacheTables(env);
      const calendarIdRaw = getTargetCalendarId(env);
      const t0 = Date.parse(p.timeMinISO);
      const t1 = Date.parse(p.timeMaxISO);
      const minMs = Number.isFinite(t0) ? t0 : 0;
      const maxMs = Number.isFinite(t1) ? t1 : Date.now() + 365 * 24 * 3600 * 1000;
      const q = (p.q ?? "").trim().toLowerCase();
      let eventsRes: any;
      if (p.telegramUserId && p.telegramUserId.trim()) {
        eventsRes = await env.DB.prepare(
          `SELECT event_id, start_iso, end_iso, start_ms, end_ms, summary, description, status, raw_json
           FROM google_calendar_events
           WHERE telegram_user_id = ?
             AND calendar_id = ?
             AND start_ms IS NOT NULL
             AND start_ms >= ?
             AND start_ms < ?
           ORDER BY start_ms ASC
           LIMIT ?`,
        )
          .bind(p.telegramUserId.trim(), calendarIdRaw, minMs, maxMs, p.maxResults ?? 50)
          .all();
      } else {
        const resolved = await resolveAccountAddress(env, { accountAddress: p.accountAddress, telegramUserId: undefined });
        eventsRes = await env.DB.prepare(
          `SELECT event_id, start_iso, end_iso, start_ms, end_ms, summary, description, status, raw_json
           FROM google_calendar_events
           WHERE account_address = ?
             AND calendar_id = ?
             AND start_ms IS NOT NULL
             AND start_ms >= ?
             AND start_ms < ?
           ORDER BY start_ms ASC
           LIMIT ?`,
        )
          .bind(resolved.accountAddress, calendarIdRaw, minMs, maxMs, p.maxResults ?? 50)
          .all();
      }
      let events = (eventsRes.results ?? []) as any[];
      if (q) {
        events = events.filter((e) => String(e?.summary ?? "").toLowerCase().includes(q) || String(e?.description ?? "").toLowerCase().includes(q));
      }
      return { content: [{ type: "text", text: jsonText({ asOfISO: nowISO(), calendarId: calendarIdRaw, events }) }] };
    },
  );

  server.tool(
    "googlecalendar_create_event",
    "Create an event on the target calendar (primary, or TARGET_CALENDAR_ID if set, e.g. myclaw).",
    {
      accountAddress: z.string().min(3),
      summary: z.string().min(1),
      description: z.string().optional(),
      startISO: z.string().min(10),
      endISO: z.string().min(10),
    },
    async (args) => {
      const p = z
        .object({
          accountAddress: z.string().min(3),
          summary: z.string().min(1),
          description: z.string().optional(),
          startISO: z.string().min(10),
          endISO: z.string().min(10),
        })
        .parse(args);
      const accessToken = await getAccessTokenForAccount(env, p.accountAddress);
      const calendarId = calendarIdForApiPath(getTargetCalendarId(env));
      const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`, {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          summary: p.summary,
          description: p.description,
          start: { dateTime: p.startISO },
          end: { dateTime: p.endISO },
        }),
      });
      const json = (await res.json().catch(() => ({}))) as any;
      if (!res.ok) throw new Error(googleApiErrorHint(res.status, json, "events.insert"));
      return { content: [{ type: "text", text: jsonText({ asOfISO: nowISO(), event: json }) }] };
    },
  );

  server.tool(
    "googlecalendar_update_event",
    "Update an existing event (summary, description, start, end) on the target calendar (primary or TARGET_CALENDAR_ID). Partial update: only provided fields are changed.",
    {
      accountAddress: z.string().min(3),
      eventId: z.string().min(1),
      summary: z.string().min(1).optional(),
      description: z.string().optional(),
      startISO: z.string().min(10).optional(),
      endISO: z.string().min(10).optional(),
    },
    async (args) => {
      const p = z
        .object({
          accountAddress: z.string().min(3),
          eventId: z.string().min(1),
          summary: z.string().min(1).optional(),
          description: z.string().optional(),
          startISO: z.string().min(10).optional(),
          endISO: z.string().min(10).optional(),
        })
        .parse(args);
      const accessToken = await getAccessTokenForAccount(env, p.accountAddress);
      const calendarId = calendarIdForApiPath(getTargetCalendarId(env));
      const eventId = encodeURIComponent(p.eventId);
      const body: Record<string, unknown> = {};
      if (p.summary != null) body.summary = p.summary;
      if (p.description != null) body.description = p.description;
      if (p.startISO != null) body.start = { dateTime: p.startISO };
      if (p.endISO != null) body.end = { dateTime: p.endISO };
      if (Object.keys(body).length === 0) {
        return { content: [{ type: "text", text: jsonText({ asOfISO: nowISO(), error: "Provide at least one of summary, description, startISO, endISO" }) }] };
      }
      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${eventId}`,
        {
          method: "PATCH",
          headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const json = (await res.json().catch(() => ({}))) as any;
      if (!res.ok) throw new Error(googleApiErrorHint(res.status, json, "events.patch"));
      return { content: [{ type: "text", text: jsonText({ asOfISO: nowISO(), event: json }) }] };
    },
  );

  server.tool(
    "googlecalendar_delete_event",
    "Delete an event on the target calendar (primary or TARGET_CALENDAR_ID, e.g. myclaw). Use eventId from create_event or list_events for that same calendar.",
    {
      accountAddress: z.string().min(3),
      eventId: z.string().min(1),
      sendUpdates: z.enum(["all", "externalOnly", "none"]).optional(),
    },
    async (args) => {
      const p = z
        .object({
          accountAddress: z.string().min(3),
          eventId: z.string().min(1),
          sendUpdates: z.enum(["all", "externalOnly", "none"]).optional(),
        })
        .parse(args);
      const accessToken = await getAccessTokenForAccount(env, p.accountAddress);
      const calendarId = calendarIdForApiPath(getTargetCalendarId(env));
      const eventId = encodeURIComponent(p.eventId);
      const q = new URLSearchParams();
      q.set("sendUpdates", p.sendUpdates ?? "all");
      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${eventId}?${q.toString()}`,
        { method: "DELETE", headers: { authorization: `Bearer ${accessToken}` } },
      );
      if (res.status === 204 || res.status === 200) {
        return { content: [{ type: "text", text: jsonText({ asOfISO: nowISO(), deleted: true, eventId: p.eventId }) }] };
      }
      const json = (await res.json().catch(() => ({}))) as any;
      throw new Error(googleApiErrorHint(res.status, json, "events.delete"));
    },
  );

  return server;
}

async function handleOAuthStart(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const accountAddress = (url.searchParams.get("accountAddress") ?? "").trim();
  if (accountAddress.length < 3) return new Response("Missing accountAddress", { status: 400 });
  const telegramUserId = (url.searchParams.get("telegramUserId") ?? "").trim() || null;

  const clientId = (env.GOOGLE_CLIENT_ID ?? "").trim();
  const redirectUri = (env.OAUTH_REDIRECT_URL ?? "").trim();
  if (!clientId || !redirectUri) return new Response("Missing GOOGLE_CLIENT_ID or OAUTH_REDIRECT_URL", { status: 500 });

  const state = `st_${crypto.randomUUID()}`;
  await ensureSchema(env);
  await env.DB.prepare(`INSERT INTO google_oauth_states (state, account_address, telegram_user_id, created_at_iso) VALUES (?, ?, ?, ?)`)
    .bind(state, accountAddress, telegramUserId, nowISO())
    .run();

  const scopes = [
    "openid",
    "email",
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/calendar.events",
  ];

  const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  auth.searchParams.set("client_id", clientId);
  auth.searchParams.set("redirect_uri", redirectUri);
  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("access_type", "offline");
  auth.searchParams.set("prompt", "consent");
  auth.searchParams.set("scope", scopes.join(" "));
  auth.searchParams.set("state", state);

  return Response.redirect(auth.toString(), 302);
}

async function handleOAuthCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = (url.searchParams.get("code") ?? "").trim();
  const state = (url.searchParams.get("state") ?? "").trim();
  if (!code || !state) return new Response("Missing code/state", { status: 400 });

  await ensureSchema(env);
  const st = await env.DB.prepare(`SELECT account_address, telegram_user_id FROM google_oauth_states WHERE state = ? LIMIT 1`)
    .bind(state)
    .first();
  if (!st) return new Response("Invalid state", { status: 400 });
  const accountAddress = String((st as any).account_address ?? "");
  const telegramUserId = (st as any).telegram_user_id ? String((st as any).telegram_user_id) : null;

  const token = await googleTokenExchange(env, code);
  const refresh = (token.refresh_token ?? "").trim();
  const access = (token.access_token ?? "").trim();
  if (!refresh) return new Response("Missing refresh_token (try disconnect/re-consent)", { status: 400 });

  const enc = await encryptToken(env, refresh);
  const expiresIn = Number(token.expires_in ?? 0);
  const expiryMs = Date.now() + Math.max(0, expiresIn) * 1000;

  let sub: string | null = null;
  let email: string | null = null;
  try {
    const info = await googleUserInfo(access);
    sub = info.sub ? String(info.sub) : null;
    email = info.email ? String(info.email) : null;
  } catch {
    // ignore
  }

  const ts = nowISO();
  await env.DB.prepare(
    `INSERT INTO google_calendar_connections (
      account_address, telegram_user_id, google_sub, google_email, refresh_token_enc, scope, token_type, access_token, expiry_date_ms, created_at_iso, updated_at_iso
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_address) DO UPDATE SET
      telegram_user_id=excluded.telegram_user_id,
      google_sub=excluded.google_sub,
      google_email=excluded.google_email,
      refresh_token_enc=excluded.refresh_token_enc,
      scope=excluded.scope,
      token_type=excluded.token_type,
      access_token=excluded.access_token,
      expiry_date_ms=excluded.expiry_date_ms,
      updated_at_iso=excluded.updated_at_iso`,
  )
    .bind(
      accountAddress,
      telegramUserId,
      sub,
      email,
      enc,
      token.scope ?? null,
      token.token_type ?? null,
      access || null,
      Number.isFinite(expiryMs) ? expiryMs : null,
      ts,
      ts,
    )
    .run();

  await env.DB.prepare(`DELETE FROM google_oauth_states WHERE state = ?`).bind(state).run();

  const success = (env.WEB_SUCCESS_REDIRECT_URL ?? "").trim();
  if (success) {
    const u = new URL(success);
    u.searchParams.set("googleCalendar", "connected");
    return Response.redirect(u.toString(), 302);
  }
  return new Response("Google Calendar connected. You can close this tab.", { status: 200 });
}

function chatSuccessHtml(connected: boolean) {
  const title = connected ? "Google Calendar connected" : "Google Calendar";
  const body = connected
    ? "<p>Google Calendar is connected for this gym account. You can close this tab and return to the app.</p>"
    : "<p>Use the link from your app to connect Google Calendar.</p>";
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${title}</title><style>body{font-family:system-ui,sans-serif;max-width:36rem;margin:2rem auto;padding:0 1rem;line-height:1.5}</style></head><body><h1>${title}</h1>${body}</body></html>`;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname === "/oauth/start") return handleOAuthStart(request, env);
    if (url.pathname === "/oauth/callback") return handleOAuthCallback(request, env);
    // Browser success page after OAuth — no API key (unlike /mcp)
    if (url.pathname === "/chat") {
      const connected = url.searchParams.get("googleCalendar") === "connected";
      return new Response(chatSuccessHtml(connected), {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    try {
      await requireApiKey(request, env);
    } catch {
      return new Response("Unauthorized", { status: 401 });
    }

    try {
      const server = createServer(env);
      return createMcpHandler(server, { route: "/mcp" })(request, env, ctx);
    } catch (e) {
      return new Response(jsonText({ error: String((e as any)?.message ?? e ?? "internal error") }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
  },
};

