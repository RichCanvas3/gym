import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export type Env = {
  // Shared secret (optional). If set, caller must send header `x-api-key: <value>`.
  MCP_API_KEY?: string;
  DB: D1Database;
};

const ClassType = z.enum(["group", "private"]);

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

async function requireApiKey(request: Request, env: Env) {
  const want = (env.MCP_API_KEY ?? "").trim();
  if (!want) return;
  const got = (request.headers.get("x-api-key") ?? "").trim();
  if (got !== want) throw new Error("Unauthorized (bad x-api-key)");
}

async function checkInstructorConflict(db: D1Database, args: { instructorId: string; startUnix: number; endUnix: number; excludeClassId?: string }) {
  const res = await db
    .prepare(
      `
      SELECT class_id, start_time_iso, start_unix, end_unix
      FROM classes
      WHERE instructor_id = ?
        AND (? < end_unix AND start_unix < ?)
        AND (? IS NULL OR class_id != ?)
      LIMIT 1
    `,
    )
    .bind(args.instructorId, args.startUnix, args.endUnix, args.excludeClassId ?? null, args.excludeClassId ?? null)
    .all();

  if (res.results?.length) {
    const c = res.results[0] as any;
    throw new Error(`Instructor scheduling conflict with class ${String(c.class_id ?? "")} at ${String(c.start_time_iso ?? "")}`);
  }
}

