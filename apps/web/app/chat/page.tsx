"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useCart } from "@/components/cart/CartProvider";
import { useWaiver } from "@/components/waiver/WaiverProvider";
import { useRouter } from "next/navigation";

type ChatMessage = {
  role: "user" | "assistant";
  text: string;
};

type ChatApiResponse = {
  answer?: unknown;
  error?: unknown;
  suggestedCartItems?: unknown;
  cartActions?: unknown;
  uiActions?: unknown;
};

type SuggestedCartItem = {
  sku: string;
  quantity: number;
  note?: string;
};

export default function ChatPage() {
  const router = useRouter();
  const { lines, addLine, removeSku, clear } = useCart();
  const { waiver } = useWaiver();
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: "assistant",
      text:
        "Hi — ask about classes, policies, rentals, or check availability (e.g., rental shoes size 11).",
    },
  ]);
  const [busy, setBusy] = useState(false);
  const [lastSuggestions, setLastSuggestions] = useState<SuggestedCartItem[] | null>(null);

  const canSend = useMemo(() => input.trim().length > 0 && !busy, [input, busy]);

  async function send() {
    if (!canSend) return;
    const text = input.trim();
    setInput("");
    setMessages((m) => [...m, { role: "user", text }]);
    setBusy(true);
    try {
      const useHosted = process.env.NEXT_PUBLIC_USE_LANGGRAPH === "1";
      const url = useHosted ? "/api/agent/run" : "/api/chat";
      const body = {
        message: text,
        session: {
          gymName: "Front Range Climbing (Boulder)",
          timezone: "America/Denver",
          cartLines: lines,
          threadId: waiver?.accountAddress ? `thr_${waiver.accountAddress}` : undefined,
          waiver: waiver
            ? {
                id: waiver.id,
                accountAddress: waiver.accountAddress,
                participantName: waiver.participantName,
                participantEmail: waiver.participantEmail,
                isMinor: waiver.isMinor,
              }
            : undefined,
        },
      };

      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      const json = (await res.json().catch(() => ({}))) as unknown;
      const j = json as Record<string, unknown>;
      const payload = json as ChatApiResponse;
      if (!res.ok) {
        const errMsg = extractErrorMessage(j);
        setMessages((m) => [
          ...m,
          { role: "assistant", text: errMsg },
        ]);
        return;
      }
      setMessages((m) => [...m, { role: "assistant", text: String(payload?.answer ?? "") }]);
      setLastSuggestions(parseSuggestions(payload?.suggestedCartItems));

      // Auto-apply cart actions, then navigate to /cart if requested.
      const cartOps = parseCartActions(payload?.cartActions);
      let cartChanged = false;
      for (const op of cartOps) {
        if (op.op === "clear") {
          clear();
          cartChanged = true;
        } else if (op.op === "remove" && op.sku) {
          removeSku(op.sku);
          cartChanged = true;
        } else if (op.op === "add" && op.sku) {
          addLine({ sku: op.sku, quantity: op.quantity ?? 1 });
          cartChanged = true;
        }
      }
      if (cartChanged) {
        router.push("/cart");
        return;
      }

      // Auto-navigate when agent signals it.
      const ui = parseUiActions(payload?.uiActions);
      const wantsWaiver = ui.some((a) => a.type === "navigate" && a.to === "/waiver");
      if (wantsWaiver) {
        router.push("/waiver");
        return;
      }
      const wantsCalendar = ui.some((a) => a.type === "navigate" && a.to === "/calendar");
      if (wantsCalendar) {
        router.push("/calendar");
        return;
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900 dark:bg-black dark:text-zinc-50">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-10">
        <header className="flex flex-col gap-1">
          <div className="flex items-center justify-between gap-4">
            <h1 className="text-2xl font-semibold tracking-tight">Climb Gym Copilot</h1>
            <Link
              href="/cart"
              className="h-10 rounded-xl border border-zinc-200 px-3 text-sm font-medium leading-10 dark:border-white/10"
            >
              Cart
            </Link>
          </div>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            RAG for policies &amp; catalog, ops for availability.
          </p>
        </header>

        <main className="flex flex-col gap-3 rounded-2xl border border-zinc-200 bg-white p-4 dark:border-white/10 dark:bg-zinc-950">
          <div className="flex flex-col gap-3">
            {messages.map((m, idx) => (
              <div
                key={idx}
                className={[
                  "max-w-[90%] whitespace-pre-wrap rounded-2xl px-4 py-3 text-sm leading-6",
                  m.role === "user"
                    ? "ml-auto bg-zinc-900 text-white dark:bg-white dark:text-black"
                    : "mr-auto bg-zinc-100 text-zinc-900 dark:bg-white/10 dark:text-zinc-50",
                ].join(" ")}
              >
                {m.text}
              </div>
            ))}
          </div>
        </main>

        {lastSuggestions?.length ? (
          <div className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-white/10 dark:bg-zinc-950">
            <div className="text-sm font-semibold">Suggested for cart</div>
            <div className="mt-3 flex flex-col gap-2">
              {lastSuggestions.map((s) => (
                <div key={`${s.sku}-${s.note ?? ""}`} className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm">{s.sku}</div>
                    {s.note ? (
                      <div className="text-xs text-zinc-600 dark:text-zinc-400">{s.note}</div>
                    ) : null}
                  </div>
                  <button
                    onClick={() => addLine({ sku: s.sku, quantity: s.quantity })}
                    className="h-9 rounded-xl bg-zinc-900 px-3 text-xs font-medium text-white dark:bg-white dark:text-black"
                  >
                    Add x{s.quantity}
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div className="flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void send();
            }}
            placeholder={busy ? "Thinking…" : "Ask a question…"}
            className="h-12 flex-1 rounded-xl border border-zinc-200 bg-white px-4 text-sm outline-none focus:ring-2 focus:ring-zinc-900/20 dark:border-white/10 dark:bg-zinc-950 dark:focus:ring-white/20"
            disabled={busy}
          />
          <button
            onClick={() => void send()}
            disabled={!canSend}
            className="h-12 rounded-xl bg-zinc-900 px-4 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

function parseSuggestions(value: unknown): SuggestedCartItem[] | null {
  if (!Array.isArray(value)) return null;
  const out: SuggestedCartItem[] = [];
  for (const x of value) {
    if (!x || typeof x !== "object") continue;
    const o = x as Record<string, unknown>;
    const sku = typeof o.sku === "string" ? o.sku : "";
    const quantity = typeof o.quantity === "number" ? o.quantity : 1;
    const note = typeof o.note === "string" ? o.note : undefined;
    if (!sku) continue;
    out.push({ sku, quantity: Math.max(1, Math.floor(quantity)), note });
  }
  return out.length ? out : null;
}

function extractErrorMessage(j: Record<string, unknown>) {
  if (typeof j.error === "string") return j.error;
  if (typeof j.detail === "string") return j.detail;
  return "Request failed.";
}

function parseCartActions(value: unknown): Array<{ op: "add" | "remove" | "clear"; sku?: string; quantity?: number }> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ op: "add" | "remove" | "clear"; sku?: string; quantity?: number }> = [];
  for (const x of value) {
    if (!x || typeof x !== "object") continue;
    const o = x as Record<string, unknown>;
    const op = o.op === "add" || o.op === "remove" || o.op === "clear" ? o.op : null;
    if (!op) continue;
    const sku = typeof o.sku === "string" ? o.sku : undefined;
    const quantity = typeof o.quantity === "number" ? o.quantity : undefined;
    out.push({ op, sku, quantity });
  }
  return out;
}

function parseUiActions(value: unknown): Array<{ type: "navigate"; to: string }> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ type: "navigate"; to: string }> = [];
  for (const x of value) {
    if (!x || typeof x !== "object") continue;
    const o = x as Record<string, unknown>;
    if (o.type !== "navigate") continue;
    const to = typeof o.to === "string" ? o.to : "";
    if (!to) continue;
    out.push({ type: "navigate", to });
  }
  return out;
}

