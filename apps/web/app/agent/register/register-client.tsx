"use client";

import { useEffect, useState } from "react";
import {
  getCounterfactualAccountClientByAgentName,
  getCounterfactualSmartAccountAddressByAgentName,
  sendSponsoredUserOperation,
  waitForUserOperationReceipt,
} from "@agentic-trust/core/client";
import { useCreateWallet, useWallets } from "@privy-io/react-auth";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/components/auth/AuthProvider";

type Status =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "saving" }
  | { kind: "saved"; fullName?: string; txHash?: string }
  | { kind: "waiting"; message: string }
  | { kind: "error"; error: string };

type Availability =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available"; fullName: string; chainId: number; a2aHost: string }
  | { kind: "taken"; fullName: string; chainId: number }
  | { kind: "invalid" }
  | { kind: "error"; error: string };

function embeddedEthereumWalletAddress(user: unknown): string | null {
  if (!user || typeof user !== "object") return null;
  const rec = user as Record<string, unknown>;
  const linked = Array.isArray(rec.linkedAccounts) ? rec.linkedAccounts : [];
  for (const item of linked) {
    if (!item || typeof item !== "object") continue;
    const wallet = item as Record<string, unknown>;
    if (wallet.type !== "wallet") continue;
    if (wallet.chainType !== "ethereum") continue;
    const walletClientType = typeof wallet.walletClientType === "string" ? wallet.walletClientType : "";
    if (walletClientType !== "privy" && walletClientType !== "privy-v2") continue;
    if (wallet.imported === true) continue;
    const address = typeof wallet.address === "string" ? wallet.address.trim() : "";
    if (/^0x[a-fA-F0-9]{40}$/.test(address)) return address;
  }
  return null;
}

function connectedEmbeddedWallet(
  wallets: Array<{ address: string; walletClientType?: string; getEthereumProvider?: () => Promise<unknown>; switchChain?: (targetChainId: `0x${string}` | number) => Promise<void> }>,
  address: string | null,
) {
  const target = (address ?? "").trim().toLowerCase();
  return wallets.find((wallet) => {
    const walletClientType = typeof wallet.walletClientType === "string" ? wallet.walletClientType : "";
    if (walletClientType !== "privy" && walletClientType !== "privy-v2") return false;
    return typeof wallet.address === "string" && wallet.address.trim().toLowerCase() === target;
  });
}

const SEPOLIA_CHAIN = {
  id: 11155111,
  name: "Sepolia",
  nativeCurrency: { name: "Sepolia Ether", symbol: "SEP", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://ethereum-sepolia-rpc.publicnode.com"] },
    public: { http: ["https://ethereum-sepolia-rpc.publicnode.com"] },
  },
  blockExplorers: {
    default: { name: "Etherscan", url: "https://sepolia.etherscan.io" },
  },
  testnet: true,
} as const;

