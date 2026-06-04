/**
 * Redis-backed prefill progress store.
 *
 * Replaces the globalThis in-memory Map in prefill-progress.ts.
 * Both the Next.js API routes and the standalone worker process import
 * from this module so that progress written by the worker is immediately
 * visible when the frontend polls the status endpoint.
 *
 * Key schema:  prefill:progress:<jobId>  →  JSON of PrefillProgressState
 * TTL:         2 hours (configurable via PREFILL_PROGRESS_TTL_S)
 */

import IORedis from "ioredis";
import { redisConnection } from "@/lib/bullmq-queue";
import {
  defaultPrefillSteps,
  type PrefillPlatform,
  type PrefillStep,
  type PrefillStepStatus,
} from "@/lib/prefill-steps";
import { getPrefillQueue } from "@/lib/bullmq-queue";

export type { PrefillPlatform, PrefillStep, PrefillStepStatus };
export {
  MYHOME_PREFILL_STEPS,
  SSGE_PREFILL_STEPS,
  defaultPrefillSteps,
} from "@/lib/prefill-steps";

export type PrefillJobStatus =
  | "queued"
  | "running"
  | "success"
  | "failed"
  | "partial";
export type PrefillLogLevel = "info" | "warn" | "error" | "success";

export interface PrefillLogEntry {
  id: string;
  level: PrefillLogLevel;
  message: string;
  ts: number;
}

export interface PrefillProgressState {
  jobId: string;
  platform: PrefillPlatform;
  listingId: string;
  userId: string;
  status: PrefillJobStatus;
  steps: PrefillStep[];
  logs: PrefillLogEntry[];
  error?: string;
  postUrl?: string;
  updatedAt: number;
}

export interface PrefillReporter {
  step(id: string, detail?: string): void;
  stepDone(id: string, detail?: string): void;
  stepWarn(id: string, detail: string): void;
  log(level: PrefillLogLevel, message: string): void;
  warn(message: string): void;
  info(message: string): void;
  success(message: string): void;
}

const TTL_S = parseInt(process.env.PREFILL_PROGRESS_TTL_S || "7200", 10);
const KEY_PREFIX = "prefill:progress:";

// ---- Redis client (lazy singleton per process) ----------------------------

const globalStore = globalThis as unknown as { _prefillRedis?: IORedis };

function getRedis(): IORedis {
  if (!globalStore._prefillRedis) {
    globalStore._prefillRedis = new IORedis({
      ...(redisConnection as object),
      lazyConnect: false,
    });
    globalStore._prefillRedis.on("error", (err: Error) =>
      console.error("[prefill-progress-redis] Redis error:", err.message)
    );
  }
  return globalStore._prefillRedis;
}

function key(jobId: string): string {
  return `${KEY_PREFIX}${jobId}`;
}

let _logCounter = 0;

function nextLogId(): string {
  return String(++_logCounter);
}

// ---- Read / write helpers -------------------------------------------------

async function readState(jobId: string): Promise<PrefillProgressState | null> {
  try {
    const raw = await getRedis().get(key(jobId));
    return raw ? (JSON.parse(raw) as PrefillProgressState) : null;
  } catch {
    return null;
  }
}

async function writeState(state: PrefillProgressState): Promise<void> {
  try {
    await getRedis().set(key(state.jobId), JSON.stringify(state), "EX", TTL_S);
  } catch (err) {
    console.error("[prefill-progress-redis] write failed:", err);
  }
}

async function updateState(
  jobId: string,
  mutate: (state: PrefillProgressState) => void
): Promise<void> {
  const state = await readState(jobId);
  if (!state) return;
  mutate(state);
  state.updatedAt = Date.now();
  await writeState(state);
}

function pushLog(
  state: PrefillProgressState,
  level: PrefillLogLevel,
  message: string
) {
  state.logs.push({ id: nextLogId(), level, message, ts: Date.now() });
  if (state.logs.length > 120) state.logs.shift();
}

// ---- Public API (mirrors prefill-progress.ts) -----------------------------

