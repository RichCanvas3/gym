"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/components/auth/AuthProvider";

type Status =
  | { kind: "idle" }
  | { kind: "redirecting" }
  | { kind: "exchanging" }
  | { kind: "ok"; detail: unknown }
  | { kind: "error"; error: string };

export default function StravaConnectClient() {
  const { ready, authenticated, getAccessToken, login } = useAuth();
  const sp = useSearchParams();
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const ranForCodeRef = useRef<string>("");

  const code = useMemo(() => (sp?.get("code") ?? "").trim(), [sp]);
  const redirectUri = useMemo(() => (typeof window !== "undefined" ? `${window.location.origin}/strava/connect` : ""), []);

  async function disconnect() {
    const tok = await getAccessToken();
    if (!tok) throw new Error("Missing Privy access token");
    await fetch("/api/strava/disconnect", { method: "POST", headers: { authorization: `Bearer ${tok}` } });
    try {
      if (typeof window !== "undefined") window.sessionStorage.removeItem("strava_oauth_connected");
    } catch {
      // ignore
    }
    setStatus({ kind: "idle" });
  }

  useEffect(() => {
    if (!ready) return;
    if (!authenticated) return;
    if (status.kind === "ok") return;
    if (status.kind === "exchanging" || status.kind === "redirecting") return;

    async function run() {
      try {
        if (!code) {
          // If we already connected in this session, don't auto-redirect back to Strava.
          try {
            if (typeof window !== "undefined" && window.sessionStorage.getItem("strava_oauth_connected") === "1") {
              setStatus({ kind: "ok", detail: { ok: true, note: "Strava already connected (session)." } });
              return;
            }
          } catch {
            // ignore
          }

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

        // Dev mode can run effects twice; ensure we only exchange once per code.
        if (ranForCodeRef.current === code) return;
        ranForCodeRef.current = code;

        // Strava OAuth codes are single-use; avoid retrying the same code on refresh.
        const usedKey = `strava_oauth_used_code:${code}`;
        try {
          if (typeof window !== "undefined" && window.sessionStorage.getItem(usedKey) === "1") {
            throw new Error("This Strava OAuth code was already used. Reopen /strava/connect to restart the flow.");
          }
        } catch {
          // ignore storage failures
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
        try {
          if (typeof window !== "undefined") window.sessionStorage.setItem(usedKey, "1");
        } catch {
          // ignore
        }
        // Strip ?code= from the URL so refreshes don't reuse it.
        try {
          if (typeof window !== "undefined") window.history.replaceState({}, "", "/strava/connect");
        } catch {
          // ignore
        }
        try {
          if (typeof window !== "undefined") window.sessionStorage.setItem("strava_oauth_connected", "1");
        } catch {
          // ignore
        }
        setStatus({ kind: "ok", detail: json });
      } catch (e) {
        try {
          if (typeof window !== "undefined") window.history.replaceState({}, "", "/strava/connect");
        } catch {
          // ignore
        }
        const msg = e instanceof Error ? e.message : String(e ?? "");
        setStatus({ kind: "error", error: msg });
      }
    }

    void run();
  }, [ready, authenticated, code, redirectUri, getAccessToken, status.kind]);

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
        {status.kind === "ok" && code === "" ? (
          <button
            onClick={() => {
              try {
                if (typeof window !== "undefined") window.sessionStorage.removeItem("strava_oauth_connected");
              } catch {
                // ignore
              }
              window.location.href = "/strava/connect";
            }}
            className="mt-3 h-9 rounded-xl border border-zinc-200 bg-white px-3 text-xs font-medium dark:border-white/10 dark:bg-zinc-950"
          >
            Reconnect
          </button>
        ) : null}
        {status.kind === "redirecting" ? <div className="mt-2">Redirecting to Strava…</div> : null}
        {status.kind === "exchanging" ? <div className="mt-2">Finishing connection…</div> : null}
        {status.kind === "ok" ? (
          <div className="mt-2">
            <div className="font-semibold text-emerald-700 dark:text-emerald-400">Connected.</div>
            <pre className="mt-3 max-h-80 overflow-auto rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-[11px] dark:border-white/10 dark:bg-black/40">
              {JSON.stringify(status.detail, null, 2)}
            </pre>
            <div className="mt-3 flex items-center gap-2">
              <button
                onClick={async () => disconnect()}
                className="h-9 rounded-xl border border-zinc-200 bg-white px-3 text-xs font-medium dark:border-white/10 dark:bg-zinc-950"
              >
                Disconnect
              </button>
              <Link href="/chat" className="inline-flex text-xs font-medium underline">
                Back to chat
              </Link>
            </div>
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

