import { keccak_256 } from "@noble/hashes/sha3";
import { Point, recoverPublicKey } from "@noble/secp256k1";

type Env = {
  DB: D1Database;

  // Wildcard host parsing
  HANDLE_BASE_DOMAIN?: string; // e.g. a2a.gym.example.com

  // LangGraph forwarding
  LANGGRAPH_DEPLOYMENT_URL?: string;
  LANGSMITH_API_KEY?: string;
  LANGGRAPH_ASSISTANT_ID?: string;
  DEFAULT_TZ?: string;

  // Admin writes (handle claiming) from web app
  A2A_ADMIN_KEY?: string;

  // First-party web bypass (server-to-server)
  A2A_WEB_KEY?: string;

  // Rudimentary abuse control
  RATE_LIMIT_PER_MINUTE?: string;
};

type HandleRow = {
  handle: string;
  account_address: string;
  telegram_user_id: string | null;
};

type A2aEnvelope = {
  fromAgentId?: string;
  toAgentId?: string;
  message?: string;
  payload?: unknown;
  metadata?: Record<string, unknown>;
  // Signature fields (Agentic-Trust-style simplified):
  // - signer: 0x… address
  // - signature: 0x… 65-byte (r,s,v) personal_sign over canonicalized message
  signer?: string;
  signature?: string;
  timestampISO?: string;
  nonce?: string;
};

function nowISO() {
  return new Date().toISOString();
}

function json(obj: unknown, status = 200, headers?: Record<string, string>) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...(headers ?? {}) },
  });
}

function badRequest(msg: string, extra?: Record<string, unknown>) {
  return json({ ok: false, error: msg, ...(extra ?? {}) }, 400);
}

function unauthorized(msg = "Unauthorized") {
  return json({ ok: false, error: msg }, 401);
}

function notFound(msg = "Not Found") {
  return json({ ok: false, error: msg }, 404);
}

