import { NextResponse } from "next/server";
import { requirePrivyAuth } from "../../../_lib/privy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  origin?: unknown;
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
  const reqOrigin = typeof body?.origin === "string" ? body.origin.trim() : "";
  const walletAddress = typeof body?.walletAddress === "string" ? body.walletAddress.trim() : "";
  const origin = reqOrigin || new URL(req.url).origin;
  const authz = req.headers.get("authorization") ?? "";
  const statusUrl = walletAddress
    ? `${origin}/api/agentictrust/status?walletAddress=${encodeURIComponent(walletAddress)}`
    : `${origin}/api/agentictrust/status`;

  const stRes = await fetch(statusUrl, {
    headers: { authorization: authz },
    cache: "no-store",
  });
  const stJson = (await stRes.json().catch(() => ({}))) as unknown;
  const stRec = stJson && typeof stJson === "object" ? (stJson as Record<string, unknown>) : {};
  if (!stRes.ok) {
    return NextResponse.json({ ok: false, error: "agentictrust_status_failed", detail: stRec.error ?? stJson }, { status: 502 });
  }

  const agentHandle = typeof stRec.agentHandle === "string" ? stRec.agentHandle.trim() : "";
  const a2aHost = typeof stRec.a2aHost === "string" ? stRec.a2aHost.trim() : "";
  const principalSmartAccount = typeof stRec.agentAccount === "string" ? stRec.agentAccount.trim() : "";
  const chainId = typeof stRec.chainId === "number" ? stRec.chainId : 11155111;
  const agentOwnerEoa = typeof stRec.agentOwnerEoa === "string" ? stRec.agentOwnerEoa.trim() : "";
  if (!agentHandle || !a2aHost || !principalSmartAccount || !agentOwnerEoa) {
    const missing = [
      !agentHandle ? "agentHandle" : null,
      !a2aHost ? "a2aHost" : null,
      !principalSmartAccount ? "agentAccount" : null,
      !agentOwnerEoa ? "agentOwnerEoa" : null,
    ].filter(Boolean);
    const detail =
      typeof stRec.note === "string" && stRec.note.trim()
        ? stRec.note.trim()
        : typeof stRec.detail === "string" && stRec.detail.trim()
          ? stRec.detail.trim()
          : "Missing agent handle, A2A host, principal smart account, or agent owner EOA.";
    return NextResponse.json(
      { ok: false, error: "invalid_gym_agent", detail, missing },
      { status: 409 },
    );
  }

  try {
    const res = await fetch(`${a2aAgentBaseUrl()}/api/a2a/auth/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-key": a2aAdminKey() },
      body: JSON.stringify({
        accountAddress: auth.accountAddress,
        walletAddress: agentOwnerEoa,
        principalSmartAccount,
        agentHandle,
        a2aHost,
        chainId,
        origin,
      }),
    });
    const json = (await res.json().catch(() => ({}))) as unknown;
    return NextResponse.json(json, { status: res.status });
  } catch (e) {
    return NextResponse.json({ ok: false, error: "challenge_proxy_failed", detail: e instanceof Error ? e.message : String(e ?? "") }, { status: 502 });
  }
}
