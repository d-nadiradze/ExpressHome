/**
 * Discovery-spike network capture for the ss.ge prefill flow.
 *
 * Records home.ss.ge / account.ss.ge create-wizard API traffic during a real
 * browser prefill so we can build HTTP-based API prefill.
 *
 * Gated by SSGE_CAPTURE_HAR=true — no-op otherwise.
 * Artifacts: captures/ssge-{timestamp}.{har,jsonl} (gitignored).
 */
import { mkdirSync, appendFileSync } from "fs";
import { join } from "path";
import type { BrowserContext } from "playwright";

const CAPTURE_HOSTS = [
  "home.ss.ge",
  "account.ss.ge",
  "api-gateway.ss.ge",
  "classification-api.ss.ge",
  "api.ss.ge",
  "ss.ge",
];

const MAX_BODY_CHARS = 200_000;

export function isSsgeCaptureEnabled(): boolean {
  return process.env.SSGE_CAPTURE_HAR === "true";
}

export function captureDir(): string {
  const dir = join(process.cwd(), "captures");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function newCaptureTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function ssgeHarPathFor(stamp: string): string {
  return join(captureDir(), `ssge-${stamp}.har`);
}

function redactSecrets(body: string | null): string | null {
  if (!body) return body;
  return body
    .replace(/("pass(?:word)?"\s*:\s*")[^"]*(")/gi, "$1***$2")
    .replace(/((?:^|&)pass(?:word)?=)[^&]*/gi, "$1***");
}

function isRelevant(url: string): boolean {
  if (url.includes("google") || url.includes("facebook") || url.includes("gstatic")) {
    return false;
  }
  return CAPTURE_HOSTS.some((host) => url.includes(host));
}

function isTextLikeContentType(contentType: string): boolean {
  return /json|text|application\/x-www-form-urlencoded|javascript|xml|multipart/i.test(
    contentType
  );
}

export interface SsgeApiCapture {
  jsonlPath: string;
  dispose: () => void;
}

export function attachSsgeApiCapture(
  context: BrowserContext,
  stamp: string = newCaptureTimestamp()
): SsgeApiCapture {
  const jsonlPath = join(captureDir(), `ssge-${stamp}.jsonl`);

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
      /* never break prefill */
    }
  };

  context.on("response", onResponse);
  console.log(`[ssge-capture] logging API traffic -> ${jsonlPath}`);

  return {
    jsonlPath,
    dispose: () => {
      context.off("response", onResponse);
    },
  };
}
