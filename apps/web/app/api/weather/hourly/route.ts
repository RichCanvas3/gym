import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ToolCallResponse = {
  result?: {
    content?: Array<{ type?: unknown; text?: unknown }>;
  };
};

function extractSseDataLine(raw: string) {
  // Find the first "data: {...}" line.
  const lines = raw.split("\n");
  for (const l of lines) {
    if (l.startsWith("data: ")) return l.slice("data: ".length).trim();
  }
  return "";
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const lat = Number(url.searchParams.get("lat") ?? "40.015");
  const lon = Number(url.searchParams.get("lon") ?? "-105.2705");
  const hours = Math.max(1, Math.min(48, Number(url.searchParams.get("hours") ?? "48")));
  const units = (url.searchParams.get("units") ?? "metric").toLowerCase();

  const mcpUrl = process.env.WEATHER_MCP_URL ?? "";
  const mcpKey = process.env.WEATHER_MCP_API_KEY ?? "";
  if (!mcpUrl || !mcpKey) {
    return NextResponse.json({ error: "Missing WEATHER_MCP_URL or WEATHER_MCP_API_KEY" }, { status: 500 });
  }

  const res = await fetch(mcpUrl.replace(/\/$/, ""), {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "x-api-key": mcpKey,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "weather_forecast_hourly",
        arguments: { lat, lon, hours, units },
      },
    }),
  });

  const raw = await res.text();
  if (!res.ok) return NextResponse.json({ error: raw || `HTTP ${res.status}` }, { status: res.status });

  const data = extractSseDataLine(raw);
  if (!data) return NextResponse.json({ error: "Invalid MCP SSE response" }, { status: 502 });

  const parsed = JSON.parse(data) as ToolCallResponse;
  const text = parsed?.result?.content?.[0]?.text;
  if (typeof text !== "string") return NextResponse.json({ error: "Missing tool content text" }, { status: 502 });

  // tool returns JSON text
  const payload = JSON.parse(text) as unknown;
  return NextResponse.json(payload);
}

