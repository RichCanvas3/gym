"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useCart } from "@/components/cart/CartProvider";

type CatalogItem = {
  sku: string;
  name: string;
  category: string;
  description?: string;
  priceCents: number;
  currency: "USD";
  requiresFacilityAccess?: boolean;
};

type CatalogResponse = {
  data?: unknown;
};

type OpsResponse<T> = {
  data: T;
  asOfISO: string;
};

function formatUSD(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

export default function ShopPage() {
  const { lines, addLine, removeSku, clear } = useCart();
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const res = await fetch("/api/ops/catalog", { cache: "no-store" });
        const json = (await res.json().catch(() => ({}))) as CatalogResponse;
        const ops = json as OpsResponse<unknown>;
        const items = Array.isArray(ops?.data) ? (ops.data as unknown[]) : [];
        const normalized = items
          .map((x) => {
            if (!x || typeof x !== "object") return null;
            const o = x as Record<string, unknown>;
            const sku = typeof o.sku === "string" ? o.sku : "";
            const name = typeof o.name === "string" ? o.name : "";
            const category = typeof o.category === "string" ? o.category : "";
            const priceCents = typeof o.priceCents === "number" ? o.priceCents : NaN;
            const currency = o.currency === "USD" ? "USD" : "USD";
            const description = typeof o.description === "string" ? o.description : undefined;
            const requiresFacilityAccess =
              typeof o.requiresFacilityAccess === "boolean" ? o.requiresFacilityAccess : undefined;
            if (!sku || !name || !Number.isFinite(priceCents)) return null;
            return { sku, name, category, description, priceCents, currency, requiresFacilityAccess };
          })
          .filter(Boolean) as CatalogItem[];
        if (!cancelled) setCatalog(normalized);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const cartCount = useMemo(() => lines.reduce((sum, l) => sum + l.quantity, 0), [lines]);

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900 dark:bg-black dark:text-zinc-50">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-10">
        <header className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Shop</h1>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Memberships, drop-in access, programs, lessons, and rentals.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/chat"
              className="h-10 rounded-xl border border-zinc-200 px-3 text-sm font-medium leading-10 dark:border-white/10"
            >
              Chat
            </Link>
            <Link
              href="/cart"
              className="h-10 rounded-xl bg-zinc-900 px-3 text-sm font-medium leading-10 text-white dark:bg-white dark:text-black"
            >
              Cart ({cartCount})
            </Link>
          </div>
        </header>

        <main className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {loading ? (
            <div className="rounded-2xl border border-zinc-200 bg-white p-4 text-sm dark:border-white/10 dark:bg-zinc-950">
              Loading…
            </div>
          ) : (
            catalog.map((p) => (
              <div
                key={p.sku}
                className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-white/10 dark:bg-zinc-950"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex flex-col gap-1">
                    <div className="text-sm font-semibold">{p.name}</div>
                    <div className="text-xs text-zinc-600 dark:text-zinc-400">{p.sku}</div>
                  </div>
                  <div className="text-sm font-semibold">{formatUSD(p.priceCents)}</div>
                </div>
                {p.description ? (
                  <p className="mt-3 text-sm leading-6 text-zinc-700 dark:text-zinc-300">
                    {p.description}
                  </p>
                ) : null}
                {p.requiresFacilityAccess ? (
                  <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
                    Requires facility access (day pass or membership).
                  </p>
                ) : null}
                <div className="mt-4 flex gap-2">
                  <button
                    onClick={() => addLine({ sku: p.sku, quantity: 1 })}
                    className="h-10 rounded-xl bg-zinc-900 px-3 text-sm font-medium text-white dark:bg-white dark:text-black"
                  >
                    Add
                  </button>
                  <button
                    onClick={() => removeSku(p.sku)}
                    className="h-10 rounded-xl border border-zinc-200 px-3 text-sm font-medium dark:border-white/10"
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))
          )}
        </main>

        <footer className="flex items-center justify-between">
          <button
            onClick={() => clear()}
            className="h-10 rounded-xl border border-zinc-200 px-3 text-sm font-medium dark:border-white/10"
          >
            Clear cart
          </button>
          <Link href="/" className="text-sm text-zinc-600 underline dark:text-zinc-400">
            Home
          </Link>
        </footer>
      </div>
    </div>
  );
}

