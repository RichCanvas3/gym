import { NextResponse } from "next/server";
import { requirePrivyAuth, telegramUserIdForPrivyDid } from "../../_lib/privy";
import { mcpToolCall } from "../../_lib/mcp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = { timeMinISO?: unknown; timeMaxISO?: unknown };

function isoOrEmpty(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export async function POST(req: Request) {
  const auth = await requirePrivyAuth(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const tg = await telegramUserIdForPrivyDid(auth.did);
  if (!tg) return NextResponse.json({ error: "Telegram not linked for this Privy user." }, { status: 400 });

  const body = (await req.json().catch(() => null)) as Body | null;
  const now = Date.now();
  const timeMinISO = isoOrEmpty(body?.timeMinISO) || new Date(now - 30 * 24 * 3600 * 1000).toISOString();
  const timeMaxISO = isoOrEmpty(body?.timeMaxISO) || new Date(now + 90 * 24 * 3600 * 1000).toISOString();

  const out = await mcpToolCall("googlecalendar", "googlecalendar_sync_events", {
    telegramUserId: tg,
    timeMinISO,
    timeMaxISO,
    maxResults: 2500,
  });
  const extra = out && typeof out === "object" ? (out as Record<string, unknown>) : { raw: out };
  return NextResponse.json({ ok: true, timeMinISO, timeMaxISO, ...extra });
}

