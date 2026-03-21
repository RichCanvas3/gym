import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export type Env = {
  MCP_API_KEY?: string;
  /** Optional: separate key for POST /ingest/workout (e.g. from iPhone app). If unset, ingest uses MCP_API_KEY. */
  INGEST_API_KEY?: string;
  DB: D1Database;
  /** Strava sync: set all three to enable POST /internal/sync-strava. Get refresh_token via OAuth (activity:read_all). */
  STRAVA_CLIENT_ID?: string;
  STRAVA_CLIENT_SECRET?: string;
  STRAVA_REFRESH_TOKEN?: string;
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

/** Ingest auth: INGEST_API_KEY if set, else MCP_API_KEY */
function requireIngestAuth(request: Request, env: Env) {
  const ingestKey = (env.INGEST_API_KEY ?? "").trim();
  const mcpKey = (env.MCP_API_KEY ?? "").trim();
  const want = ingestKey || mcpKey;
  if (!want) throw new Error("Configure INGEST_API_KEY or MCP_API_KEY for ingest");
  const got = (request.headers.get("x-api-key") ?? "").trim();
  if (got !== want) throw new Error("Unauthorized (bad x-api-key)");
}

function canonicalizeAddress(address: string) {
  return (address || "").trim();
}

const IngestWorkoutPayload = z.object({
  source: z.string().min(1),
  device: z.string().optional(),
  eventType: z.string().min(1),
  workoutId: z.string().uuid(),
  activityType: z.string().min(1),
  startedAt: z.string().min(1),
  endedAt: z.string().min(1),
  durationSeconds: z.number().int().nonnegative(),
  distanceMeters: z.number().nonnegative().optional(),
  activeEnergyKcal: z.number().nonnegative().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

async function handleIngestWorkout(request: Request, env: Env): Promise<Response> {
  requireIngestAuth(request, env);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response(jsonText({ error: "Invalid JSON body" }), { status: 400, headers: { "content-type": "application/json" } });
  }
  const parsed = IngestWorkoutPayload.safeParse(body);
  if (!parsed.success) {
    return new Response(
      jsonText({ error: "Validation failed", details: parsed.error.flatten() }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }
  const p = parsed.data;
  const ts = nowISO();
  const existing = await env.DB.prepare(`SELECT 1 FROM workouts WHERE workout_id = ?`).bind(p.workoutId).first();
  if (existing) {
    return new Response(jsonText({ ok: true, workoutId: p.workoutId, inserted: false }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  const metadataJson = p.metadata ? JSON.stringify(p.metadata) : null;
  await env.DB.prepare(
    `INSERT INTO workouts (
      workout_id, source, device, event_type, activity_type, started_at_iso, ended_at_iso,
      duration_seconds, distance_meters, active_energy_kcal, metadata_json, created_at_iso
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      p.workoutId,
      p.source,
      p.device ?? null,
      p.eventType,
      p.activityType,
      p.startedAt,
      p.endedAt,
      p.durationSeconds,
      p.distanceMeters ?? null,
      p.activeEnergyKcal ?? null,
      metadataJson,
      ts,
    )
    .run();
  return new Response(
    jsonText({ ok: true, workoutId: p.workoutId, inserted: true }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

// --- Strava sync (writes to same workouts table with source=strava, workout_id=strava-{id}) ---
type StravaActivity = {
  id: number;
  type: string;
  sport_type?: string;
  start_date: string;
  start_date_local?: string;
  elapsed_time: number;
  moving_time?: number;
  distance?: number;
  kilojoules?: number | null;
  name?: string;
};

async function getStravaAccessToken(env: Env): Promise<string> {
  const clientId = (env.STRAVA_CLIENT_ID ?? "").trim();
  const clientSecret = (env.STRAVA_CLIENT_SECRET ?? "").trim();
  const refreshToken = (env.STRAVA_REFRESH_TOKEN ?? "").trim();
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Strava sync requires STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, STRAVA_REFRESH_TOKEN");
  }
  const res = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; message?: string };
  if (!res.ok || !data.access_token) {
    throw new Error(data.message ?? `Strava token failed: ${res.status}`);
  }
  return data.access_token;
}

async function fetchStravaActivities(accessToken: string, afterUnix: number): Promise<StravaActivity[]> {
  const url = `https://www.strava.com/api/v3/athlete/activities?after=${afterUnix}&per_page=100`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = (await res.json().catch(() => null)) as StravaActivity[] | { message?: string; errors?: unknown };
  if (!Array.isArray(data)) {
    const msg =
      typeof data === "object" && data !== null && "message" in data
        ? String((data as { message?: string }).message)
        : res.statusText;
    const detail =
      typeof data === "object" && data !== null && "errors" in data
        ? ` ${JSON.stringify((data as { errors?: unknown }).errors)}`
        : "";
    throw new Error(
      `Strava activities: ${msg}${detail}. If you see activity:read_permission, re-authorize with scope activity:read_all and put the new refresh token in STRAVA_REFRESH_TOKEN.`,
    );
  }
  if (!res.ok) {
    throw new Error(`Strava activities HTTP ${res.status}`);
  }
  return data;
}

function stravaActivityToWorkoutRow(a: StravaActivity): {
  workout_id: string;
  source: string;
  device: string | null;
  event_type: string;
  activity_type: string;
  started_at_iso: string;
  ended_at_iso: string;
  duration_seconds: number;
  distance_meters: number | null;
  active_energy_kcal: number | null;
  metadata_json: string | null;
} {
  const startedAt = a.start_date ?? "";
  const elapsed = typeof a.elapsed_time === "number" ? a.elapsed_time : 0;
  const endDate = startedAt ? new Date(new Date(startedAt).getTime() + elapsed * 1000).toISOString() : startedAt;
  const kcal = a.kilojoules != null ? Math.round(a.kilojoules * 0.239) : null;
  return {
    workout_id: `strava-${a.id}`,
    source: "strava",
    device: "strava",
    event_type: "workout.completed",
    activity_type: (a.type || a.sport_type || "Workout").trim() || "Workout",
    started_at_iso: startedAt,
    ended_at_iso: endDate,
    duration_seconds: elapsed,
    distance_meters: a.distance != null ? Number(a.distance) : null,
    active_energy_kcal: kcal,
    metadata_json: a.name ? JSON.stringify({ name: a.name, sport_type: a.sport_type }) : null,
  };
}

const STRAVA_SYNC_THROTTLE_MINUTES = 15;

async function getLastStravaSync(env: Env): Promise<Date | null> {
  const row = await env.DB.prepare(`SELECT last_sync_at_iso FROM strava_sync_state WHERE id = 1`).first<{ last_sync_at_iso: string }>();
  if (!row?.last_sync_at_iso) return null;
  const d = new Date(row.last_sync_at_iso);
  return isNaN(d.getTime()) ? null : d;
}

async function setLastStravaSync(env: Env): Promise<void> {
  await env.DB.prepare(`INSERT OR REPLACE INTO strava_sync_state (id, last_sync_at_iso) VALUES (1, ?)`).bind(nowISO()).run();
}

/** Run Strava sync in background if last sync was > STRAVA_SYNC_THROTTLE_MINUTES ago. Safe for waitUntil. */
async function syncStravaIfStale(env: Env): Promise<void> {
  if (!(env.STRAVA_CLIENT_ID && env.STRAVA_CLIENT_SECRET && env.STRAVA_REFRESH_TOKEN)) return;
  const last = await getLastStravaSync(env);
  const cutoff = Date.now() - STRAVA_SYNC_THROTTLE_MINUTES * 60 * 1000;
  if (last && last.getTime() > cutoff) return;
  try {
    await syncStravaToWorkouts(env);
    await setLastStravaSync(env);
  } catch (e) {
    console.warn("[gym-core-mcp] Strava sync-on-read failed:", (e as Error)?.message ?? e);
  }
}

async function syncStravaToWorkouts(env: Env): Promise<{ ok: boolean; synced: number; inserted: number; error?: string }> {
  const afterUnix = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60; // 30 days
  const accessToken = await getStravaAccessToken(env);
  const activities = await fetchStravaActivities(accessToken, afterUnix);
  let inserted = 0;
  const ts = nowISO();
  for (const a of activities) {
    const row = stravaActivityToWorkoutRow(a);
    const existing = await env.DB.prepare(`SELECT 1 FROM workouts WHERE workout_id = ?`).bind(row.workout_id).first();
    if (existing) continue;
    await env.DB.prepare(
      `INSERT INTO workouts (
        workout_id, source, device, event_type, activity_type, started_at_iso, ended_at_iso,
        duration_seconds, distance_meters, active_energy_kcal, metadata_json, created_at_iso
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        row.workout_id,
        row.source,
        row.device,
        row.event_type,
        row.activity_type,
        row.started_at_iso,
        row.ended_at_iso,
        row.duration_seconds,
        row.distance_meters,
        row.active_energy_kcal,
        row.metadata_json,
        ts,
      )
      .run();
    inserted += 1;
  }
  return { ok: true, synced: activities.length, inserted };
}

async function handleSyncStrava(request: Request, env: Env): Promise<Response> {
  await requireApiKey(request, env);
  try {
    const result = await syncStravaToWorkouts(env);
    return new Response(jsonText(result), { status: 200, headers: { "content-type": "application/json" } });
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    return new Response(
      jsonText({ ok: false, error: msg }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }
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

  // Workout ingestion (Apple HealthKit → POST /ingest/workout) — query via MCP
  server.tool(
    "core_list_workouts",
    "List workouts (post-workout data from Apple HealthKit ingest). Most recent first.",
    { limit: z.number().int().positive().max(100).optional(), activityType: z.string().min(1).optional() },
    async (args) => {
      const parsed = z
        .object({ limit: z.number().int().positive().max(100).optional(), activityType: z.string().min(1).optional() })
        .parse(args);
      const limit = parsed.limit ?? 20;
      const stmt =
        parsed.activityType != null
          ? env.DB.prepare(
              `SELECT workout_id, source, device, event_type, activity_type, started_at_iso, ended_at_iso,
               duration_seconds, distance_meters, active_energy_kcal, metadata_json, created_at_iso
               FROM workouts WHERE activity_type = ? ORDER BY ended_at_iso DESC LIMIT ?`,
            ).bind(parsed.activityType, limit)
          : env.DB.prepare(
              `SELECT workout_id, source, device, event_type, activity_type, started_at_iso, ended_at_iso,
               duration_seconds, distance_meters, active_energy_kcal, metadata_json, created_at_iso
               FROM workouts ORDER BY ended_at_iso DESC LIMIT ?`,
            ).bind(limit);
      const res = await stmt.all();
      const workouts = (res.results ?? []).map((r: any) => ({
        workoutId: String(r.workout_id ?? ""),
        source: String(r.source ?? ""),
        device: r.device ? String(r.device) : null,
        eventType: String(r.event_type ?? ""),
        activityType: String(r.activity_type ?? ""),
        startedAt: String(r.started_at_iso ?? ""),
        endedAt: String(r.ended_at_iso ?? ""),
        durationSeconds: Number(r.duration_seconds ?? 0),
        distanceMeters: r.distance_meters != null ? Number(r.distance_meters) : null,
        activeEnergyKcal: r.active_energy_kcal != null ? Number(r.active_energy_kcal) : null,
        metadata: (() => {
          try {
            return r.metadata_json ? JSON.parse(String(r.metadata_json)) : null;
          } catch {
            return null;
          }
        })(),
        createdAtISO: String(r.created_at_iso ?? ""),
      }));
      return { content: [{ type: "text", text: jsonText({ workouts }) }] };
    },
  );

  server.tool(
    "core_get_workout",
    "Get a single workout by workoutId (UUID from Apple ingest, or strava-<id> from Strava sync).",
    { workoutId: z.string().min(1) },
    async (args) => {
      const parsed = z.object({ workoutId: z.string().min(1) }).parse(args);
      const row = await env.DB.prepare(
        `SELECT workout_id, source, device, event_type, activity_type, started_at_iso, ended_at_iso,
         duration_seconds, distance_meters, active_energy_kcal, metadata_json, created_at_iso
         FROM workouts WHERE workout_id = ? LIMIT 1`,
      )
        .bind(parsed.workoutId)
        .first();
      if (!row) {
        return { content: [{ type: "text", text: jsonText({ workout: null, error: "Not found" }) }] };
      }
      const r = row as any;
      const workout = {
        workoutId: String(r.workout_id ?? ""),
        source: String(r.source ?? ""),
        device: r.device ? String(r.device) : null,
        eventType: String(r.event_type ?? ""),
        activityType: String(r.activity_type ?? ""),
        startedAt: String(r.started_at_iso ?? ""),
        endedAt: String(r.ended_at_iso ?? ""),
        durationSeconds: Number(r.duration_seconds ?? 0),
        distanceMeters: r.distance_meters != null ? Number(r.distance_meters) : null,
        activeEnergyKcal: r.active_energy_kcal != null ? Number(r.active_energy_kcal) : null,
        metadata: (() => {
          try {
            return r.metadata_json ? JSON.parse(String(r.metadata_json)) : null;
          } catch {
            return null;
          }
        })(),
        createdAtISO: String(r.created_at_iso ?? ""),
      };
      return { content: [{ type: "text", text: jsonText({ workout }) }] };
    },
  );

  server.tool("core_latest_workout", "Get the most recent workout (by ended_at).", {}, async () => {
    const row = await env.DB.prepare(
      `SELECT workout_id, source, device, event_type, activity_type, started_at_iso, ended_at_iso,
       duration_seconds, distance_meters, active_energy_kcal, metadata_json, created_at_iso
       FROM workouts ORDER BY ended_at_iso DESC LIMIT 1`,
    ).first();
    if (!row) {
      return { content: [{ type: "text", text: jsonText({ workout: null, message: "No workouts yet" }) }] };
    }
    const r = row as any;
    const workout = {
      workoutId: String(r.workout_id ?? ""),
      source: String(r.source ?? ""),
      device: r.device ? String(r.device) : null,
      eventType: String(r.event_type ?? ""),
      activityType: String(r.activity_type ?? ""),
      startedAt: String(r.started_at_iso ?? ""),
      endedAt: String(r.ended_at_iso ?? ""),
      durationSeconds: Number(r.duration_seconds ?? 0),
      distanceMeters: r.distance_meters != null ? Number(r.distance_meters) : null,
      activeEnergyKcal: r.active_energy_kcal != null ? Number(r.active_energy_kcal) : null,
      metadata: (() => {
        try {
          return r.metadata_json ? JSON.parse(String(r.metadata_json)) : null;
        } catch {
          return null;
        }
      })(),
      createdAtISO: String(r.created_at_iso ?? ""),
    };
    return { content: [{ type: "text", text: jsonText({ workout }) }] };
  });

  return server;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname === "/ingest/workout" && request.method === "POST") {
      try {
        return await handleIngestWorkout(request, env);
      } catch (e) {
        const msg = String((e as Error)?.message ?? e);
        const status = msg.includes("Unauthorized") ? 401 : 500;
        return new Response(jsonText({ error: msg }), { status, headers: { "content-type": "application/json" } });
      }
    }
    if (
      url.pathname === "/internal/sync-strava" &&
      (request.method === "POST" || request.method === "GET")
    ) {
      try {
        return await handleSyncStrava(request, env);
      } catch (e) {
        const msg = String((e as Error)?.message ?? e);
        const status = msg.includes("Unauthorized") ? 401 : 500;
        return new Response(jsonText({ error: msg }), { status, headers: { "content-type": "application/json" } });
      }
    }
    try {
      await requireApiKey(request, env);
    } catch {
      return new Response("Unauthorized", { status: 401 });
    }
    const server = createServer(env);
    ctx.waitUntil(syncStravaIfStale(env));
    return createMcpHandler(server, { route: "/mcp" })(request, env, ctx);
  },
};