function createServer(env: Env) {
  const server = new McpServer({
    name: "Gym Scheduling MCP (D1)",
    version: "0.1.0",
  });

  server.tool(
    "schedule_upsert_instructor",
    "Create/update an instructor (skills optional).",
    {
      instructorId: z.string().min(1),
      name: z.string().min(1),
      skills: z.array(z.string()).optional(),
    },
    async (args) => {
      const parsed = z
        .object({
          instructorId: z.string().min(1),
          name: z.string().min(1),
          skills: z.array(z.string()).optional(),
        })
        .parse(args);

      const ts = nowISO();
      const skillsJson = parsed.skills ? JSON.stringify(parsed.skills) : null;

      await env.DB.prepare(
        `
        INSERT INTO instructors (instructor_id, name, skills_json, created_at_iso, updated_at_iso)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(instructor_id) DO UPDATE SET
          name=excluded.name,
          skills_json=excluded.skills_json,
          updated_at_iso=excluded.updated_at_iso
      `,
      )
        .bind(parsed.instructorId, parsed.name, skillsJson, ts, ts)
        .run();

      return { content: [{ type: "text", text: jsonText({ instructor: parsed }) }] };
    },
  );

  server.tool("schedule_list_instructors", "List instructors.", {}, async () => {
    const res = await env.DB.prepare(`SELECT instructor_id, name, skills_json, created_at_iso, updated_at_iso FROM instructors ORDER BY name ASC`).all();
    const instructors = (res.results ?? []).map((r: any) => ({
      instructorId: String(r.instructor_id ?? ""),
      name: String(r.name ?? ""),
      skills: (() => {
        try {
          const v = r.skills_json ? JSON.parse(String(r.skills_json)) : null;
          return Array.isArray(v) ? (v as unknown[]) : undefined;
        } catch {
          return undefined;
        }
      })(),
      createdAtISO: String(r.created_at_iso ?? ""),
      updatedAtISO: String(r.updated_at_iso ?? ""),
    }));
    return { content: [{ type: "text", text: jsonText({ instructors }) }] };
  });

  server.tool(
    "schedule_create_class",
    "Create/update a class (group/private) with capacity and time. Optionally assign an instructor (conflicts checked).",
    {
      classId: z.string().min(1),
      title: z.string().min(1),
      type: ClassType,
      startTimeISO: z.string().min(8),
      durationMinutes: z.number().int().positive(),
      capacity: z.number().int().positive(),
      instructorId: z.string().min(1).optional(),
      skillLevel: z.enum(["beginner", "intermediate", "advanced"]).optional(),
      isOutdoor: z.boolean().optional(),
    },
    async (args) => {
      const parsed = z
        .object({
          classId: z.string().min(1),
          title: z.string().min(1),
          type: ClassType,
          startTimeISO: z.string().min(8),
          durationMinutes: z.number().int().positive(),
          capacity: z.number().int().positive(),
          instructorId: z.string().min(1).optional(),
          skillLevel: z.enum(["beginner", "intermediate", "advanced"]).optional(),
          isOutdoor: z.boolean().optional(),
        })
        .parse(args);

      const startUnix = parseIsoToUnixSeconds(parsed.startTimeISO);
      const endUnix = computeEndUnix(startUnix, parsed.durationMinutes);
      const ts = nowISO();

      if (parsed.instructorId) {
        const exists = await env.DB.prepare(`SELECT instructor_id FROM instructors WHERE instructor_id = ? LIMIT 1`)
          .bind(parsed.instructorId)
          .first();
        if (!exists) throw new Error("Unknown instructorId");
        await checkInstructorConflict(env.DB, {
          instructorId: parsed.instructorId,
          startUnix,
          endUnix,
          excludeClassId: parsed.classId,
        });
      }

      await env.DB.prepare(
        `
        INSERT INTO classes (
          class_id, title, type, skill_level,
          start_time_iso, start_unix, end_unix, duration_minutes,
          capacity, instructor_id, is_outdoor,
          created_at_iso, updated_at_iso
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(class_id) DO UPDATE SET
          title=excluded.title,
          type=excluded.type,
          skill_level=excluded.skill_level,
          start_time_iso=excluded.start_time_iso,
          start_unix=excluded.start_unix,
          end_unix=excluded.end_unix,
          duration_minutes=excluded.duration_minutes,
          capacity=excluded.capacity,
          instructor_id=excluded.instructor_id,
          is_outdoor=excluded.is_outdoor,
          updated_at_iso=excluded.updated_at_iso
      `,
      )
        .bind(
          parsed.classId,
          parsed.title,
          parsed.type,
          parsed.skillLevel ?? null,
          parsed.startTimeISO,
          startUnix,
          endUnix,
          parsed.durationMinutes,
          parsed.capacity,
          parsed.instructorId ?? null,
          parsed.isOutdoor ? 1 : 0,
          ts,
          ts,
        )
        .run();

      return {
        content: [
          {
            type: "text",
            text: jsonText({
              gymClass: {
                classId: parsed.classId,
                title: parsed.title,
                type: parsed.type,
                skillLevel: parsed.skillLevel ?? null,
                startTimeISO: parsed.startTimeISO,
                durationMinutes: parsed.durationMinutes,
                capacity: parsed.capacity,
                instructorId: parsed.instructorId ?? null,
                isOutdoor: Boolean(parsed.isOutdoor),
              },
            }),
          },
        ],
      };
    },
  );

  server.tool(
    "schedule_assign_instructor",
    "Assign an instructor to an existing class (conflicts checked).",
    { classId: z.string().min(1), instructorId: z.string().min(1) },
    async (args) => {
      const parsed = z.object({ classId: z.string().min(1), instructorId: z.string().min(1) }).parse(args);

      const cls = await env.DB.prepare(
        `SELECT class_id, start_time_iso, start_unix, end_unix, duration_minutes FROM classes WHERE class_id = ? LIMIT 1`,
      )
        .bind(parsed.classId)
        .first();
      if (!cls) throw new Error("Unknown classId");

      const inst = await env.DB.prepare(`SELECT instructor_id FROM instructors WHERE instructor_id = ? LIMIT 1`)
        .bind(parsed.instructorId)
        .first();
      if (!inst) throw new Error("Unknown instructorId");

      const startUnix = Number((cls as any).start_unix ?? NaN);
      const endUnix = Number((cls as any).end_unix ?? NaN);
      if (!Number.isFinite(startUnix) || !Number.isFinite(endUnix)) throw new Error("Bad class time data");

      await checkInstructorConflict(env.DB, {
        instructorId: parsed.instructorId,
        startUnix,
        endUnix,
        excludeClassId: parsed.classId,
      });

      const ts = nowISO();
      await env.DB.prepare(`UPDATE classes SET instructor_id = ?, updated_at_iso = ? WHERE class_id = ?`)
        .bind(parsed.instructorId, ts, parsed.classId)
        .run();

      return { content: [{ type: "text", text: jsonText({ assigned: true }) }] };
    },
  );

  server.tool(
    "schedule_list_classes",
    "List classes (optional filters).",
    {
      fromISO: z.string().optional(),
      toISO: z.string().optional(),
      type: ClassType.optional(),
    },
    async (args) => {
      const parsed = z
        .object({
          fromISO: z.string().optional(),
          toISO: z.string().optional(),
          type: ClassType.optional(),
        })
        .parse(args);

      const fromUnix = parsed.fromISO ? parseIsoToUnixSeconds(parsed.fromISO) : null;
      const toUnix = parsed.toISO ? parseIsoToUnixSeconds(parsed.toISO) : null;

      const res = await env.DB.prepare(
        `
        SELECT
          class_id, title, type, skill_level, start_time_iso, duration_minutes, capacity, instructor_id, is_outdoor
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
        title: String(r.title ?? ""),
        type: r.type === "group" || r.type === "private" ? r.type : String(r.type ?? ""),
        skillLevel: r.skill_level ? String(r.skill_level) : null,
        startTimeISO: String(r.start_time_iso ?? ""),
        durationMinutes: Number(r.duration_minutes ?? 0),
        capacity: Number(r.capacity ?? 0),
        instructorId: r.instructor_id ? String(r.instructor_id) : null,
        isOutdoor: Boolean(Number(r.is_outdoor ?? 0)),
      }));

      return { content: [{ type: "text", text: jsonText({ classes }) }] };
    },
  );

  server.tool(
    "schedule_reserve_seat",
    "Reserve a seat in a class (capacity enforced).",
    { classId: z.string().min(1), customerEmail: z.string().email(), customerName: z.string().optional() },
    async (args) => {
      const parsed = z
        .object({
          classId: z.string().min(1),
          customerEmail: z.string().email(),
          customerName: z.string().optional(),
        })
        .parse(args);

      const cls = await env.DB.prepare(`SELECT class_id, capacity FROM classes WHERE class_id = ? LIMIT 1`)
        .bind(parsed.classId)
        .first();
      if (!cls) throw new Error("Unknown classId");

      const capacity = Number((cls as any).capacity ?? NaN);
      if (!Number.isFinite(capacity) || capacity <= 0) throw new Error("Bad capacity");

      // Best-effort atomicity: begin/commit around count+insert (SQLite transaction).
      const reservationId = `res_${crypto.randomUUID()}`;
      const ts = nowISO();
      await env.DB.exec("BEGIN IMMEDIATE");
      try {
        const current = await env.DB.prepare(
          `SELECT COUNT(*) as c FROM reservations WHERE class_id = ? AND status = 'active'`,
        )
          .bind(parsed.classId)
          .first();
        const count = Number((current as any)?.c ?? 0);
        if (count >= capacity) throw new Error("No seats left");

        await env.DB.prepare(
          `
          INSERT INTO reservations (reservation_id, class_id, customer_email, customer_name, status, reserved_at_iso)
          VALUES (?, ?, ?, ?, 'active', ?)
        `,
        )
          .bind(reservationId, parsed.classId, parsed.customerEmail, parsed.customerName ?? null, ts)
          .run();

        await env.DB.exec("COMMIT");
      } catch (e) {
        await env.DB.exec("ROLLBACK");
        throw e;
      }

      return {
        content: [
          {
            type: "text",
            text: jsonText({
              reservation: {
                reservationId,
                classId: parsed.classId,
                customerEmail: parsed.customerEmail,
                customerName: parsed.customerName ?? null,
                status: "active",
                reservedAtISO: ts,
              },
            }),
          },
        ],
      };
    },
  );

  server.tool(
    "schedule_cancel_reservation",
    "Cancel an existing reservation by reservationId.",
    { reservationId: z.string().min(1) },
    async (args) => {
      const parsed = z.object({ reservationId: z.string().min(1) }).parse(args);
      const ts = nowISO();
      const res = await env.DB.prepare(
        `UPDATE reservations SET status = 'cancelled', cancelled_at_iso = ? WHERE reservation_id = ? AND status = 'active'`,
      )
        .bind(ts, parsed.reservationId)
        .run();
      const cancelled = Number(res.meta?.changes ?? 0) > 0;
      return { content: [{ type: "text", text: jsonText({ cancelled }) }] };
    },
  );

  server.tool(
    "schedule_list_reservations",
    "List reservations (optional filters).",
    { classId: z.string().optional(), customerEmail: z.string().email().optional(), status: z.enum(["active", "cancelled"]).optional() },
    async (args) => {
      const parsed = z
        .object({
          classId: z.string().optional(),
          customerEmail: z.string().email().optional(),
          status: z.enum(["active", "cancelled"]).optional(),
        })
        .parse(args);

      const res = await env.DB.prepare(
        `
        SELECT reservation_id, class_id, customer_email, customer_name, status, reserved_at_iso, cancelled_at_iso
        FROM reservations
        WHERE (? IS NULL OR class_id = ?)
          AND (? IS NULL OR customer_email = ?)
          AND (? IS NULL OR status = ?)
        ORDER BY reserved_at_iso DESC
      `,
      )
        .bind(
          parsed.classId ?? null,
          parsed.classId ?? null,
          parsed.customerEmail ?? null,
          parsed.customerEmail ?? null,
          parsed.status ?? null,
          parsed.status ?? null,
        )
        .all();

      const reservations = (res.results ?? []).map((r: any) => ({
        reservationId: String(r.reservation_id ?? ""),
        classId: String(r.class_id ?? ""),
        customerEmail: String(r.customer_email ?? ""),
        customerName: r.customer_name ? String(r.customer_name) : null,
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

    // Create a new server instance per request (required by MCP SDK >= 1.26.0).
    const server = createServer(env);
    return createMcpHandler(server, { route: "/mcp" })(request, env, ctx);
  },
};

