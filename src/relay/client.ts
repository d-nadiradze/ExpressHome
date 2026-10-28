/**
 * ss.ge token relay — client half. Runs on an ordinary home/office connection
 * (not a datacenter): ss.ge's Cloudflare Turnstile blocks token minting from
 * server IPs, but plain HTTP works from residential ones.
 *
 * Two ways to run it:
 *
 *   Admin (repo checkout, master secret, mints for every account):
 *     npx tsx scripts/ssge-token-relay.ts [--once]
 *     config from env or `.env.relay`: SSGE_RELAY_URL, SSGE_RELAY_SECRET
 *
 *   Staff PC (bundled by the Docker build into public/relay/ssge-relay.cjs and
 *   installed by public/relay/install.ps1; per-user token, mints the shared
 *   guest token and this user's own account token only):
 *     node ssge-relay.cjs
 *     config from env EH_RELAY_URL / EH_RELAY_TOKEN, or `config.json` next to
 *     the script: { "url": "...", "token": "..." }
 *
 * Loop: GET /api/internal/ssge-relay → mint what it asks for (guest token from
 * the public listing page, account tokens via the HTTP OAuth chain, credential
 * checks for accounts being linked) → POST the results. No browser involved;
 * one account login is ~3 s and ~6 requests.
 *
 * Auto-update: every 10 min compare our own file hash with /relay/version.txt
 * on the server; if the server ships a newer bundle, exit 0 — the launcher
 * re-downloads it and starts us again.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config as loadEnv } from "dotenv";
import { loginSsgeApiHttp } from "@/lib/ssge-api-http-auth";

// Node 16 (the last release that runs on Windows 7) has AbortController but
// not AbortSignal.timeout, and only has fetch behind --experimental-fetch,
// which the launcher turns on. Node 18+ already has both.
const signalStatics = AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal };
if (typeof signalStatics.timeout !== "function") {
  signalStatics.timeout = (ms: number): AbortSignal => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
  };
}
if (typeof fetch !== "function") {
  console.error(
    "This Node.js has no fetch. On Windows 7 the ExpressHome launcher must start it with --experimental-fetch."
  );
  process.exit(1);
}

const ONCE = process.argv.includes("--once");
const SELF_PATH = process.argv[1] ?? "";

function readConfig(): { url: string; token: string } {
  const env = process.env;
  const configFile = SELF_PATH ? join(dirname(SELF_PATH), "config.json") : "";
  // .env.relay is the admin/checkout way; bundled installs carry config.json.
  if (!env.EH_RELAY_URL && !env.SSGE_RELAY_URL && !(configFile && existsSync(configFile))) {
    loadEnv({ path: ".env.relay", quiet: true });
  }
  let url = env.EH_RELAY_URL || env.SSGE_RELAY_URL || "";
  let token = env.EH_RELAY_TOKEN || env.SSGE_RELAY_SECRET || "";
  if ((!url || !token) && configFile && existsSync(configFile)) {
    try {
      const parsed = JSON.parse(readFileSync(configFile, "utf8")) as { url?: string; token?: string };
      url = url || parsed.url || "";
      token = token || parsed.token || "";
    } catch (err) {
      console.error(`config.json unreadable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { url: url.replace(/\/+$/, ""), token: token.trim() };
}

const { url: SERVER, token: TOKEN } = readConfig();
/** Max account logins per pass — the rest wait for the next poll. */
const MAX_LOGINS_PER_PASS = parseInt(process.env.SSGE_RELAY_MAX_LOGINS || "8", 10);
const LOGIN_PAUSE_MS = parseInt(process.env.SSGE_RELAY_LOGIN_PAUSE_MS || "1500", 10);
const UPDATE_CHECK_MS = parseInt(process.env.SSGE_RELAY_UPDATE_CHECK_MS || String(2 * 60_000), 10);
const GUEST_PAGE =
  "https://home.ss.ge/ka/udzravi-qoneba/l/bina/iyideba?cityIdList=95";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

interface Work {
  relay?: { id: string; kind: "admin" | "user" };
  guest: { needed: boolean; urgent: boolean };
  accounts: Array<{ userId: string; email: string; password: string; urgent: boolean }>;
  verifications: Array<{ id: string; email: string; password: string }>;
  pages?: Array<{ id: string; url: string }>;
  api?: Array<{
    id: string;
    method: string;
    path: string;
    body?: string;
    contentType?: string;
    authorization: string;
  }>;
  pollMs: number;
}

interface Results {
  guest?: { token?: string; error?: string };
  accounts?: Array<{ userId: string; accessToken?: string; error?: string }>;
  verifications?: Array<{ id: string; accessToken?: string; error?: string }>;
  pages?: Array<{ id: string; html?: string; error?: string }>;
  api?: Array<{ id: string; status?: number; body?: string; contentType?: string; error?: string }>;
}

