import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ToolCallResponse = { result?: { content?: Array<{ type?: unknown; text?: unknown }> } };

function extractSseDataLine(raw: string): string {
  // Same pattern as /api/weather/hourly: pull the last "data: {...}" line.
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith("data: ")) return line.slice("data: ".length).trim();
  }
  return "";
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const dateISO = url.searchParams.get("date") ?? undefined;
  const skillLevel = (url.searchParams.get("skillLevel") ?? undefined) as
    | "beginner"
    | "intermediate"
    | "advanced"
    | undefined;
  const type = (url.searchParams.get("type") ?? undefined) as "group" | "private" | undefined;

  const mcpUrl = process.env.SCHEDULING_MCP_URL ?? "";
  const mcpKey = process.env.SCHEDULING_MCP_API_KEY ?? "";
  if (!mcpUrl || !mcpKey) {
    return NextResponse.json({ error: "Missing SCHEDULING_MCP_URL or SCHEDULING_MCP_API_KEY" }, { status: 500 });
  }

  const fromISO = dateISO ? `${dateISO}T00:00:00.000Z` : undefined;
  const toISO = dateISO ? `${dateISO}T23:59:59.999Z` : undefined;

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
        name: "schedule_list_classes",
        arguments: { fromISO, toISO, type },
      },
    }),
  });

  const raw = await res.text();
  if (!res.ok) {
    return NextResponse.json({ error: "Scheduling MCP error", detail: raw }, { status: 502 });
  }

  const dataLine = extractSseDataLine(raw);
  const parsed = (JSON.parse(dataLine) as ToolCallResponse) ?? {};
  const txt = parsed?.result?.content?.find((c) => c?.type === "text")?.text;
  const payload = typeof txt === "string" ? (JSON.parse(txt) as unknown) : null;
  const p = (payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {}) as Record<string, unknown>;
  const classes = Array.isArray(p.classes) ? (p.classes as unknown[]) : [];

  const mapped = classes
    .map((x) => {
      if (!x || typeof x !== "object") return null;
      const o = x as Record<string, unknown>;
      const id = typeof o.classId === "string" ? o.classId : "";
      const title = typeof o.title === "string" ? o.title : "";
      const type = o.type === "group" || o.type === "private" ? o.type : null;
      const startTimeISO = typeof o.startTimeISO === "string" ? o.startTimeISO : "";
      const durationMinutes = typeof o.durationMinutes === "number" ? o.durationMinutes : NaN;
      const capacity = typeof o.capacity === "number" ? o.capacity : NaN;
      const coachId = typeof o.instructorId === "string" ? o.instructorId : "";
      const skillLevel =
        o.skillLevel === "beginner" || o.skillLevel === "intermediate" || o.skillLevel === "advanced"
          ? o.skillLevel
          : "beginner";
      if (!id || !title || !type || !startTimeISO) return null;
      if (!Number.isFinite(durationMinutes) || !Number.isFinite(capacity)) return null;
      return { id, title, type, skillLevel, coachId, startTimeISO, durationMinutes, capacity };
    })
    .filter(Boolean) as Array<{
    id: string;
    title: string;
    type: "group" | "private";
    skillLevel: "beginner" | "intermediate" | "advanced";
    coachId: string;
    startTimeISO: string;
    durationMinutes: number;
    capacity: number;
  }>;

  const filtered = mapped.filter((o) => (skillLevel ? o.skillLevel === skillLevel : true));

  return NextResponse.json({ asOfISO: new Date().toISOString(), data: filtered });
}

