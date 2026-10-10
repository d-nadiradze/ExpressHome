/**
 * Fetch an HTML page from a Cloudflare-protected portal (ss.ge, myhome.ge) in
 * a way that survives the managed challenge on datacenter IPs.
 *
 * Cloudflare keys the challenge on the client's TLS/HTTP fingerprint and the
 * egress IP: from the VPS, Node's fetch gets `cf-mitigated: challenge` (403,
 * ~5 KB "Just a moment" page) while a real Chromium passes. So escalate:
 *
 *   1. plain fetch            — ~300 ms, works from residential IPs / locally
 *   2. curl (if installed)    — different TLS stack, sometimes passes
 *   3. headless Chromium      — slowest (~5-40 s), but a real browser
 *
 * Once Chromium clears a challenge, its `cf_clearance` cookie is kept per
 * host and replayed by the fetch tier (same User-Agent, same egress IP), so
 * the next requests to that host are fast again until the cookie expires.
 * Callers should also cache whatever they extract (tokens live ~1 h).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const FETCH_TIMEOUT_MS = parseInt(process.env.PARSE_GOTO_TIMEOUT_MS || "20000", 10);
const CURL_TIMEOUT_S = Math.max(5, Math.ceil(FETCH_TIMEOUT_MS / 1000));
/**
 * How long a browser-obtained `cf_clearance` cookie is replayed before we let
 * the chain escalate again. Cloudflare's own expiry is usually longer, but a
 * site can revoke early; the cookie is also dropped as soon as a replay gets
 * challenged.
 */
const CLEARANCE_TTL_MS = parseInt(
  process.env.CHALLENGE_CLEARANCE_TTL_MS || String(25 * 60 * 1000),
  10
);
/**
 * Total budget for the Chromium tier (navigation + waiting for the challenge
 * interstitial to clear; a passing challenge takes ~5 s). The whole chain
 * (fetch 20 s + curl 20 s + slot 10 s + this) plus a possible account login
 * must fit inside the worker's 180 s parse deadline.
 */
