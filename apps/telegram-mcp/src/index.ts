import { createMcpHandler } from "agents/mcp";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const TELEGRAM_URI_PREFIX = "telegram://chat/";
const TELEGRAM_URI_SUFFIX = "/messages";

export type Env = {
  MCP_API_KEY?: string;
  DB: D1Database;
  MEDIA_TOKEN_RESOLVER: DurableObjectNamespace;
  TELEGRAM_BOT_TOKEN?: string;
  /** Bot username (without @). If unset, we’ll call getMe to discover it when needed. */
  TELEGRAM_BOT_USERNAME?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  MCP_SESSION_ID?: string; // set from mcp-session-id header for subscribe + pending flush
  /** Base URL of this worker (no trailing slash), e.g. https://gym-telegram-mcp.xxx.workers.dev — required for public image URLs in message JSON */
  PUBLIC_BASE_URL?: string;
  /** Alias for PUBLIC_BASE_URL */
  TELEGRAM_MCP_PUBLIC_URL?: string;
  /** Set to `1` with a wrangler `triggers.crons` entry to run Smart Agent image backfill on schedule */
  TELEGRAM_CRON_BACKFILL?: string;
};

function nowISO() {
  return new Date().toISOString();
}

function jsonText(obj: unknown) {
  return JSON.stringify(obj, null, 2);
}

async function ensureSchema(env: Env): Promise<void> {
  // These tables also exist in schema.sql; create idempotently for safety.
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS telegram_oauth_states (
      state TEXT PRIMARY KEY,
      account_address TEXT NOT NULL,
      created_at_iso TEXT NOT NULL
    )`,
  ).run();
  await env.DB.prepare(
    `CREATE INDEX IF NOT EXISTS idx_telegram_oauth_states_created ON telegram_oauth_states(created_at_iso DESC)`,
  ).run();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS telegram_account_links (
      account_address TEXT PRIMARY KEY,
      telegram_user_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      linked_at_iso TEXT NOT NULL
    )`,
  ).run();
  await env.DB.prepare(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_account_links_tg_user ON telegram_account_links(telegram_user_id)`,
  ).run();
}

async function requireApiKey(request: Request, env: Env) {
  const want = (env.MCP_API_KEY ?? "").trim();
  if (!want) return;
  const got = (request.headers.get("x-api-key") ?? "").trim();
  if (got !== want) throw new Error("Unauthorized (bad x-api-key)");
}

function tgBase(env: Env) {
  const token = (env.TELEGRAM_BOT_TOKEN ?? "").trim();
  if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN");
  return `https://api.telegram.org/bot${token}`;
}

async function tgCall(env: Env, method: string, payload: unknown) {
  const res = await fetch(`${tgBase(env)}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  });
  const json = (await res.json().catch(() => ({}))) as any;
  if (!res.ok || json?.ok === false) {
    throw new Error(`Telegram ${method} failed: ${JSON.stringify(json)}`);
  }
  return json;
}

function base64Url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.byteLength; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function newConnectState(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return base64Url(b);
}

async function resolveBotUsername(env: Env): Promise<string> {
  const fromEnv = String(env.TELEGRAM_BOT_USERNAME ?? "").trim().replace(/^@/, "");
  if (fromEnv) return fromEnv;
  const me = await tgCall(env, "getMe", {});
  const uname = String(me?.result?.username ?? "").trim().replace(/^@/, "");
  if (!uname) throw new Error("Missing TELEGRAM_BOT_USERNAME (and getMe returned no username)");
  return uname;
}

async function createConnectState(env: Env, accountAddress: string): Promise<{ ok: true; accountAddress: string; state: string; startUrl: string }> {
  const acct = String(accountAddress ?? "").trim();
  if (!acct) throw new Error("Missing accountAddress");
  await ensureSchema(env);
  const state = newConnectState();
  const ts = nowISO();
  await env.DB.prepare(`INSERT INTO telegram_oauth_states (state, account_address, created_at_iso) VALUES (?, ?, ?)`)
    .bind(state, acct, ts)
    .run();
  const botUsername = await resolveBotUsername(env);
  const startUrl = `https://t.me/${encodeURIComponent(botUsername)}?start=${encodeURIComponent(state)}`;
  return { ok: true, accountAddress: acct, state, startUrl };
}

async function getAccountLink(env: Env, accountAddress: string): Promise<{ ok: true; linked: boolean; accountAddress: string; telegramUserId: string | null; chatId: string | null; linkedAtISO: string | null }> {
  const acct = String(accountAddress ?? "").trim();
  if (!acct) throw new Error("Missing accountAddress");
  await ensureSchema(env);
  const row = await env.DB.prepare(
    `SELECT telegram_user_id, chat_id, linked_at_iso FROM telegram_account_links WHERE account_address = ? LIMIT 1`,
  )
    .bind(acct)
    .first<{ telegram_user_id: string; chat_id: string; linked_at_iso: string }>();
  if (!row) return { ok: true, linked: false, accountAddress: acct, telegramUserId: null, chatId: null, linkedAtISO: null };
  return {
    ok: true,
    linked: true,
    accountAddress: acct,
    telegramUserId: String((row as any).telegram_user_id ?? "").trim() || null,
    chatId: String((row as any).chat_id ?? "").trim() || null,
    linkedAtISO: String((row as any).linked_at_iso ?? "").trim() || null,
  };
}

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES_PER_RESPONSE = 20;

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.byteLength; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

function mimeFromFilePath(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return "image/jpeg";
}

/** Largest Telegram photo variant (last in array). */
function largestPhotoFileId(raw: any): string | null {
  const photos = raw?.photo;
  if (!Array.isArray(photos) || photos.length === 0) return null;
  const last = photos[photos.length - 1];
  const fid = last?.file_id;
  return typeof fid === "string" && fid.length > 0 ? fid : null;
}

/** Image document (e.g. sent as file). */
function imageDocumentFileId(raw: any): string | null {
  const doc = raw?.document;
  if (!doc || typeof doc !== "object") return null;
  const mt = String(doc.mime_type ?? "");
  if (!mt.startsWith("image/")) return null;
  const fid = doc.file_id;
  return typeof fid === "string" ? fid : null;
}

function publicBaseUrl(env: Env): string {
  return (env.PUBLIC_BASE_URL ?? env.TELEGRAM_MCP_PUBLIC_URL ?? "").trim().replace(/\/$/, "");
}

const MEDIA_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function registerMediaToken(env: Env, fileId: string): Promise<{ url: string } | { error: string }> {
  const base = publicBaseUrl(env);
  if (!base) {
    console.warn(
      "[telegram-mcp] media: skip register — PUBLIC_BASE_URL / TELEGRAM_MCP_PUBLIC_URL not set (no public image URL)",
    );
    return { error: "Set PUBLIC_BASE_URL or TELEGRAM_MCP_PUBLIC_URL on the worker (e.g. https://gym-telegram-mcp.xxx.workers.dev) for image URLs" };
  }
  const token = crypto.randomUUID();
  const now = nowISO();
  const exp = new Date(Date.now() + MEDIA_TOKEN_TTL_MS).toISOString();
  await env.DB.prepare(
    `INSERT INTO telegram_media_tokens (token, file_id, created_at_iso, expires_at_iso) VALUES (?, ?, ?, ?)`,
  )
    .bind(token, fileId, now, exp)
    .run();
  // Write-through to a single DO (strongly consistent) so other colos can resolve immediately.
  try {
    const id = env.MEDIA_TOKEN_RESOLVER.idFromName("global");
    const stub = env.MEDIA_TOKEN_RESOLVER.get(id);
    const u = new URL("https://media-token-resolver/put");
    await stub.fetch(u.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, file_id: fileId, expires_at_iso: exp }),
    });
  } catch (e) {
    console.warn(`[telegram-mcp] media: DO write-through failed: ${String((e as Error)?.message ?? e)}`);
  }
  const url = `${base}/telegram/media/${token}`;
  console.log(
    `[telegram-mcp] media: DB insert token ok → public url=${url} file_id=${fileId.slice(0, 24)}${fileId.length > 24 ? "…" : ""}`,
  );
  return { url };
}

