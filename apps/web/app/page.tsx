import Link from "next/link";

export default function Home() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 px-6 font-sans text-zinc-900 dark:bg-black dark:text-zinc-50">
      <main className="w-full max-w-3xl rounded-3xl border border-zinc-200 bg-white p-10 dark:border-white/10 dark:bg-zinc-950">
        <h1 className="text-3xl font-semibold tracking-tight">Erie Rec Center Copilot</h1>
        <p className="mt-3 max-w-xl text-sm leading-6 text-zinc-600 dark:text-zinc-400">
          Hosted assistant for Erie Community Center: schedules, classes, training, climbing wall,
          aquatics, and personal fitness tracking.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link
            href="/chat"
            className="inline-flex h-11 items-center rounded-xl bg-zinc-900 px-4 text-sm font-medium text-white dark:bg-white dark:text-black"
          >
            Open chat
          </Link>
          <Link
            href="/shop"
            className="inline-flex h-11 items-center rounded-xl border border-zinc-200 px-4 text-sm font-medium dark:border-white/10"
          >
            Shop + cart
          </Link>
          <Link
            href="/waiver"
            className="inline-flex h-11 items-center rounded-xl border border-zinc-200 px-4 text-sm font-medium dark:border-white/10"
          >
            Online waiver
          </Link>
          <Link
            href="/calendar"
            className="inline-flex h-11 items-center rounded-xl border border-zinc-200 px-4 text-sm font-medium dark:border-white/10"
          >
            Class calendar
          </Link>
        </div>
      </main>
    </div>
  );
}
