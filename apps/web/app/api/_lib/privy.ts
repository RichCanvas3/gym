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

export async function requirePrivyAuth(req: Request): Promise<PrivyAuthOk | PrivyAuthErr> {
  const auth = req.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return { ok: false, status: 401, error: "Missing Authorization: Bearer <token>" };
  const accessToken = String(m[1] ?? "").trim();
  if (!accessToken) return { ok: false, status: 401, error: "Missing access token" };

  try {
    const privy = privyClient();
    const verified = await privy.utils().auth().verifyAccessToken(accessToken);
    const did = typeof (verified as any)?.userId === "string" ? String((verified as any).userId).trim() : "";
    if (!did) return { ok: false, status: 401, error: "Invalid Privy token (missing DID)" };
    return { ok: true, did, accountAddress: accountAddressFromPrivyDid(did) };
  } catch (e) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }
}

