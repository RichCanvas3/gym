import { getClassAvailability } from "@climb-gym/ops";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const classId = url.searchParams.get("classId") ?? "";

  if (!classId) {
    return NextResponse.json({ error: "Missing classId" }, { status: 400 });
  }

  const res = getClassAvailability({ classId });
  return NextResponse.json(res);
}

