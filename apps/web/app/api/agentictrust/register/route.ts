import { NextResponse } from "next/server";
import { requirePrivyAuth, eoaAddressForPrivyDid } from "../../_lib/privy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SUFFIX = "-gym.8004-agent.eth";

type Body = { baseName?: unknown };

function safeBaseName(v: unknown): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return "";
  if (!/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/i.test(s)) return "";
  return s;
}

function baseNameFromAgentName(agentName: string): string | null {
  const s = String(agentName ?? "").trim();
  if (!s.toLowerCase().endsWith(SUFFIX)) return null;
  const base = s.slice(0, -SUFFIX.length);
  return base ? base : null;
}

function nameCandidatesFromAgentRecord(ar: Record<string, unknown>): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v !== "string") return;
    const s = v.trim();
    if (!s) return;
    out.push(s);
  };
  push(ar.agentName);
  push(ar.name);
  push(ar.ensName);
  push(ar.ens_name);
  push(ar.identityEnsDid);

  const identities = ar.identities as unknown;
  if (Array.isArray(identities)) {
    for (const id of identities) {
      if (!id || typeof id !== "object") continue;
      const ir = id as Record<string, unknown>;
      push(ir.agentName);
      push(ir.name);
      push(ir.ensName);
      push(ir.ens_name);
      push(ir.did);
      push(ir.didIdentity);
      push(ir.identityEnsDid);
      const did = typeof ir.did === "string" ? ir.did.trim() : "";
      if (did.toLowerCase().startsWith("did:ens:")) push(did.slice("did:ens:".length));
    }
  }

  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const s of out) {
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(s);
  }
  return deduped;
}

function a2aAgentBaseUrl(): string {
  const u = String(process.env.A2A_AGENT_URL ?? "").trim();
  if (!u) throw new Error("Missing A2A_AGENT_URL");
  return u.replace(/\/+$/, "");
}

function a2aAdminKey(): string {
  const k = String(process.env.A2A_ADMIN_KEY ?? "").trim();
  if (!k) throw new Error("Missing A2A_ADMIN_KEY");
  return k;
}

function discoveryUrl(): string {
  const u = String(process.env.AGENTIC_TRUST_DISCOVERY_URL ?? "").trim();
  if (!u) throw new Error("Missing AGENTIC_TRUST_DISCOVERY_URL");
  return u.replace(/\/+$/, "");
}

function discoveryAuthHeader(): string {
  const k = String(process.env.AGENTIC_TRUST_DISCOVERY_API_KEY ?? "").trim();
  return `Bearer ${k}`;
}

async function findExistingGymAgent(baseName: string, chainId: number) {
  const target = `${baseName}${SUFFIX}`.toLowerCase();
  const res = await fetch(`${discoveryUrl()}/graphql`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: discoveryAuthHeader(),
    },
    body: JSON.stringify({
      query:
        "query($q:String!,$chainId:Int!,$limit:Int!){ searchAgents(query:$q, chainId:$chainId, limit:$limit){ agentId agentName didName } }",
      variables: { q: baseName, chainId, limit: 25 },
    }),
  });
  const json = (await res.json().catch(() => ({}))) as unknown;
  if (!res.ok) throw new Error(`discovery_http_${res.status}`);
  const rec = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
  const errs = rec.errors;
  if (Array.isArray(errs) && errs.length) {
    throw new Error(`discovery_graphql_${JSON.stringify(errs).slice(0, 200)}`);
  }
  const data = rec.data && typeof rec.data === "object" ? (rec.data as Record<string, unknown>) : {};
  const agents = Array.isArray(data.searchAgents) ? data.searchAgents : [];
  for (const a of agents) {
    if (!a || typeof a !== "object") continue;
    const ar = a as Record<string, unknown>;
    const agentName = typeof ar.agentName === "string" ? ar.agentName.trim() : "";
    const didName = typeof ar.didName === "string" ? ar.didName.trim() : "";
    if (agentName.toLowerCase() === target || didName.toLowerCase().endsWith(`:${target}`)) {
      return {
        agentId:
          typeof ar.agentId === "string" ? ar.agentId : typeof ar.agentId === "number" ? String(ar.agentId) : null,
        agentName: agentName || target,
        didName: didName || null,
      };
    }
  }
  return null;
}

async function upsertProfile(args: {
  accountAddress: string;
  eoaAddress: string | null;
  baseName: string;
  discoveredAgentName: string | null;
  discoveredEnsName: string | null;
}) {
  const base = a2aAgentBaseUrl();
  const adminKey = a2aAdminKey();
  const res = await fetch(`${base}/api/a2a/profile`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-key": adminKey },
    body: JSON.stringify({
      accountAddress: args.accountAddress,
      eoaAddress: args.eoaAddress,
      baseName: args.baseName,
      discoveredAgentName: args.discoveredAgentName,
      discoveredEnsName: args.discoveredEnsName,
    }),
  });
  const json = (await res.json().catch(() => ({}))) as unknown;
  if (!res.ok) throw new Error(`a2a_profile_upsert_failed:${res.status}:${JSON.stringify(json).slice(0, 200)}`);
  return json;
}

export async function POST(req: Request) {
  const auth = await requirePrivyAuth(req);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });

  const body = (await req.json().catch(() => null)) as Body | null;
  const baseName = safeBaseName(body?.baseName);
  if (!baseName) return NextResponse.json({ ok: false, error: "Invalid baseName" }, { status: 400 });

  const eoaAddress = await eoaAddressForPrivyDid(auth.did);
  if (!eoaAddress) {
    return NextResponse.json({ ok: false, error: "Missing embedded-wallet EOA for Privy user" }, { status: 400 });
  }

  const chainIdRaw = Number(String(process.env.AGENTIC_TRUST_CHAIN_ID ?? "").trim() || "11155111");
  const chainId = Number.isFinite(chainIdRaw) && chainIdRaw > 0 ? chainIdRaw : 11155111;
  const match = await findExistingGymAgent(baseName, chainId);
  if (match) {
    return NextResponse.json(
      { ok: false, error: "agent_exists", wantName: `${baseName}${SUFFIX}`, match },
      { status: 400 },
    );
  }

  const out = await upsertProfile({
    accountAddress: auth.accountAddress,
    eoaAddress,
    baseName,
    discoveredAgentName: null,
    discoveredEnsName: null,
  });
  return NextResponse.json({ ok: true, accountAddress: auth.accountAddress, eoaAddress, baseName, result: out });
}

export async function GET(req: Request) {
  const auth = await requirePrivyAuth(req);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });

  const url = new URL(req.url);
  const baseName = safeBaseName(url.searchParams.get("baseName"));
  if (!baseName) return NextResponse.json({ ok: false, error: "Invalid baseName" }, { status: 400 });

  const chainIdRaw = Number(String(process.env.AGENTIC_TRUST_CHAIN_ID ?? "").trim() || "11155111");
  const chainId = Number.isFinite(chainIdRaw) && chainIdRaw > 0 ? chainIdRaw : 11155111;
  const match = await findExistingGymAgent(baseName, chainId);
  return NextResponse.json({
    ok: true,
    baseName,
    fullName: `${baseName}${SUFFIX}`,
    available: !match,
    match,
  });
}

