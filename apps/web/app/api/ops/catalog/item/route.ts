import { getCatalogItem } from "@climb-gym/ops";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const sku = url.searchParams.get("sku") ?? "";
  if (!sku) return NextResponse.json({ error: "Missing sku" }, { status: 400 });
  const res = getCatalogItem({ sku });
  return NextResponse.json(res);
}

