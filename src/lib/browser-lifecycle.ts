import {
  chromium,
  type Browser,
  type BrowserContext,
  type LaunchOptions,
} from "playwright";
import { chromiumLaunchLimiter } from "@/lib/server-limits";

const activeBrowsers = new Set<Browser>();
const slotReleases = new WeakMap<Browser, () => void>();

/**
 * Playwright's close() has no timeout of its own. A Chromium that lost its
 * renderer (common under container memory pressure) never answers, so an
 * awaited close would hang the prefill job forever and — worse — never hand
 * its launch slot back, wedging every later job behind the limiter.
 */
function browserCloseTimeoutMs(): number {
  return parseInt(process.env.BROWSER_CLOSE_TIMEOUT_MS || "15000", 10);
}

async function closeWithDeadline(
  label: string,
  close: () => Promise<void>
): Promise<void> {
  const ms = browserCloseTimeoutMs();
  if (ms <= 0) {
    await close().catch(() => null);
    return;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    close().then(
      () => false,
      () => false
    ),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), ms);
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (timedOut) {
    console.warn(`[browser] ${label}.close() timed out after ${ms}ms`);
  }
}

function releaseSlot(browser: Browser): void {
  const release = slotReleases.get(browser);
  if (release) {
    slotReleases.delete(browser);
    release();
  }
}

function trackBrowser(browser: Browser): Browser {
  activeBrowsers.add(browser);
  browser.once("disconnected", () => {
    activeBrowsers.delete(browser);
    releaseSlot(browser);
  });
  return browser;
}

export function registerBrowser(browser: Browser): Browser {
  return trackBrowser(browser);
}

/**
 * Launch Chromium under the process-wide browser slot cap.
 * The slot is held until the browser disconnects / is closed — not just until
 * launch returns — so concurrent prefills cannot stack multiple Chromiums.
 */
export async function launchTrackedBrowser(
  options?: LaunchOptions
): Promise<Browser> {
  const release = await chromiumLaunchLimiter().acquire();
  try {
    const browser = trackBrowser(await chromium.launch(options));
    slotReleases.set(browser, release);
    return browser;
  } catch (error) {
    release();
    throw error;
  }
}

export async function closeBrowserSession(
  browser?: Browser | null,
  context?: BrowserContext | null
): Promise<void> {
  try {
    if (context) {
      await closeWithDeadline("context", () => context.close());
    }
    if (browser?.isConnected()) {
      await closeWithDeadline("browser", () => browser.close());
    }
  } finally {
    // The slot must come back even when Chromium refused to die, otherwise the
    // next prefill waits on a launch slot that no live browser owns.
    if (browser) {
      releaseSlot(browser);
      activeBrowsers.delete(browser);
    }
  }
}

export async function closeAllBrowsers(): Promise<void> {
  const browsers = [...activeBrowsers];
  await Promise.all(
    browsers.map(async (b) => {
      await closeWithDeadline("browser", () => b.close());
      releaseSlot(b);
    })
  );
  activeBrowsers.clear();
}

export function isMyhomePrefillHeadless(): boolean {
  return process.env.MYHOME_PREFILL_HEADLESS !== "false";
}

export function isSsgePrefillHeadless(): boolean {
  return process.env.SSGE_PREFILL_HEADLESS !== "false";
}

/** OAuth token grab for api-gateway — always headless unless explicitly debugging. */
export function isSsgeApiAuthHeadless(): boolean {
  return process.env.SSGE_API_AUTH_HEADED !== "true";
}

/** When false, each prefill launches a fresh browser and always closes it after the job. */
export function shouldReusePrefillSession(): boolean {
  return process.env.PREFILL_REUSE_BROWSER === "true";
}

export function prefillSessionTtlMs(): number {
  return parseInt(process.env.PREFILL_SESSION_TTL_MS || "120000", 10);
}

let shutdownHooksRegistered = false;

export function registerBrowserShutdownHooks(
  extraCleanup?: () => Promise<void>
): void {
  if (shutdownHooksRegistered || typeof process === "undefined") return;
  shutdownHooksRegistered = true;

  const shutdown = async (signal: string) => {
    console.log(`[browser] ${signal} — closing Playwright browsers`);
    try {
      await extraCleanup?.();
    } catch {
      /* ignore */
    }
    await closeAllBrowsers();
  };

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, () => {
      void shutdown(signal);
    });
  }
}
