import { NextResponse } from "next/server";
import { addToL1OrgPK, getAgenticTrustClient, getENSClient } from "@agentic-trust/core/server";
import { eoaAddressForPrivyDid, requirePrivyAuth, telegramUserIdForPrivyDid } from "../../_lib/privy";
import { gymAgentLabelFromBaseName, gymAgentNameFromBaseName, safeBaseName } from "../_lib/gym-agent";
import { createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ENS_ORG_NAME = "8004-agent.eth";
const ENS_ORG_LABEL = "8004-agent";

type PrepareBody = {
  phase?: unknown;
  baseName?: unknown;
  agentAddress?: unknown;
};

type CompleteBody = {
  phase?: unknown;
  baseName?: unknown;
  agentAddress?: unknown;
  txHash?: unknown;
};

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

function ensOrgAddressForChain(chainId: number): string {
  if (chainId === 11155111) {
    return String(process.env.AGENTIC_TRUST_ENS_ORG_ADDRESS_SEPOLIA ?? process.env.NEXT_PUBLIC_AGENTIC_TRUST_ENS_ORG_ADDRESS_SEPOLIA ?? "").trim();
  }
  return "";
}

function identityRegistryForChain(chainId: number): string {
  if (chainId === 11155111) {
    return String(process.env.AGENTIC_TRUST_IDENTITY_REGISTRY_SEPOLIA ?? process.env.NEXT_PUBLIC_AGENTIC_TRUST_IDENTITY_REGISTRY_SEPOLIA ?? "").trim();
  }
  return "";
}

function ensPublicResolverForChain(chainId: number): string {
  if (chainId === 11155111) {
    return String(process.env.AGENTIC_TRUST_ENS_PUBLIC_RESOLVER_SEPOLIA ?? process.env.NEXT_PUBLIC_AGENTIC_TRUST_ENS_PUBLIC_RESOLVER_SEPOLIA ?? "").trim();
  }
  return "";
}

function bundlerUrlForChain(chainId: number): string {
  if (chainId === 11155111) {
    return String(process.env.AGENTIC_TRUST_BUNDLER_URL_SEPOLIA ?? process.env.NEXT_PUBLIC_AGENTIC_TRUST_BUNDLER_URL_SEPOLIA ?? "").trim();
  }
  return "";
}

function ensPrivateKeyForChain(chainId: number): string {
  if (chainId === 11155111) {
    return String(process.env.AGENTIC_TRUST_ENS_PRIVATE_KEY_SEPOLIA ?? "").trim();
  }
  return "";
}

function agentDescription(baseName: string): string {
  return `Personal gym agent for ${baseName}.`;
}

function a2aHostForBaseName(baseName: string): string {
  return `https://${gymAgentLabelFromBaseName(baseName)}.${a2aHandleBaseDomain()}`;
}

function normalizeAddress(value: unknown): `0x${string}` | null {
  const s = typeof value === "string" ? value.trim() : "";
  if (!/^0x[a-fA-F0-9]{40}$/.test(s)) return null;
  return s as `0x${string}`;
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

async function upsertHandle(args: { handle: string; accountAddress: string; telegramUserId: string | null }) {
  const base = a2aAgentBaseUrl();
  const adminKey = a2aAdminKey();
  const res = await fetch(`${base}/api/a2a/handle`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-key": adminKey },
    body: JSON.stringify({
      handle: args.handle,
      accountAddress: args.accountAddress,
      telegramUserId: args.telegramUserId,
    }),
  });
  const json = (await res.json().catch(() => ({}))) as unknown;
  if (!res.ok) throw new Error(`a2a_handle_upsert_failed:${res.status}:${JSON.stringify(json).slice(0, 200)}`);
  return json;
}

export async function POST(req: Request) {
  const auth = await requirePrivyAuth(req);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });

  const body = (await req.json().catch(() => null)) as PrepareBody | CompleteBody | null;
  const phase = typeof body?.phase === "string" ? body.phase : "prepare";
  const baseName = safeBaseName(body?.baseName);
  if (!baseName) return NextResponse.json({ ok: false, error: "Invalid baseName" }, { status: 400 });

  const eoaAddress = await eoaAddressForPrivyDid(auth.did);
  if (!eoaAddress) {
    return NextResponse.json({ ok: false, error: "Missing connected Ethereum wallet EOA for Privy user" }, { status: 400 });
  }

  const chainId = registrationChainId();
  const fullName = gymAgentNameFromBaseName(baseName);
  const agentLabel = gymAgentLabelFromBaseName(baseName);
  const a2aHost = a2aHostForBaseName(baseName);

  if (phase === "prepare") {
    const agentAddress = normalizeAddress(body?.agentAddress);
    if (!agentAddress) {
      return NextResponse.json({ ok: false, error: "Invalid agentAddress" }, { status: 400 });
    }
    if (!ensOrgAddressForChain(chainId)) {
      return NextResponse.json(
        {
          ok: false,
          error: "missing_ens_org_address",
          detail: chainId === 11155111 ? "Set AGENTIC_TRUST_ENS_ORG_ADDRESS_SEPOLIA." : `Set ENS org address for chain ${chainId}.`,
        },
        { status: 500 },
      );
    }
    if (!identityRegistryForChain(chainId)) {
      return NextResponse.json(
        {
          ok: false,
          error: "missing_identity_registry",
          detail:
            chainId === 11155111
              ? "Set AGENTIC_TRUST_IDENTITY_REGISTRY_SEPOLIA. AGENTIC_TRUST_ENS_IDENTITY_WRAPPER_SEPOLIA is a different setting."
              : `Set identity registry for chain ${chainId}.`,
        },
        { status: 500 },
      );
    }
    if (!ensPublicResolverForChain(chainId)) {
      return NextResponse.json(
        {
          ok: false,
          error: "missing_ens_public_resolver",
          detail:
            chainId === 11155111
              ? "Set AGENTIC_TRUST_ENS_PUBLIC_RESOLVER_SEPOLIA."
              : `Set ENS public resolver for chain ${chainId}.`,
        },
        { status: 500 },
      );
    }
    if (!bundlerUrlForChain(chainId)) {
      return NextResponse.json(
        {
          ok: false,
          error: "missing_bundler_url",
          detail: chainId === 11155111 ? "Set AGENTIC_TRUST_BUNDLER_URL_SEPOLIA." : `Set bundler URL for chain ${chainId}.`,
        },
        { status: 500 },
      );
    }
    if (!ensPrivateKeyForChain(chainId)) {
      return NextResponse.json(
        {
          ok: false,
          error: "missing_ens_private_key",
          detail: chainId === 11155111 ? "Set AGENTIC_TRUST_ENS_PRIVATE_KEY_SEPOLIA." : `Set ENS private key for chain ${chainId}.`,
        },
        { status: 500 },
      );
    }

    const client = await getAgenticTrustClient();
    const canReadEns = hasEnsReadConfig(chainId);
    const available = canReadEns ? await client.isENSNameAvailable(fullName, chainId) : true;
    if (available !== true) {
      const info = await client.getENSInfo(fullName, chainId).catch(() => null);
      return NextResponse.json(
        {
          ok: false,
          error: available === false ? "agent_exists" : "ens_availability_failed",
          fullName,
          agentLabel,
          a2aHost,
          match: info,
        },
        { status: available === false ? 409 : 502 },
      );
    }

    let addResult;
    let infoCalls;
    try {
      addResult = await addToL1OrgPK({
        agentAddress,
        orgName: ENS_ORG_LABEL,
        agentName: agentLabel,
        agentUrl: a2aHost,
        chainId,
      });
      const ensClient = await getENSClient(chainId);
      infoCalls = await ensClient.prepareSetAgentNameInfoCalls({
        agentAddress,
        orgName: ENS_ORG_LABEL,
        agentName: agentLabel,
        agentUrl: a2aHost,
        agentDescription: agentDescription(baseName),
      });
    } catch (e) {
      return NextResponse.json(
        {
          ok: false,
          error: "ens_prepare_failed",
          detail: e instanceof Error ? e.message : String(e ?? ""),
        },
        { status: 500 },
      );
    }

    const calls = Array.isArray(infoCalls?.calls)
      ? infoCalls.calls.map((call) => ({
          to: call.to,
          data: call.data,
        }))
      : [];

    return NextResponse.json(
      {
        ok: true,
        phase: "prepare",
        accountAddress: auth.accountAddress,
        eoaAddress,
        chainId,
        baseName,
        agentLabel,
        fullName,
        agentAddress,
        a2aHost,
        bundlerUrl: bundlerUrlForChain(chainId),
        userOpHash: typeof addResult?.userOpHash === "string" ? addResult.userOpHash : null,
        ensReadVerified: canReadEns,
        serverSubmitted: true,
        calls,
      },
      { status: 200 },
    );
  }

  if (phase !== "complete") {
    return NextResponse.json({ ok: false, error: "Invalid phase" }, { status: 400 });
  }

  const completeBody = body as CompleteBody;
  const agentAddress = normalizeAddress(completeBody.agentAddress);
  const txHash = typeof completeBody.txHash === "string" ? completeBody.txHash.trim() : "";
  if (!agentAddress) {
    return NextResponse.json({ ok: false, error: "Invalid agentAddress" }, { status: 400 });
  }
  if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
    return NextResponse.json({ ok: false, error: "Invalid txHash" }, { status: 400 });
  }

  const client = await getAgenticTrustClient();
  const info = await client.getENSInfo(fullName, chainId).catch(() => null);
  const resolvedAccount = normalizeAddress(info?.account) ?? agentAddress;
  const owner = resolvedAccount ? await readSmartAccountOwner(chainId, resolvedAccount).catch(() => null) : null;
  const validOwner = typeof owner === "string" && owner.trim().toLowerCase() === eoaAddress.toLowerCase();

  const out = await upsertProfile({
    accountAddress: auth.accountAddress,
    eoaAddress,
    baseName,
    discoveredAgentName: validOwner ? fullName : null,
    discoveredEnsName: validOwner ? fullName : null,
  });

  const telegramUserId = await telegramUserIdForPrivyDid(auth.did);
  await upsertHandle({
    handle: agentLabel,
    accountAddress: auth.accountAddress,
    telegramUserId,
  }).catch(() => null);

  return NextResponse.json({
    ok: true,
    phase: "complete",
    accountAddress: auth.accountAddress,
    eoaAddress,
    baseName,
    agentLabel,
    fullName,
    agentAddress,
    a2aHost,
    txHash,
    validOwner,
    result: out,
  });
}

export async function GET(req: Request) {
  const auth = await requirePrivyAuth(req);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });

  const url = new URL(req.url);
  const baseName = safeBaseName(url.searchParams.get("baseName"));
  if (!baseName) return NextResponse.json({ ok: false, error: "Invalid baseName" }, { status: 400 });

  const chainId = registrationChainId();
  const fullName = gymAgentNameFromBaseName(baseName);
  const client = await getAgenticTrustClient();
  const canReadEns = hasEnsReadConfig(chainId);
  const availableByAddr = canReadEns ? await client.isENSNameAvailable(fullName, chainId) : true;
  const hasOwner = canReadEns ? await ensNameHasOwner(fullName, chainId).catch(() => false) : false;
  const available = canReadEns ? availableByAddr === true && !hasOwner : true;
  const info = canReadEns && available !== true ? await client.getENSInfo(fullName, chainId).catch(() => null) : null;

  return NextResponse.json({
    ok: true,
    chainId,
    baseName,
    agentLabel: gymAgentLabelFromBaseName(baseName),
    fullName,
    a2aHost: a2aHostForBaseName(baseName),
    available: available === true,
    ensReadVerified: canReadEns,
    match: info,
  });
}

