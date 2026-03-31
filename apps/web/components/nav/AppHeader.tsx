"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { useCart } from "@/components/cart/CartProvider";
import { useReservations } from "@/components/reservations/ReservationsProvider";
import { CalendarDays, MessageCircle, ShoppingCart, UserCircle2 } from "lucide-react";

function extractTelegramUserId(user: unknown): string | null {
  if (!user || typeof user !== "object") return null;
  const u = user as Record<string, unknown>;
  const tg = u.telegram && typeof u.telegram === "object" ? (u.telegram as Record<string, unknown>) : null;
  const directCandidates: unknown[] = [
    tg?.telegram_user_id,
    tg?.telegramUserId,
    tg?.telegram_userId,
    tg?.telegramUserID,
  ];
  for (const c of directCandidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
    if (typeof c === "number" && Number.isFinite(c)) return String(c);
  }

  const linked = (u.linkedAccounts ?? (u as Record<string, unknown>).linked_accounts) as unknown;
  if (Array.isArray(linked)) {
    for (const a of linked) {
      if (!a || typeof a !== "object") continue;
      const acc = a as Record<string, unknown>;
      const accountType = (acc as Record<string, unknown>).accountType;
      const type = typeof acc.type === "string" ? acc.type : typeof accountType === "string" ? accountType : "";
      if (type !== "telegram") continue;
      const idCandidates: unknown[] = [
        acc.telegram_user_id,
        (acc as Record<string, unknown>).telegramUserId,
        (acc as Record<string, unknown>).telegram_userId,
      ];
      for (const c of idCandidates) {
        if (typeof c === "string" && c.trim()) return c.trim();
        if (typeof c === "number" && Number.isFinite(c)) return String(c);
      }
    }
  }
  return null;
}

