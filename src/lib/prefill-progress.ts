import { getPrefillQueuePosition } from "@/lib/prefill-queue";
import {
  defaultPrefillSteps,
  type PrefillPlatform,
  type PrefillStep,
  type PrefillStepStatus,
} from "@/lib/prefill-steps";

export type { PrefillPlatform, PrefillStep, PrefillStepStatus };
export { MYHOME_PREFILL_STEPS, SSGE_PREFILL_STEPS, defaultPrefillSteps } from "@/lib/prefill-steps";

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

export type PrefillJobStatus = "queued" | "running" | "success" | "failed" | "partial";
export type PrefillLogLevel = "info" | "warn" | "error" | "success";

/** Shared across Next.js route bundles (module-level Maps are not). */
const globalStore = globalThis as unknown as {
  prefillJobs?: Map<string, PrefillProgressState>;
  prefillLogCounter?: number;
};

function jobs(): Map<string, PrefillProgressState> {
  if (!globalStore.prefillJobs) {
    globalStore.prefillJobs = new Map();
  }
  return globalStore.prefillJobs;
}

function nextLogId(): string {
  globalStore.prefillLogCounter = (globalStore.prefillLogCounter ?? 0) + 1;
  return String(globalStore.prefillLogCounter);
}

export function initPrefillProgress(
  jobId: string,
  platform: PrefillPlatform,
  listingId: string,
  userId: string
): PrefillProgressState {
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
  jobs().set(jobId, state);
  pushLog(state, "info", `Prefill job queued (${platform})`);
  return state;
}

export function getPrefillProgress(jobId: string): PrefillProgressState | null {
  return jobs().get(jobId) ?? null;
}

export function markPrefillRunning(jobId: string): void {
  const state = jobs().get(jobId);
  if (!state) return;
  state.status = "running";
  state.updatedAt = Date.now();
}

export function completePrefillJob(jobId: string, postUrl?: string): void {
  const state = jobs().get(jobId);
  if (!state) return;
  const hasWarnings = state.steps.some((s) => s.status === "error");
  state.status = hasWarnings ? "partial" : "success";
  state.postUrl = postUrl;
  state.updatedAt = Date.now();
  if (hasWarnings) {
    pushLog(state, "warn", "Prefill finished with missing or invalid fields — review the form");
  }
  pushLog(
    state,
    hasWarnings ? "warn" : "success",
    postUrl ? `Prefill complete — ${postUrl}` : "Prefill complete"
  );
}

export function failPrefillJob(jobId: string, error: string): void {
  const state = jobs().get(jobId);
  if (!state) return;
  state.status = "failed";
  state.error = error;
  state.updatedAt = Date.now();
  pushLog(state, "error", error);
}

function pushLog(state: PrefillProgressState, level: PrefillLogLevel, message: string) {
  state.logs.push({
    id: nextLogId(),
    level,
    message,
    ts: Date.now(),
  });
  if (state.logs.length > 120) state.logs.shift();
}

export function createPrefillReporter(jobId: string): PrefillReporter {
  const getState = () => jobs().get(jobId);

  return {
    step(id, detail) {
      const state = getState();
      if (!state) return;
      if (state.status === "queued") state.status = "running";
      for (const step of state.steps) {
        if (step.id === id) {
          step.status = "running";
          step.detail = detail;
        } else if (step.status === "running") {
          step.status = "done";
        }
      }
      pushLog(state, "info", detail ? `${findStepLabel(state, id)} — ${detail}` : findStepLabel(state, id));
      state.updatedAt = Date.now();
    },
    stepDone(id, detail) {
      const state = getState();
      if (!state) return;
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
      state.updatedAt = Date.now();
    },
    stepWarn(id, detail) {
      const state = getState();
      if (!state) return;
      const step = state.steps.find((s) => s.id === id);
      if (step) {
        step.status = "error";
        step.detail = detail;
      }
      pushLog(state, "warn", `${findStepLabel(state, id)} — ${detail}`);
      state.updatedAt = Date.now();
    },
    log(level, message) {
      const state = getState();
      if (!state) return;
      pushLog(state, level, message);
      state.updatedAt = Date.now();
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

function findStepLabel(state: PrefillProgressState, id: string): string {
  return state.steps.find((s) => s.id === id)?.label ?? id;
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

export function getPrefillStatusPayload(jobId: string) {
  const state = jobs().get(jobId);
  if (!state) return null;

  const queueKey =
    state.platform === "myhome"
      ? `myhome-${state.listingId}`
      : `ssge-${state.listingId}`;
  const pos = getPrefillQueuePosition(queueKey);

  return {
    ...state,
    queuePosition: pos >= 0 ? pos + 1 : null,
  };
}
