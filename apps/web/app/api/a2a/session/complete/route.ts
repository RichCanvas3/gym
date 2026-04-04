import { NextResponse } from "next/server";
import { assembleSmartAgentSessionPackage } from "@agentic-trust/core";
import { requirePrivyAuth } from "../../../_lib/privy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  selector?: unknown;
  signedDelegation?: unknown;
  scDelegation?: unknown;
};

function a2aAgentBaseUrl(): string {
  const u = String(process.env.A2A_AGENT_URL ?? "").trim();
  if (!u) throw new Error("Missing A2A_AGENT_URL");
  return u.replace(/\/+$/, "");
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
  const body = (await req.json().catch(() => null)) as Body | null;
  const selector = typeof body?.selector === "string" ? body.selector.trim() : "";
  const signedDelegation = body?.signedDelegation && typeof body.signedDelegation === "object" ? body.signedDelegation : null;
  const scDelegation = body?.scDelegation && typeof body.scDelegation === "object" ? body.scDelegation : undefined;
  if (!selector || !signedDelegation) {
    return NextResponse.json({ ok: false, error: "missing_delegation" }, { status: 400 });
  }

  const statusRes = await fetch(`${origin}/api/a2a/session/status`, {
    headers: { authorization: authz },
    cache: "no-store",
  });
  const statusJson = (await statusRes.json().catch(() => ({}))) as Record<string, unknown>;
  if (!statusRes.ok || statusJson.ok !== true) {
    return NextResponse.json({ ok: false, error: "a2a_session_status_failed", detail: statusJson.error ?? statusJson }, { status: 502 });
  }

  const principalSmartAccount = typeof statusJson.principalSmartAccount === "string" ? statusJson.principalSmartAccount.trim() : "";
  const chainId = typeof statusJson.chainId === "number" ? statusJson.chainId : 11155111;
  const fullAgentName = typeof statusJson.fullAgentName === "string" ? statusJson.fullAgentName.trim() : "";
  if (!principalSmartAccount) {
    return NextResponse.json({ ok: false, error: "invalid_gym_agent", detail: "Missing principal smart account." }, { status: 409 });
  }

  const initRes = await fetch(
    `${a2aAgentBaseUrl()}/api/a2a/session/init?accountAddress=${encodeURIComponent(auth.accountAddress)}`,
    { headers: { "x-web-key": a2aWebKey() }, cache: "no-store" },
  );
  const initJson = (await initRes.json().catch(() => ({}))) as Record<string, unknown>;
  if (!initRes.ok || initJson.ok !== true || initJson.pending !== true) {
    return NextResponse.json({ ok: false, error: "missing_session_init", detail: initJson.error ?? initJson }, { status: 409 });
  }

  const initData = initJson.initData && typeof initJson.initData === "object" ? (initJson.initData as Record<string, unknown>) : null;
  const sessionAA = initData && typeof initData.sessionAA === "string" ? initData.sessionAA.trim() : "";
  const bundlerUrl = initData && typeof initData.bundlerUrl === "string" ? initData.bundlerUrl.trim() : "";
  const entryPoint = initData && typeof initData.entryPoint === "string" ? initData.entryPoint.trim() : "";
  const sessionKey = initData && typeof initData.sessionKey === "object" ? initData.sessionKey : null;
  if (!initData || !sessionAA || !bundlerUrl || !entryPoint || !sessionKey) {
    return NextResponse.json({ ok: false, error: "invalid_session_init", detail: "Stored init payload is incomplete." }, { status: 409 });
  }

  const sessionPackage = assembleSmartAgentSessionPackage({
    chainId,
    agentAccount: principalSmartAccount as `0x${string}`,
    sessionAA: sessionAA as `0x${string}`,
    sessionKey: sessionKey as never,
    entryPoint: entryPoint as `0x${string}`,
    bundlerUrl,
    selector: selector as `0x${string}`,
    signedDelegation: signedDelegation as never,
    ...(scDelegation ? { scDelegation: scDelegation as never } : {}),
    ensName: typeof initData.ensName === "string" && initData.ensName.trim() ? initData.ensName.trim() : fullAgentName || undefined,
    uaid: typeof initData.uaid === "string" && initData.uaid.trim() ? initData.uaid.trim() : undefined,
    did: typeof initData.did === "string" && initData.did.trim() ? initData.did.trim() : undefined,
  });

  const storeRes = await fetch(`${origin}/api/a2a/session/package`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: authz },
    body: JSON.stringify({ sessionPackage }),
  });
  const storeJson = (await storeRes.json().catch(() => ({}))) as Record<string, unknown>;
  if (!storeRes.ok || storeJson.ok !== true) {
    return NextResponse.json({ ok: false, error: "a2a_session_store_failed", detail: storeJson.error ?? storeJson }, { status: 502 });
  }

  return NextResponse.json(storeJson, { status: 200 });
}
