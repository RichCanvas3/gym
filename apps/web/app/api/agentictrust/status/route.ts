import { NextResponse } from "next/server";
import { extractAgentAccountFromDiscovery, getAgenticTrustClient, getDiscoveryClient } from "@agentic-trust/core/server";
import { requirePrivyAuth, eoaAddressForPrivyDid } from "../../_lib/privy";
import { baseNameFromGymAgentName, gymAgentLabelFromBaseName, gymAgentNameFromBaseName, nameCandidatesFromAgentRecord } from "../_lib/gym-agent";
import { createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

function a2aHandleBaseDomain(): string {
  const s = String(process.env.A2A_HANDLE_BASE_DOMAIN ?? "").trim();
  if (!s) throw new Error("Missing A2A_HANDLE_BASE_DOMAIN");
  const noProto = s.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  if (!noProto) throw new Error("Invalid A2A_HANDLE_BASE_DOMAIN");
  return noProto;
}

function registrationChainId(): number {
  const raw = Number(String(process.env.AGENTIC_TRUST_CHAIN_ID ?? "").trim() || "11155111");
  return Number.isFinite(raw) && raw > 0 ? raw : 11155111;
}

function hasEnsReadConfig(chainId: number): boolean {
  if (chainId === 11155111) {
    return Boolean(
      String(process.env.AGENTIC_TRUST_ENS_REGISTRY_SEPOLIA ?? process.env.NEXT_PUBLIC_AGENTIC_TRUST_ENS_REGISTRY_SEPOLIA ?? "").trim() &&
        String(process.env.AGENTIC_TRUST_ENS_RESOLVER_SEPOLIA ?? process.env.NEXT_PUBLIC_AGENTIC_TRUST_ENS_RESOLVER_SEPOLIA ?? "").trim(),
    );
  }
  return true;
}

function normalizeAddress(value: unknown): `0x${string}` | null {
  const s = typeof value === "string" ? value.trim() : "";
  if (!/^0x[a-fA-F0-9]{40}$/.test(s)) return null;
  return s.toLowerCase() as `0x${string}`;
}

function a2aHostForBaseName(baseName: string): string {
  return `https://${gymAgentLabelFromBaseName(baseName)}.${a2aHandleBaseDomain()}`;
}

function rpcUrlForChain(chainId: number): string {
  if (chainId === 11155111) {
    return String(process.env.AGENTIC_TRUST_RPC_URL_SEPOLIA ?? process.env.NEXT_PUBLIC_AGENTIC_TRUST_RPC_URL_SEPOLIA ?? "").trim();
  }
  return "";
}

async function readSmartAccountOwner(chainId: number, smartAccount: string): Promise<`0x${string}` | null> {
  const account = normalizeAddress(smartAccount);
  const rpcUrl = rpcUrlForChain(chainId);
  if (!account || !rpcUrl) return null;
  if (chainId !== 11155111) return null;
  const client = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });
  try {
    const owner = await client.readContract({
      address: account,
      abi: [
        {
          type: "function",
          name: "owner",
          stateMutability: "view",
          inputs: [],
          outputs: [{ type: "address" }],
        },
      ],
      functionName: "owner",
    });
    return normalizeAddress(owner);
  } catch {
    return null;
  }
}

async function isA2aEndpointReachable(a2aHost: string): Promise<boolean> {
  try {
    const res = await fetch(`${a2aHost}/.well-known/agent.json`, { cache: "no-store" });
    return res.ok;
  } catch {
    return false;
  }
}

type DiscoveredGymAgent = {
  agentName: string;
  ensName: string | null;
  baseName: string;
  agentId?: string | null;
  chainId?: number | null;
  agentAccount?: `0x${string}` | null;
};

