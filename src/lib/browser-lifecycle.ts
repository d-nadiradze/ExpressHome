import type { Browser, BrowserContext } from "playwright";

const activeBrowsers = new Set<Browser>();

function trackBrowser(browser: Browser): Browser {
  activeBrowsers.add(browser);
  browser.once("disconnected", () => activeBrowsers.delete(browser));
  return browser;
}

export function registerBrowser(browser: Browser): Browser {
  return trackBrowser(browser);
}

export async function closeBrowserSession(
  browser?: Browser | null,
  context?: BrowserContext | null
): Promise<void> {
  if (context) {
    await context.close().catch(() => null);
  }
  if (browser?.isConnected()) {
    await browser.close().catch(() => null);
  }
  if (browser) {
    activeBrowsers.delete(browser);
  }
}

export async function closeAllBrowsers(): Promise<void> {
  const browsers = [...activeBrowsers];
  await Promise.all(browsers.map((b) => b.close().catch(() => null)));
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
