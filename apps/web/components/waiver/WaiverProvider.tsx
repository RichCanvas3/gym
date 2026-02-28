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

export function WaiverProvider({ children }: { children: React.ReactNode }) {
  const [waiver, setWaiverState] = useState<WaiverInfo | null>(() => {
    try {
      if (typeof window === "undefined") return null;
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
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
      return null;
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