/** Stream file body from Telegram (for public GET). */
async function streamTelegramFileFromTelegram(
  env: Env,
  fileId: string,
): Promise<{ body: ReadableStream<Uint8Array>; mimeType: string } | { error: string }> {
  try {
    const json = (await tgCall(env, "getFile", { file_id: fileId })) as any;
    const fp = json?.result?.file_path;
    if (typeof fp !== "string" || !fp.trim()) return { error: "getFile: missing file_path" };
    const bot = (env.TELEGRAM_BOT_TOKEN ?? "").trim();
    const fileUrl = `https://api.telegram.org/file/bot${bot}/${fp}`;
    const res = await fetch(fileUrl);
    if (!res.ok) return { error: `Telegram file fetch failed: ${res.status}` };
    if (!res.body) return { error: "Empty body" };
    const mimeType = mimeFromFilePath(fp);
    return { body: res.body as ReadableStream<Uint8Array>, mimeType };
  } catch (e) {
    return { error: String((e as Error)?.message ?? e) };
  }
}

async function downloadTelegramFile(
  env: Env,
  fileId: string,
): Promise<{ base64: string; mimeType: string; byteLength: number } | { error: string }> {
  try {
    const json = (await tgCall(env, "getFile", { file_id: fileId })) as any;
    const fp = json?.result?.file_path;
    if (typeof fp !== "string" || !fp.trim()) return { error: "getFile: missing file_path" };
    const token = (env.TELEGRAM_BOT_TOKEN ?? "").trim();
    const fileUrl = `https://api.telegram.org/file/bot${token}/${fp}`;
    const res = await fetch(fileUrl);
    if (!res.ok) return { error: `file download failed: ${res.status}` };
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > MAX_IMAGE_BYTES) {
      return { error: `file too large (${buf.byteLength} bytes, max ${MAX_IMAGE_BYTES})` };
    }
    const mimeType = mimeFromFilePath(fp);
    return { base64: bytesToBase64(buf), mimeType, byteLength: buf.byteLength };
  } catch (e) {
    return { error: String((e as Error)?.message ?? e) };
  }
}

const MEDIA_404_HEADERS = { "cache-control": "no-store", "CDN-Cache-Control": "no-store" };
const MEDIA_410_HEADERS = { "cache-control": "no-store", "CDN-Cache-Control": "no-store" };

