"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useAuth } from "@/components/auth/AuthProvider";

type Status =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "connected"; detail: unknown }
  | { kind: "not_connected"; detail: unknown }
  | { kind: "error"; error: string; detail?: unknown; hint?: unknown };

export default function GoogleCalendarConnectClient() {
  const { ready, authenticated, getAccessToken, login } = useAuth();
  const sp = useSearchParams();
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const connectedHint = (sp?.get("googleCalendar") ?? "").trim() === "connected";

  useEffect(() => {
    if (!ready) return;
    if (!authenticated) return;

    async function load() {
      try {
        setStatus({ kind: "loading" });
        const tok = await getAccessToken();
        if (!tok) throw new Error("Missing Privy access token");
        const res = await fetch("/api/googlecalendar/status", { headers: { authorization: `Bearer ${tok}` } });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          const err = typeof (json as any)?.error === "string" ? String((json as any).error) : "";
          const detail = (json as any)?.detail;
          const hint = (json as any)?.hint;
          const msg = err || `HTTP ${res.status}`;
          const extra = detail ? `\n${String(detail)}` : "";
          const extraHint = hint ? `\nHint: ${String(hint)}` : "";
          const e = new Error(`${msg}${extra}${extraHint}`.trim());
          (e as any).__detail__ = detail;
          (e as any).__hint__ = hint;
          throw e;
        }
        if (json?.connected === true) setStatus({ kind: "connected", detail: json });
        else setStatus({ kind: "not_connected", detail: json });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e ?? "");
        const detail = (e as any)?.__detail__;
        const hint = (e as any)?.__hint__;
        setStatus({ kind: "error", error: msg, ...(detail !== undefined ? { detail } : {}), ...(hint !== undefined ? { hint } : {}) });
      }
    }

    void load();
  }, [ready, authenticated, getAccessToken, connectedHint]);

  if (!ready) return <div className="mx-auto w-full max-w-2xl px-4 py-10 text-sm">Loading…</div>;

  if (!authenticated) {
    return (
      <div className="mx-auto w-full max-w-2xl px-4 py-10 text-sm">
        <div className="rounded-2xl border border-zinc-200 bg-white p-6 dark:border-white/10 dark:bg-zinc-950">
          <div className="text-base font-semibold">Connect Google Calendar</div>
          <div className="mt-2 text-zinc-600 dark:text-zinc-400">Sign in with Privy (Telegram) first.</div>
          <button
            onClick={() => login()}
            className="mt-4 h-9 rounded-xl border border-zinc-200 bg-white px-3 text-xs font-medium dark:border-white/10 dark:bg-zinc-950"
          >
            Log in
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-10 text-sm">
      <div className="rounded-2xl border border-zinc-200 bg-white p-6 dark:border-white/10 dark:bg-zinc-950">
        <div className="text-base font-semibold">Connect Google Calendar</div>

        {status.kind === "loading" ? <div className="mt-2">Checking connection…</div> : null}

        {status.kind === "connected" ? (
          <div className="mt-2">
            <div className="font-semibold text-emerald-700 dark:text-emerald-400">Connected.</div>
            <pre className="mt-3 max-h-80 overflow-auto rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-[11px] dark:border-white/10 dark:bg-black/40">
              {JSON.stringify(status.detail, null, 2)}
            </pre>
            <Link href="/chat" className="mt-4 inline-flex text-xs font-medium underline">
              Back to chat
            </Link>
          </div>
        ) : null}

        {status.kind === "not_connected" ? (
          <div className="mt-2">
            <div className="text-zinc-600 dark:text-zinc-400">Not connected.</div>
            <button
              onClick={async () => {
                const tok = await getAccessToken();
                if (!tok) return;
                window.location.href = "/api/googlecalendar/oauth/start";
              }}
              className="mt-3 h-9 rounded-xl border border-zinc-200 bg-white px-3 text-xs font-medium dark:border-white/10 dark:bg-zinc-950"
            >
              Connect
            </button>
          </div>
        ) : null}

        {status.kind === "error" ? (
          <div className="mt-2">
            <div className="font-semibold text-red-700 dark:text-red-400">Error</div>
            <div className="mt-1 font-mono text-[11px] text-zinc-700 dark:text-zinc-300">{status.error}</div>
            <button
              onClick={() => {
                window.location.href = "/api/googlecalendar/oauth/start";
              }}
              className="mt-3 h-9 rounded-xl border border-zinc-200 bg-white px-3 text-xs font-medium dark:border-white/10 dark:bg-zinc-950"
            >
              Try connect anyway
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

