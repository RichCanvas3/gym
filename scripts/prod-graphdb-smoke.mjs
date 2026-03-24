/**
 * Smoke test: can we query FitnessCore GraphDB via gym-core-mcp tool.
 *
 * Requires env:
 * - CORE_MCP_URL
 * - CORE_MCP_API_KEY (if protected)
 * - TG_USER_ID (telegram user id)
 *
 * Optional:
 * - FITNESSCORE_GRAPH_CONTEXT_BASE (defaults to https://id.fitnesscore.ai/graph/d1)
 */
const coreUrl = (process.env.CORE_MCP_URL || "").trim().replace(/\/+$/, "");
if (!coreUrl) throw new Error("Missing CORE_MCP_URL");
const apiKey = (process.env.CORE_MCP_API_KEY || "").trim();
const tgUserId = (process.env.TG_USER_ID || "").trim();
if (!tgUserId) throw new Error("Missing TG_USER_ID");
const base = (process.env.FITNESSCORE_GRAPH_CONTEXT_BASE || "https://id.fitnesscore.ai/graph/d1").trim().replace(/\/+$/, "");
const graph = `${base}/${encodeURIComponent(`tg:${tgUserId}`)}`;

const q = `
PREFIX fc: <https://ontology.fitnesscore.ai/fc#>
SELECT (COUNT(?s) AS ?n) WHERE {
  GRAPH <${graph}> { ?s a fc:Workout . }
}
`.trim();

const res = await fetch(`${coreUrl}/mcp`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(apiKey ? { "x-api-key": apiKey } : {}),
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: "1",
    method: "tools/call",
    params: { name: "core_graphdb_sparql_select", arguments: { query: q } },
  }),
});

const txt = await res.text();
if (!res.ok) throw new Error(`HTTP ${res.status}: ${txt.slice(0, 800)}`);
// Worker MCP commonly responds as SSE; extract first `data: ...` line if present.
let out;
const m = txt.match(/data: (.+)\n/);
if (m && m[1]) {
  try {
    out = JSON.parse(m[1]);
  } catch {
    out = { raw: txt.slice(0, 2000) };
  }
} else {
  try {
    out = JSON.parse(txt);
  } catch {
    out = { raw: txt.slice(0, 2000) };
  }
}
console.log(JSON.stringify({ ok: true, graph, out }, null, 2));

