import { NextResponse } from "next/server";
import { requirePrivyAuth } from "../../_lib/privy";
import { mcpToolCall } from "../../_lib/mcp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const auth = await requirePrivyAuth(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  try {
    const out = await mcpToolCall("strava", "strava_disconnect", { accountAddress: auth.accountAddress });
    return NextResponse.json(out);
  } catch (e) {
    return NextResponse.json({ error: "strava_disconnect_failed", detail: String((e as Error)?.message ?? e) }, { status: 502 });
  }
}

