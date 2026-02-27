"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useWaiver } from "@/components/waiver/WaiverProvider";
import { useReservations } from "@/components/reservations/ReservationsProvider";

type GymClass = {
  id: string;
  title: string;
  type: "group" | "private";
  skillLevel: "beginner" | "intermediate" | "advanced";
  coachId: string;
  startTimeISO: string;
  durationMinutes: number;
  capacity: number;
};

type HourlyForecast = {
  location?: { lat?: number; lon?: number; label?: string | null };
  hourly?: Array<{
    dt?: number;
    temp?: number;
    wind_speed?: number;
    wind_gust?: number;
    pop?: number;
    weather?: Array<{ id?: number; description?: string }>;
  }>;
};

type HourPoint = NonNullable<HourlyForecast["hourly"]>[number];

function startOfDayISO(d: Date) {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0));
  return x.toISOString().slice(0, 10);
}

function formatLocalTime(iso: string) {
  const d = new Date(iso);
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(d);
}

function toUnix(iso: string) {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

function pickNearestHour(hourly: HourlyForecast["hourly"], targetUnix: number) {
  if (!Array.isArray(hourly) || hourly.length === 0) return null;
  let best: HourPoint | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const h of hourly) {
    const dt = typeof h?.dt === "number" ? h.dt : NaN;
    if (!Number.isFinite(dt)) continue;
    const delta = Math.abs(dt - targetUnix);
    if (delta < bestDelta) {
      best = h;
      bestDelta = delta;
    }
  }
  return best;
}

