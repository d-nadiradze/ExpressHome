/**
 * Cloudflare-challenge escalation for ss.ge HTML: fetch → curl → browser.
 *
 * Run: npx tsx src/lib/ssge-challenge-fetch.test.ts
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";

process.env.SSGE_BROWSER_FALLBACK = "false"; // never launch Chromium in a unit test

const CHALLENGE_HTML =
  '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script></body></html>';
const REAL_HTML =
  '<!DOCTYPE html><html lang="ka"><head></head><body><script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"credentialsToken":"guest.jwt.token"}}}</script></body></html>';

function hasCurl(): boolean {
  try {
    execFileSync("curl", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const { fetchSsgeHtmlResilient, looksLikeCloudflareChallenge } = await import(
    "./ssge-challenge-fetch"
  );

  // ---- detection --------------------------------------------------------
  assert.equal(looksLikeCloudflareChallenge(CHALLENGE_HTML), true, "interstitial markup");
  assert.equal(
    looksLikeCloudflareChallenge("<html>anything</html>", new Headers({ "cf-mitigated": "challenge" })),
    true,
    "cf-mitigated header"
  );
  assert.equal(looksLikeCloudflareChallenge(REAL_HTML), false, "real page is not a challenge");
  console.log("ok challenge detection");

  // ---- local server standing in for home.ss.ge --------------------------
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(REAL_HTML);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/ka/udzravi-qoneba/l/bina/iyideba`;

  const realFetch = globalThis.fetch;
  try {
    // 1) Plain fetch works → used directly, nothing escalates.
    {
      const r = await fetchSsgeHtmlResilient(url);
      assert.equal(r.via, "fetch");
      assert.ok(r.html.includes("credentialsToken"));
      console.log("ok plain fetch is preferred");
    }

    // 2) fetch is challenged (403 + cf-mitigated) → curl gets the real page.
    globalThis.fetch = (async () =>
      new Response(CHALLENGE_HTML, {
        status: 403,
        headers: { "cf-mitigated": "challenge", "content-type": "text/html" },
      })) as typeof fetch;

    if (hasCurl()) {
      const r = await fetchSsgeHtmlResilient(url);
      assert.equal(r.via, "curl");
      assert.ok(r.html.includes("credentialsToken"));
      console.log("ok challenged fetch escalates to curl");
    } else {
      console.log("skip curl escalation (curl not installed here)");
    }

    // 3) Everything disabled/failing → one error naming each strategy.
    process.env.SSGE_CURL_FALLBACK = "false";
    await assert.rejects(
      () => fetchSsgeHtmlResilient(url),
      (err: Error) => /fetch: Cloudflare challenge \(HTTP 403\)/.test(err.message)
    );
    console.log("ok failure lists the strategies tried");
  } finally {
    globalThis.fetch = realFetch;
    server.close();
  }

  console.log("ssge-challenge-fetch tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