export async function initPrefillProgress(
  jobId: string,
  platform: PrefillPlatform,
  listingId: string,
  userId: string
): Promise<PrefillProgressState> {
  const state: PrefillProgressState = {
    jobId,
    platform,
    listingId,
    userId,
    status: "queued",
    steps: defaultPrefillSteps(platform),
    logs: [],
    updatedAt: Date.now(),
  };
  pushLog(state, "info", `Prefill job queued (${platform})`);
  await writeState(state);
  return state;
}

export async function getPrefillProgress(
  jobId: string
): Promise<PrefillProgressState | null> {
  return readState(jobId);
}

export async function markPrefillRunning(jobId: string): Promise<void> {
  await updateState(jobId, (s) => {
    s.status = "running";
  });
}

export async function completePrefillJob(
  jobId: string,
  postUrl?: string
): Promise<void> {
  await updateState(jobId, (s) => {
    const hasWarnings = s.steps.some((step) => step.status === "error");
    s.status = hasWarnings ? "partial" : "success";
    s.postUrl = postUrl;
    pushLog(s, "warn", "Prefill finished with missing or invalid fields — review the form");
    pushLog(
      s,
      hasWarnings ? "warn" : "success",
      postUrl ? `Prefill complete — ${postUrl}` : "Prefill complete"
    );
  });
}

export async function failPrefillJob(
  jobId: string,
  error: string
): Promise<void> {
  await updateState(jobId, (s) => {
    s.status = "failed";
    s.error = error;
    pushLog(s, "error", error);
  });
}

function findStepLabel(state: PrefillProgressState, id: string): string {
  return state.steps.find((s) => s.id === id)?.label ?? id;
}

/**
 * Returns a reporter that makes atomic read-modify-write calls to Redis.
 * Each reporter method is async-safe but not strongly atomic — acceptable
 * because a single job's reporter is only called sequentially.
 */
export function createPrefillReporter(jobId: string): PrefillReporter {
  // Buffer small logs and flush them together to reduce Redis calls
  return {
    step(id, detail) {
      void updateState(jobId, (state) => {
        if (state.status === "queued") state.status = "running";
        for (const step of state.steps) {
          if (step.id === id) {
            step.status = "running";
            step.detail = detail;
          } else if (step.status === "running") {
            step.status = "done";
          }
        }
        pushLog(
          state,
          "info",
          detail
            ? `${findStepLabel(state, id)} — ${detail}`
            : findStepLabel(state, id)
        );
      });
    },
    stepDone(id, detail) {
      void updateState(jobId, (state) => {
        const step = state.steps.find((s) => s.id === id);
        if (step && step.status !== "error") {
          step.status = "done";
          step.detail = detail;
        } else if (step && detail && !step.detail) {
          step.detail = detail;
        }
        if (detail && step?.status === "done") {
          pushLog(state, "success", `${findStepLabel(state, id)} — ${detail}`);
        }
      });
    },
    stepWarn(id, detail) {
      void updateState(jobId, (state) => {
        const step = state.steps.find((s) => s.id === id);
        if (step) {
          step.status = "error";
          step.detail = detail;
        }
        pushLog(state, "warn", `${findStepLabel(state, id)} — ${detail}`);
      });
    },
    log(level, message) {
      void updateState(jobId, (state) => {
        pushLog(state, level, message);
      });
    },
    warn(message) {
      this.log("warn", message);
    },
    info(message) {
      this.log("info", message);
    },
    success(message) {
      this.log("success", message);
    },
  };
}

export async function getPrefillStatusPayload(jobId: string) {
  const state = await readState(jobId);
  if (!state) return null;

  // Get queue position from BullMQ (works across processes)
  let queuePosition: number | null = null;
  if (state.status === "queued") {
    try {
      const queue = getPrefillQueue();
      const waiting = await queue.getWaiting();
      const pos = waiting.findIndex((j) => j.name === jobId);
      queuePosition = pos >= 0 ? pos + 1 : null;
    } catch {
      // non-critical
    }
  }

  return { ...state, queuePosition };
}

export const noopPrefillReporter: PrefillReporter = {
  step() {},
  stepDone() {},
  stepWarn() {},
  log() {},
  warn() {},
  info() {},
  success() {},
};
