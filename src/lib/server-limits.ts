/**
 * Shared limiters for work that runs inside the Next.js / worker process.
 *
 * Held on globalThis so dev-mode module reloads reuse the same counters.
 */
import { createLimiter, type Limiter } from "@/lib/concurrency-limit";

const store = globalThis as unknown as {
  browserLoginLimiter?: Limiter;
  myhomeParseLimiter?: Limiter;
  chromiumLaunchLimiter?: Limiter;
};

/**
 * Account linking verifies credentials with Playwright. Each Chromium costs
 * hundreds of MB in the web container, so keep these serialized and fail fast
 * instead of letting retries stack up.
 */
export function browserLoginLimiter(): Limiter {
  if (!store.browserLoginLimiter) {
    store.browserLoginLimiter = createLimiter({
      maxConcurrent: parseInt(process.env.BROWSER_LOGIN_MAX_CONCURRENT || "1", 10),
      maxQueueWaitMs: parseInt(process.env.BROWSER_LOGIN_MAX_WAIT_MS || "45000", 10),
    });
  }
  return store.browserLoginLimiter;
}

/** myhome parses run in-process (HTTP + DB), so cap how many overlap. */
export function myhomeParseLimiter(): Limiter {
  if (!store.myhomeParseLimiter) {
    store.myhomeParseLimiter = createLimiter({
      maxConcurrent: parseInt(process.env.MYHOME_PARSE_MAX_CONCURRENT || "3", 10),
    });
  }
  return store.myhomeParseLimiter;
}

/**
 * Hard cap on live Chromium processes in this Node process (app or worker).
 * Separate from PREFILL_MAX_CONCURRENT — one job can launch auth + wizard
 * browsers; this bounds the real memory cost.
 */
export function chromiumLaunchLimiter(): Limiter {
  if (!store.chromiumLaunchLimiter) {
    store.chromiumLaunchLimiter = createLimiter({
      maxConcurrent: parseInt(process.env.BROWSER_MAX_CONCURRENT || "1", 10),
    });
  }
  return store.chromiumLaunchLimiter;
}
