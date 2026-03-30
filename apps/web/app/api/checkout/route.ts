import { NextResponse } from "next/server";
import { requirePrivyAuth } from "../_lib/privy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
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
  const session =
    body?.session && typeof body.session === "object"
      ? (body.session as Record<string, unknown>)
      : undefined;
  const sessionOut: Record<string, unknown> = { ...(session ?? {}) };
  sessionOut.accountAddress = auth.accountAddress;
  if ("waiver" in sessionOut) delete sessionOut["waiver"];
  const threadIdRaw = sessionOut["threadId"];
  if (typeof threadIdRaw !== "string" || !threadIdRaw.trim()) {
    sessionOut.threadId = `thr_${auth.accountAddress.replace(/[^a-zA-Z0-9_]/g, "_")}`;
  }

  const url = `${deploymentUrl.replace(/\/$/, "")}/runs/wait`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({
      assistant_id: assistantId,
      input: { message: "__CHECKOUT__", session: sessionOut },
    }),
  });

  const json = (await res.json().catch(() => ({}))) as unknown;
  if (!res.ok) return NextResponse.json(json, { status: res.status });

  const j = json as Record<string, unknown>;
  const output = (j.output ?? {}) as Record<string, unknown>;
  return NextResponse.json(output);
}

