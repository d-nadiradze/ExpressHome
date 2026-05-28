"use client";

import { useEffect, useState } from "react";

interface AiTokenUsageStatus {
  limits: {
    hour: number | null;
    day: number | null;
    month: number | null;
  };
  usage: {
    hour: number;
    day: number;
    month: number;
  };
}

function formatLimit(used: number, limit: number | null): string {
  if (limit == null) return `${used.toLocaleString()} / ∞`;
  return `${used.toLocaleString()} / ${limit.toLocaleString()}`;
}

function usagePercent(used: number, limit: number | null): number | null {
  if (limit == null || limit <= 0) return null;
  return Math.min(100, Math.round((used / limit) * 100));
}

function UsageBar({
  label,
  used,
  limit,
}: {
  label: string;
  used: number;
  limit: number | null;
}) {
  const percent = usagePercent(used, limit);
  const nearLimit = percent != null && percent >= 85;

  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <span className="text-xs font-medium text-subtle">{label}</span>
        <span
          className={`text-xs tabular-nums ${
            nearLimit ? "text-amber-600 dark:text-amber-400" : "text-muted"
          }`}
        >
          {formatLimit(used, limit)}
        </span>
      </div>
      {limit != null ? (
        <div className="h-1.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-300 ${
              nearLimit ? "bg-amber-500" : "bg-violet-500"
            }`}
            style={{ width: `${percent ?? 0}%` }}
          />
        </div>
      ) : (
        <div className="h-1.5 rounded-full bg-slate-100 dark:bg-slate-800" />
      )}
    </div>
  );
}

export default function AiUsageCard() {
  const [status, setStatus] = useState<AiTokenUsageStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/ai/usage")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setStatus(data))
      .finally(() => setLoading(false));
  }, []);

  const hasLimits =
    status &&
    (status.limits.hour != null || status.limits.day != null || status.limits.month != null);

  if (loading) {
    return (
      <div className="card-muted animate-pulse h-28" aria-hidden="true" />
    );
  }

  if (!status || !hasLimits) {
    return null;
  }

  return (
    <div className="card space-y-4">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-violet-50 text-violet-600 dark:bg-violet-950/50 dark:text-violet-300">
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456z" />
          </svg>
        </div>
        <div>
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-50">AI token usage</h2>
          <p className="text-xs text-subtle mt-0.5">
            Improve with AI counts toward these limits.
          </p>
        </div>
      </div>

      <div className="space-y-3">
        {status.limits.hour != null && (
          <UsageBar label="This hour" used={status.usage.hour} limit={status.limits.hour} />
        )}
        {status.limits.day != null && (
          <UsageBar label="Today" used={status.usage.day} limit={status.limits.day} />
        )}
        {status.limits.month != null && (
          <UsageBar label="This month" used={status.usage.month} limit={status.limits.month} />
        )}
      </div>
    </div>
  );
}
