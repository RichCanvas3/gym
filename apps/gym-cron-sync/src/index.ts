type Service = { fetch(input: Request | string, init?: RequestInit): Promise<Response> };

export type Env = {
  MCP_API_KEY?: string;
  // Which weight-management scope we sync into.
  SYNC_TELEGRAM_USER_ID?: string;
  SYNC_CHAT_TITLE?: string;
  SYNC_TZ_NAME?: string;
  SYNC_LOOKBACK_DAYS?: string;

  TELEGRAM_MCP: Service;
  WEIGHT_MCP: Service;
  STRAVA_MCP: Service;
};

function nowISO() {
  return new Date().toISOString();
}

async function readSseJson(res: Response): Promise<any> {
  const txt = await res.text();
  const m = txt.match(/data: (.+)\n/);
  if (!m) {
    return { jsonrpc: "2.0", id: 1, error: { message: `Unexpected SSE: ${txt.slice(0, 200)}` } };
  }
  return JSON.parse(m[1]);
}

async function mcpCall(service: Service, apiKey: string | undefined, tool: string, args: Record<string, unknown>) {
  const res = await service.fetch("http://service/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(apiKey ? { "x-api-key": apiKey } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
  });
  const msg = await readSseJson(res);
  const text = msg?.result?.content?.[0]?.text;
  return typeof text === "string" ? JSON.parse(text) : msg;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function firstImageUrl(m: any): string | null {
  const direct = typeof m?.imageUrl === "string" ? m.imageUrl.trim() : "";
  if (direct) return direct;
  const img = m?.image;
  const u1 = typeof img?.url === "string" ? img.url.trim() : "";
  if (u1) return u1;
  const u2 = typeof img?.imageUrl === "string" ? img.imageUrl.trim() : "";
  if (u2) return u2;
  return null;
}

function safeInt(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;
}

function fmtKcal(v: unknown): string {
  return typeof v === "number" && Number.isFinite(v) ? `~${Math.round(v)} kcal` : "";
}

function normalizeTelegramUserId(raw: string): string {
  const t = (raw || "").trim();
  if (!t) return "";
  // Accept either "6105195555" or "tg:6105195555"
  if (t.startsWith("tg:")) return t.slice("tg:".length);
  return t;
}

function fmtDistanceMeters(m: unknown): string {
  if (typeof m !== "number" || !Number.isFinite(m) || m <= 0) return "";
  const km = m / 1000;
  const mi = km * 0.621371;
  return mi >= 0.5 ? `${mi.toFixed(1)} mi` : `${km.toFixed(1)} km`;
}

