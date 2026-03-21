#!/usr/bin/env node
/**
 * Seed Erie Community Center drop-in schedules into scheduling-mcp as concrete occurrences.
 *
 * Usage:
 *   SCHEDULING_MCP_URL="https://<worker>.workers.dev/mcp" \
 *   SCHEDULING_MCP_API_KEY="gym" \
 *   WEEKS=8 \
 *   node apps/scheduling-mcp/scripts/seed-erie-schedule.mjs
 *
 * Notes:
 * - This uses a fixed America/Denver offset (-06:00) for the current season.
 * - scheduling-mcp is occurrence-only (no recurrence), so we generate a horizon.
 */

import dns from "node:dns";

dns.setDefaultResultOrder("ipv4first");

const MCP_URL = process.env.SCHEDULING_MCP_URL?.trim() || "";
const API_KEY = process.env.SCHEDULING_MCP_API_KEY?.trim() || "";
const WEEKS = Math.max(1, Math.min(12, Number(process.env.WEEKS || "8") || 8));

if (!MCP_URL) {
  console.error("Missing SCHEDULING_MCP_URL");
  process.exit(1);
}

const TZ_OFFSET = "-06:00";

function pad2(n) {
  return String(n).padStart(2, "0");
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 3600 * 1000);
}

function isoDateUTC(d) {
  return d.toISOString().slice(0, 10);
}

function dowIndex(d) {
  // 0=Sunday ... 6=Saturday
  return d.getUTCDay();
}

function parseHm(hm) {
  const [h, m] = hm.split(":").map((x) => Number(x));
  return { h, m: Number.isFinite(m) ? m : 0 };
}

function to24h(time, ampm) {
  const t = time.trim().toLowerCase();
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(t);
  if (!m) throw new Error(`bad time: ${time}`);
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ap = ampm.toLowerCase();
  if (ap === "am") {
    if (h === 12) h = 0;
  } else if (ap === "pm") {
    if (h !== 12) h += 12;
  } else {
    throw new Error(`bad am/pm: ${ampm}`);
  }
  return { h, m: min };
}

function minutesBetween(start, end) {
  const sm = start.h * 60 + start.m;
  const em = end.h * 60 + end.m;
  return Math.max(15, em - sm);
}

function startIso(dateISO, hm) {
  return `${dateISO}T${hm}:00${TZ_OFFSET}`;
}

function hmString(t) {
  return `${pad2(t.h)}:${pad2(t.m)}`;
}

function classId(slug, dateISO, hm) {
  const safe = slug.replace(/[^a-z0-9_]+/gi, "_").toLowerCase();
  return `erie_${safe}_${dateISO}_${hm.replace(":", "")}`;
}