const BROWSER_CHALLENGE_TIMEOUT_MS = parseInt(
  process.env.SSGE_CHALLENGE_BROWSER_TIMEOUT_MS || "30000",
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

// ---- Clearance cookie reuse -------------------------------------------------

interface Clearance {
  /** `Cookie` header value (cf_clearance plus whatever the site set). */
  cookie: string;
  expiresAt: number;
}

const clearances = new Map<string, Clearance>();

/** Replayable Cloudflare clearance for `host`, or null. Exposed for tests. */
export function getChallengeClearance(host: string): string | null {
  const c = clearances.get(host);
  if (!c) return null;
  if (c.expiresAt <= Date.now()) {
    clearances.delete(host);
    return null;
  }
  return c.cookie;
}

/** Remember browser cookies for `host`. Only useful when they include cf_clearance. */
export function setChallengeClearance(
  host: string,
  cookies: { name: string; value: string; expires?: number }[]
): boolean {
  const cf = cookies.find((c) => c.name === "cf_clearance");
  if (!cf) return false;
  let expiresAt = Date.now() + CLEARANCE_TTL_MS;
  if (cf.expires && cf.expires > 0) {
    expiresAt = Math.min(expiresAt, cf.expires * 1000);
  }
  if (expiresAt <= Date.now()) return false;
  clearances.set(host, {
    cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; "),
    expiresAt,
  });
  return true;
}

export function clearChallengeClearance(host: string): void {
  clearances.delete(host);
}

/**
 * Hosts where fetch *and* curl were just challenged while the browser passed
 * (Cloudflare is scoring the TLS fingerprint there). Skip straight to the
 * browser for a while rather than paying ~1 s to be refused twice per call.
 */
const CHALLENGED_HOST_TTL_MS = parseInt(
  process.env.CHALLENGE_SKIP_PLAIN_TTL_MS || String(10 * 60 * 1000),
  10
);
const challengedHosts = new Map<string, number>();

function plainTiersChallenged(host: string): boolean {
  const until = challengedHosts.get(host);
  if (!until) return false;
  if (until <= Date.now()) {
    challengedHosts.delete(host);
    return false;
  }
  return true;
}

async function viaFetch(url: string): Promise<SsgeHtmlResult> {
  const host = new URL(url).hostname;
  const clearance = getChallengeClearance(host);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ka-GE,ka;q=0.9,en;q=0.8",
        ...(clearance ? { Cookie: clearance } : {}),
      },
      signal: controller.signal,
    });
    const html = await res.text();
    if (looksLikeCloudflareChallenge(html, res.headers)) {
      if (clearance) {
        clearChallengeClearance(host);
        throw new Error(`Cloudflare challenge (HTTP ${res.status}) despite clearance cookie — dropped`);
      }
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
    // We only want the server-rendered document. Letting a 1.6 MB listing
    // page hydrate on a 2 vCPU box costs 20-30 s of renderer time (and
    // page.content()/close block behind it), so drop every subresource
    // except Cloudflare's own challenge assets under /cdn-cgi/.
    await context.route("**/*", (route) => {
      const req = route.request();
      if (req.resourceType() === "document" || req.url().includes("/cdn-cgi/")) {
        return route.continue();
      }
      return route.abort();
    });

    const page = await context.newPage();
    // Read the HTML straight from the main-frame navigation response instead
    // of the DOM: it is available as soon as the bytes arrive, and a cleared
    // challenge simply produces a second navigation response.
    let html = "";
    let lastDoc = "";
    page.on("response", (res) => {
      const req = res.request();
      if (!req.isNavigationRequest() || req.frame() !== page.mainFrame()) return;
      if (res.status() >= 300 && res.status() < 400) return;
      const cfMitigated = res.headers()["cf-mitigated"];
      void res
        .text()
        .then((body) => {
          lastDoc = body;
          if (
            body.includes("__NEXT_DATA__") &&
            !cfMitigated &&
            !looksLikeCloudflareChallenge(body)
          ) {
            html = body;
          }
        })
        .catch(() => {});
    });

    await page
      .goto(url, {
        waitUntil: "commit",
        timeout: Math.max(5_000, deadline - Date.now()),
      })
      .catch((err) => {
        // A challenge that clears mid-navigation can abort goto; the response
        // listener still sees the final document, so only fail if it did not.
        if (!html) throw err;
      });

    while (!html && Date.now() < deadline) {
      await page.waitForTimeout(250);
    }
    if (!html) {
      // Last resort: whatever the DOM holds now (slow, but complete).
      const dom = await page.content().catch(() => "");
      if (dom.includes("__NEXT_DATA__") && !looksLikeCloudflareChallenge(dom)) html = dom;
      else if (dom) lastDoc = dom;
    }
    if (html) {
      // Keep the clearance (if a challenge was actually served and solved) so
      // the fetch tier can skip the browser next time.
      const host = new URL(url).hostname;
      const cookies = await context.cookies(url).catch(() => []);
      if (setChallengeClearance(host, cookies)) {
        console.log(`[${host} html] stored Cloudflare clearance cookie for reuse`);
      }
      return { html, via: "browser" };
    }
    throw new Error(
      looksLikeCloudflareChallenge(lastDoc)
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
export async function fetchHtmlResilient(url: string): Promise<SsgeHtmlResult> {
  const failures: string[] = [];
  const { hostname: host, pathname } = new URL(url);
  const tag = `[${host.replace(/^(www|home)\./, "")} html]`;
  let challenged = 0;

  // Plain tiers are skipped only while the host is known to challenge them
  // and we hold no clearance cookie that might let fetch through.
  const skipPlain =
    browserEnabled() && plainTiersChallenged(host) && !getChallengeClearance(host);

  if (skipPlain) {
    failures.push("fetch/curl: skipped (host challenged them recently)");
  } else {
    try {
      return await viaFetch(url);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/Cloudflare challenge/.test(message)) challenged++;
      failures.push(`fetch: ${message}`);
    }

    if (curlEnabled()) {
      try {
        const result = await viaCurl(url);
        console.log(`${tag} fetch was challenged — curl succeeded for ${pathname}`);
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/Cloudflare challenge/.test(message)) challenged++;
        failures.push(`curl: ${message}`);
      }
    } else {
      challenged++; // only one plain tier available; treat it as decisive
    }
  }

  if (browserEnabled()) {
    try {
      const started = Date.now();
      if (!skipPlain) {
        console.warn(`${tag} ${failures.join("; ")} — launching headless Chromium for ${pathname}`);
      }
      const result = await viaBrowser(url);
      if (challenged >= 2) {
        challengedHosts.set(host, Date.now() + CHALLENGED_HOST_TTL_MS);
      }
      console.log(
        `${tag} ${skipPlain ? "browser" : "fetch/curl were challenged — browser"} succeeded in ${Date.now() - started}ms for ${pathname}`
      );
      return result;
    } catch (err) {
      challengedHosts.delete(host);
      failures.push(`browser: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new Error(`${host} page unavailable (${failures.join("; ")})`);
}

/** @deprecated alias — the chain is not ss.ge-specific any more. */
export const fetchSsgeHtmlResilient = fetchHtmlResilient;
