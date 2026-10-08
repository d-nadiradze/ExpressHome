/**
 * Fetch an ss.ge HTML page in a way that survives Cloudflare's managed
 * challenge on datacenter IPs.
 *
 * Cloudflare keys the challenge on the client's TLS/HTTP fingerprint, not the
 * IP: from the same VPS, Node's fetch gets `cf-mitigated: challenge` (403,
 * ~5 KB "Just a moment" page) while curl receives the real page and a real
 * Chromium passes the challenge. So escalate:
 *
 *   1. plain fetch            — ~300 ms, works from residential IPs / locally
 *   2. curl (if installed)    — different TLS stack, passes from the VPS
 *   3. headless Chromium      — slowest (~5-15 s), but a real browser
 *
 * Callers should cache whatever they extract (tokens live ~1 h) so the slow
 * strategies run at most once per cache period.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const FETCH_TIMEOUT_MS = parseInt(process.env.PARSE_GOTO_TIMEOUT_MS || "20000", 10);
const CURL_TIMEOUT_S = Math.max(5, Math.ceil(FETCH_TIMEOUT_MS / 1000));
/**
 * Total budget for the Chromium tier (navigation + waiting for the challenge
 * interstitial to clear). Kept well under the 180 s parse deadline.
 */
const BROWSER_CHALLENGE_TIMEOUT_MS = parseInt(
  process.env.SSGE_CHALLENGE_BROWSER_TIMEOUT_MS || "45000",
  10
);
/**
 * Max time to wait for a free Chromium slot. The worker allows one Chromium
 * (BROWSER_MAX_CONCURRENT=1) and a prefill can hold it for minutes; a token
 * fetch must not queue behind that or the parse silently hits its deadline.
 */
const BROWSER_SLOT_WAIT_MS = parseInt(
  process.env.SSGE_CHALLENGE_BROWSER_SLOT_WAIT_MS || "10000",
  10
);

export type SsgeHtmlVia = "fetch" | "curl" | "browser";

export interface SsgeHtmlResult {
  html: string;
  via: SsgeHtmlVia;
}

/** Cloudflare's interstitial, whatever the status code. */
export function looksLikeCloudflareChallenge(
  html: string,
  headers?: Headers | null
): boolean {
  if (headers?.get("cf-mitigated")) return true;
  if (html.length > 50_000) return false;
  return (
    /<title>\s*Just a moment/i.test(html) ||
    /cf-chl|challenge-platform|_cf_chl_opt|cf_chl_rc/i.test(html) ||
    /Checking your browser|Enable JavaScript and cookies to continue/i.test(html)
  );
}

function curlEnabled(): boolean {
  return process.env.SSGE_CURL_FALLBACK !== "false";
}

function browserEnabled(): boolean {
  return process.env.SSGE_BROWSER_FALLBACK !== "false";
}

async function viaFetch(url: string): Promise<SsgeHtmlResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ka-GE,ka;q=0.9,en;q=0.8",
      },
      signal: controller.signal,
    });
    const html = await res.text();
    if (looksLikeCloudflareChallenge(html, res.headers)) {
      throw new Error(`Cloudflare challenge (HTTP ${res.status})`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { html, via: "fetch" };
  } finally {
    clearTimeout(timer);
  }
}

async function viaCurl(url: string): Promise<SsgeHtmlResult> {
  // Deliberately *not* impersonating Chrome here: Cloudflare scores the
  // User-Agent against the TLS fingerprint, and plain `curl/8.x` with curl's
  // own TLS stack is exactly what was verified to pass from the VPS.
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      "curl",
      ["-sS", "-L", "--max-time", String(CURL_TIMEOUT_S), "--compressed", url],
      { maxBuffer: 16 * 1024 * 1024, timeout: (CURL_TIMEOUT_S + 2) * 1000 }
    ));
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string; code?: string | number };
    if (e.code === "ENOENT") throw new Error("not installed");
    // e.g. "curl: (77) error setting certificate file" / "(28) Operation timed out"
    const detail = (e.stderr ?? "").trim().split("\n")[0] || e.message.split("\n")[0];
    throw new Error(`exit ${e.code ?? "?"}: ${detail}`);
  }
  if (looksLikeCloudflareChallenge(stdout)) {
    throw new Error("Cloudflare challenge via curl");
  }
  return { html: stdout, via: "curl" };
}

async function viaBrowser(url: string): Promise<SsgeHtmlResult> {
  const { launchTrackedBrowser, closeBrowserSession } = await import(
    "@/lib/browser-lifecycle"
  );
  const { LimiterBusyError } = await import("@/lib/concurrency-limit");
  const deadline = Date.now() + BROWSER_CHALLENGE_TIMEOUT_MS;

  let browser;
  try {
    browser = await launchTrackedBrowser(
      {
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--disable-crash-reporter",
        ],
      },
      { maxWaitMs: BROWSER_SLOT_WAIT_MS }
    );
  } catch (err) {
    if (err instanceof LimiterBusyError) {
      throw new Error(
        `Chromium slot busy for ${BROWSER_SLOT_WAIT_MS}ms (another browser job is running)`
      );
    }
    throw err;
  }
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    locale: "ka-GE",
    viewport: { width: 1366, height: 768 },
  });
  try {
    const page = await context.newPage();
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: Math.max(5_000, deadline - Date.now()),
    });
    // The challenge page auto-submits and reloads; poll until the real page
    // (one with Next.js data) is in the DOM or the shared budget runs out.
    let html = "";
    while (Date.now() < deadline) {
      html = await page.content().catch(() => "");
      if (html.includes("__NEXT_DATA__") && !looksLikeCloudflareChallenge(html)) {
        return { html, via: "browser" };
      }
      await page.waitForTimeout(1000);
    }
    throw new Error(
      looksLikeCloudflareChallenge(html)
        ? "Cloudflare challenge did not clear in the browser"
        : "Page loaded in browser but had no __NEXT_DATA__"
    );
  } finally {
    await closeBrowserSession(browser, context);
  }
}

/**
 * Fetch `url` with the escalation chain. Throws only when every enabled
 * strategy failed; the message lists each failure.
 */
export async function fetchSsgeHtmlResilient(url: string): Promise<SsgeHtmlResult> {
  const failures: string[] = [];

  try {
    return await viaFetch(url);
  } catch (err) {
    failures.push(`fetch: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (curlEnabled()) {
    try {
      const result = await viaCurl(url);
      console.log(`[ss.ge html] fetch was challenged — curl succeeded for ${new URL(url).pathname}`);
      return result;
    } catch (err) {
      failures.push(`curl: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (browserEnabled()) {
    try {
      const started = Date.now();
      console.warn(
        `[ss.ge html] ${failures.join("; ")} — launching headless Chromium for ${new URL(url).pathname}`
      );
      const result = await viaBrowser(url);
      console.log(
        `[ss.ge html] fetch/curl were challenged — browser succeeded in ${Date.now() - started}ms for ${new URL(url).pathname}`
      );
      return result;
    } catch (err) {
      failures.push(`browser: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new Error(`ss.ge page unavailable (${failures.join("; ")})`);
}
