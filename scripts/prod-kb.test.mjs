import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function loadDotEnvLocal() {
  const p = path.join(process.cwd(), "apps", "web", ".env.local");
  if (!fs.existsSync(p)) return {};
  const lines = fs.readFileSync(p, "utf8").split("\n");
  const out = {};
  for (const line of lines) {
    const s = line.trim();
    if (!s || s.startsWith("#") || !s.includes("=")) continue;
    const idx = s.indexOf("=");
    const k = s.slice(0, idx).trim();
    const v = s.slice(idx + 1);
    out[k] = v;
  }
  return out;
}

const envLocal = loadDotEnvLocal();
const CORE_MCP_URL = (process.env.CORE_MCP_URL || envLocal.CORE_MCP_URL || "").trim() || "https://gym-core-mcp.richardpedersen3.workers.dev/mcp";
const KEY = (process.env.CORE_MCP_API_KEY || process.env.MCP_API_KEY || envLocal.CORE_MCP_API_KEY || "gym").trim();

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
  assert.ok(res.ok, `HTTP ${res.status} calling ${name}: ${text.slice(0, 200)}`);
  const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
  const body = dataLine ? dataLine.slice("data: ".length) : text;
  const msg = JSON.parse(body);
  const outText = msg?.result?.content?.[0]?.text;
  if (typeof outText !== "string") return msg;
  try {
    return JSON.parse(outText);
  } catch {
    return { text: outText };
  }
}

test("prod core KB contains FitnessCore ontology + SQL schema docs", async () => {
  const out = await rpc(CORE_MCP_URL, "core_kb_list_chunks", { limit: 2000, offset: 0 });
  assert.equal(out?.ok ?? true, true); // tolerate older envelopes
  const chunks = Array.isArray(out?.chunks) ? out.chunks : [];
  assert.ok(chunks.length > 0, "Expected non-empty kb_chunks in core");

  const sources = new Set(chunks.map((c) => String(c?.sourceId || "")));
  assert.ok(
    Array.from(sources).some((s) => s.startsWith("fitness/fitnesscore_ontology.md")),
    "Expected FitnessCore ontology KB doc to be indexed",
  );
  assert.ok(
    Array.from(sources).some((s) => s.startsWith("fitness/sql_schemas.md")),
    "Expected SQL schemas KB doc to be indexed",
  );
});