function okText(s: string) {
  return new Response(s, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
}

function parseHandleFromHost(host: string, baseDomain: string): string | null {
  const h = (host ?? "").trim().toLowerCase();
  const base = (baseDomain ?? "").trim().toLowerCase();
  if (!h || !base) return null;
  if (h === base) return null;
  if (!h.endsWith(`.${base}`)) return null;
  const prefix = h.slice(0, -1 * (`.${base}`.length));
  if (!prefix || prefix.includes(".")) return null; // only one label for now
  if (!/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(prefix)) return null;
  return prefix;
}

function hexToBytes(hex: string): Uint8Array | null {
  const s = (hex ?? "").trim().toLowerCase();
  const clean = s.startsWith("0x") ? s.slice(2) : s;
  if (!clean || clean.length % 2 !== 0) return null;
  if (!/^[0-9a-f]+$/.test(clean)) return null;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return `0x${s}`;
}

function normalizeAddress(addr: string): string {
  const a = (addr ?? "").trim().toLowerCase();
  if (!a.startsWith("0x")) return "";
  if (a.length !== 42) return "";
  if (!/^0x[0-9a-f]{40}$/.test(a)) return "";
  return a;
}

function utf8Bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function keccak256(bytes: Uint8Array): Uint8Array {
  return keccak_256.create().update(bytes).digest();
}

function ethPersonalMessageHash(message: string): Uint8Array {
  const msgBytes = utf8Bytes(message);
  const prefix = utf8Bytes(`\u0019Ethereum Signed Message:\n${msgBytes.length}`);
  return keccak256(new Uint8Array([...prefix, ...msgBytes]));
}

function pubkeyToEthAddress(pubkey: Uint8Array): string {
  // Ethereum address is keccak256(uncompressed_pubkey[1:]) last 20 bytes.
  // noble recoverPublicKey returns compressed (33b) by default, so normalize.
  let uncompressed65: Uint8Array;
  try {
    if (pubkey.length === 65 && pubkey[0] === 4) uncompressed65 = pubkey;
    else uncompressed65 = Point.fromBytes(pubkey).toBytes(false);
  } catch {
    // fallback: treat as-is (will likely fail checksum/match)
    uncompressed65 = pubkey;
  }
  const raw = uncompressed65[0] === 4 ? uncompressed65.slice(1) : uncompressed65;
  const h = keccak256(raw);
  const addr = h.slice(h.length - 20);
  return bytesToHex(addr);
}

function canonicalToSign(handle: string, env: A2aEnvelope): string {
  // Deterministic string for signature validation.
  // Important: keep stable across clients.
  return JSON.stringify(
    {
      toHandle: handle,
      fromAgentId: env.fromAgentId ?? null,
      toAgentId: env.toAgentId ?? null,
      message: env.message ?? null,
      payload: env.payload ?? null,
      timestampISO: env.timestampISO ?? null,
      nonce: env.nonce ?? null,
    },
    null,
    0,
  );
}

async function verifySignatureOrThrow(handle: string, env: A2aEnvelope): Promise<{ signer: string }> {
  const signer = normalizeAddress(String(env.signer ?? ""));
  const sigHex = String(env.signature ?? "").trim();
  if (!signer || !sigHex) throw new Error("missing_signature");
  const sigBytes = hexToBytes(sigHex);
  if (!sigBytes || sigBytes.length !== 65) throw new Error("bad_signature_format");
  const r = sigBytes.slice(0, 32);
  const s = sigBytes.slice(32, 64);
  let v = sigBytes[64] ?? 0;
  if (v >= 27) v = v - 27;
  if (v !== 0 && v !== 1) throw new Error("bad_signature_v");
  const msg = canonicalToSign(handle, env);
  const msgHash = ethPersonalMessageHash(msg);

  // noble expects 65-byte 'recovered' signature (r,s,recovery).
  const sigRecovered = new Uint8Array([...r, ...s, v]);
  const pub = recoverPublicKey(sigRecovered, msgHash, { prehash: false });
  if (!pub) throw new Error("signature_recover_failed");
  const recovered = normalizeAddress(pubkeyToEthAddress(pub));
  if (!recovered || recovered !== signer) throw new Error("signature_mismatch");
  return { signer };
}

async function ensureSchema(db: D1Database) {
  const stmts = [
    `CREATE TABLE IF NOT EXISTS a2a_handles (
      handle TEXT PRIMARY KEY,
      account_address TEXT NOT NULL,
      telegram_user_id TEXT,
      created_at_iso TEXT NOT NULL,
      updated_at_iso TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_a2a_handles_account ON a2a_handles(account_address)`,
    `CREATE TABLE IF NOT EXISTS a2a_messages (
      message_id TEXT PRIMARY KEY,
      handle TEXT NOT NULL,
      from_agent_id TEXT,
      body_json TEXT NOT NULL,
      created_at_iso TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'received'
    )`,
    `CREATE INDEX IF NOT EXISTS idx_a2a_messages_handle_created ON a2a_messages(handle, created_at_iso)`,
  ];
  for (const sql of stmts) {
    try {
      await db.prepare(sql).run();
    } catch {
      // ignore
    }
  }
}

async function getHandleRow(db: D1Database, handle: string): Promise<HandleRow | null> {
  const h = (handle ?? "").trim().toLowerCase();
  if (!h) return null;
  const row = await db
    .prepare(`SELECT handle, account_address, telegram_user_id FROM a2a_handles WHERE handle = ? LIMIT 1`)
    .bind(h)
    .first<HandleRow>();
  if (!row?.handle || !row?.account_address) return null;
  return row;
}

async function upsertHandle(db: D1Database, args: { handle: string; accountAddress: string; telegramUserId?: string | null }) {
  const h = (args.handle ?? "").trim().toLowerCase();
  const acct = String(args.accountAddress ?? "").trim();
  if (!h || !/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(h)) throw new Error("invalid_handle");
  if (!acct) throw new Error("missing_account_address");
  const existing = await db
    .prepare(`SELECT account_address FROM a2a_handles WHERE handle = ? LIMIT 1`)
    .bind(h)
    .first<{ account_address: string }>();
  if (existing?.account_address && String(existing.account_address) !== acct) {
    throw new Error("handle_taken");
  }
  const ts = nowISO();
  await db
    .prepare(
      `INSERT INTO a2a_handles (handle, account_address, telegram_user_id, created_at_iso, updated_at_iso)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(handle) DO UPDATE SET
         account_address=excluded.account_address,
         telegram_user_id=excluded.telegram_user_id,
         updated_at_iso=excluded.updated_at_iso`,
    )
    .bind(h, acct, args.telegramUserId ?? null, ts, ts)
    .run();
  return { handle: h, accountAddress: acct, telegramUserId: args.telegramUserId ?? null, updatedAtISO: ts };
}

async function forwardToLangGraph(env: Env, args: { handle: string; accountAddress: string; message: string; metadata?: Record<string, unknown> }) {
  const deploymentUrl = (env.LANGGRAPH_DEPLOYMENT_URL ?? "").trim().replace(/\/$/, "");
  const apiKey = (env.LANGSMITH_API_KEY ?? "").trim();
  const assistantId = (env.LANGGRAPH_ASSISTANT_ID ?? "gym").trim() || "gym";
  if (!deploymentUrl || !apiKey) throw new Error("missing_langgraph_env");

  const threadId = `a2a_${args.handle}`;
  const md = args.metadata && typeof args.metadata === "object" ? args.metadata : undefined;
  const callerSession = md?.session && typeof md.session === "object" ? (md.session as Record<string, unknown>) : undefined;
  const tzRaw = (callerSession?.timezone ?? md?.timezone ?? env.DEFAULT_TZ ?? "America/Denver") as unknown;
  const tz = typeof tzRaw === "string" && tzRaw.trim() ? tzRaw.trim() : "America/Denver";
  const gymNameRaw = (callerSession?.gymName ?? md?.gymName ?? "Erie Community Center") as unknown;
  const gymName = typeof gymNameRaw === "string" && gymNameRaw.trim() ? gymNameRaw.trim() : "Erie Community Center";
  const a2aMeta = md ? { ...md } : undefined;
  if (a2aMeta && "session" in a2aMeta) delete (a2aMeta as Record<string, unknown>)["session"];
  const res = await fetch(`${deploymentUrl}/runs/wait`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({
      assistant_id: assistantId,
      input: {
        message: args.message,
        session: {
          ...(callerSession ?? {}),
          gymName,
          timezone: tz,
          accountAddress: args.accountAddress,
          threadId,
          a2a: { handle: args.handle, ...(a2aMeta ?? {}) },
        },
      },
      config: { configurable: { thread_id: threadId } },
    }),
  });
  const json = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) {
    const detail = json && typeof json === "object" ? json : { raw: String(json ?? "") };
    throw new Error(`langgraph_error:${res.status}:${JSON.stringify(detail).slice(0, 500)}`);
  }
  const out = json?.output;
  const answer = typeof out?.answer === "string" ? out.answer : typeof out?.output === "string" ? out.output : null;
  return { ok: true, answer, output: out ?? null, raw: json };
}

