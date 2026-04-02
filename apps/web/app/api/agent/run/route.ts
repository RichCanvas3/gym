import { NextResponse } from "next/server";
import { requirePrivyAuth, telegramUserIdForPrivyDid } from "../../_lib/privy";
import { mcpToolCall } from "../../_lib/mcp";
import { createHash } from "crypto";

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

function a2aHandleBaseDomain(): string {
  const s = String(process.env.A2A_HANDLE_BASE_DOMAIN ?? "").trim();
  if (!s) throw new Error("Missing A2A_HANDLE_BASE_DOMAIN");
  const noProto = s.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  if (!noProto) throw new Error("Invalid A2A_HANDLE_BASE_DOMAIN");
  return noProto;
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

function handleForAccountAddress(accountAddress: string): string {
  const acct = String(accountAddress ?? "").trim();
  const hex = createHash("sha256").update(acct).digest("hex");
  // Must match: /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/
  return `u-${hex.slice(0, 50)}`;
}

export async function POST(req: Request) {
  const auth = await requirePrivyAuth(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

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
    if (!gymName) {
      return NextResponse.json(
        {
          error: "invalid_gym_agent",
          detail: "No discovered gym agent ending with -gym.8004-agent.eth is available for this account.",
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
  let baseDomain = "";
  let adminKey = "";
  let webKey = "";
  try {
    baseUrl = a2aAgentBaseUrl();
    baseDomain = a2aHandleBaseDomain();
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

  const handle = handleForAccountAddress(auth.accountAddress);

  // Ensure handle → account mapping exists (idempotent).
  try {
    await fetch(`${baseUrl}/api/a2a/handle`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-key": adminKey },
      body: JSON.stringify({
        handle,
        accountAddress: auth.accountAddress,
        telegramUserId: telegramUserId ?? null,
      }),
    });
  } catch {
    // ignore (best-effort); the subsequent /api/a2a call will fail clearly if handle missing
  }

  const a2aEndpoint = `https://${handle}.${baseDomain}/api/a2a`;
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

