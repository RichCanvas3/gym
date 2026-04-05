// Minimal local D1 typings (avoid relying on editor/workspace type resolution).
type D1Result<T = Record<string, unknown>> = { results?: T[] | null } & Record<string, unknown>;
type D1PreparedStatement = {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<Record<string, unknown>>;
};
type D1Database = { prepare(query: string): D1PreparedStatement };
export interface Env {
  DB: D1Database;
  MCP_API_KEY?: string;
  /** Optional: internal worker binding for fetching public media URLs reliably. */
  MEDIA_PROXY?: { fetch(input: Request | string, init?: RequestInit): Promise<Response> };
  /** OpenAI-compatible vision (e.g. gpt-4o-mini). */
  VISION_API_KEY?: string;
  VISION_MODEL?: string;
  VISION_OPENAI_BASE_URL?: string;
  /** Set to "0" / "false" to silence `[weight-mcp]` console logs. */
  WEIGHT_MCP_LOG?: string;
}

type Scope = {
  /** Preferred canonical id (Privy canonical accountAddress), e.g. acct:privy_... */
  accountAddress?: string;
  /** Back-compat: Telegram numeric user id as string (e.g. "6105195555"). */
  telegramUserId?: string;
};

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
};

function sseJson(data: unknown): string {
  return `event: message\ndata: ${JSON.stringify(data)}\n\n`;
}

function okResult(id: number | string, text: string, extra?: Record<string, unknown>) {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text }],
      ...(extra ?? {}),
    },
  };
}

function errResult(id: number | string, code: number, message: string, data?: unknown) {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init.headers ?? {}),
    },
  });
}

function cors(req: Request): HeadersInit {
  const origin = req.headers.get("origin") ?? "*";
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST,OPTIONS",
    "access-control-allow-headers": "content-type,x-api-key",
    "access-control-max-age": "86400",
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}


function requireAuth(req: Request, env: Env) {
  const expected = (env.MCP_API_KEY ?? "").trim();
  if (!expected) throw new Error("Server misconfigured: MCP_API_KEY missing");
  const got = (req.headers.get("x-api-key") ?? "").trim();
  if (!got || got !== expected) throw new Response("Unauthorized", { status: 401 });
}

function weightMcpLogEnabled(env: Env): boolean {
  const v = (env.WEIGHT_MCP_LOG ?? "").trim().toLowerCase();
  if (v === "0" || v === "false" || v === "off" || v === "no") return false;
  return true;
}

function weightMcpLog(env: Env, event: string, detail?: Record<string, unknown>): void {
  if (!weightMcpLogEnabled(env)) return;
  const extra = detail && Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : "";
  console.log(`[weight-mcp] ${event}${extra}`);
}

/** Safe args summary for logs (no raw base64). */
function imageUrlKindForLog(url: unknown): "telegram_cdn" | "https" | "none" {
  if (typeof url !== "string" || !url.trim()) return "none";
  if (/api\.telegram\.org\/file\/bot/i.test(url)) return "telegram_cdn";
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? "https" : "none";
  } catch {
    return "none";
  }
}

function summarizeWeightToolArgs(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const sc = isRecord(args.scope) ? args.scope : null;
  const scopeHint = sc
    ? {
        telegramUserId:
          typeof (sc as any).telegramUserId === "string"
            ? String((sc as any).telegramUserId).trim()
            : typeof (sc as any).telegram_user_id === "string"
              ? String((sc as any).telegram_user_id).trim()
              : undefined,
      }
    : {};

  if (name === "weight_analyze_meal_photo") {
    const sr = isRecord(args.sourceRef) ? args.sourceRef : null;
    const b64len = typeof args.imageBase64 === "string" ? args.imageBase64.length : 0;
    return {
      ...scopeHint,
      imageBase64_chars: b64len,
      imageUrl_kind: imageUrlKindForLog(args.imageUrl),
      sourceRef_chatId: sr && typeof sr.chatId === "string" ? sr.chatId : undefined,
      sourceRef_messageId: sr && typeof sr.messageId === "number" ? sr.messageId : undefined,
    };
  }

  if (name === "weight_log_food_from_analysis") {
    const aid = normStr(args.analysisId);
    return {
      ...scopeHint,
      analysisId_prefix: aid ? `${aid.slice(0, 8)}…` : "",
      mode: args.mode,
    };
  }

  const keys = Object.keys(args).filter((k) => k !== "scope");
  return { ...scopeHint, argKeys: keys.slice(0, 14) };
}

function nowMs(): number {
  return Date.now();
}

function scopeId(scope: Scope): string {
  const acct = typeof scope.accountAddress === "string" ? scope.accountAddress.trim() : "";
  if (acct) return acct;
  const tg = typeof scope.telegramUserId === "string" ? scope.telegramUserId.trim() : "";
  if (!tg) throw new Error("Missing scope.accountAddress or scope.telegramUserId");
  return `tg:${tg}`;
}

async function migrateScopeId(env: Env, fromScopeId: string, toScopeId: string): Promise<{ ok: true; migrated: boolean; fromScopeId: string; toScopeId: string; tablesUpdated: number }> {
  const from = String(fromScopeId ?? "").trim();
  const to = String(toScopeId ?? "").trim();
  if (!from || !to || from === to) return { ok: true, migrated: false, fromScopeId: from, toScopeId: to, tablesUpdated: 0 };

  const mergeJsonObjects = (leftRaw: string | null, rightRaw: string | null): string => {
    let left: Record<string, unknown> = {};
    let right: Record<string, unknown> = {};
    try {
      const parsed = leftRaw ? JSON.parse(leftRaw) : {};
      left = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      left = {};
    }
    try {
      const parsed = rightRaw ? JSON.parse(rightRaw) : {};
      right = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      right = {};
    }
    // Preserve newer acct-scoped writes when both rows exist.
    return JSON.stringify({ ...left, ...right });
  };

  const tables = [
    "wm_events",
    "wm_profiles",
    "wm_food_entries",
    "wm_food_items",
    "wm_meal_analyses",
    "wm_exercise_entries",
    "wm_photos",
    "wm_water_log",
    "wm_fast_windows",
    "wm_daily_targets",
  ];
  let updated = 0;
  for (const t of tables) {
    if (t === "wm_profiles") {
      const fromRow = await env.DB.prepare(`SELECT scope_json, profile_json, updated_at FROM wm_profiles WHERE scope_id=?1 LIMIT 1`)
        .bind(from)
        .first<{ scope_json: string | null; profile_json: string | null; updated_at: number | null }>();
      if (fromRow) {
        const toRow = await env.DB.prepare(`SELECT scope_json, profile_json, updated_at FROM wm_profiles WHERE scope_id=?1 LIMIT 1`)
          .bind(to)
          .first<{ scope_json: string | null; profile_json: string | null; updated_at: number | null }>();
        if (toRow) {
          const mergedScope = mergeJsonObjects(fromRow.scope_json, toRow.scope_json);
          const mergedProfile = mergeJsonObjects(fromRow.profile_json, toRow.profile_json);
          const mergedUpdatedAt = Math.max(Number(fromRow.updated_at ?? 0), Number(toRow.updated_at ?? 0), nowMs());
          await env.DB.prepare(`UPDATE wm_profiles SET scope_json=?1, profile_json=?2, updated_at=?3 WHERE scope_id=?4`)
            .bind(mergedScope, mergedProfile, mergedUpdatedAt, to)
            .run();
          await env.DB.prepare(`DELETE FROM wm_profiles WHERE scope_id=?1`).bind(from).run();
        } else {
          await env.DB.prepare(`UPDATE wm_profiles SET scope_id=?1 WHERE scope_id=?2`).bind(to, from).run();
        }
      }
      updated += 1;
      continue;
    }
    if (t === "wm_daily_targets") {
      const fromRow = await env.DB.prepare(`SELECT targets_json, updated_at FROM wm_daily_targets WHERE scope_id=?1 LIMIT 1`)
        .bind(from)
        .first<{ targets_json: string | null; updated_at: number | null }>();
      if (fromRow) {
        const toRow = await env.DB.prepare(`SELECT targets_json, updated_at FROM wm_daily_targets WHERE scope_id=?1 LIMIT 1`)
          .bind(to)
          .first<{ targets_json: string | null; updated_at: number | null }>();
        if (toRow) {
          const mergedTargets = mergeJsonObjects(fromRow.targets_json, toRow.targets_json);
          const mergedUpdatedAt = Math.max(Number(fromRow.updated_at ?? 0), Number(toRow.updated_at ?? 0), nowMs());
          await env.DB.prepare(`UPDATE wm_daily_targets SET targets_json=?1, updated_at=?2 WHERE scope_id=?3`)
            .bind(mergedTargets, mergedUpdatedAt, to)
            .run();
          await env.DB.prepare(`DELETE FROM wm_daily_targets WHERE scope_id=?1`).bind(from).run();
        } else {
          await env.DB.prepare(`UPDATE wm_daily_targets SET scope_id=?1 WHERE scope_id=?2`).bind(to, from).run();
        }
      }
      updated += 1;
      continue;
    }
    await env.DB.prepare(`UPDATE ${t} SET scope_id=?1 WHERE scope_id=?2`).bind(to, from).run();
    updated += 1;
  }
  return { ok: true, migrated: true, fromScopeId: from, toScopeId: to, tablesUpdated: updated };
}

async function maybeAutoMigrateLegacyAcctScope(env: Env, toScopeId: string): Promise<{ migrated: boolean; fromScopeId: string | null }> {
  const sid = String(toScopeId ?? "").trim();
  if (!sid.startsWith("acct:")) return { migrated: false, fromScopeId: null };

  // If we already have scoped rows, do nothing.
  const anyScoped = await env.DB.prepare(`SELECT 1 FROM wm_food_entries WHERE scope_id=?1 LIMIT 1`).bind(sid).first();
  if (anyScoped) return { migrated: false, fromScopeId: null };

  // Single-user migration assist: if there is exactly one tg:* scope present, migrate it to acct:*.
  const legacy = await env.DB.prepare(`SELECT DISTINCT scope_id FROM wm_food_entries WHERE scope_id LIKE 'tg:%' LIMIT 3`).all<{ scope_id: string }>();
  const ids = (legacy.results ?? []).map((r: any) => String(r?.scope_id ?? "").trim()).filter(Boolean);
  const uniq = Array.from(new Set(ids));
  if (uniq.length !== 1) return { migrated: false, fromScopeId: null };
  const from = uniq[0]!;
  await migrateScopeId(env, from, sid);
  return { migrated: true, fromScopeId: from };
}

function normStr(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t : null;
}

async function latestWeightKg(env: Env, sid: string, atMsUpperBound: number | null): Promise<number | null> {
  // Weight is stored in wm_profiles.profile_json (wm_weights table is deprecated/removed).
  void atMsUpperBound;
  const prow = await env.DB.prepare(`SELECT profile_json FROM wm_profiles WHERE scope_id=?1 LIMIT 1`)
    .bind(sid)
    .first<{ profile_json: string | null }>();
  const pjson = prow && typeof (prow as any).profile_json === "string" ? String((prow as any).profile_json) : "";
  if (!pjson) return null;
  try {
    const p = JSON.parse(pjson);
    if (!p || typeof p !== "object") return null;
    const anyP: any = p as any;
    const kg2 =
      (typeof anyP.weight_kg === "number" && Number.isFinite(anyP.weight_kg) ? Number(anyP.weight_kg) : null) ??
      (typeof anyP.weightKg === "number" && Number.isFinite(anyP.weightKg) ? Number(anyP.weightKg) : null) ??
      (typeof anyP.body_weight_kg === "number" && Number.isFinite(anyP.body_weight_kg) ? Number(anyP.body_weight_kg) : null) ??
      (typeof anyP.bodyWeightKg === "number" && Number.isFinite(anyP.bodyWeightKg) ? Number(anyP.bodyWeightKg) : null);
    if (kg2 != null && kg2 > 0) return kg2;
    const lb =
      (typeof anyP.weight_lb === "number" && Number.isFinite(anyP.weight_lb) ? Number(anyP.weight_lb) : null) ??
      (typeof anyP.weightLb === "number" && Number.isFinite(anyP.weightLb) ? Number(anyP.weightLb) : null) ??
      (typeof anyP.bodyWeightLb === "number" && Number.isFinite(anyP.bodyWeightLb) ? Number(anyP.bodyWeightLb) : null);
    if (lb != null && lb > 0) return lb * 0.45359237;
    return null;
  } catch {
    return null;
  }
}

