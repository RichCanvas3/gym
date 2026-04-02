type StatusJson = unknown;

let lastAccountAddress: string | null = null;
let cached: { atMs: number; json: StatusJson } | null = null;
let inFlight: Promise<StatusJson> | null = null;

export async function getAgentictrustStatusCached(args: {
  accountAddress: string | null;
  accessToken: string | null;
  cacheMs?: number;
}): Promise<StatusJson> {
  const acct = (args.accountAddress ?? "").trim() || null;
  const tok = (args.accessToken ?? "").trim() || null;
  if (!acct) return {};
  if (!tok) return {};

  if (lastAccountAddress !== acct) {
    lastAccountAddress = acct;
    cached = null;
    inFlight = null;
  }

  const cacheMs = typeof args.cacheMs === "number" && Number.isFinite(args.cacheMs) ? Math.max(0, args.cacheMs) : 60_000;
  const now = Date.now();
  if (cached && now - cached.atMs <= cacheMs) return cached.json;
  if (inFlight) return await inFlight;

  inFlight = (async () => {
    const res = await fetch("/api/agentictrust/status", { headers: { authorization: `Bearer ${tok}` } });
    const json = (await res.json().catch(() => ({}))) as StatusJson;
    cached = { atMs: Date.now(), json };
    return json;
  })().finally(() => {
    inFlight = null;
  });

  return await inFlight;
}

export function setAgentictrustStatusCached(accountAddress: string | null, json: StatusJson) {
  const acct = (accountAddress ?? "").trim() || null;
  if (!acct) return;
  lastAccountAddress = acct;
  cached = { atMs: Date.now(), json };
  inFlight = null;
}

