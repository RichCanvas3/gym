import { NextResponse } from "next/server";
import { requirePrivyAuth, eoaAddressForPrivyDid } from "../../_lib/privy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = { baseName?: unknown };

function safeBaseName(v: unknown): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return "";
  if (!/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/i.test(s)) return "";
  return s;
}

function a2aAgentBaseUrl(): string {
  const u = String(process.env.A2A_AGENT_URL ?? "").trim();
  if (!u) throw new Error("Missing A2A_AGENT_URL");
  return u.replace(/\/+$/, "");
}

function a2aAdminKey(): string {
  const k = String(process.env.A2A_ADMIN_KEY ?? "").trim();
  if (!k) throw new Error("Missing A2A_ADMIN_KEY");
  return k;
}

async function upsertProfile(args: { accountAddress: string; eoaAddress: string | null; baseName: string }) {
  const base = a2aAgentBaseUrl();
  const adminKey = a2aAdminKey();
  const res = await fetch(`${base}/api/a2a/profile`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-key": adminKey },
    body: JSON.stringify({
      accountAddress: args.accountAddress,
      eoaAddress: args.eoaAddress,
      baseName: args.baseName,
    }),
  });
  const json = (await res.json().catch(() => ({}))) as unknown;
  if (!res.ok) throw new Error(`a2a_profile_upsert_failed:${res.status}:${JSON.stringify(json).slice(0, 200)}`);
  return json;
}

export async function POST(req: Request) {
  const auth = await requirePrivyAuth(req);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });

  const body = (await req.json().catch(() => null)) as Body | null;
  const baseName = safeBaseName(body?.baseName);
  if (!baseName) return NextResponse.json({ ok: false, error: "Invalid baseName" }, { status: 400 });

  const eoaAddress = await eoaAddressForPrivyDid(auth.did);
  const out = await upsertProfile({ accountAddress: auth.accountAddress, eoaAddress, baseName });
  return NextResponse.json({ ok: true, accountAddress: auth.accountAddress, eoaAddress, baseName, result: out });
}

