import { NextResponse } from "next/server";
import { requirePrivyAuth } from "../../_lib/privy";
import { mcpToolCall } from "../../_lib/mcp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const auth = await requirePrivyAuth(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  try {
    const out = await mcpToolCall("telegram", "telegram_link_disconnect", { accountAddress: auth.accountAddress });
    return NextResponse.json(out);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e ?? "");
    return NextResponse.json({ error: "telegram_disconnect_failed", detail: msg }, { status: 502 });
  }
}

