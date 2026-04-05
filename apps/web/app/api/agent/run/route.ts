import { NextResponse } from "next/server";
import { requirePrivyAuth } from "../../_lib/privy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  message?: unknown;
  session?: unknown;
  a2aAuthSessionToken?: unknown;
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
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const body = (await req.json().catch(() => null)) as Body | null;
  let agentHandle = "";
  let a2aHost = "";
  try {
    const origin = new URL(req.url).origin;
    const authz = req.headers.get("authorization") ?? "";
    const walletAddress = typeof body?.walletAddress === "string" ? body.walletAddress.trim() : "";
    const statusUrl = walletAddress
      ? `${origin}/api/agentictrust/status?walletAddress=${encodeURIComponent(walletAddress)}`
      : `${origin}/api/agentictrust/status`;
    const stRes = await fetch(statusUrl, {
      headers: { authorization: authz },
      cache: "no-store",
    });
    const stJson = (await stRes.json().catch(() => ({}))) as unknown;
    const stRec = stJson && typeof stJson === "object" ? (stJson as Record<string, unknown>) : {};
    const gymName = typeof stRec.savedBaseName === "string" ? stRec.savedBaseName.trim() : "";
    const registrationRequired = stRec.registrationRequired === true;
    agentHandle = typeof stRec.agentHandle === "string" ? stRec.agentHandle.trim() : "";
    a2aHost = typeof stRec.a2aHost === "string" ? stRec.a2aHost.trim() : "";
    if (registrationRequired || !gymName) {
      return NextResponse.json(
        {
          error: "invalid_gym_agent",
          detail: "No valid gym agent ENS name is available for this account.",
          pendingBaseName: typeof stRec.pendingBaseName === "string" ? stRec.pendingBaseName : null,
        },
        { status: 409 },
      );
    }
    if (!agentHandle || !a2aHost) {
      return NextResponse.json(
        {
          error: "invalid_gym_agent",
          detail: "Gym agent status is missing the A2A routing metadata.",
          pendingBaseName: typeof stRec.pendingBaseName === "string" ? stRec.pendingBaseName : null,
        },
        { status: 409 },
      );
    }
  } catch (e) {
    return NextResponse.json(
      {
        error: "agentictrust_status_failed",
        detail: e instanceof Error ? e.message : String(e ?? ""),
      },
      { status: 502 },
    );
  }

  let baseUrl = "";
  let adminKey = "";
  try {
    baseUrl = a2aAgentBaseUrl();
    adminKey = a2aAdminKey();
  } catch (e) {
    return NextResponse.json({ error: (e as Error)?.message ?? String(e ?? "") }, { status: 500 });
  }

  const message = typeof body?.message === "string" ? body.message.trim() : "";
  const a2aAuthSessionToken = typeof body?.a2aAuthSessionToken === "string" ? body.a2aAuthSessionToken.trim() : "";

  if (!message) return NextResponse.json({ error: "Missing message" }, { status: 400 });
  if (!a2aAuthSessionToken) {
    return NextResponse.json({ error: "a2a_auth_required" }, { status: 401 });
  }

  const session = body?.session && typeof body.session === "object" ? (body.session as Record<string, unknown>) : undefined;

  const sessionOut: Record<string, unknown> = { ...(session ?? {}) };
  sessionOut.accountAddress = auth.accountAddress;
  if ("telegramUserId" in sessionOut) delete sessionOut.telegramUserId;
  if ("waiver" in sessionOut) delete sessionOut["waiver"];
  const derivedThreadId = `thr_${auth.accountAddress.replace(/[^a-zA-Z0-9_]/g, "_")}`;
  const threadIdRaw = sessionOut["threadId"];
  const threadId = typeof threadIdRaw === "string" && threadIdRaw.trim() ? threadIdRaw : derivedThreadId;
  sessionOut.threadId = threadId;

  try {
    await fetch(`${baseUrl}/api/a2a/handle`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-key": adminKey },
      body: JSON.stringify({
        handle: agentHandle,
        accountAddress: auth.accountAddress,
      }),
    });
  } catch {
    // ignore (best-effort); the subsequent /api/a2a call will fail clearly if handle missing
  }

  const a2aEndpoint = `${a2aHost}/api/a2a`;
  let res: Response;
  try {
    res = await fetch(a2aEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "x-a2a-web-session": a2aAuthSessionToken },
      body: JSON.stringify({
        fromAgentId: "web",
        toAgentId: "gym-a2a-agent",
        message,
        metadata: {
          session: sessionOut,
          webThreadId: threadId,
        },
      }),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e ?? "");
    console.error("[a2a] forward network error", { accountAddress: auth.accountAddress, agentHandle, a2aHost, a2aEndpoint, detail: msg });
    return NextResponse.json({ error: "a2a_forward_network_error", detail: msg, a2aEndpoint }, { status: 502 });
  }

  const json = (await res.json().catch(() => ({}))) as unknown;
  const rec = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
  if (!res.ok) {
    console.error("[a2a] forward non-200", {
      accountAddress: auth.accountAddress,
      agentHandle,
      a2aHost,
      a2aEndpoint,
      status: res.status,
      body: json,
    });
    const upstreamError = typeof rec.error === "string" ? rec.error : "";
    const authish =
      upstreamError === "a2a_auth_required" ||
      upstreamError === "a2a_auth_invalid" ||
      upstreamError === "a2a_auth_expired" ||
      upstreamError === "a2a_auth_account_mismatch" ||
      upstreamError === "a2a_auth_agent_mismatch";
    const status = authish ? 401 : res.status;
    return NextResponse.json(
      {
        error: authish ? upstreamError || "a2a_auth_required" : "a2a_forward_failed",
        detail: rec?.error ?? json,
        a2aEndpoint,
        upstreamStatus: res.status,
      },
      { status },
    );
  }
  if (rec.ok !== true) {
    console.error("[a2a] forward bad-shape", {
      accountAddress: auth.accountAddress,
      agentHandle,
      a2aHost,
      a2aEndpoint,
      body: json,
    });
    const upstreamError = typeof rec.error === "string" ? rec.error : "";
    const authish =
      upstreamError === "a2a_auth_required" ||
      upstreamError === "a2a_auth_invalid" ||
      upstreamError === "a2a_auth_expired" ||
      upstreamError === "session_handle_mismatch" ||
      upstreamError === "session_account_mismatch" ||
      upstreamError === "session_agent_mismatch";
    const status = authish ? 401 : 502;
    return NextResponse.json({ error: authish ? upstreamError || "a2a_auth_required" : "a2a_forward_failed", detail: json, a2aEndpoint }, { status });
  }

  const agentOutput = rec.agentOutput;
  if (agentOutput && typeof agentOutput === "object" && !Array.isArray(agentOutput)) {
    return NextResponse.json(agentOutput);
  }
  const response = rec.response && typeof rec.response === "object" ? (rec.response as Record<string, unknown>) : {};
  const answer = typeof response.answer === "string" ? response.answer : "";
  if (answer.trim()) return NextResponse.json({ answer });
  return NextResponse.json({ error: "Agent returned no output", detail: json }, { status: 502 });
}
