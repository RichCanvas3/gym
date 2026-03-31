import crypto from "node:crypto";
import { PrivyClient } from "@privy-io/node";

type PrivyAuthOk = {
  ok: true;
  did: string;
  accountAddress: string;
};

type PrivyAuthErr = {
  ok: false;
  status: number;
  error: string;
};

let _privy: PrivyClient | null = null;

function privyClient(): PrivyClient {
  if (_privy) return _privy;
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "";
  const appSecret = process.env.PRIVY_APP_SECRET ?? "";
  const jwtVerificationKey = process.env.PRIVY_JWT_VERIFICATION_KEY ?? "";
  if (!appId || !appSecret) {
    throw new Error("Missing NEXT_PUBLIC_PRIVY_APP_ID or PRIVY_APP_SECRET");
  }
  _privy = new PrivyClient({
    appId,
    appSecret,
    jwtVerificationKey: jwtVerificationKey || undefined,
  });
  return _privy;
}

export function accountAddressFromPrivyDid(did: string): string {
  const h = crypto.createHash("sha256").update(did, "utf8").digest("base64url");
  return `acct:privy_${h}`;
}

type UnknownAsyncFn = (arg: unknown) => Promise<unknown>;

function extractDid(verifiedClaims: unknown): string {
  if (!verifiedClaims || typeof verifiedClaims !== "object") return "";
  const v = verifiedClaims as Record<string, unknown>;
  const user = v.user && typeof v.user === "object" ? (v.user as Record<string, unknown>) : null;
  const claims = v.claims && typeof v.claims === "object" ? (v.claims as Record<string, unknown>) : null;
  const candidates: unknown[] = [
    v.userId,
    v.user_id,
    v.sub,
    user?.id,
    user?.userId,
    claims?.userId,
    claims?.sub,
  ];
  for (const c of candidates) {
    if (typeof c === "string") {
      const s = c.trim();
      if (s) return s;
    }
  }
  return "";
}

function diagEnv(): string {
  const appId = String(process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "").trim();
  const appSecret = String(process.env.PRIVY_APP_SECRET ?? "").trim();
  const jwtKey = String(process.env.PRIVY_JWT_VERIFICATION_KEY ?? "").trim();
  return `env(appId=${Boolean(appId)},secret=${Boolean(appSecret)},jwtKey=${Boolean(jwtKey)})`;
}

export async function requirePrivyAuth(req: Request): Promise<PrivyAuthOk | PrivyAuthErr> {
  const auth = req.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return { ok: false, status: 401, error: "Missing Authorization: Bearer <token>" };
  const accessToken = String(m[1] ?? "").trim();
  if (!accessToken) return { ok: false, status: 401, error: "Missing access token" };
  if (accessToken.split(".").length !== 3) {
    return { ok: false, status: 401, error: "Invalid access token format (expected JWT)" };
  }

  try {
    const dev = process.env.NODE_ENV !== "production";
    const privy = privyClient();
    const diag = dev ? diagEnv() : "";
    let verified: unknown;
    try {
      // Current Privy SDK shape (per docs): verifyAccessToken({ access_token })
      const p = privy as unknown as { utils: () => { auth: () => { verifyAccessToken: (arg: unknown) => Promise<unknown> } } };
      verified = await p.utils().auth().verifyAccessToken({ access_token: accessToken });
    } catch {
      try {
        // Back-compat: some versions accepted verifyAccessToken(accessToken)
        const p = privy as unknown as { utils: () => { auth: () => { verifyAccessToken: (arg: unknown) => Promise<unknown> } } };
        verified = await p.utils().auth().verifyAccessToken(accessToken);
      } catch (e2) {
        const verifyAuthToken = (privy as unknown as { verifyAuthToken?: UnknownAsyncFn }).verifyAuthToken;
        if (typeof verifyAuthToken === "function") {
          verified = await verifyAuthToken.call(privy, accessToken);
        } else {
          throw e2;
        }
      }
    }
    const did = extractDid(verified);
    if (!did) {
      if (dev) {
        const keys =
          verified && typeof verified === "object" ? Object.keys(verified as Record<string, unknown>) : [];
        console.warn("[privy] verified token but missing DID", { keys });
      }
      return {
        ok: false,
        status: 401,
        error: dev ? `Invalid Privy token (missing DID). ${diag}` : "Invalid Privy token (missing DID)",
      };
    }
    return { ok: true, did, accountAddress: accountAddressFromPrivyDid(did) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e ?? "");
    if (process.env.NODE_ENV !== "production" && msg) {
      console.warn("[privy] access token verification failed", msg);
      return {
        ok: false,
        status: 401,
        error: `Unauthorized (check PRIVY_APP_SECRET matches NEXT_PUBLIC_PRIVY_APP_ID). ${msg} (${diagEnv()})`,
      };
    }
    return { ok: false, status: 401, error: "Unauthorized" };
  }
}

