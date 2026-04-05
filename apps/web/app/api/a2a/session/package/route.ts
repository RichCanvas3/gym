import { NextResponse } from "next/server";
import { requirePrivyAuth } from "../../../_lib/privy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  sessionPackage?: unknown;
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

  const origin = new URL(req.url).origin;
  const authz = req.headers.get("authorization") ?? "";
  const body = (await req.json().catch(() => null)) as Body | null;
  const sessionPackage = body?.sessionPackage && typeof body.sessionPackage === "object" ? body.sessionPackage : null;
  const walletAddress = typeof body?.walletAddress === "string" ? body.walletAddress.trim() : "";
  if (!sessionPackage) {
    return NextResponse.json({ ok: false, error: "missing_session_package" }, { status: 400 });
  }

  const statusUrl = walletAddress
    ? `${origin}/api/a2a/session/status?walletAddress=${encodeURIComponent(walletAddress)}`
    : `${origin}/api/a2a/session/status`;
  const statusRes = await fetch(statusUrl, {
    headers: { authorization: authz },
    cache: "no-store",
  });
  const statusJson = (await statusRes.json().catch(() => ({}))) as unknown;
  const statusRec = statusJson && typeof statusJson === "object" ? (statusJson as Record<string, unknown>) : {};
  if (!statusRes.ok) {
    return NextResponse.json({ ok: false, error: "a2a_session_status_failed", detail: statusRec.error ?? statusJson }, { status: 502 });
  }

  const agentHandle = typeof statusRec.agentHandle === "string" ? statusRec.agentHandle.trim() : "";
  const principalSmartAccount = typeof statusRec.principalSmartAccount === "string" ? statusRec.principalSmartAccount.trim() : "";
  const principalOwnerEoa = typeof statusRec.principalOwnerEoa === "string" ? statusRec.principalOwnerEoa.trim() : "";
  const chainId = typeof statusRec.chainId === "number" ? statusRec.chainId : 11155111;
  const agentId =
    typeof statusRec.agentId === "number"
      ? statusRec.agentId
      : typeof statusRec.agentId === "string" && statusRec.agentId.trim()
        ? Number(statusRec.agentId)
        : null;
  if (!agentHandle || !principalSmartAccount || !principalOwnerEoa) {
    return NextResponse.json({ ok: false, error: "invalid_gym_agent", detail: "Missing session package context." }, { status: 409 });
  }

  const workerRes = await fetch(`${a2aAgentBaseUrl()}/api/a2a/session/package`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-key": a2aAdminKey() },
    body: JSON.stringify({
      accountAddress: auth.accountAddress,
      agentHandle,
      principalSmartAccount,
      principalOwnerEoa,
      agentId,
      chainId,
      sessionPackage,
    }),
  });
  const workerJson = (await workerRes.json().catch(() => ({}))) as unknown;
  return NextResponse.json(workerJson, { status: workerRes.status });
}