async function mcpCall(method, params) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(API_KEY ? { "x-api-key": API_KEY } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`);
  // Handle either JSON or SSE streamable output (take last JSON message line).
  const lastJsonLine = text
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => l.replace(/^data:\s*/, "").trim())
    .filter(Boolean)
    .slice(-1)[0];
  const payload = lastJsonLine ? JSON.parse(lastJsonLine) : JSON.parse(text);
  const content = payload?.result?.content;
  const blockText =
    Array.isArray(content) && content[0] && typeof content[0].text === "string" ? content[0].text : null;
  return blockText ? JSON.parse(blockText) : payload;
}

async function upsertClass(row) {
  await mcpCall("tools/call", { name: "schedule_create_class", arguments: row });
}

function weeklySlots() {
  // 0=Sun..6=Sat. Times derived from Erie pages (Jan–Apr 2026 season).
  const slots = [];

  // Indoor pickleball drop-in (classDefId optional)
  const pickleball = {
    title: "Indoor Pickleball (Drop-in)",
    slug: "pickleball_indoor",
    classDefId: "cdef_pickleball_indoor",
    type: "group",
    skillLevel: "beginner",
    capacity: 24,
    timesByDow: {
      0: [["11:00", "14:00"]],
      1: [["06:30", "08:30"], ["11:00", "14:00"]],
      2: [["11:00", "14:00"]],
      3: [["06:30", "08:30"]],
      4: [["11:00", "14:00"]],
      5: [["06:30", "08:30"], ["11:00", "14:00"]],
    },
  };
  slots.push(pickleball);

  // Indoor drop-in sports schedule
  slots.push({
    title: "Badminton (Drop-in)",
    slug: "badminton_dropin",
    type: "group",
    skillLevel: "beginner",
    capacity: 24,
    timesByDow: { 0: [["08:15", "10:45"]] },
  });
  slots.push({
    title: "Wallyball (Drop-in)",
    slug: "wallyball_dropin",
    type: "group",
    skillLevel: "beginner",
    capacity: 24,
    timesByDow: { 3: [["18:00", "20:45"]], 4: [["19:00", "20:45"]] },
  });
  slots.push({
    title: "Volleyball (Drop-in)",
    slug: "volleyball_dropin",
    type: "group",
    skillLevel: "beginner",
    capacity: 24,
    timesByDow: { 5: [["15:00", "17:00"]] },
  });

  // Climbing wall supervised open climb
  slots.push({
    title: "Climbing Wall: Supervised Open Climb",
    slug: "climbing_supervised_open_climb",
    classDefId: "cdef_climbing_supervised_open_climb",
    type: "group",
    skillLevel: "beginner",
    capacity: 20,
    timesByDow: {
      0: [["10:00", "11:00"]],
      1: [["18:30", "20:00"]],
      2: [["16:00", "19:00"]],
      4: [["16:00", "19:00"]],
      6: [["11:00", "12:00"]],
    },
  });

  // Climbing registration-based programming blocks
  slots.push({
    title: "Climbing Wall: Registration-based Programming",
    slug: "climbing_programming",
    type: "group",
    skillLevel: "beginner",
    capacity: 12,
    timesByDow: {
      0: [["11:00", "13:15"]],
      1: [["16:15", "18:30"]],
      3: [["16:15", "19:35"]],
      6: [["09:00", "11:00"]],
    },
  });

  // Pool (simplified): lap swim + open swim
  slots.push({
    title: "Lap Swim",
    slug: "pool_lap_swim",
    classDefId: "cdef_pool_lap_swim",
    type: "group",
    skillLevel: "beginner",
    capacity: 18,
    timesByDow: {
      1: [["05:00", "08:00"]],
      2: [["05:00", "08:00"]],
      3: [["05:00", "08:00"]],
      4: [["05:00", "08:00"]],
      5: [["05:00", "08:00"]],
      6: [["07:00", "09:00"]],
      0: [["08:00", "10:00"]],
    },
  });
  slots.push({
    title: "Open Swim",
    slug: "pool_open_swim",
    classDefId: "cdef_pool_open_swim",
    type: "group",
    skillLevel: "beginner",
    capacity: 60,
    timesByDow: {
      1: [["11:15", "20:30"]],
      3: [["11:15", "20:30"]],
      2: [["11:15", "15:50"], ["18:30", "20:30"]],
      4: [["11:15", "15:50"], ["18:30", "20:30"]],
      5: [["11:15", "17:30"]],
      6: [["12:00", "16:15"]],
      0: [["11:00", "16:30"]],
    },
  });

  return slots;
}

function firstWeekStartUTC() {
  const d = new Date();
  const iso = isoDateUTC(d);
  const base = new Date(`${iso}T00:00:00.000Z`);
  // start from today
  return base;
}

function isFirstMondayOfMonth(dateISO) {
  const d = new Date(`${dateISO}T00:00:00.000Z`);
  if (dowIndex(d) !== 1) return false;
  const day = d.getUTCDate();
  return day <= 7;
}

function isThirdThursdayOfMonth(dateISO) {
  const d = new Date(`${dateISO}T00:00:00.000Z`);
  if (dowIndex(d) !== 4) return false;
  const day = d.getUTCDate();
  return day >= 15 && day <= 21;
}

async function main() {
  const start = firstWeekStartUTC();
  const slots = weeklySlots();
  let created = 0;

  for (let w = 0; w < WEEKS; w++) {
    for (let day = 0; day < 7; day++) {
      const d = addDays(start, w * 7 + day);
      const dateISO = isoDateUTC(d);
      const dow = dowIndex(d);

      for (const s of slots) {
        const ranges = s.timesByDow?.[dow] ?? [];
        for (const [startHm, endHm] of ranges) {
          const st = parseHm(startHm);
          const en = parseHm(endHm);
          const dur = minutesBetween(st, en);
          const hm = hmString(st);
          await upsertClass({
            classId: classId(s.slug, dateISO, hm),
            classDefId: s.classDefId,
            title: s.title,
            type: s.type,
            skillLevel: s.skillLevel,
            startTimeISO: startIso(dateISO, hm),
            durationMinutes: dur,
            capacity: s.capacity,
            isOutdoor: false,
          });
          created++;
        }
      }

      // Monthly special: Belay Skills Training Course (first Monday, 18:30-20:00)
      if (isFirstMondayOfMonth(dateISO)) {
        const st = parseHm("18:30");
        const en = parseHm("20:00");
        const hm = hmString(st);
        await upsertClass({
          classId: classId("climbing_belay_skills_training", dateISO, hm),
          classDefId: "cdef_climbing_belay_skills_training",
          title: "Climbing Wall: Belay Skills Training Course",
          type: "group",
          skillLevel: "intermediate",
          startTimeISO: startIso(dateISO, hm),
          durationMinutes: minutesBetween(st, en),
          capacity: 12,
          isOutdoor: false,
        });
        created++;
      }

      // Monthly special: Teen bouldering orientation (third Thursday, 16:15-17:15)
      if (isThirdThursdayOfMonth(dateISO)) {
        const st = parseHm("16:15");
        const en = parseHm("17:15");
        const hm = hmString(st);
        await upsertClass({
          classId: classId("climbing_teen_bouldering_orientation", dateISO, hm),
          classDefId: "cdef_climbing_teen_bouldering_orientation",
          title: "Climbing Wall: Teen Bouldering Orientation (Ages 12–17)",
          type: "group",
          skillLevel: "beginner",
          startTimeISO: startIso(dateISO, hm),
          durationMinutes: minutesBetween(st, en),
          capacity: 12,
          isOutdoor: false,
        });
        created++;
      }
    }
  }

  console.log(JSON.stringify({ ok: true, weeks: WEEKS, created }, null, 2));
}

main().catch((e) => {
  console.error(String(e?.stack ?? e?.message ?? e));
  process.exit(1);
});