function extractTelegramUserIdFromPrivyUser(user: unknown): string | null {
  if (!user || typeof user !== "object") return null;
  const u = user as Record<string, unknown>;
  const linked = (u.linked_accounts ?? u.linkedAccounts) as unknown;
  if (!Array.isArray(linked)) return null;
  for (const a of linked) {
    if (!a || typeof a !== "object") continue;
    const acc = a as Record<string, unknown>;
    const type = typeof acc.type === "string" ? acc.type : "";
    if (type !== "telegram") continue;
    const candidates: unknown[] = [acc.telegram_user_id, (acc as Record<string, unknown>).telegramUserId, (acc as Record<string, unknown>).telegram_userId];
    for (const c of candidates) {
      if (typeof c === "string" && c.trim()) return c.trim();
      if (typeof c === "number" && Number.isFinite(c)) return String(c);
    }
  }
  return null;
}

export async function telegramUserIdForPrivyDid(did: string): Promise<string | null> {
  const clean = String(did ?? "").trim();
  if (!clean) return null;
  try {
    const privy = privyClient();
    // Privy docs: users()._get(<did>) returns user JSON (linked_accounts includes telegram_user_id when linked).
    const user = await (privy as unknown as { users: () => { _get: (id: string) => Promise<unknown> } })
      .users()
      ._get(clean);
    return extractTelegramUserIdFromPrivyUser(user);
  } catch {
    return null;
  }
}

function extractEoaFromPrivyUser(user: unknown): `0x${string}` | null {
  if (!user || typeof user !== "object") return null;
  const u = user as Record<string, unknown>;

  const candidates: unknown[] = [];
  // Common top-level fields (varies by Privy account type)
  candidates.push(u.wallet_address, u.walletAddress, u.address);

  // linked_accounts frequently contains embedded wallet entries
  const linked = (u.linked_accounts ?? u.linkedAccounts) as unknown;
  if (Array.isArray(linked)) {
    for (const a of linked) {
      if (!a || typeof a !== "object") continue;
      const acc = a as Record<string, unknown>;
      candidates.push(acc.address, acc.wallet_address, acc.walletAddress);

      const wallet = acc.wallet && typeof acc.wallet === "object" ? (acc.wallet as Record<string, unknown>) : null;
      if (wallet) candidates.push(wallet.address, wallet.wallet_address, wallet.walletAddress);
    }
  }

  // Some shapes include `wallets: [{ address }]`
  const wallets = u.wallets as unknown;
  if (Array.isArray(wallets)) {
    for (const w of wallets) {
      if (!w || typeof w !== "object") continue;
      const wr = w as Record<string, unknown>;
      candidates.push(wr.address, wr.wallet_address, wr.walletAddress);
    }
  }

  for (const c of candidates) {
    if (typeof c !== "string") continue;
    const s = c.trim();
    if (/^0x[0-9a-fA-F]{40}$/.test(s)) return s.toLowerCase() as `0x${string}`;
  }
  return null;
}

export async function eoaAddressForPrivyDid(did: string): Promise<`0x${string}` | null> {
  const clean = String(did ?? "").trim();
  if (!clean) return null;
  try {
    const privy = privyClient();
    const user = await (privy as unknown as { users: () => { _get: (id: string) => Promise<unknown> } })
      .users()
      ._get(clean);
    return extractEoaFromPrivyUser(user);
  } catch {
    return null;
  }
}

