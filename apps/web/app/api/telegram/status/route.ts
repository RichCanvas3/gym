import { NextResponse } from "next/server";
import { requirePrivyAuth } from "../../_lib/privy";
import { mcpToolCall } from "../../_lib/mcp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await requirePrivyAuth(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  try {
    const st = await mcpToolCall("telegram", "telegram_link_status", { accountAddress: auth.accountAddress });
    // Best-effort: persist mapping in core external identities (like Strava/GCal).
    try {
      const rec = st && typeof st === "object" ? (st as Record<string, unknown>) : {};
      const linked = rec.linked === true;
      const telegramUserId = typeof rec.telegramUserId === "string" && rec.telegramUserId.trim() ? rec.telegramUserId.trim() : "";
      const chatId = typeof rec.chatId === "string" && rec.chatId.trim() ? rec.chatId.trim() : "";
      if (linked && telegramUserId) {
        await mcpToolCall("core", "core_upsert_external_profile", {
          canonicalAddress: auth.accountAddress,
          provider: "telegram",
          externalUserId: telegramUserId,
          profile: { chatId: chatId || null },
        });
      }
    } catch {
      // ignore
    }
    return NextResponse.json(st);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e ?? "");
    const hint =
      msg.includes("Missing MCP_SERVERS_JSON") ||
      msg.includes('MCP server "telegram" missing url in MCP_SERVERS_JSON')
        ? 'Set MCP_SERVERS_JSON to include {"telegram":{"url":"https://<telegram-mcp>/mcp","headers":{"x-api-key":"${TELEGRAM_MCP_API_KEY}"}}} and redeploy.'
        : msg.includes("Unauthorized")
          ? "Your telegram MCP URL is reachable but auth failed. Ensure MCP_SERVERS_JSON.telegram.headers.x-api-key matches telegram-mcp MCP_API_KEY."
          : msg.includes("Unexpected MCP SSE") || msg.includes("Not Found")
            ? 'Your telegram MCP URL is probably missing the `/mcp` suffix (it must end with `/mcp`).'
            : undefined;
    return NextResponse.json({ error: "telegram_status_failed", detail: msg, ...(hint ? { hint } : {}) }, { status: 502 });
  }
}

