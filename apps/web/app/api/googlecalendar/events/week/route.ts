import { NextResponse } from "next/server";
import { requirePrivyAuth, telegramUserIdForPrivyDid } from "../../../_lib/privy";
import { mcpToolCall } from "../../../_lib/mcp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function addDaysISO(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00.000Z`);
  const ms = d.getTime();
  if (!Number.isFinite(ms)) return isoDate;
  return new Date(ms + days * 24 * 3600 * 1000).toISOString().slice(0, 10);
}

export async function GET(req: Request) {
  const auth = await requirePrivyAuth(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const tg = await telegramUserIdForPrivyDid(auth.did);
  if (!tg) return NextResponse.json({ error: "Telegram not linked for this Privy user." }, { status: 400 });

  const url = new URL(req.url);
  const start = String(url.searchParams.get("start") ?? "").trim();
  if (!start || !isIsoDate(start)) return NextResponse.json({ error: "Missing/invalid start (YYYY-MM-DD)" }, { status: 400 });

  const end = addDaysISO(start, 7);
  const timeMinISO = `${start}T00:00:00.000Z`;
  const timeMaxISO = `${end}T00:00:00.000Z`;

  const out = await mcpToolCall("googlecalendar", "googlecalendar_list_events_cached", {
    telegramUserId: tg,
    timeMinISO,
    timeMaxISO,
    maxResults: 200,
  });
  return NextResponse.json({ ok: true, start, end, timeMinISO, timeMaxISO, ...out });
}

