import { NextResponse } from "next/server";
import { requirePrivyAuth, telegramUserIdForPrivyDid } from "../../../_lib/privy";
import { mcpToolCall } from "../../../_lib/mcp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  code?: unknown;
  redirectUri?: unknown;
};

export async function POST(req: Request) {
  const auth = await requirePrivyAuth(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const body = (await req.json().catch(() => null)) as Body | null;
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  if (!code) return NextResponse.json({ error: "Missing code" }, { status: 400 });

  const tgUserId = await telegramUserIdForPrivyDid(auth.did);
  if (!tgUserId) return NextResponse.json({ error: "Telegram not linked for this Privy user." }, { status: 400 });

  const url = new URL(req.url);
  const redirectUri =
    typeof body?.redirectUri === "string" && body.redirectUri.trim()
      ? body.redirectUri.trim()
      : `${url.origin}/strava/connect`;

  const out = await mcpToolCall("strava", "strava_connect", { telegramUserId: tgUserId, code, redirectUri });

  // Best-effort: also attach Strava athlete profile to gym-core for this user.
  // Canonical user id design decision: use tg:<telegramUserId> as the core canonicalAddress.
  try {
    const athlete = out?.athlete;
    const athleteId = athlete && typeof athlete === "object" && athlete !== null && "id" in athlete ? String((athlete as any).id) : "";
    await mcpToolCall("core", "core_upsert_external_profile", {
      canonicalAddress: `tg:${tgUserId}`,
      provider: "strava",
      ...(athleteId ? { externalUserId: athleteId } : {}),
      profile: athlete ?? null,
    });
  } catch {
    // ignore — Strava connect should still succeed even if core isn't configured in MCP_SERVERS_JSON
  }

  return NextResponse.json(out);
}

