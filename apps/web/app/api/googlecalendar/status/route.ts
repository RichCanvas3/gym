import { NextResponse } from "next/server";
import { requirePrivyAuth } from "../../_lib/privy";
import { mcpToolCall } from "../../_lib/mcp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await requirePrivyAuth(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const out = await mcpToolCall("googlecalendar", "googlecalendar_get_connection_status", {
    accountAddress: auth.accountAddress,
  });
  return NextResponse.json(out);
}

