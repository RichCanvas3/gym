import { runGymAssistant } from "@climb-gym/agent";
import type { GymAssistantSession } from "@climb-gym/agent";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as
    | { message?: unknown; session?: unknown }
    | null;

  const message = typeof body?.message === "string" ? body.message : "";
  const session = parseSession(body?.session);

  if (!message.trim()) {
    return NextResponse.json({ error: "Missing message" }, { status: 400 });
  }

  const result = await runGymAssistant({ message, session });
  return NextResponse.json(result);
}

function parseSession(value: unknown): GymAssistantSession | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  const session: GymAssistantSession = {};
  if (typeof v.gymName === "string") session.gymName = v.gymName;
  if (typeof v.timezone === "string") session.timezone = v.timezone;
  if (typeof v.userName === "string") session.userName = v.userName;
  if (typeof v.userGoals === "string") session.userGoals = v.userGoals;
  return session;
}

