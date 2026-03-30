import { NextResponse } from "next/server";
import { requirePrivyAuth, telegramUserIdForPrivyDid } from "../../_lib/privy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = { handle?: unknown };

function safeHandle(v: unknown): string {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (!s) return "";
  if (!/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(s)) return "";
  return s;
}

function a2aWorkerBaseUrl(): string {
  const u = String(process.env.A2A_AGENT_URL ?? "").trim();
  if (!u) throw new Error("Missing A2A_AGENT_URL");
  return u.replace(/\/+$/, "");
}

export async function POST(req: Request) {
  const auth = await requirePrivyAuth(req);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });

  const adminKey = String(process.env.A2A_ADMIN_KEY ?? "").trim();
  if (!adminKey) return NextResponse.json({ ok: false, error: "Missing A2A_ADMIN_KEY" }, { status: 500 });

  const body = (await req.json().catch(() => null)) as Body | null;
  const handle = safeHandle(body?.handle);
  if (!handle) return NextResponse.json({ ok: false, error: "Invalid handle (use a-z0-9 and dashes, 3-64 chars)." }, { status: 400 });

  const tg = await telegramUserIdForPrivyDid(auth.did);

  const base = a2aWorkerBaseUrl();
  const res = await fetch(`${base}/api/a2a/handle`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-key": adminKey },
    body: JSON.stringify({ handle, accountAddress: auth.accountAddress, telegramUserId: tg }),
  });
  const json = (await res.json().catch(() => ({}))) as unknown;
  if (!res.ok) return NextResponse.json(json, { status: res.status });
  return NextResponse.json({ ok: true, handle, accountAddress: auth.accountAddress, worker: base, result: json });
}

