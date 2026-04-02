import { NextResponse } from "next/server";
import { requirePrivyAuth } from "../../../_lib/privy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  challengeId?: unknown;
  signature?: unknown;
  walletAddress?: unknown;
};

function a2aAgentBaseUrl(): string {
  const u = String(process.env.A2A_AGENT_URL ?? "").trim();
  if (!u) throw new Error("Missing A2A_AGENT_URL");
  return u.replace(/\/+$/, "");
}

function a2aAdminKey(): string {
  const k = String(process.env.A2A_ADMIN_KEY ?? "").trim();
  if (!k) throw new Error("Missing A2A_ADMIN_KEY");
  return k;
}

export async function POST(req: Request) {
  const auth = await requirePrivyAuth(req);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });


  const body = (await req.json().catch(() => null)) as Body | null;
  const challengeId = typeof body?.challengeId === "string" ? body.challengeId.trim() : "";
  const signature = typeof body?.signature === "string" ? body.signature.trim() : "";
  const walletAddress = typeof body?.walletAddress === "string" ? body.walletAddress.trim() : "";
  if (!challengeId || !signature || !walletAddress) {
    return NextResponse.json({ ok: false, error: "missing_challenge_or_signature" }, { status: 400 });
  }

  try {
    const res = await fetch(`${a2aAgentBaseUrl()}/api/a2a/auth/verify`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-key": a2aAdminKey() },
      body: JSON.stringify({
        challengeId,
        signature,
        accountAddress: auth.accountAddress,
        walletAddress,
      }),
    });
    const json = (await res.json().catch(() => ({}))) as unknown;
    return NextResponse.json(json, { status: res.status });
  } catch (e) {
    return NextResponse.json({ ok: false, error: "verify_proxy_failed", detail: e instanceof Error ? e.message : String(e ?? "") }, { status: 502 });
  }
}