export default function CalendarPage() {
  const { waiver } = useWaiver();
  const { reservations, addReservation, clearReservations } = useReservations();

  const [classes, setClasses] = useState<GymClass[]>([]);
  const [classAsOfISO, setClassAsOfISO] = useState<string>("");
  const [hourly, setHourly] = useState<HourlyForecast | null>(null);
  const [weatherErr, setWeatherErr] = useState<string>("");
  const [reserveBusyId, setReserveBusyId] = useState<string>("");
  const [reserveMsg, setReserveMsg] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const today = new Date();
      const dates: string[] = [];
      for (let i = 0; i < 7; i++) {
        const d = new Date(today.getTime() + i * 24 * 3600 * 1000);
        dates.push(startOfDayISO(d));
      }

      const all: GymClass[] = [];
      let asOfISO = "";
      for (const dateISO of dates) {
        const res = await fetch(`/api/ops/classes/search?date=${encodeURIComponent(dateISO)}`, { cache: "no-store" });
        const json = (await res.json().catch(() => ({}))) as unknown;
        const j = json as Record<string, unknown>;
        const items = Array.isArray(j?.data) ? (j.data as unknown[]) : [];
        if (typeof j?.asOfISO === "string") asOfISO = j.asOfISO;
        for (const x of items) {
          if (!x || typeof x !== "object") continue;
          const o = x as Record<string, unknown>;
          const id = typeof o.id === "string" ? o.id : "";
          const title = typeof o.title === "string" ? o.title : "";
          const type = o.type === "group" || o.type === "private" ? o.type : null;
          const skillLevel =
            o.skillLevel === "beginner" || o.skillLevel === "intermediate" || o.skillLevel === "advanced"
              ? o.skillLevel
              : null;
          const coachId = typeof o.coachId === "string" ? o.coachId : "";
          const startTimeISO = typeof o.startTimeISO === "string" ? o.startTimeISO : "";
          const durationMinutes = typeof o.durationMinutes === "number" ? o.durationMinutes : NaN;
          const capacity = typeof o.capacity === "number" ? o.capacity : NaN;
          if (!id || !title || !type || !skillLevel || !coachId || !startTimeISO) continue;
          if (!Number.isFinite(durationMinutes) || !Number.isFinite(capacity)) continue;
          all.push({ id, title, type, skillLevel, coachId, startTimeISO, durationMinutes, capacity });
        }
      }

      all.sort((a, b) => toUnix(a.startTimeISO) - toUnix(b.startTimeISO));

      if (!cancelled) {
        setClasses(all);
        setClassAsOfISO(asOfISO);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadWeather() {
      setWeatherErr("");
      const res = await fetch("/api/weather/hourly?lat=40.015&lon=-105.2705&hours=48&units=metric", {
        cache: "no-store",
      });
      const json = (await res.json().catch(() => ({}))) as unknown;
      if (!res.ok) {
        const j = json as Record<string, unknown>;
        if (!cancelled) setWeatherErr(String(j?.error ?? "Weather fetch failed."));
        return;
      }
      if (!cancelled) setHourly(json as HourlyForecast);
    }
    void loadWeather();
    return () => {
      cancelled = true;
    };
  }, []);

  const reservationsByClassId = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of reservations) map.set(r.classId, r.reservationId);
    return map;
  }, [reservations]);

  const grouped = useMemo(() => {
    const map = new Map<string, GymClass[]>();
    for (const c of classes) {
      const d = new Date(c.startTimeISO);
      const key = d.toISOString().slice(0, 10);
      const arr = map.get(key) ?? [];
      arr.push(c);
      map.set(key, arr);
    }
    return [...map.entries()];
  }, [classes]);

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900 dark:bg-black dark:text-zinc-50">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-10">
        <header className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Class calendar</h1>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Shows the next 7 days. Outdoor classes include a weather snapshot (48h).
            </p>
            {classAsOfISO ? (
              <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-500">Schedule as-of: {classAsOfISO}</div>
            ) : null}
            {weatherErr ? (
              <div className="mt-1 text-xs text-red-600 dark:text-red-400">Weather: {weatherErr}</div>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/chat"
              className="h-10 rounded-xl border border-zinc-200 px-3 text-sm font-medium leading-10 dark:border-white/10"
            >
              Chat
            </Link>
            <Link
              href="/waiver"
              className="h-10 rounded-xl border border-zinc-200 px-3 text-sm font-medium leading-10 dark:border-white/10"
            >
              Waiver
            </Link>
          </div>
        </header>

        <main className="flex flex-col gap-4">
          {grouped.length === 0 ? (
            <div className="rounded-2xl border border-zinc-200 bg-white p-4 text-sm text-zinc-600 dark:border-white/10 dark:bg-zinc-950 dark:text-zinc-400">
              No classes found.
            </div>
          ) : (
            grouped.map(([dateISO, items]) => (
              <section key={dateISO} className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-white/10 dark:bg-zinc-950">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold">{dateISO}</h2>
                  <div className="text-xs text-zinc-600 dark:text-zinc-400">{items.length} classes</div>
                </div>
                <div className="mt-3 flex flex-col gap-3">
                  {items.map((c) => {
                    const isOutdoor = c.id.toLowerCase().includes("outdoor") || c.title.toLowerCase().includes("outdoor");
                    const reservedId = reservationsByClassId.get(c.id);
                    const t = toUnix(c.startTimeISO);
                    const h = isOutdoor ? pickNearestHour(hourly?.hourly, t) : null;
                    const weatherLine =
                      isOutdoor && h
                        ? `Temp ${typeof h.temp === "number" ? h.temp.toFixed(1) : "?"}°C • wind ${
                            typeof h.wind_speed === "number" ? h.wind_speed.toFixed(1) : "?"
                          } m/s gust ${
                            typeof h.wind_gust === "number" ? h.wind_gust.toFixed(1) : "?"
                          } • precip ${
                            typeof h.pop === "number" ? Math.round(h.pop * 100) : "?"
                          }%`
                        : null;

                    return (
                      <div
                        key={c.id}
                        className={`rounded-xl border p-3 ${
                          reservedId
                            ? "border-emerald-300 bg-emerald-50 dark:border-emerald-400/40 dark:bg-emerald-400/10"
                            : "border-zinc-200 dark:border-white/10"
                        }`}
                      >
                        <div className="flex items-start justify-between gap-4">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium">
                              {c.title}{" "}
                              {isOutdoor ? (
                                <span className="ml-2 rounded-full border border-zinc-200 px-2 py-0.5 text-xs dark:border-white/10">
                                  Outdoor
                                </span>
                              ) : null}
                              {reservedId ? (
                                <span className="ml-2 rounded-full bg-emerald-600 px-2 py-0.5 text-xs font-semibold text-white">
                                  Reserved
                                </span>
                              ) : null}
                            </div>
                            <div className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
                              {formatLocalTime(c.startTimeISO)} • {c.skillLevel} • {c.type} • {c.id}
                            </div>
                            {weatherLine ? (
                              <div className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">{weatherLine}</div>
                            ) : null}
                          </div>
                          <button
                            disabled={reserveBusyId === c.id || !!reservedId}
                            onClick={async () => {
                              setReserveMsg("");
                              if (!waiver?.id || !waiver.participantEmail) {
                                setReserveMsg("Reserve requires a saved waiver (for email confirmation).");
                                return;
                              }
                              setReserveBusyId(c.id);
                              try {
                                const res = await fetch("/api/agent/run", {
                                  method: "POST",
                                  headers: { "content-type": "application/json" },
                                  body: JSON.stringify({
                                    message: `__RESERVE_CLASS__:${c.id}`,
                                    session: {
                                      gymName: "Front Range Climbing (Boulder)",
                                      timezone: "America/Denver",
                                      waiver: {
                                        id: waiver.id,
                                        participantName: waiver.participantName,
                                        participantEmail: waiver.participantEmail,
                                        isMinor: waiver.isMinor,
                                      },
                                    },
                                  }),
                                });
                                const json = (await res.json().catch(() => ({}))) as unknown;
                                const j = json as Record<string, unknown>;
                                if (!res.ok) {
                                  setReserveMsg(String(j?.error ?? j?.detail ?? "Reserve failed."));
                                  return;
                                }
                                const r = j.reservation;
                                if (r && typeof r === "object") {
                                  const rr = r as Record<string, unknown>;
                                  const reservationId = typeof rr.reservationId === "string" ? rr.reservationId : "";
                                  if (reservationId) {
                                    addReservation({
                                      reservationId,
                                      classId: c.id,
                                      title: c.title,
                                      startTimeISO: c.startTimeISO,
                                      isOutdoor,
                                      reservedAtISO: new Date().toISOString(),
                                    });
                                    setReserveMsg("Reserved. Check your email for confirmation.");
                                    return;
                                  }
                                }
                                setReserveMsg(String(j?.answer ?? "Reserved."));
                              } finally {
                                setReserveBusyId("");
                              }
                            }}
                            className="h-9 rounded-xl bg-zinc-900 px-3 text-xs font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
                          >
                            {reservedId ? "Reserved" : reserveBusyId === c.id ? "Reserving…" : "Reserve"}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            ))
          )}
        </main>

        <footer className="flex items-center justify-between">
          <button
            onClick={() => clearReservations()}
            className="h-10 rounded-xl border border-zinc-200 px-3 text-sm font-medium dark:border-white/10"
          >
            Clear reservations
          </button>
          <Link href="/" className="text-sm text-zinc-600 underline dark:text-zinc-400">
            Home
          </Link>
        </footer>

        {reserveMsg ? <div className="text-sm text-zinc-600 dark:text-zinc-400">{reserveMsg}</div> : null}
      </div>
    </div>
  );
}

