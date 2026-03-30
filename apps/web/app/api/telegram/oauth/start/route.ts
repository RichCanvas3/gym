import { NextResponse } from "next/server";
import { requirePrivyAuth } from "../../../_lib/privy";
import { mcpToolCall } from "../../../_lib/mcp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const auth = await requirePrivyAuth(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  try {
    const out = await mcpToolCall("telegram", "telegram_link_start", { accountAddress: auth.accountAddress });
    const rec = out && typeof out === "object" ? (out as Record<string, unknown>) : {};
    const startUrl = typeof rec.startUrl === "string" ? rec.startUrl : null;
    if (!startUrl) return NextResponse.json({ error: "telegram_oauth_start_failed", detail: out }, { status: 502 });
    return NextResponse.json({ ok: true, startUrl });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e ?? "");
    const hint =
      msg.includes("Missing MCP_SERVERS_JSON") ||
      msg.includes('MCP server "telegram" missing url in MCP_SERVERS_JSON')
        ? 'Set MCP_SERVERS_JSON to include {"telegram":{"url":"https://<telegram-mcp>/mcp","headers":{"x-api-key":"${TELEGRAM_MCP_API_KEY}"}}} and redeploy.'
        : msg.includes("Unauthorized")
          ? "Your telegram MCP URL is reachable but auth failed. Ensure MCP_SERVERS_JSON.telegram.headers.x-api-key matches telegram-mcp MCP_API_KEY."
          : msg.includes("Unexpected MCP SSE") || msg.includes("Not Found")
            ? 'Your telegram MCP URL is probably missing the `/mcp` suffix (it must end with `/mcp`).'
            : undefined;
    return NextResponse.json({ error: "telegram_oauth_start_failed", detail: msg, ...(hint ? { hint } : {}) }, { status: 502 });
  }
}

