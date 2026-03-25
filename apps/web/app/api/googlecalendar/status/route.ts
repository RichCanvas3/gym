import { NextResponse } from "next/server";
import { requirePrivyAuth } from "../../_lib/privy";
import { mcpToolCall } from "../../_lib/mcp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await requirePrivyAuth(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  try {
    const out = await mcpToolCall("googlecalendar", "googlecalendar_get_connection_status", {
      accountAddress: auth.accountAddress,
    });
    return NextResponse.json(out);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e ?? "");
    const hint =
      msg.includes("Missing MCP_SERVERS_JSON") || msg.includes('missing "googlecalendar.url"') || msg.includes('missing url in MCP_SERVERS_JSON')
        ? "Set MCP_SERVERS_JSON in Vercel to include the googlecalendar server (url ends with /mcp) and redeploy."
        : undefined;
    return NextResponse.json({ error: "googlecalendar_status_failed", detail: msg, ...(hint ? { hint } : {}) }, { status: 500 });
  }
}

