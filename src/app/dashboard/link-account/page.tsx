import { Suspense } from "react";
import LinkAccountsClient from "./LinkAccountsClient";

function LinkAccountsFallback() {
  return (
    <div className="flex flex-col items-center justify-center py-20 gap-3">
      <div
        className="animate-spin w-8 h-8 border-[3px] border-slate-200 border-t-slate-900 rounded-full"
        role="status"
        aria-label="Loading"
      />
      <p className="text-sm text-slate-500">Loading…</p>
    </div>
  );
}

export default function LinkAccountPage() {
  return (
    <Suspense fallback={<LinkAccountsFallback />}>
      <LinkAccountsClient />
    </Suspense>
  );
}
