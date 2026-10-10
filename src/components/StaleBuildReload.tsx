"use client";

import { useEffect } from "react";
import toast from "react-hot-toast";

/**
 * Self-heal tabs that outlive a deploy.
 *
 * After every production deploy, tabs opened before it keep the old JS bundle
 * and start failing in confusing ways ("Failed to find Server Action",
 * "Loading chunk … failed", RSC payload mismatches) until the user reloads —
 * which looked like "parsing worked, then stopped" on some computers.
 *
 *   - When the tab becomes visible / focused, compare the server's build id
 *     with ours; if it changed, say so and reload.
 *   - Hidden tabs re-check every 10 minutes and reload silently.
 *   - A stale-bundle error reloads immediately (at most once a minute, so a
 *     genuinely broken deploy cannot loop).
 */
const STALE_ERROR = /Failed to find Server Action|ChunkLoadError|Loading chunk [\w-]+ failed|Failed to fetch dynamically imported module|Importing a module script failed/i;
const HIDDEN_CHECK_MS = 10 * 60 * 1000;
const RELOAD_GUARD_KEY = "eh:stale-reload-at";

function reloadOnce(reason: string, announce: boolean) {
  const last = Number(sessionStorage.getItem(RELOAD_GUARD_KEY) || 0);
  if (Date.now() - last < 60_000) return;
  sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));
  console.info(`[stale-build] reloading: ${reason}`);
  if (announce) {
    toast("A new version was deployed — reloading…", { icon: "🔄", duration: 1500 });
    setTimeout(() => window.location.reload(), 1200);
  } else {
    window.location.reload();
  }
}

export default function StaleBuildReload({ buildId }: { buildId: string }) {
  useEffect(() => {
    if (buildId === "dev") return;
    let inFlight = false;

    async function check(announce: boolean) {
      if (inFlight) return;
      inFlight = true;
      try {
        const res = await fetch("/api/version", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { buildId?: string };
        if (data.buildId && data.buildId !== buildId) {
          reloadOnce(`build ${buildId} → ${data.buildId}`, announce);
        }
      } catch {
        // offline / server restarting — try again next time
      } finally {
        inFlight = false;
      }
    }

    const onVisible = () => {
      if (document.visibilityState === "visible") void check(true);
    };
    const onError = (event: ErrorEvent | PromiseRejectionEvent) => {
      const err = "reason" in event ? event.reason : event.error ?? event.message;
      const message = err instanceof Error ? err.message : String(err ?? "");
      if (STALE_ERROR.test(message)) reloadOnce(message.slice(0, 80), false);
    };

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onError);
    const timer = setInterval(() => {
      if (document.visibilityState === "hidden") void check(false);
    }, HIDDEN_CHECK_MS);

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onError);
      clearInterval(timer);
    };
  }, [buildId]);

  return null;
}
