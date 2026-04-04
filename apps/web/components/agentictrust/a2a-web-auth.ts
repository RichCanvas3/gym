"use client";

import {
  SMART_AGENT_DELEGATION_SELECTOR,
  signAgentDelegation,
} from "@agentic-trust/core/client";
import { signAgentChallengeWithSmartAccount } from "./session-package-builder";

const STORAGE_KEY = "climb_gym_a2a_web_auth_v1";

type WalletLike = {
  address?: string;
  walletClientType?: string;
  getEthereumProvider?: () => Promise<unknown>;
  switchChain?: (targetChainId: `0x${string}` | number) => Promise<void>;
};

type ChallengeResponse = {
  ok?: boolean;
  challengeId?: string;
  typedData?: unknown;
  challenge?: {
    walletAddress?: unknown;
    principalSmartAccount?: unknown;
    agentHandle?: unknown;
    chainId?: unknown;
    a2aHost?: unknown;
  };
};

type VerifyResponse = {
  ok?: boolean;
  session?: {
    sessionToken?: unknown;
    expiresAtISO?: unknown;
    walletAddress?: unknown;
    principalSmartAccount?: unknown;
    agentHandle?: unknown;
  };
};

type SessionStatusResponse = {
  ok?: boolean;
  ready?: boolean;
  agentHandle?: unknown;
  principalSmartAccount?: unknown;
  principalOwnerEoa?: unknown;
  chainId?: unknown;
  rpcUrl?: unknown;
  bundlerUrl?: unknown;
  bootstrapReady?: unknown;
  bootstrapMissing?: unknown;
  detail?: unknown;
  error?: unknown;
};

type StoredSession = {
  accountAddress: string;
  sessionToken: string;
  expiresAtISO: string;
  walletAddress: string;
  principalSmartAccount: string;
  agentHandle: string;
};

type EnsureArgs = {
  accountAddress: string;
  accessToken: string;
  wallets: WalletLike[];
  origin: string;
  force?: boolean;
  signTypedData?: (
    input: unknown,
    options?: {
      address?: string;
    },
  ) => Promise<{ signature: string }>;
  signMessage?: (
    input: {
      message: string;
    },
    options?: {
      address?: string;
    },
  ) => Promise<{ signature: string }>;
};

function parseStoredSessions(): Record<string, StoredSession> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, StoredSession>) : {};
  } catch {
    return {};
  }
}

function saveStoredSession(session: StoredSession) {
  const map = parseStoredSessions();
  map[session.accountAddress] = session;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
}

export function clearA2AWebAuthSession(accountAddress?: string | null) {
  try {
    if (!accountAddress) {
      window.localStorage.removeItem(STORAGE_KEY);
      return;
    }
    const map = parseStoredSessions();
    delete map[accountAddress];
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // ignore
  }
}

export function getStoredA2AWebAuthSession(accountAddress?: string | null): StoredSession | null {
  if (!accountAddress) return null;
  const entry = parseStoredSessions()[accountAddress];
  if (!entry) return null;
  if (!entry.expiresAtISO || Number.isNaN(Date.parse(entry.expiresAtISO)) || Date.parse(entry.expiresAtISO) <= Date.now()) {
    clearA2AWebAuthSession(accountAddress);
    return null;
  }
  return entry;
}