function log(msg: string): void {
  console.log(`${new Date().toISOString().slice(11, 19)} ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function mask(email: string): string {
  const [user, domain] = email.split("@");
  return `${(user || "").slice(0, 3)}...@${domain || "?"}`;
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function api<T>(method: "GET" | "POST", body?: unknown): Promise<T> {
  const res = await fetch(`${SERVER}/api/internal/ssge-relay`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    // GET long-polls while the office PC is idle, so this has to outlast that hold.
    signal: AbortSignal.timeout(method === "GET" ? 60_000 : 30_000),
  });
  if (!res.ok) {
    throw new HttpError(res.status, `${method} relay endpoint -> HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

function looksLikeCloudflare(html: string): boolean {
  if (html.length > 50_000) return false;
  return /Just a moment|cf-chl|challenge-platform/i.test(html);
}

function isAllowedSsgePageUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    return host === "home.ss.ge" || host === "www.home.ss.ge" || host === "ss.ge" || host === "www.ss.ge";
  } catch {
    return false;
  }
}

async function fetchSsgeHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "ka-GE,ka;q=0.9,en;q=0.8",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(25_000),
  });
  const html = await res.text();
  if (!res.ok) throw new Error(`page HTTP ${res.status}`);
  if (looksLikeCloudflare(html)) throw new Error("page is Cloudflare-challenged from this connection too");
  return html;
}

async function fetchGuestToken(): Promise<string> {
  const html = await fetchSsgeHtml(GUEST_PAGE);
  const match =
    html.match(/"credentialsToken"\s*:\s*"([^"]+)"/) ??
    html.match(/credentialsToken\\":\\"([^\\"]+)/);
  if (!match?.[1]) {
    throw new Error(`credentialsToken not in page (${html.length} bytes)`);
  }
  return match[1];
}

const API_ORIGIN = "https://api-gateway.ss.ge/v1";
const API_METHODS = new Set(["GET", "POST", "PUT", "DELETE", "PATCH"]);

function isAllowedApiPath(path: string): boolean {
  if (!path.startsWith("/") || path.startsWith("//")) return false;
  if (path.includes("..") || path.includes("\\") || path.length > 500) return false;
  return /^\/[A-Za-z0-9_./?&=%+\-]+$/.test(path);
}

async function callSsgeApi(job: NonNullable<Work["api"]>[number]): Promise<{
  status: number;
  body: string;
  contentType?: string;
  error?: string;
}> {
  const method = (job.method || "GET").toUpperCase();
  if (!API_METHODS.has(method) || !isAllowedApiPath(job.path)) {
    return { status: 0, body: "", error: "refused api call" };
  }
  if (!/^Bearer \S+$/.test(job.authorization || "")) {
    return { status: 0, body: "", error: "refused api call" };
  }
  const res = await fetch(`${API_ORIGIN}${job.path}`, {
    method,
    headers: {
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "ka-GE",
      Authorization: job.authorization,
      Origin: "https://home.ss.ge",
      Referer: "https://home.ss.ge/ka/udzravi-qoneba/create",
      "User-Agent": USER_AGENT,
      ...(job.body != null ? { "Content-Type": job.contentType || "application/json" } : {}),
    },
    body: job.body ?? undefined,
    redirect: "manual",
    signal: AbortSignal.timeout(60_000),
  });
  if (res.status >= 300 && res.status < 400) {
    return { status: res.status, body: "", error: "refused redirect" };
  }
  const body = await res.text();
  return {
    status: res.status,
    body: body.length > 2_000_000 ? body.slice(0, 2_000_000) : body,
    contentType: res.headers.get("content-type") || undefined,
  };
}

async function login(email: string, password: string): Promise<{ accessToken?: string; error?: string }> {
  const started = Date.now();
  const result = await loginSsgeApiHttp({ email, password });
  const ms = Date.now() - started;
  if (result.success && result.accessToken) {
    log(`  login ok   ${mask(email)} (${ms}ms)`);
    return { accessToken: result.accessToken };
  }
  log(`  login FAIL ${mask(email)} (${ms}ms): ${result.error}`);
  return { error: result.error || "ss.ge login failed" };
}

let announced = false;

async function pass(): Promise<number> {
  const work = await api<Work>("GET");
  if (!announced && work.relay) {
    announced = true;
    log(`server sees us as ${work.relay.kind} relay (${work.relay.id})`);
  }
  const results: Results = {};
  let did = 0;

  // Prefill API calls first — photos go out together, same as a direct upload.
  if (work.api?.length) {
    const outcomes = await mapPool(work.api, 4, async (job) => {
      const started = Date.now();
      try {
        const result = await callSsgeApi(job);
        log(
          `api ${job.method} ${job.path.split("?")[0]} -> ${result.status || result.error} (${Date.now() - started}ms)`
        );
        return { id: job.id, ...result };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        log(`api FAIL ${job.method} ${job.path.split("?")[0]}: ${error}`);
        return { id: job.id, status: 0, error };
      }
    });
    results.api = outcomes;
    did++;
  }

  // Listing HTML — a person is waiting on parse, and ss.ge no longer
  // ships credentialsToken so guest mint is often a wasted round-trip.
  if (work.pages?.length) {
    results.pages = [];
    for (const p of work.pages) {
      if (!isAllowedSsgePageUrl(p.url)) {
        results.pages.push({ id: p.id, error: "refused non-ss.ge URL" });
        continue;
      }
      try {
        const html = await fetchSsgeHtml(p.url);
        results.pages.push({ id: p.id, html });
        log(`page ok ${p.url} (${html.length} bytes)`);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        results.pages.push({ id: p.id, error });
        log(`page FAIL ${p.url}: ${error}`);
      }
    }
    did++;
  }

  if (work.guest.needed) {
    try {
      const token = await fetchGuestToken();
      results.guest = { token };
      log(`guest token ok${work.guest.urgent ? " (urgent)" : ""}`);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      results.guest = { error };
      log(`guest token FAIL: ${error}`);
    }
    did++;
  }

  // Credential checks first — a person is waiting on the link form.
  if (work.verifications.length) {
    results.verifications = [];
    for (const v of work.verifications) {
      log(`verify ${mask(v.email)}`);
      results.verifications.push({ id: v.id, ...(await login(v.email, v.password)) });
      did++;
    }
  }

  if (work.accounts.length) {
    const batch = work.accounts.slice(0, MAX_LOGINS_PER_PASS);
    log(
      `accounts: ${batch.length}/${work.accounts.length} (${batch.filter((a) => a.urgent).length} urgent)`
    );
    results.accounts = [];
    for (const [i, a] of batch.entries()) {
      if (i > 0) await sleep(LOGIN_PAUSE_MS);
      results.accounts.push({ userId: a.userId, ...(await login(a.email, a.password)) });
      did++;
    }
  }

  if (did > 0) await api("POST", results);
  // Come straight back after real work. Idle time is spent inside the long-poll GET.
  if (work.api?.length || work.pages?.length) return 200;
  return work.pollMs;
}

async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Math.min(limit, items.length);
  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await fn(items[index]);
      }
    })
  );
  return results;
}

