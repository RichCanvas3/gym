/**
 * One-off: ensure wm_profiles.profile_json includes weight_lb for a Telegram user.
 *
 * Required env:
 * - WEIGHT_MCP_URL (e.g. https://gym-weight-management-mcp.richardpedersen3.workers.dev/mcp)
 * - WEIGHT_MCP_API_KEY (e.g. gym)
 * - TG_USER_ID (e.g. 6105195555)
 *
 * Optional:
 * - WEIGHT_LB (default 220)
 */
const url = String(process.env.WEIGHT_MCP_URL || "").trim();
if (!url) throw new Error("Missing WEIGHT_MCP_URL");
const apiKey = String(process.env.WEIGHT_MCP_API_KEY || "").trim();
if (!apiKey) throw new Error("Missing WEIGHT_MCP_API_KEY");
const tgUserId = String(process.env.TG_USER_ID || "").trim();
if (!tgUserId) throw new Error("Missing TG_USER_ID");
const weightLb = Number(String(process.env.WEIGHT_LB || "220").trim());
if (!Number.isFinite(weightLb) || weightLb <= 0) throw new Error("Invalid WEIGHT_LB");

async function call(tool, args) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${txt.slice(0, 500)}`);
  const m = txt.match(/data: (.+)\n/);
  const msg = m && m[1] ? JSON.parse(m[1]) : JSON.parse(txt);
  const text = msg?.result?.content?.[0]?.text;
  return typeof text === "string" ? JSON.parse(text) : msg;
}

const scope = { telegramUserId: tgUserId };
const prof = await call("weight_profile_get", { scope });
const profile = prof && typeof prof === "object" ? (prof.profile ?? {}) : {};
const next = profile && typeof profile === "object" ? { ...profile } : {};
if (next.weight_lb == null && next.weightKg == null && next.weight_kg == null && next.weightLb == null) {
  next.weight_lb = weightLb;
}
await call("weight_profile_upsert", { scope, profile: next });
const after = await call("weight_profile_get", { scope });
console.log(JSON.stringify({ ok: true, before: profile, after: after?.profile ?? null }, null, 2));

