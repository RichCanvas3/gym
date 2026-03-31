"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/components/auth/AuthProvider";

type Status =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; error: string };

export default function AgentRegisterClient() {
  const router = useRouter();
  const { ready, authenticated, getAccessToken, login } = useAuth();
  const [baseName, setBaseName] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  useEffect(() => {
    if (!ready) return;
    if (!authenticated) return;
    async function load() {
      setStatus({ kind: "loading" });
      try {
        const tok = await getAccessToken();
        const res = await fetch("/api/agentictrust/status", { headers: { authorization: `Bearer ${tok}` } });
        const json = (await res.json().catch(() => ({}))) as unknown;
        const rec = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
        const saved = typeof rec.savedBaseName === "string" ? rec.savedBaseName.trim() : "";
        if (saved) {
          setStatus({ kind: "saved" });
          router.replace("/chat");
          return;
        }
        setStatus({ kind: "idle" });
      } catch (e) {
        setStatus({ kind: "error", error: e instanceof Error ? e.message : String(e ?? "") });
      }
    }
    void load();
  }, [ready, authenticated, getAccessToken, router]);

  async function save() {
    setStatus({ kind: "saving" });
    try {
      const tok = await getAccessToken();
      if (!tok) throw new Error("Missing Privy access token");
      const res = await fetch("/api/agentictrust/register", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${tok}` },
        body: JSON.stringify({ baseName }),
      });
      const json = (await res.json().catch(() => ({}))) as unknown;
      if (!res.ok) {
        const rec = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
        const err = typeof rec.error === "string" ? rec.error : `HTTP ${res.status}`;
        throw new Error(err);
      }
      setStatus({ kind: "saved" });
      router.replace("/chat");
    } catch (e) {
      setStatus({ kind: "error", error: e instanceof Error ? e.message : String(e ?? "") });
    }
  }

  if (!ready) return <div className="mx-auto w-full max-w-2xl px-4 py-10 text-sm">Loading…</div>;

  if (!authenticated) {
    return (
      <div className="mx-auto w-full max-w-2xl px-4 py-10 text-sm">
        <div className="rounded-2xl border border-zinc-200 bg-white p-6 dark:border-white/10 dark:bg-zinc-950">
          <div className="text-base font-semibold">Register gym agent name</div>
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
          <div className="text-base font-semibold">Register gym agent name</div>
          <Link href="/chat" className="text-xs text-zinc-700 underline dark:text-zinc-300">
            Back to chat
          </Link>
        </div>
        <div className="mt-2 text-zinc-600 dark:text-zinc-400">
          Pick a base name. If you later register an on-chain agent, it should end with <span className="font-mono">-gym.8004-agent.eth</span>.
        </div>

        <div className="mt-4 flex items-center gap-2">
          <input
            value={baseName}
            onChange={(e) => setBaseName(e.target.value)}
            placeholder="e.g. barb"
            className="h-10 w-full rounded-xl border border-zinc-200 bg-white px-3 text-sm outline-none dark:border-white/10 dark:bg-zinc-950"
          />
          <button
            onClick={() => void save()}
            disabled={status.kind === "saving" || !baseName.trim()}
            className="h-10 shrink-0 rounded-xl bg-zinc-900 px-4 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
          >
            {status.kind === "saving" ? "Saving…" : "Save"}
          </button>
        </div>

        {status.kind === "error" ? <div className="mt-3 text-xs text-red-600 dark:text-red-400">{status.error}</div> : null}
      </div>
    </div>
  );
}

