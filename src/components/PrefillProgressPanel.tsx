"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { defaultPrefillSteps } from "@/lib/prefill-steps";

type PrefillPlatform = "myhome" | "ssge";
type PrefillJobStatus = "queued" | "running" | "success" | "failed" | "partial";
type PrefillStepStatus = "pending" | "running" | "done" | "error";
type PrefillLogLevel = "info" | "warn" | "error" | "success";

interface PrefillStep {
  id: string;
  label: string;
  status: PrefillStepStatus;
  detail?: string;
}

interface PrefillLogEntry {
  id: string;
  level: PrefillLogLevel;
  message: string;
  ts: number;
}

interface PrefillStatus {
  jobId: string;
  platform: PrefillPlatform;
  status: PrefillJobStatus;
  steps: PrefillStep[];
  logs: PrefillLogEntry[];
  error?: string;
  postUrl?: string;
  queuePosition?: number | null;
}

interface PrefillProgressPanelProps {
  jobId: string;
  platform: PrefillPlatform;
  onClose: () => void;
  onComplete?: (postUrl?: string) => void;
}

const TERMINAL: PrefillJobStatus[] = ["success", "failed", "partial"];

const platformMeta: Record<
  PrefillPlatform,
  { name: string; accent: string; gradient: string }
> = {
  myhome: {
    name: "myhome.ge",
    accent: "text-emerald-600",
    gradient: "from-emerald-500 to-teal-600",
  },
  ssge: {
    name: "ss.ge",
    accent: "text-indigo-600",
    gradient: "from-indigo-500 to-violet-600",
  },
};

function StepIcon({ status }: { status: PrefillStepStatus }) {
  if (status === "done") {
    return (
      <span className="flex h-7 w-7 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
        </svg>
      </span>
    );
  }
  if (status === "running") {
    return (
      <span className="flex h-7 w-7 items-center justify-center rounded-full bg-blue-100 text-blue-600">
        <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden>
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="flex h-7 w-7 items-center justify-center rounded-full bg-red-100 text-red-600">
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      </span>
    );
  }
  return (
    <span className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800">
      <span className="h-2 w-2 rounded-full bg-gray-300 dark:bg-slate-500" />
    </span>
  );
}

