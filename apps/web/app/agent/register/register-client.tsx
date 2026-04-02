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

type Availability =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available"; fullName: string }
  | { kind: "taken"; fullName: string }
  | { kind: "invalid" }
  | { kind: "error"; error: string };

export default function AgentRegisterClient() {
  const router = useRouter();
  const { ready, authenticated, accountAddress, getAccessToken, login } = useAuth();
  const [baseName, setBaseName] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [availability, setAvailability] = useState<Availability>({ kind: "idle" });

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
        const pending = typeof rec.pendingBaseName === "string" ? rec.pendingBaseName.trim() : "";
        if (pending) setBaseName((prev) => prev || pending);
        setStatus({ kind: "idle" });
      } catch (e) {
        setStatus({ kind: "error", error: e instanceof Error ? e.message : String(e ?? "") });
      }
    }
    void load();
  }, [ready, authenticated, getAccessToken, router]);

  useEffect(() => {
    if (!ready || !authenticated) return;
    const s = baseName.trim();
    if (!s) {
      setAvailability({ kind: "idle" });
      return;
    }
    if (!/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/i.test(s)) {
      setAvailability({ kind: "invalid" });
      return;
    }

    let cancelled = false;
    const t = setTimeout(() => {
      void (async () => {
        setAvailability({ kind: "checking" });
        try {
          const tok = await getAccessToken();
          if (!tok) throw new Error("Missing Privy access token");
          const res = await fetch(`/api/agentictrust/register?baseName=${encodeURIComponent(s)}`, {
            headers: { authorization: `Bearer ${tok}` },
          });
          const json = (await res.json().catch(() => ({}))) as unknown;
          if (!res.ok) {
            const rec = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
            const err = typeof rec.error === "string" ? rec.error : `HTTP ${res.status}`;
            throw new Error(err);
          }
          const rec = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
          const available = rec.available === true;
          const fullName = typeof rec.fullName === "string" ? rec.fullName : `${s}-gym.8004-agent.eth`;
          if (cancelled) return;
          setAvailability(available ? { kind: "available", fullName } : { kind: "taken", fullName });
        } catch (e) {
          if (cancelled) return;
          setAvailability({ kind: "error", error: e instanceof Error ? e.message : String(e ?? "") });
        }
      })();
    }, 350);

    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [baseName, ready, authenticated, getAccessToken]);

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
      setBaseName(baseName.trim());
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
          Enter a new base name. `Register` appears only when{" "}
          <span className="font-mono">-gym.8004-agent.eth</span>.
        </div>

        <div className="mt-4 flex items-center gap-2">
          <input
            value={baseName}
            onChange={(e) => setBaseName(e.target.value)}
            placeholder="e.g. barb"
            className="h-10 w-full rounded-xl border border-zinc-200 bg-white px-3 text-sm outline-none dark:border-white/10 dark:bg-zinc-950"
          />
          {availability.kind === "available" ? (
            <button
              onClick={() => void save()}
              disabled={status.kind === "saving"}
              className="h-10 shrink-0 rounded-xl bg-zinc-900 px-4 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
            >
              {status.kind === "saving" ? "Registering…" : "Register"}
            </button>
          ) : null}
        </div>

        {availability.kind === "checking" ? <div className="mt-3 text-xs text-zinc-500">Checking name…</div> : null}
        {availability.kind === "invalid" ? (
          <div className="mt-3 text-xs text-red-600 dark:text-red-400">Use letters, numbers, and hyphens only.</div>
        ) : null}
        {availability.kind === "taken" ? (
          <div className="mt-3 text-xs text-amber-600 dark:text-amber-400">{availability.fullName} already exists.</div>
        ) : null}
        {availability.kind === "available" ? (
          <div className="mt-3 text-xs text-emerald-600 dark:text-emerald-400">{availability.fullName} was not found. You can register it.</div>
        ) : null}
        {status.kind === "saved" ? (
          <div className="mt-3 text-xs text-zinc-600 dark:text-zinc-400">
            Name saved. You will stay here until discovery finds a valid <span className="font-mono">-gym.8004-agent.eth</span> agent.
          </div>
        ) : null}
        {availability.kind === "error" ? <div className="mt-3 text-xs text-red-600 dark:text-red-400">{availability.error}</div> : null}
        {status.kind === "error" ? <div className="mt-3 text-xs text-red-600 dark:text-red-400">{status.error}</div> : null}
      </div>
    </div>
  );
}

