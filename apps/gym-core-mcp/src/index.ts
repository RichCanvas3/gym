import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export type Env = {
  MCP_API_KEY?: string;
  DB: D1Database;
  // Optional: GraphDB access for FitnessCore graph queries (SPARQL).
  GRAPHDB_BASE_URL?: string;
  GRAPHDB_REPOSITORY?: string;
  GRAPHDB_USERNAME?: string;
  GRAPHDB_PASSWORD?: string;
  GRAPHDB_CF_ACCESS_CLIENT_ID?: string;
  GRAPHDB_CF_ACCESS_CLIENT_SECRET?: string;
};

const AccountAddress = z.string().min(3);

function nowISO() {
  return new Date().toISOString();
}

function jsonText(obj: unknown) {
  return JSON.stringify(obj, null, 2);
}

function basicAuthHeader(username: string, password: string) {
  const tok = btoa(`${username}:${password}`);
  return `Basic ${tok}`;
}

function graphdbHeaders(env: Env, extra?: Record<string, string>): Record<string, string> {
  const user = (env.GRAPHDB_USERNAME ?? "").trim();
  const pass = (env.GRAPHDB_PASSWORD ?? "").trim();
  if (!user || !pass) throw new Error("Missing GRAPHDB_USERNAME/GRAPHDB_PASSWORD");
  const h: Record<string, string> = {
    authorization: basicAuthHeader(user, pass),
    ...(extra ?? {}),
  };
  const cfId = (env.GRAPHDB_CF_ACCESS_CLIENT_ID ?? "").trim();
  const cfSecret = (env.GRAPHDB_CF_ACCESS_CLIENT_SECRET ?? "").trim();
  if (cfId && cfSecret) {
    h["CF-Access-Client-Id"] = cfId;
    h["CF-Access-Client-Secret"] = cfSecret;
  }
  return h;
}

