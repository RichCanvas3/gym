import { NextResponse } from "next/server";
import { requirePrivyAuth } from "../../../_lib/privy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

function chainSetting(chainId: number, base: string): string {
  if (chainId === 11155111) {
    return String(process.env[`${base}_SEPOLIA`] ?? process.env[`NEXT_PUBLIC_${base}_SEPOLIA`] ?? "").trim();
  }
  return "";
}

export async function GET(req: Request) {
  const auth = await requirePrivyAuth(req);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });

  const requestUrl = new URL(req.url);
  const origin = requestUrl.origin;
  const walletAddress = requestUrl.searchParams.get("walletAddress")?.trim() || "";
  const authz = req.headers.get("authorization") ?? "";
  const statusUrl = walletAddress
    ? `${origin}/api/agentictrust/status?walletAddress=${encodeURIComponent(walletAddress)}`
    : `${origin}/api/agentictrust/status`;
  const statusRes = await fetch(statusUrl, {
    headers: { authorization: authz },
    cache: "no-store",
  });
  const statusJson = (await statusRes.json().catch(() => ({}))) as unknown;
  const statusRec = statusJson && typeof statusJson === "object" ? (statusJson as Record<string, unknown>) : {};
  if (!statusRes.ok) {
    return NextResponse.json({ ok: false, error: "agentictrust_status_failed", detail: statusRec.error ?? statusJson }, { status: 502 });
  }

  const agentHandle = typeof statusRec.agentHandle === "string" ? statusRec.agentHandle.trim() : "";
  const a2aHost = typeof statusRec.a2aHost === "string" ? statusRec.a2aHost.trim() : "";
  const principalSmartAccount = typeof statusRec.agentAccount === "string" ? statusRec.agentAccount.trim() : "";
  const principalOwnerEoa = typeof statusRec.agentOwnerEoa === "string" ? statusRec.agentOwnerEoa.trim() : "";
  const chainId = typeof statusRec.chainId === "number" ? statusRec.chainId : 11155111;
  const agentId =
    typeof statusRec.agentId === "number"
      ? statusRec.agentId
      : typeof statusRec.agentId === "string" && statusRec.agentId.trim()
        ? Number(statusRec.agentId)
        : null;
  const fullAgentName = typeof statusRec.fullAgentName === "string" ? statusRec.fullAgentName.trim() : "";
  if (!agentHandle || !a2aHost || !principalSmartAccount || !principalOwnerEoa) {
    return NextResponse.json({ ok: false, error: "invalid_gym_agent", detail: "Missing agent handle, owner EOA, or smart account." }, { status: 409 });
  }

  const workerRes = await fetch(`${a2aAgentBaseUrl()}/api/a2a/session/status?accountAddress=${encodeURIComponent(auth.accountAddress)}`, {
    headers: { "x-web-key": a2aWebKey() },
    cache: "no-store",
  });
  const workerJson = (await workerRes.json().catch(() => ({}))) as unknown;
  const workerRec = workerJson && typeof workerJson === "object" ? (workerJson as Record<string, unknown>) : {};
  if (!workerRes.ok) {
    return NextResponse.json({ ok: false, error: "a2a_session_status_failed", detail: workerRec.error ?? workerJson }, { status: 502 });
  }

  const rpcUrl = chainSetting(chainId, "AGENTIC_TRUST_RPC_URL");
  const bundlerUrl = chainSetting(chainId, "AGENTIC_TRUST_BUNDLER_URL");
  if (!rpcUrl) {
    return NextResponse.json(
      {
        ok: false,
        error: "missing_a2a_rpc_url",
        detail: "Missing AGENTIC_TRUST_RPC_URL_SEPOLIA.",
      },
      { status: 409 },
    );
  }
  const bootstrapMissing = [
    !bundlerUrl ? "AGENTIC_TRUST_BUNDLER_URL_SEPOLIA" : "",
  ].filter(Boolean);
  const bootstrapReady = bootstrapMissing.length === 0;

  return NextResponse.json({
    ok: true,
    accountAddress: auth.accountAddress,
    agentHandle,
    a2aHost,
    principalSmartAccount,
    principalOwnerEoa,
    agentId,
    chainId,
    fullAgentName,
    rpcUrl,
    bundlerUrl,
    bootstrapReady,
    bootstrapMissing,
    ...workerRec,
  });
}
