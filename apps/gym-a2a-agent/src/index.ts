import { keccak_256 } from "@noble/hashes/sha3";
import { Point, recoverPublicKey } from "@noble/secp256k1";
import { hashDelegation } from "@metamask/smart-accounts-kit/utils";
import { createPublicClient, hashTypedData, http, parseAbi, recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

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
  A2A_SESSION_PACKAGE_SECRET?: string;
  MCP_DELEGATION_SHARED_SECRET?: string;

  // Rudimentary abuse control
  RATE_LIMIT_PER_MINUTE?: string;
};

type HandleRow = {
  handle: string;
  account_address: string;
  telegram_user_id: string | null;
};

type GymAgentProfileRow = {
  account_address: string;
  eoa_address: string | null;
  base_name: string | null;
  discovered_agent_name: string | null;
  discovered_ens_name: string | null;
  created_at_iso: string;
  updated_at_iso: string;
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

type A2AWebSessionPayload = {
  sessionId: string;
  sessionToken: string;
  challengeId: string;
  accountAddress: string;
  walletAddress: string;
  principalSmartAccount: string;
  agentHandle: string;
  a2aHost: string;
  chainId: number;
  scope: string;
  erc1271Validated: true;
  verifiedAtISO: string;
  expiresAtISO: string;
};

type A2AWebAuthChallengeRow = {
  challenge_id: string;
  account_address: string;
  wallet_address: string;
  principal_smart_account: string;
  agent_handle: string;
  a2a_host: string;
  chain_id: number;
  origin: string;
  uri: string;
  agent_card_uri: string;
  nonce: string;
  requested_scope: string;
  issued_at_iso: string;
  expires_at_iso: string;
  used_at_iso: string | null;
};

type SessionPackageRow = {
  account_address: string;
  agent_handle: string;
  principal_smart_account: string;
  principal_owner_eoa: string;
  agent_id: number | null;
  chain_id: number;
  session_key_address: string;
  session_aa: string | null;
  permissions_version: string;
  permissions_hash: string;
  encrypted_package_json: string;
  expires_at_iso: string;
  created_at_iso: string;
  updated_at_iso: string;
};

type RuntimeSessionPackage = {
  row: SessionPackageRow;
  sessionPackage: Record<string, unknown>;
  sessionAA: `0x${string}`;
  selector: `0x${string}`;
  sessionKey: {
    privateKey: `0x${string}`;
    address: `0x${string}`;
    validAfter: number;
    validUntil: number;
  };
  signedDelegation: {
    delegate: `0x${string}`;
    delegator: `0x${string}`;
    authority: `0x${string}`;
    caveats: unknown[];
    salt: `0x${string}`;
    signature: `0x${string}`;
  };
};

type CoreMcpDelegationClaims = {
  v: 1;
  iss: "gym-a2a-agent";
  aud: "urn:mcp:server:core";
  sub: string;
  chainId: number;
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
  signedDelegation: RuntimeSessionPackage["signedDelegation"];
  issuedAtISO: string;
  expiresAtISO: string;
  nonce: string;
};

type CoreMcpDelegationEnvelope = {
  claims: CoreMcpDelegationClaims;
  sessionSignature: `0x${string}`;
  issuerSignature: string;
};

type SessionInitRow = {
  account_address: string;
  agent_handle: string;
  principal_smart_account: string;
  principal_owner_eoa: string;
  chain_id: number;
  session_aa: string;
  encrypted_init_json: string;
  expires_at_iso: string;
  created_at_iso: string;
  updated_at_iso: string;
};

function nowISO() {
  return new Date().toISOString();
}

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
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
    `CREATE TABLE IF NOT EXISTS gym_agent_profiles (
      account_address TEXT PRIMARY KEY,
      eoa_address TEXT,
      base_name TEXT,
      discovered_agent_name TEXT,
      discovered_ens_name TEXT,
      created_at_iso TEXT NOT NULL,
      updated_at_iso TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_gym_agent_profiles_updated ON gym_agent_profiles(updated_at_iso DESC)`,
    `CREATE TABLE IF NOT EXISTS a2a_auth_challenges (
      challenge_id TEXT PRIMARY KEY,
      account_address TEXT NOT NULL,
      wallet_address TEXT NOT NULL,
      principal_smart_account TEXT NOT NULL,
      agent_handle TEXT NOT NULL,
      a2a_host TEXT NOT NULL,
      chain_id INTEGER NOT NULL,
      origin TEXT NOT NULL,
      uri TEXT NOT NULL,
      agent_card_uri TEXT NOT NULL,
      nonce TEXT NOT NULL,
      requested_scope TEXT NOT NULL,
      issued_at_iso TEXT NOT NULL,
      expires_at_iso TEXT NOT NULL,
      used_at_iso TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_a2a_auth_challenges_account ON a2a_auth_challenges(account_address, issued_at_iso DESC)`,
    `CREATE TABLE IF NOT EXISTS a2a_auth_sessions (
      session_token TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      challenge_id TEXT NOT NULL,
      account_address TEXT NOT NULL,
      wallet_address TEXT NOT NULL,
      principal_smart_account TEXT NOT NULL,
      agent_handle TEXT NOT NULL,
      a2a_host TEXT NOT NULL,
      chain_id INTEGER NOT NULL,
      scope TEXT NOT NULL,
      verified_at_iso TEXT NOT NULL,
      expires_at_iso TEXT NOT NULL,
      created_at_iso TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_a2a_auth_sessions_account ON a2a_auth_sessions(account_address, created_at_iso DESC)`,
    `CREATE TABLE IF NOT EXISTS a2a_session_packages (
      account_address TEXT PRIMARY KEY,
      agent_handle TEXT NOT NULL,
      principal_smart_account TEXT NOT NULL,
      principal_owner_eoa TEXT NOT NULL,
      agent_id INTEGER,
      chain_id INTEGER NOT NULL,
      session_key_address TEXT NOT NULL,
      session_aa TEXT,
      permissions_version TEXT NOT NULL,
      permissions_hash TEXT NOT NULL,
      encrypted_package_json TEXT NOT NULL,
      expires_at_iso TEXT NOT NULL,
      created_at_iso TEXT NOT NULL,
      updated_at_iso TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_a2a_session_packages_handle ON a2a_session_packages(agent_handle, updated_at_iso DESC)`,
    `CREATE TABLE IF NOT EXISTS a2a_session_inits (
      account_address TEXT PRIMARY KEY,
      agent_handle TEXT NOT NULL,
      principal_smart_account TEXT NOT NULL,
      principal_owner_eoa TEXT NOT NULL,
      chain_id INTEGER NOT NULL,
      session_aa TEXT NOT NULL,
      encrypted_init_json TEXT NOT NULL,
      expires_at_iso TEXT NOT NULL,
      created_at_iso TEXT NOT NULL,
      updated_at_iso TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_a2a_session_inits_handle ON a2a_session_inits(agent_handle, updated_at_iso DESC)`,
  ];
  for (const sql of stmts) {
    try {
      await db.prepare(sql).run();
    } catch {
      // ignore
    }
  }
}

function okOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s : null;
}

const SESSION_PACKAGE_PERMISSIONS_VERSION = "v1";
const SESSION_PACKAGE_REQUIRED_PERMISSIONS = [
  { aud: "urn:mcp:server:core", tool: "*", actions: ["execute"] },
  { aud: "urn:mcp:server:strava", tool: "*", actions: ["execute"] },
  { aud: "urn:mcp:server:googlecalendar", tool: "*", actions: ["execute"] },
  { aud: "urn:mcp:server:telegram", tool: "*", actions: ["execute"] },
] as const;

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

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(utf8Bytes(value)));
  return base64UrlEncodeBytes(new Uint8Array(digest));
}

async function sessionPackageSecretKey(env: Env): Promise<CryptoKey> {
  const secret = String(env.A2A_SESSION_PACKAGE_SECRET ?? "").trim();
  if (!secret) throw new Error("missing_session_package_secret");
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(utf8Bytes(secret)));
  return await crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptSessionPackage(env: Env, value: unknown): Promise<string> {
  const key = await sessionPackageSecretKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = utf8Bytes(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, toArrayBuffer(plaintext));
  return JSON.stringify({
    v: 1,
    iv: base64UrlEncodeBytes(iv),
    ciphertext: base64UrlEncodeBytes(new Uint8Array(ciphertext)),
  });
}

async function decryptSessionPackage<T>(env: Env, payload: string): Promise<T> {
  const key = await sessionPackageSecretKey(env);
  const parsed = JSON.parse(payload) as Record<string, unknown>;
  const iv = typeof parsed.iv === "string" ? parsed.iv : "";
  const ciphertext = typeof parsed.ciphertext === "string" ? parsed.ciphertext : "";
  if (!iv || !ciphertext) throw new Error("invalid_encrypted_session_package");
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(base64UrlDecodeBytes(iv)) },
    key,
    toArrayBuffer(base64UrlDecodeBytes(ciphertext)),
  );
  return JSON.parse(new TextDecoder().decode(new Uint8Array(plaintext))) as T;
}

async function requiredPermissionsHash(): Promise<string> {
  return await sha256Base64Url(JSON.stringify(SESSION_PACKAGE_REQUIRED_PERMISSIONS));
}

function base64UrlEncodeText(value: string): string {
  return base64UrlEncodeBytes(utf8Bytes(value));
}

function base64UrlDecodeText(value: string): string {
  return new TextDecoder().decode(base64UrlDecodeBytes(value));
}

function normalizeHexString(value: unknown): `0x${string}` | null {
  const s = String(value ?? "").trim();
  if (!/^0x[0-9a-fA-F]+$/.test(s)) return null;
  return s.toLowerCase() as `0x${string}`;
}

function normalizeSignedDelegation(value: unknown): RuntimeSessionPackage["signedDelegation"] | null {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  const msg = raw && raw.message && typeof raw.message === "object" ? (raw.message as Record<string, unknown>) : raw;
  if (!msg) return null;
  const delegate = normalizeAddress(String(msg.delegate ?? ""));
  const delegator = normalizeAddress(String(msg.delegator ?? ""));
  const authority = normalizeAddress(String(msg.authority ?? ""));
  const salt = normalizeHexString(msg.salt);
  const signature = normalizeHexString(raw?.signature ?? msg.signature);
  const caveats = Array.isArray(msg.caveats) ? msg.caveats : [];
  if (!delegate || !delegator || !authority || !salt || !signature) return null;
  return {
    delegate: delegate as `0x${string}`,
    delegator: delegator as `0x${string}`,
    authority: authority as `0x${string}`,
    caveats,
    salt,
    signature,
  };
}

