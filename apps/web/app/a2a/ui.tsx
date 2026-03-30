"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/components/auth/AuthProvider";

type Status =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; detail: unknown }
  | { kind: "error"; error: string; detail?: unknown };

function handleBaseDomain(): string {
  return String(process.env.NEXT_PUBLIC_A2A_HANDLE_BASE_DOMAIN ?? "").trim();
}

export default function A2AClient() {
  const { ready, authenticated, getAccessToken, login } = useAuth();
  const [handle, setHandle] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const suffix = handleBaseDomain();
  const endpoint = useMemo(() => {
    const h = handle.trim().toLowerCase();
    if (!h || !suffix) return "";
    return `https://${h}.${suffix}/api/a2a`;
  }, [handle, suffix]);

  async function save() {
    setStatus({ kind: "saving" });
    try {
      const tok = await getAccessToken();
      if (!tok) throw new Error("Missing Privy access token");
      const res = await fetch("/api/a2a/handle", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${tok}` },
        body: JSON.stringify({ handle }),
      });
      const json = (await res.json().catch(() => ({}))) as unknown;
      if (!res.ok) {
        const j = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
        const msg = typeof j?.error === "string" ? String(j.error) : `HTTP ${res.status}`;
        setStatus({ kind: "error", error: msg, detail: json });
        return;
      }
      setStatus({ kind: "saved", detail: json });
    } catch (e) {
      setStatus({ kind: "error", error: e instanceof Error ? e.message : String(e ?? "") });
    }
  }

  if (!ready) return <div className="mx-auto w-full max-w-2xl px-4 py-10 text-sm">Loading…</div>;

  if (!authenticated) {
    return (
      <div className="mx-auto w-full max-w-2xl px-4 py-10 text-sm">
        <div className="rounded-2xl border border-zinc-200 bg-white p-6 dark:border-white/10 dark:bg-zinc-950">
          <div className="text-base font-semibold">A2A endpoint</div>
          <div className="mt-2 text-zinc-600 dark:text-zinc-400">Sign in with Privy first.</div>
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
        <div className="flex items-center justify-between gap-3">
          <div className="text-base font-semibold">A2A endpoint</div>
          <Link href="/chat" className="text-xs text-zinc-700 underline dark:text-zinc-300">
            Back to chat
          </Link>
        </div>

        <div className="mt-3 text-xs text-zinc-600 dark:text-zinc-400">
          Choose a handle (subdomain). This maps <span className="font-mono">{`<handle>.${suffix || "<base-domain>"}`}</span> to your
          Privy account.
        </div>

        <div className="mt-3 flex items-center gap-2">
          <input
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            placeholder="handle (e.g. barb)"
            className="h-10 w-full rounded-xl border border-zinc-200 bg-white px-3 text-sm outline-none dark:border-white/10 dark:bg-zinc-950"
          />
          <button
            disabled={status.kind === "saving"}
            onClick={() => void save()}
            className="h-10 shrink-0 rounded-xl bg-zinc-900 px-4 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
          >
            {status.kind === "saving" ? "Saving…" : "Save"}
          </button>
        </div>

        {endpoint ? (
          <div className="mt-3 rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-xs dark:border-white/10 dark:bg-black/40">
            Endpoint: <span className="font-mono">{endpoint}</span>
          </div>
        ) : (
          <div className="mt-3 text-xs text-zinc-600 dark:text-zinc-400">
            Set <span className="font-mono">NEXT_PUBLIC_A2A_HANDLE_BASE_DOMAIN</span> to show the full URL.
          </div>
        )}

        {status.kind === "error" ? <div className="mt-3 text-xs text-red-600 dark:text-red-400">{status.error}</div> : null}
        {status.kind === "saved" ? (
          <div className="mt-3 text-xs text-emerald-700 dark:text-emerald-400">Saved.</div>
        ) : null}

        {status.kind === "saved" ? (
          <pre className="mt-3 max-h-80 overflow-auto rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-[11px] dark:border-white/10 dark:bg-black/40">
            {JSON.stringify(status.detail, null, 2)}
          </pre>
        ) : null}
      </div>
    </div>
  );
}

