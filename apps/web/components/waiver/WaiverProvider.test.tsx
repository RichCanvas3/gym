import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { WaiverProvider, useWaiver } from "./WaiverProvider";

function Harness() {
  const { waiver } = useWaiver();
  return <div data-testid="acct">{waiver?.accountAddress ?? ""}</div>;
}

describe("WaiverProvider", () => {
  it("uses demo waiver by default when enabled", () => {
    vi.stubEnv("NEXT_PUBLIC_DEMO_DEFAULT_USER", "1");
    render(
      <WaiverProvider>
        <Harness />
      </WaiverProvider>,
    );
    expect(screen.getByTestId("acct")).toHaveTextContent("acct_cust_casey");
  });
});

