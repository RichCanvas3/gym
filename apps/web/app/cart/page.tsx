"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useCart } from "@/components/cart/CartProvider";
import { useAuth } from "@/components/auth/AuthProvider";

type CatalogItem = {
  sku: string;
  name: string;
  priceCents: number;
  currency: "USD";
};

type OpsResponse<T> = {
  data: T;
  asOfISO: string;
};

function formatUSD(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

export default function CartPage() {
  const { lines, removeSku, clear } = useCart();
  const { ready, authenticated, user, accountAddress, getAccessToken, login } = useAuth();
  const [catalogBySku, setCatalogBySku] = useState<Record<string, CatalogItem>>({});
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [checkoutMsg, setCheckoutMsg] = useState<string>("");
  const [clientTz, setClientTz] = useState<string>("America/Denver");

  useEffect(() => {
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (tz && typeof tz === "string") setClientTz(tz);
    } catch {
      // ignore
    }
  }, []);

  function extractEmail(u: unknown): string {
    if (!u || typeof u !== "object") return "";
    const o = u as any;
    const e1 = typeof o?.email?.address === "string" ? o.email.address : "";
    if (e1.trim()) return e1.trim();
    const e2 = typeof o?.google?.email === "string" ? o.google.email : "";
    if (e2.trim()) return e2.trim();
    const e3 = typeof o?.apple?.email === "string" ? o.apple.email : "";
    if (e3.trim()) return e3.trim();
    return "";
  }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const res = await fetch("/api/ops/catalog", { cache: "no-store" });
      const json = (await res.json().catch(() => ({}))) as unknown;
      const ops = json as OpsResponse<unknown>;
      const items = Array.isArray(ops?.data) ? (ops.data as unknown[]) : [];
      const map: Record<string, CatalogItem> = {};
      for (const x of items) {
        if (!x || typeof x !== "object") continue;
        const o = x as Record<string, unknown>;
        const sku = typeof o.sku === "string" ? o.sku : "";
        const name = typeof o.name === "string" ? o.name : "";
        const priceCents = typeof o.priceCents === "number" ? o.priceCents : NaN;
        if (!sku || !name || !Number.isFinite(priceCents)) continue;
        map[sku] = { sku, name, priceCents, currency: "USD" };
      }
      if (!cancelled) setCatalogBySku(map);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const totalCents = useMemo(() => {
    return lines.reduce((sum, l) => sum + (catalogBySku[l.sku]?.priceCents ?? 0) * l.quantity, 0);
  }, [lines, catalogBySku]);

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900 dark:bg-black dark:text-zinc-50">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-10">
        <header className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Cart</h1>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">Review items and checkout.</p>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/shop"
              className="h-10 rounded-xl border border-zinc-200 px-3 text-sm font-medium leading-10 dark:border-white/10"
            >
              Shop
            </Link>
            <Link
              href="/chat"
              className="h-10 rounded-xl border border-zinc-200 px-3 text-sm font-medium leading-10 dark:border-white/10"
            >
              Chat
            </Link>
          </div>
        </header>

        <main className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-white/10 dark:bg-zinc-950">
          {lines.length === 0 ? (
            <div className="text-sm text-zinc-600 dark:text-zinc-400">Your cart is empty.</div>
          ) : (
            <div className="flex flex-col gap-3">
              {lines.map((l) => {
                const item = catalogBySku[l.sku];
                return (
                  <div key={l.sku} className="flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{item?.name ?? l.sku}</div>
                      <div className="text-xs text-zinc-600 dark:text-zinc-400">
                        {l.sku} • qty {l.quantity}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="text-sm font-semibold">
                        {item ? formatUSD(item.priceCents * l.quantity) : "—"}
                      </div>
                      <button
                        onClick={() => removeSku(l.sku)}
                        className="h-9 rounded-xl border border-zinc-200 px-3 text-xs font-medium dark:border-white/10"
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                );
              })}
              <div className="mt-2 flex items-center justify-between border-t border-zinc-200 pt-3 text-sm font-semibold dark:border-white/10">
                <div>Total</div>
                <div>{formatUSD(totalCents)}</div>
              </div>
            </div>
          )}
        </main>

        <footer className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button
              onClick={() => clear()}
              className="h-10 rounded-xl border border-zinc-200 px-3 text-sm font-medium dark:border-white/10"
            >
              Clear cart
            </button>
            <button
              disabled={checkoutBusy || lines.length === 0}
              onClick={async () => {
                setCheckoutMsg("");
                if (!ready || !authenticated) {
                  setCheckoutMsg("Please log in to checkout.");
                  login();
                  return;
                }
                if (!accountAddress) {
                  setCheckoutMsg("Missing account identity.");
                  return;
                }
                const email = extractEmail(user);
                if (!email) {
                  setCheckoutMsg("Checkout requires an email (link an email login in Privy).");
                  return;
                }
                setCheckoutBusy(true);
                try {
                  const tok = await getAccessToken();
                  const res = await fetch("/api/checkout", {
                    method: "POST",
                    headers: { "content-type": "application/json", authorization: `Bearer ${tok}` },
                    body: JSON.stringify({
                      session: {
                        gymName: "Erie Community Center",
                        timezone: clientTz || "America/Denver",
                        cartLines: lines,
                        accountAddress,
                        userEmail: email,
                      },
                    }),
                  });
                  const json = (await res.json().catch(() => ({}))) as unknown;
                  const j = json as Record<string, unknown>;
                  if (!res.ok) {
                    setCheckoutMsg(String(j?.error ?? j?.detail ?? "Checkout failed."));
                    return;
                  }
                  clear();
                  setCheckoutMsg(String(j?.answer ?? "Checkout complete."));
                } finally {
                  setCheckoutBusy(false);
                }
              }}
              className="h-10 rounded-xl bg-zinc-900 px-3 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
            >
              {checkoutBusy ? "Checking out…" : "Checkout + email receipt"}
            </button>
          </div>
          <Link href="/" className="text-sm text-zinc-600 underline dark:text-zinc-400">
            Home
          </Link>
        </footer>
        {checkoutMsg ? (
          <div className="text-sm text-zinc-600 dark:text-zinc-400">{checkoutMsg}</div>
        ) : null}
      </div>
    </div>
  );
}