function estimateExerciseKcal(args: {
  activityType: unknown;
  durationSeconds: unknown;
  distanceMeters: unknown;
  weightKg: number;
}): number | null {
  const w = args.weightKg;
  if (!Number.isFinite(w) || w <= 0) return null;

  const typ = typeof args.activityType === "string" ? args.activityType.trim().toLowerCase() : "";
  const dur = typeof args.durationSeconds === "number" && Number.isFinite(args.durationSeconds) ? Math.max(0, Math.trunc(args.durationSeconds)) : 0;
  const distM = typeof args.distanceMeters === "number" && Number.isFinite(args.distanceMeters) ? Number(args.distanceMeters) : 0;

  // Prefer distance-based for run/walk when distance is present.
  if (distM > 0) {
    const km = distM / 1000.0;
    if (typ.includes("run") || typ.includes("jog")) return Math.round(w * km * 1.0);
    if (typ.includes("walk") || typ.includes("hike")) return Math.round(w * km * 0.6);
  }

  if (dur > 0) {
    const hours = dur / 3600.0;
    // Simple MET mapping (coarse). kcal ≈ MET * kg * hours
    let met = 5.0;
    if (typ.includes("walk")) met = 3.3;
    else if (typ.includes("run")) met = 9.8;
    else if (typ.includes("ride") || typ.includes("bike") || typ.includes("cycle")) met = 8.0;
    else if (typ.includes("swim")) met = 8.0;
    else if (typ.includes("strength") || typ.includes("weight") || typ.includes("workout")) met = 6.0;
    return Math.round(met * w * hours);
  }

  return null;
}

/** Optional correlation IDs (e.g. chat + message from an external app); stored in DB columns, opaque to this worker. */
function parseSourceRef(args: Record<string, unknown>): { chatId: string | null; messageId: number | null } {
  const r = isRecord(args.sourceRef) ? (args.sourceRef as Record<string, unknown>) : null;
  if (!r) return { chatId: null, messageId: null };
  return {
    chatId: normStr(r.chatId),
    messageId: typeof r.messageId === "number" ? Math.trunc(r.messageId) : null,
  };
}

const MAX_MEAL_IMAGE_BYTES = 8 * 1024 * 1024;

/** Optional https image reference — fetched server-side and converted to bytes (never passed to vision as http). */
function isFetchableHttpsImageUrl(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  try {
    const u = new URL(t);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function mediaTokenFromTelegramUrl(url: string): string | null {
  try {
    const path = new URL(url).pathname;
    if (!path.startsWith("/telegram/media/")) return null;
    const token = path.replace(/^\/telegram\/media\//, "").split("/")[0]?.trim() ?? "";
    return token || null;
  } catch {
    return null;
  }
}

async function fetchHttpUrlAsDataUrl(url: string, env: Env): Promise<string> {
  const mediaTok = mediaTokenFromTelegramUrl(url);
  let effectiveUrl = url;
  // Worker->Worker fetches can see stale/cached edge errors; cache-bust Telegram media proxy URLs.
  // This is a single request (no retry) but avoids “stuck 404” artifacts.
  try {
    const u = new URL(url);
    if (u.pathname.startsWith("/telegram/media/")) {
      u.searchParams.set("cb", String(Date.now()));
      effectiveUrl = u.toString();
    }
  } catch {
    // ignore parse errors; fetch will throw later
  }
  try {
    const u = new URL(url);
    weightMcpLog(env, "meal_photo/fetch_image", {
      host: u.hostname,
      media_token_len: mediaTok?.length,
      media_token_prefix: mediaTok ? `${mediaTok.slice(0, 8)}…` : undefined,
    });
  } catch {
    /* ignore */
  }
  // Mimic curl; also ask fetch not to store/reuse a cached response.
  // Some Cloudflare accounts restrict worker->workers.dev subrequests; prefer service binding when available.
  const fetchFn =
    env.MEDIA_PROXY && (() => {
      try {
        const u = new URL(effectiveUrl);
        if (u.hostname === "gym-telegram-mcp.richardpedersen3.workers.dev") return env.MEDIA_PROXY!.fetch.bind(env.MEDIA_PROXY);
      } catch {
        /* ignore */
      }
      return null;
    })();
  const r = await (fetchFn ? fetchFn(effectiveUrl, {
    method: "GET",
    redirect: "follow",
    cache: "no-store",
    headers: {
      "User-Agent": "curl/8.5.0",
      Accept: "*/*",
    },
  } as RequestInit) : fetch(effectiveUrl, {
    method: "GET",
    redirect: "follow",
    cache: "no-store",
    headers: {
      "User-Agent": "curl/8.5.0",
      Accept: "*/*",
    },
  } as RequestInit));
  if (!r.ok) {
    let hint = "";
    if (r.status === 404) {
      try {
        if (new URL(url).pathname.startsWith("/telegram/media/")) {
          hint =
            " (media proxy: unknown token or URL — verify GET works with curl; public URLs need no auth)";
          weightMcpLog(env, "meal_photo/fetch_image_failed", {
            status: 404,
            imageUrl: url.slice(0, 180),
            media_token_len: mediaTok?.length,
          });
        }
      } catch {
        /* ignore */
      }
    }
    throw new Error(`fetch image HTTP ${r.status}${hint}`);
  }
  const buf = new Uint8Array(await r.arrayBuffer());
  if (buf.length > MAX_MEAL_IMAGE_BYTES) {
    throw new Error(`image too large (${buf.length} bytes; max ${MAX_MEAL_IMAGE_BYTES})`);
  }
  const ctRaw = (r.headers.get("content-type") ?? "image/jpeg").split(";")[0]!.trim();
  const mime = ctRaw.startsWith("image/") ? ctRaw : "image/jpeg";
  return `data:${mime};base64,${uint8ToBase64(buf)}`;
}

function parseScope(params: Record<string, unknown>): Scope {
  const s = isRecord(params.scope) ? (params.scope as Record<string, unknown>) : {};
  const accountAddress =
    typeof (s as any).accountAddress === "string"
      ? String((s as any).accountAddress).trim()
      : typeof (s as any).canonicalAddress === "string"
        ? String((s as any).canonicalAddress).trim()
        : "";
  const telegramUserId =
    typeof (s as any).telegramUserId === "string"
      ? String((s as any).telegramUserId).trim()
      : typeof (s as any).telegram_user_id === "string"
        ? String((s as any).telegram_user_id).trim()
        : "";
  if (!accountAddress && !telegramUserId) throw new Error("Missing scope.accountAddress (preferred) or scope.telegramUserId");
  return { ...(accountAddress ? { accountAddress } : {}), ...(telegramUserId ? { telegramUserId } : {}) };
}

function parseAtMs(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && v.trim()) {
    const ms = Date.parse(v);
    if (Number.isFinite(ms)) return ms;
  }
  return nowMs();
}

function numOrNull(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return v;
}

type MealLabel = "breakfast" | "lunch" | "dinner" | "snack";

function safeTzName(tzName: string | null | undefined): string {
  const tz = (tzName ?? "").trim();
  return tz || "UTC";
}

function localHour(atMs: number, tzName: string | null | undefined): number | null {
  const tz = safeTzName(tzName);
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "2-digit",
      hour12: false,
    }).formatToParts(new Date(atMs));
    const hh = parts.find((p) => p.type === "hour")?.value ?? "";
    const n = Number.parseInt(hh, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    try {
      const hh = new Date(atMs).getUTCHours();
      return Number.isFinite(hh) ? hh : null;
    } catch {
      return null;
    }
  }
}

function localDateISO(atMs: number, tzName: string | null | undefined): string {
  const tz = safeTzName(tzName);
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(atMs));
    const y = parts.find((p) => p.type === "year")?.value ?? "1970";
    const m = parts.find((p) => p.type === "month")?.value ?? "01";
    const d = parts.find((p) => p.type === "day")?.value ?? "01";
    return `${y}-${m}-${d}`;
  } catch {
    return new Date(atMs).toISOString().slice(0, 10);
  }
}

function getTzOffsetMs(date: Date, tzName: string): number {
  // Returns offset = (formatted-in-tz-as-UTC - actual-utc) in ms.
  // Inspired by date-fns-tz approach; works with DST transitions.
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tzName,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = dtf.formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const asUTC = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUTC - date.getTime();
}

