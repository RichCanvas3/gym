import { NextResponse } from "next/server";
import { extractAgentAccountFromDiscovery, getAccountOwner, getAgenticTrustClient, getDiscoveryClient, getENSClient } from "@agentic-trust/core/server";
import { requirePrivyAuth, eoaAddressForPrivyDid } from "../../_lib/privy";
import { baseNameFromGymAgentName, gymAgentLabelFromBaseName, gymAgentNameFromBaseName, nameCandidatesFromAgentRecord } from "../_lib/gym-agent";

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
  return s as `0x${string}`;
}

function a2aHostForBaseName(baseName: string): string {
  return `https://${gymAgentLabelFromBaseName(baseName)}.${a2aHandleBaseDomain()}`;
}

async function ensNameHasOwner(fullName: string, chainId: number): Promise<boolean> {
  const withoutEth = fullName.trim().toLowerCase().replace(/\.eth$/i, "");
  const parts = withoutEth.split(".");
  if (parts.length < 2) return false;
  const agentNameLabel = parts[0] ?? "";
  const orgNameClean = parts.slice(1).join(".");
  if (!agentNameLabel || !orgNameClean) return false;
  const ensClient = await getENSClient(chainId);
  if (typeof (ensClient as { hasAgentNameOwner?: unknown }).hasAgentNameOwner !== "function") return false;
  return await (ensClient as { hasAgentNameOwner: (orgName: string, agentName: string) => Promise<boolean> }).hasAgentNameOwner(
    orgNameClean,
    agentNameLabel,
  );
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
  const discovered = discoveryUrl
    ? await discoverOwnedGymAgent({ chainId, eoaAddress: eoaAddress as `0x${string}`, discoveryUrl, discoveryApiKey }).catch((e) => {
        console.error("[agentictrust] discovery fallback failed", e);
        return null;
      })
    : null;
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

  if (savedBaseName) {
    const fullAgentName = gymAgentNameFromBaseName(savedBaseName);
    const a2aHost = a2aHostForBaseName(savedBaseName);
    const canReadEns = hasEnsReadConfig(chainId);
    const client = canReadEns ? await getAgenticTrustClient() : null;
    const agentInfo = canReadEns ? await client?.getENSInfo(fullAgentName, chainId).catch(() => null) : null;
    const hasOwner = canReadEns ? await ensNameHasOwner(fullAgentName, chainId).catch(() => false) : false;
    const discoveredForSaved = discovered?.baseName === savedBaseName ? discovered : null;
    const agentAccount = discoveredForSaved?.agentAccount ?? normalizeAddress(agentInfo?.account);
    const owner = agentAccount ? await getAccountOwner(agentAccount, chainId).catch(() => null) : null;
    const validOwner = typeof owner === "string" && owner.trim().toLowerCase() === eoaAddress.toLowerCase();
    const savedEoaMatches =
      typeof prof.eoaAddress === "string" && prof.eoaAddress.trim().toLowerCase() === eoaAddress.toLowerCase();
    const infoUrlMatches = typeof agentInfo?.url === "string" && agentInfo.url.trim() === a2aHost;
    const trustedSavedDiscovery =
      Boolean(discoveredForSaved?.agentAccount) ||
      (hasOwner &&
        ((typeof prof.discoveredAgentName === "string" && prof.discoveredAgentName.trim().toLowerCase() === fullAgentName.toLowerCase()) ||
          (savedEoaMatches && Boolean(agentAccount)) ||
          infoUrlMatches));
    if (validOwner || trustedSavedDiscovery) {
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
        fullAgentName,
        agentHandle: gymAgentLabelFromBaseName(savedBaseName),
        a2aHost,
        agentAccount: agentAccount ?? null,
        agentOwnerEoa: typeof owner === "string" ? owner : null,
        chatReady,
      });
    }
    if (!canReadEns) {
      return NextResponse.json({
        ok: true,
        accountAddress: auth.accountAddress,
        eoaAddress,
        chainId,
        discovered: null,
        savedBaseName: null,
        pendingBaseName: savedBaseName,
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
  const activeBaseName = validBaseName || savedBaseName || null;
  const a2aHost = activeBaseName ? a2aHostForBaseName(activeBaseName) : null;
  const discoveredOwner = discovered?.agentAccount ? await getAccountOwner(discovered.agentAccount, chainId).catch(() => null) : null;
  const chatReady = a2aHost ? await isA2aEndpointReachable(a2aHost) : false;

  return NextResponse.json({
    ok: true,
    accountAddress: auth.accountAddress,
    eoaAddress,
    chainId,
    discovered: discovered
      ? { agentName: discovered.agentName, ensName: discovered.ensName, baseName: discovered.baseName }
      : null,
    agentAccount: discovered?.agentAccount ?? null,
    agentOwnerEoa: typeof discoveredOwner === "string" ? discoveredOwner : null,
    savedBaseName: validBaseName,
    pendingBaseName: !validBaseName && savedBaseName ? savedBaseName : null,
    fullAgentName: activeBaseName ? gymAgentNameFromBaseName(activeBaseName) : null,
    agentHandle: activeBaseName ? gymAgentLabelFromBaseName(activeBaseName) : null,
    a2aHost,
    chatReady,
  });
}