function agentCardForHandle(origin: string, handle: string) {
  // Minimal agent card (loosely based on emerging "agent.json" conventions).
  return {
    name: `Gym A2A (${handle})`,
    description: "Per-user agent-to-agent endpoint (wildcard routed).",
    a2a: {
      endpoint: `${origin}/api/a2a`,
      wellKnown: `${origin}/.well-known/agent.json`,
    },
    capabilities: ["chat", "calendar", "fitness"],
    asOfISO: nowISO(),
  };
}

async function readBodyJson(req: Request): Promise<any> {
  const ct = (req.headers.get("content-type") ?? "").toLowerCase();
  if (!ct.includes("application/json")) {
    const txt = await req.text().catch(() => "");
    throw new Error(`expected_json:${txt.slice(0, 200)}`);
  }
  return await req.json();
}

async function rateLimitMaybe(env: Env, req: Request, handle: string) {
  const maxPerMin = Number((env.RATE_LIMIT_PER_MINUTE ?? "").trim() || "0");
  if (!Number.isFinite(maxPerMin) || maxPerMin <= 0) return;
  // Very lightweight "soft" limiter: relies on Cloudflare edge caching header space.
  // For stronger rate limiting, use Durable Objects or Turnstile.
  const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
  const key = `rl:${handle}:${ip}:${new Date().toISOString().slice(0, 16)}`; // minute bucket
  // @ts-expect-error - caches.default exists in Workers runtime
  const cache: Cache = caches.default;
  const hit = await cache.match(new Request(`https://cache/${key}`));
  if (hit) {
    const n = Number(hit.headers.get("x-count") ?? "0") + 1;
    if (n > maxPerMin) throw new Error("rate_limited");
    await cache.put(new Request(`https://cache/${key}`), new Response("ok", { headers: { "x-count": String(n) } }));
    return;
  }
  await cache.put(new Request(`https://cache/${key}`), new Response("ok", { headers: { "x-count": "1" } }));
}

