import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const dateISO = url.searchParams.get("date") ?? undefined;
  const skillLevel = (url.searchParams.get("skillLevel") ?? undefined) as
    | "beginner"
    | "intermediate"
    | "advanced"
    | undefined;
  const type = (url.searchParams.get("type") ?? undefined) as "group" | "private" | undefined;

  const deploymentUrl = process.env.LANGGRAPH_DEPLOYMENT_URL ?? "";
  const apiKey = process.env.LANGSMITH_API_KEY ?? "";
  const assistantId = process.env.LANGGRAPH_ASSISTANT_ID ?? "gym";
  if (!deploymentUrl || !apiKey) {
    return NextResponse.json({ error: "Missing LANGGRAPH_DEPLOYMENT_URL or LANGSMITH_API_KEY" }, { status: 500 });
  }

  const msg = `__SCHED_CLASSES_SEARCH__:${JSON.stringify({ dateISO, skillLevel, type })}`;
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
  if (data && typeof data === "object") return NextResponse.json(data);
  const classes: unknown[] = [];

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