function zonedMidnightUtcMs(dateISO: string, tzNameRaw: string | null | undefined): number {
  const tzName = safeTzName(tzNameRaw);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((dateISO || "").trim());
  if (!m) return Date.parse(`${dateISO}T00:00:00.000Z`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  // Start with naive UTC midnight for the same date, then adjust by the timezone offset at that instant.
  const guess = new Date(Date.UTC(y, mo - 1, d, 0, 0, 0));
  const offset = getTzOffsetMs(guess, tzName);
  return guess.getTime() - offset;
}

function dayWindowUtcMsFromLocalDate(dateISO: string, tzName: string | null | undefined): { startMs: number; endMs: number } {
  const startMs = zonedMidnightUtcMs(dateISO, tzName);
  const nextISO = new Date(Date.UTC(Number(dateISO.slice(0, 4)), Number(dateISO.slice(5, 7)) - 1, Number(dateISO.slice(8, 10)) + 1))
    .toISOString()
    .slice(0, 10);
  const endMs = zonedMidnightUtcMs(nextISO, tzName);
  return { startMs, endMs };
}

function coerceMealLabel(v: unknown): MealLabel | null {
  if (typeof v !== "string") return null;
  const t = v.trim().toLowerCase();
  if (t === "breakfast" || t === "lunch" || t === "dinner" || t === "snack") return t;
  return null;
}

function inferMealLabel(atMs: number, tzName: string | null | undefined, text?: string | null): MealLabel {
  const t = (text ?? "").trim().toLowerCase();
  if (t.includes("breakfast")) return "breakfast";
  if (t.includes("lunch")) return "lunch";
  if (t.includes("dinner")) return "dinner";
  if (t.includes("snack")) return "snack";

  const h = localHour(atMs, tzName);
  if (h == null) return "snack";
  if (h >= 4 && h <= 10) return "breakfast";
  if (h >= 11 && h <= 15) return "lunch";
  if (h >= 16 && h <= 21) return "dinner";
  return "snack";
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  let out = "";
  for (const b of hash) out += b.toString(16).padStart(2, "0");
  return out;
}

function looksLikeWeightText(text: string): boolean {
  const t = (text || "").trim().toLowerCase();
  if (!t || t.startsWith("/") || t.startsWith("__")) return false;
  if (t.includes(" lb") || t.includes(" lbs") || t.includes("kg") || t.includes("pounds")) return true;
  if (t.includes("weight")) return /\b\d{2,3}(\.\d)?\b/.test(t);
  return false;
}

function parseWeightFromText(text: string): { weightKg: number | null; weightLb: number | null } {
  const t = (text || "").trim().toLowerCase();
  if (!t) return { weightKg: null, weightLb: null };
  const kgm = t.match(/\b(\d{2,3}(?:\.\d)?)\s*(kg|kgs|kilograms?)\b/);
  if (kgm?.[1]) {
    const n = Number.parseFloat(kgm[1]);
    return { weightKg: Number.isFinite(n) ? n : null, weightLb: null };
  }
  const lbm = t.match(/\b(\d{2,3}(?:\.\d)?)\s*(lb|lbs|pounds?)\b/);
  if (lbm?.[1]) {
    const n = Number.parseFloat(lbm[1]);
    return { weightKg: null, weightLb: Number.isFinite(n) ? n : null };
  }
  if (t.includes("weight")) {
    const m = t.match(/\b(\d{2,3}(?:\.\d)?)\b/);
    if (m?.[1]) {
      const n = Number.parseFloat(m[1]);
      return { weightKg: null, weightLb: Number.isFinite(n) ? n : null };
    }
  }
  return { weightKg: null, weightLb: null };
}

function looksLikeMealText(text: string): boolean {
  const t = (text || "").trim().toLowerCase();
  if (!t || t.startsWith("/") || t.startsWith("__")) return false;
  if (t.length < 6) return false;
  if (t.includes("add to my meals") || t.includes("add that to my meals") || t.includes("log this")) return true;
  if (t.includes("breakfast") || t.includes("lunch") || t.includes("dinner") || t.includes("snack")) return true;
  const foodish = ["eggs", "toast", "oatmeal", "coffee", "banana", "apple", "salad", "chicken", "rice", "yogurt", "sandwich", "ice cream"];
  return foodish.some((w) => t.includes(w));
}

type MealAnalysisJson = {
  items?: Array<{
    name?: string;
    portion_g?: number | null;
    calories?: number;
    protein_g?: number;
    carbs_g?: number;
    fat_g?: number;
    fiber_g?: number | null;
    notes?: string;
  }>;
  totals?: {
    calories?: number;
    protein_g?: number;
    carbs_g?: number;
    fat_g?: number;
    fiber_g?: number | null;
  };
  confidence?: number;
  notes?: string;
};

function looksGenericVisionNotes(s: string): boolean {
  const t = s.trim().toLowerCase();
  if (!t) return true;
  if (t.startsWith("estimat")) return true;
  if (t.includes("typical serving") || t.includes("typical portion") || t.includes("common ingredients")) return true;
  return false;
}

function mealSummaryFromAnalysis(analysis: MealAnalysisJson): string {
  const rawNames = Array.isArray(analysis.items)
    ? analysis.items
        .map((it) => (typeof it?.name === "string" ? it.name.trim() : ""))
        .filter((x) => x)
    : [];
  const seen = new Set<string>();
  const names: string[] = [];
  for (const n of rawNames) {
    const k = n.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    names.push(n);
    if (names.length >= 4) break;
  }
  if (names.length) return `Photo meal: ${names.join(", ")}`;
  const notes = typeof analysis.notes === "string" ? analysis.notes.trim() : "";
  if (notes && !looksGenericVisionNotes(notes)) return notes;
  return "Meal (from photo analysis)";
}

async function insertFoodItems(
  env: Env,
  sid: string,
  foodEntryId: string,
  at_ms: number,
  meal: string | null,
  items: unknown,
  source: string | null,
  createdAt: number,
): Promise<number> {
  if (!Array.isArray(items) || !items.length) return 0;
  let n = 0;
  for (const it of items.slice(0, 20)) {
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    const name = typeof o.name === "string" ? o.name.trim() : "";
    if (!name) continue;
    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO wm_food_items
       (id, scope_id, food_entry_id, at_ms, meal, name, portion_g, calories, protein_g, carbs_g, fat_g, fiber_g, source, created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)`,
    )
      .bind(
        id,
        sid,
        foodEntryId,
        at_ms,
        meal,
        name,
        typeof o.portion_g === "number" && Number.isFinite(o.portion_g) ? o.portion_g : null,
        typeof o.calories === "number" && Number.isFinite(o.calories) ? o.calories : null,
        typeof o.protein_g === "number" && Number.isFinite(o.protein_g) ? o.protein_g : null,
        typeof o.carbs_g === "number" && Number.isFinite(o.carbs_g) ? o.carbs_g : null,
        typeof o.fat_g === "number" && Number.isFinite(o.fat_g) ? o.fat_g : null,
        typeof o.fiber_g === "number" && Number.isFinite(o.fiber_g) ? o.fiber_g : null,
        source,
        createdAt,
      )
      .run();
    n++;
  }
  return n;
}

type MealTextAnalysisJson = {
  meal?: string | null;
  /** If the text mentions a different time than the base timestamp, return the corrected absolute timestamp (prefer Z/UTC ISO). */
  atISO?: string | null;
  items?: Array<{
    name?: string;
    portion_g?: number | null;
    calories?: number;
    protein_g?: number;
    carbs_g?: number;
    fat_g?: number;
    fiber_g?: number | null;
    notes?: string;
  }>;
  totals?: {
    calories?: number;
    protein_g?: number;
    carbs_g?: number;
    fat_g?: number;
    fiber_g?: number | null;
  };
  confidence?: number;
  notes?: string;
};

async function visionAnalyzeMealPhoto(
  env: Env,
  imageDataUrl: string,
  meal?: string | null,
  locale?: string | null,
): Promise<MealAnalysisJson> {
  const key = env.VISION_API_KEY?.trim();
  if (!key) throw new Error("VISION_API_KEY not configured on weight-management-mcp");
  const baseRaw = (env.VISION_OPENAI_BASE_URL ?? "https://api.openai.com/v1").trim().replace(/\/$/, "");
  let base: string;
  try {
    const u = new URL(baseRaw);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("not http(s)");
    base = baseRaw;
  } catch {
    throw new Error(
      `VISION_OPENAI_BASE_URL must be an absolute http(s) URL; could not parse: ${baseRaw.slice(0, 96)}`,
    );
  }
  const model = env.VISION_MODEL ?? "gpt-4o-mini";
  const system = `You are a nutrition estimation assistant. Return ONLY valid JSON with this exact shape:
{"items":[{"name":"string","portion_g":null,"calories":0,"protein_g":0,"carbs_g":0,"fat_g":0,"fiber_g":null,"notes":""}],
"totals":{"calories":0,"protein_g":0,"carbs_g":0,"fat_g":0,"fiber_g":null},
"confidence":0.5,
"notes":""}
Use realistic estimates; set confidence 0–1 based on image clarity and ambiguity.`;

  const ctxLines = [meal ? `Meal context: ${meal}` : null, locale ? `Locale/prefs: ${locale}` : null].filter(Boolean);
  const userText = ctxLines.length ? ctxLines.join("\n") : "Estimate nutrition for this meal photo.";
  const userContent: Array<Record<string, unknown>> = [{ type: "text", text: userText }];
  // Vision input is always a data URL (bytes); we never send remote http(s) image URLs to the model.
  if (!imageDataUrl.startsWith("data:")) {
    throw new Error("vision: internal error — expected data: URL");
  }
  userContent.push({ type: "image_url", image_url: { url: imageDataUrl } });

  const body = {
    model,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: userContent },
    ],
  };

  const resp = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`vision HTTP ${resp.status}: ${t.slice(0, 600)}`);
  }
  const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("vision: empty content");
  try {
    return JSON.parse(content) as MealAnalysisJson;
  } catch {
    throw new Error("vision: invalid JSON");
  }
}

async function visionAnalyzeMealText(
  env: Env,
  text: string,
  baseAtISO: string,
  tzName?: string | null,
): Promise<MealTextAnalysisJson> {
  const key = env.VISION_API_KEY?.trim();
  if (!key) throw new Error("VISION_API_KEY not configured on weight-management-mcp");
  const baseRaw = (env.VISION_OPENAI_BASE_URL ?? "https://api.openai.com/v1").trim().replace(/\/$/, "");
  let base: string;
  try {
    const u = new URL(baseRaw);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("not http(s)");
    base = baseRaw;
  } catch {
    throw new Error(`VISION_OPENAI_BASE_URL must be an absolute http(s) URL; could not parse: ${baseRaw.slice(0, 96)}`);
  }
  const model = env.VISION_MODEL ?? "gpt-4o-mini";
  const system = `You extract meal logs from casual text.\nReturn ONLY valid JSON with this exact shape:\n{\n  \"meal\": \"breakfast\"|\"lunch\"|\"dinner\"|\"snack\"|null,\n  \"atISO\": \"<ISO timestamp (prefer Z/UTC)>\"|null,\n  \"items\": [{\"name\":\"string\",\"portion_g\":null,\"calories\":0,\"protein_g\":0,\"carbs_g\":0,\"fat_g\":0,\"fiber_g\":null,\"notes\":\"\"}],\n  \"totals\": {\"calories\":0,\"protein_g\":0,\"carbs_g\":0,\"fat_g\":0,\"fiber_g\":null},\n  \"confidence\": 0.5,\n  \"notes\": \"\"\n}\nRules:\n- Use the provided BaseAtISO + Timezone as the default time.\n- If the text mentions a different time (e.g. \"around 9am\"), set atISO to the corrected absolute timestamp for that same local date.\n- If you can't estimate macros, set them to 0 but still estimate calories when possible.\n- Confidence 0–1 based on ambiguity.`;
  const user = `BaseAtISO: ${baseAtISO}\nTimezone: ${(tzName ?? "").trim() || "unknown"}\nText: ${text}`;
  const body = {
    model,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };

  const resp = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`meal_text HTTP ${resp.status}: ${t.slice(0, 600)}`);
  }
  const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("meal_text: empty content");
  try {
    return JSON.parse(content) as MealTextAnalysisJson;
  } catch {
    throw new Error("meal_text: invalid JSON");
  }
}

async function lookupBarcodeOpenFoodFacts(barcode: string): Promise<unknown> {
  const clean = barcode.replace(/\s/g, "");
  if (!/^\d{8,14}$/.test(clean)) throw new Error("Invalid barcode (expect 8–14 digits)");
  const url = `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(clean)}.json`;
  const r = await fetch(url, { headers: { "user-agent": "gym-weight-management-mcp/0.1 (contact: local)" } });
  if (!r.ok) throw new Error(`OpenFoodFacts HTTP ${r.status}`);
  return r.json() as Promise<unknown>;
}

function toolList() {
  const scopeSchema = {
    type: "object",
    properties: {
      accountAddress: { type: "string", description: "Preferred canonical id (Privy accountAddress), e.g. 'acct:privy_...'." },
      telegramUserId: { type: "string", description: "Telegram numeric user id as string (e.g. '6105195555')." },
    },
    anyOf: [{ required: ["accountAddress"] }, { required: ["telegramUserId"] }],
  };

  return [
    { name: "weight_ping", description: "Health check", inputSchema: { type: "object", properties: {} } },
    {
      name: "weight_ingest_telegram_message",
      description:
        "Ingest a Telegram message (text and/or photo URL) into weight-management. Idempotent by (scope, chatId, messageId). Writes an audit row to wm_events.",
      inputSchema: {
        type: "object",
        properties: {
          scope: scopeSchema,
          tzName: { type: "string", description: "IANA timezone name (e.g. America/Denver) for meal labeling." },
          chatId: { type: "string" },
          messageId: { type: "number" },
          dateUnix: { type: "number", description: "Telegram message unix seconds." },
          atMs: { type: "number", description: "Message time in ms since epoch." },
          text: { type: "string" },
          imageUrl: { type: "string", description: "Public HTTPS URL for the photo (e.g. telegram-mcp media URL)." },
          locale: { type: "string" },
          meal: { type: "string", description: "Optional override (breakfast/lunch/dinner/snack) for photo analysis." },
        },
        required: ["scope", "chatId", "messageId"],
      },
    },
    {
      name: "weight_profile_get",
      description: "Get weight-management profile/settings for this scope.",
      inputSchema: { type: "object", properties: { scope: scopeSchema }, required: ["scope"] },
    },
    {
      name: "weight_profile_upsert",
      description: "Upsert weight-management profile/settings for this scope (targets, preferences).",
      inputSchema: {
        type: "object",
        properties: { scope: scopeSchema, profile: { type: "object" } },
        required: ["scope", "profile"],
      },
    },
    {
      name: "weight_log_weight",
      description: "Log a weigh-in (kg or lb) with optional body fat and notes.",
      inputSchema: {
        type: "object",
        properties: {
          scope: scopeSchema,
          atISO: { type: "string" },
          atMs: { type: "number" },
          weightKg: { type: "number" },
          weightLb: { type: "number" },
          bodyFatPct: { type: "number" },
          notes: { type: "string" },
          source: { type: "string" },
          sourceRef: {
            type: "object",
            description: "Optional opaque correlation (e.g. external chat + message id).",
            properties: { chatId: { type: "string" }, messageId: { type: "number" } },
          },
        },
        required: ["scope"],
      },
    },
    {
      name: "weight_list_weights",
      description: "List weigh-ins for a scope in a time window.",
      inputSchema: {
        type: "object",
        properties: {
          scope: scopeSchema,
          fromISO: { type: "string" },
          toISO: { type: "string" },
          limit: { type: "number" },
        },
        required: ["scope"],
      },
    },
    {
      name: "weight_log_food",
      description: "Log a food entry (text + optional calories/macros).",
      inputSchema: {
        type: "object",
        properties: {
          scope: scopeSchema,
          atISO: { type: "string" },
          atMs: { type: "number" },
          meal: { type: "string" },
          text: { type: "string" },
          imageUrl: { type: "string", description: "Optional public image URL associated with this food entry." },
          calories: { type: "number" },
          protein_g: { type: "number" },
          carbs_g: { type: "number" },
          fat_g: { type: "number" },
          fiber_g: { type: "number" },
          sugar_g: { type: "number" },
          sodium_mg: { type: "number" },
          source: { type: "string" },
          analysisId: { type: "string" },
          sourceRef: {
            type: "object",
            properties: { chatId: { type: "string" }, messageId: { type: "number" } },
          },
        },
        required: ["scope", "text"],
      },
    },
    {
      name: "weight_log_meal_from_text",
      description:
        "Interpret a casual meal text (e.g. from Telegram), estimate calories/macros, time-tag, and persist both wm_meal_analyses + wm_food_entries. Optional sourceRef provides idempotency.",
      inputSchema: {
        type: "object",
        properties: {
          scope: scopeSchema,
          text: { type: "string" },
          atISO: {
            type: "string",
            description: "Base timestamp (e.g. message time). If text mentions a different time, worker may adjust.",
          },
          atMs: { type: "number" },
          tzName: { type: "string", description: "IANA tz name (e.g. America/Denver) to interpret times like '9am'." },
          meal: { type: "string", description: "Optional override (breakfast/lunch/dinner/snack). If omitted, extracted from text." },
          source: { type: "string" },
          sourceRef: {
            type: "object",
            properties: { chatId: { type: "string" }, messageId: { type: "number" } },
          },
        },
        required: ["scope", "text"],
      },
    },
    {
      name: "weight_list_food",
      description: "List food entries for a scope in a time window.",
      inputSchema: {
        type: "object",
        properties: { scope: scopeSchema, fromISO: { type: "string" }, toISO: { type: "string" }, limit: { type: "number" } },
        required: ["scope"],
      },
    },
    {
      name: "weight_meal_trends",
      description:
        "Summarize meals over a date range: per-day totals, per-meal totals, and top foods per meal type (from wm_food_items).",
      inputSchema: {
        type: "object",
        properties: {
          scope: scopeSchema,
          fromISO: { type: "string" },
          toISO: { type: "string" },
          tzName: { type: "string", description: "IANA tz name (e.g. America/Denver) for day bucketing." },
          topN: { type: "number", description: "Max top foods per meal type (default 8)." },
        },
        required: ["scope", "tzName"],
      },
    },
    {
      name: "weight_ingest_workout",
      description:
        "Ingest a workout (e.g. from Strava) as an exercise calorie-burn entry. Idempotent by (scope, source, workoutId).",
      inputSchema: {
        type: "object",
        properties: {
          scope: scopeSchema,
          source: { type: "string", description: "e.g. strava" },
          workoutId: { type: "string", description: "Stable workout id (e.g. strava-123)" },
          startedAtISO: { type: "string" },
          atMs: { type: "number" },
          activityType: { type: "string" },
          durationSeconds: { type: "number" },
          distanceMeters: { type: "number" },
          activeEnergyKcal: { type: "number" },
          raw: { type: "object", description: "Optional raw workout JSON for traceability." },
        },
        required: ["scope", "source", "workoutId"],
      },
    },
    {
      name: "weight_log_photo",
      description: "Log a photo reference (HTTPS URL) with optional opaque sourceRef for correlation.",
      inputSchema: {
        type: "object",
        properties: {
          scope: scopeSchema,
          atISO: { type: "string" },
          atMs: { type: "number" },
          kind: { type: "string" },
          caption: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          sourceRef: {
            type: "object",
            properties: { chatId: { type: "string" }, messageId: { type: "number" } },
          },
          photoUrl: { type: "string" },
        },
        required: ["scope", "kind"],
      },
    },
    {
      name: "weight_list_photos",
      description: "List logged photos for a scope in a time window.",
      inputSchema: {
        type: "object",
        properties: { scope: scopeSchema, fromISO: { type: "string" }, toISO: { type: "string" }, limit: { type: "number" } },
        required: ["scope"],
      },
    },
    {
      name: "weight_day_summary",
      description:
        "Summarize a day: weights, food calories/macros totals, water, daily targets (if set), photo count, meal analyses count.",
      inputSchema: {
        type: "object",
        properties: { scope: scopeSchema, dateISO: { type: "string" }, tzName: { type: "string", description: "IANA tz name for local-day boundaries." } },
        required: ["scope"],
      },
    },
    {
      name: "weight_analyze_meal_photo",
      description:
        "Estimate calories/macros from a meal image via vision API; persist row in wm_meal_analyses. Provide imageUrl (https) — this worker fetches bytes server-side — or imageBase64 for small/legacy payloads. Optional sourceRef for opaque correlation ids.",
      inputSchema: {
        type: "object",
        properties: {
          scope: scopeSchema,
          meal: { type: "string" },
          locale: { type: "string" },
          tzName: { type: "string", description: "IANA timezone name (e.g. America/Denver) used for meal classification." },
          imageUrl: {
            type: "string",
            description: "Preferred; https URL fetched in this worker (bytes not sent in tool args).",
          },
          imageBase64: { type: "string" },
          sourceRef: {
            type: "object",
            properties: { chatId: { type: "string" }, messageId: { type: "number" } },
          },
          atMs: { type: "number" },
          atISO: { type: "string" },
        },
        required: ["scope"],
      },
    },
    {
      name: "weight_log_food_from_analysis",
      description:
        "Create wm_food_entries from a prior weight_analyze_meal_photo analysis (items = one row per detected food; aggregate = single row with totals).",
      inputSchema: {
        type: "object",
        properties: {
          scope: scopeSchema,
          analysisId: { type: "string" },
          mode: { type: "string", enum: ["items", "aggregate"] },
          atMs: { type: "number" },
          atISO: { type: "string" },
          meal: { type: "string" },
          source: { type: "string" },
          sourceRef: {
            type: "object",
            properties: { chatId: { type: "string" }, messageId: { type: "number" } },
          },
        },
        required: ["scope", "analysisId"],
      },
    },
    {
      name: "weight_lookup_barcode",
      description: "Look up product nutrition via Open Food Facts (barcode digits).",
      inputSchema: {
        type: "object",
        properties: { scope: scopeSchema, barcode: { type: "string" } },
        required: ["scope", "barcode"],
      },
    },
    {
      name: "weight_target_get",
      description: "Get daily nutrition/water/steps targets JSON for this scope.",
      inputSchema: { type: "object", properties: { scope: scopeSchema }, required: ["scope"] },
    },
    {
      name: "weight_target_upsert",
      description:
        "Upsert daily targets JSON, e.g. {calories,protein_g,carbs_g,fat_g,fiber_g,sodium_mg,water_ml_day,steps} (fields optional).",
      inputSchema: {
        type: "object",
        properties: { scope: scopeSchema, targets: { type: "object" } },
        required: ["scope", "targets"],
      },
    },
    {
      name: "weight_water_log",
      description: "Log water intake (ml).",
      inputSchema: {
        type: "object",
        properties: {
          scope: scopeSchema,
          amount_ml: { type: "number" },
          atMs: { type: "number" },
          atISO: { type: "string" },
          source: { type: "string" },
          sourceRef: {
            type: "object",
            properties: { chatId: { type: "string" }, messageId: { type: "number" } },
          },
        },
        required: ["scope", "amount_ml"],
      },
    },
    {
      name: "weight_water_list",
      description: "List water log rows in a time window.",
      inputSchema: {
        type: "object",
        properties: { scope: scopeSchema, fromISO: { type: "string" }, toISO: { type: "string" }, limit: { type: "number" } },
        required: ["scope"],
      },
    },
    {
      name: "weight_fast_start",
      description: "Start a fasting window (end_ms null until weight_fast_end).",
      inputSchema: {
        type: "object",
        properties: {
          scope: scopeSchema,
          label: { type: "string" },
          startMs: { type: "number" },
          startISO: { type: "string" },
          source: { type: "string" },
        },
        required: ["scope"],
      },
    },
    {
      name: "weight_fast_end",
      description: "End a fast: pass fastId, or closeLatest=true to close the latest open window for this scope.",
      inputSchema: {
        type: "object",
        properties: {
          scope: scopeSchema,
          fastId: { type: "string" },
          closeLatest: { type: "boolean" },
          endMs: { type: "number" },
          endISO: { type: "string" },
        },
        required: ["scope"],
      },
    },
    {
      name: "weight_fast_list",
      description: "List fasting windows (optional time range).",
      inputSchema: {
        type: "object",
        properties: { scope: scopeSchema, fromISO: { type: "string" }, toISO: { type: "string" }, limit: { type: "number" } },
        required: ["scope"],
      },
    },
    {
      name: "weight_week_summary",
      description: "Aggregate food + water per day for ISO week starting Monday (UTC); include targets if configured.",
      inputSchema: {
        type: "object",
        properties: { scope: scopeSchema, weekStartISO: { type: "string" } },
        required: ["scope"],
      },
    },
  ];
}

async function toolCall(env: Env, name: string, args: Record<string, unknown>): Promise<unknown> {
  const scope = parseScope(args);
  const sid = scopeId(scope);

  if (name === "weight_ping") return { ok: true, ts: nowMs() };

  if (name === "weight_ingest_telegram_message") {
    const chatId = normStr(args.chatId);
    const messageId =
      typeof args.messageId === "number" && Number.isFinite(args.messageId) ? Math.trunc(args.messageId) : null;
    if (!chatId || messageId == null) throw new Error("chatId and messageId required");

    const tzName = normStr(args.tzName) ?? "UTC";
    const text = normStr(args.text);
    const imageUrl = normStr(args.imageUrl);
    const locale = normStr(args.locale);
    const mealOverride = normStr(args.meal);

    const at_ms =
      typeof args.atMs === "number" && Number.isFinite(args.atMs)
        ? Math.trunc(args.atMs)
        : typeof args.dateUnix === "number" && Number.isFinite(args.dateUnix)
          ? Math.trunc(args.dateUnix) * 1000
          : parseAtMs(args.atISO);

    const ts = nowMs();
    const eventKey = `${sid}|telegram|${chatId}|${messageId}`;
    const eventId = `tg_${await sha256Hex(eventKey)}`;
    const payload = {
      chatId,
      messageId,
      at_ms,
      tzName,
      text,
      imageUrl,
      locale,
      meal: mealOverride,
    };
    await env.DB.prepare(
      `INSERT OR IGNORE INTO wm_events (id, scope_id, type, at_ms, payload_json, created_at)
       VALUES (?1,?2,?3,?4,?5,?6)`,
    )
      .bind(eventId, sid, "telegram_message", at_ms, JSON.stringify(payload), ts)
      .run();

    // Idempotency: if already ingested into any primary table, return quickly.
    const existingFood = await env.DB.prepare(
      `SELECT id, at_ms, meal, image_url, calories
       FROM wm_food_entries
       WHERE scope_id=?1 AND telegram_chat_id=?2 AND telegram_message_id=?3
       LIMIT 1`,
    )
      .bind(sid, chatId, messageId)
      .first<{ id: string; at_ms: number; meal: string | null; image_url?: string | null; calories?: number | null }>();
    if (existingFood?.id) {
      return {
        ok: true,
        deduped: true,
        kind: "food",
        scope_id: sid,
        foodEntryId: existingFood.id,
        at_ms: existingFood.at_ms,
        meal: existingFood.meal ?? null,
        calories: existingFood.calories ?? null,
        imageUrl: (existingFood as any).image_url ?? null,
      };
    }
    // Weight is stored in wm_profiles.profile_json only; no per-message weight row dedupe.
    const existingAnalysis = await env.DB.prepare(
      `SELECT id, at_ms, summary
       FROM wm_meal_analyses
       WHERE scope_id=?1 AND telegram_chat_id=?2 AND telegram_message_id=?3
       LIMIT 1`,
    )
      .bind(sid, chatId, messageId)
      .first<{ id: string; at_ms: number; summary: string | null }>();
    if (existingAnalysis?.id) {
      return { ok: true, deduped: true, kind: "meal_analysis", scope_id: sid, analysisId: existingAnalysis.id, at_ms: existingAnalysis.at_ms };
    }

    const sourceRef = { chatId, messageId };

    if (imageUrl) {
      const res = await toolCall(env, "weight_analyze_meal_photo", {
        scope,
        imageUrl,
        atMs: at_ms,
        tzName,
        locale: locale ?? undefined,
        meal: mealOverride ?? undefined,
        sourceRef,
      });
      const logged = await env.DB.prepare(
        `SELECT id, at_ms, meal, text, calories, protein_g, carbs_g, fat_g, fiber_g, analysis_id, image_url
         FROM wm_food_entries
         WHERE scope_id=?1 AND telegram_chat_id=?2 AND telegram_message_id=?3
         ORDER BY at_ms DESC
         LIMIT 1`,
      )
        .bind(sid, chatId, messageId)
        .first<{
          id: string;
          at_ms: number;
          meal: string | null;
          text: string | null;
          calories: number | null;
          protein_g: number | null;
          carbs_g: number | null;
          fat_g: number | null;
          fiber_g: number | null;
          analysis_id: string | null;
          image_url: string | null;
        }>();
      return { ok: true, deduped: false, kind: "meal_photo", scope_id: sid, result: res, foodEntry: logged ?? null };
    }

    if (text && looksLikeWeightText(text)) {
      const w = parseWeightFromText(text);
      if (w.weightKg == null && w.weightLb == null) {
        throw new Error("weight text detected but could not parse a weight");
      }
      const res = await toolCall(env, "weight_log_weight", {
        scope,
        atMs: at_ms,
        weightKg: w.weightKg ?? undefined,
        weightLb: w.weightLb ?? undefined,
        source: "telegram_text",
        sourceRef,
      });
      return { ok: true, deduped: false, kind: "weight", scope_id: sid, result: res };
    }

    if (text && looksLikeMealText(text)) {
      const res = await toolCall(env, "weight_log_meal_from_text", {
        scope,
        text,
        atMs: at_ms,
        tzName,
        source: "telegram_text",
        sourceRef,
      });
      return { ok: true, deduped: false, kind: "meal_text", scope_id: sid, result: res };
    }

    return { ok: true, deduped: false, kind: "ignored", scope_id: sid };
  }

  if (name === "weight_profile_get") {
    const row = await env.DB.prepare(`SELECT profile_json, updated_at FROM wm_profiles WHERE scope_id=?1 LIMIT 1`)
      .bind(sid)
      .first<{ profile_json: string; updated_at: number }>();
    return { ok: true, scope_id: sid, profile: row ? JSON.parse(row.profile_json) : {}, updated_at: row?.updated_at ?? null };
  }

  if (name === "weight_profile_upsert") {
    const profile = isRecord(args.profile) ? args.profile : {};
    const ts = nowMs();
    await env.DB.prepare(
      `INSERT INTO wm_profiles (scope_id, scope_json, profile_json, updated_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(scope_id) DO UPDATE SET profile_json=excluded.profile_json, updated_at=excluded.updated_at`,
    )
      .bind(sid, JSON.stringify(scope), JSON.stringify(profile), ts)
      .run();
    return { ok: true, scope_id: sid, updated_at: ts };
  }

  if (name === "weight_log_weight") {
    const at_ms = "atMs" in args ? parseAtMs(args.atMs) : parseAtMs(args.atISO);
    const weightKg = numOrNull(args.weightKg);
    const weightLb = numOrNull(args.weightLb);
    const bodyfat = numOrNull(args.bodyFatPct);
    const notes = normStr(args.notes);
    const source = normStr(args.source);
    const { chatId, messageId } = parseSourceRef(args);

    const kg =
      weightKg ??
      (weightLb != null ? weightLb * 0.45359237 : null);
    if (kg == null) throw new Error("Provide weightKg or weightLb");

    const ts = nowMs();
    // Store weight on profile_json (wm_weights table is deprecated/removed).
    const row = await env.DB.prepare(`SELECT profile_json FROM wm_profiles WHERE scope_id=?1 LIMIT 1`)
      .bind(sid)
      .first<{ profile_json: string | null }>();
    let prof: Record<string, unknown> = {};
    try {
      const raw = row && typeof (row as any).profile_json === "string" ? String((row as any).profile_json) : "";
      const parsed = raw ? JSON.parse(raw) : {};
      prof = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      prof = {};
    }
    const next: Record<string, unknown> = { ...prof };
    next.weight_kg = kg;
    if (weightLb != null) next.weight_lb = weightLb;
    if (bodyfat != null) next.bodyfat_pct = bodyfat;
    if (notes) next.weight_notes = notes;
    if (source) next.weight_source = source;
    if (chatId) next.weight_telegram_chat_id = chatId;
    if (messageId != null) next.weight_telegram_message_id = messageId;
    next.weight_at_ms = at_ms;

    await env.DB.prepare(
      `INSERT INTO wm_profiles (scope_id, scope_json, profile_json, updated_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(scope_id) DO UPDATE SET profile_json=excluded.profile_json, updated_at=excluded.updated_at`,
    )
      .bind(sid, JSON.stringify(scope), JSON.stringify(next), ts)
      .run();

    return { ok: true, scope_id: sid, at_ms, weight_kg: kg, updated_at: ts };
  }

  if (name === "weight_list_weights") {
    return { ok: true, scope_id: sid, items: [], reason: "wm_weights_removed_use_weight_profile_get" };
  }

  if (name === "weight_log_food") {
    const id = crypto.randomUUID();
    const at_ms = "atMs" in args ? parseAtMs(args.atMs) : parseAtMs(args.atISO);
    const meal = normStr(args.meal);
    const text = normStr(args.text);
    if (!text) throw new Error("Missing text");
    const imageUrl = normStr((args as any).imageUrl);
    const ts = nowMs();
    const { chatId, messageId } = parseSourceRef(args);
    const analysisId = normStr(args.analysisId);
    await env.DB.prepare(
      `INSERT INTO wm_food_entries
       (id, scope_id, at_ms, meal, text, calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg, source, telegram_chat_id, telegram_message_id, analysis_id, image_url, created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)`,
    )
      .bind(
        id,
        sid,
        at_ms,
        meal,
        text,
        numOrNull(args.calories),
        numOrNull(args.protein_g),
        numOrNull(args.carbs_g),
        numOrNull(args.fat_g),
        numOrNull(args.fiber_g),
        numOrNull(args.sugar_g),
        numOrNull(args.sodium_mg),
        normStr(args.source),
        chatId,
        messageId,
        analysisId,
        imageUrl,
        ts,
      )
      .run();
    return { ok: true, id, scope_id: sid, at_ms, meal, text };
  }

  if (name === "weight_log_meal_from_text") {
    const rawText = normStr(args.text);
    if (!rawText) throw new Error("text required");
    const { chatId, messageId } = parseSourceRef(args);

    if (chatId && messageId != null) {
      const existing = await env.DB.prepare(
        `SELECT id, analysis_id, at_ms, meal, calories
         FROM wm_food_entries
         WHERE scope_id=?1 AND telegram_chat_id=?2 AND telegram_message_id=?3
         LIMIT 1`,
      )
        .bind(sid, chatId, messageId)
        .first<{
          id: string;
          analysis_id?: string | null;
          at_ms: number;
          meal?: string | null;
          calories?: number | null;
        }>();
      if (existing?.id) {
        return {
          ok: true,
          deduped: true,
          scope_id: sid,
          foodEntryId: existing.id,
          analysisId: existing.analysis_id ?? null,
          at_ms: existing.at_ms,
          meal: existing.meal ?? null,
          calories: existing.calories ?? null,
        };
      }
    }

    const baseAtMs = "atMs" in args ? parseAtMs(args.atMs) : parseAtMs(args.atISO);
    const baseAtISO = new Date(baseAtMs).toISOString();
    const tzName = normStr(args.tzName);

    const analysis = await visionAnalyzeMealText(env, rawText, baseAtISO, tzName);
    const model = (env.VISION_MODEL ?? "gpt-4o-mini").trim();

    const at_ms_from_model =
      analysis?.atISO && typeof analysis.atISO === "string" && analysis.atISO.trim()
        ? Date.parse(analysis.atISO.trim())
        : NaN;
    const at_ms = Number.isFinite(at_ms_from_model) ? Math.trunc(at_ms_from_model) : baseAtMs;

    const overrideMeal = normStr(args.meal);
    const mealFromModel = analysis?.meal && typeof analysis.meal === "string" ? normStr(analysis.meal) : null;
    const meal = overrideMeal ?? coerceMealLabel(mealFromModel) ?? inferMealLabel(at_ms, tzName, rawText);

    const totals = analysis && typeof analysis === "object" ? (analysis.totals ?? {}) : {};
    const calories = typeof totals.calories === "number" ? totals.calories : null;
    const protein_g = typeof totals.protein_g === "number" ? totals.protein_g : null;
    const carbs_g = typeof totals.carbs_g === "number" ? totals.carbs_g : null;
    const fat_g = typeof totals.fat_g === "number" ? totals.fat_g : null;
    const fiber_g = typeof totals.fiber_g === "number" ? totals.fiber_g : null;

    const ts = nowMs();
    const analysisId = crypto.randomUUID();
    const summary =
      calories != null
        ? `~${Math.round(calories)} kcal (confidence ${typeof analysis.confidence === "number" ? analysis.confidence.toFixed(2) : "?"})`
        : "meal text analysis";
    const analysisRef: Record<string, unknown> = { source: "meal_text", baseAtISO, tzName: tzName ?? null };

    await env.DB.prepare(
      `INSERT INTO wm_meal_analyses
       (id, scope_id, at_ms, model, summary, raw_json, image_ref_json, telegram_chat_id, telegram_message_id, created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)`,
    )
      .bind(analysisId, sid, at_ms, model, summary, JSON.stringify(analysis), JSON.stringify(analysisRef), chatId, messageId, ts)
      .run();

    const foodEntryId = crypto.randomUUID();
    const source = normStr(args.source) ?? "meal_text";
    await env.DB.prepare(
      `INSERT INTO wm_food_entries
       (id, scope_id, at_ms, meal, text, calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg, source, telegram_chat_id, telegram_message_id, analysis_id, image_url, created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)`,
    )
      .bind(
        foodEntryId,
        sid,
        at_ms,
        meal,
        rawText,
        calories,
        protein_g,
        carbs_g,
        fat_g,
        fiber_g,
        null,
        null,
        source,
        chatId,
        messageId,
        analysisId,
        null,
        ts,
      )
      .run();

    await insertFoodItems(env, sid, foodEntryId, at_ms, meal, analysis?.items, source, ts);

    return {
      ok: true,
      scope_id: sid,
      analysisId,
      foodEntryId,
      at_ms,
      meal,
      summary,
      totals: { calories, protein_g, carbs_g, fat_g, fiber_g },
      confidence: typeof analysis.confidence === "number" ? analysis.confidence : null,
      notes: typeof analysis.notes === "string" ? analysis.notes : null,
    };
  }

  if (name === "weight_list_food") {
    const from = "fromISO" in args ? Date.parse(String(args.fromISO)) : NaN;
    const to = "toISO" in args ? Date.parse(String(args.toISO)) : NaN;
    const limit = typeof args.limit === "number" && Number.isFinite(args.limit) ? Math.min(200, Math.max(1, Math.trunc(args.limit))) : 50;
    await maybeAutoMigrateLegacyAcctScope(env, sid);
    const where: string[] = ["scope_id=?1"];
    const binds: unknown[] = [sid];
    if (Number.isFinite(from)) {
      where.push("at_ms >= ?2");
      binds.push(from);
    }
    if (Number.isFinite(to)) {
      where.push(`at_ms <= ?${binds.length + 1}`);
      binds.push(to);
    }
    const sql = `SELECT id, at_ms, meal, text, calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg, source, telegram_chat_id, telegram_message_id, analysis_id, image_url
                 FROM wm_food_entries
                 WHERE ${where.join(" AND ")}
                 ORDER BY at_ms DESC
                 LIMIT ${limit}`;
    const res = await env.DB.prepare(sql).bind(...binds).all();
    return { ok: true, scope_id: sid, items: res.results ?? [] };
  }

  if (name === "weight_meal_trends") {
    const tzName = normStr(args.tzName) ?? "UTC";
    const topN =
      typeof args.topN === "number" && Number.isFinite(args.topN) ? Math.min(25, Math.max(1, Math.trunc(args.topN))) : 8;
    const fromMs = "fromISO" in args ? Date.parse(String(args.fromISO)) : NaN;
    const toMs = "toISO" in args ? Date.parse(String(args.toISO)) : NaN;
    const now = nowMs();
    const from = Number.isFinite(fromMs) ? Math.trunc(fromMs) : now - 7 * 86400000;
    const to = Number.isFinite(toMs) ? Math.trunc(toMs) : now;

    const foods = await env.DB.prepare(
      `SELECT at_ms, meal, calories, protein_g, carbs_g, fat_g
       FROM wm_food_entries
       WHERE scope_id=?1 AND at_ms>=?2 AND at_ms<=?3
       ORDER BY at_ms ASC
       LIMIT 5000`,
    )
      .bind(sid, from, to)
      .all<{
        at_ms: number;
        meal: string | null;
        calories: number | null;
        protein_g: number | null;
        carbs_g: number | null;
        fat_g: number | null;
      }>();

    type Tot = { calories: number; protein_g: number; carbs_g: number; fat_g: number };
    const zero = (): Tot => ({ calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 });
    const dayMap = new Map<
      string,
      { dateISO: string; totals: Tot; meals: Record<string, Tot>; exercise_kcal: number }
    >();

    for (const r of foods.results ?? []) {
      const at_ms = typeof (r as any).at_ms === "number" ? (r as any).at_ms : null;
      if (at_ms == null) continue;
      const dateISO = localDateISO(at_ms, tzName);
      const meal = typeof (r as any).meal === "string" && (r as any).meal.trim() ? (r as any).meal.trim() : "unknown";
      const calories = typeof (r as any).calories === "number" ? (r as any).calories : 0;
      const protein_g = typeof (r as any).protein_g === "number" ? (r as any).protein_g : 0;
      const carbs_g = typeof (r as any).carbs_g === "number" ? (r as any).carbs_g : 0;
      const fat_g = typeof (r as any).fat_g === "number" ? (r as any).fat_g : 0;

      let day = dayMap.get(dateISO);
      if (!day) {
        day = { dateISO, totals: zero(), meals: {}, exercise_kcal: 0 };
        dayMap.set(dateISO, day);
      }
      day.totals.calories += calories;
      day.totals.protein_g += protein_g;
      day.totals.carbs_g += carbs_g;
      day.totals.fat_g += fat_g;

      if (!day.meals[meal]) day.meals[meal] = zero();
      day.meals[meal]!.calories += calories;
      day.meals[meal]!.protein_g += protein_g;
      day.meals[meal]!.carbs_g += carbs_g;
      day.meals[meal]!.fat_g += fat_g;
    }

    const wkg = (await latestWeightKg(env, sid, to)) ?? (await latestWeightKg(env, sid, null));
    const ex = await env.DB.prepare(
      `SELECT at_ms, activity_type, duration_seconds, distance_meters, active_energy_kcal
       FROM wm_exercise_entries
       WHERE scope_id=?1 AND at_ms>=?2 AND at_ms<=?3
       ORDER BY at_ms ASC
       LIMIT 15000`,
    )
      .bind(sid, from, to)
      .all<{
        at_ms: number;
        activity_type: string | null;
        duration_seconds: number | null;
        distance_meters: number | null;
        active_energy_kcal: number | null;
      }>();
    for (const r of ex.results ?? []) {
      const at_ms = typeof (r as any).at_ms === "number" ? (r as any).at_ms : null;
      if (at_ms == null) continue;
      const dateISO = localDateISO(at_ms, tzName);
      const stored = typeof (r as any).active_energy_kcal === "number" ? Number((r as any).active_energy_kcal) : null;
      const kcal =
        stored != null && Number.isFinite(stored)
          ? stored
          : wkg != null
            ? estimateExerciseKcal({
                activityType: (r as any).activity_type,
                durationSeconds: (r as any).duration_seconds,
                distanceMeters: (r as any).distance_meters,
                weightKg: wkg,
              }) ?? 0
            : 0;
      let day = dayMap.get(dateISO);
      if (!day) {
        day = { dateISO, totals: zero(), meals: {}, exercise_kcal: 0 };
        dayMap.set(dateISO, day);
      }
      day.exercise_kcal += kcal;
    }

    const items = await env.DB.prepare(
      `SELECT at_ms, meal, name, calories
       FROM wm_food_items
       WHERE scope_id=?1 AND at_ms>=?2 AND at_ms<=?3
       ORDER BY at_ms ASC
       LIMIT 15000`,
    )
      .bind(sid, from, to)
      .all<{ at_ms: number; meal: string | null; name: string; calories: number | null }>();

    const topMap = new Map<string, { meal: string; name: string; count: number; calories: number }>();
    for (const r of items.results ?? []) {
      const name = typeof (r as any).name === "string" ? (r as any).name.trim() : "";
      if (!name) continue;
      const meal = typeof (r as any).meal === "string" && (r as any).meal.trim() ? (r as any).meal.trim() : "unknown";
      const key = `${meal}::${name.toLowerCase()}`;
      const cals = typeof (r as any).calories === "number" ? (r as any).calories : 0;
      const cur = topMap.get(key);
      if (cur) {
        cur.count += 1;
        cur.calories += cals;
      } else {
        topMap.set(key, { meal, name, count: 1, calories: cals });
      }
    }

    const byMeal: Record<string, Array<{ name: string; count: number; calories: number }>> = {};
    for (const v of topMap.values()) {
      if (!byMeal[v.meal]) byMeal[v.meal] = [];
      byMeal[v.meal]!.push({ name: v.name, count: v.count, calories: v.calories });
    }
    for (const m of Object.keys(byMeal)) {
      byMeal[m]!.sort((a, b) => b.count - a.count || b.calories - a.calories);
      byMeal[m] = byMeal[m]!.slice(0, topN);
    }

    const days = Array.from(dayMap.values())
      .sort((a, b) => (a.dateISO < b.dateISO ? -1 : a.dateISO > b.dateISO ? 1 : 0))
      .map((d) => ({ ...d, net_calories: d.totals.calories - d.exercise_kcal }));
    const totalsAll = days.reduce(
      (acc, d) => {
        acc.calories += d.totals.calories;
        acc.protein_g += d.totals.protein_g;
        acc.carbs_g += d.totals.carbs_g;
        acc.fat_g += d.totals.fat_g;
        return acc;
      },
      zero(),
    );
    const exercise_kcal = days.reduce((s, d) => s + (typeof (d as any).exercise_kcal === "number" ? (d as any).exercise_kcal : 0), 0);

    return {
      ok: true,
      scope_id: sid,
      tzName,
      fromISO: new Date(from).toISOString(),
      toISO: new Date(to).toISOString(),
      totals: { ...totalsAll, exercise_kcal, net_calories: totalsAll.calories - exercise_kcal },
      days,
      topFoods: byMeal,
    };
  }

  if (name === "weight_ingest_workout") {
    const source = normStr(args.source) ?? "";
    const workoutId = normStr(args.workoutId) ?? "";
    if (!source || !workoutId) throw new Error("source and workoutId required");
    const at_ms = "atMs" in args ? parseAtMs(args.atMs) : parseAtMs((args as any).startedAtISO);
    const ts = nowMs();
    const activityType = normStr((args as any).activityType);
    const durationSeconds =
      typeof (args as any).durationSeconds === "number" && Number.isFinite((args as any).durationSeconds)
        ? Math.trunc((args as any).durationSeconds)
        : null;
    const distanceMeters =
      typeof (args as any).distanceMeters === "number" && Number.isFinite((args as any).distanceMeters)
        ? Number((args as any).distanceMeters)
        : null;
    const providedActiveEnergyKcal =
      typeof (args as any).activeEnergyKcal === "number" && Number.isFinite((args as any).activeEnergyKcal)
        ? Number((args as any).activeEnergyKcal)
        : null;

    const eventKey = `${sid}|workout|${source}|${workoutId}`;
    const eventId = `wk_${await sha256Hex(eventKey)}`;
    await env.DB.prepare(
      `INSERT OR IGNORE INTO wm_events (id, scope_id, type, at_ms, payload_json, created_at)
       VALUES (?1,?2,?3,?4,?5,?6)`,
    )
      .bind(
        eventId,
        sid,
        "workout",
        at_ms,
        JSON.stringify({
          source,
          workoutId,
          startedAtISO: normStr((args as any).startedAtISO),
          activityType,
          durationSeconds:
            typeof durationSeconds === "number" && Number.isFinite(durationSeconds) ? Math.trunc(durationSeconds) : null,
          distanceMeters:
            typeof distanceMeters === "number" && Number.isFinite(distanceMeters) ? Number(distanceMeters) : null,
          activeEnergyKcal:
            typeof providedActiveEnergyKcal === "number" && Number.isFinite(providedActiveEnergyKcal) ? Number(providedActiveEnergyKcal) : null,
          raw: isRecord((args as any).raw) ? (args as any).raw : null,
        }),
        ts,
      )
      .run();

    const existing = await env.DB.prepare(
      `SELECT id, at_ms, active_energy_kcal FROM wm_exercise_entries
       WHERE scope_id=?1 AND source=?2 AND workout_id=?3
       LIMIT 1`,
    )
      .bind(sid, source, workoutId)
      .first<{ id: string; at_ms: number; active_energy_kcal: number | null }>();
    if (existing?.id) {
      let activeEnergyKcal = existing.active_energy_kcal;
      if (activeEnergyKcal == null) {
        const wkg = (await latestWeightKg(env, sid, at_ms)) ?? (await latestWeightKg(env, sid, null));
        if (wkg != null) {
          const est = estimateExerciseKcal({
            activityType,
            durationSeconds,
            distanceMeters,
            weightKg: wkg,
          });
          if (est != null) {
            await env.DB.prepare(`UPDATE wm_exercise_entries SET active_energy_kcal=?1 WHERE id=?2 AND active_energy_kcal IS NULL`)
              .bind(est, existing.id)
              .run();
            activeEnergyKcal = est;
          }
        }
      }
      return {
        ok: true,
        deduped: true,
        scope_id: sid,
        exerciseEntryId: existing.id,
        at_ms: existing.at_ms,
        activeEnergyKcal,
      };
    }

    const wkg = (await latestWeightKg(env, sid, at_ms)) ?? (await latestWeightKg(env, sid, null));
    const estimatedActiveEnergyKcal =
      providedActiveEnergyKcal == null && wkg != null
        ? estimateExerciseKcal({ activityType, durationSeconds, distanceMeters, weightKg: wkg })
        : null;
    const activeEnergyKcalOut = providedActiveEnergyKcal ?? estimatedActiveEnergyKcal ?? null;

    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO wm_exercise_entries
       (id, scope_id, at_ms, source, workout_id, activity_type, duration_seconds, distance_meters, active_energy_kcal, raw_json, created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`,
    )
      .bind(
        id,
        sid,
        at_ms,
        source,
        workoutId,
        activityType,
        durationSeconds,
        distanceMeters,
        activeEnergyKcalOut,
        isRecord((args as any).raw) ? JSON.stringify((args as any).raw) : null,
        ts,
      )
      .run();

    return { ok: true, deduped: false, scope_id: sid, exerciseEntryId: id, at_ms, activeEnergyKcal: activeEnergyKcalOut };
  }

  if (name === "weight_log_photo") {
    const id = crypto.randomUUID();
    const at_ms = "atMs" in args ? parseAtMs(args.atMs) : parseAtMs(args.atISO);
    const kind = normStr(args.kind) ?? "other";
    const caption = normStr(args.caption);
    const tags = Array.isArray(args.tags) ? args.tags.filter((t) => typeof t === "string") : [];
    const { chatId, messageId } = parseSourceRef(args);
    const photoUrl = normStr(args.photoUrl);
    const ts = nowMs();
    await env.DB.prepare(
      `INSERT INTO wm_photos
       (id, scope_id, at_ms, kind, caption, tags_json, telegram_chat_id, telegram_message_id, telegram_file_id, telegram_file_unique_id, photo_url, created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)`,
    )
      .bind(id, sid, at_ms, kind, caption, JSON.stringify(tags), chatId, messageId, null, null, photoUrl, ts)
      .run();
    return { ok: true, id, scope_id: sid, at_ms, kind };
  }

  if (name === "weight_list_photos") {
    const from = "fromISO" in args ? Date.parse(String(args.fromISO)) : NaN;
    const to = "toISO" in args ? Date.parse(String(args.toISO)) : NaN;
    const limit = typeof args.limit === "number" && Number.isFinite(args.limit) ? Math.min(200, Math.max(1, Math.trunc(args.limit))) : 50;
    const where: string[] = ["scope_id=?1"];
    const binds: unknown[] = [sid];
    if (Number.isFinite(from)) {
      where.push("at_ms >= ?2");
      binds.push(from);
    }
    if (Number.isFinite(to)) {
      where.push(`at_ms <= ?${binds.length + 1}`);
      binds.push(to);
    }
    const sql = `SELECT id, at_ms, kind, caption, tags_json, telegram_chat_id, telegram_message_id, telegram_file_id, photo_url
                 FROM wm_photos
                 WHERE ${where.join(" AND ")}
                 ORDER BY at_ms DESC
                 LIMIT ${limit}`;
    const res = await env.DB.prepare(sql).bind(...binds).all();
    const items = (res.results ?? []).map((r) => ({
      ...r,
      tags: typeof (r as any).tags_json === "string" ? JSON.parse((r as any).tags_json) : [],
    }));
    return { ok: true, scope_id: sid, items };
  }

  if (name === "weight_day_summary") {
    const dateISO = normStr(args.dateISO) ?? new Date().toISOString().slice(0, 10);
    const tzName = normStr(args.tzName);
    const win = dayWindowUtcMsFromLocalDate(dateISO, tzName);
    const dayStart = win.startMs;
    const dayEnd = win.endMs;
    await maybeAutoMigrateLegacyAcctScope(env, sid);

    const weights = { results: [] as any[] };

    const foods = await env.DB.prepare(
      `SELECT calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg FROM wm_food_entries
       WHERE scope_id=?1 AND at_ms>=?2 AND at_ms<?3`,
    )
      .bind(sid, dayStart, dayEnd)
      .all();

    let calories = 0;
    let protein_g = 0;
    let carbs_g = 0;
    let fat_g = 0;
    for (const r of foods.results ?? []) {
      calories += typeof (r as any).calories === "number" ? (r as any).calories : 0;
      protein_g += typeof (r as any).protein_g === "number" ? (r as any).protein_g : 0;
      carbs_g += typeof (r as any).carbs_g === "number" ? (r as any).carbs_g : 0;
      fat_g += typeof (r as any).fat_g === "number" ? (r as any).fat_g : 0;
    }

    const photoCount = await env.DB.prepare(
      `SELECT COUNT(1) as c FROM wm_photos WHERE scope_id=?1 AND at_ms>=?2 AND at_ms<?3`,
    )
      .bind(sid, dayStart, dayEnd)
      .first<{ c: number }>();

    const waterRow = await env.DB.prepare(
      `SELECT COALESCE(SUM(amount_ml),0) as w FROM wm_water_log WHERE scope_id=?1 AND at_ms>=?2 AND at_ms<?3`,
    )
      .bind(sid, dayStart, dayEnd)
      .first<{ w: number }>();

    const analysisCount = await env.DB.prepare(
      `SELECT COUNT(1) as c FROM wm_meal_analyses WHERE scope_id=?1 AND at_ms>=?2 AND at_ms<?3`,
    )
      .bind(sid, dayStart, dayEnd)
      .first<{ c: number }>();

    const wkg = (await latestWeightKg(env, sid, dayEnd - 1)) ?? (await latestWeightKg(env, sid, null));
    const exRows = await env.DB.prepare(
      `SELECT id, activity_type, duration_seconds, distance_meters, active_energy_kcal
       FROM wm_exercise_entries
       WHERE scope_id=?1 AND at_ms>=?2 AND at_ms<?3
       ORDER BY at_ms ASC
       LIMIT 15000`,
    )
      .bind(sid, dayStart, dayEnd)
      .all<{
        id: string;
        activity_type: string | null;
        duration_seconds: number | null;
        distance_meters: number | null;
        active_energy_kcal: number | null;
      }>();
    let exercise_kcal = 0;
    for (const r of exRows.results ?? []) {
      const stored = typeof (r as any).active_energy_kcal === "number" ? Number((r as any).active_energy_kcal) : null;
      if (stored != null && Number.isFinite(stored)) {
        exercise_kcal += stored;
        continue;
      }
      if (wkg == null) continue;
      const est = estimateExerciseKcal({
        activityType: (r as any).activity_type,
        durationSeconds: (r as any).duration_seconds,
        distanceMeters: (r as any).distance_meters,
        weightKg: wkg,
      });
      if (est == null) continue;
      exercise_kcal += est;
      const exId = typeof (r as any).id === "string" ? String((r as any).id) : "";
      if (exId) {
        await env.DB.prepare(`UPDATE wm_exercise_entries SET active_energy_kcal=?1 WHERE id=?2 AND active_energy_kcal IS NULL`)
          .bind(est, exId)
          .run();
      }
    }

    const targetsRow = await env.DB.prepare(`SELECT targets_json, updated_at FROM wm_daily_targets WHERE scope_id=?1 LIMIT 1`)
      .bind(sid)
      .first<{ targets_json: string; updated_at: number }>();

    return {
      ok: true,
      scope_id: sid,
      dateISO,
      weights: weights.results ?? [],
      totals: { calories, protein_g, carbs_g, fat_g, exercise_kcal, net_calories: calories - exercise_kcal },
      water_ml: waterRow?.w ?? 0,
      photoCount: photoCount?.c ?? 0,
      mealAnalysesCount: analysisCount?.c ?? 0,
      targets: targetsRow ? JSON.parse(targetsRow.targets_json) : null,
      targets_updated_at: targetsRow?.updated_at ?? null,
    };
  }

  if (name === "weight_analyze_meal_photo") {
    const { chatId: srcChatId, messageId: srcMessageId } = parseSourceRef(args);
    const rawB64 = normStr(args.imageBase64);
    const imageUrlArg = normStr(args.imageUrl);

    let imageDataUrl: string;
    let imageSourceHttpsUrl: string | null = null;
    if (imageUrlArg && isFetchableHttpsImageUrl(imageUrlArg)) {
      imageSourceHttpsUrl = imageUrlArg;
      imageDataUrl = await fetchHttpUrlAsDataUrl(imageUrlArg, env);
    } else if (rawB64) {
      imageDataUrl = rawB64.startsWith("data:") ? rawB64 : `data:image/jpeg;base64,${rawB64}`;
    } else {
      throw new Error("Provide imageUrl (https) or imageBase64");
    }

    const analysis = await visionAnalyzeMealPhoto(env, imageDataUrl, normStr(args.meal), normStr(args.locale));
    const model = (env.VISION_MODEL ?? "gpt-4o-mini").trim();
    const at_ms = "atMs" in args ? parseAtMs(args.atMs) : parseAtMs(args.atISO);
    const tzName = normStr(args.tzName);
    const ts = nowMs();
    const id = crypto.randomUUID();
    const totals = analysis.totals ?? {};
    const summary =
      typeof totals.calories === "number"
        ? `~${Math.round(totals.calories)} kcal (confidence ${typeof analysis.confidence === "number" ? analysis.confidence.toFixed(2) : "?"})`
        : "meal analysis";
    const imageRef: Record<string, unknown> = { vision_input: "worker_fetched" };
    if (rawB64) imageRef.imageBase64_sha_prefix = rawB64.slice(0, 24);
    if (imageUrlArg && !rawB64) {
      imageRef.source = "https_url";
    }
    await env.DB.prepare(
      `INSERT INTO wm_meal_analyses
       (id, scope_id, at_ms, model, summary, raw_json, image_ref_json, telegram_chat_id, telegram_message_id, created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)`,
    )
      .bind(id, sid, at_ms, model, summary, JSON.stringify(analysis), JSON.stringify(imageRef), srcChatId, srcMessageId, ts)
      .run();

    // Auto-create an aggregate food entry so day/week summaries include this meal.
    // Dedupe by analysis_id so callers can safely re-run analysis/logging.
    const existing = await env.DB.prepare(`SELECT 1 FROM wm_food_entries WHERE scope_id=?1 AND analysis_id=?2 LIMIT 1`)
      .bind(sid, id)
      .first();
    if (!existing) {
      const t = analysis.totals ?? {};
      const calories = typeof t.calories === "number" ? t.calories : null;
      const protein_g = typeof t.protein_g === "number" ? t.protein_g : null;
      const carbs_g = typeof t.carbs_g === "number" ? t.carbs_g : null;
      const fat_g = typeof t.fat_g === "number" ? t.fat_g : null;
      const fiber_g = typeof t.fiber_g === "number" ? t.fiber_g : null;
      const explicitMeal = normStr(args.meal);
      const meal = coerceMealLabel(explicitMeal) ?? inferMealLabel(at_ms, tzName, null);
      const text = mealSummaryFromAnalysis(analysis);
      const fid = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO wm_food_entries
         (id, scope_id, at_ms, meal, text, calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg, source, telegram_chat_id, telegram_message_id, analysis_id, image_url, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)`,
      )
        .bind(
          fid,
          sid,
          at_ms,
          meal,
          text,
          calories,
          protein_g,
          carbs_g,
          fat_g,
          fiber_g,
          null,
          null,
          "meal_photo_auto",
          srcChatId,
          srcMessageId,
          id,
          imageSourceHttpsUrl,
          ts,
        )
        .run();
      weightMcpLog(env, "meal_photo/auto_logged_food", { foodEntryId: fid, analysisId: id });
      await insertFoodItems(env, sid, fid, at_ms, meal, analysis?.items, "meal_photo_auto", ts);
    }

    weightMcpLog(env, "meal_photo/processed", {
      analysisId: id,
      summary,
      image_https_url: imageSourceHttpsUrl,
      image_source: imageSourceHttpsUrl ? "https_fetch" : "base64_inline",
    });

    return { ok: true, analysisId: id, scope_id: sid, at_ms, model, summary, analysis };
  }

  if (name === "weight_log_food_from_analysis") {
    const analysisId = normStr(args.analysisId);
    if (!analysisId) throw new Error("Missing analysisId");
    const row = await env.DB.prepare(`SELECT raw_json FROM wm_meal_analyses WHERE id=?1 AND scope_id=?2 LIMIT 1`)
      .bind(analysisId, sid)
      .first<{ raw_json: string }>();
    if (!row) throw new Error("analysis not found for scope");
    const parsed = JSON.parse(row.raw_json) as MealAnalysisJson;
    const mode = normStr(args.mode) === "aggregate" ? "aggregate" : "items";
    const at_ms = "atMs" in args ? parseAtMs(args.atMs) : parseAtMs(args.atISO);
    const meal = normStr(args.meal);
    const source = normStr(args.source) ?? "meal_photo_analysis";
    const { chatId, messageId } = parseSourceRef(args);
    const ts = nowMs();
    const createdIds: string[] = [];

    if (mode === "aggregate") {
      const t = parsed.totals ?? {};
      const fid = crypto.randomUUID();
      const text =
        parsed.notes?.trim() ||
        `Meal (from photo analysis${parsed.confidence != null ? `, conf ${parsed.confidence}` : ""})`;
      await env.DB.prepare(
        `INSERT INTO wm_food_entries
         (id, scope_id, at_ms, meal, text, calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg, source, telegram_chat_id, telegram_message_id, analysis_id, image_url, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)`,
      )
        .bind(
          fid,
          sid,
          at_ms,
          meal,
          text,
          numOrNull(t.calories),
          numOrNull(t.protein_g),
          numOrNull(t.carbs_g),
          numOrNull(t.fat_g),
          numOrNull(t.fiber_g),
          null,
          null,
          source,
          chatId,
          messageId,
          analysisId,
          null,
          ts,
        )
        .run();
      createdIds.push(fid);
      await insertFoodItems(env, sid, fid, at_ms, meal, parsed?.items, source, ts);
    } else {
      const items = Array.isArray(parsed.items) ? parsed.items : [];
      for (const it of items) {
        const fid = crypto.randomUUID();
        const text = typeof it.name === "string" && it.name.trim() ? it.name.trim() : "food item";
        const notes = typeof it.notes === "string" && it.notes.trim() ? it.notes.trim() : "";
        const line = notes ? `${text} — ${notes}` : text;
        await env.DB.prepare(
          `INSERT INTO wm_food_entries
           (id, scope_id, at_ms, meal, text, calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg, source, telegram_chat_id, telegram_message_id, analysis_id, image_url, created_at)
           VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)`,
        )
          .bind(
            fid,
            sid,
            at_ms,
            meal,
            line,
            numOrNull(it.calories),
            numOrNull(it.protein_g),
            numOrNull(it.carbs_g),
            numOrNull(it.fat_g),
            numOrNull(it.fiber_g),
            null,
            null,
            source,
            chatId,
            messageId,
            analysisId,
            null,
            ts,
          )
          .run();
        createdIds.push(fid);
      }
    }

    return { ok: true, scope_id: sid, analysisId, mode, foodEntryIds: createdIds, count: createdIds.length };
  }

  if (name === "weight_lookup_barcode") {
    const raw = await lookupBarcodeOpenFoodFacts(normStr(args.barcode) ?? "");
    return { ok: true, scope_id: sid, product: raw };
  }

  if (name === "weight_target_get") {
    const row = await env.DB.prepare(`SELECT targets_json, updated_at FROM wm_daily_targets WHERE scope_id=?1 LIMIT 1`)
      .bind(sid)
      .first<{ targets_json: string; updated_at: number }>();
    return { ok: true, scope_id: sid, targets: row ? JSON.parse(row.targets_json) : {}, updated_at: row?.updated_at ?? null };
  }

  if (name === "weight_target_upsert") {
    const targets = isRecord(args.targets) ? args.targets : {};
    const ts = nowMs();
    await env.DB.prepare(
      `INSERT INTO wm_daily_targets (scope_id, targets_json, updated_at) VALUES (?1,?2,?3)
       ON CONFLICT(scope_id) DO UPDATE SET targets_json=excluded.targets_json, updated_at=excluded.updated_at`,
    )
      .bind(sid, JSON.stringify(targets), ts)
      .run();
    return { ok: true, scope_id: sid, updated_at: ts };
  }

  if (name === "weight_water_log") {
    const at_ms = "atMs" in args ? parseAtMs(args.atMs) : parseAtMs(args.atISO);
    const amount = numOrNull(args.amount_ml);
    if (amount == null || amount <= 0) throw new Error("amount_ml required");
    const { chatId, messageId } = parseSourceRef(args);
    const id = crypto.randomUUID();
    const ts = nowMs();
    await env.DB.prepare(
      `INSERT INTO wm_water_log (id, scope_id, at_ms, amount_ml, source, telegram_chat_id, telegram_message_id, created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`,
    )
      .bind(id, sid, at_ms, amount, normStr(args.source), chatId, messageId, ts)
      .run();
    return { ok: true, id, scope_id: sid, at_ms, amount_ml: amount };
  }

  if (name === "weight_water_list") {
    const from = "fromISO" in args ? Date.parse(String(args.fromISO)) : NaN;
    const to = "toISO" in args ? Date.parse(String(args.toISO)) : NaN;
    const limit = typeof args.limit === "number" && Number.isFinite(args.limit) ? Math.min(200, Math.max(1, Math.trunc(args.limit))) : 50;
    const where: string[] = ["scope_id=?1"];
    const binds: unknown[] = [sid];
    if (Number.isFinite(from)) {
      where.push("at_ms >= ?2");
      binds.push(from);
    }
    if (Number.isFinite(to)) {
      where.push(`at_ms <= ?${binds.length + 1}`);
      binds.push(to);
    }
    const q = `SELECT * FROM wm_water_log WHERE ${where.join(" AND ")} ORDER BY at_ms DESC LIMIT ?${binds.length + 1}`;
    binds.push(limit);
    const rows = await env.DB.prepare(q).bind(...binds).all();
    return { ok: true, scope_id: sid, rows: rows.results ?? [] };
  }

  if (name === "weight_fast_start") {
    const start_ms = "startMs" in args ? parseAtMs(args.startMs) : parseAtMs(args.startISO);
    const id = crypto.randomUUID();
    const ts = nowMs();
    await env.DB.prepare(
      `INSERT INTO wm_fast_windows (id, scope_id, start_ms, end_ms, label, source, created_at)
       VALUES (?1,?2,?3,NULL,?4,?5,?6)`,
    )
      .bind(id, sid, start_ms, normStr(args.label), normStr(args.source), ts)
      .run();
    return { ok: true, fastId: id, scope_id: sid, start_ms };
  }

  if (name === "weight_fast_end") {
    const end_ms =
      "endMs" in args && typeof args.endMs === "number"
        ? parseAtMs(args.endMs)
        : "endISO" in args && typeof args.endISO === "string"
          ? parseAtMs(args.endISO)
          : nowMs();
    const fastId = normStr(args.fastId);
    const closeLatest = args.closeLatest === true;
    if (!fastId && !closeLatest) throw new Error("Provide fastId or closeLatest=true");
    let row: { id: string } | null = null;
    if (closeLatest) {
      row = await env.DB.prepare(
        `SELECT id FROM wm_fast_windows WHERE scope_id=?1 AND end_ms IS NULL ORDER BY start_ms DESC LIMIT 1`,
      )
        .bind(sid)
        .first<{ id: string }>();
      if (!row) return { ok: true, scope_id: sid, updated: false, note: "no open fast" };
    } else {
      row = { id: fastId! };
    }
    await env.DB.prepare(`UPDATE wm_fast_windows SET end_ms=?1 WHERE id=?2 AND scope_id=?3`)
      .bind(end_ms, row.id, sid)
      .run();
    return { ok: true, scope_id: sid, fastId: row.id, end_ms, updated: true };
  }

  if (name === "weight_fast_list") {
    const from = "fromISO" in args ? Date.parse(String(args.fromISO)) : NaN;
    const to = "toISO" in args ? Date.parse(String(args.toISO)) : NaN;
    const limit = typeof args.limit === "number" && Number.isFinite(args.limit) ? Math.min(200, Math.max(1, Math.trunc(args.limit))) : 50;
    const where: string[] = ["scope_id=?1"];
    const binds: unknown[] = [sid];
    if (Number.isFinite(from)) {
      where.push("start_ms >= ?2");
      binds.push(from);
    }
    if (Number.isFinite(to)) {
      where.push(`COALESCE(end_ms, start_ms) <= ?${binds.length + 1}`);
      binds.push(to);
    }
    const q = `SELECT * FROM wm_fast_windows WHERE ${where.join(" AND ")} ORDER BY start_ms DESC LIMIT ?${binds.length + 1}`;
    binds.push(limit);
    const rows = await env.DB.prepare(q).bind(...binds).all();
    return { ok: true, scope_id: sid, rows: rows.results ?? [] };
  }

  if (name === "weight_week_summary") {
    const ref = normStr(args.weekStartISO);
    const refMs = ref ? Date.parse(`${ref}T12:00:00.000Z`) : Date.now();
    const monday = new Date(refMs);
    const dow = monday.getUTCDay();
    const diff = (dow + 6) % 7;
    monday.setUTCDate(monday.getUTCDate() - diff);
    const weekStartISO = monday.toISOString().slice(0, 10);
    const weekStartMs = Date.parse(`${weekStartISO}T00:00:00.000Z`);
    const weekEndMs = weekStartMs + 7 * 86400000;

    const targetsRow = await env.DB.prepare(`SELECT targets_json FROM wm_daily_targets WHERE scope_id=?1 LIMIT 1`)
      .bind(sid)
      .first<{ targets_json: string }>();
    const targets = targetsRow ? (JSON.parse(targetsRow.targets_json) as Record<string, unknown>) : null;

    const days: Array<{
      dateISO: string;
      totals: { calories: number; protein_g: number; carbs_g: number; fat_g: number };
      water_ml: number;
      weight_count: number;
    }> = [];

    for (let i = 0; i < 7; i++) {
      const d0 = new Date(weekStartMs + i * 86400000);
      const dateISO = d0.toISOString().slice(0, 10);
      const dayStart = Date.parse(`${dateISO}T00:00:00.000Z`);
      const dayEnd = dayStart + 86400000;

      const foods = await env.DB.prepare(
        `SELECT calories, protein_g, carbs_g, fat_g FROM wm_food_entries WHERE scope_id=?1 AND at_ms>=?2 AND at_ms<?3`,
      )
        .bind(sid, dayStart, dayEnd)
        .all();
      let calories = 0;
      let protein_g = 0;
      let carbs_g = 0;
      let fat_g = 0;
      for (const r of foods.results ?? []) {
        const rr = r as Record<string, unknown>;
        calories += typeof rr.calories === "number" ? rr.calories : 0;
        protein_g += typeof rr.protein_g === "number" ? rr.protein_g : 0;
        carbs_g += typeof rr.carbs_g === "number" ? rr.carbs_g : 0;
        fat_g += typeof rr.fat_g === "number" ? rr.fat_g : 0;
      }
      const wrow = await env.DB.prepare(
        `SELECT COALESCE(SUM(amount_ml),0) as w FROM wm_water_log WHERE scope_id=?1 AND at_ms>=?2 AND at_ms<?3`,
      )
        .bind(sid, dayStart, dayEnd)
        .first<{ w: number }>();
      const wc = await env.DB.prepare(
        `SELECT 0 as c`,
      )
        .bind(sid, dayStart, dayEnd)
        .first<{ c: number }>();

      days.push({
        dateISO,
        totals: { calories, protein_g, carbs_g, fat_g },
        water_ml: wrow?.w ?? 0,
        weight_count: wc?.c ?? 0,
      });
    }

    const tCal = typeof targets?.calories === "number" ? targets.calories : null;
    const tWater = typeof targets?.water_ml_day === "number" ? targets.water_ml_day : null;

    return {
      ok: true,
      scope_id: sid,
      weekStartISO,
      weekEndISO: new Date(weekEndMs).toISOString().slice(0, 10),
      targets,
      days,
      hints:
        tCal != null || tWater != null
          ? {
              avg_daily_calories: days.reduce((s, d) => s + d.totals.calories, 0) / 7,
              target_calories: tCal,
              avg_daily_water_ml: days.reduce((s, d) => s + d.water_ml, 0) / 7,
              target_water_ml_day: tWater,
            }
          : undefined,
    };
  }

  throw new Error(`Unknown tool: ${name}`);
}

