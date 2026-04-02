"use client";

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
  const requested = await provider.request({ method: "eth_requestAccounts" }).catch(() => null);
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
  return embedded ?? eligible[0] ?? null;
}

async function ethereumProviderForWallet(wallets: WalletLike[], walletAddress: string, chainId: number) {
  const target = normalizeAddress(walletAddress);
  const wallet = preferredWallet(wallets, walletAddress);
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
  throw new Error(`Wallet provider for ${walletAddress} is not ready yet.`);
}

export async function ensureA2AWebAuthSession(args: EnsureArgs): Promise<string> {
  const cached = !args.force ? getStoredA2AWebAuthSession(args.accountAddress) : null;
  if (cached?.sessionToken) return cached.sessionToken;

  const challengeRes = await fetch("/api/a2a/auth/challenge", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${args.accessToken}` },
    body: JSON.stringify({ origin: args.origin }),
  });
  const challengeJson = (await challengeRes.json().catch(() => ({}))) as ChallengeResponse;
  if (!challengeRes.ok || challengeJson.ok !== true) {
    const err = typeof (challengeJson as Record<string, unknown>).error === "string" ? String((challengeJson as Record<string, unknown>).error) : "Failed to create A2A auth challenge.";
    throw new Error(err);
  }

  const challengeId = typeof challengeJson.challengeId === "string" ? challengeJson.challengeId.trim() : "";
  const walletAddress = typeof challengeJson.challenge?.walletAddress === "string" ? challengeJson.challenge.walletAddress.trim() : "";
  const chainId = typeof challengeJson.challenge?.chainId === "number" ? challengeJson.challenge.chainId : 11155111;
  if (!walletAddress || !challengeId || !challengeJson.typedData) {
    throw new Error("Challenge response was incomplete.");
  }

  const provider = await ethereumProviderForWallet(args.wallets, walletAddress, chainId);
  const signature = await provider.request({
    method: "eth_signTypedData_v4",
    params: [walletAddress, JSON.stringify(challengeJson.typedData)],
  });
  if (typeof signature !== "string" || !signature.trim()) throw new Error("MetaMask did not return a signature.");

  const verifyRes = await fetch("/api/a2a/auth/verify", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${args.accessToken}` },
    body: JSON.stringify({ challengeId, signature: signature.trim(), walletAddress }),
  });
  const verifyJson = (await verifyRes.json().catch(() => ({}))) as VerifyResponse;
  if (!verifyRes.ok || verifyJson.ok !== true) {
    const err = typeof (verifyJson as Record<string, unknown>).error === "string" ? String((verifyJson as Record<string, unknown>).error) : "Failed to verify A2A auth challenge.";
    throw new Error(err);
  }

  const sessionToken = typeof verifyJson.session?.sessionToken === "string" ? verifyJson.session.sessionToken.trim() : "";
  const expiresAtISO = typeof verifyJson.session?.expiresAtISO === "string" ? verifyJson.session.expiresAtISO.trim() : "";
  const principalSmartAccount = typeof verifyJson.session?.principalSmartAccount === "string" ? verifyJson.session.principalSmartAccount.trim() : "";
  const agentHandle = typeof verifyJson.session?.agentHandle === "string" ? verifyJson.session.agentHandle.trim() : "";
  if (!sessionToken || !expiresAtISO) throw new Error("A2A auth verify response was incomplete.");

  saveStoredSession({
    accountAddress: args.accountAddress,
    sessionToken,
    expiresAtISO,
    walletAddress,
    principalSmartAccount,
    agentHandle,
  });
  return sessionToken;
}
