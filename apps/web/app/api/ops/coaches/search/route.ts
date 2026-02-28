import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ToolCallResponse = { result?: { content?: Array<{ type?: unknown; text?: unknown }> } };

function extractSseDataLine(raw: string): string {
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith("data: ")) return line.slice("data: ".length).trim();
  }
  return "";
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const skill = url.searchParams.get("skill") ?? "";

  if (!skill) {
    return NextResponse.json({ error: "Missing skill" }, { status: 400 });
  }

  const mcpUrl = process.env.SCHEDULING_MCP_URL ?? "";
  const mcpKey = process.env.SCHEDULING_MCP_API_KEY ?? "";
  if (!mcpUrl || !mcpKey) {
    return NextResponse.json({ error: "Missing SCHEDULING_MCP_URL or SCHEDULING_MCP_API_KEY" }, { status: 500 });
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
      params: { name: "schedule_list_instructors", arguments: {} },
    }),
  });

  const raw = await res.text();
  if (!res.ok) return NextResponse.json({ error: "Scheduling MCP error", detail: raw }, { status: 502 });

  const dataLine = extractSseDataLine(raw);
  const parsed = (JSON.parse(dataLine) as ToolCallResponse) ?? {};
  const txt = parsed?.result?.content?.find((c) => c?.type === "text")?.text;
  const payload = typeof txt === "string" ? (JSON.parse(txt) as unknown) : null;
  const p = (payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {}) as Record<string, unknown>;
  const instructors = Array.isArray(p.instructors) ? (p.instructors as unknown[]) : [];

  const q = skill.trim().toLowerCase();
  const filtered = instructors.filter((x) => {
    if (!x || typeof x !== "object") return false;
    const o = x as Record<string, unknown>;
    const skills = Array.isArray(o.skills) ? (o.skills as unknown[]) : [];
    return skills.some((s) => typeof s === "string" && s.toLowerCase().includes(q));
  });

  return NextResponse.json({ asOfISO: new Date().toISOString(), data: filtered });
}