async function handleMcp(req: Request, env: Env): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: cors(req) });

  requireAuth(req, env);

  let body: JsonRpcRequest | null = null;
  try {
    body = (await req.json()) as JsonRpcRequest;
  } catch {
    return json({ error: "invalid_json" }, { status: 400, headers: cors(req) });
  }

  const id = body?.id ?? 1;
  const method = body?.method ?? "";
  const params = isRecord(body?.params) ? (body!.params as Record<string, unknown>) : {};

  let resp: unknown;
  try {
    // MCP Streamable HTTP handshake (required by langchain-mcp-adapters).
    if (method === "initialize") {
      weightMcpLog(env, "jsonrpc", { method: "initialize" });
      resp = {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          serverInfo: { name: "gym-weight-management-mcp", version: "0.1.0" },
          capabilities: {
            tools: {},
          },
        },
      };
    } else if (method === "notifications/initialized") {
      // One-way notification; acknowledge with empty result for compatibility.
      weightMcpLog(env, "jsonrpc", { method: "notifications/initialized" });
      resp = { jsonrpc: "2.0", id, result: {} };
    } else if (method === "tools/list") {
      weightMcpLog(env, "jsonrpc", { method: "tools/list" });
      const tools = toolList();
      weightMcpLog(env, "jsonrpc_ok", { method: "tools/list", toolCount: tools.length });
      resp = { jsonrpc: "2.0", id, result: { tools } };
    } else if (method === "tools/call") {
      const name = normStr(params.name);
      const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
      if (!name) resp = errResult(id, -32602, "Missing tool name");
      else {
        const t0 = Date.now();
        weightMcpLog(env, "tools/call", { tool: name, args: summarizeWeightToolArgs(name, args) });
        const out = await toolCall(env, name, args);
        weightMcpLog(env, "tools/call_ok", { tool: name, ms: Date.now() - t0 });
        resp = okResult(id, JSON.stringify(out, null, 2));
      }
    } else {
      weightMcpLog(env, "jsonrpc_unknown_method", { method });
      resp = errResult(id, -32601, `Unknown method: ${method}`);
    }
  } catch (e) {
    if (e instanceof Response) return e;
    weightMcpLog(env, "jsonrpc_error", { method, error: (e as Error).message });
    resp = errResult(id, -32603, (e as Error).message);
  }

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sseJson(resp)));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-store", ...cors(req) },
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") return json({ ok: true, ts: nowMs() }, { headers: cors(req) });
    if (url.pathname === "/mcp") {
      weightMcpLog(env, "http_enter", { path: "/mcp", method: req.method });
      return handleMcp(req, env);
    }
    return new Response("Not Found", { status: 404, headers: cors(req) });
  },
};

