"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useWaiver } from "@/components/waiver/WaiverProvider";

type ApiOk = { id: string; createdAtISO: string; message: string };
type ApiErr = { error: string };

function computeIsMinor(dobISO: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dobISO)) return { isMinor: false, age: null as number | null };
  const dob = new Date(`${dobISO}T00:00:00Z`);
  const now = new Date();
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const m = now.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < dob.getUTCDate())) age--;
  return { isMinor: age < 18, age };
}

export default function WaiverPage() {
  const { setWaiver, waiver, clearWaiver } = useWaiver();
  const [accountAddress, setAccountAddress] = useState("");
  const [participantName, setParticipantName] = useState("");
  const [participantEmail, setParticipantEmail] = useState("");
  const [participantDobISO, setParticipantDobISO] = useState("");
  const [participantSignature, setParticipantSignature] = useState("");

  const [guardianName, setGuardianName] = useState("");
  const [guardianEmail, setGuardianEmail] = useState("");
  const [guardianSignature, setGuardianSignature] = useState("");

  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ApiOk | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { isMinor, age } = useMemo(() => computeIsMinor(participantDobISO), [participantDobISO]);

  async function submit() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/waiver", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accountAddress,
          participantName,
          participantEmail,
          participantDobISO,
          participantSignature,
          isMinor,
          guardianName: isMinor ? guardianName : undefined,
          guardianEmail: isMinor ? guardianEmail : undefined,
          guardianSignature: isMinor ? guardianSignature : undefined,
        }),
      });

      const json = (await res.json().catch(() => ({}))) as unknown;
      if (!res.ok) {
        const e = json as Partial<ApiErr>;
        setError(typeof e.error === "string" ? e.error : "Submission failed.");
        return;
      }
      const ok = json as ApiOk;
      setResult(ok);
      setWaiver({
        id: ok.id,
        createdAtISO: ok.createdAtISO,
        accountAddress: accountAddress.trim(),
        participantName: participantName.trim(),
        participantEmail: participantEmail.trim(),
        participantDobISO: participantDobISO.trim(),
        isMinor,
        guardianName: isMinor ? guardianName.trim() : undefined,
        guardianEmail: isMinor ? guardianEmail.trim() : undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900 dark:bg-black dark:text-zinc-50">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-10">
        <header className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Online Waiver</h1>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Minors (under 18) require a parent/guardian signature.
            </p>
          </div>
          <Link
            href="/chat"
            className="h-10 rounded-xl border border-zinc-200 px-3 text-sm font-medium leading-10 dark:border-white/10"
          >
            Chat
          </Link>
        </header>

        <main className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-white/10 dark:bg-zinc-950">
          <div className="grid grid-cols-1 gap-4">
            {waiver ? (
              <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-sm dark:border-white/10 dark:bg-white/5">
                <div className="font-semibold">Waiver on file (this browser)</div>
                <div className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
                  {waiver.participantName} • {waiver.participantEmail} • Account{" "}
                  <span className="font-mono">{waiver.accountAddress}</span> • ID{" "}
                  <span className="font-mono">{waiver.id}</span>
                </div>
                <button
                  onClick={() => clearWaiver()}
                  className="mt-3 h-9 rounded-xl border border-zinc-200 px-3 text-xs font-medium dark:border-white/10"
                >
                  Clear saved waiver
                </button>
              </div>
            ) : null}
            <Field label="Canonical account address (required for identity)">
              <input
                value={accountAddress}
                onChange={(e) => setAccountAddress(e.target.value)}
                placeholder="e.g. acct_... (from your account table address)"
                className="h-11 w-full rounded-xl border border-zinc-200 bg-white px-3 text-sm dark:border-white/10 dark:bg-zinc-950"
              />
              <div className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
                This is the canonical address used for reservations (not email).
              </div>
            </Field>
            <Field label="Participant full name">
              <input
                value={participantName}
                onChange={(e) => setParticipantName(e.target.value)}
                className="h-11 w-full rounded-xl border border-zinc-200 bg-white px-3 text-sm dark:border-white/10 dark:bg-zinc-950"
              />
            </Field>

            <Field label="Participant email">
              <input
                value={participantEmail}
                onChange={(e) => setParticipantEmail(e.target.value)}
                className="h-11 w-full rounded-xl border border-zinc-200 bg-white px-3 text-sm dark:border-white/10 dark:bg-zinc-950"
              />
            </Field>

            <Field label={`Date of birth (YYYY-MM-DD)${age != null ? ` • age ${age}` : ""}`}>
              <input
                value={participantDobISO}
                onChange={(e) => setParticipantDobISO(e.target.value)}
                placeholder="YYYY-MM-DD"
                className="h-11 w-full rounded-xl border border-zinc-200 bg-white px-3 text-sm dark:border-white/10 dark:bg-zinc-950"
              />
              <div className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
                Status: {isMinor ? "Minor (guardian required)" : "Adult"}
              </div>
            </Field>

            <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-sm leading-6 dark:border-white/10 dark:bg-white/5">
              <div className="font-semibold">Agreement</div>
              <p className="mt-2 text-zinc-700 dark:text-zinc-300">
                By signing below, you acknowledge the risks of climbing and agree to follow staff
                instructions and posted safety policies.
              </p>
            </div>

            <Field label="Participant signature (type full name)">
              <input
                value={participantSignature}
                onChange={(e) => setParticipantSignature(e.target.value)}
                className="h-11 w-full rounded-xl border border-zinc-200 bg-white px-3 text-sm dark:border-white/10 dark:bg-zinc-950"
              />
            </Field>

            {isMinor ? (
              <div className="rounded-2xl border border-zinc-200 p-4 dark:border-white/10">
                <div className="text-sm font-semibold">Guardian (required for minors)</div>
                <div className="mt-3 grid grid-cols-1 gap-4">
                  <Field label="Guardian full name">
                    <input
                      value={guardianName}
                      onChange={(e) => setGuardianName(e.target.value)}
                      className="h-11 w-full rounded-xl border border-zinc-200 bg-white px-3 text-sm dark:border-white/10 dark:bg-zinc-950"
                    />
                  </Field>
                  <Field label="Guardian email">
                    <input
                      value={guardianEmail}
                      onChange={(e) => setGuardianEmail(e.target.value)}
                      className="h-11 w-full rounded-xl border border-zinc-200 bg-white px-3 text-sm dark:border-white/10 dark:bg-zinc-950"
                    />
                  </Field>
                  <Field label="Guardian signature (type full name)">
                    <input
                      value={guardianSignature}
                      onChange={(e) => setGuardianSignature(e.target.value)}
                      className="h-11 w-full rounded-xl border border-zinc-200 bg-white px-3 text-sm dark:border-white/10 dark:bg-zinc-950"
                    />
                  </Field>
                </div>
              </div>
            ) : null}

            {error ? (
              <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900/40 dark:bg-red-950/40 dark:text-red-200">
                {error}
              </div>
            ) : null}
            {result ? (
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-900/40 dark:bg-emerald-950/40 dark:text-emerald-200">
                Submitted. Confirmation ID: <span className="font-mono">{result.id}</span>
              </div>
            ) : null}

            <div className="flex items-center gap-2">
              <button
                onClick={() => void submit()}
                disabled={busy}
                className="h-11 rounded-xl bg-zinc-900 px-4 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
              >
                {busy ? "Submitting…" : "Submit waiver"}
              </button>
              <Link href="/" className="text-sm text-zinc-600 underline dark:text-zinc-400">
                Home
              </Link>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm font-medium">{label}</span>
      {children}
    </label>
  );
}