async function graphdbSparqlSelect(env: Env, query: string): Promise<unknown> {
  const base = (env.GRAPHDB_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const repo = (env.GRAPHDB_REPOSITORY ?? "").trim();
  if (!base || !repo) throw new Error("Missing GRAPHDB_BASE_URL/GRAPHDB_REPOSITORY");
  const url = `${base}/repositories/${encodeURIComponent(repo)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: graphdbHeaders(env, {
      "content-type": "application/sparql-query; charset=utf-8",
      accept: "application/sparql-results+json",
    }),
    body: query,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GraphDB SELECT failed: ${res.status} ${text.slice(0, 500)}`);
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
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

async function ensureSchema(db: D1Database): Promise<void> {
  // KB persistence (embeddings + text). Used by apps/api/knowledge_index.py to cache the KB index.
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS kb_chunks (
        chunk_id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        text TEXT NOT NULL,
        embedding_json TEXT NOT NULL,
        created_at_iso TEXT NOT NULL,
        updated_at_iso TEXT NOT NULL
      )`,
    )
    .run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_kb_chunks_source ON kb_chunks(source_id)`).run();

  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS account_external_identities (
        account_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        external_user_id TEXT NOT NULL,
        created_at_iso TEXT NOT NULL,
        updated_at_iso TEXT NOT NULL,
        PRIMARY KEY (account_id, provider),
        UNIQUE (provider, external_user_id),
        FOREIGN KEY (account_id) REFERENCES accounts(account_id)
      )`,
    )
    .run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_external_identities_provider_user ON account_external_identities(provider, external_user_id)`).run();

  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS account_external_profiles (
        account_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        profile_json TEXT NOT NULL,
        created_at_iso TEXT NOT NULL,
        updated_at_iso TEXT NOT NULL,
        PRIMARY KEY (account_id, provider),
        FOREIGN KEY (account_id) REFERENCES accounts(account_id)
      )`,
    )
    .run();
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

async function upsertExternalIdentityAndProfile(
  db: D1Database,
  args: {
    canonicalAddress: string;
    provider: string;
    externalUserId?: string | null;
    profile?: unknown;
  },
) {
  await ensureSchema(db);
  const acc = await ensureAccount(db, { canonicalAddress: args.canonicalAddress });
  const ts = nowISO();
  const provider = (args.provider || "").trim().toLowerCase();
  if (!provider) throw new Error("Missing provider");

  const externalUserId = args.externalUserId != null ? String(args.externalUserId).trim() : "";
  if (externalUserId) {
    await db
      .prepare(
        `INSERT OR REPLACE INTO account_external_identities (account_id, provider, external_user_id, created_at_iso, updated_at_iso)
         VALUES (?, ?, ?, COALESCE((SELECT created_at_iso FROM account_external_identities WHERE account_id = ? AND provider = ?), ?), ?)`,
      )
      .bind(acc.accountId, provider, externalUserId, acc.accountId, provider, ts, ts)
      .run();
  }

  if (args.profile !== undefined) {
    await db
      .prepare(
        `INSERT OR REPLACE INTO account_external_profiles (account_id, provider, profile_json, created_at_iso, updated_at_iso)
         VALUES (?, ?, ?, COALESCE((SELECT created_at_iso FROM account_external_profiles WHERE account_id = ? AND provider = ?), ?), ?)`,
      )
      .bind(acc.accountId, provider, JSON.stringify(args.profile ?? null), acc.accountId, provider, ts, ts)
      .run();
  }

  return { account: acc, provider, externalUserId: externalUserId || null };
}

function createServer(env: Env) {
  const server = new McpServer({ name: "Gym Core MCP (D1)", version: "0.1.0" });

  server.tool(
    "core_graphdb_sparql_select",
    "Run a SPARQL SELECT query against FitnessCore GraphDB and return SPARQL JSON results.",
    { query: z.string().min(1) },
    async (args) => {
      const p = z.object({ query: z.string().min(1) }).parse(args);
      const results = await graphdbSparqlSelect(env, p.query);
      return { content: [{ type: "text", text: jsonText({ ok: true, results }) }] };
    },
  );

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

  server.tool(
    "core_upsert_external_profile",
    "Attach a third-party identity/profile (e.g. Strava athlete, Telegram user) to an account canonicalAddress.",
    {
      canonicalAddress: AccountAddress,
      provider: z.string().min(1),
      externalUserId: z.string().min(1).optional(),
      profile: z.any().optional(),
    },
    async (args) => {
      const parsed = z
        .object({
          canonicalAddress: AccountAddress,
          provider: z.string().min(1),
          externalUserId: z.string().min(1).optional(),
          profile: z.any().optional(),
        })
        .parse(args);
      const out = await upsertExternalIdentityAndProfile(env.DB, {
        canonicalAddress: parsed.canonicalAddress,
        provider: parsed.provider,
        externalUserId: parsed.externalUserId ?? null,
        profile: parsed.profile,
      });
      return { content: [{ type: "text", text: jsonText({ ok: true, ...out }) }] };
    },
  );

  server.tool(
    "core_get_account_by_external_id",
    "Lookup an account by external provider user id (e.g. telegram user id).",
    { provider: z.string().min(1), externalUserId: z.string().min(1) },
    async (args) => {
      await ensureSchema(env.DB);
      const p = z.object({ provider: z.string().min(1), externalUserId: z.string().min(1) }).parse(args);
      const provider = p.provider.trim().toLowerCase();
      const externalUserId = p.externalUserId.trim();
      const row = await env.DB.prepare(
        `SELECT a.account_id, a.canonical_address, a.email, a.display_name, a.phone_e164
         FROM account_external_identities x JOIN accounts a ON a.account_id = x.account_id
         WHERE x.provider = ? AND x.external_user_id = ? LIMIT 1`,
      )
        .bind(provider, externalUserId)
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
      return { content: [{ type: "text", text: jsonText({ ok: true, provider, externalUserId, account }) }] };
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

  // Persistent memory (chat threads/messages)
  server.tool(
    "core_memory_ensure_thread",
    "Ensure a chat thread exists for a canonicalAddress (persistent memory).",
    { canonicalAddress: AccountAddress, threadId: z.string().min(3).optional(), title: z.string().min(1).optional() },
    async (args) => {
      const parsed = z
        .object({ canonicalAddress: AccountAddress, threadId: z.string().min(3).optional(), title: z.string().min(1).optional() })
        .parse(args);
      const acc = await ensureAccount(env.DB, { canonicalAddress: parsed.canonicalAddress });
      const threadId = (parsed.threadId ?? `thr_${acc.canonicalAddress}`).trim();
      const ts = nowISO();
      await env.DB.prepare(
        `INSERT INTO chat_threads (thread_id, account_id, title, created_at_iso, updated_at_iso)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET updated_at_iso=excluded.updated_at_iso, title=COALESCE(excluded.title, chat_threads.title)`,
      )
        .bind(threadId, acc.accountId, parsed.title ?? null, ts, ts)
        .run();
      return { content: [{ type: "text", text: jsonText({ threadId }) }] };
    },
  );

  server.tool(
    "core_memory_append_message",
    "Append a message to a chat thread.",
    { threadId: z.string().min(3), role: z.enum(["user", "assistant", "system"]), content: z.string().min(1) },
    async (args) => {
      const parsed = z
        .object({ threadId: z.string().min(3), role: z.enum(["user", "assistant", "system"]), content: z.string().min(1) })
        .parse(args);
      const messageId = `msg_${crypto.randomUUID()}`;
      const ts = nowISO();
      await env.DB.prepare(
        `INSERT INTO chat_messages (message_id, thread_id, role, content, created_at_iso) VALUES (?, ?, ?, ?, ?)`,
      )
        .bind(messageId, parsed.threadId, parsed.role, parsed.content, ts)
        .run();
      await env.DB.prepare(`UPDATE chat_threads SET updated_at_iso = ? WHERE thread_id = ?`).bind(ts, parsed.threadId).run();
      return { content: [{ type: "text", text: jsonText({ messageId }) }] };
    },
  );

  server.tool(
    "core_memory_list_messages",
    "List recent messages for a chat thread (chronological).",
    { threadId: z.string().min(3), limit: z.number().int().positive().max(100).optional() },
    async (args) => {
      const parsed = z.object({ threadId: z.string().min(3), limit: z.number().int().positive().max(100).optional() }).parse(args);
      const limit = parsed.limit ?? 24;
      const res = await env.DB.prepare(
        `SELECT role, content, created_at_iso FROM chat_messages WHERE thread_id = ? ORDER BY created_at_iso DESC LIMIT ?`,
      )
        .bind(parsed.threadId, limit)
        .all();
      const rows = (res.results ?? []).map((r: any) => ({
        role: String(r.role ?? ""),
        content: String(r.content ?? ""),
        createdAtISO: String(r.created_at_iso ?? ""),
      }));
      const messages = rows.reverse();
      return { content: [{ type: "text", text: jsonText({ messages }) }] };
    },
  );

  // Persistent KB chunks (embeddings index)
  server.tool(
    "core_kb_upsert_chunks",
    "Upsert KB chunks (text + embedding) for persistent retrieval.",
    {
      chunks: z
        .array(
          z.object({
            chunkId: z.string().min(1),
            sourceId: z.string().min(1),
            text: z.string().min(1),
            embedding: z.array(z.number()),
          }),
        )
        .min(1)
        .max(500),
    },
    async (args) => {
      await ensureSchema(env.DB);
      const parsed = z
        .object({
          chunks: z
            .array(
              z.object({
                chunkId: z.string().min(1),
                sourceId: z.string().min(1),
                text: z.string().min(1),
                embedding: z.array(z.number()),
              }),
            )
            .min(1)
            .max(500),
        })
        .parse(args);
      const ts = nowISO();
      for (const c of parsed.chunks) {
        await env.DB.prepare(
          `INSERT INTO kb_chunks (chunk_id, source_id, text, embedding_json, created_at_iso, updated_at_iso)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(chunk_id) DO UPDATE SET
             source_id=excluded.source_id,
             text=excluded.text,
             embedding_json=excluded.embedding_json,
             updated_at_iso=excluded.updated_at_iso`,
        )
          .bind(c.chunkId, c.sourceId, c.text, JSON.stringify(c.embedding), ts, ts)
          .run();
      }
      return { content: [{ type: "text", text: jsonText({ upserted: parsed.chunks.length }) }] };
    },
  );

  server.tool(
    "core_kb_list_chunks",
    "List KB chunks (text + embedding) for retrieval.",
    { limit: z.number().int().positive().max(2000).optional(), offset: z.number().int().nonnegative().optional() },
    async (args) => {
      await ensureSchema(env.DB);
      const parsed = z
        .object({ limit: z.number().int().positive().max(2000).optional(), offset: z.number().int().nonnegative().optional() })
        .parse(args);
      const limit = parsed.limit ?? 2000;
      const offset = parsed.offset ?? 0;
      const res = await env.DB.prepare(
        `SELECT chunk_id, source_id, text, embedding_json, updated_at_iso FROM kb_chunks ORDER BY source_id ASC LIMIT ? OFFSET ?`,
      )
        .bind(limit, offset)
        .all();
      const chunks = (res.results ?? []).map((r: any) => ({
        chunkId: String(r.chunk_id ?? ""),
        sourceId: String(r.source_id ?? ""),
        text: String(r.text ?? ""),
        embedding: (() => {
          try {
            const v = JSON.parse(String(r.embedding_json ?? "[]"));
            return Array.isArray(v) ? v : [];
          } catch {
            return [];
          }
        })(),
        updatedAtISO: String(r.updated_at_iso ?? ""),
      }));
      return { content: [{ type: "text", text: jsonText({ chunks }) }] };
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
    const url = new URL(request.url);
    try {
      await requireApiKey(request, env);
    } catch {
      return new Response("Unauthorized", { status: 401 });
    }
    const server = createServer(env);
    return createMcpHandler(server, { route: "/mcp" })(request, env, ctx);
  },
};