async function discoverOwnedGymAgent(args: {
  chainId: number;
  eoaAddress: `0x${string}`;
  discoveryUrl: string;
  discoveryApiKey?: string;
}): Promise<DiscoveredGymAgent | null> {
  const discoveryClient = await getDiscoveryClient({ endpoint: args.discoveryUrl, apiKey: args.discoveryApiKey || undefined });
  const owned = (await discoveryClient.getAgentsByAgentAccountOwnerEoa(args.chainId, args.eoaAddress, {
    first: 200,
    skip: 0,
    includeIdentityAndAccounts: true,
  })) as { agents?: unknown[]; total?: unknown; hasMore?: unknown };
  const agents = Array.isArray(owned?.agents) ? owned.agents : [];
  try {
    console.log("[agentictrust] getAgentsByAgentAccountOwnerEoa", {
      chainId: args.chainId,
      eoaAddress: args.eoaAddress,
      count: Array.isArray(agents) ? agents.length : 0,
      total: typeof owned?.total === "number" ? owned.total : null,
      hasMore: owned?.hasMore === true,
    });
  } catch {
    // ignore
  }

  for (const a of agents) {
    if (!a || typeof a !== "object") continue;
    const ar = a as Record<string, unknown>;
    const candidates = nameCandidatesFromAgentRecord(ar);
    for (const cand of candidates) {
      const baseName = baseNameFromGymAgentName(cand);
      if (!baseName) continue;
      const ensName = cand.toLowerCase().endsWith(".8004-agent.eth") ? cand : null;
      const agentId =
        typeof ar.agentId === "string"
          ? ar.agentId
          : typeof ar.agentId === "number"
            ? String(ar.agentId)
            : typeof ar.id === "string"
              ? ar.id
              : null;
      const discoveredChainId =
        typeof ar.chainId === "number"
          ? ar.chainId
          : typeof ar.chain_id === "number"
            ? ar.chain_id
            : typeof ar.chainId === "string"
              ? Number(ar.chainId)
              : null;
      return {
        agentName: cand,
        ensName,
        baseName,
        agentId,
        chainId: Number.isFinite(discoveredChainId ?? NaN) ? (discoveredChainId as number) : null,
        agentAccount: extractAgentAccountFromDiscovery(a) ?? null,
      };
    }
  }
  return null;
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
  const chainId = registrationChainId();
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
    return NextResponse.json({ ok: false, error: "missing_agentictrust_discovery_url" }, { status: 500 });
  }
  if (!eoaAddress) {
    return NextResponse.json(
      {
        ok: true,
        eoaAddress: null,
        discovered: null,
        savedBaseName,
        pendingBaseName: savedBaseName,
        registrationRequired: !savedBaseName,
        note: "No connected Ethereum wallet EOA found in Privy user.",
      },
      { status: 200 },
    );
  }
  const discovered = await discoverOwnedGymAgent({
    chainId,
    eoaAddress: eoaAddress as `0x${string}`,
    discoveryUrl,
    discoveryApiKey,
  }).catch((e) => {
    const msg = e instanceof Error ? e.message : String(e ?? "");
    return NextResponse.json({ ok: false, error: "agent_discovery_failed", detail: msg }, { status: 502 });
  });
  if (discovered instanceof NextResponse) return discovered;

  if (savedBaseName) {
    const fullAgentName = gymAgentNameFromBaseName(savedBaseName);
    const a2aHost = a2aHostForBaseName(savedBaseName);
    const canReadEns = hasEnsReadConfig(chainId);
    const client = canReadEns ? await getAgenticTrustClient() : null;
    const agentInfo = canReadEns ? await client?.getENSInfo(fullAgentName, chainId).catch(() => null) : null;
    const discoveredForSaved = discovered?.baseName === savedBaseName ? discovered : null;
    const agentAccount = discoveredForSaved?.agentAccount ?? normalizeAddress(agentInfo?.account) ?? "";
    const savedProfileEoa = normalizeAddress(prof.eoaAddress);
    const owner = agentAccount ? await readSmartAccountOwner(chainId, agentAccount) : null;
    const liveOwnerMatches = Boolean(owner) && owner === eoaAddress.toLowerCase();
    const savedOwnerMatchesCurrent = Boolean(savedProfileEoa) && savedProfileEoa === eoaAddress.toLowerCase();
    const validOwner = Boolean(agentAccount) && (liveOwnerMatches || (!owner && savedOwnerMatchesCurrent));
    const discoveredOwnedAgent = Boolean(discoveredForSaved?.agentAccount);
    const resolvedOwnerEoa = owner ?? (savedOwnerMatchesCurrent ? savedProfileEoa : null);
    if (owner && savedProfileEoa !== owner) {
      try {
        await upsertSavedProfile({
          accountAddress: auth.accountAddress,
          eoaAddress: owner,
          baseName: savedBaseName,
          discoveredAgentName: discoveredForSaved?.agentName ?? fullAgentName,
          discoveredEnsName: discoveredForSaved?.ensName ?? fullAgentName,
        });
      } catch {
        // ignore
      }
    }
    if (validOwner) {
      const chatReady = await isA2aEndpointReachable(a2aHost);
      return NextResponse.json({
        ok: true,
        accountAddress: auth.accountAddress,
        eoaAddress,
        chainId,
        discovered: {
          agentName: fullAgentName,
          ensName: fullAgentName,
          baseName: savedBaseName,
        },
        savedBaseName,
        pendingBaseName: null,
        registrationRequired: false,
        fullAgentName,
        agentHandle: gymAgentLabelFromBaseName(savedBaseName),
        a2aHost,
        agentId: discoveredForSaved?.agentId ?? null,
        agentAccount: agentAccount ?? null,
        agentOwnerEoa: resolvedOwnerEoa,
        chatReady,
        ownerSource: owner ? "onchain" : "saved_profile",
      });
    }
    if (canReadEns && agentAccount && !validOwner) {
      const ownerText = owner ?? savedProfileEoa ?? "(unresolved)";
      const agentAccountText = agentAccount || "(unresolved)";
      return NextResponse.json({
        ok: true,
        accountAddress: auth.accountAddress,
        eoaAddress,
        chainId,
        discovered: null,
        savedBaseName,
        pendingBaseName: savedBaseName,
        registrationRequired: false,
        fullAgentName,
        agentHandle: gymAgentLabelFromBaseName(savedBaseName),
        a2aHost,
        chatReady: false,
        note: `Saved gym agent registration EOA does not match the current Privy EOA. agentAccount=${agentAccountText} registeredEoa=${ownerText} currentEoa=${eoaAddress}`,
      });
    }
    if (!canReadEns) {
      return NextResponse.json({
        ok: true,
        accountAddress: auth.accountAddress,
        eoaAddress,
        chainId,
        discovered: null,
        savedBaseName,
        pendingBaseName: savedBaseName,
        registrationRequired: false,
        fullAgentName,
        agentHandle: gymAgentLabelFromBaseName(savedBaseName),
        a2aHost,
        chatReady: false,
        note: "ENS resolver/registry env is not configured for live verification yet.",
      });
    }
  }


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

  const validBaseName = discovered?.baseName ?? null;
  const activeBaseName = validBaseName ?? savedBaseName;
  const a2aHost = activeBaseName ? a2aHostForBaseName(activeBaseName) : null;
  const discoveredOwner = discovered?.agentAccount ? await readSmartAccountOwner(chainId, discovered.agentAccount).catch(() => null) : null;
  const chatReady = a2aHost ? await isA2aEndpointReachable(a2aHost) : false;

  return NextResponse.json({
    ok: true,
    accountAddress: auth.accountAddress,
    eoaAddress,
    chainId,
    discovered: discovered
      ? { agentName: discovered.agentName, ensName: discovered.ensName, baseName: discovered.baseName }
      : null,
    agentId: discovered?.agentId ?? null,
    agentAccount: discovered?.agentAccount ?? null,
    agentOwnerEoa: typeof discoveredOwner === "string" ? discoveredOwner : null,
    savedBaseName,
    pendingBaseName: !validBaseName && savedBaseName ? savedBaseName : null,
    registrationRequired: !activeBaseName,
    fullAgentName: activeBaseName ? gymAgentNameFromBaseName(activeBaseName) : null,
    agentHandle: activeBaseName ? gymAgentLabelFromBaseName(activeBaseName) : null,
    a2aHost,
    chatReady,
  });
}

