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
  if (Array.isArray(v.cartLines)) {
    session.cartLines = v.cartLines
      .map((x) => {
        if (!x || typeof x !== "object") return null;
        const o = x as Record<string, unknown>;
        const sku = typeof o.sku === "string" ? o.sku : "";
        const quantity = typeof o.quantity === "number" ? o.quantity : 1;
        if (!sku) return null;
        return { sku, quantity: Math.max(1, Math.floor(quantity)) };
      })
      .filter(Boolean) as Array<{ sku: string; quantity: number }>;
  }
  if (v.waiver && typeof v.waiver === "object") {
    const w = v.waiver as Record<string, unknown>;
    const id = typeof w.id === "string" ? w.id : "";
    const participantName = typeof w.participantName === "string" ? w.participantName : "";
    const participantEmail = typeof w.participantEmail === "string" ? w.participantEmail : "";
    const isMinor = typeof w.isMinor === "boolean" ? w.isMinor : false;
    if (id && participantName) {
      session.waiver = participantEmail
        ? { id, participantName, participantEmail, isMinor }
        : { id, participantName, isMinor };
    }
  }
  return session;
}

