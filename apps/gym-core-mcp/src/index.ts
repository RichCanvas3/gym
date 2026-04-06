import { createMcpHandler } from "agents/mcp";
import { hashDelegation } from "@metamask/smart-accounts-kit/utils";
import { getSmartAccountsEnvironment } from "@metamask/smart-accounts-kit";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { concatHex, createPublicClient, http, keccak256, parseAbi, recoverMessageAddress } from "viem";
import { sepolia } from "viem/chains";
import { z } from "zod";

export type Env = {
  MCP_API_KEY?: string;
  MCP_DELEGATION_SHARED_SECRET?: string;
  AGENTIC_TRUST_RPC_URL_SEPOLIA?: string;
  DB: D1Database;
  // Optional: GraphDB access for FitnessCore graph queries (SPARQL).
  GRAPHDB_BASE_URL?: string;
  GRAPHDB_REPOSITORY?: string;
  GRAPHDB_USERNAME?: string;
  GRAPHDB_PASSWORD?: string;
  GRAPHDB_CF_ACCESS_CLIENT_ID?: string;
  GRAPHDB_CF_ACCESS_CLIENT_SECRET?: string;
};

type CoreMcpDelegationClaims = {
  v: 1;
  iss: "gym-a2a-agent";
  aud: "urn:mcp:server:core";
  sub: string;
  chainId: number;
  sessionGeneration: number;
  accountAddress: string;
  agentHandle: string;
  principalSmartAccount: `0x${string}`;
  principalOwnerEoa: `0x${string}`;
  sessionAA: `0x${string}`;
  sessionKeyAddress: `0x${string}`;
  sessionValidAfter: number;
  sessionValidUntil: number;
  selector: `0x${string}`;
  permissionsHash: string;
  signedDelegation: {
    delegate: `0x${string}`;
    delegator: `0x${string}`;
    authority: `0x${string}`;
    caveats: unknown[];
    salt: `0x${string}`;
    signature: `0x${string}`;
  };
  issuedAtISO: string;
  expiresAtISO: string;
  jti: string;
  usageLimit: number;
};

type CoreMcpDelegationEnvelope = {
  v?: 2;
  typ?: "urn:agentic-trust:mcp-delegation-envelope";
  alg?: "session-message+hmac-sha256";
  kid?: string;
  claims: CoreMcpDelegationClaims;
  sessionSignature: `0x${string}`;
  issuerSignature: string;
};

type RequestAuth =
  | { kind: "api_key" }
  | {
      kind: "delegated";
      principal: {
        chainId: number;
        accountAddress: string;
        agentHandle: string;
        principalSmartAccount: `0x${string}`;
        principalOwnerEoa: `0x${string}`;
        sessionAA: `0x${string}`;
        sessionKeyAddress: `0x${string}`;
        selector: `0x${string}`;
        permissionsHash: string;
        expiresAtISO: string;
      };
    };

const AccountAddress = z.string().min(3);
const ERC1271_ABI = parseAbi(["function isValidSignature(bytes32,bytes) view returns (bytes4)"]);
const ERC1271_MAGIC_VALUE = "0x1626ba7e";
const DELEGATION_MANAGER_ABI = parseAbi([
  "function getDomainHash() view returns (bytes32)",
  "function getDelegationHash((address delegate,address delegator,bytes32 authority,(address enforcer,bytes terms,bytes args)[] caveats,uint256 salt,bytes signature) _input) view returns (bytes32)",
  "function isValidSignature(bytes32,bytes) view returns (bytes4)",
]);

function nowISO() {
  return new Date().toISOString();
}

function jsonText(obj: unknown) {
  return JSON.stringify(obj, null, 2);
}

function utf8Bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function base64UrlEncodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecodeBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function base64UrlDecodeText(value: string): string {
  return new TextDecoder().decode(base64UrlDecodeBytes(value));
}

