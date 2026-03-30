"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";

type Status =
  | { ok: true; linked: boolean; accountAddress: string; telegramUserId: string | null; chatId: string | null; linkedAtISO: string | null }
  | { error: string; detail?: unknown };

export function TelegramConnectClient() {
  const { authenticated, getAccessToken } = useAuth();
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    if (!authenticated) {
      setStatus({ error: "not_authenticated" });
      return;
    }
    const tok = await getAccessToken();
    const res = await fetch("/api/telegram/status", { headers: { authorization: `Bearer ${tok}` } });
    const j = (await res.json().catch(() => ({}))) as Status;
    setStatus(j);
  }

  async function startConnect() {
    if (!authenticated) return;
    setBusy(true);
    try {
      const tok = await getAccessToken();
      const res = await fetch("/api/telegram/oauth/start", { method: "POST", headers: { authorization: `Bearer ${tok}` } });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; startUrl?: string };
      if (j?.startUrl) {
        window.location.href = j.startUrl;
        return;
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticated]);

  const linked = Boolean(status && "ok" in status && status.ok === true && status.linked === true);

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-10">
      <h1 className="text-xl font-semibold tracking-tight">Connect Telegram</h1>
      <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
        This links your Privy account to a Telegram chat so the app can message you via the bot.
      </p>

      <div className="mt-6 rounded-2xl border border-zinc-200 bg-white p-4 dark:border-white/10 dark:bg-zinc-950">
        <div className="text-xs text-zinc-500 dark:text-zinc-500">Status</div>
        <div className="mt-1 text-sm font-medium">
          {!authenticated ? "Not signed in" : linked ? "Connected" : "Not connected"}
        </div>
        {authenticated ? (
          <div className="mt-3 flex items-center gap-2">
            <button
              onClick={startConnect}
              disabled={busy}
              className="h-9 rounded-xl border border-zinc-200 bg-white px-3 text-xs font-medium dark:border-white/10 dark:bg-zinc-950 disabled:opacity-60"
            >
              {linked ? "Reconnect Telegram" : "Connect Telegram"}
            </button>
            <button
              onClick={refresh}
              disabled={busy}
              className="h-9 rounded-xl border border-zinc-200 bg-white px-3 text-xs font-medium dark:border-white/10 dark:bg-zinc-950 disabled:opacity-60"
            >
              Refresh
            </button>
          </div>
        ) : null}

        <div className="mt-4 text-xs text-zinc-600 dark:text-zinc-400">
          After you tap Connect, Telegram will open. Press Start in the bot chat, then come back here and hit Refresh.
        </div>
      </div>
    </div>
  );
}

