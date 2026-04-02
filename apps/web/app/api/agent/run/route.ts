import { NextResponse } from "next/server";
import { requirePrivyAuth, telegramUserIdForPrivyDid } from "../../_lib/privy";
import { mcpToolCall } from "../../_lib/mcp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  message?: unknown;
  session?: unknown;
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

function a2aWebKey(): string {
  const k = String(process.env.A2A_WEB_KEY ?? "").trim();
  if (!k) throw new Error("Missing A2A_WEB_KEY");
  return k;
}

export async function POST(req: Request) {
  const auth = await requirePrivyAuth(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let agentHandle = "";
  let a2aHost = "";
  try {
    const origin = new URL(req.url).origin;
    const authz = req.headers.get("authorization") ?? "";
    const stRes = await fetch(`${origin}/api/agentictrust/status`, {
      headers: { authorization: authz },
      cache: "no-store",
    });
    const stJson = (await stRes.json().catch(() => ({}))) as unknown;
    const stRec = stJson && typeof stJson === "object" ? (stJson as Record<string, unknown>) : {};
    const gymName = typeof stRec.savedBaseName === "string" ? stRec.savedBaseName.trim() : "";
    agentHandle = typeof stRec.agentHandle === "string" ? stRec.agentHandle.trim() : "";
    a2aHost = typeof stRec.a2aHost === "string" ? stRec.a2aHost.trim() : "";
    const chatReady = stRec.chatReady === true;
    if (!gymName) {
      return NextResponse.json(
        {
          error: "invalid_gym_agent",
          detail: "No valid gym agent ENS name is available for this account.",
          pendingBaseName: typeof stRec.pendingBaseName === "string" ? stRec.pendingBaseName : null,
        },
        { status: 409 },
      );
    }
    if (!chatReady) {
      return NextResponse.json(
        {
          error: "agent_endpoint_unreachable",
          detail: "Gym agent A2A endpoint is not reachable yet.",
          a2aHost: a2aHost || null,
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
  let webKey = "";
  try {
    baseUrl = a2aAgentBaseUrl();
    adminKey = a2aAdminKey();
    webKey = a2aWebKey();
  } catch (e) {
    return NextResponse.json({ error: (e as Error)?.message ?? String(e ?? "") }, { status: 500 });
  }

  const body = (await req.json().catch(() => null)) as Body | null;
  const message = typeof body?.message === "string" ? body.message.trim() : "";

  if (!message) return NextResponse.json({ error: "Missing message" }, { status: 400 });

  const session =
    body?.session && typeof body.session === "object" ? (body.session as Record<string, unknown>) : undefined;

  const sessionOut: Record<string, unknown> = { ...(session ?? {}) };
  sessionOut.accountAddress = auth.accountAddress;
  let telegramUserId = await telegramUserIdForPrivyDid(auth.did);
  if (!telegramUserId) {
    try {
      const st = await mcpToolCall("telegram", "telegram_link_status", { accountAddress: auth.accountAddress });
      const rec = st && typeof st === "object" ? (st as Record<string, unknown>) : {};
      const v = rec.telegramUserId;
      telegramUserId = typeof v === "string" && v.trim() ? v.trim() : null;
    } catch {
      // ok: Telegram is optional (user can connect later)
    }
  }
  if (telegramUserId) sessionOut.telegramUserId = telegramUserId;
  // Remove legacy/unsupported identity field (waiver flow removed).
  if ("waiver" in sessionOut) delete sessionOut["waiver"];
  const derivedThreadId = `thr_${auth.accountAddress.replace(/[^a-zA-Z0-9_]/g, "_")}`;
  const threadIdRaw = sessionOut["threadId"];
  const threadId = typeof threadIdRaw === "string" && threadIdRaw.trim() ? threadIdRaw : derivedThreadId;
  sessionOut.threadId = threadId;

  // Ensure handle → account mapping exists (idempotent).
  try {
    await fetch(`${baseUrl}/api/a2a/handle`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-key": adminKey },
      body: JSON.stringify({
        handle: agentHandle,
        accountAddress: auth.accountAddress,
        telegramUserId: telegramUserId ?? null,
      }),
    });
  } catch {
    // ignore (best-effort); the subsequent /api/a2a call will fail clearly if handle missing
  }

  const a2aEndpoint = `${a2aHost}/api/a2a`;
  const res = await fetch(a2aEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", "x-web-key": webKey },
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

  const json = (await res.json().catch(() => ({}))) as unknown;
  const rec = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
  if (!res.ok) {
    return NextResponse.json(
      {
        error: "a2a_forward_failed",
        detail: rec?.error ?? json,
        hint: "A2A endpoint returned non-200. Verify A2A_HANDLE_BASE_DOMAIN points at gym-a2a-agent wildcard DNS and that HANDLE_BASE_DOMAIN in the worker matches.",
        a2aEndpoint,
      },
      { status: 502 },
    );
  }
  if (rec.ok !== true) {
    const looksLikeOtherAgent = rec.success === true || ("response" in rec && rec.ok !== true);
    return NextResponse.json(
      {
        error: "a2a_forward_failed",
        detail: json,
        hint: looksLikeOtherAgent
          ? "A2A_HANDLE_BASE_DOMAIN appears to route to a different worker/agent (response shape mismatch). Point wildcard DNS to gym-a2a-agent and set A2A_HANDLE_BASE_DOMAIN to that base domain."
          : "A2A response missing ok:true. Verify A2A_HANDLE_BASE_DOMAIN + worker HANDLE_BASE_DOMAIN and that the handle is connected.",
        a2aEndpoint,
      },
      { status: 502 },
    );
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

