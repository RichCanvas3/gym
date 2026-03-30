import { NextResponse } from "next/server";
import { requirePrivyAuth, telegramUserIdForPrivyDid } from "../../_lib/privy";
import { mcpToolCall } from "../../_lib/mcp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  message?: unknown;
  session?: unknown;
};

export async function POST(req: Request) {
  const deploymentUrl = process.env.LANGGRAPH_DEPLOYMENT_URL ?? "";
  const apiKey = process.env.LANGSMITH_API_KEY ?? "";
  const assistantId = process.env.LANGGRAPH_ASSISTANT_ID ?? "gym";

  const auth = await requirePrivyAuth(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  if (!deploymentUrl || !apiKey) {
    return NextResponse.json(
      { error: "Missing LANGGRAPH_DEPLOYMENT_URL or LANGSMITH_API_KEY" },
      { status: 500 },
    );
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

  const url = `${deploymentUrl.replace(/\/$/, "")}/runs/wait`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({
      assistant_id: assistantId,
      input: { message, session: sessionOut },
      // LangGraph uses thread_id (via config) to restore state when a checkpointer is configured.
      config: threadId ? { configurable: { thread_id: threadId } } : undefined,
    }),
  });

  const json = (await res.json().catch(() => ({}))) as unknown;
  if (!res.ok) {
    return NextResponse.json(json, { status: res.status });
  }

  // Our graph returns { output: { answer, ... }, messages: [...] }
  const j = json as Record<string, unknown>;
  if (j.__error__ && typeof j.__error__ === "object") {
    return NextResponse.json({ error: "Agent error", detail: j.__error__ }, { status: 502 });
  }
  const output = (j.output ?? {}) as Record<string, unknown>;
  if (!output || typeof output !== "object" || Array.isArray(output) || !("answer" in output)) {
    return NextResponse.json({ error: "Agent returned no output", detail: j }, { status: 502 });
  }
  return NextResponse.json(output);
}

