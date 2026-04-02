import { NextResponse } from "next/server";
import { requirePrivyAuth, eoaAddressForPrivyDid } from "../../_lib/privy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SUFFIX = "-gym.8004-agent.eth";

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

function a2aWebKey(): string {
  const k = String(process.env.A2A_WEB_KEY ?? "").trim();
  if (!k) throw new Error("Missing A2A_WEB_KEY");
  return k;
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
      if (did.toLowerCase().startsWith("did:ens:")) {
        push(did.slice("did:ens:".length));
      }
    }
  }

  // de-dupe preserving order
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

type SavedProfile = {
  ok?: boolean;
  profile?: {
    baseName?: unknown;
    discoveredAgentName?: unknown;
    discoveredEnsName?: unknown;
    eoaAddress?: unknown;
    updatedAtISO?: unknown;
  } | null;
};

async function readSavedProfile(accountAddress: string): Promise<SavedProfile> {
  const base = a2aAgentBaseUrl();
  const webKey = a2aWebKey();
  const url = `${base}/api/a2a/profile?accountAddress=${encodeURIComponent(accountAddress)}`;
  const res = await fetch(url, { headers: { "x-web-key": webKey } });
  const json = (await res.json().catch(() => ({}))) as unknown;
  if (!res.ok) return { ok: false, profile: null, ...(json && typeof json === "object" ? (json as object) : {}) };
  return (json && typeof json === "object" ? (json as SavedProfile) : { ok: false, profile: null }) as SavedProfile;
}

async function upsertSavedProfile(args: {
  accountAddress: string;
  eoaAddress: string | null;
  baseName: string | null;
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

export async function GET(req: Request) {
  const auth = await requirePrivyAuth(req);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });

  const eoaAddress = await eoaAddressForPrivyDid(auth.did);
  try {
    console.log("[agentictrust] eoaAddress", { accountAddress: auth.accountAddress, eoaAddress });
  } catch {
    // ignore
  }
  const saved = await readSavedProfile(auth.accountAddress).catch(() => ({ ok: false, profile: null }));
  const savedRec = saved && typeof saved === "object" ? (saved as Record<string, unknown>) : {};
  const prof = savedRec.profile && typeof savedRec.profile === "object" ? (savedRec.profile as Record<string, unknown>) : {};
  const savedBaseName = typeof prof.baseName === "string" && prof.baseName.trim() ? prof.baseName.trim() : null;

  const discoveryUrl = String(process.env.AGENTIC_TRUST_DISCOVERY_URL ?? "").trim();
  const discoveryApiKey = String(process.env.AGENTIC_TRUST_DISCOVERY_API_KEY ?? "").trim();
  if (!discoveryUrl) {
    return NextResponse.json({ ok: false, error: "Missing AGENTIC_TRUST_DISCOVERY_URL", eoaAddress, savedBaseName: null }, { status: 500 });
  }
  if (!eoaAddress) {
    return NextResponse.json(
      {
        ok: true,
        eoaAddress: null,
        discovered: null,
        savedBaseName: null,
        pendingBaseName: savedBaseName,
        note: "No embedded-wallet EOA found in Privy user.",
      },
      { status: 200 },
    );
  }

  // Use discovery client owned-agents lookup (matches dao-collab usage).
  const mod = await import("@agentic-trust/core/server");
  const getDiscoveryClient = (mod as unknown as { getDiscoveryClient: (cfg?: { endpoint?: string; apiKey?: string }) => Promise<any> })
    .getDiscoveryClient;
  const discoveryClient = await getDiscoveryClient({ endpoint: discoveryUrl, apiKey: discoveryApiKey || undefined });
  const chainIdRaw = Number(String(process.env.AGENTIC_TRUST_CHAIN_ID ?? "").trim() || "11155111");
  const chainId = Number.isFinite(chainIdRaw) && chainIdRaw > 0 ? chainIdRaw : 11155111;
  const owned = (await discoveryClient.getAgentsByAgentAccountOwnerEoa(chainId, eoaAddress, {
    first: 200,
    skip: 0,
    includeIdentityAndAccounts: true,
  })) as { agents?: unknown[]; total?: unknown; hasMore?: unknown };
  const agents = Array.isArray(owned?.agents) ? owned.agents : [];
  try {
    console.log("[agentictrust] getAgentsByAgentAccountOwnerEoa", {
      chainId,
      eoaAddress,
      count: Array.isArray(agents) ? agents.length : 0,
      total: typeof owned?.total === "number" ? owned.total : null,
      hasMore: owned?.hasMore === true,
      agents,
    });
  } catch {
    // ignore
  }

  let discovered: { agentName: string; ensName: string | null; baseName: string; agentId?: string | null; chainId?: number | null } | null =
    null;

  for (const a of agents) {
    if (!a || typeof a !== "object") continue;
    const ar = a as Record<string, unknown>;
    const candidates = nameCandidatesFromAgentRecord(ar);
    for (const cand of candidates) {
      const baseName = baseNameFromAgentName(cand);
      if (!discovered && baseName) {
        const ensName = cand.toLowerCase().endsWith(SUFFIX) ? cand : null;

        const agentId =
          typeof ar.agentId === "string"
            ? ar.agentId
            : typeof ar.agentId === "number"
              ? String(ar.agentId)
              : typeof ar.id === "string"
                ? ar.id
                : null;
        const chainId =
          typeof ar.chainId === "number"
            ? ar.chainId
            : typeof ar.chain_id === "number"
              ? ar.chain_id
              : typeof ar.chainId === "string"
                ? Number(ar.chainId)
                : null;
        discovered = { agentName: cand, ensName, baseName, agentId, chainId: Number.isFinite(chainId ?? NaN) ? (chainId as number) : null };
      }
    }
    if (discovered) break;
  }

  const validBaseName = discovered?.baseName ?? null;

  // Persist discovered baseName if present and no user-chosen baseName exists.
  console.log("[agentictrust] discovered", discovered);
  console.log("[agentictrust] savedBaseName", savedBaseName);
  console.log("[agentictrust] saved", saved);
  console.log("[agentictrust] auth", auth);
  console.log("[agentictrust] eoaAddress", eoaAddress);
  console.log("[agentictrust] auth.accountAddress", auth.accountAddress);
  console.log("[agentictrust] auth.did", auth.did);

  if (discovered?.baseName && !savedBaseName) {
    try {
      await upsertSavedProfile({
        accountAddress: auth.accountAddress,
        eoaAddress,
        baseName: discovered.baseName,
        discoveredAgentName: discovered.agentName,
        discoveredEnsName: discovered.ensName,
      });
    } catch {
      // ignore
    }
  }

  return NextResponse.json({
    ok: true,
    accountAddress: auth.accountAddress,
    eoaAddress,
    discovered: discovered
      ? { agentName: discovered.agentName, ensName: discovered.ensName, baseName: discovered.baseName }
      : null,
    savedBaseName: validBaseName,
    pendingBaseName: !validBaseName && savedBaseName ? savedBaseName : null,
  });
}

