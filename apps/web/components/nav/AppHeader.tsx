"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useWaiver } from "@/components/waiver/WaiverProvider";
import { useCart } from "@/components/cart/CartProvider";
import { useReservations } from "@/components/reservations/ReservationsProvider";
import { CalendarDays, FileSignature, MessageCircle, ShoppingCart, UserCircle2 } from "lucide-react";

export function AppHeader() {
  const { waiver, clearWaiver } = useWaiver();
  const { lines, clear } = useCart();
  const { reservations, clearReservations } = useReservations();

  const cartCount = useMemo(() => lines.reduce((n, l) => n + (l.quantity || 0), 0), [lines]);
  const resCount = reservations.length;

  return (
    <div className="sticky top-0 z-20 border-b border-zinc-200 bg-white/80 backdrop-blur dark:border-white/10 dark:bg-black/60">
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3 px-4 py-3">
        <Link href="/" className="flex items-center gap-2 text-sm font-semibold tracking-tight">
          <CalendarDays className="h-4 w-4 text-zinc-700 dark:text-zinc-200" aria-hidden="true" />
          Climb Gym Copilot
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
          <Link
            href="/waiver"
            className="inline-flex h-9 items-center gap-2 rounded-xl border border-zinc-200 bg-white px-3 text-xs font-medium dark:border-white/10 dark:bg-zinc-950"
          >
            <FileSignature className="h-4 w-4" aria-hidden="true" />
            Waiver
          </Link>
        </div>

        <div className="hidden items-center gap-3 md:flex">
          <div className="flex items-center gap-2 rounded-xl border border-zinc-200 bg-white px-3 py-2 text-xs dark:border-white/10 dark:bg-zinc-950">
            <UserCircle2 className="h-4 w-4 text-zinc-600 dark:text-zinc-400" aria-hidden="true" />
            {waiver ? (
              <div className="min-w-0">
                <div className="truncate font-semibold">{waiver.participantName}</div>
                <div className="truncate font-mono text-[10px] text-zinc-500 dark:text-zinc-500">{waiver.accountAddress}</div>
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

          <button
            onClick={() => {
              clear();
              clearReservations();
              clearWaiver();
            }}
            className="h-9 rounded-xl border border-zinc-200 bg-white px-3 text-xs font-medium dark:border-white/10 dark:bg-zinc-950"
          >
            Log out
          </button>
        </div>
      </div>
    </div>
  );
}

