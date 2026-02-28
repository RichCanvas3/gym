"use client";

import React, { createContext, useContext, useEffect, useMemo, useState } from "react";

export type WaiverInfo = {
  id: string;
  createdAtISO: string;
  accountAddress: string;
  participantName: string;
  participantEmail: string;
  participantDobISO: string;
  isMinor: boolean;
  guardianName?: string;
  guardianEmail?: string;
};

type WaiverContextValue = {
  waiver: WaiverInfo | null;
  setWaiver: (waiver: WaiverInfo) => void;
  clearWaiver: () => void;
};

const WaiverContext = createContext<WaiverContextValue | null>(null);
const STORAGE_KEY = "climb_gym_waiver_v2";
const DEFAULT_DEMO_WAIVER: WaiverInfo = {
  id: "waiver_demo_casey",
  createdAtISO: "2026-02-01T00:00:00Z",
  accountAddress: "acct_cust_casey",
  participantName: "Casey Morgan",
  participantEmail: "casey@example.com",
  participantDobISO: "1990-01-01",
  isMinor: false,
};

function demoDefaultEnabled() {
  return (process.env.NEXT_PUBLIC_DEMO_DEFAULT_USER ?? "1").toLowerCase() !== "0";
}

export function WaiverProvider({ children }: { children: React.ReactNode }) {
  const [waiver, setWaiverState] = useState<WaiverInfo | null>(() => {
    try {
      if (typeof window === "undefined") return null;
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return demoDefaultEnabled() ? DEFAULT_DEMO_WAIVER : null;
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object") return null;
      const o = parsed as Record<string, unknown>;
      if (typeof o.id !== "string" || typeof o.createdAtISO !== "string") return null;
      if (typeof o.accountAddress !== "string") return null;
      if (typeof o.participantName !== "string" || typeof o.participantEmail !== "string") return null;
      if (typeof o.participantDobISO !== "string" || typeof o.isMinor !== "boolean") return null;
      return {
        id: o.id,
        createdAtISO: o.createdAtISO,
        accountAddress: o.accountAddress,
        participantName: o.participantName,
        participantEmail: o.participantEmail,
        participantDobISO: o.participantDobISO,
        isMinor: o.isMinor,
        guardianName: typeof o.guardianName === "string" ? o.guardianName : undefined,
        guardianEmail: typeof o.guardianEmail === "string" ? o.guardianEmail : undefined,
      };
    } catch {
      return demoDefaultEnabled() ? DEFAULT_DEMO_WAIVER : null;
    }
  });

  useEffect(() => {
    try {
      if (!waiver) {
        window.localStorage.removeItem(STORAGE_KEY);
      } else {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(waiver));
      }
    } catch {
      // ignore
    }
  }, [waiver]);

  const value = useMemo<WaiverContextValue>(
    () => ({
      waiver,
      setWaiver: (w) => setWaiverState(w),
      clearWaiver: () => setWaiverState(null),
    }),
    [waiver],
  );

  return <WaiverContext.Provider value={value}>{children}</WaiverContext.Provider>;
}

export function useWaiver() {
  const ctx = useContext(WaiverContext);
  if (!ctx) throw new Error("useWaiver must be used within WaiverProvider");
  return ctx;
}

