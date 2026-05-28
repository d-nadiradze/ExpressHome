export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { recoverStuckJobs } = await import("@/lib/parse-queue");
    const { warmupParseBrowser, closeParseBrowser } = await import("@/lib/parse-browser");
    const { registerBrowserShutdownHooks } = await import("@/lib/browser-lifecycle");
    const { closeMyhomePostSession } = await import("@/lib/myhome-parser");
    const { closeSsgePostSession } = await import("@/lib/ssge-parser");

    registerBrowserShutdownHooks(async () => {
      await closeMyhomePostSession();
      await closeSsgePostSession();
      await closeParseBrowser();
    });

    await recoverStuckJobs();
    void warmupParseBrowser();
  }
}
