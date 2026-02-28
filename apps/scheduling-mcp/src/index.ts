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
const AccountRole = z.enum(["instructor", "customer", "both"]);

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
  return (address || "").trim().toLowerCase();
}

async function requireApiKey(request: Request, env: Env) {
  const want = (env.MCP_API_KEY ?? "").trim();
  if (!want) return;
  const got = (request.headers.get("x-api-key") ?? "").trim();
  if (got !== want) throw new Error("Unauthorized (bad x-api-key)");
}

async function ensureAccount(
  db: D1Database,
  args: {
    canonicalAddress: string;
    email?: string | null;
    displayName?: string | null;
    phoneE164?: string | null;
  },
) {
  const addr = canonicalizeAddress(args.canonicalAddress);
  if (!addr) throw new Error("Missing canonicalAddress");
  const existing = await db
    .prepare(`SELECT account_id, canonical_address, email, display_name, phone_e164 FROM accounts WHERE canonical_address = ? LIMIT 1`)
    .bind(addr)
    .first();
  if (existing && typeof (existing as any).account_id === "string") {
    return {
      accountId: String((existing as any).account_id),
      canonicalAddress: String((existing as any).canonical_address ?? addr),
      email: (existing as any).email ? String((existing as any).email) : null,
      displayName: (existing as any).display_name ? String((existing as any).display_name) : null,
      phoneE164: (existing as any).phone_e164 ? String((existing as any).phone_e164) : null,
      created: false,
    };
  }

  const accountId = crypto.randomUUID();
  const ts = nowISO();
  await db
    .prepare(
      `
      INSERT INTO accounts (account_id, canonical_address, email, display_name, phone_e164, created_at_iso, updated_at_iso)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    )
    .bind(
      accountId,
      addr,
      args.email ?? null,
      args.displayName ?? null,
      args.phoneE164 ?? null,
      ts,
      ts,
    )
    .run();

  return {
    accountId,
    canonicalAddress: addr,
    email: args.email ?? null,
    displayName: args.displayName ?? null,
    phoneE164: args.phoneE164 ?? null,
    created: true,
  };
}

async function ensureInstructor(db: D1Database, args: { accountId: string; skillsJson: string | null }) {
  const existing = await db.prepare(`SELECT instructor_id FROM instructors WHERE account_id = ? LIMIT 1`).bind(args.accountId).first();
  const ts = nowISO();
  if (existing && (existing as any).instructor_id) {
    const instructorId = String((existing as any).instructor_id);
    await db.prepare(`UPDATE instructors SET skills_json = COALESCE(?, skills_json), updated_at_iso = ? WHERE instructor_id = ?`)
      .bind(args.skillsJson, ts, instructorId)
      .run();
    return { instructorId, created: false };
  }
  const instructorId = `inst_${crypto.randomUUID()}`;
  await db
    .prepare(
      `INSERT INTO instructors (instructor_id, account_id, skills_json, created_at_iso, updated_at_iso) VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(instructorId, args.accountId, args.skillsJson, ts, ts)
    .run();
  return { instructorId, created: true };
}

async function ensureCustomer(db: D1Database, args: { accountId: string }) {
  const existing = await db.prepare(`SELECT customer_id FROM customers WHERE account_id = ? LIMIT 1`).bind(args.accountId).first();
  const ts = nowISO();
  if (existing && (existing as any).customer_id) {
    return { customerId: String((existing as any).customer_id), created: false };
  }
  const customerId = `cust_${crypto.randomUUID()}`;
  await db
    .prepare(`INSERT INTO customers (customer_id, account_id, created_at_iso, updated_at_iso) VALUES (?, ?, ?, ?)`)
    .bind(customerId, args.accountId, ts, ts)
    .run();
  return { customerId, created: true };
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
    "schedule_upsert_account",
    "Create/update an account (canonical address).",
    {
      canonicalAddress: AccountAddress,
      role: AccountRole.optional(),
      email: z.string().email().optional(),
      displayName: z.string().min(1).optional(),
      phoneE164: z.string().min(7).optional(),
      skills: z.array(z.string()).optional(),
    },
    async (args) => {
      const parsed = z
        .object({
          canonicalAddress: AccountAddress,
          role: AccountRole.optional(),
          email: z.string().email().optional(),
          displayName: z.string().min(1).optional(),
          phoneE164: z.string().min(7).optional(),
          skills: z.array(z.string()).optional(),
        })
        .parse(args);

      const account = await ensureAccount(env.DB, {
        canonicalAddress: parsed.canonicalAddress,
        email: parsed.email ?? parsed.canonicalAddress,
        displayName: parsed.displayName ?? null,
        phoneE164: parsed.phoneE164 ?? null,
      });

      const role = parsed.role ?? "customer";
      const skillsJson = parsed.skills ? JSON.stringify(parsed.skills) : null;
      let instructorId: string | null = null;
      let customerId: string | null = null;
      if (role === "instructor" || role === "both") {
        const inst = await ensureInstructor(env.DB, { accountId: account.accountId, skillsJson });
        instructorId = inst.instructorId;
      }
      if (role === "customer" || role === "both") {
        const cust = await ensureCustomer(env.DB, { accountId: account.accountId });
        customerId = cust.customerId;
      }

      return {
        content: [
          {
            type: "text",
            text: jsonText({
              account: {
                accountId: account.accountId,
                canonicalAddress: account.canonicalAddress,
                email: account.email,
                displayName: account.displayName,
                phoneE164: account.phoneE164,
              },
              instructorId,
              customerId,
            }),
          },
        ],
      };
    },
  );

  server.tool(
    "schedule_upsert_instructor",
    "Create/update an instructor. Uses an account canonical address for identity.",
    {
      canonicalAddress: AccountAddress,
      displayName: z.string().min(1),
      skills: z.array(z.string()).optional(),
    },
    async (args) => {
      const parsed = z
        .object({
          canonicalAddress: AccountAddress,
          displayName: z.string().min(1),
          skills: z.array(z.string()).optional(),
        })
        .parse(args);

      const skillsJson = parsed.skills ? JSON.stringify(parsed.skills) : null;
      const account = await ensureAccount(env.DB, {
        canonicalAddress: parsed.canonicalAddress,
        email: parsed.canonicalAddress,
        displayName: parsed.displayName,
      });
      const inst = await ensureInstructor(env.DB, { accountId: account.accountId, skillsJson });
      return {
        content: [
          {
            type: "text",
            text: jsonText({
              instructor: {
                instructorId: inst.instructorId,
                accountId: account.accountId,
                canonicalAddress: account.canonicalAddress,
                displayName: account.displayName,
                skills: parsed.skills ?? null,
              },
            }),
          },
        ],
      };
    },
  );

  server.tool("schedule_list_instructors", "List instructors.", {}, async () => {
    const res = await env.DB.prepare(
      `
      SELECT i.instructor_id, i.account_id, i.skills_json, i.created_at_iso, i.updated_at_iso,
             a.canonical_address, a.display_name, a.email, a.phone_e164
      FROM instructors i
      JOIN accounts a ON a.account_id = i.account_id
      ORDER BY a.display_name ASC
      `,
    ).all();
    const instructors = (res.results ?? []).map((r: any) => ({
      instructorId: String(r.instructor_id ?? ""),
      accountId: String(r.account_id ?? ""),
      canonicalAddress: String(r.canonical_address ?? ""),
      displayName: String(r.display_name ?? ""),
      email: r.email ? String(r.email) : null,
      phoneE164: r.phone_e164 ? String(r.phone_e164) : null,
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
    "schedule_upsert_customer",
    "Create/update a customer account (canonical address).",
    {
      canonicalAddress: AccountAddress,
      displayName: z.string().min(1).optional(),
      phoneE164: z.string().min(7).optional(),
    },
    async (args) => {
      const parsed = z
        .object({
          canonicalAddress: AccountAddress,
          displayName: z.string().min(1).optional(),
          phoneE164: z.string().min(7).optional(),
        })
        .parse(args);

      const account = await ensureAccount(env.DB, {
        canonicalAddress: parsed.canonicalAddress,
        email: parsed.canonicalAddress,
        displayName: parsed.displayName ?? null,
        phoneE164: parsed.phoneE164 ?? null,
      });
      const cust = await ensureCustomer(env.DB, { accountId: account.accountId });

      return {
        content: [
          {
            type: "text",
            text: jsonText({
              customer: {
                customerId: cust.customerId,
                accountId: account.accountId,
                canonicalAddress: account.canonicalAddress,
                displayName: account.displayName,
                email: account.email,
                phoneE164: account.phoneE164,
              },
            }),
          },
        ],
      };
    },
  );

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
    "schedule_get_class",
    "Get a class by classId.",
    { classId: z.string().min(1) },
    async (args) => {
      const parsed = z.object({ classId: z.string().min(1) }).parse(args);
      const r = await env.DB.prepare(
        `
        SELECT class_id, title, type, skill_level, start_time_iso, duration_minutes, capacity, instructor_id, is_outdoor
        FROM classes WHERE class_id = ? LIMIT 1
      `,
      )
        .bind(parsed.classId)
        .first();
      if (!r) return { content: [{ type: "text", text: jsonText({ gymClass: null }) }] };
      const gymClass = {
        classId: String((r as any).class_id ?? ""),
        title: String((r as any).title ?? ""),
        type: (r as any).type === "group" || (r as any).type === "private" ? (r as any).type : String((r as any).type ?? ""),
        skillLevel: (r as any).skill_level ? String((r as any).skill_level) : null,
        startTimeISO: String((r as any).start_time_iso ?? ""),
        durationMinutes: Number((r as any).duration_minutes ?? 0),
        capacity: Number((r as any).capacity ?? 0),
        instructorId: (r as any).instructor_id ? String((r as any).instructor_id) : null,
        isOutdoor: Boolean(Number((r as any).is_outdoor ?? 0)),
      };
      return { content: [{ type: "text", text: jsonText({ gymClass }) }] };
    },
  );

  server.tool(
    "schedule_class_availability",
    "Get seat availability for a class (capacity, reserved, seatsLeft).",
    { classId: z.string().min(1) },
    async (args) => {
      const parsed = z.object({ classId: z.string().min(1) }).parse(args);
      const cls = await env.DB.prepare(`SELECT class_id, capacity FROM classes WHERE class_id = ? LIMIT 1`).bind(parsed.classId).first();
      if (!cls) return { content: [{ type: "text", text: jsonText({ error: "Unknown classId" }) }] };
      const capacity = Number((cls as any).capacity ?? 0);
      const current = await env.DB.prepare(`SELECT COUNT(*) as c FROM reservations WHERE class_id = ? AND status = 'active'`).bind(parsed.classId).first();
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
      customerCanonicalAddress: AccountAddress,
      customerDisplayName: z.string().min(1).optional(),
    },
    async (args) => {
      const parsed = z
        .object({
          classId: z.string().min(1),
          customerCanonicalAddress: AccountAddress,
          customerDisplayName: z.string().min(1).optional(),
        })
        .parse(args);

      const cls = await env.DB.prepare(`SELECT class_id, capacity FROM classes WHERE class_id = ? LIMIT 1`)
        .bind(parsed.classId)
        .first();
      if (!cls) throw new Error("Unknown classId");

      const capacity = Number((cls as any).capacity ?? NaN);
      if (!Number.isFinite(capacity) || capacity <= 0) throw new Error("Bad capacity");

      const account = await ensureAccount(env.DB, {
        canonicalAddress: parsed.customerCanonicalAddress,
        email: parsed.customerCanonicalAddress,
        displayName: parsed.customerDisplayName ?? null,
      });
      await ensureCustomer(env.DB, { accountId: account.accountId });

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
          INSERT INTO reservations (reservation_id, class_id, customer_account_id, status, reserved_at_iso)
          VALUES (?, ?, ?, 'active', ?)
        `,
        )
          .bind(reservationId, parsed.classId, account.accountId, ts)
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
                customerAccountId: account.accountId,
                customerCanonicalAddress: account.canonicalAddress,
                customerDisplayName: account.displayName,
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
    {
      classId: z.string().optional(),
      customerCanonicalAddress: AccountAddress.optional(),
      status: z.enum(["active", "cancelled"]).optional(),
    },
    async (args) => {
      const parsed = z
        .object({
          classId: z.string().optional(),
          customerCanonicalAddress: AccountAddress.optional(),
          status: z.enum(["active", "cancelled"]).optional(),
        })
        .parse(args);

      const canonical = parsed.customerCanonicalAddress ? canonicalizeAddress(parsed.customerCanonicalAddress) : null;
      let accountId: string | null = null;
      if (canonical) {
        const acc = await env.DB.prepare(`SELECT account_id FROM accounts WHERE canonical_address = ? LIMIT 1`).bind(canonical).first();
        accountId = acc && (acc as any).account_id ? String((acc as any).account_id) : null;
      }

      const res = await env.DB.prepare(
        `
        SELECT r.reservation_id, r.class_id, r.customer_account_id, r.status, r.reserved_at_iso, r.cancelled_at_iso,
               a.canonical_address, a.display_name
        FROM reservations
        JOIN accounts a ON a.account_id = r.customer_account_id
        WHERE (? IS NULL OR r.class_id = ?)
          AND (? IS NULL OR r.customer_account_id = ?)
          AND (? IS NULL OR r.status = ?)
        ORDER BY reserved_at_iso DESC
      `,
      )
        .bind(
          parsed.classId ?? null,
          parsed.classId ?? null,
          accountId,
          accountId,
          parsed.status ?? null,
          parsed.status ?? null,
        )
        .all();

      const reservations = (res.results ?? []).map((r: any) => ({
        reservationId: String(r.reservation_id ?? ""),
        classId: String(r.class_id ?? ""),
        customerAccountId: String(r.customer_account_id ?? ""),
        customerCanonicalAddress: String(r.canonical_address ?? ""),
        customerDisplayName: r.display_name ? String(r.display_name) : null,
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

