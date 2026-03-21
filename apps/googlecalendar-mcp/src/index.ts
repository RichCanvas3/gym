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

function createServer(env: Env) {
  const server = new McpServer({ name: "Google Calendar MCP", version: "0.1.0" });

  server.tool("googlecalendar_ping", "Health check", {}, async () => {
    return { content: [{ type: "text", text: jsonText({ ok: true, asOfISO: nowISO() }) }] };
  });

  server.tool(
    "googlecalendar_get_connection_status",
    "Check whether an accountAddress has connected Google Calendar.",
    { accountAddress: z.string().min(3) },
    async (args) => {
      const p = z.object({ accountAddress: z.string().min(3) }).parse(args);
      const row = await env.DB.prepare(
        `SELECT account_address, google_email, google_sub, scope, updated_at_iso FROM google_calendar_connections WHERE account_address = ? LIMIT 1`,
      )
        .bind(p.accountAddress)
        .first();
      const connected = Boolean(row);
      return {
        content: [
          {
            type: "text",
            text: jsonText({
              connected,
              accountAddress: p.accountAddress,
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
    { accountAddress: z.string().min(3) },
    async (args) => {
      const p = z.object({ accountAddress: z.string().min(3) }).parse(args);
      const accessToken = await getAccessTokenForAccount(env, p.accountAddress);
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
      accountAddress: z.string().min(3),
      timeMinISO: z.string().min(10),
      timeMaxISO: z.string().min(10),
      q: z.string().optional(),
      maxResults: z.number().int().positive().max(50).optional(),
    },
    async (args) => {
      const p = z
        .object({
          accountAddress: z.string().min(3),
          timeMinISO: z.string().min(10),
          timeMaxISO: z.string().min(10),
          q: z.string().optional(),
          maxResults: z.number().int().positive().max(50).optional(),
        })
        .parse(args);
      const accessToken = await getAccessTokenForAccount(env, p.accountAddress);
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

  const clientId = (env.GOOGLE_CLIENT_ID ?? "").trim();
  const redirectUri = (env.OAUTH_REDIRECT_URL ?? "").trim();
  if (!clientId || !redirectUri) return new Response("Missing GOOGLE_CLIENT_ID or OAUTH_REDIRECT_URL", { status: 500 });

  const state = `st_${crypto.randomUUID()}`;
  await env.DB.prepare(`INSERT INTO google_oauth_states (state, account_address, created_at_iso) VALUES (?, ?, ?)`)
    .bind(state, accountAddress, nowISO())
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

  const st = await env.DB.prepare(`SELECT account_address FROM google_oauth_states WHERE state = ? LIMIT 1`).bind(state).first();
  if (!st) return new Response("Invalid state", { status: 400 });
  const accountAddress = String((st as any).account_address ?? "");

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
      account_address, google_sub, google_email, refresh_token_enc, scope, token_type, access_token, expiry_date_ms, created_at_iso, updated_at_iso
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_address) DO UPDATE SET
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

