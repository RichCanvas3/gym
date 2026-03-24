"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/components/auth/AuthProvider";

type Status =
  | { kind: "idle" }
  | { kind: "redirecting" }
  | { kind: "exchanging" }
  | { kind: "ok"; detail: any }
  | { kind: "error"; error: string };

export default function StravaConnectClient() {
  const { ready, authenticated, getAccessToken, login } = useAuth();
  const sp = useSearchParams();
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const code = useMemo(() => (sp?.get("code") ?? "").trim(), [sp]);
  const redirectUri = useMemo(() => (typeof window !== "undefined" ? `${window.location.origin}/strava/connect` : ""), []);

  useEffect(() => {
    if (!ready) return;
    if (!authenticated) return;

    async function run() {
      try {
        if (!code) {
          const clientId = (process.env.NEXT_PUBLIC_STRAVA_CLIENT_ID ?? "").trim();
          if (!clientId) throw new Error("Missing NEXT_PUBLIC_STRAVA_CLIENT_ID");
          setStatus({ kind: "redirecting" });
          const authUrl = new URL("https://www.strava.com/oauth/authorize");
          authUrl.searchParams.set("client_id", clientId);
          authUrl.searchParams.set("redirect_uri", redirectUri);
          authUrl.searchParams.set("response_type", "code");
          authUrl.searchParams.set("approval_prompt", "auto");
          authUrl.searchParams.set("scope", "read,activity:read_all,profile:read_all");
          window.location.href = authUrl.toString();
          return;
        }

        setStatus({ kind: "exchanging" });
        const tok = await getAccessToken();
        if (!tok) throw new Error("Missing Privy access token");
        const res = await fetch("/api/strava/oauth/exchange", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${tok}` },
          body: JSON.stringify({ code, redirectUri }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          const msg = typeof json?.error === "string" ? json.error : JSON.stringify(json).slice(0, 300);
          throw new Error(msg || `HTTP ${res.status}`);
        }
        setStatus({ kind: "ok", detail: json });
      } catch (e) {
        setStatus({ kind: "error", error: String((e as any)?.message ?? e) });
      }
    }

    void run();
  }, [ready, authenticated, code, redirectUri, getAccessToken]);

  if (!ready) {
    return <div className="mx-auto w-full max-w-2xl px-4 py-10 text-sm">Loading…</div>;
  }

  if (!authenticated) {
    return (
      <div className="mx-auto w-full max-w-2xl px-4 py-10 text-sm">
        <div className="rounded-2xl border border-zinc-200 bg-white p-6 dark:border-white/10 dark:bg-zinc-950">
          <div className="text-base font-semibold">Connect Strava</div>
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
        <div className="text-base font-semibold">Connect Strava</div>
        {status.kind === "redirecting" ? <div className="mt-2">Redirecting to Strava…</div> : null}
        {status.kind === "exchanging" ? <div className="mt-2">Finishing connection…</div> : null}
        {status.kind === "ok" ? (
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
        {status.kind === "error" ? (
          <div className="mt-2">
            <div className="font-semibold text-red-700 dark:text-red-400">Error</div>
            <div className="mt-1 font-mono text-[11px] text-zinc-700 dark:text-zinc-300">{status.error}</div>
          </div>
        ) : null}
        {status.kind === "idle" ? <div className="mt-2">Preparing…</div> : null}
      </div>
    </div>
  );
}

