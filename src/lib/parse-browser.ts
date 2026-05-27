import "@/lib/esbuild-shim";
import { chromium, type Browser, type Route } from "playwright";

const LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
];

let browserInstance: Browser | null = null;

export async function getParseBrowser(): Promise<Browser> {
  if (!browserInstance?.isConnected()) {
    browserInstance = await chromium.launch({
      headless: true,
      args: LAUNCH_ARGS,
    });
  }
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

/** Pre-launch Chromium on server start so the first parse skips cold boot. */
export async function warmupParseBrowser(): Promise<void> {
  try {
    await getParseBrowser();
  } catch (error) {
    console.warn("[parse] browser warmup failed:", error);
  }
}
