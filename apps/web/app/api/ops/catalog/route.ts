import { listCatalog } from "@climb-gym/ops";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const res = listCatalog();
  return NextResponse.json(res);
}

