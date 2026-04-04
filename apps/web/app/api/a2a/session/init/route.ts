import { NextResponse } from "next/server";
import { createSessionKeyAndSessionAccount } from "@agentic-trust/core";
import { requirePrivyAuth } from "../../../_lib/privy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

function a2aWebKey(): string {
  const k = String(process.env.A2A_WEB_KEY ?? "").trim();
  if (!k) throw new Error("Missing A2A_WEB_KEY");
  return k;
}

export async function POST(req: Request) {
  const auth = await requirePrivyAuth(req);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });

  const origin = new URL(req.url).origin;
  const authz = req.headers.get("authorization") ?? "";
  const statusRes = await fetch(`${origin}/api/a2a/session/status`, {
    headers: { authorization: authz },
    cache: "no-store",
  });
  const statusJson = (await statusRes.json().catch(() => ({}))) as Record<string, unknown>;
  if (!statusRes.ok || statusJson.ok !== true) {
    return NextResponse.json({ ok: false, error: "a2a_session_status_failed", detail: statusJson.error ?? statusJson }, { status: 502 });
  }

  if (statusJson.ready === true) {
    const packageMeta = statusJson.packageMeta && typeof statusJson.packageMeta === "object" ? (statusJson.packageMeta as Record<string, unknown>) : {};
    return NextResponse.json({
      ok: true,
      ready: true,
      chainId: statusJson.chainId ?? null,
      sessionAA: typeof packageMeta.sessionAA === "string" ? packageMeta.sessionAA : null,
    });
  }

  const agentHandle = typeof statusJson.agentHandle === "string" ? statusJson.agentHandle.trim() : "";
  const principalSmartAccount = typeof statusJson.principalSmartAccount === "string" ? statusJson.principalSmartAccount.trim() : "";
  const principalOwnerEoa = typeof statusJson.principalOwnerEoa === "string" ? statusJson.principalOwnerEoa.trim() : "";
  const fullAgentName = typeof statusJson.fullAgentName === "string" ? statusJson.fullAgentName.trim() : "";
  const chainId = typeof statusJson.chainId === "number" ? statusJson.chainId : 11155111;
  const rpcUrl = typeof statusJson.rpcUrl === "string" ? statusJson.rpcUrl.trim() : "";
  const bundlerUrl = typeof statusJson.bundlerUrl === "string" ? statusJson.bundlerUrl.trim() : "";
  if (!agentHandle || !principalSmartAccount || !principalOwnerEoa || !rpcUrl || !bundlerUrl) {
    return NextResponse.json({ ok: false, error: "invalid_gym_agent", detail: "Missing session init context." }, { status: 409 });
  }

  const existingRes = await fetch(
    `${a2aAgentBaseUrl()}/api/a2a/session/init?accountAddress=${encodeURIComponent(auth.accountAddress)}`,
    { headers: { "x-web-key": a2aWebKey() }, cache: "no-store" },
  );
  const existingJson = (await existingRes.json().catch(() => ({}))) as Record<string, unknown>;
  if (existingRes.ok && existingJson.ok === true && existingJson.pending === true) {
    const sessionAA = typeof existingJson.sessionAA === "string" ? existingJson.sessionAA.trim() : "";
    if (sessionAA) {
      return NextResponse.json({ ok: true, ready: false, chainId, sessionAA });
    }
  }

  const { artifacts, pub } = await createSessionKeyAndSessionAccount({
    chainId,
    rpcUrl,
    bundlerUrl,
    ensureSessionAccountDeployed: true,
  });
  const expiresAtISO = new Date(artifacts.sessionKey.validUntil * 1000).toISOString();

  const initStoreRes = await fetch(`${a2aAgentBaseUrl()}/api/a2a/session/init`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-key": a2aAdminKey() },
    body: JSON.stringify({
      accountAddress: auth.accountAddress,
      agentHandle,
      principalSmartAccount,
      principalOwnerEoa,
      chainId,
      sessionAA: pub.sessionAA,
      expiresAtISO,
      initData: {
        chainId,
        sessionAA: pub.sessionAA,
        sessionKey: artifacts.sessionKey,
        entryPoint: artifacts.entryPoint,
        bundlerUrl: artifacts.bundlerUrl,
        ensName: fullAgentName || null,
        uaid: null,
        did: null,
      },
    }),
  });
  const initStoreJson = (await initStoreRes.json().catch(() => ({}))) as Record<string, unknown>;
  if (!initStoreRes.ok || initStoreJson.ok !== true) {
    return NextResponse.json({ ok: false, error: "a2a_session_init_store_failed", detail: initStoreJson.error ?? initStoreJson }, { status: 502 });
  }

  return NextResponse.json({
    ok: true,
    ready: false,
    chainId: pub.chainId,
    sessionAA: pub.sessionAA,
  });
}
