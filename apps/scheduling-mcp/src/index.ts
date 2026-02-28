import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export type Env = {
  // Shared secret (optional). If set, caller must send header `x-api-key: <value>`.
  MCP_API_KEY?: string;
  DB: D1Database;
};

const ClassType = z.enum(["group", "private"]);
const AccountAddress = z.string().min(3);

function nowISO() {
  return new Date().toISOString();
}

function parseIsoToUnixSeconds(iso: string) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new Error("Invalid startTimeISO");
  return Math.floor(ms / 1000);
}

function computeEndUnix(startUnix: number, durationMinutes: number) {
  return startUnix + Math.floor(durationMinutes * 60);
}

function jsonText(obj: unknown) {
  return JSON.stringify(obj, null, 2);
}

function canonicalizeAddress(address: string) {
  // Canonical addresses are NOT emails; don't mutate case.
  return (address || "").trim();
}

async function requireApiKey(request: Request, env: Env) {
  const want = (env.MCP_API_KEY ?? "").trim();
  if (!want) return;
  const got = (request.headers.get("x-api-key") ?? "").trim();
  if (got !== want) throw new Error("Unauthorized (bad x-api-key)");
}

async function upsertInstructor(
  db: D1Database,
  args: { instructorAccountAddress: string; displayName?: string | null; skillsJson?: string | null },
) {
  const addr = canonicalizeAddress(args.instructorAccountAddress);
  if (!addr) throw new Error("Missing instructorAccountAddress");
  const existing = await db
    .prepare(`SELECT instructor_id FROM instructors WHERE instructor_account_address = ? LIMIT 1`)
    .bind(addr)
    .first();
  const ts = nowISO();
  if (existing && (existing as any).instructor_id) {
    const instructorId = String((existing as any).instructor_id);
    await db
      .prepare(
        `UPDATE instructors
         SET display_name = COALESCE(?, display_name),
             skills_json = COALESCE(?, skills_json),
             updated_at_iso = ?
         WHERE instructor_id = ?`,
      )
      .bind(args.displayName ?? null, args.skillsJson ?? null, ts, instructorId)
      .run();
    return { instructorId, instructorAccountAddress: addr, created: false };
  }

  const instructorId = `inst_${crypto.randomUUID()}`;
  await db
    .prepare(
      `INSERT INTO instructors (instructor_id, instructor_account_address, display_name, skills_json, created_at_iso, updated_at_iso)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(instructorId, addr, args.displayName ?? null, args.skillsJson ?? null, ts, ts)
    .run();
  return { instructorId, instructorAccountAddress: addr, created: true };
}

async function checkInstructorConflict(
  db: D1Database,
  args: { instructorAccountAddress: string; startUnix: number; endUnix: number; excludeClassId?: string },
) {
  const res = await db
    .prepare(
      `
      SELECT class_id, start_time_iso, start_unix, end_unix
      FROM classes
      WHERE instructor_account_address = ?
        AND (? < end_unix AND start_unix < ?)
        AND (? IS NULL OR class_id != ?)
      LIMIT 1
    `,
    )
    .bind(
      args.instructorAccountAddress,
      args.startUnix,
      args.endUnix,
      args.excludeClassId ?? null,
      args.excludeClassId ?? null,
    )
    .all();

  if (res.results?.length) {
    const c = res.results[0] as any;
    throw new Error(
      `Instructor scheduling conflict with class ${String(c.class_id ?? "")} at ${String(c.start_time_iso ?? "")}`,
    );
  }
}

function createServer(env: Env) {
  const server = new McpServer({
    name: "Gym Scheduling MCP (D1)",
    version: "0.2.0",
  });

  server.tool(
    "schedule_upsert_instructor",
    "Upsert an instructor record keyed by canonical account address (scheduler-only).",
    {
      instructorAccountAddress: AccountAddress,
      displayName: z.string().min(1).optional(),
      skills: z.array(z.string()).optional(),
    },
    async (args) => {
      const parsed = z
        .object({
          instructorAccountAddress: AccountAddress,
          displayName: z.string().min(1).optional(),
          skills: z.array(z.string()).optional(),
        })
        .parse(args);
      const inst = await upsertInstructor(env.DB, {
        instructorAccountAddress: parsed.instructorAccountAddress,
        displayName: parsed.displayName ?? null,
        skillsJson: parsed.skills ? JSON.stringify(parsed.skills) : null,
      });
      return { content: [{ type: "text", text: jsonText({ instructor: inst }) }] };
    },
  );

  server.tool("schedule_list_instructors", "List instructors.", {}, async () => {
    const res = await env.DB.prepare(
      `SELECT instructor_id, instructor_account_address, display_name, skills_json FROM instructors ORDER BY display_name ASC`,
    ).all();
    const instructors = (res.results ?? []).map((r: any) => ({
      instructorId: String(r.instructor_id ?? ""),
      instructorAccountAddress: String(r.instructor_account_address ?? ""),
      displayName: r.display_name ? String(r.display_name) : null,
      skills: (() => {
        try {
          const v = r.skills_json ? JSON.parse(String(r.skills_json)) : null;
          return Array.isArray(v) ? v : [];
        } catch {
          return [];
        }
      })(),
    }));
    return { content: [{ type: "text", text: jsonText({ instructors }) }] };
  });

  server.tool(
    "schedule_create_class",
    "Create or update a class occurrence (conflicts checked if instructor provided).",
    {
      classId: z.string().min(1).optional(),
      classDefId: z.string().min(1).optional(),
      title: z.string().min(1),
      type: ClassType,
      skillLevel: z.enum(["beginner", "intermediate", "advanced"]).optional(),
      startTimeISO: z.string().min(10),
      durationMinutes: z.number().int().positive(),
      capacity: z.number().int().positive(),
      instructorAccountAddress: AccountAddress.optional(),
      isOutdoor: z.boolean().optional(),
    },
    async (args) => {
      const parsed = z
        .object({
          classId: z.string().min(1).optional(),
          classDefId: z.string().min(1).optional(),
          title: z.string().min(1),
          type: ClassType,
          skillLevel: z.enum(["beginner", "intermediate", "advanced"]).optional(),
          startTimeISO: z.string().min(10),
          durationMinutes: z.number().int().positive(),
          capacity: z.number().int().positive(),
          instructorAccountAddress: AccountAddress.optional(),
          isOutdoor: z.boolean().optional(),
        })
        .parse(args);

      const classId = parsed.classId ?? `class_${crypto.randomUUID()}`;
      const ts = nowISO();
      const startUnix = parseIsoToUnixSeconds(parsed.startTimeISO);
      const endUnix = computeEndUnix(startUnix, parsed.durationMinutes);
      const instructorAddr = parsed.instructorAccountAddress ? canonicalizeAddress(parsed.instructorAccountAddress) : null;

      if (instructorAddr) {
        const inst = await env.DB.prepare(`SELECT instructor_id FROM instructors WHERE instructor_account_address = ? LIMIT 1`)
          .bind(instructorAddr)
          .first();
        if (!inst) throw new Error("Unknown instructorAccountAddress (upsert instructor first)");
        await checkInstructorConflict(env.DB, {
          instructorAccountAddress: instructorAddr,
          startUnix,
          endUnix,
          excludeClassId: classId,
        });
      }

      await env.DB.prepare(
        `
        INSERT INTO classes (
          class_id, class_def_id, title, type, skill_level, start_time_iso, start_unix, end_unix, duration_minutes, capacity,
          instructor_account_address, is_outdoor, created_at_iso, updated_at_iso
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(class_id) DO UPDATE SET
          class_def_id=excluded.class_def_id,
          title=excluded.title,
          type=excluded.type,
          skill_level=excluded.skill_level,
          start_time_iso=excluded.start_time_iso,
          start_unix=excluded.start_unix,
          end_unix=excluded.end_unix,
          duration_minutes=excluded.duration_minutes,
          capacity=excluded.capacity,
          instructor_account_address=excluded.instructor_account_address,
          is_outdoor=excluded.is_outdoor,
          updated_at_iso=excluded.updated_at_iso
      `,
      )
        .bind(
          classId,
          parsed.classDefId ?? null,
          parsed.title,
          parsed.type,
          parsed.skillLevel ?? null,
          parsed.startTimeISO,
          startUnix,
          endUnix,
          parsed.durationMinutes,
          parsed.capacity,
          instructorAddr,
          parsed.isOutdoor ? 1 : 0,
          ts,
          ts,
        )
        .run();

      return { content: [{ type: "text", text: jsonText({ classId }) }] };
    },
  );

  server.tool(
    "schedule_assign_instructor",
    "Assign an instructor to an existing class (conflicts checked).",
    { classId: z.string().min(1), instructorAccountAddress: AccountAddress },
    async (args) => {
      const parsed = z.object({ classId: z.string().min(1), instructorAccountAddress: AccountAddress }).parse(args);
      const addr = canonicalizeAddress(parsed.instructorAccountAddress);

      const cls = await env.DB.prepare(`SELECT class_id, start_unix, end_unix FROM classes WHERE class_id = ? LIMIT 1`)
        .bind(parsed.classId)
        .first();
      if (!cls) throw new Error("Unknown classId");

      const inst = await env.DB.prepare(`SELECT instructor_id FROM instructors WHERE instructor_account_address = ? LIMIT 1`)
        .bind(addr)
        .first();
      if (!inst) throw new Error("Unknown instructorAccountAddress (upsert instructor first)");

      const startUnix = Number((cls as any).start_unix ?? NaN);
      const endUnix = Number((cls as any).end_unix ?? NaN);
      if (!Number.isFinite(startUnix) || !Number.isFinite(endUnix)) throw new Error("Bad class time data");

      await checkInstructorConflict(env.DB, { instructorAccountAddress: addr, startUnix, endUnix, excludeClassId: parsed.classId });

      const ts = nowISO();
      await env.DB.prepare(`UPDATE classes SET instructor_account_address = ?, updated_at_iso = ? WHERE class_id = ?`)
        .bind(addr, ts, parsed.classId)
        .run();

      return { content: [{ type: "text", text: jsonText({ assigned: true }) }] };
    },
  );

  server.tool(
    "schedule_list_classes",
    "List classes (optional filters).",
    { fromISO: z.string().optional(), toISO: z.string().optional(), type: ClassType.optional() },
    async (args) => {
      const parsed = z.object({ fromISO: z.string().optional(), toISO: z.string().optional(), type: ClassType.optional() }).parse(args);
      const fromUnix = parsed.fromISO ? parseIsoToUnixSeconds(parsed.fromISO) : null;
      const toUnix = parsed.toISO ? parseIsoToUnixSeconds(parsed.toISO) : null;

      const res = await env.DB.prepare(
        `
        SELECT class_id, class_def_id, title, type, skill_level, start_time_iso, duration_minutes, capacity, instructor_account_address, is_outdoor
        FROM classes
        WHERE (? IS NULL OR start_unix >= ?)
          AND (? IS NULL OR start_unix <= ?)
          AND (? IS NULL OR type = ?)
        ORDER BY start_unix ASC
      `,
      )
        .bind(fromUnix, fromUnix, toUnix, toUnix, parsed.type ?? null, parsed.type ?? null)
        .all();

      const classes = (res.results ?? []).map((r: any) => ({
        classId: String(r.class_id ?? ""),
        classDefId: r.class_def_id ? String(r.class_def_id) : null,
        title: String(r.title ?? ""),
        type: r.type === "group" || r.type === "private" ? r.type : String(r.type ?? ""),
        skillLevel: r.skill_level ? String(r.skill_level) : null,
        startTimeISO: String(r.start_time_iso ?? ""),
        durationMinutes: Number(r.duration_minutes ?? 0),
        capacity: Number(r.capacity ?? 0),
        instructorAccountAddress: r.instructor_account_address ? String(r.instructor_account_address) : null,
        instructorId: r.instructor_account_address ? String(r.instructor_account_address) : null, // backward-compatible
        isOutdoor: Boolean(Number(r.is_outdoor ?? 0)),
      }));

      return { content: [{ type: "text", text: jsonText({ classes }) }] };
    },
  );

  server.tool("schedule_get_class", "Get a class by classId.", { classId: z.string().min(1) }, async (args) => {
    const parsed = z.object({ classId: z.string().min(1) }).parse(args);
    const r = await env.DB.prepare(
      `
      SELECT class_id, class_def_id, title, type, skill_level, start_time_iso, duration_minutes, capacity, instructor_account_address, is_outdoor
      FROM classes WHERE class_id = ? LIMIT 1
    `,
    )
      .bind(parsed.classId)
      .first();
    if (!r) return { content: [{ type: "text", text: jsonText({ gymClass: null }) }] };
    const gymClass = {
      classId: String((r as any).class_id ?? ""),
      classDefId: (r as any).class_def_id ? String((r as any).class_def_id) : null,
      title: String((r as any).title ?? ""),
      type:
        (r as any).type === "group" || (r as any).type === "private" ? (r as any).type : String((r as any).type ?? ""),
      skillLevel: (r as any).skill_level ? String((r as any).skill_level) : null,
      startTimeISO: String((r as any).start_time_iso ?? ""),
      durationMinutes: Number((r as any).duration_minutes ?? 0),
      capacity: Number((r as any).capacity ?? 0),
      instructorAccountAddress: (r as any).instructor_account_address ? String((r as any).instructor_account_address) : null,
      instructorId: (r as any).instructor_account_address ? String((r as any).instructor_account_address) : null, // backward-compatible
      isOutdoor: Boolean(Number((r as any).is_outdoor ?? 0)),
    };
    return { content: [{ type: "text", text: jsonText({ gymClass }) }] };
  });

  server.tool(
    "schedule_class_availability",
    "Get seat availability for a class (capacity, reserved, seatsLeft).",
    { classId: z.string().min(1) },
    async (args) => {
      const parsed = z.object({ classId: z.string().min(1) }).parse(args);
      const cls = await env.DB.prepare(`SELECT class_id, capacity FROM classes WHERE class_id = ? LIMIT 1`)
        .bind(parsed.classId)
        .first();
      if (!cls) return { content: [{ type: "text", text: jsonText({ error: "Unknown classId" }) }] };
      const capacity = Number((cls as any).capacity ?? 0);
      const current = await env.DB.prepare(`SELECT COUNT(*) as c FROM reservations WHERE class_id = ? AND status = 'active'`)
        .bind(parsed.classId)
        .first();
      const reserved = Number((current as any)?.c ?? 0);
      const seatsLeft = Math.max(0, capacity - reserved);
      return { content: [{ type: "text", text: jsonText({ classId: parsed.classId, capacity, reserved, seatsLeft }) }] };
    },
  );

  server.tool(
    "schedule_reserve_seat",
    "Reserve a seat in a class (capacity enforced).",
    {
      classId: z.string().min(1),
      customerAccountAddress: AccountAddress.optional(),
      customerCanonicalAddress: AccountAddress.optional(), // backward-compatible
    },
    async (args) => {
      const parsed = z
        .object({
          classId: z.string().min(1),
          customerAccountAddress: AccountAddress.optional(),
          customerCanonicalAddress: AccountAddress.optional(),
        })
        .parse(args);

      const customerAddr = canonicalizeAddress(parsed.customerAccountAddress ?? parsed.customerCanonicalAddress ?? "");
      if (!customerAddr) throw new Error("Missing customerAccountAddress");

      const cls = await env.DB.prepare(`SELECT class_id, capacity FROM classes WHERE class_id = ? LIMIT 1`)
        .bind(parsed.classId)
        .first();
      if (!cls) throw new Error("Unknown classId");

      const reservationId = `res_${crypto.randomUUID()}`;
      const ts = nowISO();
      const ins = await env.DB.prepare(
        `
        INSERT INTO reservations (reservation_id, class_id, customer_account_address, status, reserved_at_iso)
        SELECT ?, ?, ?, 'active', ?
        WHERE (SELECT COUNT(*) FROM reservations WHERE class_id = ? AND status = 'active')
              < (SELECT capacity FROM classes WHERE class_id = ?)
      `,
      )
        .bind(reservationId, parsed.classId, customerAddr, ts, parsed.classId, parsed.classId)
        .run();

      const created = Number(ins.meta?.changes ?? 0) > 0;
      if (!created) throw new Error("No seats left");

      return {
        content: [
          {
            type: "text",
            text: jsonText({
              reservation: {
                reservationId,
                classId: parsed.classId,
                customerAccountAddress: customerAddr,
                status: "active",
                reservedAtISO: ts,
              },
            }),
          },
        ],
      };
    },
  );

  server.tool("schedule_cancel_reservation", "Cancel an existing reservation by reservationId.", { reservationId: z.string().min(1) }, async (args) => {
    const parsed = z.object({ reservationId: z.string().min(1) }).parse(args);
    const ts = nowISO();
    const res = await env.DB.prepare(`UPDATE reservations SET status = 'cancelled', cancelled_at_iso = ? WHERE reservation_id = ? AND status = 'active'`)
      .bind(ts, parsed.reservationId)
      .run();
    const cancelled = Number(res.meta?.changes ?? 0) > 0;
    return { content: [{ type: "text", text: jsonText({ cancelled }) }] };
  });

  server.tool(
    "schedule_list_reservations",
    "List reservations (optional filters).",
    { classId: z.string().optional(), customerAccountAddress: AccountAddress.optional(), status: z.enum(["active", "cancelled"]).optional() },
    async (args) => {
      const parsed = z
        .object({
          classId: z.string().optional(),
          customerAccountAddress: AccountAddress.optional(),
          status: z.enum(["active", "cancelled"]).optional(),
        })
        .parse(args);
      const addr = parsed.customerAccountAddress ? canonicalizeAddress(parsed.customerAccountAddress) : null;
      const res = await env.DB.prepare(
        `
        SELECT reservation_id, class_id, customer_account_address, status, reserved_at_iso, cancelled_at_iso
        FROM reservations
        WHERE (? IS NULL OR class_id = ?)
          AND (? IS NULL OR customer_account_address = ?)
          AND (? IS NULL OR status = ?)
        ORDER BY reserved_at_iso DESC
      `,
      )
        .bind(
          parsed.classId ?? null,
          parsed.classId ?? null,
          addr,
          addr,
          parsed.status ?? null,
          parsed.status ?? null,
        )
        .all();

      const reservations = (res.results ?? []).map((r: any) => ({
        reservationId: String(r.reservation_id ?? ""),
        classId: String(r.class_id ?? ""),
        customerAccountAddress: String(r.customer_account_address ?? ""),
        status: String(r.status ?? ""),
        reservedAtISO: String(r.reserved_at_iso ?? ""),
        cancelledAtISO: r.cancelled_at_iso ? String(r.cancelled_at_iso) : null,
      }));
      return { content: [{ type: "text", text: jsonText({ reservations }) }] };
    },
  );

  return server;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    try {
      await requireApiKey(request, env);
    } catch {
      return new Response("Unauthorized", { status: 401 });
    }
    const server = createServer(env);
    return createMcpHandler(server, { route: "/mcp" })(request, env, ctx);
  },
};