function normalizeHexString(value: unknown): `0x${string}` | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return `0x${Math.trunc(value).toString(16)}` as `0x${string}`;
  }
  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return null;
    if (s === "0x" || s === "0X") return "0x00";
    if (/^0x[0-9a-fA-F]+$/i.test(s)) return `0x${s.slice(2).toLowerCase()}` as `0x${string}`;
    if (/^[0-9a-fA-F]+$/.test(s)) return `0x${s.toLowerCase()}` as `0x${string}`;
    if (/^\d+$/.test(s)) return `0x${BigInt(s).toString(16)}` as `0x${string}`;
    return null;
  }
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    const nested = rec.hex ?? rec.value ?? rec._hex ?? rec.data;
    if (nested !== undefined) return normalizeHexString(nested);
  }
  if (Array.isArray(value) && value.every((part) => typeof part === "number" && Number.isFinite(part) && part >= 0 && part <= 255)) {
    let hex = "";
    for (const part of value) hex += Math.trunc(part).toString(16).padStart(2, "0");
    return `0x${hex}` as `0x${string}`;
  }
  return null;
}

function normalizeAddress(value: unknown): `0x${string}` | null {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return null;
  const s = raw.startsWith("0x") ? raw.slice(2) : raw;
  if (!/^[0-9a-f]+$/.test(s)) return null;
  if (s.length === 40) return `0x${s}` as `0x${string}`;
  if (s.length === 64) return `0x${s.slice(-40)}` as `0x${string}`;
  return null;
}

function addressLike(value: unknown): unknown {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    return rec.address ?? rec.account ?? rec.value ?? rec.hex ?? value;
  }
  return value;
}

function normalizeSignedDelegation(value: unknown): CoreMcpDelegationClaims["signedDelegation"] | null {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  const msg =
    raw && raw.message && typeof raw.message === "object"
      ? (raw.message as Record<string, unknown>)
      : raw && raw.delegation && typeof raw.delegation === "object"
        ? (raw.delegation as Record<string, unknown>)
        : raw;
  if (!msg) return null;
  const delegate = normalizeAddress(addressLike(msg.delegate));
  const delegator = normalizeAddress(addressLike(msg.delegator));
  const authority = normalizeHexString(msg.authority);
  const salt = normalizeHexString(msg.salt);
  const signature = normalizeHexString(raw?.signature ?? raw?.sig ?? msg.signature ?? msg.sig);
  const caveats = Array.isArray(msg.caveats) ? msg.caveats : [];
  if (!delegate || !delegator || !authority || !salt || !signature) return null;
  return { delegate, delegator, authority, caveats, salt, signature };
}

function coreMcpClaimsCanonicalString(claims: CoreMcpDelegationClaims): string {
  return JSON.stringify({
    v: claims.v,
    iss: claims.iss,
    aud: claims.aud,
    sub: claims.sub,
    chainId: claims.chainId,
    sessionGeneration: claims.sessionGeneration,
    accountAddress: claims.accountAddress,
    agentHandle: claims.agentHandle,
    principalSmartAccount: claims.principalSmartAccount,
    principalOwnerEoa: claims.principalOwnerEoa,
    sessionAA: claims.sessionAA,
    sessionKeyAddress: claims.sessionKeyAddress,
    sessionValidAfter: claims.sessionValidAfter,
    sessionValidUntil: claims.sessionValidUntil,
    selector: claims.selector,
    permissionsHash: claims.permissionsHash,
    signedDelegation: claims.signedDelegation,
    issuedAtISO: claims.issuedAtISO,
    expiresAtISO: claims.expiresAtISO,
    jti: claims.jti,
    usageLimit: claims.usageLimit,
  });
}

