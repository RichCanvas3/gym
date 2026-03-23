"use client";

import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { PrivyProvider, usePrivy } from "@privy-io/react-auth";

export type AuthContextValue = {
  ready: boolean;
  authenticated: boolean;
  user: unknown | null;
  accountAddress: string | null;
  getAccessToken: () => Promise<string>;
  login: () => void;
  logout: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

function base64UrlFromBytes(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  if (!globalThis.btoa) throw new Error("Missing btoa; cannot base64 encode.");
  const b64 = globalThis.btoa(bin);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256Base64Url(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return base64UrlFromBytes(new Uint8Array(hash));
}

function privyDidFromUser(user: unknown): string {
  if (!user || typeof user !== "object") return "";
  const u = user as Record<string, unknown>;
  const id = u.id;
  const did = u.did;
  if (typeof id === "string" && id.trim()) return id.trim();
  if (typeof did === "string" && did.trim()) return did.trim();
  return "";
}

function AuthContextInner({ children }: { children: React.ReactNode }) {
  const { ready, authenticated, user, login, logout, getAccessToken } = usePrivy();
  const [accountAddress, setAccountAddress] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function compute() {
      const did = privyDidFromUser(user);
      if (!did) {
        if (!cancelled) setAccountAddress(null);
        return;
      }
      const h = await sha256Base64Url(did);
      if (!cancelled) setAccountAddress(`acct:privy_${h}`);
    }
    void compute();
    return () => {
      cancelled = true;
    };
  }, [user]);

  const value = useMemo<AuthContextValue>(
    () => ({
      ready: Boolean(ready),
      authenticated: Boolean(authenticated),
      user: (user as unknown) ?? null,
      accountAddress,
      getAccessToken: async () => {
        const tok = await getAccessToken();
        return typeof tok === "string" ? tok : "";
      },
      login: () => login(),
      logout: () => logout(),
    }),
    [ready, authenticated, user, accountAddress, getAccessToken, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "";
  if (!appId) {
    const value: AuthContextValue = {
      ready: true,
      authenticated: false,
      user: null,
      accountAddress: null,
      getAccessToken: async () => "",
      login: () => {},
      logout: () => {},
    };
    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
  }
  return (
    <PrivyProvider appId={appId}>
      <AuthContextInner>{children}</AuthContextInner>
    </PrivyProvider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

