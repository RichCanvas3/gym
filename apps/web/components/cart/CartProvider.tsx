"use client";

import React, { createContext, useContext, useEffect, useMemo, useState } from "react";

export type CartLine = {
  sku: string;
  quantity: number;
};

type CartContextValue = {
  lines: CartLine[];
  addLine: (line: CartLine) => void;
  removeSku: (sku: string) => void;
  clear: () => void;
};

const CartContext = createContext<CartContextValue | null>(null);

const STORAGE_KEY = "climb_gym_cart_v1";

export function CartProvider({ children }: { children: React.ReactNode }) {
  const [lines, setLines] = useState<CartLine[]>(() => {
    try {
      if (typeof window === "undefined") return [];
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map((x) => {
          if (!x || typeof x !== "object") return null;
          const o = x as Record<string, unknown>;
          const sku = typeof o.sku === "string" ? o.sku : "";
          const quantity = typeof o.quantity === "number" ? o.quantity : 1;
          if (!sku) return null;
          return { sku, quantity: Math.max(1, Math.floor(quantity)) };
        })
        .filter(Boolean) as CartLine[];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(lines));
    } catch {
      // ignore
    }
  }, [lines]);

  const value = useMemo<CartContextValue>(
    () => ({
      lines,
      addLine: (line) => {
        setLines((prev) => {
          const q = Math.max(1, Math.floor(line.quantity));
          const idx = prev.findIndex((l) => l.sku === line.sku);
          if (idx === -1) return [...prev, { sku: line.sku, quantity: q }];
          const copy = [...prev];
          copy[idx] = { sku: line.sku, quantity: copy[idx].quantity + q };
          return copy;
        });
      },
      removeSku: (sku) => setLines((prev) => prev.filter((l) => l.sku !== sku)),
      clear: () => setLines([]),
    }),
    [lines],
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart() {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error("useCart must be used within CartProvider");
  return ctx;
}

