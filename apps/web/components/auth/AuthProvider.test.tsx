import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

vi.mock("@privy-io/react-auth", () => {
  return {
    PrivyProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    usePrivy: () => {
      return {
        ready: true,
        authenticated: true,
        user: { id: "did:privy:123" },
        login: vi.fn(),
        logout: vi.fn(),
        getAccessToken: vi.fn(async () => "tok_demo"),
      };
    },
  };
});

describe("AuthProvider", () => {
  it("derives a stable accountAddress from Privy DID", async () => {
    const { AuthProvider, useAuth } = await import("./AuthProvider");
    function Harness() {
      const { authenticated, accountAddress } = useAuth();
      return (
        <div>
          <div data-testid="authed">{authenticated ? "yes" : "no"}</div>
          <div data-testid="acct">{accountAddress ?? ""}</div>
        </div>
      );
    }

    vi.stubEnv("NEXT_PUBLIC_PRIVY_APP_ID", "app_test");
    const subtle = { digest: vi.fn(async () => new Uint8Array([1, 2, 3]).buffer) };
    const prev = (globalThis.crypto as any)?.subtle;
    Object.defineProperty(globalThis.crypto, "subtle", { value: subtle, configurable: true });

    render(
      <AuthProvider>
        <Harness />
      </AuthProvider>,
    );

    expect(screen.getByTestId("authed")).toHaveTextContent("yes");
    await waitFor(() => expect(screen.getByTestId("acct")).toHaveTextContent("acct:privy_AQID"));

    Object.defineProperty(globalThis.crypto, "subtle", { value: prev, configurable: true });
  });
});

