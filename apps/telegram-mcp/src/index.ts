import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export type Env = {
  MCP_API_KEY?: string;
  DB: D1Database;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string; // optional; compare with header x-telegram-bot-api-secret-token
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

async function insertMessage(env: Env, msg: any) {
  const chatId = msg?.chat?.id;
  const messageId = msg?.message_id;
  if ((typeof chatId !== "number" && typeof chatId !== "string") || typeof messageId !== "number") return;
  const chat_id = String(chatId);
  const message_thread_id = typeof msg?.message_thread_id === "number" ? msg.message_thread_id : null;
  const id = `${chat_id}:${messageId}${message_thread_id ? `:${message_thread_id}` : ""}`;
  const from_user_id = typeof msg?.from?.id === "number" ? msg.from.id : null;
  const date_unix = typeof msg?.date === "number" ? msg.date : null;
  const text = typeof msg?.text === "string" ? msg.text : null;
  const ts = nowISO();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO telegram_messages (
      id, chat_id, message_id, message_thread_id, from_user_id, date_unix, text, raw_json, created_at_iso
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, chat_id, messageId, message_thread_id, from_user_id, date_unix, text, JSON.stringify(msg), ts)
    .run();
}

async function handleWebhook(request: Request, env: Env): Promise<Response> {
  const want = (env.TELEGRAM_WEBHOOK_SECRET ?? "").trim();
  if (want) {
    const got = (request.headers.get("x-telegram-bot-api-secret-token") ?? "").trim();
    if (got !== want) return new Response("Unauthorized", { status: 401 });
  }
  const update = (await request.json().catch(() => null)) as any;
  const updateId = update?.update_id;
  if (typeof updateId !== "number") return new Response("Bad update", { status: 400 });
  await env.DB.prepare(`INSERT OR IGNORE INTO telegram_updates (update_id, received_at_iso, raw_json) VALUES (?, ?, ?)`)
    .bind(updateId, nowISO(), JSON.stringify(update))
    .run();

  const msg = update?.message ?? update?.edited_message ?? update?.channel_post ?? update?.edited_channel_post;
  if (msg) {
    await upsertChat(env, msg.chat);
    await insertMessage(env, msg);
  }

  return new Response("ok", { status: 200 });
}

function createServer(env: Env) {
  const server = new McpServer({ name: "Telegram MCP (Bot API + D1)", version: "0.1.0" });

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

  return server;
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

