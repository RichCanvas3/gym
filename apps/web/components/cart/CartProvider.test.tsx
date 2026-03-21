import React from "react";
import { describe, expect, it } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { CartProvider, useCart } from "./CartProvider";

function Harness() {
  const { lines, addLine, removeSku, clear } = useCart();
  return (
    <div>
      <div data-testid="count">{lines.length}</div>
      <button onClick={() => addLine({ sku: "prod_day_pass", quantity: 2 })}>add</button>
      <button onClick={() => removeSku("prod_day_pass")}>remove</button>
      <button onClick={() => clear()}>clear</button>
    </div>
  );
}

describe("CartProvider", () => {
  it("adds, removes, clears cart lines", () => {
    render(
      <CartProvider>
        <Harness />
      </CartProvider>,
    );

    expect(screen.getByTestId("count")).toHaveTextContent("0");
    fireEvent.click(screen.getByText("add"));
    expect(screen.getByTestId("count")).toHaveTextContent("1");
    fireEvent.click(screen.getByText("remove"));
    expect(screen.getByTestId("count")).toHaveTextContent("0");
    fireEvent.click(screen.getByText("add"));
    expect(screen.getByTestId("count")).toHaveTextContent("1");
    fireEvent.click(screen.getByText("clear"));
    expect(screen.getByTestId("count")).toHaveTextContent("0");
  });
});