export default {
  async fetch(req: Request, env: Env) {
    await ensureSchema(env.DB);
    const url = new URL(req.url);
    const host = req.headers.get("host") ?? url.host;
    const baseDomain = (env.HANDLE_BASE_DOMAIN ?? "").trim();
    const handle = parseHandleFromHost(host, baseDomain);
    const origin = `${url.protocol}//${host}`;

    if (url.pathname === "/health") return json({ ok: true, asOfISO: nowISO(), host, handle, baseDomain });

    if (url.pathname === "/.well-known/agent.json") {
      if (!handle) return notFound("Missing handle in host.");
      return json(agentCardForHandle(origin, handle));
    }

    // Admin: claim/set handle mapping (called from web app).
    if (url.pathname === "/api/a2a/handle" && req.method === "POST") {
      const want = (env.A2A_ADMIN_KEY ?? "").trim();
      const got = (req.headers.get("x-admin-key") ?? "").trim();
      if (!want || got !== want) return unauthorized("Unauthorized (bad x-admin-key)");
      const body = await readBodyJson(req).catch((e) => ({ __error__: String((e as any)?.message ?? e) }));
      if (body?.__error__) return badRequest("Bad JSON body", { detail: body.__error__ });
      const h = String(body?.handle ?? "").trim().toLowerCase();
      const acct = String(body?.accountAddress ?? "").trim();
      const tg = body?.telegramUserId ? String(body.telegramUserId).trim() : null;
      try {
        const out = await upsertHandle(env.DB, { handle: h, accountAddress: acct, telegramUserId: tg });
        return json({ ok: true, ...out });
      } catch (e) {
        return badRequest("Failed to upsert handle", { detail: String((e as any)?.message ?? e) });
      }
    }

    if (url.pathname === "/api/a2a" && req.method === "POST") {
      if (!handle) return notFound("Missing handle in host.");
      try {
        await rateLimitMaybe(env, req, handle);
      } catch {
        return json({ ok: false, error: "rate_limited" }, 429);
      }

      const row = await getHandleRow(env.DB, handle);
      if (!row) return notFound("Unknown handle (not connected).");

      const body = await readBodyJson(req).catch((e) => ({ __error__: String((e as any)?.message ?? e) }));
      if (body?.__error__) return badRequest("Bad JSON body", { detail: body.__error__ });
      const envl: A2aEnvelope = body && typeof body === "object" ? (body as A2aEnvelope) : {};

      const wantWeb = (env.A2A_WEB_KEY ?? "").trim();
      const gotWeb = (req.headers.get("x-web-key") ?? "").trim();
      const isWebBypass = Boolean(wantWeb && gotWeb && gotWeb === wantWeb);
      if (!isWebBypass) {
        try {
          await verifySignatureOrThrow(handle, envl);
        } catch (e) {
          const code = String((e as any)?.message ?? e);
          return unauthorized(code);
        }
      }

      const message =
        typeof envl.message === "string" && envl.message.trim()
          ? envl.message.trim()
          : typeof envl.payload === "string" && envl.payload.trim()
            ? envl.payload.trim()
            : JSON.stringify(envl.payload ?? {}, null, 2);

      const messageId = `a2a_${crypto.randomUUID()}`;
      try {
        await env.DB.prepare(
          `INSERT INTO a2a_messages (message_id, handle, from_agent_id, body_json, created_at_iso, status) VALUES (?, ?, ?, ?, ?, ?)`,
        )
          .bind(messageId, handle, envl.fromAgentId ?? null, JSON.stringify(envl ?? {}), nowISO(), "received")
          .run();
      } catch {
        // ignore
      }

      try {
        const forwarded = await forwardToLangGraph(env, { handle, accountAddress: row.account_address, message, metadata: envl.metadata });
        return json({
          ok: true,
          messageId,
          handle,
          accountAddress: row.account_address,
          response: { received: true, processedAt: nowISO(), answer: forwarded.answer },
          agentOutput: forwarded.output ?? null,
          raw: isWebBypass ? forwarded.raw ?? null : undefined,
        });
      } catch (e) {
        return json({ ok: false, error: "forward_failed", detail: String((e as any)?.message ?? e) }, 502);
      }
    }

    if (url.pathname === "/" && req.method === "GET") {
      return okText("gym-a2a-agent");
    }
    return notFound();
  },
} satisfies ExportedHandler<Env>;