function fmtDurationSeconds(s: unknown): string {
  if (typeof s !== "number" || !Number.isFinite(s) || s <= 0) return "";
  const sec = Math.trunc(s);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function fmtWorkoutLine(wk: any): string {
  const activityType = asString(wk?.activity_type).trim() || "Workout";
  const startedAtISO = asString(wk?.started_at_iso).trim();
  const when = startedAtISO ? startedAtISO.replace(".000Z", "Z") : "";
  const dist = fmtDistanceMeters(wk?.distance_meters);
  const dur = fmtDurationSeconds(wk?.duration_seconds);
  const kcal = fmtKcal(wk?.active_energy_kcal);
  const parts = [activityType, when ? `(${when})` : "", dur ? `• ${dur}` : "", dist ? `• ${dist}` : "", kcal ? `• ${kcal}` : ""].filter(Boolean);
  return `Workout synced: ${parts.join(" ")}`.trim();
}

async function syncTelegram(env: Env) {
  const apiKey = (env.MCP_API_KEY ?? "").trim() || undefined;
  const chatTitle = (env.SYNC_CHAT_TITLE ?? "Smart Agent").trim();
  const tzName = (env.SYNC_TZ_NAME ?? "UTC").trim() || "UTC";

  const tgUserIdEnv = normalizeTelegramUserId((env.SYNC_TELEGRAM_USER_ID ?? "").trim());

  const chats = await mcpCall(env.TELEGRAM_MCP, apiKey, "telegram_list_chats", {
    limit: 200,
    ...(tgUserIdEnv ? { fromUserId: tgUserIdEnv } : {}),
  });
  const chatList = Array.isArray(chats?.chats) ? chats.chats : [];
  const chat = chatList.find((c: any) => asString(c?.title).trim().toLowerCase() === chatTitle.toLowerCase());
  const chatId = asString(chat?.chatId).trim();
  if (!chatId) return { ok: true, imported: 0, replied: 0, reason: "chat_not_found" };

  const msgs = await mcpCall(env.TELEGRAM_MCP, apiKey, "telegram_list_messages", {
    chatId,
    ...(tgUserIdEnv ? { fromUserId: tgUserIdEnv } : {}),
    limit: 50,
    includeImageUrls: true,
    includeImageBytes: false,
  });
  const items = Array.isArray(msgs?.messages) ? msgs.messages : [];

  let imported = 0;
  let replied = 0;
  const errors: Array<{ messageId: number; error: string }> = [];
  for (const m of items) {
    const mid = safeInt(m?.messageId);
    if (mid == null) continue;
    const dateUnix = safeInt(m?.dateUnix);
    const atMs = dateUnix != null ? dateUnix * 1000 : Date.now();
    const text = asString(m?.text).trim();
    const imageUrl = firstImageUrl(m);
    if (!text && !imageUrl) continue;

    const tgUserId = asString(m?.fromUserId).trim();
    if (!tgUserId) continue;

    const out = await mcpCall(env.WEIGHT_MCP, apiKey, "weight_ingest_telegram_message", {
      scope: { telegramUserId: tgUserId },
      tzName,
      chatId,
      messageId: mid,
      dateUnix,
      atMs,
      text,
      imageUrl,
      locale: "en-US",
    });

    if (out?.ok !== true) {
      const err = typeof out?.error === "string" ? out.error : JSON.stringify(out?.error ?? out).slice(0, 300);
      errors.push({ messageId: mid, error: err });
      continue;
    }
    if (out?.kind === "ignored") continue;
    if (out?.deduped === true) continue;
    imported += 1;

    // Reply with quick summary to confirm ingestion.
    let reply = "";
    if (out.kind === "meal_text") {
      const r = out.result ?? {};
      reply = `Logged ${asString(r.meal || "meal")} (${fmtKcal(r?.totals?.calories || r?.calories)}).`;
    } else if (out.kind === "meal_photo") {
      const fe = out.foodEntry ?? null;
      if (fe && typeof fe === "object") {
        reply = `Logged ${asString((fe as any).meal || "meal")} (${fmtKcal((fe as any).calories)}).`;
      } else {
        const r = out.result ?? {};
        reply = `Analyzed meal photo (${asString(r?.summary) || "ok"}).`;
      }
    } else if (out.kind === "weight") {
      const r = out.result ?? {};
      const kg = typeof r.weight_kg === "number" ? `${r.weight_kg.toFixed(1)} kg` : "weight";
      reply = `Logged weigh-in: ${kg}.`;
    } else {
      reply = `Logged: ${asString(out.kind) || "entry"}.`;
    }

    if (reply) {
      await mcpCall(env.TELEGRAM_MCP, apiKey, "telegram_send_message", {
        chatId,
        text: reply,
        replyToMessageId: mid,
        disableNotification: true,
      });
      replied += 1;
    }
  }

  return { ok: true, imported, replied, errors: errors.slice(0, 5) };
}

async function syncStrava(env: Env) {
  const apiKey = (env.MCP_API_KEY ?? "").trim() || undefined;
  const tzName = (env.SYNC_TZ_NAME ?? "UTC").trim() || "UTC";
  const chatTitle = (env.SYNC_CHAT_TITLE ?? "Smart Agent").trim();
  const tgUserId = normalizeTelegramUserId((env.SYNC_TELEGRAM_USER_ID ?? "").trim());
  if (!tgUserId) return { ok: true, inserted: 0, messaged: 0, reason: "missing_sync_telegram_user_id" };

  const chats = await mcpCall(env.TELEGRAM_MCP, apiKey, "telegram_list_chats", { limit: 200 });
  const chatList = Array.isArray(chats?.chats) ? chats.chats : [];
  const chat = chatList.find((c: any) => asString(c?.title).trim().toLowerCase() === chatTitle.toLowerCase());
  const chatId = asString(chat?.chatId).trim();
  if (!chatId) return { ok: true, inserted: 0, messaged: 0, reason: "chat_not_found" };

  const lookbackDays = Number.parseInt((env.SYNC_LOOKBACK_DAYS ?? "7").trim(), 10);
  await mcpCall(env.STRAVA_MCP, apiKey, "strava_sync", {
    telegramUserId: tgUserId,
    lookbackDays: Number.isFinite(lookbackDays) ? lookbackDays : 7,
  });
  const w = await mcpCall(env.STRAVA_MCP, apiKey, "strava_list_workouts", { telegramUserId: tgUserId, limit: 50 });
  const workouts = Array.isArray(w?.workouts) ? w.workouts : [];

  let inserted = 0;
  let messaged = 0;
  const errors: Array<{ workoutId: string; error: string }> = [];
  for (const wk of workouts.slice(0, 50)) {
    const workoutId = asString(wk?.workout_id).trim();
    if (!workoutId) continue;
    const startedAtISO = asString(wk?.started_at_iso).trim();
    const activityType = asString(wk?.activity_type).trim();
    const durationSeconds = safeInt(wk?.duration_seconds);
    const distanceMeters = typeof wk?.distance_meters === "number" ? wk.distance_meters : null;
    const kcal = typeof wk?.active_energy_kcal === "number" ? wk.active_energy_kcal : null;

    const out = await mcpCall(env.WEIGHT_MCP, apiKey, "weight_ingest_workout", {
      scope: { telegramUserId: tgUserId },
      source: "strava",
      workoutId,
      startedAtISO,
      activityType,
      durationSeconds,
      distanceMeters,
      activeEnergyKcal: kcal,
      raw: wk,
    });
    if (out?.ok !== true) {
      const err = typeof out?.error === "string" ? out.error : JSON.stringify(out?.error ?? out).slice(0, 300);
      errors.push({ workoutId, error: err });
      continue;
    }
    if (out?.deduped === true) continue;
    inserted += 1;

    const line = fmtWorkoutLine(wk);
    await mcpCall(env.TELEGRAM_MCP, apiKey, "telegram_send_message", {
      chatId,
      text: line,
      disableNotification: true,
    });
    messaged += 1;
  }

  return { ok: true, inserted, messaged, tzName, scopeTelegramUserId: tgUserId, errors: errors.slice(0, 5) };
}

async function runCron(env: Env) {
  const t0 = Date.now();
  const tg = await syncTelegram(env).catch((e) => ({ ok: false, error: String((e as any)?.message ?? e) }));
  const st = await syncStrava(env).catch((e) => ({ ok: false, error: String((e as any)?.message ?? e) }));
  return { ok: true, asOfISO: nowISO(), ms: Date.now() - t0, telegram: tg, strava: st };
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return new Response(JSON.stringify({ ok: true, asOfISO: nowISO() }, null, 2));
    if (url.pathname === "/run") {
      const out = await runCron(env);
      return new Response(JSON.stringify(out, null, 2), { headers: { "content-type": "application/json; charset=utf-8" } });
    }
    return new Response("Not Found", { status: 404 });
  },
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runCron(env));
  },
};

