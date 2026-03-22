"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useCart } from "@/components/cart/CartProvider";
import { useWaiver } from "@/components/waiver/WaiverProvider";
import { useRouter } from "next/navigation";

type ChatMessage = {
  role: "user" | "assistant";
  text: string;
  images?: string[];
};

type ChatApiResponse = {
  answer?: unknown;
  error?: unknown;
  suggestedCartItems?: unknown;
  cartActions?: unknown;
  uiActions?: unknown;
  goalBundle?: Record<string, unknown>;
  data?: unknown;
};

type SkillsApiResponse = {
  ok?: boolean;
  capabilities?: Array<{ id?: string; label?: string; tools?: string[] }>;
};

const GOAL_BUNDLE_STORAGE_KEY = "climb_gym_goal_bundle_v1";

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
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [lastSuggestions, setLastSuggestions] = useState<SuggestedCartItem[] | null>(null);
  const [goalBundle, setGoalBundle] = useState<Record<string, unknown> | null>(null);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [skills, setSkills] = useState<SkillsApiResponse | null>(null);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [clientTz, setClientTz] = useState<string>("America/Denver");
  const [profileMissing, setProfileMissing] = useState(false);
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileAge, setProfileAge] = useState("");
  const [profileSex, setProfileSex] = useState<"male" | "female" | "other" | "">("");
  const [profileHeightIn, setProfileHeightIn] = useState("");
  const [profileBodyShape, setProfileBodyShape] = useState<"lean" | "average" | "stocky" | "athletic" | "">("");
  const [profileActivityLevel, setProfileActivityLevel] = useState<
    "sedentary" | "light" | "moderate" | "very_active" | ""
  >("");

  const threadId = waiver?.accountAddress ? `thr_${waiver.accountAddress}` : "thr_demo";
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (tz && typeof tz === "string") setClientTz(tz);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadHistory() {
      const tid = threadId || "thr_demo";

      // Load from browser cache first (fast, works even if server memory isn't ready).
      let loadedAny = false;
      try {
        const goalRaw = window.localStorage.getItem(GOAL_BUNDLE_STORAGE_KEY);
        if (goalRaw && !cancelled) {
          const goalParsed = JSON.parse(goalRaw) as unknown;
          if (goalParsed && typeof goalParsed === "object") {
            const byThread = goalParsed as Record<string, unknown>;
            const b = byThread[tid];
            if (b && typeof b === "object" && !Array.isArray(b)) {
              setGoalBundle(b as Record<string, unknown>);
            }
          }
        }
        const raw = window.localStorage.getItem("climb_gym_chat_threads_v1");
        if (raw) {
          const parsed = JSON.parse(raw) as unknown;
          if (parsed && typeof parsed === "object") {
            const map = parsed as Record<string, unknown>;
            const arr = map[tid];
            if (Array.isArray(arr)) {
              const cached: ChatMessage[] = [];
              for (const x of arr) {
                if (!x || typeof x !== "object") continue;
                const o = x as Record<string, unknown>;
                const role = o.role === "user" || o.role === "assistant" ? o.role : null;
                const text = typeof o.text === "string" ? o.text : "";
                const images = Array.isArray(o.images) ? o.images.filter((u) => typeof u === "string" && u.trim()) : undefined;
                if (role && text.trim()) cached.push({ role, text, images });
              }
              if (!cancelled && cached.length) {
                setMessages(cached);
                loadedAny = true;
              }
            }
          }
        }
      } catch {
        // ignore
      }

      const url = "/api/agent/run";
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            message: "__CHAT_HISTORY__",
            session: {
              gymName: "Erie Community Center",
              timezone: clientTz || "America/Denver",
              threadId: tid,
              goalBundle: goalBundle ?? undefined,
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
          }),
        });
        const json = (await res.json().catch(() => ({}))) as any;
        const data = json?.data;
        const msgs = data?.messages;
        if (Array.isArray(msgs)) {
          const out: ChatMessage[] = [];
          for (const m of msgs) {
            if (!m || typeof m !== "object") continue;
            const role = (m as any).role;
            const content = (m as any).content;
            if ((role === "user" || role === "assistant") && typeof content === "string" && content.trim()) {
              out.push({ role, text: content });
            }
          }
          if (!cancelled && out.length) {
            setMessages(out);
            loadedAny = true;
          }
        }
      } catch {
        // ignore
      }

      if (!cancelled && !loadedAny) {
        setMessages([
          {
            role: "assistant",
            text: "Hi — ask about classes, policies, rentals, or check availability.",
          },
        ]);
      }
      if (!cancelled) setHydrated(true);
    }
    void loadHistory();
    return () => {
      cancelled = true;
    };
  }, [threadId, waiver, clientTz]);

  useEffect(() => {
    let cancelled = false;
    async function loadProfile() {
      if (!hydrated) return;
      if (!waiver?.accountAddress) return;
      try {
        setProfileBusy(true);
        setProfileError(null);
        const res = await fetch("/api/agent/run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            message: "__WEIGHT_PROFILE_GET__",
            session: {
              gymName: "Erie Community Center",
              timezone: clientTz || "America/Denver",
              threadId: threadId || "thr_demo",
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
          }),
        });
        const json = (await res.json().catch(() => ({}))) as any;
        const ok = json?.data?.ok;
        if (ok === false) {
          setProfileError(String(json?.data?.error ?? json?.data?.hint ?? "Profile load failed."));
          setProfileMissing(true);
          return;
        }
        const prof = json?.data?.profile;
        const age = typeof prof?.age === "number" ? String(prof.age) : typeof prof?.age === "string" ? prof.age : "";
        const sex = prof?.sex === "male" || prof?.sex === "female" || prof?.sex === "other" ? prof.sex : "";
        const heightIn = typeof prof?.height_in === "number" ? String(prof.height_in) : typeof prof?.height_in === "string" ? prof.height_in : "";
        const bodyShape = prof?.body_shape === "lean" || prof?.body_shape === "average" || prof?.body_shape === "stocky" || prof?.body_shape === "athletic" ? prof.body_shape : "";
        const activityLevel =
          prof?.activity_level === "sedentary" ||
          prof?.activity_level === "light" ||
          prof?.activity_level === "moderate" ||
          prof?.activity_level === "very_active"
            ? prof.activity_level
            : "";
        if (!cancelled) {
          setProfileAge(age);
          setProfileSex(sex);
          setProfileHeightIn(heightIn);
          setProfileBodyShape(bodyShape);
          setProfileActivityLevel(activityLevel);
          setProfileMissing(!(age && sex && heightIn && activityLevel));
        }
      } catch {
        // ignore
      } finally {
        if (!cancelled) setProfileBusy(false);
      }
    }
    void loadProfile();
    return () => {
      cancelled = true;
    };
  }, [hydrated, waiver?.accountAddress, clientTz, threadId]);

  useEffect(() => {
    const tid = threadId || "thr_demo";
    try {
      if (!hydrated) return;
      const raw = window.localStorage.getItem("climb_gym_chat_threads_v1");
      const parsed = raw ? (JSON.parse(raw) as unknown) : null;
      const map: Record<string, unknown> = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
      map[tid] = messages;
      window.localStorage.setItem("climb_gym_chat_threads_v1", JSON.stringify(map));
    } catch {
      // ignore
    }
  }, [messages, threadId, hydrated]);

  const canSend = useMemo(() => input.trim().length > 0 && !busy, [input, busy]);

  async function send() {
    if (!canSend) return;
    const text = input.trim();
    setInput("");
    setMessages((m) => [...m, { role: "user", text }]);
    setBusy(true);
    try {
      const url = "/api/agent/run";
      const body = {
        message: text,
        session: {
          gymName: "Erie Community Center",
          timezone: clientTz || "America/Denver",
          cartLines: lines,
          threadId: threadId || "thr_demo",
          goalBundle: goalBundle ?? undefined,
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
      const images = extractMealImages(payload?.data);
      setMessages((m) => [...m, { role: "assistant", text: String(payload?.answer ?? ""), images }]);
      setLastSuggestions(parseSuggestions(payload?.suggestedCartItems));

      if (payload?.goalBundle && typeof payload.goalBundle === "object" && !Array.isArray(payload.goalBundle)) {
        setGoalBundle(payload.goalBundle);
        const tid = threadId || "thr_demo";
        try {
          const raw = window.localStorage.getItem(GOAL_BUNDLE_STORAGE_KEY);
          const map: Record<string, unknown> = (raw && JSON.parse(raw)) || {};
          map[tid] = payload.goalBundle;
          window.localStorage.setItem(GOAL_BUNDLE_STORAGE_KEY, JSON.stringify(map));
        } catch {
          // ignore
        }
      }

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

  async function toggleSkills() {
    setSkillsOpen((v) => !v);
    if (skills || skillsError) return;
    try {
      const res = await fetch("/api/a2a/skills", { method: "GET" });
      const json = (await res.json().catch(() => ({}))) as SkillsApiResponse;
      if (!res.ok || !json?.ok) {
        setSkillsError("Failed to load skills.");
        return;
      }
      setSkills(json);
    } catch {
      setSkillsError("Failed to load skills.");
    }
  }

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900 dark:bg-black dark:text-zinc-50">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-10">
        <header className="flex flex-col gap-1">
          <div className="flex items-center justify-between gap-4">
            <h1 className="text-2xl font-semibold tracking-tight">Erie Rec Center Copilot</h1>
            <div className="flex items-center gap-2">
              <button
                onClick={() => void toggleSkills()}
                className="h-10 rounded-xl border border-zinc-200 px-3 text-sm font-medium leading-10 dark:border-white/10"
              >
                Skills
              </button>
              <Link
                href="/cart"
                className="h-10 rounded-xl border border-zinc-200 px-3 text-sm font-medium leading-10 dark:border-white/10"
              >
                Cart
              </Link>
            </div>
          </div>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            RAG for policies &amp; catalog, ops for availability.
          </p>
        </header>

        {skillsOpen ? (
          <div className="rounded-2xl border border-zinc-200 bg-white p-4 text-sm dark:border-white/10 dark:bg-zinc-950">
            {skillsError ? (
              <div className="text-zinc-600 dark:text-zinc-400">{skillsError}</div>
            ) : skills?.capabilities?.length ? (
              <div className="flex flex-col gap-3">
                {skills.capabilities.map((c) => (
                  <div key={String(c.id ?? c.label ?? "")}>
                    <div className="font-semibold">{String(c.label ?? c.id ?? "Capability")}</div>
                    {Array.isArray(c.tools) && c.tools.length ? (
                      <div className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
                        {c.tools.join(", ")}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-zinc-600 dark:text-zinc-400">Loading…</div>
            )}
          </div>
        ) : null}

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
                <div>{m.text}</div>
                {m.role === "assistant" && Array.isArray(m.images) && m.images.length ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {m.images.slice(0, 8).map((url) => (
                      <a
                        key={url}
                        href={url}
                        target="_blank"
                        rel="noreferrer"
                        className="block overflow-hidden rounded-xl border border-zinc-200 dark:border-white/10"
                        title="Open image"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={url} alt="Meal" className="h-24 w-24 object-cover" />
                      </a>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </main>

        {hydrated && waiver?.accountAddress && profileMissing ? (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-50">
            <div className="font-semibold">Complete your profile (for TDEE + calorie burn estimates)</div>
            {profileError ? <div className="mt-2 text-xs opacity-90">{profileError}</div> : null}
            <div className="mt-2 grid gap-2 sm:grid-cols-5">
              <input
                value={profileAge}
                onChange={(e) => setProfileAge(e.target.value)}
                placeholder="Age"
                className="h-10 rounded-xl border border-amber-200 bg-white px-3 text-sm outline-none dark:border-amber-500/30 dark:bg-zinc-950"
              />
              <select
                value={profileSex}
                onChange={(e) => setProfileSex(e.target.value as any)}
                className="h-10 rounded-xl border border-amber-200 bg-white px-3 text-sm outline-none dark:border-amber-500/30 dark:bg-zinc-950"
              >
                <option value="">Sex</option>
                <option value="male">Male</option>
                <option value="female">Female</option>
                <option value="other">Other</option>
              </select>
              <input
                value={profileHeightIn}
                onChange={(e) => setProfileHeightIn(e.target.value)}
                placeholder="Height (in)"
                className="h-10 rounded-xl border border-amber-200 bg-white px-3 text-sm outline-none dark:border-amber-500/30 dark:bg-zinc-950"
              />
              <select
                value={profileActivityLevel}
                onChange={(e) => setProfileActivityLevel(e.target.value as any)}
                className="h-10 rounded-xl border border-amber-200 bg-white px-3 text-sm outline-none dark:border-amber-500/30 dark:bg-zinc-950"
              >
                <option value="">Activity level</option>
                <option value="sedentary">Sedentary</option>
                <option value="light">Light</option>
                <option value="moderate">Moderate</option>
                <option value="very_active">Very active</option>
              </select>
              <select
                value={profileBodyShape}
                onChange={(e) => setProfileBodyShape(e.target.value as any)}
                className="h-10 rounded-xl border border-amber-200 bg-white px-3 text-sm outline-none dark:border-amber-500/30 dark:bg-zinc-950"
              >
                <option value="">Body shape (optional)</option>
                <option value="lean">Lean</option>
                <option value="average">Average</option>
                <option value="athletic">Athletic</option>
                <option value="stocky">Stocky</option>
              </select>
            </div>
            <div className="mt-3 flex items-center justify-end">
              <button
                disabled={profileBusy}
                onClick={async () => {
                  if (!waiver?.accountAddress) return;
                  setProfileBusy(true);
                  setProfileError(null);
                  try {
                    const ageN = Number.parseInt(profileAge.trim(), 10);
                    const heightN = Number.parseFloat(profileHeightIn.trim());
                    const profile: Record<string, unknown> = {};
                    if (Number.isFinite(ageN)) profile.age = ageN;
                    if (profileSex) profile.sex = profileSex;
                    if (Number.isFinite(heightN)) profile.height_in = heightN;
                    if (profileBodyShape) profile.body_shape = profileBodyShape;
                    if (profileActivityLevel) profile.activity_level = profileActivityLevel;
                    await fetch("/api/agent/run", {
                      method: "POST",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({
                        message: `__WEIGHT_PROFILE_UPSERT__:${JSON.stringify({ profile })}`,
                        session: {
                          gymName: "Erie Community Center",
                          timezone: clientTz || "America/Denver",
                          threadId: threadId || "thr_demo",
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
                      }),
                    });
                    // Reload profile to confirm it persisted.
                    const res2 = await fetch("/api/agent/run", {
                      method: "POST",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({
                        message: "__WEIGHT_PROFILE_GET__",
                        session: {
                          gymName: "Erie Community Center",
                          timezone: clientTz || "America/Denver",
                          threadId: threadId || "thr_demo",
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
                      }),
                    });
                    const j2 = (await res2.json().catch(() => ({}))) as any;
                    if (j2?.data?.ok === false) {
                      setProfileError(String(j2?.data?.error ?? j2?.data?.hint ?? "Profile save failed."));
                      setProfileMissing(true);
                    } else {
                      setProfileMissing(false);
                    }
                  } finally {
                    setProfileBusy(false);
                  }
                }}
                className="h-9 rounded-xl bg-amber-900 px-3 text-xs font-medium text-white disabled:opacity-50 dark:bg-amber-400 dark:text-black"
              >
                Save
              </button>
            </div>
          </div>
        ) : null}

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

function extractMealImages(data: unknown): string[] | undefined {
  if (!data || typeof data !== "object") return undefined;
  const d = data as Record<string, unknown>;
  const items = d.foodItems;
  if (!Array.isArray(items)) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of items) {
    if (!x || typeof x !== "object") continue;
    const o = x as Record<string, unknown>;
    const url = typeof o.image_url === "string" ? o.image_url.trim() : typeof (o as any).imageUrl === "string" ? String((o as any).imageUrl).trim() : "";
    if (!url || !(url.startsWith("http://") || url.startsWith("https://"))) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
    if (out.length >= 20) break;
  }
  return out.length ? out : undefined;
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

