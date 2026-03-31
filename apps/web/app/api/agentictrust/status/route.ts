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
  const saved = await readSavedProfile(auth.accountAddress).catch(() => ({ ok: false, profile: null }));
  const savedRec = saved && typeof saved === "object" ? (saved as Record<string, unknown>) : {};
  const prof = savedRec.profile && typeof savedRec.profile === "object" ? (savedRec.profile as Record<string, unknown>) : {};
  const savedBaseName = typeof prof.baseName === "string" && prof.baseName.trim() ? prof.baseName.trim() : null;

  const discoveryUrl = String(process.env.AGENTIC_TRUST_DISCOVERY_URL ?? "").trim();
  const discoveryApiKey = String(process.env.AGENTIC_TRUST_DISCOVERY_API_KEY ?? "").trim();
  if (!discoveryUrl) {
    return NextResponse.json(
      { ok: false, error: "Missing AGENTIC_TRUST_DISCOVERY_URL", eoaAddress, savedBaseName },
      { status: 500 },
    );
  }
  if (!eoaAddress) {
    return NextResponse.json(
      { ok: true, eoaAddress: null, discovered: null, savedBaseName, note: "No embedded-wallet EOA found in Privy user." },
      { status: 200 },
    );
  }

  // Lazy import to keep cold-start smaller when this route isn't used.
  const mod = await import("@agentic-trust/core/server");
  const AgenticTrustClient = (mod as unknown as { AgenticTrustClient: { create: (args: any) => Promise<any> } })
    .AgenticTrustClient;

  const client = await AgenticTrustClient.create({
    graphQLUrl: discoveryUrl,
    apiKey: discoveryApiKey || undefined,
  });

  // Best-effort discovery: search by suffix; filter client-side.
  const resp = await client.searchAgents({ query: "gym.8004-agent.eth", page: 1, pageSize: 50 });
  const agents: unknown[] = Array.isArray(resp?.agents) ? resp.agents : [];

  let discovered: { agentName: string; ensName: string | null; baseName: string; agentId?: string | null; chainId?: number | null } | null =
    null;

  for (const a of agents) {
    if (!a || typeof a !== "object") continue;
    const ar = a as Record<string, unknown>;
    const agentName = typeof ar.agentName === "string" ? ar.agentName : typeof ar.name === "string" ? ar.name : "";
    const ensName = typeof ar.ensName === "string" ? ar.ensName : typeof ar.ens_name === "string" ? ar.ens_name : null;
    const baseName = baseNameFromAgentName(agentName ?? "") ?? (ensName ? baseNameFromAgentName(ensName) : null);
    if (!baseName) continue;

    // Confirm ownership by EOA when possible.
    const agentId = typeof ar.agentId === "string" ? ar.agentId : typeof ar.id === "string" ? ar.id : null;
    const chainId =
      typeof ar.chainId === "number" ? ar.chainId : typeof ar.chain_id === "number" ? ar.chain_id : typeof ar.chainId === "string" ? Number(ar.chainId) : null;
    if (agentId && chainId && Number.isFinite(chainId)) {
      try {
        const owner = await client.getAgentOwner(agentId, chainId);
        const ownerAddr =
          owner && typeof owner === "object"
            ? (owner as Record<string, unknown>).ownerAddress ?? (owner as Record<string, unknown>).address
            : null;
        const ownerStr = typeof ownerAddr === "string" ? ownerAddr.trim().toLowerCase() : "";
        if (ownerStr && ownerStr !== eoaAddress.toLowerCase()) continue;
      } catch {
        // If owner check fails, still allow match (discovery might already include owner).
      }
    }

    discovered = { agentName, ensName, baseName, agentId, chainId };
    break;
  }

  // Persist discovered baseName if present and no user-chosen baseName exists.
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
    savedBaseName: savedBaseName ?? (discovered?.baseName ?? null),
  });
}

