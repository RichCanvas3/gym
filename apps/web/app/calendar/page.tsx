"use client";

import Link from "next/link";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { useReservations } from "@/components/reservations/ReservationsProvider";
import { useRouter, useSearchParams } from "next/navigation";
import {
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Filter,
  MessageCircle,
  MoreHorizontal,
  Sun,
  Users,
  User,
  Wind,
  Droplets,
} from "lucide-react";

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

type GoogleEvent = {
  event_id: string;
  start_iso?: string | null;
  end_iso?: string | null;
  start_ms?: number | null;
  end_ms?: number | null;
  summary?: string | null;
  description?: string | null;
  status?: string | null;
};

type PrivateEventsMeta = {
  start?: string;
  end?: string;
  timeMinISO?: string;
  timeMaxISO?: string;
  calendarId?: string;
  asOfISO?: string;
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

function formatWeekday(isoDate: string) {
  const d = new Date(`${isoDate}T00:00:00.000Z`);
  return new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(d);
}

function formatMonthDay(isoDate: string) {
  const d = new Date(`${isoDate}T00:00:00.000Z`);
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(d);
}

function formatEventWhen(startIso: string | null | undefined) {
  const s = (startIso ?? "").trim();
  if (!s) return "";
  if (!s.includes("T")) return s;
  const d = new Date(s);
  if (!Number.isFinite(d.getTime())) return s;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(d);
}

type Filters = {
  type: "all" | "group" | "private";
  skill: "all" | "beginner" | "intermediate" | "advanced";
  outdoorOnly: boolean;
  reservedOnly: boolean;
};

function CalendarInner() {
  const router = useRouter();
  const params = useSearchParams();
  const { ready, authenticated, accountAddress, getAccessToken, login, logout } = useAuth();
  const { reservations, addReservation, clearReservations } = useReservations();

  const [classes, setClasses] = useState<GymClass[]>([]);
  const [classAsOfISO, setClassAsOfISO] = useState<string>("");
  const [weatherErr, setWeatherErr] = useState<string>("");
  const [privateEvents, setPrivateEvents] = useState<GoogleEvent[]>([]);
  const [privateEventsErr, setPrivateEventsErr] = useState<string>("");
  const [privateEventsMeta, setPrivateEventsMeta] = useState<PrivateEventsMeta>({});
  const [reserveBusyId, setReserveBusyId] = useState<string>("");
  const [reserveMsg, setReserveMsg] = useState<string>("");
  const [clientTz, setClientTz] = useState<string>("America/Denver");

  const showLoading = !ready;
  const showLoginGate = Boolean(ready) && !authenticated;

  useEffect(() => {
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (tz && typeof tz === "string") setClientTz(tz);
    } catch {
      // ignore
    }
  }, []);

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

  const filters = useMemo<Filters>(() => {
    const t = String(params?.get("type") ?? "");
    const s = String(params?.get("skill") ?? "");
    const outdoor = String(params?.get("outdoor") ?? "");
    const reserved = String(params?.get("reserved") ?? "");
    return {
      type: t === "group" || t === "private" ? t : "all",
      skill: s === "beginner" || s === "intermediate" || s === "advanced" ? s : "all",
      outdoorOnly: outdoor === "1" || outdoor.toLowerCase() === "true",
      reservedOnly: reserved === "1" || reserved.toLowerCase() === "true",
    };
  }, [params]);

  function pushQuery(patch: Partial<Record<string, string | undefined>>) {
    const next = new URLSearchParams(params?.toString() ?? "");
    for (const [k, v] of Object.entries(patch)) {
      if (!v) next.delete(k);
      else next.set(k, v);
    }
    const qs = next.toString();
    router.push(qs ? `/calendar?${qs}` : "/calendar");
  }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!authenticated) return;
      setWeatherErr("");
      const tok = await getAccessToken();
      if (!tok) return;
      const res = await fetch(
        `/api/calendar/week?start=${encodeURIComponent(weekStartISO)}&tz=${encodeURIComponent(clientTz || "America/Denver")}`,
        { cache: "no-store", headers: { authorization: `Bearer ${tok}` } },
      );
      const json = (await res.json().catch(() => ({}))) as unknown;
      if (!res.ok) {
        const j = json as Record<string, unknown>;
        if (!cancelled) setWeatherErr(String(j?.error ?? j?.detail ?? "Calendar fetch failed."));
        if (res.status === 401) logout();
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
  }, [weekStartISO, authenticated, getAccessToken, clientTz, logout]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!authenticated) return;
      setPrivateEventsErr("");
      const tok = await getAccessToken();
      if (!tok) return;
      const res = await fetch(`/api/googlecalendar/events/week?start=${encodeURIComponent(weekStartISO)}`, {
        cache: "no-store",
        headers: { authorization: `Bearer ${tok}` },
      });
      const json = (await res.json().catch(() => ({}))) as unknown;
      const j = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
      if (!res.ok) {
        if (!cancelled) setPrivateEventsErr(String(j?.error ?? j?.detail ?? "Private calendar fetch failed."));
        if (res.status === 401) logout();
        return;
      }
      const events = Array.isArray(j?.events) ? (j.events as GoogleEvent[]) : [];
      const meta: PrivateEventsMeta = {
        start: typeof j?.start === "string" ? String(j.start) : undefined,
        end: typeof j?.end === "string" ? String(j.end) : undefined,
        timeMinISO: typeof j?.timeMinISO === "string" ? String(j.timeMinISO) : undefined,
        timeMaxISO: typeof j?.timeMaxISO === "string" ? String(j.timeMaxISO) : undefined,
        calendarId: typeof j?.calendarId === "string" ? String(j.calendarId) : undefined,
        asOfISO: typeof j?.asOfISO === "string" ? String(j.asOfISO) : undefined,
      };
      if (!cancelled) {
        setPrivateEvents(events);
        setPrivateEventsMeta(meta);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [weekStartISO, authenticated, getAccessToken, logout]);

  const reservationsByClassId = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of reservations) map.set(r.classId, r.reservationId);
    return map;
  }, [reservations]);

  const filteredClasses = useMemo(() => {
    const out: GymClass[] = [];
    for (const c of classes) {
      if (filters.type !== "all" && c.type !== filters.type) continue;
      if (filters.skill !== "all" && c.skillLevel !== filters.skill) continue;
      if (filters.outdoorOnly && !c.isOutdoor) continue;
      if (filters.reservedOnly && !reservationsByClassId.get(c.id)) continue;
      out.push(c);
    }
    return out;
  }, [classes, filters, reservationsByClassId]);

  const grouped = useMemo(() => {
    const map = new Map<string, GymClass[]>();
    for (const d of weekDates) map.set(d, []);
    for (const c of filteredClasses) {
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
  }, [filteredClasses, weekDates]);

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900 dark:bg-black dark:text-zinc-50">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-10">
        {showLoading ? (
          <div className="rounded-2xl border border-zinc-200 bg-white p-4 text-sm text-zinc-600 dark:border-white/10 dark:bg-zinc-950 dark:text-zinc-300">
            Loading…
          </div>
        ) : showLoginGate ? (
          <div className="rounded-3xl border border-zinc-200 bg-white p-8 dark:border-white/10 dark:bg-zinc-950">
            <div className="text-xl font-semibold tracking-tight">Sign in to view the calendar</div>
            <div className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
              The calendar requires authentication.
            </div>
            <button
              onClick={() => login()}
              className="mt-6 inline-flex h-11 w-full items-center justify-center rounded-xl bg-zinc-900 px-4 text-sm font-medium text-white dark:bg-white dark:text-black"
            >
              Log in
            </button>
          </div>
        ) : (
          <>
        <header className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <CalendarDays className="h-5 w-5 text-zinc-600 dark:text-zinc-400" aria-hidden="true" />
              <h1 className="text-2xl font-semibold tracking-tight">Class calendar</h1>
            </div>
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
            <div className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
              Showing <span className="font-medium">{filteredClasses.length}</span> of{" "}
              <span className="font-medium">{classes.length}</span> classes
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => router.push(`/calendar?start=${encodeURIComponent(addDaysISO(weekStartISO, -7))}`)}
              className="inline-flex h-10 items-center gap-1 rounded-xl border border-zinc-200 bg-white px-3 text-sm font-medium dark:border-white/10 dark:bg-zinc-950"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
              Prev
            </button>
            <button
              onClick={() => router.push(`/calendar?start=${encodeURIComponent(startOfDayISO(new Date()))}`)}
              className="h-10 rounded-xl border border-zinc-200 bg-white px-3 text-sm font-medium dark:border-white/10 dark:bg-zinc-950"
            >
              Today
            </button>
            <button
              onClick={() => router.push(`/calendar?start=${encodeURIComponent(addDaysISO(weekStartISO, 7))}`)}
              className="inline-flex h-10 items-center gap-1 rounded-xl border border-zinc-200 bg-white px-3 text-sm font-medium dark:border-white/10 dark:bg-zinc-950"
            >
              Next
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </button>
            <Link
              href="/chat"
              className="inline-flex h-10 items-center gap-2 rounded-xl border border-zinc-200 bg-white px-3 text-sm font-medium dark:border-white/10 dark:bg-zinc-950"
            >
              <MessageCircle className="h-4 w-4" aria-hidden="true" />
              Chat
            </Link>
          </div>
        </header>

        <section className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-white/10 dark:bg-zinc-950">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Filter className="h-4 w-4 text-zinc-600 dark:text-zinc-400" aria-hidden="true" />
              Filters
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center overflow-hidden rounded-xl border border-zinc-200 dark:border-white/10">
                <button
                  onClick={() => pushQuery({ type: undefined })}
                  className={`inline-flex h-9 items-center gap-1 px-3 text-xs font-medium ${
                    filters.type === "all"
                      ? "bg-zinc-900 text-white dark:bg-white dark:text-black"
                      : "bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100"
                  }`}
                >
                  <Users className="h-3.5 w-3.5" aria-hidden="true" />
                  All
                </button>
                <button
                  onClick={() => pushQuery({ type: "group" })}
                  className={`inline-flex h-9 items-center gap-1 border-l border-zinc-200 px-3 text-xs font-medium dark:border-white/10 ${
                    filters.type === "group"
                      ? "bg-zinc-900 text-white dark:bg-white dark:text-black"
                      : "bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100"
                  }`}
                >
                  <Users className="h-3.5 w-3.5" aria-hidden="true" />
                  Group
                </button>
                <button
                  onClick={() => pushQuery({ type: "private" })}
                  className={`inline-flex h-9 items-center gap-1 border-l border-zinc-200 px-3 text-xs font-medium dark:border-white/10 ${
                    filters.type === "private"
                      ? "bg-zinc-900 text-white dark:bg-white dark:text-black"
                      : "bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100"
                  }`}
                >
                  <User className="h-3.5 w-3.5" aria-hidden="true" />
                  Private
                </button>
              </div>

              <label className="flex items-center gap-2 rounded-xl border border-zinc-200 bg-white px-3 py-2 text-xs font-medium dark:border-white/10 dark:bg-zinc-950">
                Skill
                <select
                  value={filters.skill}
                  onChange={(e) => pushQuery({ skill: e.target.value === "all" ? undefined : e.target.value })}
                  className="h-6 rounded-md border border-zinc-200 bg-white px-2 text-xs dark:border-white/10 dark:bg-zinc-950"
                >
                  <option value="all">All</option>
                  <option value="beginner">Beginner</option>
                  <option value="intermediate">Intermediate</option>
                  <option value="advanced">Advanced</option>
                </select>
              </label>

              <button
                onClick={() => pushQuery({ outdoor: filters.outdoorOnly ? undefined : "1" })}
                className={`inline-flex h-9 items-center gap-2 rounded-xl border px-3 text-xs font-medium ${
                  filters.outdoorOnly
                    ? "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-400/40 dark:bg-amber-400/10 dark:text-amber-200"
                    : "border-zinc-200 bg-white text-zinc-900 dark:border-white/10 dark:bg-zinc-950 dark:text-zinc-100"
                }`}
              >
                <Sun className="h-4 w-4" aria-hidden="true" />
                Outdoor
              </button>

              <button
                onClick={() => pushQuery({ reserved: filters.reservedOnly ? undefined : "1" })}
                className={`inline-flex h-9 items-center gap-2 rounded-xl border px-3 text-xs font-medium ${
                  filters.reservedOnly
                    ? "border-emerald-300 bg-emerald-50 text-emerald-950 dark:border-emerald-400/40 dark:bg-emerald-400/10 dark:text-emerald-200"
                    : "border-zinc-200 bg-white text-zinc-900 dark:border-white/10 dark:bg-zinc-950 dark:text-zinc-100"
                }`}
              >
                <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                Reserved
              </button>
            </div>
          </div>
        </section>

        <section className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-white/10 dark:bg-zinc-950">
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm font-medium">Private calendar (Google)</div>
            <Link
              href="/googlecalendar/connect"
              className="text-xs font-medium text-zinc-700 underline underline-offset-4 dark:text-zinc-300"
            >
              Connect / status
            </Link>
          </div>
          <div className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-500">
            Window: {privateEventsMeta.start ?? weekStartISO} → {privateEventsMeta.end ?? addDaysISO(weekStartISO, 7)} •{" "}
            {privateEventsMeta.calendarId ? `calendarId=${privateEventsMeta.calendarId}` : "calendarId=? (check MCP config)"} •{" "}
            {privateEventsMeta.asOfISO ? `as-of=${privateEventsMeta.asOfISO}` : ""}
          </div>
          {privateEventsErr ? <div className="mt-2 text-xs text-red-600 dark:text-red-400">{privateEventsErr}</div> : null}
          <div className="mt-3 flex flex-col gap-2">
            {privateEvents.length === 0 ? (
              <div className="rounded-xl border border-dashed border-zinc-200 p-3 text-xs text-zinc-500 dark:border-white/10 dark:text-zinc-500">
                No cached events for this week yet. (Connect triggers a sync; cron also syncs periodically.)
              </div>
            ) : (
              privateEvents.slice(0, 20).map((e) => (
                <div key={e.event_id} className="rounded-xl border border-zinc-200 p-3 text-xs dark:border-white/10">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0 truncate font-medium">{String(e.summary ?? "Untitled")}</div>
                    <div className="shrink-0 text-[11px] text-zinc-600 dark:text-zinc-400">{formatEventWhen(e.start_iso ?? null)}</div>
                  </div>
                  {e.description ? (
                    <div className="mt-1 line-clamp-2 text-[11px] text-zinc-600 dark:text-zinc-400">{String(e.description)}</div>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </section>

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
                      <div className="min-w-0">
                        <h2 className="text-xs font-semibold">
                          {formatWeekday(dateISO)}{" "}
                          <span className="font-normal text-zinc-600 dark:text-zinc-400">{formatMonthDay(dateISO)}</span>
                        </h2>
                        <div className="text-[10px] text-zinc-500 dark:text-zinc-500">{dateISO}</div>
                      </div>
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
                                  <div className="flex flex-wrap items-center gap-2">
                                    <div className="flex items-center gap-1 text-xs font-medium">
                                      <Clock className="h-3.5 w-3.5 text-zinc-600 dark:text-zinc-400" aria-hidden="true" />
                                      {formatLocalTime(c.startTimeISO)}
                                    </div>
                                    {reservedId ? (
                                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-600 px-2 py-0.5 text-[10px] font-semibold text-white dark:bg-emerald-500">
                                        <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                                        Reserved
                                      </span>
                                    ) : null}
                                    {isOutdoor ? (
                                      <span className="inline-flex items-center gap-1 rounded-full bg-amber-500 px-2 py-0.5 text-[10px] font-semibold text-black">
                                        <Sun className="h-3 w-3" aria-hidden="true" />
                                        Outdoor
                                      </span>
                                    ) : null}
                                  </div>
                                  <div className="mt-1 break-words text-xs font-semibold leading-snug">{c.title}</div>
                                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-zinc-600 dark:text-zinc-400">
                                    <span className="capitalize">{c.skillLevel}</span>
                                    <span className="text-zinc-400 dark:text-zinc-600">•</span>
                                    <span className="capitalize">{c.type}</span>
                                    <span className="text-zinc-400 dark:text-zinc-600">•</span>
                                    <span className="inline-flex items-center gap-1">
                                      <Users className="h-3.5 w-3.5" aria-hidden="true" />
                                      {c.capacity}
                                    </span>
                                    <span className="text-zinc-400 dark:text-zinc-600">•</span>
                                    <span>{c.durationMinutes} min</span>
                                  </div>
                                  {isOutdoor && wf ? (
                                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-600 dark:text-zinc-400">
                                      <span className="inline-flex items-center gap-1">
                                        <Sun className="h-3.5 w-3.5" aria-hidden="true" />
                                        {wf.summary ?? "Forecast"}
                                      </span>
                                      <span className="inline-flex items-center gap-1">
                                        <Wind className="h-3.5 w-3.5" aria-hidden="true" />
                                        {typeof wf.wind_speed === "number" ? wf.wind_speed.toFixed(1) : "?"} m/s
                                        {typeof wf.wind_gust === "number" ? ` gust ${wf.wind_gust.toFixed(1)}` : ""}
                                      </span>
                                      <span className="inline-flex items-center gap-1">
                                        <Droplets className="h-3.5 w-3.5" aria-hidden="true" />
                                        {typeof wf.pop === "number" ? `${Math.round(wf.pop * 100)}%` : "?"} precip
                                      </span>
                                      <span className="inline-flex items-center gap-1">
                                        Temp {typeof wf.temp === "number" ? `${wf.temp.toFixed(1)}°C` : "?"}
                                      </span>
                                    </div>
                                  ) : null}
                                </div>
                              </div>

                              {!reservedId ? (
                                <div className="mt-2 flex items-center justify-end">
                                  <button
                                    disabled={reserveBusyId === c.id}
                                    onClick={async () => {
                                      setReserveMsg("");
                                      if (!accountAddress) {
                                        setReserveMsg("Sign in required to reserve.");
                                        return;
                                      }
                                      setReserveBusyId(c.id);
                                      try {
                                        const tok = await getAccessToken();
                                        const res = await fetch("/api/agent/run", {
                                          method: "POST",
                                          headers: { "content-type": "application/json", authorization: `Bearer ${tok}` },
                                          body: JSON.stringify({
                                            message: `__RESERVE_CLASS__:${c.id}`,
                                            session: {
                                              gymName: "Erie Community Center",
                                              timezone: clientTz || "America/Denver",
                                              threadId: accountAddress ? `thr_${accountAddress.replace(/[^a-zA-Z0-9_]/g, "_")}` : undefined,
                                              accountAddress,
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
                                            setReserveMsg("Reserved.");
                                            return;
                                          }
                                        }
                                        setReserveMsg(String(j?.answer ?? "Reserved."));
                                      } finally {
                                        setReserveBusyId("");
                                      }
                                    }}
                                    className="inline-flex h-7 max-w-full items-center gap-1 rounded-lg border border-zinc-200 bg-white px-2 text-[11px] font-medium text-zinc-900 disabled:opacity-50 dark:border-white/10 dark:bg-zinc-950 dark:text-zinc-100"
                                  >
                                    <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
                                    {reserveBusyId === c.id ? "Reserving…" : "Reserve"}
                                  </button>
                                </div>
                              ) : null}
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
            className="h-10 rounded-xl border border-zinc-200 bg-white px-3 text-sm font-medium dark:border-white/10 dark:bg-zinc-950"
          >
            Clear reservations
          </button>
          <Link href="/" className="text-sm text-zinc-600 underline dark:text-zinc-400">
            Home
          </Link>
        </footer>

        {reserveMsg ? <div className="text-sm text-zinc-600 dark:text-zinc-400">{reserveMsg}</div> : null}
          </>
        )}
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