export function AppHeader() {
  const { authenticated, accountAddress, user, login, logout, getAccessToken } = useAuth();
  const { lines, clear } = useCart();
  const { reservations, clearReservations } = useReservations();

  const cartCount = useMemo(() => lines.reduce((n, l) => n + (l.quantity || 0), 0), [lines]);
  const resCount = reservations.length;
  const telegramUserId = useMemo(() => extractTelegramUserId(user), [user]);
  const [stravaConnected, setStravaConnected] = useState<boolean | null>(null);
  const [googleCalendarConnected, setGoogleCalendarConnected] = useState<boolean | null>(null);
  const [telegramConnected, setTelegramConnected] = useState<boolean | null>(null);
  const [telegramLinkedUserId, setTelegramLinkedUserId] = useState<string | null>(null);
  const [gymAgentBaseName, setGymAgentBaseName] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!authenticated) {
        if (!cancelled) setStravaConnected(null);
        return;
      }
      try {
        const tok = await getAccessToken();
        const res = await fetch("/api/strava/status", { headers: { authorization: `Bearer ${tok}` } });
        const j = await res.json().catch(() => ({}));
        const connected = Boolean(j?.connected === true);
        if (!cancelled) setStravaConnected(connected);
      } catch {
        if (!cancelled) setStravaConnected(null);
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [authenticated, getAccessToken]);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!authenticated) {
        if (!cancelled) setGoogleCalendarConnected(null);
        return;
      }
      try {
        const tok = await getAccessToken();
        const res = await fetch("/api/googlecalendar/status", { headers: { authorization: `Bearer ${tok}` } });
        const j = await res.json().catch(() => ({}));
        const connected = Boolean(j?.connected === true);
        if (!cancelled) setGoogleCalendarConnected(connected);
      } catch {
        if (!cancelled) setGoogleCalendarConnected(null);
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [authenticated, getAccessToken]);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!authenticated) {
        if (!cancelled) {
          setTelegramConnected(null);
          setTelegramLinkedUserId(null);
        }
        return;
      }
      try {
        const tok = await getAccessToken();
        const res = await fetch("/api/telegram/status", { headers: { authorization: `Bearer ${tok}` } });
        const j = (await res.json().catch(() => ({}))) as unknown;
        const rec = j && typeof j === "object" ? (j as Record<string, unknown>) : {};
        const connected = rec.linked === true;
        const v = rec.telegramUserId;
        const tg = connected && typeof v === "string" && v.trim() ? v.trim() : null;
        if (!cancelled) {
          setTelegramConnected(connected);
          setTelegramLinkedUserId(tg);
        }
      } catch {
        if (!cancelled) {
          setTelegramConnected(null);
          setTelegramLinkedUserId(null);
        }
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [authenticated, getAccessToken]);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!authenticated) {
        if (!cancelled) setGymAgentBaseName(null);
        return;
      }
      try {
        const tok = await getAccessToken();
        const res = await fetch("/api/agentictrust/status", { headers: { authorization: `Bearer ${tok}` } });
        const j = (await res.json().catch(() => ({}))) as unknown;
        const rec = j && typeof j === "object" ? (j as Record<string, unknown>) : {};
        const v = rec.savedBaseName;
        const name = typeof v === "string" && v.trim() ? v.trim() : null;
        if (!cancelled) setGymAgentBaseName(name);
      } catch {
        if (!cancelled) setGymAgentBaseName(null);
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [authenticated, getAccessToken]);

  return (
    <div className="sticky top-0 z-20 border-b border-zinc-200 bg-white/80 backdrop-blur dark:border-white/10 dark:bg-black/60">
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3 px-4 py-3">
        <Link href="/" className="flex items-center gap-2 text-sm font-semibold tracking-tight">
          <CalendarDays className="h-4 w-4 text-zinc-700 dark:text-zinc-200" aria-hidden="true" />
          Erie Rec Center Copilot
        </Link>

        <div className="flex items-center gap-2">
          <Link
            href="/calendar"
            className="inline-flex h-9 items-center gap-2 rounded-xl border border-zinc-200 bg-white px-3 text-xs font-medium dark:border-white/10 dark:bg-zinc-950"
          >
            <CalendarDays className="h-4 w-4" aria-hidden="true" />
            Calendar
          </Link>
          <Link
            href="/shop"
            className="inline-flex h-9 items-center gap-2 rounded-xl border border-zinc-200 bg-white px-3 text-xs font-medium dark:border-white/10 dark:bg-zinc-950"
          >
            <ShoppingCart className="h-4 w-4" aria-hidden="true" />
            Shop
            {cartCount ? (
              <span className="ml-1 rounded-full bg-zinc-900 px-2 py-0.5 text-[10px] font-semibold text-white dark:bg-white dark:text-black">
                {cartCount}
              </span>
            ) : null}
          </Link>
          <Link
            href="/chat"
            className="inline-flex h-9 items-center gap-2 rounded-xl border border-zinc-200 bg-white px-3 text-xs font-medium dark:border-white/10 dark:bg-zinc-950"
          >
            <MessageCircle className="h-4 w-4" aria-hidden="true" />
            Chat
          </Link>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 rounded-xl border border-zinc-200 bg-white px-3 py-2 text-xs dark:border-white/10 dark:bg-zinc-950">
            <UserCircle2 className="h-4 w-4 text-zinc-600 dark:text-zinc-400" aria-hidden="true" />
            {authenticated && accountAddress ? (
              <div className="min-w-0">
                <div className="truncate font-semibold">Signed in</div>
                <div className="truncate font-mono text-[10px] text-zinc-500 dark:text-zinc-500">{accountAddress}</div>
                {gymAgentBaseName ? (
                  <div className="truncate font-mono text-[10px] text-zinc-500 dark:text-zinc-500">
                    {`gym:${gymAgentBaseName}`}
                  </div>
                ) : null}
                {telegramLinkedUserId || telegramUserId ? (
                  <div className="truncate font-mono text-[10px] text-zinc-500 dark:text-zinc-500">
                    {telegramLinkedUserId ? `tg:${telegramLinkedUserId}` : `tg:${telegramUserId}`}
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="text-zinc-600 dark:text-zinc-400">Not signed in</div>
            )}
            {resCount ? (
              <span className="ml-2 rounded-full bg-emerald-600 px-2 py-0.5 text-[10px] font-semibold text-white">
                {resCount} reserved
              </span>
            ) : null}
          </div>

          {authenticated ? (
            <div className="flex items-center gap-2">
              <Link
                href="/strava/connect"
                className="h-9 rounded-xl border border-zinc-200 bg-white px-3 text-xs font-medium dark:border-white/10 dark:bg-zinc-950 inline-flex items-center"
              >
                {stravaConnected ? "Strava connected" : "Connect Strava"}
              </Link>
              <Link
                href="/googlecalendar/connect"
                className="h-9 rounded-xl border border-zinc-200 bg-white px-3 text-xs font-medium dark:border-white/10 dark:bg-zinc-950 inline-flex items-center"
              >
                {googleCalendarConnected ? "GCal connected" : "Connect GCal"}
              </Link>
              <Link
                href="/telegram/connect"
                className="h-9 rounded-xl border border-zinc-200 bg-white px-3 text-xs font-medium dark:border-white/10 dark:bg-zinc-950 inline-flex items-center"
              >
                {telegramConnected ? "Telegram connected" : "Connect Telegram"}
              </Link>
            </div>
          ) : null}

          <button
            onClick={async () => {
              clear();
              clearReservations();
              if (authenticated) {
                try {
                  const tok = await getAccessToken();
                  await Promise.allSettled([
                    fetch("/api/strava/disconnect", { method: "POST", headers: { authorization: `Bearer ${tok}` } }),
                    fetch("/api/googlecalendar/disconnect", { method: "POST", headers: { authorization: `Bearer ${tok}` } }),
                    fetch("/api/telegram/disconnect", { method: "POST", headers: { authorization: `Bearer ${tok}` } }),
                  ]);
                } catch {
                  // ignore
                }
                logout();
              } else {
                login();
              }
            }}
            className="h-9 rounded-xl border border-zinc-200 bg-white px-3 text-xs font-medium dark:border-white/10 dark:bg-zinc-950"
          >
            {authenticated ? "Log out" : "Log in"}
          </button>
        </div>
      </div>
    </div>
  );
}

