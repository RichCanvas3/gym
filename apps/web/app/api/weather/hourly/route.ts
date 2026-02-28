import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const lat = Number(url.searchParams.get("lat") ?? "40.015");
  const lon = Number(url.searchParams.get("lon") ?? "-105.2705");
  const hours = Math.max(1, Math.min(48, Number(url.searchParams.get("hours") ?? "48")));
  const units = (url.searchParams.get("units") ?? "metric").toLowerCase();

  // Weather is fetched via the agent (which uses MCP), not directly from the web app.
  const deploymentUrl = process.env.LANGGRAPH_DEPLOYMENT_URL ?? "";
  const apiKey = process.env.LANGSMITH_API_KEY ?? "";
  const assistantId = process.env.LANGGRAPH_ASSISTANT_ID ?? "gym";
  if (!deploymentUrl || !apiKey) {
    return NextResponse.json({ error: "Missing LANGGRAPH_DEPLOYMENT_URL or LANGSMITH_API_KEY" }, { status: 500 });
  }

  const msg = `__WEATHER_HOURLY__:${JSON.stringify({ lat, lon, hours, units })}`;
  const res = await fetch(`${deploymentUrl.replace(/\/$/, "")}/runs/wait`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({ assistant_id: assistantId, input: { message: msg, session: { timezone: "UTC" } } }),
  });
  const json = (await res.json().catch(() => ({}))) as unknown;
  if (!res.ok) return NextResponse.json(json, { status: res.status });
  const j = (json && typeof json === "object" ? (json as Record<string, unknown>) : {}) as Record<string, unknown>;
  const output = j.output && typeof j.output === "object" ? (j.output as Record<string, unknown>) : undefined;
  const data = output?.data;
  return NextResponse.json(data && typeof data === "object" ? data : {});
}

