type McpServerCfg = {
  transport?: string;
  url?: string;
  headers?: Record<string, string>;
};

const ENV_VAR_PATTERN = /\$\{([A-Z0-9_]+)\}/g;

function substituteEnvVars(s: string): string {
  return s.replace(ENV_VAR_PATTERN, (_m, key: string) => process.env[key] ?? "");
}

function resolvePlaceholders(v: unknown): unknown {
  if (typeof v === "string") return substituteEnvVars(v);
  if (Array.isArray(v)) return v.map(resolvePlaceholders);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o)) out[k] = resolvePlaceholders(o[k]);
    return out;
  }
  return v;
}

function parseMcpServersJson(): Record<string, McpServerCfg> {
  const raw = (process.env.MCP_SERVERS_JSON ?? "").trim();
  if (!raw) throw new Error("Missing MCP_SERVERS_JSON (needed to call MCP servers from web routes).");
  const parsed = resolvePlaceholders(JSON.parse(raw)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid MCP_SERVERS_JSON (expected object).");
  return parsed as Record<string, McpServerCfg>;
}

async function readSseJson(res: Response): Promise<unknown> {
  const txt = await res.text();
  const m = txt.match(/data: (.+)\n/);
  if (!m) throw new Error(`Unexpected MCP SSE: ${txt.slice(0, 200)}`);
  return JSON.parse(m[1]);
}

export async function mcpToolCall(serverName: string, toolName: string, args: Record<string, unknown>): Promise<any> {
  const servers = parseMcpServersJson();
  const cfg = servers[serverName];
  const url = String(cfg?.url ?? "").trim();
  if (!url) throw new Error(`MCP server "${serverName}" missing url in MCP_SERVERS_JSON.`);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(cfg?.headers ?? {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: toolName, arguments: args } }),
  });

  const ct = res.headers.get("content-type") ?? "";
  const msg = ct.includes("application/json") ? await res.json() : await readSseJson(res);
  const text = (msg as any)?.result?.content?.[0]?.text;
  return typeof text === "string" ? JSON.parse(text) : msg;
}

