/**
 * Negative cache for expensive operations that just failed.
 *
 * When ss.ge's token page or login is blocked, every market slice and every
 * parse would otherwise re-run the whole fetch → curl → Chromium → Playwright
 * login chain (minutes of CPU, and more bot-looking traffic that makes the
 * block worse). After a failure, callers skip the attempt until the cooldown
 * expires and surface the original reason instead.
 */
export interface CooldownState {
  /** Milliseconds until another attempt is allowed. */
  remainingMs: number;
  /** Why the last attempt failed. */
  reason: string;
  /** When the last attempt failed. */
  failedAt: number;
}

export interface Cooldown {
  /** Active cooldown for `key`, or null if an attempt may proceed. */
  get(key?: string): CooldownState | null;
  /** Record a failure for `key`; blocks attempts for `ms` (default) from now. */
  fail(key: string | undefined, reason: string, ms?: number): void;
  /** Clear the cooldown for `key` (call after a success). */
  clear(key?: string): void;
}

export function createCooldown(defaultMs: number): Cooldown {
  const entries = new Map<string, { until: number; reason: string; failedAt: number }>();
  const k = (key?: string) => key ?? "";

  return {
    get(key) {
      const entry = entries.get(k(key));
      if (!entry) return null;
      const remainingMs = entry.until - Date.now();
      if (remainingMs <= 0) {
        entries.delete(k(key));
        return null;
      }
      return { remainingMs, reason: entry.reason, failedAt: entry.failedAt };
    },
    fail(key, reason, ms = defaultMs) {
      if (ms <= 0) return;
      const now = Date.now();
      entries.set(k(key), { until: now + ms, reason, failedAt: now });
    },
    clear(key) {
      entries.delete(k(key));
    },
  };
}

/** "3m 20s" / "45s" for log lines. */
export function formatCooldownMs(ms: number): string {
  const s = Math.max(1, Math.ceil(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}m ${rem}s` : `${m}m`;
}