async function handleTelegramMediaGet(env: Env, request: Request, token: string): Promise<Response> {
  let row = await env.DB.prepare(`SELECT file_id, expires_at_iso FROM telegram_media_tokens WHERE token = ? LIMIT 1`)
    .bind(token)
    .first<{ file_id: string; expires_at_iso: string }>();
  // D1 reads can be inconsistent across colos shortly after writes. If this edge misses,
  // consult a single durable object which does the lookup from its pinned colo.
  if (!row) {
    try {
      const id = env.MEDIA_TOKEN_RESOLVER.idFromName("global");
      const stub = env.MEDIA_TOKEN_RESOLVER.get(id);
      const u = new URL("https://media-token-resolver/resolve");
      u.searchParams.set("token", token);
      const rr = await stub.fetch(u.toString(), { method: "GET" });
      if (rr.ok) {
        const j = (await rr.json().catch(() => null)) as null | { file_id?: string; expires_at_iso?: string };
        if (j?.file_id) {
          row = { file_id: String(j.file_id), expires_at_iso: String(j.expires_at_iso ?? "") };
          console.log(`[telegram-mcp] media: DO resolver hit token=${token.slice(0, 8)}…`);
        }
      }
    } catch (e) {
      console.warn(`[telegram-mcp] media: DO resolver failed: ${String((e as Error)?.message ?? e)}`);
    }
  }
  if (!row) {
    console.warn(
      `[telegram-mcp] media: GET unknown token len=${token.length} id=${token} url=${request.url.slice(0, 160)}`,
    );
    return new Response("Not found", { status: 404, headers: MEDIA_404_HEADERS });
  }
  if (row.expires_at_iso && new Date(row.expires_at_iso) < new Date()) {
    await env.DB.prepare(`DELETE FROM telegram_media_tokens WHERE token = ?`).bind(token).run();
    console.warn(`[telegram-mcp] media: GET expired token prefix=${token.slice(0, 8)}…`);
    return new Response("Expired", { status: 410, headers: MEDIA_410_HEADERS });
  }
  console.log(
    `[telegram-mcp] media: GET proxy Telegram file token=${token.slice(0, 8)}… file_id=${row.file_id.slice(0, 20)}…`,
  );
  const streamed = await streamTelegramFileFromTelegram(env, row.file_id);
  if ("error" in streamed) {
    console.warn(`[telegram-mcp] media: GET stream failed: ${streamed.error}`);
    return new Response(streamed.error, {
      status: 502,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
  return new Response(streamed.body, {
    headers: {
      "content-type": streamed.mimeType,
      "cache-control": "public, max-age=3600",
      "access-control-allow-origin": "*",
    },
  });
}

export class MediaTokenResolver {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/put") {
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      const body = (await request.json().catch(() => null)) as null | { token?: string; file_id?: string; expires_at_iso?: string };
      const token = (body?.token ?? "").trim();
      const fileId = (body?.file_id ?? "").trim();
      const exp = (body?.expires_at_iso ?? "").trim();
      if (!token || !fileId) return new Response("Missing token/file_id", { status: 400 });
      await this.state.storage.put(`t:${token}`, { file_id: fileId, expires_at_iso: exp });
      return new Response("ok", { status: 200 });
    }
    if (url.pathname === "/resolve") {
      if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
      const token = (url.searchParams.get("token") ?? "").trim();
      if (!token) return new Response("Missing token", { status: 400 });

      const cached = (await this.state.storage.get<{ file_id?: string; expires_at_iso?: string }>(`t:${token}`)) ?? null;
      if (cached?.file_id) {
        return new Response(JSON.stringify(cached), { headers: { "content-type": "application/json; charset=utf-8" } });
      }

      const row = await this.env.DB.prepare(
        `SELECT file_id, expires_at_iso FROM telegram_media_tokens WHERE token = ? LIMIT 1`,
      )
        .bind(token)
        .first<{ file_id: string; expires_at_iso: string }>();
      if (!row) return new Response("Not found", { status: 404 });
      await this.state.storage.put(`t:${token}`, row);
      return new Response(JSON.stringify(row), { headers: { "content-type": "application/json; charset=utf-8" } });
    }
    return new Response("Not found", { status: 404 });
  }
}

type MessageRow = {
  message_id: unknown;
  message_thread_id?: unknown;
  from_user_id?: unknown;
  date_unix?: unknown;
  text?: unknown;
  raw_json?: unknown;
};

async function mapMessageRowToPayload(
  env: Env,
  r: MessageRow,
  opts: { includeImageUrls: boolean; includeImageBytes: boolean },
  imageBudget: { remaining: number },
): Promise<Record<string, unknown>> {
  let raw: Record<string, unknown> = {};
  try {
    if (typeof r.raw_json === "string") raw = JSON.parse(r.raw_json) as Record<string, unknown>;
    else if (r.raw_json && typeof r.raw_json === "object") raw = r.raw_json as Record<string, unknown>;
  } catch {
    raw = {};
  }
  const out: Record<string, unknown> = {
    messageId: Number(r.message_id ?? 0),
    messageThreadId:
      r.message_thread_id !== null && r.message_thread_id !== undefined ? Number(r.message_thread_id) : null,
    fromUserId: r.from_user_id !== null && r.from_user_id !== undefined ? Number(r.from_user_id) : null,
    dateUnix: r.date_unix !== null && r.date_unix !== undefined ? Number(r.date_unix) : null,
    text: r.text != null ? String(r.text) : null,
  };
  if ((!opts.includeImageUrls && !opts.includeImageBytes) || imageBudget.remaining <= 0) return out;

  const fileId = largestPhotoFileId(raw) ?? imageDocumentFileId(raw);
  if (!fileId) return out;

  imageBudget.remaining -= 1;
  const image: Record<string, unknown> = { fileId };

  if (opts.includeImageUrls) {
    const reg = await registerMediaToken(env, fileId);
    if ("error" in reg) image.urlError = reg.error;
    else {
      image.url = reg.url;
      image.imageUrl = reg.url;
      out.imageUrl = reg.url;
    }
  }

  if (opts.includeImageBytes) {
    const dl = await downloadTelegramFile(env, fileId);
    if ("error" in dl) image.bytesError = dl.error;
    else {
      image.mimeType = dl.mimeType;
      image.byteLength = dl.byteLength;
      image.bytesBase64 = dl.base64;
    }
  }

  out.image = image;
  return out;
}

async function upsertChat(env: Env, chat: any) {
  const chatId = chat?.id;
  if (typeof chatId !== "number" && typeof chatId !== "string") return;
  const id = String(chatId);
  const type = chat?.type ? String(chat.type) : null;
  const title = chat?.title ? String(chat.title) : null;
  const username = chat?.username ? String(chat.username) : null;
  const ts = nowISO();
  await env.DB.prepare(
    `INSERT INTO telegram_chats (chat_id, type, title, username, created_at_iso, updated_at_iso)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET
       type=excluded.type,
       title=excluded.title,
       username=excluded.username,
       updated_at_iso=excluded.updated_at_iso`,
  )
    .bind(id, type, title, username, ts, ts)
    .run();
}

function numOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseInt(v, 10);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

async function insertMessage(env: Env, msg: any) {
  const chatId = msg?.chat?.id;
  const messageId = numOrNull(msg?.message_id);
  if ((typeof chatId !== "number" && typeof chatId !== "string") || messageId == null) return;
  const chat_id = String(chatId);
  const message_thread_id = numOrNull(msg?.message_thread_id);
  const id = `${chat_id}:${messageId}${message_thread_id != null ? `:${message_thread_id}` : ""}`;
  const from_user_id = numOrNull(msg?.from?.id);
  const date_unix = numOrNull(msg?.date);
  const text =
    typeof msg?.text === "string"
      ? msg.text
      : typeof msg?.caption === "string"
        ? msg.caption
        : null;
  const ts = nowISO();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO telegram_messages (
      id, chat_id, message_id, message_thread_id, from_user_id, date_unix, text, raw_json, created_at_iso
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, chat_id, messageId, message_thread_id ?? null, from_user_id ?? null, date_unix ?? null, text, JSON.stringify(msg), ts)
    .run();
}

/** Resolve resource URI to chatId. By-id: telegram://chat/{chatId}/messages. By-title: telegram://chat/by-title/{title}/messages */
async function uriToChatId(uri: string, env: Env): Promise<string | null> {
  if (!uri.startsWith(TELEGRAM_URI_PREFIX) || !uri.endsWith(TELEGRAM_URI_SUFFIX)) return null;
  const middle = uri.slice(TELEGRAM_URI_PREFIX.length, -TELEGRAM_URI_SUFFIX.length);
  if (middle.startsWith("by-title/")) {
    const title = decodeURIComponent(middle.slice("by-title/".length));
    const row = await env.DB.prepare(`SELECT chat_id FROM telegram_chats WHERE title = ? LIMIT 1`)
      .bind(title)
      .first<{ chat_id: string }>();
    return row?.chat_id ?? null;
  }
  return middle ? middle : null;
}

/** Return both possible resource URIs for a chat (by id and by title) for matching subscriptions */
function chatToResourceUris(chatId: string, title: string | null): string[] {
  const byId = `${TELEGRAM_URI_PREFIX}${chatId}${TELEGRAM_URI_SUFFIX}`;
  const uris = [byId];
  if (title && title.trim()) {
    uris.push(`${TELEGRAM_URI_PREFIX}by-title/${encodeURIComponent(title.trim())}${TELEGRAM_URI_SUFFIX}`);
  }
  return uris;
}

/** Get and clear pending notifications for a session. Returns list of resource_uri. */
async function getAndClearPendingNotifications(env: Env, sessionId: string): Promise<{ resource_uri: string }[]> {
  if (!sessionId.trim()) return [];
  const res = await env.DB.prepare(
    `SELECT resource_uri FROM telegram_pending_notifications WHERE session_id = ?`,
  )
    .bind(sessionId)
    .all();
  const rows = (res.results ?? []) as { resource_uri: string }[];
  await env.DB.prepare(`DELETE FROM telegram_pending_notifications WHERE session_id = ?`)
    .bind(sessionId)
    .run();
  return rows;
}

async function handleWebhook(request: Request, env: Env): Promise<Response> {
  const want = (env.TELEGRAM_WEBHOOK_SECRET ?? "").trim();
  if (want) {
    const got = (request.headers.get("x-telegram-bot-api-secret-token") ?? "").trim();
    if (got !== want) {
      return new Response(
        jsonText({
          error: "Webhook secret mismatch",
          hint: "Either set Telegram webhook with secret_token matching TELEGRAM_WEBHOOK_SECRET, or remove TELEGRAM_WEBHOOK_SECRET (wrangler secret delete TELEGRAM_WEBHOOK_SECRET) to accept without a secret.",
        }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    }
  }
  const update = (await request.json().catch(() => null)) as any;
  const updateId = update?.update_id;
  if (typeof updateId !== "number") return new Response("Bad update", { status: 400 });
  await env.DB.prepare(`INSERT OR IGNORE INTO telegram_updates (update_id, received_at_iso, raw_json) VALUES (?, ?, ?)`)
    .bind(updateId, nowISO(), JSON.stringify(update))
    .run();

  const msg = update?.message ?? update?.edited_message ?? update?.channel_post ?? update?.edited_channel_post;
  const chatFromMember = update?.my_chat_member?.chat ?? update?.chat_member?.chat;
  let chatId: string | null = null;
  let title: string | null = null;
  if (msg?.chat) {
    await upsertChat(env, msg.chat);
    await insertMessage(env, msg);
    chatId = String(msg.chat?.id ?? "");
    title = msg.chat?.title ? String(msg.chat.title) : null;
    // "Connect Telegram": user taps https://t.me/<bot>?start=<state> then Telegram sends "/start <state>"
    const txt = typeof msg?.text === "string" ? msg.text.trim() : "";
    if (txt.startsWith("/start")) {
      const parts = txt.split(/\s+/).filter(Boolean);
      const token = parts.length >= 2 ? String(parts[1] ?? "").trim() : "";
      const fromId = numOrNull(msg?.from?.id);
      const chatId2 = String(msg.chat?.id ?? "").trim();
      if (token && fromId != null && chatId2) {
        try {
          await ensureSchema(env);
          const st = await env.DB.prepare(
            `SELECT account_address FROM telegram_oauth_states WHERE state = ? LIMIT 1`,
          )
            .bind(token)
            .first<{ account_address: string }>();
          const acct = st?.account_address ? String((st as any).account_address).trim() : "";
          if (acct) {
            const ts = nowISO();
            await env.DB.prepare(
              `INSERT OR REPLACE INTO telegram_account_links (account_address, telegram_user_id, chat_id, linked_at_iso)
               VALUES (?, ?, ?, ?)`,
            )
              .bind(acct, String(fromId), chatId2, ts)
              .run();
            await env.DB.prepare(`DELETE FROM telegram_oauth_states WHERE state = ?`).bind(token).run();
            await tgCall(env, "sendMessage", {
              chat_id: chatId2,
              text: "Connected. You can go back to the app now.",
            });
            console.log(`[telegram-mcp] link: connected account_address=${acct} telegram_user_id=${fromId} chat_id=${chatId2}`);
          }
        } catch (e) {
          console.warn("[telegram-mcp] link: failed to link from /start", e);
        }
      }
    }
    const hasPhoto = Array.isArray(msg?.photo) && msg.photo.length > 0;
    const hasImageDoc =
      msg?.document &&
      typeof msg.document === "object" &&
      String((msg.document as { mime_type?: string }).mime_type ?? "").startsWith("image/");
    if (hasPhoto || hasImageDoc) {
      console.log(
        `[telegram-mcp] webhook: stored message with image chat_id=${chatId} message_id=${msg?.message_id} kind=${hasPhoto ? "photo" : "image_document"} (raw in D1; URLs created when tools/resources request images)`,
      );
    }
  } else if (chatFromMember) {
    await upsertChat(env, chatFromMember);
    chatId = String(chatFromMember?.id ?? "");
    title = chatFromMember?.title ? String(chatFromMember.title) : null;
  }

  if (chatId) {
    const uris = chatToResourceUris(chatId, title);
    const subs = await env.DB.prepare(
      `SELECT DISTINCT session_id, resource_uri FROM telegram_resource_subscriptions WHERE resource_uri IN (${uris.map(() => "?").join(",")})`,
    )
      .bind(...uris)
      .all();
    const ts = nowISO();
    for (const row of (subs.results ?? []) as { session_id: string; resource_uri: string }[]) {
      await env.DB.prepare(
        `INSERT INTO telegram_pending_notifications (session_id, resource_uri, created_at_iso) VALUES (?, ?, ?)`,
      )
        .bind(row.session_id, row.resource_uri, ts)
        .run();
    }
  }

  return new Response("ok", { status: 200 });
}

const SMART_AGENT_CHAT_TITLE = "Smart Agent";
const MAX_BACKFILL_IMAGES = 120;

/** Register media tokens for unique image file_ids in "Smart Agent" chat (for testing + tail). Dedupes by file_id. */
async function backfillSmartAgentImages(env: Env): Promise<{
  ok: boolean;
  chatId: string | null;
  error?: string;
  imageCount: number;
  urls: string[];
  publicBaseUrl: string | null;
}> {
  const base = publicBaseUrl(env) || null;
  if (!base) {
    const err = "Set PUBLIC_BASE_URL or TELEGRAM_MCP_PUBLIC_URL before backfill";
    console.warn(`[telegram-mcp] backfill: ${err}`);
    return { ok: false, chatId: null, error: err, imageCount: 0, urls: [], publicBaseUrl: null };
  }
  const chatRow = await env.DB.prepare(`SELECT chat_id FROM telegram_chats WHERE title = ? LIMIT 1`)
    .bind(SMART_AGENT_CHAT_TITLE)
    .first<{ chat_id: string }>();
  if (!chatRow) {
    console.warn(`[telegram-mcp] backfill: no chat titled "${SMART_AGENT_CHAT_TITLE}" in telegram_chats (receive messages first)`);
    return {
      ok: false,
      chatId: null,
      error: `Chat "${SMART_AGENT_CHAT_TITLE}" not found in DB`,
      imageCount: 0,
      urls: [],
      publicBaseUrl: base,
    };
  }
  console.log(`[telegram-mcp] backfill: start chat_id=${chatRow.chat_id} title="${SMART_AGENT_CHAT_TITLE}"`);
  const res = await env.DB.prepare(
    `SELECT message_id, raw_json FROM telegram_messages WHERE chat_id = ? ORDER BY date_unix DESC LIMIT 500`,
  )
    .bind(chatRow.chat_id)
    .all();
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const r of (res.results ?? []) as { message_id: unknown; raw_json: unknown }[]) {
    if (urls.length >= MAX_BACKFILL_IMAGES) break;
    let raw: Record<string, unknown> = {};
    try {
      if (typeof r.raw_json === "string") raw = JSON.parse(r.raw_json) as Record<string, unknown>;
      else if (r.raw_json && typeof r.raw_json === "object") raw = r.raw_json as Record<string, unknown>;
    } catch {
      continue;
    }
    const fileId = largestPhotoFileId(raw) ?? imageDocumentFileId(raw);
    if (!fileId || seen.has(fileId)) continue;
    seen.add(fileId);
    const reg = await registerMediaToken(env, fileId);
    if ("error" in reg) {
      console.warn(`[telegram-mcp] backfill: skip message_id=${r.message_id}: ${reg.error}`);
      continue;
    }
    urls.push(reg.url);
    console.log(`[telegram-mcp] backfill: sample url (message_id=${r.message_id}) ${reg.url}`);
  }
  console.log(
    `[telegram-mcp] backfill: complete unique_images=${urls.length} publicBaseUrl=${base} firstUrl=${urls[0] ?? "(none)"}`,
  );
  return { ok: true, chatId: chatRow.chat_id, imageCount: urls.length, urls, publicBaseUrl: base };
}

function createServer(env: Env) {
  const server = new McpServer(
    { name: "Telegram MCP (Bot API + D1)", version: "0.1.0" },
    { capabilities: { resources: { listChanged: true, subscribe: true } } },
  );

  // Ensure newer tables exist even if schema.sql wasn't applied yet.
  void ensureSchema(env);

  const listChats = async () => {
    const res = await env.DB.prepare(
      `SELECT chat_id, type, title FROM telegram_chats ORDER BY updated_at_iso DESC LIMIT 100`,
    )
      .all();
    const resources: { uri: string; name: string; title: string; mimeType: string }[] = [];
    for (const r of (res.results ?? []) as { chat_id: string; type: string | null; title: string | null }[]) {
      resources.push({
        uri: `${TELEGRAM_URI_PREFIX}${r.chat_id}${TELEGRAM_URI_SUFFIX}`,
        name: r.title ?? `Chat ${r.chat_id}`,
        title: r.title ?? `Chat ${r.chat_id}`,
        mimeType: "application/json",
      });
      if (r.title?.trim()) {
        resources.push({
          uri: `${TELEGRAM_URI_PREFIX}by-title/${encodeURIComponent(r.title.trim())}${TELEGRAM_URI_SUFFIX}`,
          name: r.title,
          title: r.title,
          mimeType: "application/json",
        });
      }
    }
    return { resources };
  };

  const readChatMessages = async (uri: URL) => {
    const chatId = await uriToChatId(uri.toString(), env);
    if (!chatId) return { contents: [{ uri: uri.toString(), mimeType: "text/plain", text: "Chat not found" }] };
    const res = await env.DB.prepare(
      `SELECT message_id, message_thread_id, from_user_id, date_unix, text, raw_json FROM telegram_messages WHERE chat_id = ? ORDER BY date_unix DESC LIMIT 50`,
    )
      .bind(chatId)
      .all();
    const budget = { remaining: MAX_IMAGES_PER_RESPONSE };
    const rows = (res.results ?? []) as MessageRow[];
    const messages: Record<string, unknown>[] = [];
    for (const r of rows) {
      messages.push(await mapMessageRowToPayload(env, r, { includeImageUrls: true, includeImageBytes: false }, budget));
    }
    return {
      contents: [{ uri: uri.toString(), mimeType: "application/json", text: jsonText({ chatId, messages }) }],
    };
  };

  server.resource(
    "telegram_chat_messages",
    new ResourceTemplate(`${TELEGRAM_URI_PREFIX}{chatId}${TELEGRAM_URI_SUFFIX}`, { list: listChats }),
    { title: "Telegram chat messages (by id)", description: "Recent messages for a chat by chatId", mimeType: "application/json" },
    async (uri, _variables, _extra) => readChatMessages(uri),
  );
  server.resource(
    "telegram_chat_messages_by_title",
    new ResourceTemplate(`${TELEGRAM_URI_PREFIX}by-title/{title}${TELEGRAM_URI_SUFFIX}`, { list: listChats }),
    { title: "Telegram chat messages (by title)", description: "Recent messages for a chat by title", mimeType: "application/json" },
    async (uri, _variables, _extra) => readChatMessages(uri),
  );

  server.server.setRequestHandler(SubscribeRequestSchema, async (request) => {
    const sessionId = (env.MCP_SESSION_ID ?? "").trim();
    if (!sessionId) return {};
    const uri = (request.params?.uri ?? "").trim();
    if (!uri.startsWith(TELEGRAM_URI_PREFIX) || !uri.endsWith(TELEGRAM_URI_SUFFIX)) return {};
    const ts = nowISO();
    await env.DB.prepare(
      `INSERT OR REPLACE INTO telegram_resource_subscriptions (session_id, resource_uri, created_at_iso) VALUES (?, ?, ?)`,
    )
      .bind(sessionId, uri, ts)
      .run();
    return {};
  });
  server.server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
    const sessionId = (env.MCP_SESSION_ID ?? "").trim();
    if (!sessionId) return {};
    const uri = (request.params?.uri ?? "").trim();
    await env.DB.prepare(`DELETE FROM telegram_resource_subscriptions WHERE session_id = ? AND resource_uri = ?`)
      .bind(sessionId, uri)
      .run();
    return {};
  });

  server.tool("telegram_ping", "Health check", {}, async () => {
    return { content: [{ type: "text", text: jsonText({ ok: true, asOfISO: nowISO() }) }] };
  });

  server.tool(
    "telegram_link_start",
    "Start Telegram linking for an accountAddress (returns https://t.me/<bot>?start=<state>).",
    { accountAddress: z.string().min(1) },
    async (args) => {
      const p = z.object({ accountAddress: z.string().min(1) }).parse(args);
      const out = await createConnectState(env, p.accountAddress);
      return { content: [{ type: "text", text: jsonText(out) }] };
    },
  );

  server.tool(
    "telegram_link_status",
    "Get Telegram link status for an accountAddress (telegram user id + chat id).",
    { accountAddress: z.string().min(1) },
    async (args) => {
      const p = z.object({ accountAddress: z.string().min(1) }).parse(args);
      const st = await getAccountLink(env, p.accountAddress);
      return { content: [{ type: "text", text: jsonText(st) }] };
    },
  );

  server.tool(
    "telegram_link_disconnect",
    "Disconnect Telegram for an accountAddress (deletes stored link).",
    { accountAddress: z.string().min(1) },
    async (args) => {
      const p = z.object({ accountAddress: z.string().min(1) }).parse(args);
      await ensureSchema(env);
      const acct = p.accountAddress.trim();
      await env.DB.prepare(`DELETE FROM telegram_account_links WHERE account_address = ?`).bind(acct).run();
      await env.DB.prepare(`DELETE FROM telegram_oauth_states WHERE account_address = ?`).bind(acct).run();
      return { content: [{ type: "text", text: jsonText({ ok: true, accountAddress: acct, disconnectedAtISO: nowISO() }) }] };
    },
  );

  server.tool(
    "telegram_send_message_to_account",
    "Send a Telegram message to a linked accountAddress.",
    { accountAddress: z.string().min(1), text: z.string().min(1), parseMode: z.enum(["MarkdownV2", "HTML"]).optional(), disableNotification: z.boolean().optional() },
    async (args) => {
      const p = z
        .object({
          accountAddress: z.string().min(1),
          text: z.string().min(1),
          parseMode: z.enum(["MarkdownV2", "HTML"]).optional(),
          disableNotification: z.boolean().optional(),
        })
        .parse(args);
      const link = await getAccountLink(env, p.accountAddress);
      if (!link.linked || !link.chatId) {
        return { content: [{ type: "text", text: jsonText({ ok: false, error: "Telegram not linked for this accountAddress" }) }] };
      }
      const res = await tgCall(env, "sendMessage", {
        chat_id: link.chatId,
        text: p.text,
        parse_mode: p.parseMode,
        disable_notification: p.disableNotification,
      });
      return { content: [{ type: "text", text: jsonText({ ok: true, accountAddress: p.accountAddress, chatId: link.chatId, result: res }) }] };
    },
  );

  server.tool(
    "telegram_set_webhook",
    "Set Telegram webhook URL for this bot.",
    { url: z.string().url(), secretToken: z.string().min(8).optional() },
    async (args) => {
      const p = z.object({ url: z.string().url(), secretToken: z.string().min(8).optional() }).parse(args);
      const res = await tgCall(env, "setWebhook", {
        url: p.url,
        secret_token: p.secretToken,
      });
      return { content: [{ type: "text", text: jsonText({ result: res }) }] };
    },
  );

  server.tool("telegram_get_webhook_info", "Get current webhook info.", {}, async () => {
    const res = await tgCall(env, "getWebhookInfo", {});
    return { content: [{ type: "text", text: jsonText({ result: res }) }] };
  });

  server.tool(
    "telegram_send_message",
    "Send a message to a chat (optionally forum topic thread).",
    {
      chatId: z.union([z.string().min(1), z.number().int()]),
      text: z.string().min(1),
      parseMode: z.enum(["MarkdownV2", "HTML"]).optional(),
      replyToMessageId: z.number().int().optional(),
      messageThreadId: z.number().int().optional(),
      disableNotification: z.boolean().optional(),
    },
    async (args) => {
      const p = z
        .object({
          chatId: z.union([z.string().min(1), z.number().int()]),
          text: z.string().min(1),
          parseMode: z.enum(["MarkdownV2", "HTML"]).optional(),
          replyToMessageId: z.number().int().optional(),
          messageThreadId: z.number().int().optional(),
          disableNotification: z.boolean().optional(),
        })
        .parse(args);
      const res = await tgCall(env, "sendMessage", {
        chat_id: p.chatId,
        text: p.text,
        parse_mode: p.parseMode,
        reply_to_message_id: p.replyToMessageId,
        message_thread_id: p.messageThreadId,
        disable_notification: p.disableNotification,
      });
      return { content: [{ type: "text", text: jsonText({ result: res }) }] };
    },
  );

  server.tool(
    "telegram_edit_message_text",
    "Edit a previously sent message.",
    {
      chatId: z.union([z.string().min(1), z.number().int()]),
      messageId: z.number().int(),
      text: z.string().min(1),
      parseMode: z.enum(["MarkdownV2", "HTML"]).optional(),
    },
    async (args) => {
      const p = z
        .object({
          chatId: z.union([z.string().min(1), z.number().int()]),
          messageId: z.number().int(),
          text: z.string().min(1),
          parseMode: z.enum(["MarkdownV2", "HTML"]).optional(),
        })
        .parse(args);
      const res = await tgCall(env, "editMessageText", {
        chat_id: p.chatId,
        message_id: p.messageId,
        text: p.text,
        parse_mode: p.parseMode,
      });
      return { content: [{ type: "text", text: jsonText({ result: res }) }] };
    },
  );

  server.tool(
    "telegram_delete_message",
    "Delete a message.",
    { chatId: z.union([z.string().min(1), z.number().int()]), messageId: z.number().int() },
    async (args) => {
      const p = z.object({ chatId: z.union([z.string().min(1), z.number().int()]), messageId: z.number().int() }).parse(args);
      const res = await tgCall(env, "deleteMessage", { chat_id: p.chatId, message_id: p.messageId });
      return { content: [{ type: "text", text: jsonText({ result: res }) }] };
    },
  );

  server.tool(
    "telegram_pin_message",
    "Pin a message in a chat (bot must be admin).",
    { chatId: z.union([z.string().min(1), z.number().int()]), messageId: z.number().int(), disableNotification: z.boolean().optional() },
    async (args) => {
      const p = z
        .object({
          chatId: z.union([z.string().min(1), z.number().int()]),
          messageId: z.number().int(),
          disableNotification: z.boolean().optional(),
        })
        .parse(args);
      const res = await tgCall(env, "pinChatMessage", {
        chat_id: p.chatId,
        message_id: p.messageId,
        disable_notification: p.disableNotification,
      });
      return { content: [{ type: "text", text: jsonText({ result: res }) }] };
    },
  );

  server.tool(
    "telegram_list_chats",
    "List chats seen by the webhook (from D1). Optional fromUserId filters chats to those with messages from that Telegram user id.",
    { limit: z.number().int().positive().max(200).optional(), fromUserId: z.union([z.string().min(1), z.number().int()]).optional() },
    async (args) => {
      const p = z
        .object({
          limit: z.number().int().positive().max(200).optional(),
          fromUserId: z.union([z.string().min(1), z.number().int()]).optional(),
        })
        .parse(args);
      const fromUserId = p.fromUserId !== undefined ? String(p.fromUserId) : null;
      const res = fromUserId
        ? await env.DB.prepare(
            `SELECT chat_id, type, title, username, updated_at_iso
             FROM telegram_chats
             WHERE chat_id IN (SELECT DISTINCT chat_id FROM telegram_messages WHERE from_user_id = ?)
             ORDER BY updated_at_iso DESC
             LIMIT ?`,
          )
            .bind(fromUserId, p.limit ?? 50)
            .all()
        : await env.DB.prepare(
            `SELECT chat_id, type, title, username, updated_at_iso FROM telegram_chats ORDER BY updated_at_iso DESC LIMIT ?`,
          )
            .bind(p.limit ?? 50)
            .all();
      const chats = (res.results ?? []).map((r: any) => ({
        chatId: String(r.chat_id ?? ""),
        type: r.type ? String(r.type) : null,
        title: r.title ? String(r.title) : null,
        username: r.username ? String(r.username) : null,
        updatedAtISO: String(r.updated_at_iso ?? ""),
      }));
      return { content: [{ type: "text", text: jsonText({ chats }) }] };
    },
  );

  server.tool(
    "telegram_list_unique_user_ids",
    "List unique Telegram user ids observed in stored messages (from D1). Optionally filter by chatId.",
    { chatId: z.union([z.string().min(1), z.number().int()]).optional(), limit: z.number().int().positive().max(5000).optional() },
    async (args) => {
      const p = z
        .object({
          chatId: z.union([z.string().min(1), z.number().int()]).optional(),
          limit: z.number().int().positive().max(5000).optional(),
        })
        .parse(args);
      const limit = p.limit ?? 500;
      const chatId = p.chatId !== undefined ? String(p.chatId) : null;
      const res = await env.DB.prepare(
        `SELECT DISTINCT from_user_id
         FROM telegram_messages
         WHERE from_user_id IS NOT NULL
           AND (? IS NULL OR chat_id = ?)
         ORDER BY from_user_id ASC
         LIMIT ?`,
      )
        .bind(chatId, chatId, limit)
        .all();
      const userIds = (res.results ?? [])
        .map((r: any) => (r?.from_user_id != null ? String(r.from_user_id) : ""))
        .filter((s: string) => s.trim());
      return { content: [{ type: "text", text: jsonText({ userIds }) }] };
    },
  );

  server.tool(
    "telegram_list_messages",
    "List stored messages for a chat (from D1). Photo/image messages include image.url and image.imageUrl (public worker URL) when PUBLIC_BASE_URL is set. Optional includeImageBytes for base64.",
    {
      chatId: z.union([z.string().min(1), z.number().int()]),
      fromUserId: z.union([z.string().min(1), z.number().int()]).optional(),
      limit: z.number().int().positive().max(200).optional(),
      includeImageUrls: z.boolean().optional(),
      includeImageBytes: z.boolean().optional(),
    },
    async (args) => {
      const p = z
        .object({
          chatId: z.union([z.string().min(1), z.number().int()]),
          fromUserId: z.union([z.string().min(1), z.number().int()]).optional(),
          limit: z.number().int().positive().max(200).optional(),
          includeImageUrls: z.boolean().optional(),
          includeImageBytes: z.boolean().optional(),
        })
        .parse(args);
      const chatId = String(p.chatId);
      const fromUserId = p.fromUserId !== undefined ? String(p.fromUserId) : null;
      const includeUrls = p.includeImageUrls !== false;
      const includeBytes = p.includeImageBytes === true;
      const res = await env.DB.prepare(
        `SELECT message_id, message_thread_id, from_user_id, date_unix, text, raw_json
         FROM telegram_messages
         WHERE chat_id = ?
           AND (? IS NULL OR from_user_id = ?)
         ORDER BY date_unix DESC
         LIMIT ?`,
      )
        .bind(chatId, fromUserId, fromUserId, p.limit ?? 50)
        .all();
      const budget = { remaining: MAX_IMAGES_PER_RESPONSE };
      const rows = (res.results ?? []) as MessageRow[];
      const messages: Record<string, unknown>[] = [];
      for (const r of rows) {
        messages.push(
          await mapMessageRowToPayload(env, r, { includeImageUrls: includeUrls, includeImageBytes: includeBytes }, budget),
        );
      }
      return { content: [{ type: "text", text: jsonText({ chatId, messages }) }] };
    },
  );

  server.tool(
    "telegram_search_messages",
    "Search stored messages by substring (from D1). Same image url / optional bytes behavior as telegram_list_messages.",
    {
      query: z.string().min(1),
      chatId: z.union([z.string().min(1), z.number().int()]).optional(),
      fromUserId: z.union([z.string().min(1), z.number().int()]).optional(),
      limit: z.number().int().positive().max(100).optional(),
      includeImageUrls: z.boolean().optional(),
      includeImageBytes: z.boolean().optional(),
    },
    async (args) => {
      const p = z
        .object({
          query: z.string().min(1),
          chatId: z.union([z.string().min(1), z.number().int()]).optional(),
          fromUserId: z.union([z.string().min(1), z.number().int()]).optional(),
          limit: z.number().int().positive().max(100).optional(),
          includeImageUrls: z.boolean().optional(),
          includeImageBytes: z.boolean().optional(),
        })
        .parse(args);
      const q = `%${p.query}%`;
      const fromUserId = p.fromUserId !== undefined ? String(p.fromUserId) : null;
      const includeUrls = p.includeImageUrls !== false;
      const includeBytes = p.includeImageBytes === true;
      const res = await env.DB.prepare(
        `SELECT chat_id, message_id, message_thread_id, from_user_id, date_unix, text, raw_json
         FROM telegram_messages
         WHERE (? IS NULL OR chat_id = ?)
           AND (? IS NULL OR from_user_id = ?)
           AND text LIKE ?
         ORDER BY date_unix DESC
         LIMIT ?`,
      )
        .bind(
          p.chatId ? String(p.chatId) : null,
          p.chatId ? String(p.chatId) : null,
          fromUserId,
          fromUserId,
          q,
          p.limit ?? 25,
        )
        .all();
      const budget = { remaining: MAX_IMAGES_PER_RESPONSE };
      const hits: Record<string, unknown>[] = [];
      for (const r of (res.results ?? []) as any[]) {
        const payload = await mapMessageRowToPayload(
          env,
          r as MessageRow,
          { includeImageUrls: includeUrls, includeImageBytes: includeBytes },
          budget,
        );
        hits.push({ chatId: String(r.chat_id ?? ""), ...payload });
      }
      return { content: [{ type: "text", text: jsonText({ hits }) }] };
    },
  );

  server.tool(
    "telegram_create_group",
    "Telegram Bot API cannot create groups. Returns safe bootstrap instructions.",
    { title: z.string().min(1) },
    async (args) => {
      const p = z.object({ title: z.string().min(1) }).parse(args);
      return {
        content: [
          {
            type: "text",
            text: jsonText({
              ok: false,
              reason: "Telegram bots cannot create groups/channels via Bot API.",
              nextSteps: [
                `Create the group '${p.title}' manually in Telegram.`,
                "Add this bot to the group.",
                "Promote it to admin if you want pin/delete/moderation features.",
                "Then use telegram_send_message / telegram_pin_message / etc.",
              ],
            }),
          },
        ],
      };
    },
  );

  server.tool(
    "telegram_poll_notifications",
    "Return and clear pending resource-updated notifications for this session. Call after subscribing to chat resources to get URIs that had new messages.",
    {},
    async () => {
      const sessionId = (env.MCP_SESSION_ID ?? "").trim();
      const pending = await getAndClearPendingNotifications(env, sessionId);
      return {
        content: [{ type: "text", text: jsonText({ sessionId: sessionId || null, updatedUris: pending.map((p) => p.resource_uri) }) }],
      };
    },
  );

  return server;
}