async function mcpDelegationSecretKey(env: Env): Promise<CryptoKey> {
  const secret = String(env.MCP_DELEGATION_SHARED_SECRET ?? "").trim();
  if (!secret) throw new Error("missing_mcp_delegation_shared_secret");
  return await crypto.subtle.importKey("raw", toArrayBuffer(utf8Bytes(secret)), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function verifyIssuerSignature(env: Env, claims: CoreMcpDelegationClaims, issuerSignature: string): Promise<boolean> {
  const key = await mcpDelegationSecretKey(env);
  const sig = await crypto.subtle.sign("HMAC", key, toArrayBuffer(utf8Bytes(coreMcpClaimsCanonicalString(claims))));
  return base64UrlEncodeBytes(new Uint8Array(sig)) === issuerSignature;
}

function rpcUrlForChain(env: Env, chainId: number): string {
  if (chainId === 11155111) {
    return String(env.AGENTIC_TRUST_RPC_URL_SEPOLIA ?? "").trim();
  }
  return "";
}

function publicClientForChain(env: Env, chainId: number) {
  const rpcUrl = rpcUrlForChain(env, chainId);
  if (!rpcUrl) throw new Error(`missing_rpc_url_for_chain_${chainId}`);
  if (chainId === 11155111) {
    return createPublicClient({ chain: sepolia, transport: http(rpcUrl) });
  }
  return createPublicClient({ transport: http(rpcUrl) });
}

async function verifyOriginalDelegationSignature(env: Env, claims: CoreMcpDelegationClaims): Promise<boolean> {
  const client = publicClientForChain(env, claims.chainId);
  const envCfg = getSmartAccountsEnvironment(claims.chainId);
  const delegationManager = normalizeAddress((envCfg as any)?.DelegationManager);
  if (!delegationManager) throw new Error(`missing_delegation_manager_for_chain_${claims.chainId}`);

  const delegationHash = await (async () => {
    try {
      const saltUint = BigInt(claims.signedDelegation.salt);
      return await client.readContract({
        address: delegationManager,
        abi: DELEGATION_MANAGER_ABI,
        functionName: "getDelegationHash",
        args: [
          {
            delegate: claims.signedDelegation.delegate,
            delegator: claims.signedDelegation.delegator,
            authority: claims.signedDelegation.authority as `0x${string}`,
            caveats: claims.signedDelegation.caveats as never,
            salt: saltUint,
            signature: claims.signedDelegation.signature,
          } as never,
        ],
      });
    } catch {
      return hashDelegation({
        delegate: claims.signedDelegation.delegate,
        delegator: claims.signedDelegation.delegator,
        authority: claims.signedDelegation.authority,
        caveats: claims.signedDelegation.caveats as never,
        salt: claims.signedDelegation.salt,
        signature: claims.signedDelegation.signature,
      });
    }
  })();

  // Delegation signatures are over EIP-712 typed-data hash:
  // keccak256(0x1901 ++ DelegationManager.domainSeparator ++ delegationStructHash)
  const domainHash = await client.readContract({
    address: delegationManager,
    abi: DELEGATION_MANAGER_ABI,
    functionName: "getDomainHash",
    args: [],
  });
  const typedDataHash = keccak256(concatHex(["0x1901", domainHash, delegationHash]));

  // Validate via delegator (principal smart account) ERC-1271.
  try {
    const result = await client.readContract({
      address: claims.principalSmartAccount,
      abi: ERC1271_ABI,
      functionName: "isValidSignature",
      args: [typedDataHash, claims.signedDelegation.signature],
    });
    return String(result).toLowerCase() === ERC1271_MAGIC_VALUE;
  } catch {
    return false;
  }
}

async function consumeDelegationJti(db: D1Database, claims: CoreMcpDelegationClaims): Promise<void> {
  const jti = claims.jti.trim();
  if (!jti) throw new Error("delegation_jti_missing");
  const usageLimit = Number.isFinite(claims.usageLimit) && claims.usageLimit > 0 ? Math.floor(claims.usageLimit) : 64;
  const now = nowISO();
  const existing = await db
    .prepare(`SELECT jti, usage_count, usage_limit, expires_at_iso FROM delegated_token_jti_uses WHERE jti = ? LIMIT 1`)
    .bind(jti)
    .first<{ jti: string; usage_count: number; usage_limit: number; expires_at_iso: string }>();
  if (!existing) {
    await db
      .prepare(
        `INSERT INTO delegated_token_jti_uses (jti, usage_count, usage_limit, expires_at_iso, created_at_iso, updated_at_iso)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(jti, 1, usageLimit, claims.expiresAtISO, now, now)
      .run();
    return;
  }
  const expiresAtMs = Date.parse(String(existing.expires_at_iso ?? ""));
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    await db
      .prepare(
        `UPDATE delegated_token_jti_uses
         SET usage_count = ?, usage_limit = ?, expires_at_iso = ?, updated_at_iso = ?
         WHERE jti = ?`,
      )
      .bind(1, usageLimit, claims.expiresAtISO, now, jti)
      .run();
    return;
  }
  const nextUsageCount = Number(existing.usage_count ?? 0) + 1;
  const effectiveLimit = Number(existing.usage_limit ?? usageLimit) > 0 ? Number(existing.usage_limit ?? usageLimit) : usageLimit;
  if (nextUsageCount > effectiveLimit) throw new Error("delegation_jti_usage_exceeded");
  await db
    .prepare(`UPDATE delegated_token_jti_uses SET usage_count = ?, updated_at_iso = ? WHERE jti = ?`)
    .bind(nextUsageCount, now, jti)
    .run();
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

async function authorizeRequest(request: Request, env: Env): Promise<RequestAuth> {
  const authz = (request.headers.get("authorization") ?? "").trim();
  if (authz.toLowerCase().startsWith("bearer ")) {
    const token = authz.slice(7).trim();
    if (!token) throw new Error("missing_bearer_token");
    let parsed: unknown;
    try {
      parsed = JSON.parse(base64UrlDecodeText(token));
    } catch {
      throw new Error("invalid_delegation_token");
    }
    const rec = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    if (rec?.typ && rec.typ !== "urn:agentic-trust:mcp-delegation-envelope") throw new Error("invalid_delegation_token_type");
    if (rec?.alg && rec.alg !== "session-message+hmac-sha256") throw new Error("invalid_delegation_token_alg");
    const claimsRaw = rec?.claims && typeof rec.claims === "object" ? (rec.claims as Record<string, unknown>) : null;
    const sessionSignature = normalizeHexString(rec?.sessionSignature);
    const issuerSignature = typeof rec?.issuerSignature === "string" ? rec.issuerSignature.trim() : "";
    const signedDelegation = normalizeSignedDelegation(claimsRaw?.signedDelegation);
    const claims: CoreMcpDelegationClaims | null =
      claimsRaw &&
      claimsRaw.iss === "gym-a2a-agent" &&
      claimsRaw.aud === "urn:mcp:server:core" &&
      Number(claimsRaw.v) === 1 &&
      signedDelegation &&
      normalizeAddress(claimsRaw.principalSmartAccount) &&
      normalizeAddress(claimsRaw.principalOwnerEoa) &&
      normalizeAddress(claimsRaw.sessionAA) &&
      normalizeAddress(claimsRaw.sessionKeyAddress) &&
      normalizeHexString(claimsRaw.selector) &&
      typeof claimsRaw.accountAddress === "string" &&
      typeof claimsRaw.agentHandle === "string" &&
      typeof claimsRaw.permissionsHash === "string" &&
      typeof claimsRaw.issuedAtISO === "string" &&
      typeof claimsRaw.expiresAtISO === "string" &&
      typeof (claimsRaw.jti ?? claimsRaw.nonce) === "string" &&
      Number.isFinite(Number(claimsRaw.chainId)) &&
      Number.isFinite(Number(claimsRaw.sessionGeneration ?? 1)) &&
      Number.isFinite(Number(claimsRaw.usageLimit ?? 64)) &&
      Number.isFinite(Number(claimsRaw.sessionValidAfter)) &&
      Number.isFinite(Number(claimsRaw.sessionValidUntil))
        ? {
            v: 1,
            iss: "gym-a2a-agent",
            aud: "urn:mcp:server:core",
            sub: String(claimsRaw.sub ?? claimsRaw.accountAddress ?? "").trim(),
            chainId: Number(claimsRaw.chainId),
            sessionGeneration: Number(claimsRaw.sessionGeneration ?? 1),
            accountAddress: String(claimsRaw.accountAddress ?? "").trim(),
            agentHandle: String(claimsRaw.agentHandle ?? "").trim(),
            principalSmartAccount: normalizeAddress(claimsRaw.principalSmartAccount)!,
            principalOwnerEoa: normalizeAddress(claimsRaw.principalOwnerEoa)!,
            sessionAA: normalizeAddress(claimsRaw.sessionAA)!,
            sessionKeyAddress: normalizeAddress(claimsRaw.sessionKeyAddress)!,
            sessionValidAfter: Number(claimsRaw.sessionValidAfter),
            sessionValidUntil: Number(claimsRaw.sessionValidUntil),
            selector: normalizeHexString(claimsRaw.selector)!,
            permissionsHash: String(claimsRaw.permissionsHash ?? "").trim(),
            signedDelegation,
            issuedAtISO: String(claimsRaw.issuedAtISO ?? "").trim(),
            expiresAtISO: String(claimsRaw.expiresAtISO ?? "").trim(),
            jti: String(claimsRaw.jti ?? claimsRaw.nonce ?? "").trim(),
            usageLimit: Math.max(1, Math.min(128, Number(claimsRaw.usageLimit ?? 64))),
          }
        : null;
    if (!claims || !sessionSignature || !issuerSignature) throw new Error("invalid_delegation_claims");
    if (claims.aud !== "urn:mcp:server:core") throw new Error("invalid_delegation_audience");
    const nowMs = Date.now();
    const expMs = Date.parse(claims.expiresAtISO);
    if (!Number.isFinite(expMs) || expMs <= nowMs) throw new Error("delegation_token_expired");
    const validAfterMs = claims.sessionValidAfter * 1000;
    const validUntilMs = claims.sessionValidUntil * 1000;
    if (!Number.isFinite(validAfterMs) || !Number.isFinite(validUntilMs) || nowMs < validAfterMs || nowMs >= validUntilMs) {
      throw new Error("delegation_session_window_invalid");
    }
    if (!(await verifyIssuerSignature(env, claims, issuerSignature))) throw new Error("delegation_issuer_signature_invalid");
    const recovered = normalizeAddress(await recoverMessageAddress({ message: coreMcpClaimsCanonicalString(claims), signature: sessionSignature }));
    if (!recovered || recovered !== claims.sessionKeyAddress) throw new Error("delegation_session_signature_invalid");
    if (claims.signedDelegation.delegate !== claims.sessionAA) throw new Error("delegation_delegate_mismatch");
    if (claims.signedDelegation.delegator !== claims.principalSmartAccount) throw new Error("delegation_principal_mismatch");
    if (claims.selector !== ERC1271_MAGIC_VALUE) throw new Error("delegation_selector_invalid");
    if (!(await verifyOriginalDelegationSignature(env, claims))) throw new Error("delegation_signature_invalid");
    await consumeDelegationJti(env.DB, claims);
    return {
      kind: "delegated",
      principal: {
        chainId: claims.chainId,
        accountAddress: claims.accountAddress,
        agentHandle: claims.agentHandle,
        principalSmartAccount: claims.principalSmartAccount,
        principalOwnerEoa: claims.principalOwnerEoa,
        sessionAA: claims.sessionAA,
        sessionKeyAddress: claims.sessionKeyAddress,
        selector: claims.selector,
        permissionsHash: claims.permissionsHash,
        expiresAtISO: claims.expiresAtISO,
      },
    };
  }
  await requireApiKey(request, env);
  return { kind: "api_key" };
}

function requireDelegatedPrincipal(auth: RequestAuth) {
  if (auth.kind !== "delegated") throw new Error("delegated_auth_required");
  return auth.principal;
}

function canonicalizeAddress(address: string) {
  return (address || "").trim();
}

function requirePrincipalMatch(auth: RequestAuth, canonicalAddress: string) {
  const principal = requireDelegatedPrincipal(auth);
  const expected = canonicalizeAddress(principal.accountAddress);
  const got = canonicalizeAddress(canonicalAddress);
  if (!got || got !== expected) throw new Error("principal_mismatch");
  return principal;
}

async function threadCanonicalAddress(db: D1Database, threadId: string): Promise<string | null> {
  const row = await db.prepare(
    `SELECT a.canonical_address
     FROM chat_threads t
     JOIN accounts a ON a.account_id = t.account_id
     WHERE t.thread_id = ? LIMIT 1`,
  )
    .bind(threadId.trim())
    .first<{ canonical_address?: string }>();
  return row?.canonical_address ? canonicalizeAddress(String(row.canonical_address)) : null;
}

async function requireThreadPrincipal(db: D1Database, auth: RequestAuth, threadId: string) {
  const principal = requireDelegatedPrincipal(auth);
  const canonical = await threadCanonicalAddress(db, threadId);
  if (!canonical) throw new Error("thread_not_found");
  if (canonical !== canonicalizeAddress(principal.accountAddress)) throw new Error("thread_principal_mismatch");
  return principal;
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

  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS delegated_token_jti_uses (
        jti TEXT PRIMARY KEY,
        usage_count INTEGER NOT NULL,
        usage_limit INTEGER NOT NULL,
        expires_at_iso TEXT NOT NULL,
        created_at_iso TEXT NOT NULL,
        updated_at_iso TEXT NOT NULL
      )`,
    )
    .run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_delegated_token_jti_uses_expires ON delegated_token_jti_uses(expires_at_iso)`).run();
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

function createServer(env: Env, auth: RequestAuth) {
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
      requirePrincipalMatch(auth, parsed.canonicalAddress);
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
      requirePrincipalMatch(auth, parsed.canonicalAddress);
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
      requirePrincipalMatch(auth, parsed.canonicalAddress);
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
      requirePrincipalMatch(auth, parsed.canonicalAddress);
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
      requireDelegatedPrincipal(auth);
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
      if (account) requirePrincipalMatch(auth, String(account.canonicalAddress ?? ""));
      return { content: [{ type: "text", text: jsonText({ ok: true, provider, externalUserId, account }) }] };
    },
  );

  server.tool(
    "core_get_external_id_for_account",
    "Lookup an external provider user id for a canonicalAddress (e.g. telegram user id for this Privy account).",
    { canonicalAddress: AccountAddress, provider: z.string().min(1) },
    async (args) => {
      await ensureSchema(env.DB);
      const p = z.object({ canonicalAddress: AccountAddress, provider: z.string().min(1) }).parse(args);
      requirePrincipalMatch(auth, p.canonicalAddress);
      const canonical = canonicalizeAddress(p.canonicalAddress);
      const provider = p.provider.trim().toLowerCase();
      const acc = await env.DB.prepare(`SELECT account_id FROM accounts WHERE canonical_address = ? LIMIT 1`).bind(canonical).first<{
        account_id?: string;
      }>();
      const accountId = acc?.account_id ? String((acc as any).account_id) : "";
      if (!accountId) {
        return { content: [{ type: "text", text: jsonText({ ok: true, canonicalAddress: canonical, provider, externalUserId: null }) }] };
      }
      const row = await env.DB.prepare(
        `SELECT external_user_id FROM account_external_identities WHERE account_id = ? AND provider = ? LIMIT 1`,
      )
        .bind(accountId, provider)
        .first<{ external_user_id?: string }>();
      const externalUserId = row?.external_user_id ? String((row as any).external_user_id) : null;
      return { content: [{ type: "text", text: jsonText({ ok: true, canonicalAddress: canonical, provider, externalUserId }) }] };
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
      requirePrincipalMatch(auth, parsed.canonicalAddress);
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
      await requireThreadPrincipal(env.DB, auth, parsed.threadId);
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
      await requireThreadPrincipal(env.DB, auth, parsed.threadId);
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

  return server;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    let auth: RequestAuth;
    try {
      await ensureSchema(env.DB);
      auth = await authorizeRequest(request, env);
    } catch (error) {
      console.warn("[gym-core-mcp] auth denied", {
        path: url.pathname,
        detail: String((error as Error)?.message ?? error),
      });
      return new Response("Unauthorized", { status: 401 });
    }
    const server = createServer(env, auth);
    return createMcpHandler(server, { route: "/mcp" })(request, env, ctx);
  },
};

