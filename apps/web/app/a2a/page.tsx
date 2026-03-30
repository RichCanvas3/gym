import { Suspense } from "react";
import A2AClient from "./ui";

export default function A2APage() {
  return (
    <Suspense fallback={<div className="mx-auto w-full max-w-2xl px-4 py-10 text-sm">Loading…</div>}>
      <A2AClient />
    </Suspense>
  );
}

