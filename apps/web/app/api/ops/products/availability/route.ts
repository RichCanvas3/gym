import { getProductAvailability } from "@climb-gym/ops";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const sku = url.searchParams.get("sku") ?? "";
  const size = url.searchParams.get("size") ?? undefined;

  if (!sku) {
    return NextResponse.json({ error: "Missing sku" }, { status: 400 });
  }

  const res = getProductAvailability({ sku, size });
  return NextResponse.json(res);
}

