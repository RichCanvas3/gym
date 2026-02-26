import { searchCoaches } from "@climb-gym/ops";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const skill = url.searchParams.get("skill") ?? "";

  if (!skill) {
    return NextResponse.json({ error: "Missing skill" }, { status: 400 });
  }

  const res = searchCoaches({ skillIdOrName: skill });
  return NextResponse.json(res);
}

