import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const deploymentUrl = process.env.LANGGRAPH_DEPLOYMENT_URL ?? "";
  const apiKey = process.env.LANGSMITH_API_KEY ?? "";
  const assistantId = process.env.LANGGRAPH_ASSISTANT_ID ?? "gym";
  if (!deploymentUrl || !apiKey) {
    return NextResponse.json({ error: "Missing LANGGRAPH_DEPLOYMENT_URL or LANGSMITH_API_KEY" }, { status: 500 });
  }

  const url = new URL(req.url);
  const start = url.searchParams.get("start") ?? "";
  const msg = `__CALENDAR_WEEK__:${start}`;

  const res = await fetch(`${deploymentUrl.replace(/\/$/, "")}/runs/wait`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({
      assistant_id: assistantId,
      input: { message: msg, session: { gymName: "Front Range Climbing (Boulder)", timezone: "America/Denver" } },
    }),
  });

  const json = (await res.json().catch(() => ({}))) as unknown;
  if (!res.ok) return NextResponse.json(json, { status: res.status });
  const j = (json && typeof json === "object" ? (json as Record<string, unknown>) : {}) as Record<string, unknown>;
  const output =
    j.output && typeof j.output === "object" ? (j.output as Record<string, unknown>) : ({} as Record<string, unknown>);
  const schedule = output.schedule && typeof output.schedule === "object" ? output.schedule : {};
  return NextResponse.json(schedule);
}

