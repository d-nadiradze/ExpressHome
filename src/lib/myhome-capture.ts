/**
 * Discovery-spike network capture for the myhome.ge prefill flow.
 *
 * Goal: record the real auth.tnet.ge login token exchange and every
 * api-statements.tnet.ge create / upload / publish / checkout request made by a
 * genuine browser prefill, so we can later design a fully server-side (no
 * browser) API prefill.
 *
 * Everything here is gated by MYHOME_CAPTURE_HAR=true and is a no-op otherwise,
 * so production behaviour is unchanged when the flag is unset.
 *
 * Artifacts are written under a gitignored `captures/` directory and may contain
 * auth tokens / cookies — never commit them.
 */
import { mkdirSync, appendFileSync } from "fs";
import { join } from "path";
import type { BrowserContext } from "playwright";

/** Hosts whose traffic is relevant to building an API-based prefill. */
const CAPTURE_HOSTS = [
  "auth.tnet.ge",
  "api-statements.tnet.ge",
  "statements.myhome.ge",
];

/** Cap response bodies so a stray large payload can't bloat the log. */
const MAX_BODY_CHARS = 200_000;

export function isMyhomeCaptureEnabled(): boolean {
  return process.env.MYHOME_CAPTURE_HAR === "true";
}

/** Ensure ./captures exists and return its absolute path. */
export function captureDir(): string {
  const dir = join(process.cwd(), "captures");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Filesystem-safe timestamp, e.g. 2026-06-29T00-58-12-345Z. */
export function newCaptureTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** HAR path for a given capture timestamp (used by Playwright recordHar). */
export function harPathFor(stamp: string): string {
  return join(captureDir(), `myhome-${stamp}.har`);
}

/** Redact only password fields; auth tokens/cookies are intentionally kept. */
function redactSecrets(body: string | null): string | null {
  if (!body) return body;
  return body
    .replace(/("pass(?:word)?"\s*:\s*")[^"]*(")/gi, "$1***$2")
    .replace(/((?:^|&)pass(?:word)?=)[^&]*/gi, "$1***");
}

function isRelevant(url: string): boolean {
  return CAPTURE_HOSTS.some((host) => url.includes(host));
}

function isTextLikeContentType(contentType: string): boolean {
  return /json|text|application\/x-www-form-urlencoded|javascript|xml/i.test(
    contentType
  );
}

export interface StatementApiCapture {
  jsonlPath: string;
  dispose: () => void;
}

/**
 * Attach request/response logging for the relevant hosts to a browser context.
 * Each captured exchange is appended as one JSON line to captures/myhome-*.jsonl.
 */
export function attachStatementApiCapture(
  context: BrowserContext,
  stamp: string = newCaptureTimestamp()
): StatementApiCapture {
  const jsonlPath = join(captureDir(), `myhome-${stamp}.jsonl`);

  const onResponse = async (response: import("playwright").Response) => {
    try {
      const request = response.request();
      const url = request.url();
      if (!isRelevant(url)) return;

      const responseHeaders = response.headers();
      const contentType = responseHeaders["content-type"] || "";

      let responseBody: string | null = null;
      if (isTextLikeContentType(contentType)) {
        responseBody = await response.text().catch(() => null);
        if (responseBody && responseBody.length > MAX_BODY_CHARS) {
          responseBody =
            responseBody.slice(0, MAX_BODY_CHARS) + "...[truncated]";
        }
      } else {
        responseBody = `[skipped non-text body: ${contentType || "unknown"} ${
          responseHeaders["content-length"] ?? "?"
        }B]`;
      }

      const record = {
        ts: new Date().toISOString(),
        method: request.method(),
        resourceType: request.resourceType(),
        url,
        status: response.status(),
        requestHeaders: request.headers(),
        requestBody: redactSecrets(request.postData()),
        responseHeaders,
        responseBody,
      };

      appendFileSync(jsonlPath, JSON.stringify(record) + "\n");
    } catch {
      // Never let capture interfere with the prefill itself.
    }
  };

  context.on("response", onResponse);
  console.log(`[myhome-capture] logging statement API traffic -> ${jsonlPath}`);

  return {
    jsonlPath,
    dispose: () => {
      context.off("response", onResponse);
    },
  };
}
