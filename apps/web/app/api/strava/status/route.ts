import { NextResponse } from "next/server";
import { requirePrivyAuth, telegramUserIdForPrivyDid } from "../../_lib/privy";
import { mcpToolCall } from "../../_lib/mcp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await requirePrivyAuth(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const tgUserId = await telegramUserIdForPrivyDid(auth.did);
  if (!tgUserId) return NextResponse.json({ ok: true, connected: false, reason: "telegram_not_linked" });

  const out = await mcpToolCall("strava", "strava_status", { telegramUserId: tgUserId });
  return NextResponse.json(out);
}

