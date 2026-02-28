import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export type Env = {
  MCP_API_KEY?: string;
  DB: D1Database;
};

const AccountAddress = z.string().min(3);

function nowISO() {
  return new Date().toISOString();
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

function canonicalizeAddress(address: string) {
  return (address || "").trim();
}

async function ensureAccount(
  db: D1Database,
  args: { canonicalAddress: string; email?: string | null; displayName?: string | null; phoneE164?: string | null },
) {
  const canonical = canonicalizeAddress(args.canonicalAddress);
  if (!canonical) throw new Error("Missing canonicalAddress");

  const existing = await db
    .prepare(
      `SELECT account_id, canonical_address, email, display_name, phone_e164 FROM accounts WHERE canonical_address = ? LIMIT 1`,
    )
    .bind(canonical)
    .first();
  if (existing && typeof (existing as any).account_id === "string") {
    const accountId = String((existing as any).account_id);
    const ts = nowISO();
    await db
      .prepare(
        `UPDATE accounts SET email = COALESCE(?, email), display_name = COALESCE(?, display_name), phone_e164 = COALESCE(?, phone_e164), updated_at_iso = ? WHERE account_id = ?`,
      )
      .bind(args.email ?? null, args.displayName ?? null, args.phoneE164 ?? null, ts, accountId)
      .run();
    return { accountId, canonicalAddress: canonical, created: false };
  }

  const accountId = `acc_${crypto.randomUUID()}`;
  const ts = nowISO();
  await db
    .prepare(
      `INSERT INTO accounts (account_id, canonical_address, email, display_name, phone_e164, created_at_iso, updated_at_iso)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(accountId, canonical, args.email ?? null, args.displayName ?? null, args.phoneE164 ?? null, ts, ts)
    .run();
  return { accountId, canonicalAddress: canonical, created: true };
}

async function ensureCustomer(db: D1Database, accountId: string) {
  const existing = await db.prepare(`SELECT customer_id FROM customers WHERE account_id = ? LIMIT 1`).bind(accountId).first();
  const ts = nowISO();
  if (existing && (existing as any).customer_id) return { customerId: String((existing as any).customer_id), created: false };
  const customerId = `cust_${crypto.randomUUID()}`;
  await db
    .prepare(`INSERT INTO customers (customer_id, account_id, created_at_iso, updated_at_iso) VALUES (?, ?, ?, ?)`)
    .bind(customerId, accountId, ts, ts)
    .run();
  return { customerId, created: true };
}

async function ensureInstructor(db: D1Database, accountId: string, skillsJson: string | null, bioSourceId: string | null) {
  const existing = await db.prepare(`SELECT instructor_id FROM instructors WHERE account_id = ? LIMIT 1`).bind(accountId).first();
  const ts = nowISO();
  if (existing && (existing as any).instructor_id) {
    const instructorId = String((existing as any).instructor_id);
    await db
      .prepare(`UPDATE instructors SET skills_json = COALESCE(?, skills_json), bio_source_id = COALESCE(?, bio_source_id), updated_at_iso = ? WHERE instructor_id = ?`)
      .bind(skillsJson, bioSourceId, ts, instructorId)
      .run();
    return { instructorId, created: false };
  }
  const instructorId = `inst_${crypto.randomUUID()}`;
  await db
    .prepare(
      `INSERT INTO instructors (instructor_id, account_id, skills_json, bio_source_id, created_at_iso, updated_at_iso)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(instructorId, accountId, skillsJson, bioSourceId, ts, ts)
    .run();
  return { instructorId, created: true };
}

function createServer(env: Env) {
  const server = new McpServer({ name: "Gym Core MCP (D1)", version: "0.1.0" });

  server.tool(
    "core_upsert_account",
    "Upsert an account by canonicalAddress.",
    {
      canonicalAddress: AccountAddress,
      email: z.string().min(3).optional(),
      displayName: z.string().min(1).optional(),
      phoneE164: z.string().min(7).optional(),
    },
    async (args) => {
      const parsed = z
        .object({
          canonicalAddress: AccountAddress,
          email: z.string().min(3).optional(),
          displayName: z.string().min(1).optional(),
          phoneE164: z.string().min(7).optional(),
        })
        .parse(args);
      const acc = await ensureAccount(env.DB, {
        canonicalAddress: parsed.canonicalAddress,
        email: parsed.email ?? null,
        displayName: parsed.displayName ?? null,
        phoneE164: parsed.phoneE164 ?? null,
      });
      return { content: [{ type: "text", text: jsonText({ account: acc }) }] };
    },
  );

  server.tool(
    "core_get_account",
    "Get an account by canonicalAddress.",
    { canonicalAddress: AccountAddress },
    async (args) => {
      const parsed = z.object({ canonicalAddress: AccountAddress }).parse(args);
      const canonical = canonicalizeAddress(parsed.canonicalAddress);
      const row = await env.DB.prepare(
        `SELECT account_id, canonical_address, email, display_name, phone_e164 FROM accounts WHERE canonical_address = ? LIMIT 1`,
      )
        .bind(canonical)
        .first();
      const account = row
        ? {
            accountId: String((row as any).account_id ?? ""),
            canonicalAddress: String((row as any).canonical_address ?? ""),
            email: (row as any).email ? String((row as any).email) : null,
            displayName: (row as any).display_name ? String((row as any).display_name) : null,
            phoneE164: (row as any).phone_e164 ? String((row as any).phone_e164) : null,
          }
        : null;
      return { content: [{ type: "text", text: jsonText({ account }) }] };
    },
  );

  server.tool(
    "core_upsert_customer",
    "Ensure a customer exists for an account canonicalAddress.",
    { canonicalAddress: AccountAddress, displayName: z.string().min(1).optional(), email: z.string().min(3).optional() },
    async (args) => {
      const parsed = z
        .object({
          canonicalAddress: AccountAddress,
          displayName: z.string().min(1).optional(),
          email: z.string().min(3).optional(),
        })
        .parse(args);
      const acc = await ensureAccount(env.DB, {
        canonicalAddress: parsed.canonicalAddress,
        email: parsed.email ?? null,
        displayName: parsed.displayName ?? null,
      });
      const cust = await ensureCustomer(env.DB, acc.accountId);
      return { content: [{ type: "text", text: jsonText({ account: acc, customer: cust }) }] };
    },
  );

  server.tool(
    "core_upsert_instructor",
    "Ensure an instructor exists for an account canonicalAddress.",
    {
      canonicalAddress: AccountAddress,
      displayName: z.string().min(1).optional(),
      email: z.string().min(3).optional(),
      skills: z.array(z.string()).optional(),
      bioSourceId: z.string().min(3).optional(),
    },
    async (args) => {
      const parsed = z
        .object({
          canonicalAddress: AccountAddress,
          displayName: z.string().min(1).optional(),
          email: z.string().min(3).optional(),
          skills: z.array(z.string()).optional(),
          bioSourceId: z.string().min(3).optional(),
        })
        .parse(args);
      const acc = await ensureAccount(env.DB, {
        canonicalAddress: parsed.canonicalAddress,
        email: parsed.email ?? null,
        displayName: parsed.displayName ?? null,
      });
      const skillsJson = parsed.skills ? JSON.stringify(parsed.skills) : null;
      const inst = await ensureInstructor(env.DB, acc.accountId, skillsJson, parsed.bioSourceId ?? null);
      return { content: [{ type: "text", text: jsonText({ account: acc, instructor: inst }) }] };
    },
  );

  server.tool("core_list_instructors", "List instructors.", {}, async () => {
    const res = await env.DB.prepare(
      `
      SELECT i.instructor_id, i.skills_json, i.bio_source_id, a.canonical_address, a.display_name, a.email
      FROM instructors i JOIN accounts a ON a.account_id = i.account_id
      ORDER BY a.display_name ASC
    `,
    ).all();
    const instructors = (res.results ?? []).map((r: any) => ({
      instructorId: String(r.instructor_id ?? ""),
      canonicalAddress: String(r.canonical_address ?? ""),
      displayName: String(r.display_name ?? ""),
      email: r.email ? String(r.email) : null,
      bioSourceId: r.bio_source_id ? String(r.bio_source_id) : null,
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

  const ClassDefArgs = z.object({
    classDefId: z.string().min(1),
    title: z.string().min(1),
    type: z.enum(["group", "private"]),
    skillLevel: z.enum(["beginner", "intermediate", "advanced"]).optional(),
    durationMinutes: z.number().int().positive(),
    defaultCapacity: z.number().int().positive(),
    isOutdoor: z.boolean().optional(),
    descriptionSourceId: z.string().min(3).optional(),
  });

  server.tool(
    "core_upsert_class_definition",
    "Upsert a class definition (canonical metadata).",
    ClassDefArgs.shape,
    async (args) => {
      const parsed = ClassDefArgs.parse(args);
      const ts = nowISO();
      await env.DB.prepare(
        `
        INSERT INTO class_definitions (
          class_def_id, title, type, skill_level, duration_minutes, default_capacity, is_outdoor, description_source_id,
          created_at_iso, updated_at_iso
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(class_def_id) DO UPDATE SET
          title=excluded.title,
          type=excluded.type,
          skill_level=excluded.skill_level,
          duration_minutes=excluded.duration_minutes,
          default_capacity=excluded.default_capacity,
          is_outdoor=excluded.is_outdoor,
          description_source_id=excluded.description_source_id,
          updated_at_iso=excluded.updated_at_iso
      `,
      )
        .bind(
          parsed.classDefId,
          parsed.title,
          parsed.type,
          parsed.skillLevel ?? null,
          parsed.durationMinutes,
          parsed.defaultCapacity,
          parsed.isOutdoor ? 1 : 0,
          parsed.descriptionSourceId ?? null,
          ts,
          ts,
        )
        .run();
      return { content: [{ type: "text", text: jsonText({ classDefinition: parsed }) }] };
    },
  );

  server.tool("core_list_class_definitions", "List class definitions.", {}, async () => {
    const res = await env.DB.prepare(
      `SELECT class_def_id, title, type, skill_level, duration_minutes, default_capacity, is_outdoor, description_source_id FROM class_definitions ORDER BY title ASC`,
    ).all();
    const defs = (res.results ?? []).map((r: any) => ({
      classDefId: String(r.class_def_id ?? ""),
      title: String(r.title ?? ""),
      type: String(r.type ?? ""),
      skillLevel: r.skill_level ? String(r.skill_level) : null,
      durationMinutes: Number(r.duration_minutes ?? 0),
      defaultCapacity: Number(r.default_capacity ?? 0),
      isOutdoor: Boolean(Number(r.is_outdoor ?? 0)),
      descriptionSourceId: r.description_source_id ? String(r.description_source_id) : null,
    }));
    return { content: [{ type: "text", text: jsonText({ classDefinitions: defs }) }] };
  });

  const ProductArgs = z.object({
    sku: z.string().min(1),
    name: z.string().min(1),
    category: z.string().min(1),
    priceCents: z.number().int().nonnegative(),
    descriptionSourceId: z.string().min(3).optional(),
  });

  server.tool("core_upsert_product", "Upsert a product definition.", ProductArgs.shape, async (args) => {
    const parsed = ProductArgs.parse(args);
    const ts = nowISO();
    await env.DB.prepare(
      `
      INSERT INTO products (sku, name, category, price_cents, description_source_id, created_at_iso, updated_at_iso)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(sku) DO UPDATE SET
        name=excluded.name,
        category=excluded.category,
        price_cents=excluded.price_cents,
        description_source_id=excluded.description_source_id,
        updated_at_iso=excluded.updated_at_iso
    `,
    )
      .bind(
        parsed.sku,
        parsed.name,
        parsed.category,
        parsed.priceCents,
        parsed.descriptionSourceId ?? null,
        ts,
        ts,
      )
      .run();
    return { content: [{ type: "text", text: jsonText({ sku: parsed.sku }) }] };
  });

  server.tool("core_list_products", "List product definitions.", {}, async () => {
    const res = await env.DB.prepare(
      `SELECT sku, name, category, price_cents, description_source_id FROM products ORDER BY category ASC, name ASC`,
    ).all();
    const products = (res.results ?? []).map((r: any) => ({
      sku: String(r.sku ?? ""),
      name: String(r.name ?? ""),
      category: String(r.category ?? ""),
      priceCents: Number(r.price_cents ?? 0),
      descriptionSourceId: r.description_source_id ? String(r.description_source_id) : null,
    }));
    return { content: [{ type: "text", text: jsonText({ products }) }] };
  });

  server.tool(
    "core_link_class_def_product",
    "Associate a product SKU to a class definition.",
    { classDefId: z.string().min(1), sku: z.string().min(1) },
    async (args) => {
      const parsed = z.object({ classDefId: z.string().min(1), sku: z.string().min(1) }).parse(args);
      await env.DB.prepare(`INSERT OR IGNORE INTO class_def_products (class_def_id, sku) VALUES (?, ?)`)
        .bind(parsed.classDefId, parsed.sku)
        .run();
      return { content: [{ type: "text", text: jsonText({ linked: true }) }] };
    },
  );

  server.tool(
    "core_list_class_def_products",
    "List products associated to class definitions (optionally filtered by classDefId).",
    { classDefId: z.string().min(1).optional() },
    async (args) => {
      const parsed = z.object({ classDefId: z.string().min(1).optional() }).parse(args);
      const res = await env.DB.prepare(
        `
        SELECT c.class_def_id, p.sku, p.name, p.category, p.price_cents, p.description_source_id
        FROM class_def_products c JOIN products p ON p.sku = c.sku
        WHERE (? IS NULL OR c.class_def_id = ?)
        ORDER BY c.class_def_id ASC, p.category ASC, p.name ASC
      `,
      )
        .bind(parsed.classDefId ?? null, parsed.classDefId ?? null)
        .all();
      const items = (res.results ?? []).map((r: any) => ({
        classDefId: String(r.class_def_id ?? ""),
        sku: String(r.sku ?? ""),
        name: String(r.name ?? ""),
        category: String(r.category ?? ""),
        priceCents: Number(r.price_cents ?? 0),
        descriptionSourceId: r.description_source_id ? String(r.description_source_id) : null,
      }));
      return { content: [{ type: "text", text: jsonText({ items }) }] };
    },
  );

  server.tool(
    "core_create_order",
    "Create an order for an account (stores JSON items).",
    {
      canonicalAddress: AccountAddress,
      items: z.array(z.record(z.string(), z.unknown())).min(1),
      totalCents: z.number().int().nonnegative().optional(),
      currency: z.string().min(3).optional(),
    },
    async (args) => {
      const parsed = z
        .object({
          canonicalAddress: AccountAddress,
          items: z.array(z.record(z.string(), z.unknown())).min(1),
          totalCents: z.number().int().nonnegative().optional(),
          currency: z.string().min(3).optional(),
        })
        .parse(args);
      const acc = await ensureAccount(env.DB, { canonicalAddress: parsed.canonicalAddress });
      const orderId = `ord_${crypto.randomUUID()}`;
      const ts = nowISO();
      await env.DB.prepare(
        `INSERT INTO orders (order_id, account_id, status, currency, total_cents, items_json, created_at_iso, updated_at_iso)
         VALUES (?, ?, 'created', ?, ?, ?, ?, ?)`,
      )
        .bind(orderId, acc.accountId, parsed.currency ?? "USD", parsed.totalCents ?? 0, JSON.stringify(parsed.items), ts, ts)
        .run();
      return { content: [{ type: "text", text: jsonText({ orderId }) }] };
    },
  );

  server.tool(
    "core_record_reservation",
    "Record a scheduler reservation in gym-core (ledger).",
    {
      canonicalAddress: AccountAddress,
      schedulerClassId: z.string().min(1),
      schedulerReservationId: z.string().min(1),
      classDefId: z.string().min(1).optional(),
      status: z.enum(["active", "cancelled"]).optional(),
    },
    async (args) => {
      const parsed = z
        .object({
          canonicalAddress: AccountAddress,
          schedulerClassId: z.string().min(1),
          schedulerReservationId: z.string().min(1),
          classDefId: z.string().min(1).optional(),
          status: z.enum(["active", "cancelled"]).optional(),
        })
        .parse(args);
      const acc = await ensureAccount(env.DB, { canonicalAddress: parsed.canonicalAddress });
      const id = `resrec_${crypto.randomUUID()}`;
      const ts = nowISO();
      await env.DB.prepare(
        `INSERT INTO reservation_records (reservation_record_id, account_id, class_def_id, scheduler_class_id, scheduler_reservation_id, status, created_at_iso, updated_at_iso)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          id,
          acc.accountId,
          parsed.classDefId ?? null,
          parsed.schedulerClassId,
          parsed.schedulerReservationId,
          parsed.status ?? "active",
          ts,
          ts,
        )
        .run();
      return { content: [{ type: "text", text: jsonText({ reservationRecordId: id }) }] };
    },
  );

  server.tool(
    "core_set_gym_metadata",
    "Set gym metadata key/value JSON for a gymId.",
    { gymId: z.string().min(1), key: z.string().min(1), value: z.record(z.string(), z.unknown()) },
    async (args) => {
      const parsed = z
        .object({ gymId: z.string().min(1), key: z.string().min(1), value: z.record(z.string(), z.unknown()) })
        .parse(args);
      const ts = nowISO();
      await env.DB.prepare(
        `INSERT INTO gym_metadata (gym_id, key, value_json, created_at_iso, updated_at_iso)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(gym_id, key) DO UPDATE SET value_json=excluded.value_json, updated_at_iso=excluded.updated_at_iso`,
      )
        .bind(parsed.gymId, parsed.key, JSON.stringify(parsed.value), ts, ts)
        .run();
      return { content: [{ type: "text", text: "ok" }] };
    },
  );

  server.tool(
    "core_get_gym_metadata",
    "Get gym metadata key/value JSON for a gymId.",
    { gymId: z.string().min(1) },
    async (args) => {
      const parsed = z.object({ gymId: z.string().min(1) }).parse(args);
      const res = await env.DB.prepare(`SELECT key, value_json FROM gym_metadata WHERE gym_id = ? ORDER BY key ASC`)
        .bind(parsed.gymId)
        .all();
      const items = (res.results ?? []).map((r: any) => ({
        key: String(r.key ?? ""),
        value: (() => {
          try {
            return JSON.parse(String(r.value_json ?? "{}"));
          } catch {
            return {};
          }
        })(),
      }));
      return { content: [{ type: "text", text: jsonText({ gymId: parsed.gymId, metadata: items }) }] };
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

