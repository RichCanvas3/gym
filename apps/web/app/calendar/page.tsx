"use client";

import Link from "next/link";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useWaiver } from "@/components/waiver/WaiverProvider";
import { useReservations } from "@/components/reservations/ReservationsProvider";
import { useRouter, useSearchParams } from "next/navigation";

type GymClass = {
  id: string;
  title: string;
  type: "group" | "private";
  skillLevel: "beginner" | "intermediate" | "advanced";
  coachId: string;
  startTimeISO: string;
  durationMinutes: number;
  capacity: number;
  isOutdoor?: boolean;
  weatherForecast?: {
    summary?: string;
    temp?: number;
    wind_speed?: number;
    wind_gust?: number;
    pop?: number;
  };
};

function startOfDayISO(d: Date) {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0));
  return x.toISOString().slice(0, 10);
}

function isISODate(s: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function addDaysISO(isoDate: string, days: number) {
  const d = new Date(`${isoDate}T00:00:00.000Z`);
  const ms = d.getTime();
  if (!Number.isFinite(ms)) return isoDate;
  return startOfDayISO(new Date(ms + days * 24 * 3600 * 1000));
}

function formatLocalTime(iso: string) {
  const d = new Date(iso);
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(d);
}

function CalendarInner() {
  const router = useRouter();
  const params = useSearchParams();
  const { waiver } = useWaiver();
  const { reservations, addReservation, clearReservations } = useReservations();

  const [classes, setClasses] = useState<GymClass[]>([]);
  const [classAsOfISO, setClassAsOfISO] = useState<string>("");
  const [weatherErr, setWeatherErr] = useState<string>("");
  const [reserveBusyId, setReserveBusyId] = useState<string>("");
  const [reserveMsg, setReserveMsg] = useState<string>("");

  const weekStartISO = useMemo(() => {
    const raw = String(params?.get("start") ?? "");
    if (raw && isISODate(raw)) return raw;
    return startOfDayISO(new Date());
  }, [params]);

  const weekDates = useMemo(() => {
    const dates: string[] = [];
    for (let i = 0; i < 7; i++) dates.push(addDaysISO(weekStartISO, i));
    return dates;
  }, [weekStartISO]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setWeatherErr("");
      const res = await fetch(`/api/calendar/week?start=${encodeURIComponent(weekStartISO)}`, { cache: "no-store" });
      const json = (await res.json().catch(() => ({}))) as unknown;
      if (!res.ok) {
        const j = json as Record<string, unknown>;
        if (!cancelled) setWeatherErr(String(j?.error ?? j?.detail ?? "Calendar fetch failed."));
        return;
      }
      const j = json as Record<string, unknown>;
      const items = Array.isArray(j?.classes) ? (j.classes as unknown[]) : [];
      const asOfISO = typeof j?.asOfISO === "string" ? j.asOfISO : "";
      const out: GymClass[] = [];
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
        if (!id || !title || !type || !skillLevel || !startTimeISO) continue;
        if (!Number.isFinite(durationMinutes) || !Number.isFinite(capacity)) continue;
        const isOutdoor = typeof o.isOutdoor === "boolean" ? o.isOutdoor : undefined;
        const wf = o.weatherForecast && typeof o.weatherForecast === "object" ? (o.weatherForecast as Record<string, unknown>) : null;
        const weatherForecast = wf
          ? {
              summary: typeof wf.summary === "string" ? wf.summary : undefined,
              temp: typeof wf.temp === "number" ? wf.temp : undefined,
              wind_speed: typeof wf.wind_speed === "number" ? wf.wind_speed : undefined,
              wind_gust: typeof wf.wind_gust === "number" ? wf.wind_gust : undefined,
              pop: typeof wf.pop === "number" ? wf.pop : undefined,
            }
          : undefined;
        out.push({ id, title, type, skillLevel, coachId, startTimeISO, durationMinutes, capacity, isOutdoor, weatherForecast });
      }
      out.sort((a, b) => Date.parse(a.startTimeISO) - Date.parse(b.startTimeISO));
      if (!cancelled) {
        setClasses(out);
        setClassAsOfISO(asOfISO);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [weekStartISO]);

  const reservationsByClassId = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of reservations) map.set(r.classId, r.reservationId);
    return map;
  }, [reservations]);

  const grouped = useMemo(() => {
    const map = new Map<string, GymClass[]>();
    for (const d of weekDates) map.set(d, []);
    for (const c of classes) {
      const d = new Date(c.startTimeISO);
      const key = d.toISOString().slice(0, 10);
      const arr = map.get(key);
      if (arr) arr.push(c);
    }
    for (const [k, arr] of map.entries()) {
      arr.sort((a, b) => Date.parse(a.startTimeISO) - Date.parse(b.startTimeISO));
      map.set(k, arr);
    }
    return [...map.entries()];
  }, [classes, weekDates]);

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900 dark:bg-black dark:text-zinc-50">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-10">
        <header className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Class calendar</h1>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Week view. Outdoor classes include a weather snapshot (48h).
            </p>
            <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-500">
              Week: {weekDates[0]} → {weekDates[6]}
            </div>
            {classAsOfISO ? (
              <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-500">Schedule as-of: {classAsOfISO}</div>
            ) : null}
            {weatherErr ? (
              <div className="mt-1 text-xs text-red-600 dark:text-red-400">Weather: {weatherErr}</div>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => router.push(`/calendar?start=${encodeURIComponent(addDaysISO(weekStartISO, -7))}`)}
              className="h-10 rounded-xl border border-zinc-200 px-3 text-sm font-medium leading-10 dark:border-white/10"
            >
              Prev
            </button>
            <button
              onClick={() => router.push(`/calendar?start=${encodeURIComponent(startOfDayISO(new Date()))}`)}
              className="h-10 rounded-xl border border-zinc-200 px-3 text-sm font-medium leading-10 dark:border-white/10"
            >
              Today
            </button>
            <button
              onClick={() => router.push(`/calendar?start=${encodeURIComponent(addDaysISO(weekStartISO, 7))}`)}
              className="h-10 rounded-xl border border-zinc-200 px-3 text-sm font-medium leading-10 dark:border-white/10"
            >
              Next
            </button>
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
            <section className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-white/10 dark:bg-zinc-950">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-7">
                {grouped.map(([dateISO, items]) => (
                  <div key={dateISO} className="min-w-0">
                    <div className="flex items-center justify-between">
                      <h2 className="text-xs font-semibold">{dateISO}</h2>
                      <div className="text-[11px] text-zinc-600 dark:text-zinc-400">{items.length}</div>
                    </div>
                    <div className="mt-2 flex flex-col gap-2">
                      {items.length === 0 ? (
                        <div className="rounded-xl border border-dashed border-zinc-200 p-2 text-[11px] text-zinc-500 dark:border-white/10 dark:text-zinc-500">
                          —
                        </div>
                      ) : (
                        items.map((c) => {
                          const isOutdoor = Boolean(c.isOutdoor);
                          const reservedId = reservationsByClassId.get(c.id);
                          const wf = c.weatherForecast;
                          const weatherLine =
                            isOutdoor && wf
                              ? `${wf.summary ?? "Forecast"} • Temp ${
                                  typeof wf.temp === "number" ? wf.temp.toFixed(1) : "?"
                                }°C • wind ${typeof wf.wind_speed === "number" ? wf.wind_speed.toFixed(1) : "?"} m/s gust ${
                                  typeof wf.wind_gust === "number" ? wf.wind_gust.toFixed(1) : "?"
                                } • precip ${typeof wf.pop === "number" ? Math.round(wf.pop * 100) : "?"}%`
                              : null;

                          return (
                            <div
                              key={c.id}
                              className={`rounded-xl border p-2 ${
                                reservedId
                                  ? "border-emerald-300 bg-emerald-50 dark:border-emerald-400/40 dark:bg-emerald-400/10"
                                  : "border-zinc-200 dark:border-white/10"
                              }`}
                            >
                              <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0">
                                  <div className="truncate text-xs font-medium">
                                    {formatLocalTime(c.startTimeISO)} {c.title}
                                  </div>
                                  <div className="mt-0.5 text-[11px] text-zinc-600 dark:text-zinc-400">
                                    {c.skillLevel} • {c.type}
                                    {isOutdoor ? " • outdoor" : ""}
                                    {reservedId ? " • reserved" : ""}
                                  </div>
                                  {weatherLine ? (
                                    <div className="mt-0.5 text-[11px] text-zinc-600 dark:text-zinc-400">
                                      {weatherLine}
                                    </div>
                                  ) : null}
                                </div>
                                <button
                                  disabled={reserveBusyId === c.id || !!reservedId}
                                  onClick={async () => {
                                    setReserveMsg("");
                                    if (!waiver?.id || !waiver.accountAddress) {
                                      setReserveMsg("Reserve requires a saved waiver with a canonical account address.");
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
                                              accountAddress: waiver.accountAddress,
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
                                  className="h-8 rounded-xl bg-zinc-900 px-2 text-[11px] font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
                                >
                                  {reservedId ? "Reserved" : reserveBusyId === c.id ? "…" : "Reserve"}
                                </button>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>
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

export default function CalendarPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-zinc-50 text-zinc-900 dark:bg-black dark:text-zinc-50">
          <div className="mx-auto w-full max-w-4xl px-4 py-10 text-sm text-zinc-600 dark:text-zinc-400">
            Loading calendar…
          </div>
        </div>
      }
    >
      <CalendarInner />
    </Suspense>
  );
}

