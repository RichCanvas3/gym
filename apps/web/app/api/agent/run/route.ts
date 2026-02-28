import { NextResponse } from "next/server";

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

  const threadId =
    session && typeof (session as any).threadId === "string" ? String((session as any).threadId) : undefined;

  const url = `${deploymentUrl.replace(/\/$/, "")}/runs/wait`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({
      assistant_id: assistantId,
      input: { message, session },
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
  const output = (j.output ?? {}) as Record<string, unknown>;
  return NextResponse.json(output);
}

