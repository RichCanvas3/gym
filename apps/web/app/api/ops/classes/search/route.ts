import { searchClasses } from "@climb-gym/ops";
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

  const res = searchClasses({ dateISO, skillLevel, type });
  return NextResponse.json(res);
}