function logTone(level: PrefillLogLevel): string {
  switch (level) {
    case "success":
      return "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300";
    case "warn":
      return "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300";
    case "error":
      return "border-red-200 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300";
    default:
      return "border-gray-200 bg-gray-50 text-gray-700 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-300";
  }
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export default function PrefillProgressPanel({
  jobId,
  platform,
  onClose,
  onComplete,
}: PrefillProgressPanelProps) {
  const [status, setStatus] = useState<PrefillStatus | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const meta = platformMeta[platform];

  const fallbackSteps = useMemo(() => defaultPrefillSteps(platform), [platform]);
  const displaySteps = status?.steps?.length ? status.steps : fallbackSteps;

  useEffect(() => {
    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | null = null;
    let completed = false;

    async function tick() {
      if (cancelled || completed) return;

      try {
        const res = await fetch(
          `/api/prefill/status?jobId=${encodeURIComponent(jobId)}`
        );

        if (res.status === 404) {
          completed = true;
          if (intervalId) clearInterval(intervalId);
          setPollError(
            "Progress session not found. Prefill may still be running on the server."
          );
          return;
        }

        if (!res.ok) {
          completed = true;
          if (intervalId) clearInterval(intervalId);
          setPollError("Could not load prefill progress.");
          return;
        }

        const data = (await res.json()) as PrefillStatus;
        if (cancelled) return;

        setStatus(data);
        setPollError(null);

        if (TERMINAL.includes(data.status)) {
          completed = true;
          if (intervalId) clearInterval(intervalId);
          if (data.status === "success" || data.status === "partial") {
            onCompleteRef.current?.(data.postUrl);
          }
        }
      } catch {
        // transient — keep polling until terminal or unmount
      }
    }

    void tick();
    intervalId = setInterval(tick, 1000);

    return () => {
      cancelled = true;
      completed = true;
      if (intervalId) clearInterval(intervalId);
    };
  }, [jobId]);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [status?.logs.length]);

  const errorSteps = displaySteps.filter((s) => s.status === "error").length;
  const doneSteps = displaySteps.filter((s) => s.status === "done").length;
  const runningStep = displaySteps.find((s) => s.status === "running");
  const totalSteps = displaySteps.length;
  const progressPct =
    status?.status === "success"
      ? 100
      : Math.round(
          ((doneSteps + (runningStep ? 0.5 : 0)) / Math.max(totalSteps, 1)) * 100
        );
  const isFinished =
    TERMINAL.includes(status?.status as PrefillJobStatus) || Boolean(pollError);
  const isSuccess = status?.status === "success";
  const isPartial = status?.status === "partial";

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-4 pb-4 sm:pt-6 bg-gray-900/50 dark:bg-black/60 backdrop-blur-sm overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="prefill-progress-title"
    >
      <div className="w-full max-w-2xl max-h-[calc(100vh-2rem)] sm:max-h-[calc(100vh-3rem)] flex flex-col rounded-2xl bg-white dark:bg-slate-900 shadow-2xl border border-gray-200 dark:border-slate-700 overflow-hidden">
        <div
          className={`px-6 py-5 bg-gradient-to-r ${
            isPartial ? "from-amber-500 to-orange-600" : meta.gradient
          } text-white shrink-0`}
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-white/80 text-xs font-medium uppercase tracking-wide mb-1">
                {isFinished ? "Pre-fill finished" : "Pre-fill in progress"}
              </p>
              <h2 id="prefill-progress-title" className="text-xl font-bold">
                {meta.name}
              </h2>
              {status?.queuePosition ? (
                <p className="text-white/90 text-sm mt-1">
                  Queue position {status.queuePosition}
                </p>
              ) : runningStep ? (
                <p className="text-white/90 text-sm mt-1">{runningStep.label}</p>
              ) : status?.status === "queued" ? (
                <p className="text-white/90 text-sm mt-1">Waiting in queue…</p>
              ) : errorSteps > 0 ? (
                <p className="text-white/90 text-sm mt-1">
                  {errorSteps} step(s) need review
                </p>
              ) : null}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg bg-white/20 hover:bg-white/30 px-3 py-1.5 text-sm font-medium transition-colors shrink-0"
              aria-label="Close"
            >
              Close
            </button>
          </div>

          <div className="mt-4">
            <div className="flex justify-between text-xs text-white/80 mb-1.5">
              <span>
                {doneSteps} done{errorSteps ? ` · ${errorSteps} with issues` : ""} /{" "}
                {totalSteps}
              </span>
              <span>{progressPct}%</span>
            </div>
            <div className="h-2 rounded-full bg-white/25 overflow-hidden">
              <div
                className="h-full rounded-full bg-white transition-all duration-300 ease-out"
                style={{ width: `${isSuccess || isPartial ? 100 : progressPct}%` }}
              />
            </div>
          </div>
        </div>

        <div className="flex flex-col md:flex-row min-h-0 flex-1 overflow-hidden">
          <div className="md:w-[44%] border-b md:border-b-0 md:border-r border-gray-100 dark:border-slate-800 p-5 overflow-y-auto max-h-[40vh] md:max-h-none">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-slate-500 mb-3">
              Steps
            </h3>
            <ol className="space-y-0">
              {displaySteps.map((step, i) => (
                <li key={step.id} className="flex gap-3">
                  <div className="flex flex-col items-center">
                    <StepIcon status={step.status} />
                    {i < displaySteps.length - 1 && (
                      <div
                        className={`w-0.5 flex-1 min-h-[1.25rem] my-0.5 ${
                          step.status === "done"
                            ? "bg-emerald-200"
                            : step.status === "error"
                              ? "bg-red-200"
                              : "bg-gray-200 dark:bg-slate-700"
                        }`}
                      />
                    )}
                  </div>
                  <div className="pb-4 min-w-0 flex-1">
                    <p
                      className={`text-sm font-medium leading-tight ${
                        step.status === "running"
                          ? meta.accent
                          : step.status === "done"
                            ? "text-gray-900 dark:text-slate-100"
                            : step.status === "error"
                              ? "text-red-700 dark:text-red-400"
                              : "text-gray-400 dark:text-slate-500"
                      }`}
                    >
                      {step.label}
                    </p>
                    {step.detail && (
                      <p
                        className={`text-xs mt-0.5 line-clamp-3 ${
                          step.status === "error" ? "text-red-600 dark:text-red-400" : "text-gray-500 dark:text-slate-400"
                        }`}
                      >
                        {step.detail}
                      </p>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </div>

          <div className="flex-1 flex flex-col min-h-0 p-5">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-slate-500 mb-3 shrink-0">
              Live log
            </h3>
            <div
              className="flex-1 overflow-y-auto rounded-xl border border-gray-100 dark:border-slate-800 bg-gray-50/80 dark:bg-slate-950/50 p-3 space-y-2 min-h-[180px] max-h-[280px] md:max-h-none font-mono text-xs"
              aria-live="polite"
              aria-relevant="additions"
            >
              {(status?.logs ?? []).length === 0 && !pollError ? (
                <p className="text-gray-400 text-center py-8">Waiting for first log entry…</p>
              ) : (
                <>
                  {status?.logs.map((entry) => (
                    <div
                      key={entry.id}
                      className={`rounded-lg border px-2.5 py-1.5 ${logTone(entry.level)}`}
                    >
                      <span className="text-[10px] opacity-60 mr-2">
                        {formatTime(entry.ts)}
                      </span>
                      {entry.message}
                    </div>
                  ))}
                  {pollError && (
                    <div className="rounded-lg border border-red-200 bg-red-50 text-red-800 px-2.5 py-1.5">
                      {pollError}
                    </div>
                  )}
                </>
              )}
              <div ref={logsEndRef} />
            </div>
          </div>
        </div>

        <div className="px-6 py-4 border-t border-gray-100 bg-gray-50 shrink-0">
          {pollError ? (
            <div className="flex items-start gap-3 text-red-700">
              <svg className="h-5 w-5 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <div>
                <p className="font-semibold text-sm">Progress unavailable</p>
                <p className="text-xs text-red-600/90 mt-0.5">{pollError}</p>
              </div>
            </div>
          ) : isPartial ? (
            <div className="flex items-start gap-3 text-amber-800">
              <svg className="h-5 w-5 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <div>
                <p className="font-semibold text-sm">Prefill completed with missing fields</p>
                <p className="text-xs text-amber-700/90 mt-0.5">
                  Some required fields were not filled. Review the form and fix highlighted steps.
                </p>
                {status?.postUrl && (
                  <p className="text-xs text-amber-700/80 truncate mt-1">{status.postUrl}</p>
                )}
              </div>
            </div>
          ) : isSuccess ? (
            <div className="flex items-center gap-3 text-emerald-700">
              <svg className="h-5 w-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <div>
                <p className="font-semibold text-sm">Prefill completed successfully</p>
                {status?.postUrl && (
                  <p className="text-xs text-emerald-600/80 truncate mt-0.5">{status.postUrl}</p>
                )}
              </div>
            </div>
          ) : status?.status === "failed" ? (
            <div className="flex items-start gap-3 text-red-700">
              <svg className="h-5 w-5 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <div>
                <p className="font-semibold text-sm">Prefill failed</p>
                <p className="text-xs text-red-600/90 mt-0.5">{status.error}</p>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-3 text-gray-600">
              <svg className="h-5 w-5 animate-spin text-blue-500 shrink-0" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              <p className="text-sm">
                Prefill is running. You can close this panel — automation continues in the background.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
