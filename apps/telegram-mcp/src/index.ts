import { createMcpHandler } from "agents/mcp";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const TELEGRAM_URI_PREFIX = "telegram://chat/";
const TELEGRAM_URI_SUFFIX = "/messages";

export type Env = {
  MCP_API_KEY?: string;
  DB: D1Database;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  MCP_SESSION_ID?: string; // set from mcp-session-id header for subscribe + pending flush
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
  const text = typeof msg?.text === "string" ? msg.text : null;
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

function createServer(env: Env) {
  const server = new McpServer(
    { name: "Telegram MCP (Bot API + D1)", version: "0.1.0" },
    { capabilities: { resources: { listChanged: true, subscribe: true } } },
  );

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
      `SELECT message_id, from_user_id, date_unix, text FROM telegram_messages WHERE chat_id = ? ORDER BY date_unix DESC LIMIT 50`,
    )
      .bind(chatId)
      .all();
    const messages = (res.results ?? []).map((r: any) => ({
      messageId: r.message_id,
      fromUserId: r.from_user_id,
      dateUnix: r.date_unix,
      text: r.text,
    }));
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
    "List chats seen by the webhook (from D1).",
    { limit: z.number().int().positive().max(200).optional() },
    async (args) => {
      const p = z.object({ limit: z.number().int().positive().max(200).optional() }).parse(args);
      const res = await env.DB.prepare(
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
    "telegram_list_messages",
    "List stored messages for a chat (from D1).",
    {
      chatId: z.union([z.string().min(1), z.number().int()]),
      limit: z.number().int().positive().max(200).optional(),
    },
    async (args) => {
      const p = z
        .object({ chatId: z.union([z.string().min(1), z.number().int()]), limit: z.number().int().positive().max(200).optional() })
        .parse(args);
      const chatId = String(p.chatId);
      const res = await env.DB.prepare(
        `SELECT message_id, message_thread_id, from_user_id, date_unix, text, raw_json FROM telegram_messages WHERE chat_id = ? ORDER BY date_unix DESC LIMIT ?`,
      )
        .bind(chatId, p.limit ?? 50)
        .all();
      const messages = (res.results ?? []).map((r: any) => ({
        messageId: Number(r.message_id ?? 0),
        messageThreadId: r.message_thread_id !== null && r.message_thread_id !== undefined ? Number(r.message_thread_id) : null,
        fromUserId: r.from_user_id !== null && r.from_user_id !== undefined ? Number(r.from_user_id) : null,
        dateUnix: r.date_unix !== null && r.date_unix !== undefined ? Number(r.date_unix) : null,
        text: r.text ? String(r.text) : null,
      }));
      return { content: [{ type: "text", text: jsonText({ chatId, messages }) }] };
    },
  );

  server.tool(
    "telegram_search_messages",
    "Search stored messages by substring (from D1).",
    {
      query: z.string().min(1),
      chatId: z.union([z.string().min(1), z.number().int()]).optional(),
      limit: z.number().int().positive().max(100).optional(),
    },
    async (args) => {
      const p = z
        .object({
          query: z.string().min(1),
          chatId: z.union([z.string().min(1), z.number().int()]).optional(),
          limit: z.number().int().positive().max(100).optional(),
        })
        .parse(args);
      const q = `%${p.query}%`;
      const res = await env.DB.prepare(
        `SELECT chat_id, message_id, message_thread_id, date_unix, text
         FROM telegram_messages
         WHERE (? IS NULL OR chat_id = ?)
           AND text LIKE ?
         ORDER BY date_unix DESC
         LIMIT ?`,
      )
        .bind(p.chatId ? String(p.chatId) : null, p.chatId ? String(p.chatId) : null, q, p.limit ?? 25)
        .all();
      const hits = (res.results ?? []).map((r: any) => ({
        chatId: String(r.chat_id ?? ""),
        messageId: Number(r.message_id ?? 0),
        messageThreadId: r.message_thread_id !== null && r.message_thread_id !== undefined ? Number(r.message_thread_id) : null,
        dateUnix: r.date_unix !== null && r.date_unix !== undefined ? Number(r.date_unix) : null,
        text: r.text ? String(r.text) : null,
      }));
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
};