function normalizeAddress(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

async function providerAccounts(provider: {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
}) {
  const requested =
    (await provider.request({ method: "eth_accounts" }).catch(() => null)) ??
    (await provider.request({ method: "eth_requestAccounts" }).catch(() => null));
  const list = Array.isArray(requested) ? requested : [];
  return list.map((value) => normalizeAddress(value)).filter(Boolean);
}

function preferredWallet(wallets: WalletLike[], walletAddress: string) {
  const target = normalizeAddress(walletAddress);
  const eligible = wallets.filter((wallet) => normalizeAddress(wallet.address) === target && typeof wallet.getEthereumProvider === "function");
  const embedded = eligible.find((wallet) => {
    const kind = typeof wallet.walletClientType === "string" ? wallet.walletClientType : "";
    return kind === "privy" || kind === "privy-v2";
  });
  return embedded ?? null;
}

async function ethereumProviderForWallet(wallets: WalletLike[], walletAddress: string, chainId: number) {
  const target = normalizeAddress(walletAddress);
  const wallet = preferredWallet(wallets, walletAddress);
  if (!wallet) {
    throw new Error(`No connected Privy wallet matches ${walletAddress}.`);
  }
  if (wallet && typeof wallet.switchChain === "function") {
    await wallet.switchChain(chainId).catch(() => null);
  }
  if (wallet && typeof wallet.getEthereumProvider === "function") {
    const provider = await wallet.getEthereumProvider();
    if (provider && typeof provider === "object" && typeof (provider as { request?: unknown }).request === "function") {
      const typedProvider = provider as { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> };
      const accounts = await providerAccounts(typedProvider);
      if (accounts.includes(target)) {
        return typedProvider;
      }
    }
  }
  throw new Error(`Privy wallet provider for ${walletAddress} is not ready or does not expose that account.`);
}

async function ensureA2ADelegationPackage(args: EnsureArgs) {
  const statusRes = await fetch("/api/a2a/session/status", {
    headers: { authorization: `Bearer ${args.accessToken}` },
    cache: "no-store",
  });
  const statusJson = (await statusRes.json().catch(() => ({}))) as SessionStatusResponse & Record<string, unknown>;
  if (!statusRes.ok || statusJson.ok !== true) {
    const err = typeof statusJson.error === "string" ? statusJson.error : "Failed to read A2A session package status.";
    throw new Error(err);
  }
  if (statusJson.ready === true) return;

  const agentHandle = typeof statusJson.agentHandle === "string" ? statusJson.agentHandle.trim() : "";
  const principalSmartAccount = typeof statusJson.principalSmartAccount === "string" ? statusJson.principalSmartAccount.trim() : "";
  const principalOwnerEoa = typeof statusJson.principalOwnerEoa === "string" ? statusJson.principalOwnerEoa.trim() : "";
  const chainId = typeof statusJson.chainId === "number" ? statusJson.chainId : 11155111;
  const rpcUrl = typeof statusJson.rpcUrl === "string" ? statusJson.rpcUrl.trim() : "";
  const bootstrapReady = statusJson.bootstrapReady === true;
  const bootstrapMissing = Array.isArray(statusJson.bootstrapMissing)
    ? statusJson.bootstrapMissing.filter((v): v is string => typeof v === "string" && Boolean(v.trim()))
    : [];
  if (!bootstrapReady) {
    throw new Error(`A2A delegation bootstrap config is missing: ${bootstrapMissing.join(", ")}`);
  }
  if (
    !agentHandle ||
    !principalSmartAccount ||
    !principalOwnerEoa ||
    !rpcUrl
  ) {
    throw new Error("A2A delegation bootstrap is missing required config.");
  }

  const initRes = await fetch("/api/a2a/session/init", {
    method: "POST",
    headers: { authorization: `Bearer ${args.accessToken}` },
  });
  const initJson = (await initRes.json().catch(() => ({}))) as Record<string, unknown>;
  if (!initRes.ok || initJson.ok !== true) {
    const err = typeof initJson.error === "string" ? initJson.error : "Failed to initialize A2A session package.";
    throw new Error(err);
  }
  const sessionAA = typeof initJson.sessionAA === "string" ? initJson.sessionAA.trim() : "";
  if (!sessionAA) {
    throw new Error("A2A session init did not return a session account.");
  }

  const provider = await ethereumProviderForWallet(args.wallets, principalOwnerEoa, chainId);
  const delegation = await signAgentDelegation({
    chainId,
    agentAccount: principalSmartAccount as `0x${string}`,
    provider,
    ownerAddress: principalOwnerEoa as `0x${string}`,
    rpcUrl,
    delegateeAA: sessionAA as `0x${string}`,
    selector: SMART_AGENT_DELEGATION_SELECTOR,
    includeValidationScope: false,
    includeAssociationScope: false,
    includeAgentAccountSignatureScope: true,
  });

  const storeRes = await fetch("/api/a2a/session/complete", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${args.accessToken}` },
    body: JSON.stringify({
      selector: delegation.selector,
      signedDelegation: delegation.signedDelegation,
    }),
  });
  const storeJson = (await storeRes.json().catch(() => ({}))) as Record<string, unknown>;
  if (!storeRes.ok || storeJson.ok !== true) {
    const err = typeof storeJson.error === "string" ? storeJson.error : "Failed to complete A2A session package.";
    throw new Error(err);
  }
}

export async function ensureA2AWebAuthSession(args: EnsureArgs): Promise<string> {
  const cached = !args.force ? getStoredA2AWebAuthSession(args.accountAddress) : null;
  if (cached?.sessionToken) {
    await ensureA2ADelegationPackage(args);
    return cached.sessionToken;
  }

  console.info("[a2a-web-auth] creating challenge", { accountAddress: args.accountAddress });
  const challengeRes = await fetch("/api/a2a/auth/challenge", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${args.accessToken}` },
    body: JSON.stringify({ origin: args.origin }),
  });
  const challengeJson = (await challengeRes.json().catch(() => ({}))) as ChallengeResponse;
  if (!challengeRes.ok || challengeJson.ok !== true) {
    const rec = challengeJson as Record<string, unknown>;
    const err =
      typeof rec.detail === "string" && rec.detail.trim()
        ? rec.detail.trim()
        : typeof rec.error === "string"
          ? String(rec.error)
          : "Failed to create A2A auth challenge.";
    throw new Error(err);
  }

  const challengeId = typeof challengeJson.challengeId === "string" ? challengeJson.challengeId.trim() : "";
  const walletAddress = typeof challengeJson.challenge?.walletAddress === "string" ? challengeJson.challenge.walletAddress.trim() : "";
  const chainId = typeof challengeJson.challenge?.chainId === "number" ? challengeJson.challenge.chainId : 11155111;
  if (!walletAddress || !challengeId || !challengeJson.typedData) {
    throw new Error("Challenge response was incomplete.");
  }

  console.info("[a2a-web-auth] challenge ready", { challengeId, walletAddress, chainId });
  const wallet = preferredWallet(args.wallets, walletAddress);
  if (wallet) {
    console.info("[a2a-web-auth] matched wallet", {
      walletAddress,
      walletClientType: typeof wallet.walletClientType === "string" ? wallet.walletClientType : null,
    });
    if (typeof wallet.switchChain === "function") {
      console.info("[a2a-web-auth] switching chain", { chainId });
      await wallet.switchChain(chainId).catch(() => null);
    }
  } else {
    console.info("[a2a-web-auth] no matching wallet object; using Privy signTypedData hook", { walletAddress });
  }
  const typed = challengeJson.typedData as {
    domain: Record<string, unknown>;
    types: Record<string, Array<Record<string, unknown>>>;
    primaryType: string;
    message: Record<string, unknown>;
  };
  console.info("[a2a-web-auth] signing typed data", { primaryType: typed.primaryType });
  const statusRes = await fetch("/api/a2a/session/status", {
    headers: { authorization: `Bearer ${args.accessToken}` },
    cache: "no-store",
  });
  const statusJson = (await statusRes.json().catch(() => ({}))) as SessionStatusResponse & Record<string, unknown>;
  if (!statusRes.ok || statusJson.ok !== true) {
    const err = typeof statusJson.detail === "string" ? statusJson.detail : typeof statusJson.error === "string" ? statusJson.error : "Failed to read A2A session status.";
    throw new Error(err);
  }
  const challengePrincipalSmartAccount = typeof statusJson.principalSmartAccount === "string" ? statusJson.principalSmartAccount.trim() : "";
  const rpcUrl = typeof statusJson.rpcUrl === "string" ? statusJson.rpcUrl.trim() : "";
  if (!args.signTypedData || !args.signMessage) throw new Error("Privy signing hooks are unavailable.");
  if (!challengePrincipalSmartAccount || !rpcUrl) throw new Error("Missing principal smart account or RPC URL for challenge signing.");
  const signature = await signAgentChallengeWithSmartAccount({
    chainId,
    principalSmartAccount: challengePrincipalSmartAccount as `0x${string}`,
    ownerAddress: walletAddress as `0x${string}`,
    rpcUrl,
    typedData: typed,
    signTypedData: args.signTypedData,
    signMessage: args.signMessage,
  });
  if (!signature.trim()) throw new Error("Smart account did not return a typed-data signature.");
  console.info("[a2a-web-auth] signature received");

  console.info("[a2a-web-auth] verifying challenge");
  const verifyRes = await fetch("/api/a2a/auth/verify", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${args.accessToken}` },
    body: JSON.stringify({ challengeId, signature: signature.trim(), walletAddress }),
  });
  const verifyJson = (await verifyRes.json().catch(() => ({}))) as VerifyResponse;
  if (!verifyRes.ok || verifyJson.ok !== true) {
    const serialized =
      (() => {
        try {
          return JSON.stringify(verifyJson);
        } catch {
          return "[unserializable]";
        }
      })();
    console.error("[a2a-web-auth] verify failed", {
      status: verifyRes.status,
      challengeId,
      walletAddress,
      response: verifyJson,
      serialized,
    });
    const rec = verifyJson as Record<string, unknown>;
    const err =
      typeof rec.detail === "string" && rec.detail.trim()
        ? rec.detail.trim()
        : typeof rec.error === "string"
          ? String(rec.error)
          : `Failed to verify A2A auth challenge. response=${serialized}`;
    throw new Error(err);
  }

  const sessionToken = typeof verifyJson.session?.sessionToken === "string" ? verifyJson.session.sessionToken.trim() : "";
  const expiresAtISO = typeof verifyJson.session?.expiresAtISO === "string" ? verifyJson.session.expiresAtISO.trim() : "";
  const sessionPrincipalSmartAccount = typeof verifyJson.session?.principalSmartAccount === "string" ? verifyJson.session.principalSmartAccount.trim() : "";
  const agentHandle = typeof verifyJson.session?.agentHandle === "string" ? verifyJson.session.agentHandle.trim() : "";
  if (!sessionToken || !expiresAtISO) throw new Error("A2A auth verify response was incomplete.");
  saveStoredSession({
    accountAddress: args.accountAddress,
    sessionToken,
    expiresAtISO,
    walletAddress,
    principalSmartAccount: sessionPrincipalSmartAccount,
    agentHandle,
  });
  await ensureA2ADelegationPackage(args);
  return sessionToken;
}