async function mcpDelegationSecretKey(env: Env): Promise<CryptoKey> {
  const secret = String(env.MCP_DELEGATION_SHARED_SECRET ?? "").trim();
  if (!secret) throw new Error("missing_mcp_delegation_shared_secret");
  return await crypto.subtle.importKey("raw", toArrayBuffer(utf8Bytes(secret)), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

function coreMcpClaimsCanonicalString(claims: CoreMcpDelegationClaims): string {
  return JSON.stringify({
    v: claims.v,
    iss: claims.iss,
    aud: claims.aud,
    sub: claims.sub,
    chainId: claims.chainId,
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
    nonce: claims.nonce,
  });
}

async function signCoreMcpClaimsWithIssuer(env: Env, claims: CoreMcpDelegationClaims): Promise<string> {
  const key = await mcpDelegationSecretKey(env);
  const payload = utf8Bytes(coreMcpClaimsCanonicalString(claims));
  const sig = await crypto.subtle.sign("HMAC", key, toArrayBuffer(payload));
  return base64UrlEncodeBytes(new Uint8Array(sig));
}

async function loadRuntimeSessionPackage(env: Env, accountAddress: string): Promise<RuntimeSessionPackage> {
  const status = await sessionPackageStatus(env.DB, accountAddress);
  if (!status.hasPackage) throw new Error("missing_session_package");
  if (status.expired) throw new Error("session_package_expired");
  if (!status.ready) throw new Error("session_package_not_ready");
  const row = await getSessionPackageRow(env.DB, accountAddress);
  if (!row) throw new Error("missing_session_package_row");
  const sessionPackage = await decryptSessionPackage<Record<string, unknown>>(env, row.encrypted_package_json);
  const sessionAA = normalizeAddress(String(sessionPackage.sessionAA ?? row.session_aa ?? ""));
  const selector = normalizeHexString(sessionPackage.selector);
  const sessionKey = sessionPackage.sessionKey && typeof sessionPackage.sessionKey === "object"
    ? (sessionPackage.sessionKey as Record<string, unknown>)
    : null;
  const sessionKeyAddress = normalizeAddress(String(sessionKey?.address ?? ""));
  const sessionKeyPrivateKey = normalizeHexString(sessionKey?.privateKey);
  const sessionValidAfter = Number(sessionKey?.validAfter ?? 0);
  const sessionValidUntil = Number(sessionKey?.validUntil ?? 0);
  const signedDelegation = normalizeSignedDelegation(sessionPackage.signedDelegation);
  if (!sessionAA || !selector || !sessionKey || !sessionKeyAddress || !sessionKeyPrivateKey || !Number.isFinite(sessionValidAfter) || !Number.isFinite(sessionValidUntil) || !signedDelegation) {
    throw new Error("invalid_runtime_session_package");
  }
  if (signedDelegation.delegate !== sessionAA) throw new Error("session_package_delegate_mismatch");
  if (signedDelegation.delegator !== row.principal_smart_account) throw new Error("session_package_principal_mismatch");
  if (sessionKeyAddress !== row.session_key_address) throw new Error("session_package_session_key_mismatch");
  return {
    row,
    sessionPackage,
    sessionAA: sessionAA as `0x${string}`,
    selector,
    sessionKey: {
      privateKey: sessionKeyPrivateKey,
      address: sessionKeyAddress as `0x${string}`,
      validAfter: sessionValidAfter,
      validUntil: sessionValidUntil,
    },
    signedDelegation,
  };
}

async function mintCoreMcpDelegationToken(env: Env, accountAddress: string): Promise<CoreMcpDelegationEnvelope & { token: string }> {
  const runtime = await loadRuntimeSessionPackage(env, accountAddress);
  const nowMs = Date.now();
  const issuedAtISO = new Date(nowMs).toISOString();
  const maxExpiresAtMs = Math.min(Date.parse(runtime.row.expires_at_iso), runtime.sessionKey.validUntil * 1000, nowMs + 5 * 60 * 1000);
  if (!Number.isFinite(maxExpiresAtMs) || maxExpiresAtMs <= nowMs) throw new Error("runtime_session_package_expired");
  const claims: CoreMcpDelegationClaims = {
    v: 1,
    iss: "gym-a2a-agent",
    aud: "urn:mcp:server:core",
    sub: runtime.row.account_address,
    chainId: runtime.row.chain_id,
    accountAddress: runtime.row.account_address,
    agentHandle: runtime.row.agent_handle,
    principalSmartAccount: runtime.row.principal_smart_account as `0x${string}`,
    principalOwnerEoa: runtime.row.principal_owner_eoa as `0x${string}`,
    sessionAA: runtime.sessionAA,
    sessionKeyAddress: runtime.sessionKey.address,
    sessionValidAfter: runtime.sessionKey.validAfter,
    sessionValidUntil: runtime.sessionKey.validUntil,
    selector: runtime.selector,
    permissionsHash: runtime.row.permissions_hash,
    signedDelegation: runtime.signedDelegation,
    issuedAtISO,
    expiresAtISO: new Date(maxExpiresAtMs).toISOString(),
    nonce: `core_${crypto.randomUUID()}`,
  };
  const signer = privateKeyToAccount(runtime.sessionKey.privateKey);
  const canonical = coreMcpClaimsCanonicalString(claims);
  const sessionSignature = await signer.signMessage({ message: canonical });
  const issuerSignature = await signCoreMcpClaimsWithIssuer(env, claims);
  const envelope: CoreMcpDelegationEnvelope = {
    claims,
    sessionSignature,
    issuerSignature,
  };
  return {
    ...envelope,
    token: base64UrlEncodeText(JSON.stringify(envelope)),
  };
}


const A2A_WEB_AUTH_PRIMARY_TYPE = "A2AWebAuthRequest";
const A2A_WEB_AUTH_SCOPE = "a2a:chat";
const A2A_WEB_AUTH_MAGIC_VALUE = "0x1626ba7e";
const A2A_WEB_AUTH_DOMAIN_NAME = "GymA2AWebAuth";
const A2A_WEB_AUTH_DOMAIN_VERSION = "1";
const ERC1271_ABI = parseAbi(["function isValidSignature(bytes32,bytes) view returns (bytes4)"]);
const DEFAULT_CHAIN_ID = 11155111;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 15 * 60 * 1000;

function rpcUrlForChain(chainId: number): string {
  if (chainId === 11155111) {
    return "https://ethereum-sepolia-rpc.publicnode.com";
  }
  throw new Error(`unsupported_chain:${chainId}`);
}

function publicClientForChain(chainId: number) {
  if (chainId === 11155111) {
    return createPublicClient({ chain: sepolia, transport: http(rpcUrlForChain(chainId)) });
  }
  return createPublicClient({ transport: http(rpcUrlForChain(chainId)) });
}

function typedDataMessageFromChallenge(row: A2AWebAuthChallengeRow) {
  return {
    challengeId: row.challenge_id,
    nonce: row.nonce,
    origin: row.origin,
    uri: row.uri,
    wallet: row.wallet_address as `0x${string}`,
    smartAccount: row.principal_smart_account as `0x${string}`,
    agentHandle: row.agent_handle,
    agentCardUri: row.agent_card_uri,
    requestedScope: row.requested_scope,
    issuedAt: row.issued_at_iso,
    expiresAt: row.expires_at_iso,
  };
}

function typedDataForChallenge(row: A2AWebAuthChallengeRow) {
  return {
    domain: {
      name: A2A_WEB_AUTH_DOMAIN_NAME,
      version: A2A_WEB_AUTH_DOMAIN_VERSION,
      chainId: row.chain_id,
      verifyingContract: row.principal_smart_account as `0x${string}`,
    },
    types: {
      [A2A_WEB_AUTH_PRIMARY_TYPE]: [
        { name: "challengeId", type: "string" },
        { name: "nonce", type: "string" },
        { name: "origin", type: "string" },
        { name: "uri", type: "string" },
        { name: "wallet", type: "address" },
        { name: "smartAccount", type: "address" },
        { name: "agentHandle", type: "string" },
        { name: "agentCardUri", type: "string" },
        { name: "requestedScope", type: "string" },
        { name: "issuedAt", type: "string" },
        { name: "expiresAt", type: "string" },
      ],
    },
    primaryType: A2A_WEB_AUTH_PRIMARY_TYPE,
    message: typedDataMessageFromChallenge(row),
  } as const;
}

function makeChallenge(row: {
  accountAddress: string;
  walletAddress: string;
  principalSmartAccount: string;
  agentHandle: string;
  a2aHost: string;
  chainId: number;
  origin: string;
}): A2AWebAuthChallengeRow {
  const now = Date.now();
  return {
    challenge_id: `chal_${crypto.randomUUID()}`,
    account_address: row.accountAddress.trim(),
    wallet_address: normalizeAddress(row.walletAddress),
    principal_smart_account: normalizeAddress(row.principalSmartAccount),
    agent_handle: row.agentHandle.trim().toLowerCase(),
    a2a_host: row.a2aHost.trim().replace(/\/+$/, ""),
    chain_id: Number.isFinite(row.chainId) && row.chainId > 0 ? row.chainId : DEFAULT_CHAIN_ID,
    origin: row.origin.trim().replace(/\/+$/, ""),
    uri: `${row.origin.trim().replace(/\/+$/, "")}/api/a2a/auth/verify`,
    agent_card_uri: `${row.a2aHost.trim().replace(/\/+$/, "")}/.well-known/agent.json`,
    nonce: `0x${randomHex(32)}`,
    requested_scope: A2A_WEB_AUTH_SCOPE,
    issued_at_iso: new Date(now).toISOString(),
    expires_at_iso: new Date(now + CHALLENGE_TTL_MS).toISOString(),
    used_at_iso: null,
  };
}

async function storeChallenge(db: D1Database, row: A2AWebAuthChallengeRow) {
  await db.prepare(
    `INSERT INTO a2a_auth_challenges (
      challenge_id, account_address, wallet_address, principal_smart_account, agent_handle, a2a_host,
      chain_id, origin, uri, agent_card_uri, nonce, requested_scope, issued_at_iso, expires_at_iso, used_at_iso
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  .bind(
    row.challenge_id,
    row.account_address,
    row.wallet_address,
    row.principal_smart_account,
    row.agent_handle,
    row.a2a_host,
    row.chain_id,
    row.origin,
    row.uri,
    row.agent_card_uri,
    row.nonce,
    row.requested_scope,
    row.issued_at_iso,
    row.expires_at_iso,
    row.used_at_iso,
  )
  .run();
}

async function getChallenge(db: D1Database, challengeId: string): Promise<A2AWebAuthChallengeRow | null> {
  const row = await db.prepare(
    `SELECT challenge_id, account_address, wallet_address, principal_smart_account, agent_handle, a2a_host,
      chain_id, origin, uri, agent_card_uri, nonce, requested_scope, issued_at_iso, expires_at_iso, used_at_iso
     FROM a2a_auth_challenges WHERE challenge_id = ? LIMIT 1`
  ).bind(challengeId.trim()).first<A2AWebAuthChallengeRow>();
  return row?.challenge_id ? row : null;
}

async function markChallengeUsed(db: D1Database, challengeId: string) {
  await db.prepare(`UPDATE a2a_auth_challenges SET used_at_iso = ? WHERE challenge_id = ?`).bind(nowISO(), challengeId.trim()).run();
}

async function createWebSession(db: D1Database, args: {
  challenge: A2AWebAuthChallengeRow;
}): Promise<A2AWebSessionPayload> {
  const verifiedAtISO = nowISO();
  const expiresAtISO = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  const sessionId = `sess_${crypto.randomUUID()}`;
  const sessionToken = `ws_${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "")}`;
  await db.prepare(
    `INSERT INTO a2a_auth_sessions (
      session_token, session_id, challenge_id, account_address, wallet_address, principal_smart_account,
      agent_handle, a2a_host, chain_id, scope, verified_at_iso, expires_at_iso, created_at_iso
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  .bind(
    sessionToken,
    sessionId,
    args.challenge.challenge_id,
    args.challenge.account_address,
    args.challenge.wallet_address,
    args.challenge.principal_smart_account,
    args.challenge.agent_handle,
    args.challenge.a2a_host,
    args.challenge.chain_id,
    A2A_WEB_AUTH_SCOPE,
    verifiedAtISO,
    expiresAtISO,
    verifiedAtISO,
  )
  .run();
  return {
    sessionId,
    sessionToken,
    challengeId: args.challenge.challenge_id,
    accountAddress: args.challenge.account_address,
    walletAddress: args.challenge.wallet_address,
    principalSmartAccount: args.challenge.principal_smart_account,
    agentHandle: args.challenge.agent_handle,
    a2aHost: args.challenge.a2a_host,
    chainId: args.challenge.chain_id,
    scope: A2A_WEB_AUTH_SCOPE,
    erc1271Validated: true,
    verifiedAtISO,
    expiresAtISO,
  };
}

async function verifyWebSessionToken(db: D1Database, token: string): Promise<A2AWebSessionPayload> {
  const row = await db.prepare(
    `SELECT session_token, session_id, challenge_id, account_address, wallet_address, principal_smart_account,
      agent_handle, a2a_host, chain_id, scope, verified_at_iso, expires_at_iso
     FROM a2a_auth_sessions WHERE session_token = ? LIMIT 1`
  ).bind(token.trim()).first<Record<string, unknown>>();
  if (!row) throw new Error("invalid_session_token");
  const expiresAtISO = typeof row.expires_at_iso === "string" ? row.expires_at_iso : "";
  if (!expiresAtISO || Number.isNaN(Date.parse(expiresAtISO)) || Date.parse(expiresAtISO) <= Date.now()) {
    throw new Error("session_expired");
  }
  return {
    sessionId: String(row.session_id ?? ""),
    sessionToken: String(row.session_token ?? ""),
    challengeId: String(row.challenge_id ?? ""),
    accountAddress: String(row.account_address ?? ""),
    walletAddress: String(row.wallet_address ?? ""),
    principalSmartAccount: String(row.principal_smart_account ?? ""),
    agentHandle: String(row.agent_handle ?? ""),
    a2aHost: String(row.a2a_host ?? ""),
    chainId: Number(row.chain_id ?? DEFAULT_CHAIN_ID),
    scope: String(row.scope ?? ""),
    erc1271Validated: true,
    verifiedAtISO: String(row.verified_at_iso ?? ""),
    expiresAtISO,
  };
}

async function getSessionPackageRow(db: D1Database, accountAddress: string): Promise<SessionPackageRow | null> {
  const row = await db.prepare(
    `SELECT account_address, agent_handle, principal_smart_account, principal_owner_eoa, agent_id, chain_id,
      session_key_address, session_aa, permissions_version, permissions_hash, encrypted_package_json,
      expires_at_iso, created_at_iso, updated_at_iso
     FROM a2a_session_packages WHERE account_address = ? LIMIT 1`
  )
    .bind(accountAddress.trim())
    .first<SessionPackageRow>();
  return row?.account_address ? row : null;
}

async function getSessionInitRow(db: D1Database, accountAddress: string): Promise<SessionInitRow | null> {
  const row = await db.prepare(
    `SELECT account_address, agent_handle, principal_smart_account, principal_owner_eoa, chain_id,
      session_aa, encrypted_init_json, expires_at_iso, created_at_iso, updated_at_iso
     FROM a2a_session_inits WHERE account_address = ? LIMIT 1`
  )
    .bind(accountAddress.trim())
    .first<SessionInitRow>();
  return row?.account_address ? row : null;
}

async function clearSessionInit(db: D1Database, accountAddress: string) {
  await db.prepare(`DELETE FROM a2a_session_inits WHERE account_address = ?`).bind(accountAddress.trim()).run();
}

async function upsertSessionInit(db: D1Database, env: Env, args: {
  accountAddress: string;
  agentHandle: string;
  principalSmartAccount: string;
  principalOwnerEoa: string;
  chainId: number;
  sessionAA: string;
  expiresAtISO: string;
  initData: Record<string, unknown>;
}) {
  const now = nowISO();
  const encryptedInitJson = await encryptSessionPackage(env, args.initData);
  await db.prepare(
    `INSERT INTO a2a_session_inits (
      account_address, agent_handle, principal_smart_account, principal_owner_eoa, chain_id,
      session_aa, encrypted_init_json, expires_at_iso, created_at_iso, updated_at_iso
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_address) DO UPDATE SET
      agent_handle = excluded.agent_handle,
      principal_smart_account = excluded.principal_smart_account,
      principal_owner_eoa = excluded.principal_owner_eoa,
      chain_id = excluded.chain_id,
      session_aa = excluded.session_aa,
      encrypted_init_json = excluded.encrypted_init_json,
      expires_at_iso = excluded.expires_at_iso,
      updated_at_iso = excluded.updated_at_iso`
  )
    .bind(
      args.accountAddress.trim(),
      args.agentHandle.trim().toLowerCase(),
      normalizeAddress(args.principalSmartAccount),
      normalizeAddress(args.principalOwnerEoa),
      args.chainId,
      normalizeAddress(args.sessionAA),
      encryptedInitJson,
      args.expiresAtISO,
      now,
      now,
    )
    .run();
}

async function readSessionInit(db: D1Database, env: Env, accountAddress: string) {
  const row = await getSessionInitRow(db, accountAddress);
  if (!row) return { pending: false, expired: false, initData: null as Record<string, unknown> | null, row: null as SessionInitRow | null };
  const expiresAtMs = row.expires_at_iso ? Date.parse(row.expires_at_iso) : Number.NaN;
  const expired = !row.expires_at_iso || Number.isNaN(expiresAtMs) || expiresAtMs <= Date.now();
  if (expired) {
    await clearSessionInit(db, accountAddress).catch(() => null);
    return { pending: false, expired: true, initData: null as Record<string, unknown> | null, row: null as SessionInitRow | null };
  }
  const initData = await decryptSessionPackage<Record<string, unknown>>(env, row.encrypted_init_json);
  return { pending: true, expired: false, initData, row };
}

async function sessionPackageStatus(db: D1Database, accountAddress: string) {
  const row = await getSessionPackageRow(db, accountAddress);
  const permissionsHash = await requiredPermissionsHash();
  const nowMs = Date.now();
  const expiresAtMs = row?.expires_at_iso ? Date.parse(row.expires_at_iso) : Number.NaN;
  const expired = !row?.expires_at_iso || Number.isNaN(expiresAtMs) || expiresAtMs <= nowMs;
  const ready = !!row && !expired && row.permissions_hash === permissionsHash && row.permissions_version === SESSION_PACKAGE_PERMISSIONS_VERSION;
  return {
    ready,
    hasPackage: !!row,
    expired,
    permissionsVersion: SESSION_PACKAGE_PERMISSIONS_VERSION,
    permissionsHash,
    requiredPermissions: SESSION_PACKAGE_REQUIRED_PERMISSIONS,
    packageMeta: row
      ? {
          accountAddress: row.account_address,
          agentHandle: row.agent_handle,
          principalSmartAccount: row.principal_smart_account,
          principalOwnerEoa: row.principal_owner_eoa,
          agentId: row.agent_id,
          chainId: row.chain_id,
          sessionKeyAddress: row.session_key_address,
          sessionAA: row.session_aa,
          expiresAtISO: row.expires_at_iso,
          createdAtISO: row.created_at_iso,
          updatedAtISO: row.updated_at_iso,
        }
      : null,
  };
}

async function upsertSessionPackage(db: D1Database, env: Env, args: {
  accountAddress: string;
  agentHandle: string;
  principalSmartAccount: string;
  principalOwnerEoa: string;
  agentId: number | null;
  chainId: number;
  sessionPackage: Record<string, unknown>;
}) {
  const sessionKey = (args.sessionPackage.sessionKey ?? {}) as Record<string, unknown>;
  const signedDelegation = (args.sessionPackage.signedDelegation ?? {}) as Record<string, unknown>;
  const sessionKeyAddress = normalizeAddress(String(sessionKey.address ?? ""));
  const sessionAA = normalizeAddress(String(args.sessionPackage.sessionAA ?? "")) || null;
  const normalizedSignedDelegation = normalizeSignedDelegation(signedDelegation);
  const expiresAtISO = (() => {
    const validUntil = Number(sessionKey.validUntil ?? 0);
    return Number.isFinite(validUntil) && validUntil > 0 ? new Date(validUntil * 1000).toISOString() : "";
  })();
  if (!sessionKeyAddress) throw new Error("invalid_session_key_address");
  if (!expiresAtISO) throw new Error("invalid_session_expiry");
  if (!String(sessionKey.privateKey ?? "").trim()) throw new Error("missing_session_private_key");
  if (!String(signedDelegation.signature ?? "").trim()) throw new Error("missing_signed_delegation");
  if (!sessionAA) throw new Error("invalid_session_aa");
  if (!normalizedSignedDelegation) throw new Error("invalid_signed_delegation");
  if (normalizedSignedDelegation.delegate !== sessionAA) throw new Error("session_package_delegate_mismatch");
  if (normalizedSignedDelegation.delegator !== normalizeAddress(args.principalSmartAccount)) throw new Error("session_package_principal_mismatch");
  if (!(await verifyOriginalDelegationSignature(args.chainId, normalizeAddress(args.principalSmartAccount) as `0x${string}`, normalizedSignedDelegation))) {
    throw new Error("invalid_original_signed_delegation");
  }
  const permissionsHash = await requiredPermissionsHash();
  const encryptedPackageJson = await encryptSessionPackage(env, args.sessionPackage);
  const now = nowISO();
  await db.prepare(
    `INSERT INTO a2a_session_packages (
      account_address, agent_handle, principal_smart_account, principal_owner_eoa, agent_id, chain_id,
      session_key_address, session_aa, permissions_version, permissions_hash, encrypted_package_json,
      expires_at_iso, created_at_iso, updated_at_iso
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_address) DO UPDATE SET
      agent_handle = excluded.agent_handle,
      principal_smart_account = excluded.principal_smart_account,
      principal_owner_eoa = excluded.principal_owner_eoa,
      agent_id = excluded.agent_id,
      chain_id = excluded.chain_id,
      session_key_address = excluded.session_key_address,
      session_aa = excluded.session_aa,
      permissions_version = excluded.permissions_version,
      permissions_hash = excluded.permissions_hash,
      encrypted_package_json = excluded.encrypted_package_json,
      expires_at_iso = excluded.expires_at_iso,
      updated_at_iso = excluded.updated_at_iso`
  )
    .bind(
      args.accountAddress.trim(),
      args.agentHandle.trim().toLowerCase(),
      normalizeAddress(args.principalSmartAccount),
      normalizeAddress(args.principalOwnerEoa),
      args.agentId,
      args.chainId,
      sessionKeyAddress,
      sessionAA,
      SESSION_PACKAGE_PERMISSIONS_VERSION,
      permissionsHash,
      encryptedPackageJson,
      expiresAtISO,
      now,
      now,
    )
    .run();
  await clearSessionInit(db, args.accountAddress).catch(() => null);
  return await sessionPackageStatus(db, args.accountAddress);
}

async function recoverWebAuthSigner(row: A2AWebAuthChallengeRow, signature: string): Promise<string> {
  const typed = typedDataForChallenge(row);
  const recovered = await recoverTypedDataAddress({
    domain: typed.domain,
    types: typed.types,
    primaryType: typed.primaryType,
    message: typed.message,
    signature: signature as `0x${string}`,
  });
  return normalizeAddress(recovered);
}

async function verifyWebAuthErc1271(row: A2AWebAuthChallengeRow, signature: string): Promise<{ digest: string; ok: boolean }> {
  const typed = typedDataForChallenge(row);
  const digest = hashTypedData({
    domain: typed.domain,
    types: typed.types,
    primaryType: typed.primaryType,
    message: typed.message,
  });
  const client = publicClientForChain(row.chain_id);
  const result = await client.readContract({
    address: row.principal_smart_account as `0x${string}`,
    abi: ERC1271_ABI,
    functionName: "isValidSignature",
    args: [digest, signature as `0x${string}`],
  });
  return { digest, ok: String(result).toLowerCase() === A2A_WEB_AUTH_MAGIC_VALUE };
}

async function verifyOriginalDelegationSignature(
  chainId: number,
  principalSmartAccount: `0x${string}`,
  signedDelegation: RuntimeSessionPackage["signedDelegation"],
): Promise<boolean> {
  const client = publicClientForChain(chainId);
  const delegationHash = hashDelegation({
    delegate: signedDelegation.delegate,
    delegator: signedDelegation.delegator,
    authority: signedDelegation.authority,
    caveats: signedDelegation.caveats as never,
    salt: signedDelegation.salt,
    signature: signedDelegation.signature,
  });
  const result = await client.readContract({
    address: principalSmartAccount,
    abi: ERC1271_ABI,
    functionName: "isValidSignature",
    args: [delegationHash, signedDelegation.signature],
  });
  return String(result).toLowerCase() === A2A_WEB_AUTH_MAGIC_VALUE;
}

async function upsertGymAgentProfile(
  db: D1Database,
  args: {
    accountAddress: string;
    eoaAddress?: string | null;
    baseName?: string | null;
    discoveredAgentName?: string | null;
    discoveredEnsName?: string | null;
  },
) {
  const acct = String(args.accountAddress ?? "").trim();
  if (!acct) throw new Error("missing_account_address");
  const ts = nowISO();
  await db
    .prepare(
      `INSERT INTO gym_agent_profiles (
        account_address, eoa_address, base_name, discovered_agent_name, discovered_ens_name, created_at_iso, updated_at_iso
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_address) DO UPDATE SET
        eoa_address=excluded.eoa_address,
        base_name=excluded.base_name,
        discovered_agent_name=excluded.discovered_agent_name,
        discovered_ens_name=excluded.discovered_ens_name,
        updated_at_iso=excluded.updated_at_iso`,
    )
    .bind(
      acct,
      okOrNull(args.eoaAddress ?? null),
      okOrNull(args.baseName ?? null),
      okOrNull(args.discoveredAgentName ?? null),
      okOrNull(args.discoveredEnsName ?? null),
      ts,
      ts,
    )
    .run();
  return { ok: true, accountAddress: acct, updatedAtISO: ts };
}

async function getGymAgentProfile(db: D1Database, accountAddress: string): Promise<GymAgentProfileRow | null> {
  const acct = String(accountAddress ?? "").trim();
  if (!acct) return null;
  const row = await db
    .prepare(
      `SELECT account_address, eoa_address, base_name, discovered_agent_name, discovered_ens_name, created_at_iso, updated_at_iso
       FROM gym_agent_profiles WHERE account_address = ? LIMIT 1`,
    )
    .bind(acct)
    .first<GymAgentProfileRow>();
  if (!row?.account_address) return null;
  return row;
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

async function forwardToLangGraph(env: Env, args: {
  handle: string;
  accountAddress: string;
  message: string;
  metadata?: Record<string, unknown>;
  mcpAuth?: {
    core?: {
      bearerToken: string;
      expiresAtISO: string;
    };
  };
}) {
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
          ...(args.mcpAuth ? { mcpAuth: args.mcpAuth } : {}),
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

    // Admin: upsert gym agent profile (base name).
    if (url.pathname === "/api/a2a/profile" && req.method === "POST") {
      const want = (env.A2A_ADMIN_KEY ?? "").trim();
      const got = (req.headers.get("x-admin-key") ?? "").trim();
      if (!want || got !== want) return unauthorized("Unauthorized (bad x-admin-key)");
      const body = await readBodyJson(req).catch((e) => ({ __error__: String((e as any)?.message ?? e) }));
      if (body?.__error__) return badRequest("Bad JSON body", { detail: body.__error__ });
      const acct = String(body?.accountAddress ?? "").trim();
      const eoa = body?.eoaAddress ? String(body.eoaAddress).trim() : null;
      const baseName = body?.baseName ? String(body.baseName).trim() : null;
      const discoveredAgentName = body?.discoveredAgentName ? String(body.discoveredAgentName).trim() : null;
      const discoveredEnsName = body?.discoveredEnsName ? String(body.discoveredEnsName).trim() : null;
      try {
        const out = await upsertGymAgentProfile(env.DB, { accountAddress: acct, eoaAddress: eoa, baseName, discoveredAgentName, discoveredEnsName });
        return json(out);
      } catch (e) {
        return badRequest("Failed to upsert profile", { detail: String((e as any)?.message ?? e) });
      }
    }

    // Web/server: read gym agent profile for an account.
    if (url.pathname === "/api/a2a/profile" && req.method === "GET") {
      const wantWeb = (env.A2A_WEB_KEY ?? "").trim();
      const gotWeb = (req.headers.get("x-web-key") ?? "").trim();
      if (!wantWeb || gotWeb !== wantWeb) return unauthorized("Unauthorized (bad x-web-key)");
      const acct = (url.searchParams.get("accountAddress") ?? "").trim();
      if (!acct) return badRequest("Missing accountAddress");
      const row = await getGymAgentProfile(env.DB, acct);
      if (!row) return json({ ok: true, profile: null });
      return json({
        ok: true,
        profile: {
          accountAddress: row.account_address,
          eoaAddress: row.eoa_address,
          baseName: row.base_name,
          discoveredAgentName: row.discovered_agent_name,
          discoveredEnsName: row.discovered_ens_name,
          createdAtISO: row.created_at_iso,
          updatedAtISO: row.updated_at_iso,
        },
      });
    }

    if (url.pathname === "/api/a2a/auth/challenge" && req.method === "POST") {
      const want = (env.A2A_ADMIN_KEY ?? "").trim();
      const got = (req.headers.get("x-admin-key") ?? "").trim();
      if (!want || got !== want) return unauthorized("Unauthorized (bad x-admin-key)");
      const body = await readBodyJson(req).catch((e) => ({ __error__: String((e as any)?.message ?? e) }));
      if (body?.__error__) return badRequest("Bad JSON body", { detail: body.__error__ });
      const accountAddress = String(body?.accountAddress ?? "").trim();
      const walletAddress = normalizeAddress(String(body?.walletAddress ?? ""));
      const principalSmartAccount = normalizeAddress(String(body?.principalSmartAccount ?? ""));
      const agentHandleBody = String(body?.agentHandle ?? "").trim().toLowerCase();
      const a2aHost = String(body?.a2aHost ?? "").trim();
      const originBody = String(body?.origin ?? "").trim();
      const chainId = Number(body?.chainId ?? DEFAULT_CHAIN_ID);
      if (!accountAddress || !walletAddress || !principalSmartAccount || !agentHandleBody || !a2aHost || !originBody) {
        return badRequest("Missing required auth challenge fields");
      }
      try {
        const challenge = makeChallenge({
          accountAddress,
          walletAddress,
          principalSmartAccount,
          agentHandle: agentHandleBody,
          a2aHost,
          chainId,
          origin: originBody,
        });
        await storeChallenge(env.DB, challenge);
        return json({
          ok: true,
          challengeId: challenge.challenge_id,
          challenge: {
            challengeId: challenge.challenge_id,
            nonce: challenge.nonce,
            accountAddress: challenge.account_address,
            walletAddress: challenge.wallet_address,
            principalSmartAccount: challenge.principal_smart_account,
            agentHandle: challenge.agent_handle,
            a2aHost: challenge.a2a_host,
            chainId: challenge.chain_id,
            origin: challenge.origin,
            uri: challenge.uri,
            agentCardUri: challenge.agent_card_uri,
            requestedScope: challenge.requested_scope,
            issuedAtISO: challenge.issued_at_iso,
            expiresAtISO: challenge.expires_at_iso,
          },
          typedData: typedDataForChallenge(challenge),
        });
      } catch (e) {
        return badRequest("Failed to create auth challenge", { detail: String((e as any)?.message ?? e) });
      }
    }

    if (url.pathname === "/api/a2a/auth/verify" && req.method === "POST") {
      const want = (env.A2A_ADMIN_KEY ?? "").trim();
      const got = (req.headers.get("x-admin-key") ?? "").trim();
      if (!want || got !== want) return unauthorized("Unauthorized (bad x-admin-key)");
      const body = await readBodyJson(req).catch((e) => ({ __error__: String((e as any)?.message ?? e) }));
      if (body?.__error__) return badRequest("Bad JSON body", { detail: body.__error__ });
      const challengeId = String(body?.challengeId ?? "").trim();
      const signature = String(body?.signature ?? "").trim();
      const accountAddress = String(body?.accountAddress ?? "").trim();
      const walletAddress = normalizeAddress(String(body?.walletAddress ?? ""));
      if (!challengeId || !signature || !accountAddress || !walletAddress) {
        return badRequest("Missing required auth verify fields");
      }
      const challenge = await getChallenge(env.DB, challengeId);
      if (!challenge) return notFound("Unknown challengeId");
      if (challenge.used_at_iso) return badRequest("challenge_already_used");
      if (Date.parse(challenge.expires_at_iso) <= Date.now()) return badRequest("challenge_expired");
      if (challenge.account_address !== accountAddress) {
        return json(
          {
            ok: false,
            error: "challenge_account_mismatch",
            detail: `challengeAccount=${challenge.account_address} requestAccount=${accountAddress}`,
          },
          401,
        );
      }
      if (challenge.wallet_address !== walletAddress) {
        return json(
          {
            ok: false,
            error: "challenge_wallet_mismatch",
            detail: `challengeWallet=${challenge.wallet_address} requestWallet=${walletAddress}`,
          },
          401,
        );
      }
      try {
        let recoveredSigner = "";
        try {
          recoveredSigner = await recoverWebAuthSigner(challenge, signature);
        } catch {
          recoveredSigner = "";
        }
        if (recoveredSigner && recoveredSigner !== challenge.wallet_address) {
          return json(
            {
              ok: false,
              error: "wallet_signature_mismatch",
              detail: `recoveredSigner=${recoveredSigner} expectedWallet=${challenge.wallet_address}`,
            },
            401,
          );
        }
        const erc1271 = await verifyWebAuthErc1271(challenge, signature);
        if (!erc1271.ok) {
          return json(
            {
              ok: false,
              error: "erc1271_validation_failed",
              detail: `principalSmartAccount=${challenge.principal_smart_account} walletAddress=${challenge.wallet_address} digest=${erc1271.digest}`,
            },
            401,
          );
        }
        await markChallengeUsed(env.DB, challenge.challenge_id);
        const session = await createWebSession(env.DB, { challenge });
        return json({ ok: true, recoveredSigner: recoveredSigner || null, digest: erc1271.digest, session });
      } catch (e) {
        return badRequest("Failed to verify auth challenge", { detail: String((e as any)?.message ?? e) });
      }
    }

    if (url.pathname === "/api/a2a/session/status" && req.method === "GET") {
      const want = (env.A2A_WEB_KEY ?? "").trim();
      const got = (req.headers.get("x-web-key") ?? "").trim();
      if (!want || got !== want) return unauthorized("Unauthorized (bad x-web-key)");
      const accountAddress = (url.searchParams.get("accountAddress") ?? "").trim();
      if (!accountAddress) return badRequest("Missing accountAddress");
      try {
        const status = await sessionPackageStatus(env.DB, accountAddress);
        return json({ ok: true, ...status });
      } catch (e) {
        return badRequest("Failed to read session package status", { detail: String((e as any)?.message ?? e) });
      }
    }

    if (url.pathname === "/api/a2a/session/init" && req.method === "GET") {
      const want = (env.A2A_WEB_KEY ?? "").trim();
      const got = (req.headers.get("x-web-key") ?? "").trim();
      if (!want || got !== want) return unauthorized("Unauthorized (bad x-web-key)");
      const accountAddress = (url.searchParams.get("accountAddress") ?? "").trim();
      if (!accountAddress) return badRequest("Missing accountAddress");
      try {
        const init = await readSessionInit(env.DB, env, accountAddress);
        return json({
          ok: true,
          pending: init.pending,
          expired: init.expired,
          sessionAA: init.row?.session_aa ?? null,
          chainId: init.row?.chain_id ?? null,
          initData: init.initData,
        });
      } catch (e) {
        return badRequest("Failed to read session init", { detail: String((e as any)?.message ?? e) });
      }
    }

    if (url.pathname === "/api/a2a/session/init" && req.method === "POST") {
      const want = (env.A2A_ADMIN_KEY ?? "").trim();
      const got = (req.headers.get("x-admin-key") ?? "").trim();
      if (!want || got !== want) return unauthorized("Unauthorized (bad x-admin-key)");
      const body = await readBodyJson(req).catch((e) => ({ __error__: String((e as any)?.message ?? e) }));
      if (body?.__error__) return badRequest("Bad JSON body", { detail: body.__error__ });
      const accountAddress = String(body?.accountAddress ?? "").trim();
      const agentHandle = String(body?.agentHandle ?? "").trim().toLowerCase();
      const principalSmartAccount = normalizeAddress(String(body?.principalSmartAccount ?? ""));
      const principalOwnerEoa = normalizeAddress(String(body?.principalOwnerEoa ?? ""));
      const sessionAA = normalizeAddress(String(body?.sessionAA ?? ""));
      const chainId = Number(body?.chainId ?? DEFAULT_CHAIN_ID);
      const expiresAtISO = String(body?.expiresAtISO ?? "").trim();
      const initData = body?.initData && typeof body.initData === "object" ? (body.initData as Record<string, unknown>) : null;
      if (!accountAddress || !agentHandle || !principalSmartAccount || !principalOwnerEoa || !sessionAA || !expiresAtISO || !initData) {
        return badRequest("Missing required session init fields");
      }
      try {
        await upsertSessionInit(env.DB, env, {
          accountAddress,
          agentHandle,
          principalSmartAccount,
          principalOwnerEoa,
          chainId,
          sessionAA,
          expiresAtISO,
          initData,
        });
        return json({ ok: true, pending: true, sessionAA, chainId, expiresAtISO });
      } catch (e) {
        return badRequest("Failed to store session init", { detail: String((e as any)?.message ?? e) });
      }
    }

    if (url.pathname === "/api/a2a/session/package" && req.method === "POST") {
      const want = (env.A2A_ADMIN_KEY ?? "").trim();
      const got = (req.headers.get("x-admin-key") ?? "").trim();
      if (!want || got !== want) return unauthorized("Unauthorized (bad x-admin-key)");
      const body = await readBodyJson(req).catch((e) => ({ __error__: String((e as any)?.message ?? e) }));
      if (body?.__error__) return badRequest("Bad JSON body", { detail: body.__error__ });
      const accountAddress = String(body?.accountAddress ?? "").trim();
      const agentHandle = String(body?.agentHandle ?? "").trim().toLowerCase();
      const principalSmartAccount = normalizeAddress(String(body?.principalSmartAccount ?? ""));
      const principalOwnerEoa = normalizeAddress(String(body?.principalOwnerEoa ?? ""));
      const agentIdRaw = body?.agentId;
      const agentId = Number.isFinite(Number(agentIdRaw)) ? Number(agentIdRaw) : null;
      const chainId = Number(body?.chainId ?? DEFAULT_CHAIN_ID);
      const sessionPackage = body?.sessionPackage && typeof body.sessionPackage === "object" ? (body.sessionPackage as Record<string, unknown>) : null;
      if (!accountAddress || !agentHandle || !principalSmartAccount || !principalOwnerEoa || !sessionPackage) {
        return badRequest("Missing required session package fields");
      }
      try {
        const status = await upsertSessionPackage(env.DB, env, {
          accountAddress,
          agentHandle,
          principalSmartAccount,
          principalOwnerEoa,
          agentId,
          chainId,
          sessionPackage,
        });
        return json({ ok: true, ...status });
      } catch (e) {
        return badRequest("Failed to store session package", { detail: String((e as any)?.message ?? e) });
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

      const webSessionToken = (req.headers.get("x-a2a-web-session") ?? "").trim();
      let webSession: A2AWebSessionPayload | null = null;
      if (webSessionToken) {
        try {
          webSession = await verifyWebSessionToken(env.DB, webSessionToken);
        } catch (e) {
          const code = String((e as any)?.message ?? e);
          return unauthorized(code);
        }
        if (webSession.agentHandle !== handle) return unauthorized("session_handle_mismatch");
        if (webSession.accountAddress !== row.account_address) return unauthorized("session_account_mismatch");
      } else {
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
        let coreMcpAuth: { core: { bearerToken: string; expiresAtISO: string } };
        try {
          const minted = await mintCoreMcpDelegationToken(env, row.account_address);
          coreMcpAuth = {
            core: {
              bearerToken: minted.token,
              expiresAtISO: minted.claims.expiresAtISO,
            },
          };
        } catch (e) {
          console.warn("[gym-a2a-agent] core MCP delegation mint failed", {
            handle,
            accountAddress: row.account_address,
            detail: String((e as any)?.message ?? e),
          });
          return json({ ok: false, error: "core_mcp_delegation_unavailable", detail: String((e as any)?.message ?? e) }, 401);
        }
        const forwarded = await forwardToLangGraph(env, {
          handle,
          accountAddress: row.account_address,
          message,
          metadata: envl.metadata,
          mcpAuth: coreMcpAuth,
        });
        return json({
          ok: true,
          messageId,
          handle,
          accountAddress: row.account_address,
          response: { received: true, processedAt: nowISO(), answer: forwarded.answer },
          agentOutput: forwarded.output ?? null,
          raw: webSession ? undefined : forwarded.raw ?? null,
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

