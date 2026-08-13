import {
  MARKET_FETCH_TIMEOUT_MS,
  MARKET_REQUEST_GAP_MS,
  MARKET_USER_AGENT,
} from "@/lib/market-constants";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let lastRequestAt = 0;

async function respectGap(): Promise<void> {
  const wait = lastRequestAt + MARKET_REQUEST_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

export async function marketFetch(
  url: string,
  init?: RequestInit,
  retries = 3
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < retries; attempt++) {
    await respectGap();
    try {
      const res = await fetch(url, {
        ...init,
        headers: {
          "User-Agent": MARKET_USER_AGENT,
          Accept: "application/json",
          ...(init?.headers as Record<string, string> | undefined),
        },
        signal: init?.signal ?? AbortSignal.timeout(MARKET_FETCH_TIMEOUT_MS),
      });

      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const backoff = Number.isFinite(retryAfter)
          ? retryAfter * 1000
          : 1000 * 2 ** attempt;
        console.warn(`[market] 429 from ${url} — backing off ${backoff}ms`);
        await sleep(backoff);
        continue;
      }

      return res;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < retries - 1) {
        await sleep(500 * 2 ** attempt);
      }
    }
  }

  throw lastError ?? new Error(`marketFetch failed: ${url}`);
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function str(value: unknown): string {
  if (value == null) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

export function numStr(value: unknown): string {
  if (value == null || value === "") return "";
  const n = Number(value);
  return Number.isFinite(n) ? String(n) : str(value);
}
