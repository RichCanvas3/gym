"use client";

import { Implementation, toMetaMaskSmartAccount } from "@metamask/smart-accounts-kit";
import { createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";

type Hex = `0x${string}`;

type SignAgentChallengeArgs = {
  chainId: number;
  principalSmartAccount: Hex;
  ownerAddress: Hex;
  rpcUrl: string;
  typedData: {
    domain: Record<string, unknown>;
    types: Record<string, Array<Record<string, unknown>>>;
    primaryType: string;
    message: Record<string, unknown>;
  };
  signMessage: (input: { message: string }, options?: { address?: string }) => Promise<{ signature: string }>;
  signTypedData: (input: unknown, options?: { address?: string }) => Promise<{ signature: string }>;
};

export async function signAgentChallengeWithSmartAccount(args: SignAgentChallengeArgs): Promise<Hex> {
  if (args.chainId !== 11155111) throw new Error(`Unsupported chain for browser challenge signing: ${args.chainId}`);
  const publicClient = createPublicClient({
    chain: sepolia,
    transport: http(args.rpcUrl),
  });
  const smartAccount = await toMetaMaskSmartAccount({
    address: args.principalSmartAccount,
    client: publicClient,
    implementation: Implementation.Hybrid,
    signer: {
      account: {
        address: args.ownerAddress,
        signMessage: async ({ message }: { message: unknown }) => {
          const out = await args.signMessage({ message: String(message ?? "") }, { address: args.ownerAddress });
          return out.signature as Hex;
        },
        signTypedData: async (typedDataDefinition: unknown) => {
          const out = await args.signTypedData(typedDataDefinition, { address: args.ownerAddress });
          return out.signature as Hex;
        },
      },
    },
  });
  return (await (smartAccount.signTypedData as (args: unknown) => Promise<Hex>)({
    domain: args.typedData.domain as never,
    types: args.typedData.types as never,
    primaryType: args.typedData.primaryType as never,
    message: args.typedData.message as never,
  })) as Hex;
}
