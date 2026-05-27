export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { recoverStuckJobs } = await import("@/lib/parse-queue");
    const { warmupParseBrowser } = await import("@/lib/parse-browser");
    await recoverStuckJobs();
    void warmupParseBrowser();
  }
}
