import "@/lib/esbuild-shim";
import { chromium, type Browser, type Route } from "playwright";
import {
  closeBrowserSession,
  registerBrowser,
} from "@/lib/browser-lifecycle";

const LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--disable-crash-reporter",
];

let browserInstance: Browser | null = null;
let lastUsedAt = 0;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function parseBrowserIdleMs(): number {
  return parseInt(process.env.PARSE_BROWSER_IDLE_MS || "300000", 10);
}

function scheduleIdleClose(): void {
  const idleMs = parseBrowserIdleMs();
  if (idleMs <= 0) return;

  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (!browserInstance) return;
    if (Date.now() - lastUsedAt >= idleMs) {
      void closeParseBrowser();
    } else {
      scheduleIdleClose();
    }
  }, idleMs);
}

export async function getParseBrowser(): Promise<Browser> {
  lastUsedAt = Date.now();

  if (!browserInstance?.isConnected()) {
    browserInstance = registerBrowser(
      await chromium.launch({
        headless: true,
        args: LAUNCH_ARGS,
      })
    );
  }

  scheduleIdleClose();
  return browserInstance;
}

/** Skip images/fonts/CSS during parse — listing data comes from DOM/JSON, not pixels. */
export function blockParseResources(route: Route): void {
  const type = route.request().resourceType();
  if (["media", "font", "stylesheet", "image"].includes(type)) {
    route.abort();
  } else {
    route.continue();
  }
}

export async function closeParseBrowser(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  const browser = browserInstance;
  browserInstance = null;
  await closeBrowserSession(browser);
}

/** Pre-launch Chromium on server start so the first parse skips cold boot. */
export async function warmupParseBrowser(): Promise<void> {
  try {
    await getParseBrowser();
  } catch (error) {
    console.warn("[parse] browser warmup failed:", error);
  }
}