export default function AgentRegisterClient() {
  const router = useRouter();
  const { ready, authenticated, accountAddress, user, getAccessToken, login } = useAuth();
  const { createWallet } = useCreateWallet();
  const { wallets } = useWallets();
  const [baseName, setBaseName] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [availability, setAvailability] = useState<Availability>({ kind: "idle" });

  useEffect(() => {
    if (!ready) return;
    if (!authenticated) return;
    async function load() {
      setStatus({ kind: "loading" });
      try {
        const tok = await getAccessToken();
        const res = await fetch("/api/agentictrust/status", { headers: { authorization: `Bearer ${tok}` } });
        const json = (await res.json().catch(() => ({}))) as unknown;
        const rec = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
        const saved = typeof rec.savedBaseName === "string" ? rec.savedBaseName.trim() : "";
        if (saved) {
          const fullName = typeof rec.fullAgentName === "string" ? rec.fullAgentName.trim() : "";
          setStatus({ kind: "saved", ...(fullName ? { fullName } : {}) });
          router.replace("/chat");
          return;
        }
        const pending = typeof rec.pendingBaseName === "string" ? rec.pendingBaseName.trim() : "";
        if (pending) {
          setBaseName((prev) => prev || pending);
          setStatus({ kind: "waiting", message: "Gym agent name is pending verification." });
          return;
        }
        setStatus({ kind: "idle" });
      } catch (e) {
        setStatus({ kind: "error", error: e instanceof Error ? e.message : String(e ?? "") });
      }
    }
    void load();
  }, [ready, authenticated, getAccessToken, router]);

  useEffect(() => {
    if (!ready || !authenticated || status.kind !== "saved") return;
    let cancelled = false;
    let polls = 0;
    const timer = globalThis.setInterval(() => {
      void (async () => {
        try {
          polls += 1;
          const tok = await getAccessToken();
          const res = await fetch("/api/agentictrust/status", { headers: { authorization: `Bearer ${tok}` } });
          const json = (await res.json().catch(() => ({}))) as unknown;
          const rec = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
          const saved = typeof rec.savedBaseName === "string" ? rec.savedBaseName.trim() : "";
          const note = typeof rec.note === "string" ? rec.note.trim() : "";
          if (!cancelled && saved) router.replace("/chat");
          if (!cancelled && note) {
            setStatus({ kind: "waiting", message: note });
            return;
          }
          if (!cancelled && polls >= 5 && typeof rec.pendingBaseName === "string" && rec.pendingBaseName.trim()) {
            setStatus({ kind: "waiting", message: "Gym agent is still pending verification." });
          }
        } catch {
          // ignore while polling
        }
      })();
    }, 3000);
    return () => {
      cancelled = true;
      globalThis.clearInterval(timer);
    };
  }, [ready, authenticated, status.kind, getAccessToken, router]);

  useEffect(() => {
    if (!ready || !authenticated) return;
    const s = baseName.trim();
    if (!s) {
      setAvailability({ kind: "idle" });
      return;
    }
    if (!/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/i.test(s)) {
      setAvailability({ kind: "invalid" });
      return;
    }

    let cancelled = false;
    const t = setTimeout(() => {
      void (async () => {
        setAvailability({ kind: "checking" });
        try {
          const tok = await getAccessToken();
          if (!tok) throw new Error("Missing Privy access token");
          const res = await fetch(`/api/agentictrust/register?baseName=${encodeURIComponent(s)}`, {
            headers: { authorization: `Bearer ${tok}` },
          });
          const json = (await res.json().catch(() => ({}))) as unknown;
          if (!res.ok) {
            const rec = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
            const err = typeof rec.error === "string" ? rec.error : `HTTP ${res.status}`;
            throw new Error(err);
          }
          const rec = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
          const available = rec.available === true;
          const fullName = typeof rec.fullName === "string" ? rec.fullName : `${s}-gym.8004-agent.eth`;
          const chainId = typeof rec.chainId === "number" ? rec.chainId : 11155111;
          const a2aHost = typeof rec.a2aHost === "string" ? rec.a2aHost : "";
          if (cancelled) return;
          setAvailability(available ? { kind: "available", fullName, chainId, a2aHost } : { kind: "taken", fullName, chainId });
        } catch (e) {
          if (cancelled) return;
          setAvailability({ kind: "error", error: e instanceof Error ? e.message : String(e ?? "") });
        }
      })();
    }, 350);

    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [baseName, ready, authenticated, getAccessToken]);

  async function save() {
    setStatus({ kind: "saving" });
    try {
      if (availability.kind !== "available") throw new Error("Pick an available name first");
      const tok = await getAccessToken();
      if (!tok) throw new Error("Missing Privy access token");
      let signerAddress = embeddedEthereumWalletAddress(user);
      if (!signerAddress) {
        const newWallet = await createWallet().catch((e: unknown) => {
          throw new Error(e instanceof Error ? e.message : String(e ?? ""));
        });
        const walletAddress = typeof newWallet?.address === "string" ? newWallet.address.trim() : "";
        signerAddress = /^0x[a-fA-F0-9]{40}$/.test(walletAddress) ? walletAddress : null;
      }
      if (!signerAddress) throw new Error("Embedded wallet could not be created yet. Try register again in a moment.");
      const wallet = connectedEmbeddedWallet(wallets, signerAddress);
      if (!wallet || typeof wallet.getEthereumProvider !== "function") {
        throw new Error("Embedded wallet provider is not ready yet. Try register again in a moment.");
      }
      if (typeof wallet.switchChain === "function") {
        await wallet.switchChain(availability.chainId).catch(() => null);
      }
      const ethereumProvider = await wallet.getEthereumProvider();
      const agentAddress = await getCounterfactualSmartAccountAddressByAgentName(
        availability.fullName.replace(/\.8004-agent\.eth$/i, ""),
        signerAddress as `0x${string}`,
        { ethereumProvider },
      );

      const prepareRes = await fetch("/api/agentictrust/register", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${tok}` },
        body: JSON.stringify({ phase: "prepare", baseName, agentAddress }),
      });
      const prepareJson = (await prepareRes.json().catch(() => ({}))) as unknown;
      if (!prepareRes.ok) {
        const rec = prepareJson && typeof prepareJson === "object" ? (prepareJson as Record<string, unknown>) : {};
        const err = typeof rec.error === "string" ? rec.error : `HTTP ${prepareRes.status}`;
        const detail = typeof rec.detail === "string" ? rec.detail.trim() : "";
        const note = typeof rec.note === "string" ? rec.note.trim() : "";
        const message = detail || note || err;
        throw new Error(message);
      }
      const prepareRec = prepareJson && typeof prepareJson === "object" ? (prepareJson as Record<string, unknown>) : {};
      const callsIn = Array.isArray(prepareRec.calls) ? prepareRec.calls : [];
      const bundlerUrl = typeof prepareRec.bundlerUrl === "string" ? prepareRec.bundlerUrl.trim() : "";
      const prepareUserOpHash = typeof prepareRec.userOpHash === "string" ? prepareRec.userOpHash.trim() : "";

      const calls = callsIn
        .map((call) => {
          if (!call || typeof call !== "object") return null;
          const rec = call as Record<string, unknown>;
          const to = typeof rec.to === "string" ? rec.to : "";
          const data = typeof rec.data === "string" ? rec.data : "";
          const valueHex = typeof rec.value === "string" ? rec.value : "";
          if (!to || !data) return null;
          return {
            to,
            data,
            ...(valueHex ? { value: BigInt(valueHex) } : {}),
          };
        })
        .filter((call): call is { to: `0x${string}`; data: `0x${string}`; value?: bigint } => Boolean(call));

      let txHash = prepareUserOpHash;
      if (calls.length > 0) {
        if (!bundlerUrl) throw new Error("Missing bundler URL for gasless registration.");
        const accountClient = await getCounterfactualAccountClientByAgentName(
          availability.fullName.replace(/\.8004-agent\.eth$/i, ""),
          signerAddress as `0x${string}`,
          { ethereumProvider },
        );
        txHash = await sendSponsoredUserOperation({
          bundlerUrl,
          chain: SEPOLIA_CHAIN,
          accountClient,
          calls,
        });
        await waitForUserOperationReceipt({
          bundlerUrl,
          chain: SEPOLIA_CHAIN,
          hash: txHash as `0x${string}`,
        });
      }
      if (!txHash) throw new Error("No registration transaction was sent.");

      const completeRes = await fetch("/api/agentictrust/register", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${tok}` },
        body: JSON.stringify({ phase: "complete", baseName, agentAddress, txHash }),
      });
      const completeJson = (await completeRes.json().catch(() => ({}))) as unknown;
      if (!completeRes.ok) {
        const rec = completeJson && typeof completeJson === "object" ? (completeJson as Record<string, unknown>) : {};
        const err = typeof rec.error === "string" ? rec.error : `HTTP ${completeRes.status}`;
        const detail = typeof rec.detail === "string" ? rec.detail.trim() : "";
        const note = typeof rec.note === "string" ? rec.note.trim() : "";
        throw new Error(`tx sent, but finalize failed: ${detail || note || err}`);
      }
      const completeRec = completeJson && typeof completeJson === "object" ? (completeJson as Record<string, unknown>) : {};
      const completedFullName = typeof completeRec.fullName === "string" ? completeRec.fullName.trim() : availability.fullName;
      const completedTxHash = typeof completeRec.txHash === "string" ? completeRec.txHash.trim() : txHash;
      setStatus({
        kind: "saved",
        ...(completedFullName ? { fullName: completedFullName } : {}),
        ...(completedTxHash ? { txHash: completedTxHash } : {}),
      });
      setBaseName(baseName.trim());
    } catch (e) {
      setStatus({ kind: "error", error: e instanceof Error ? e.message : String(e ?? "") });
    }
  }

  if (!ready) return <div className="mx-auto w-full max-w-2xl px-4 py-10 text-sm">Loading…</div>;

  if (!authenticated) {
    return (
      <div className="mx-auto w-full max-w-2xl px-4 py-10 text-sm">
        <div className="rounded-2xl border border-zinc-200 bg-white p-6 dark:border-white/10 dark:bg-zinc-950">
          <div className="text-base font-semibold">Register gym agent name</div>
          <div className="mt-2 text-zinc-600 dark:text-zinc-400">Sign in with Privy first.</div>
          <button
            onClick={() => login()}
            className="mt-4 h-9 rounded-xl border border-zinc-200 bg-white px-3 text-xs font-medium dark:border-white/10 dark:bg-zinc-950"
          >
            Log in
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-10 text-sm">
      <div className="rounded-2xl border border-zinc-200 bg-white p-6 dark:border-white/10 dark:bg-zinc-950">
        <div className="flex items-center justify-between gap-3">
          <div className="text-base font-semibold">Register gym agent name</div>
          <Link href="/chat" className="text-xs text-zinc-700 underline dark:text-zinc-300">
            Back to chat
          </Link>
        </div>
        <div className="mt-2 text-zinc-600 dark:text-zinc-400">
          Enter a new base name. `Register` appears only when{" "}
          <span className="font-mono">-gym.8004-agent.eth</span>.
        </div>

        <div className="mt-4 flex items-center gap-2">
          <input
            value={baseName}
            onChange={(e) => setBaseName(e.target.value)}
            placeholder="e.g. barb"
            className="h-10 w-full rounded-xl border border-zinc-200 bg-white px-3 text-sm outline-none dark:border-white/10 dark:bg-zinc-950"
          />
          {availability.kind === "available" ? (
            <button
              onClick={() => void save()}
              disabled={status.kind === "saving"}
              className="h-10 shrink-0 rounded-xl bg-zinc-900 px-4 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
            >
              {status.kind === "saving" ? "Registering…" : "Register"}
            </button>
          ) : null}
        </div>

        {availability.kind === "checking" ? <div className="mt-3 text-xs text-zinc-500">Checking name…</div> : null}
        {availability.kind === "invalid" ? (
          <div className="mt-3 text-xs text-red-600 dark:text-red-400">Use letters, numbers, and hyphens only.</div>
        ) : null}
        {availability.kind === "taken" ? (
          <div className="mt-3 text-xs text-amber-600 dark:text-amber-400">{availability.fullName} already exists.</div>
        ) : null}
        {availability.kind === "available" ? (
          <div className="mt-3 text-xs text-emerald-600 dark:text-emerald-400">
            {availability.fullName} was not found. It will route to {availability.a2aHost}.
          </div>
        ) : null}
        {status.kind === "saved" ? (
          <div className="mt-3 text-xs text-zinc-600 dark:text-zinc-400">
            ENS registration submitted
            {status.fullName ? (
              <>
                {" "}
                for <span className="font-mono">{status.fullName}</span>.
              </>
            ) : (
              <>
                . Waiting for your <span className="font-mono">-gym.8004-agent.eth</span> name to resolve.
              </>
            )}
            {status.txHash ? (
              <>
                {" "}
                Tx: <span className="font-mono">{status.txHash}</span>
              </>
            ) : null}
          </div>
        ) : null}
        {status.kind === "waiting" ? <div className="mt-3 text-xs text-zinc-600 dark:text-zinc-400">{status.message}</div> : null}
        {availability.kind === "error" ? <div className="mt-3 text-xs text-red-600 dark:text-red-400">{availability.error}</div> : null}
        {status.kind === "error" ? <div className="mt-3 text-xs text-red-600 dark:text-red-400">{status.error}</div> : null}
      </div>
    </div>
  );
}

