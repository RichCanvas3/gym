"use client";

import React, { createContext, useContext, useEffect, useMemo, useState } from "react";

export type Reservation = {
  reservationId: string;
  classId: string;
  title: string;
  startTimeISO: string;
  isOutdoor: boolean;
  reservedAtISO: string;
};

type ReservationsContextValue = {
  reservations: Reservation[];
  addReservation: (r: Reservation) => void;
  clearReservations: () => void;
};

const ReservationsContext = createContext<ReservationsContextValue | null>(null);
const STORAGE_KEY = "climb_gym_reservations_v1";

export function ReservationsProvider({ children }: { children: React.ReactNode }) {
  const [reservations, setReservations] = useState<Reservation[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map((x) => {
          if (!x || typeof x !== "object") return null;
          const o = x as Record<string, unknown>;
          const reservationId = typeof o.reservationId === "string" ? o.reservationId : "";
          const classId = typeof o.classId === "string" ? o.classId : "";
          const title = typeof o.title === "string" ? o.title : "";
          const startTimeISO = typeof o.startTimeISO === "string" ? o.startTimeISO : "";
          const reservedAtISO = typeof o.reservedAtISO === "string" ? o.reservedAtISO : "";
          const isOutdoor = typeof o.isOutdoor === "boolean" ? o.isOutdoor : false;
          if (!reservationId || !classId || !title || !startTimeISO) return null;
          return { reservationId, classId, title, startTimeISO, isOutdoor, reservedAtISO };
        })
        .filter(Boolean) as Reservation[];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    try {
      if (typeof window === "undefined") return;
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(reservations));
    } catch {
      // ignore
    }
  }, [reservations]);

  const value = useMemo<ReservationsContextValue>(
    () => ({
      reservations,
      addReservation: (r) =>
        setReservations((prev) => {
          if (prev.some((x) => x.reservationId === r.reservationId)) return prev;
          return [r, ...prev];
        }),
      clearReservations: () => setReservations([]),
    }),
    [reservations],
  );

  return <ReservationsContext.Provider value={value}>{children}</ReservationsContext.Provider>;
}

export function useReservations() {
  const ctx = useContext(ReservationsContext);
  if (!ctx) throw new Error("useReservations must be used within ReservationsProvider");
  return ctx;
}

