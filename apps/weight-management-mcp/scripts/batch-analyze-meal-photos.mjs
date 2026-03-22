#!/usr/bin/env node
/**
 * Batch-call weight_analyze_meal_photo for each HTTPS image URL.
 * The client (this script, or your agent) is responsible for obtaining URLs
 * from Telegram or anywhere else — weight-management-mcp only sees https URLs.
 *
 * Usage:
 *   export WEIGHT_MCP_URL="https://gym-weight-management-mcp....workers.dev/mcp"
 *   export MCP_API_KEY="..."
 *   export SCOPE_JSON='{"accountAddress":"acct_cust_casey"}'
 *   # or:
 *   export ACCOUNT_ADDRESS="acct_cust_casey"
 *   printf '%s\n' "https://example.com/a.jpg" "https://example.com/b.jpg" | node scripts/batch-analyze-meal-photos.mjs
 *
 * Or: node scripts/batch-analyze-meal-photos.mjs urls.txt
 */

import { readFileSync, createReadStream } from "fs";
import { createInterface } from "readline";
import dns from "node:dns";

const MCP_ACCEPT = "application/json, text/event-stream";

const url = process.env.WEIGHT_MCP_URL?.trim();
const key = process.env.MCP_API_KEY?.trim();

// WSL + Node can prefer IPv6 and fail with ENETUNREACH; force IPv4-first.
dns.setDefaultResultOrder("ipv4first");
let scope = {};
const accountAddress = process.env.ACCOUNT_ADDRESS?.trim();
if (accountAddress) scope = { accountAddress };
else {
  try {
    scope = JSON.parse(process.env.SCOPE_JSON || "{}");
  } catch {
    console.error("SCOPE_JSON must be valid JSON");
    process.exit(1);
  }
}

if (!url || !key) {
  console.error("Set WEIGHT_MCP_URL and MCP_API_KEY");
  process.exit(1);
}
if (!scope || typeof scope !== "object") {
  console.error("Set SCOPE_JSON, e.g. {\"accountAddress\":\"me\"}");
  process.exit(1);
}
if (!scope.accountAddress || typeof scope.accountAddress !== "string") {
  console.error("Set ACCOUNT_ADDRESS (recommended) or SCOPE_JSON with accountAddress");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callAnalyzeOnce(imageUrl, extra = {}) {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "weight_analyze_meal_photo",
      arguments: {
        scope,
        imageUrl,
        ...extra,
      },
    },
  };
  const r = await fetch(url, {
    method: "POST",
    headers: {
      accept: MCP_ACCEPT,
      "content-type": "application/json",
      "x-api-key": key,
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) {
    return { ok: false, status: r.status, text };
  }
  // SSE: parse first data: line JSON
  const m = text.match(/data:\s*(\{[\s\S]*?\})\s*(?:\n\n|$)/);
  if (!m) return { ok: false, raw: text.slice(0, 500) };
  try {
    const evt = JSON.parse(m[1]);
    const inner = evt.result?.content?.[0]?.text;
    if (inner) return { ok: true, result: JSON.parse(inner) };
    return { ok: false, evt };
  } catch (e) {
    return { ok: false, parseError: String(e), snippet: text.slice(0, 400) };
  }
}

async function callAnalyze(imageUrl, extra = {}) {
  const maxAttempts = Math.min(6, Math.max(1, parseInt(process.env.ANALYZE_RETRIES || "3", 10) || 3));
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const out = await callAnalyzeOnce(imageUrl, extra);
    if (out.ok) return out;
    const msg = out?.evt?.error?.message || "";
    const isTransient404 = typeof msg === "string" && msg.includes("fetch image HTTP 404");
    if (attempt < maxAttempts && isTransient404) {
      await sleep(800 * attempt);
      continue;
    }
    return out;
  }
  return { ok: false, error: "unreachable" };
}

async function callLogFoodFromAnalysisOnce(analysisId, extra = {}) {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "weight_log_food_from_analysis",
      arguments: {
        scope,
        analysisId,
        mode: "aggregate",
        ...extra,
      },
    },
  };
  const r = await fetch(url, {
    method: "POST",
    headers: {
      accept: MCP_ACCEPT,
      "content-type": "application/json",
      "x-api-key": key,
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) return { ok: false, status: r.status, text };
  const m = text.match(/data:\s*(\{[\s\S]*?\})\s*(?:\n\n|$)/);
  if (!m) return { ok: false, raw: text.slice(0, 500) };
  try {
    const evt = JSON.parse(m[1]);
    const inner = evt.result?.content?.[0]?.text;
    if (inner) return { ok: true, result: JSON.parse(inner) };
    return { ok: false, evt };
  } catch (e) {
    return { ok: false, parseError: String(e), snippet: text.slice(0, 400) };
  }
}

async function callLogFoodFromAnalysis(analysisId, extra = {}) {
  const maxAttempts = Math.min(4, Math.max(1, parseInt(process.env.LOG_RETRIES || "2", 10) || 2));
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const out = await callLogFoodFromAnalysisOnce(analysisId, extra);
    if (out.ok) return out;
    if (attempt < maxAttempts) {
      await sleep(500 * attempt);
      continue;
    }
    return out;
  }
  return { ok: false, error: "unreachable" };
}

async function* linesFromInput() {
  const arg = process.argv[2];
  if (arg) {
    const s = readFileSync(arg, "utf8");
    for (const line of s.split("\n")) {
      const t = line.trim();
      if (t && !t.startsWith("#")) yield t;
    }
    return;
  }
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const t = line.trim();
    if (t && !t.startsWith("#")) yield t;
  }
}

let n = 0;
for await (const imageUrl of linesFromInput()) {
  n += 1;
  process.stderr.write(`[${n}] ${imageUrl.slice(0, 80)}…\n`);
  const out = await callAnalyze(imageUrl);
  let logged = null;
  const autoLog = (process.env.AUTO_LOG_FOOD || "").trim().toLowerCase();
  const shouldLog = autoLog === "1" || autoLog === "true" || autoLog === "yes" || autoLog === "on";
  const analysisId = out?.result?.analysisId;
  if (shouldLog && out.ok && typeof analysisId === "string" && analysisId) {
    logged = await callLogFoodFromAnalysis(analysisId);
  }
  console.log(JSON.stringify({ imageUrl, ...out, loggedFood: logged }));
}

if (n === 0) {
  console.error("No URLs (stdin or file).");
  process.exit(1);
}
