#!/usr/bin/env node
/**
 * Call gym-telegram-mcp (MCP HTTP) → telegram_list_messages → write image HTTPS URLs to a file
 * (for batch-analyze-meal-photos.mjs). No Telegram Bot API here — only stored D1 messages.
 *
 * Usage:
 *   export TELEGRAM_MCP_URL="https://gym-telegram-mcp....workers.dev/mcp"
 *   export MCP_API_KEY="..."   # same x-api-key as telegram worker
 *   export CHAT_ID="-1001234567890"   # OR use CHAT_TITLE below
 *   node scripts/fetch-image-urls-from-telegram-mcp.mjs
 *   node scripts/fetch-image-urls-from-telegram-mcp.mjs --out urls.txt
 *
 * Resolve chat by title (optional):
 *   export CHAT_TITLE="Smart Agent"
 *   (script calls telegram_list_chats, picks first matching title)
 */

import { writeFileSync } from "fs";
import dns from "node:dns";

/** Streamable HTTP MCP requires this Accept header. */
const MCP_ACCEPT = "application/json, text/event-stream";

const mcpUrl = process.env.TELEGRAM_MCP_URL?.trim();
const key = process.env.MCP_API_KEY?.trim();
let chatId = process.env.CHAT_ID?.trim();
const chatTitle = process.env.CHAT_TITLE?.trim();
const limit = Math.min(200, Math.max(1, parseInt(process.env.MESSAGE_LIMIT || "100", 10) || 100));

const outIdx = process.argv.indexOf("--out");
const outFile = outIdx >= 0 ? process.argv[outIdx + 1] : "urls.txt";

if (!mcpUrl || !key) {
  console.error("Set TELEGRAM_MCP_URL and MCP_API_KEY");
  process.exit(1);
}

dns.setDefaultResultOrder("ipv4first");

async function mcpToolsCall(name, arguments_) {
  const body = {
    jsonrpc: "2.0",
    id: Date.now(),
    method: "tools/call",
    params: { name, arguments: arguments_ },
  };
  const r = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      accept: MCP_ACCEPT,
      "content-type": "application/json",
      "x-api-key": key,
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 400)}`);
  const m = text.match(/data:\s*(\{[\s\S]*?\})\s*(?:\n\n|$)/);
  if (!m) throw new Error(`No SSE data in response: ${text.slice(0, 300)}`);
  const evt = JSON.parse(m[1]);
  if (evt.error) throw new Error(JSON.stringify(evt.error));
  const inner = evt.result?.content?.[0]?.text;
  if (!inner) throw new Error(JSON.stringify(evt));
  return JSON.parse(inner);
}

function collectImageUrlsFromMessage(m) {
  const urls = new Set();
  if (typeof m.imageUrl === "string" && /^https?:\/\//i.test(m.imageUrl)) urls.add(m.imageUrl.trim());
  const img = m.image;
  if (img && typeof img === "object") {
    for (const k of ["url", "imageUrl"]) {
      const v = img[k];
      if (typeof v === "string" && /^https?:\/\//i.test(v)) urls.add(v.trim());
    }
  }
  return [...urls];
}

async function resolveChatIdByTitle() {
  const data = await mcpToolsCall("telegram_list_chats", { limit: 100 });
  const chats = data.chats ?? [];
  const t = chatTitle.toLowerCase();
  const hit = chats.find((c) => (c.title || "").toLowerCase() === t);
  if (!hit?.chatId) {
    const titles = chats.map((c) => c.title || c.chatId).join(", ");
    throw new Error(`No chat titled "${chatTitle}". Known: ${titles || "(none)"}`);
  }
  return String(hit.chatId);
}

async function main() {
  if (!chatId && chatTitle) {
    chatId = await resolveChatIdByTitle();
    console.error(`Resolved CHAT_TITLE "${chatTitle}" → chatId ${chatId}`);
  }
  if (!chatId) {
    console.error("Set CHAT_ID or CHAT_TITLE");
    process.exit(1);
  }

  const data = await mcpToolsCall("telegram_list_messages", {
    chatId,
    limit,
    includeImageUrls: true,
  });

  const messages = data.messages ?? [];
  const all = new Set();
  for (const m of messages) {
    for (const u of collectImageUrlsFromMessage(m)) all.add(u);
  }

  const lines = [...all].sort();
  writeFileSync(outFile, lines.join("\n") + (lines.length ? "\n" : ""), "utf8");
  console.error(`Wrote ${lines.length} URL(s) to ${outFile}`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
