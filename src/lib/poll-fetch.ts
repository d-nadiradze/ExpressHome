/**
 * Fetch helper for 1s status polling.
 *
 * A poll that outlives its interval must not stack up: when the server is
 * slow, unbounded polls add load to an already struggling app and keep it
 * down. Callers pair this with an in-flight guard so at most one poll per
 * component is open, and the timeout keeps polling alive after a stalled
 * request instead of waiting on nginx's own timeout.
 */
const DEFAULT_POLL_TIMEOUT_MS = 15000;

export async function pollFetch(
  url: string,
  timeoutMs: number = DEFAULT_POLL_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
