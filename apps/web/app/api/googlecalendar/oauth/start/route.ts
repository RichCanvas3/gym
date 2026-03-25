import { NextResponse } from "next/server";
import { requirePrivyAuth } from "../../../_lib/privy";

type McpServerCfg = { url?: string; headers?: Record<string, string> };

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
  if (!raw) throw new Error("Missing MCP_SERVERS_JSON");
  const parsed = resolvePlaceholders(JSON.parse(raw)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid MCP_SERVERS_JSON");
  return parsed as Record<string, McpServerCfg>;
}

function googleCalendarBaseUrl(): string {
  const servers = parseMcpServersJson();
  const url = String(servers.googlecalendar?.url ?? "").trim();
  if (!url) throw new Error('MCP_SERVERS_JSON missing "googlecalendar.url"');
  return url.replace(/\/mcp\/?$/, "");
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function buildOauthStartUrl(accountAddress: string): string {
  const base = googleCalendarBaseUrl();
  const u = new URL(`${base}/oauth/start`);
  u.searchParams.set("accountAddress", accountAddress);
  return u.toString();
}

export async function POST(req: Request) {
  const auth = await requirePrivyAuth(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  return NextResponse.json({ ok: true, url: buildOauthStartUrl(auth.accountAddress) });
}

// Browser navigations can't attach Authorization headers; keep GET for debugging only.
export async function GET(req: Request) {
  const auth = await requirePrivyAuth(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  return NextResponse.redirect(buildOauthStartUrl(auth.accountAddress), 302);
}