// ---- Self-update (bundled installs only) ------------------------------------------

function selfVersion(): string | null {
  // Only the esbuild bundle has a published version; the tsx run from a
  // checkout updates with `git pull`.
  if (!/\.c?js$/i.test(SELF_PATH) || !existsSync(SELF_PATH)) return null;
  try {
    return createHash("sha256").update(readFileSync(SELF_PATH)).digest("hex").slice(0, 16);
  } catch {
    return null;
  }
}

async function publishedVersion(): Promise<string | null> {
  try {
    const res = await fetch(`${SERVER}/relay/version.txt?t=${Date.now()}`, {
      headers: { "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const text = (await res.text()).trim();
    return /^[0-9a-f]{8,64}$/i.test(text) ? text : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  if (!SERVER || !TOKEN) {
    console.error(
      "Relay is not configured: set EH_RELAY_URL + EH_RELAY_TOKEN (or SSGE_RELAY_URL + SSGE_RELAY_SECRET / .env.relay), or put config.json next to the script."
    );
    process.exit(1);
  }
  const mine = selfVersion();
  log(`ss.ge token relay -> ${SERVER}${ONCE ? " (single pass)" : ""}${mine ? ` (build ${mine})` : ""}`);

  let backoffMs = 5_000;
  let lastUpdateCheck = Date.now();
  let authFailures = 0;
  for (;;) {
    let waitMs: number;
    try {
      waitMs = await pass();
      backoffMs = 5_000;
      authFailures = 0;
    } catch (err) {
      if (err instanceof HttpError && (err.status === 401 || err.status === 404)) {
        // Token revoked / user deactivated / server without relay secret. Do
        // not hammer: back off hard and give up after a while (the launcher
        // restarts us later, which re-downloads config).
        authFailures++;
        log(`server refused our token (HTTP ${err.status}) - attempt ${authFailures}`);
        if (authFailures >= 5) {
          log("giving up for now; will retry after restart");
          process.exit(0);
        }
        waitMs = 60_000 * authFailures;
      } else {
        log(`pass failed: ${err instanceof Error ? err.message : String(err)} - retrying in ${backoffMs / 1000}s`);
        waitMs = backoffMs;
        backoffMs = Math.min(backoffMs * 2, 60_000);
      }
    }
    if (ONCE) return;

    if (mine && Date.now() - lastUpdateCheck >= UPDATE_CHECK_MS) {
      lastUpdateCheck = Date.now();
      const latest = await publishedVersion();
      if (latest && latest !== mine) {
        log(`new relay build ${latest} published (we are ${mine}) - exiting for update`);
        process.exit(0);
      }
    }

    await sleep(Math.max(200, waitMs));
  }
}

void main();