/** Prepend SSE events for notifications/resources/updated to the response stream */
async function prependNotificationEvents(
  body: ReadableStream<Uint8Array>,
  pending: { resource_uri: string }[],
): Promise<ReadableStream<Uint8Array>> {
  const encoder = new TextEncoder();
  const prefix = pending
    .map(
      (p) =>
        `event: message\ndata: ${JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/resources/updated",
          params: { uri: p.resource_uri },
        })}\n\n`,
    )
    .join("");
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(prefix));
      const reader = body.getReader();
      function pump() {
        reader.read().then(({ done, value }) => {
          if (done) {
            controller.close();
            return;
          }
          controller.enqueue(value);
          pump();
        });
      }
      pump();
    },
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    // Public image proxy (no API key) — JSON messages reference image.url / image.imageUrl
    if (request.method === "GET" && url.pathname.startsWith("/telegram/media/")) {
      const token = url.pathname.replace(/^\/telegram\/media\//, "").split("/")[0]?.trim() ?? "";
      if (token) {
        try {
          return await handleTelegramMediaGet(env, request, token);
        } catch (e) {
          return new Response(String((e as Error)?.message ?? e), { status: 500 });
        }
      }
    }
    if (url.pathname === "/telegram/webhook" && request.method === "POST") {
      try {
        return await handleWebhook(request, env);
      } catch (e) {
        return new Response(jsonText({ error: String((e as any)?.message ?? e ?? "webhook error") }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
    }

    // Backfill image tokens for "Smart Agent" — requires x-api-key (same as MCP). Workers have no true "startup"; call after deploy or add a cron (see scheduled).
    if (
      url.pathname === "/telegram/internal/backfill-smart-agent" &&
      (request.method === "POST" || request.method === "GET")
    ) {
      try {
        await requireApiKey(request, env);
        const result = await backfillSmartAgentImages(env);
        return new Response(jsonText(result), {
          status: result.ok ? 200 : 422,
          headers: { "content-type": "application/json" },
        });
      } catch (e) {
        const msg = String((e as Error)?.message ?? e);
        const status = msg.includes("Unauthorized") ? 401 : 500;
        return new Response(jsonText({ error: msg }), {
          status,
          headers: { "content-type": "application/json" },
        });
      }
    }

    try {
      await requireApiKey(request, env);
    } catch {
      return new Response("Unauthorized", { status: 401 });
    }

    let sessionId = request.headers.get("mcp-session-id")?.trim() || undefined;
    if (!sessionId) sessionId = crypto.randomUUID();
    (env as Env).MCP_SESSION_ID = sessionId;
    const requestWithSession =
      request.headers.get("mcp-session-id") !== null
        ? request
        : new Request(request, { headers: (() => { const h = new Headers(request.headers); h.set("mcp-session-id", sessionId!); return h; })() });
    const pending = await getAndClearPendingNotifications(env, sessionId);

    try {
      const server = createServer(env);
      let response = await createMcpHandler(server, { route: "/mcp" })(requestWithSession, env, ctx);
      if (
        pending.length > 0 &&
        response.ok &&
        response.headers.get("content-type")?.includes("text/event-stream") &&
        response.body
      ) {
        response = new Response(await prependNotificationEvents(response.body, pending), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }
      if (sessionId && !response.headers.has("mcp-session-id")) {
        const headers = new Headers(response.headers);
        headers.set("mcp-session-id", sessionId);
        response = new Response(response.body, { status: response.status, statusText: response.statusText, headers });
      }
      return response;
    } catch (e) {
      return new Response(jsonText({ error: String((e as any)?.message ?? e ?? "internal error") }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
  },

  /** Optional: add `"triggers": { "crons": ["0 4 * * *"] }` to wrangler to run backfill on a schedule (set TELEGRAM_CRON_BACKFILL=1). */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    if (env.TELEGRAM_CRON_BACKFILL !== "1") {
      console.log("[telegram-mcp] scheduled: skip backfill (set TELEGRAM_CRON_BACKFILL=1 to enable)");
      return;
    }
    console.log(`[telegram-mcp] scheduled: cron ${event.cron} backfill Smart Agent`);
    ctx.waitUntil(
      backfillSmartAgentImages(env).catch((e) =>
        console.error("[telegram-mcp] scheduled: backfill failed", e),
      ),
    );
  },
};

