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
    return NextResponse.json({ error: "telegram_oauth_start_failed", detail: String((e as Error)?.message ?? e) }, { status: 502 });
  }
}

