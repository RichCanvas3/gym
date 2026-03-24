import process from "node:process";

const KEY = (process.env.MCP_API_KEY || process.env.GYM_MCP_API_KEY || "gym").trim();

const base = (process.env.MCP_BASE || "https://gym-core-mcp.richardpedersen3.workers.dev").replace(/\/$/, "");

const endpoints = {
  core: process.env.CORE_MCP_URL || `${base.replace("gym-core-mcp", "gym-core-mcp")}/mcp`,
  content: process.env.CONTENT_MCP_URL || `${base.replace("gym-core-mcp", "gym-content-mcp")}/mcp`,
  scheduling: process.env.SCHEDULING_MCP_URL || `${base.replace("gym-core-mcp", "gym-scheduling-mcp")}/mcp`,
  weather: process.env.WEATHER_MCP_URL || `${base.replace("gym-core-mcp", "gym-weather-mcp")}/mcp`,
  telegram: process.env.TELEGRAM_MCP_URL || `${base.replace("gym-core-mcp", "gym-telegram-mcp")}/mcp`,
  weight: process.env.WEIGHT_MCP_URL || `${base.replace("gym-core-mcp", "gym-weight-management-mcp")}/mcp`,
  strava: process.env.STRAVA_MCP_URL || `${base.replace("gym-core-mcp", "gym-strava-mcp")}/mcp`,
};

async function rpc(url, name, args) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-api-key": KEY,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args || {} },
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${url} ${name} HTTP ${res.status}: ${text.slice(0, 200)}`);

  // Streamable HTTP typically responds SSE "data: {json}".
  const dataLine = text
    .split("\n")
    .find((l) => l.startsWith("data: "));
  const body = dataLine ? dataLine.slice("data: ".length) : text;

  let msg;
  try {
    msg = JSON.parse(body);
  } catch (e) {
    throw new Error(`${url} ${name} bad JSON envelope: ${String(e)}; body=${body.slice(0, 200)}`);
  }

  const outText = msg?.result?.content?.[0]?.text;
  if (typeof outText !== "string") return msg;
  try {
    return JSON.parse(outText);
  } catch {
    return { text: outText };
  }
}

async function main() {
  const telegramUserId = (process.env.TELEGRAM_USER_ID || "").trim();
  const scope = telegramUserId ? { telegramUserId } : null;
  const now = new Date();
  const fromISO = new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString();
  const toISO = now.toISOString();

  const checks = [
    ["core", "core_get_gym_metadata", {}],
    ["content", "content_list_docs", { limit: 1 }],
    ["content", "content_crawl_erie_now", { limit: 1 }],
    ["scheduling", "schedule_list_classes", { fromISO, toISO, limit: 3 }],
    ["weather", "weather_current", { lat: 40.03781, lon: -105.05228, units: "imperial" }],
    ["telegram", "telegram_ping", {}],
  ];

  if (scope) {
    checks.push(["weight", "weight_profile_get", { scope }]);
    checks.push(["weight", "weight_list_food", { scope, fromISO, toISO, limit: 5 }]);
    checks.push(["strava", "strava_list_workouts", { telegramUserId, limit: 5 }]);
  }

  const results = [];
  for (const [svc, tool, args] of checks) {
    const url = endpoints[svc];
    if (!url) throw new Error(`Missing URL for ${svc}`);
    const out = await rpc(url, tool, args);
    results.push({ svc, tool, ok: true, sampleKeys: Object.keys(out || {}) });
  }

  console.log(JSON.stringify({ ok: true, asOfISO: new Date().toISOString(), endpoints, results }, null, 2));
}

main().catch((e) => {
  console.error(String(e?.stack || e));
  process.exit(1);
});

