type StatusJson = unknown;

let lastCacheKey: string | null = null;
let cached: { atMs: number; json: StatusJson } | null = null;
let inFlight: Promise<StatusJson> | null = null;

export async function getAgentictrustStatusCached(args: {
  accountAddress: string | null;
  accessToken: string | null;
  walletAddress?: string | null;
  cacheMs?: number;
}): Promise<StatusJson> {
  const acct = (args.accountAddress ?? "").trim() || null;
  const tok = (args.accessToken ?? "").trim() || null;
  const walletAddress = (args.walletAddress ?? "").trim().toLowerCase() || null;
  if (!acct) return {};
  if (!tok) return {};
  const cacheKey = walletAddress ? `${acct}:${walletAddress}` : acct;

  if (lastCacheKey !== cacheKey) {
    lastCacheKey = cacheKey;
    cached = null;
    inFlight = null;
  }

  const cacheMs = typeof args.cacheMs === "number" && Number.isFinite(args.cacheMs) ? Math.max(0, args.cacheMs) : 60_000;
  const now = Date.now();
  if (cached && now - cached.atMs <= cacheMs) return cached.json;
  if (inFlight) return await inFlight;

  inFlight = (async () => {
    const url = walletAddress ? `/api/agentictrust/status?walletAddress=${encodeURIComponent(walletAddress)}` : "/api/agentictrust/status";
    const res = await fetch(url, { headers: { authorization: `Bearer ${tok}` } });
    const json = (await res.json().catch(() => ({}))) as StatusJson;
    cached = { atMs: Date.now(), json };
    return json;
  })().finally(() => {
    inFlight = null;
  });

  return await inFlight;
}

export function setAgentictrustStatusCached(accountAddress: string | null, json: StatusJson, walletAddress?: string | null) {
  const acct = (accountAddress ?? "").trim() || null;
  const wallet = (walletAddress ?? "").trim().toLowerCase() || null;
  if (!acct) return;
  lastCacheKey = wallet ? `${acct}:${wallet}` : acct;
  cached = { atMs: Date.now(), json };
  inFlight = null;
}

