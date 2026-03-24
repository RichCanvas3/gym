import { Suspense } from "react";
import StravaConnectClient from "./strava-connect-client";

export default function StravaConnectPage() {
  return (
    <Suspense fallback={<div className="mx-auto w-full max-w-2xl px-4 py-10 text-sm">Loading…</div>}>
      <StravaConnectClient />
    </Suspense>
  );
}

