/**
 * ss.ge token relay — client half. Run this on an ordinary home/office
 * connection (not a datacenter): ss.ge's Cloudflare Turnstile blocks token
 * minting from server IPs, but plain HTTP works from residential ones.
 *
 *   npx tsx scripts/ssge-token-relay.ts            # run forever
 *   npx tsx scripts/ssge-token-relay.ts --once     # one pass, then exit
 *
 * Config (env or `.env.relay` in the repo root — see .env.relay.example):
 *   SSGE_RELAY_URL     https://makler.solutions
 *   SSGE_RELAY_SECRET  same value as SSGE_RELAY_SECRET on the server
 *
 * Loop: GET /api/internal/ssge-relay → mint what it asks for (guest token from
 * the public listing page, account tokens via the HTTP OAuth chain, credential
 * checks for accounts being linked) → POST the results. No browser involved;
 * one account login is ~3 s and ~6 requests.
 */
import { config as loadEnv } from "dotenv";
import { loginSsgeApiHttp } from "@/lib/ssge-api-http-auth";

loadEnv({ path: ".env.relay" });

const SERVER = (process.env.SSGE_RELAY_URL || "").replace(/\/+$/, "");
const SECRET = process.env.SSGE_RELAY_SECRET || "";
const ONCE = process.argv.includes("--once");
/** Max account logins per pass — the rest wait for the next poll. */
const MAX_LOGINS_PER_PASS = parseInt(process.env.SSGE_RELAY_MAX_LOGINS || "8", 10);
const LOGIN_PAUSE_MS = parseInt(process.env.SSGE_RELAY_LOGIN_PAUSE_MS || "1500", 10);
const GUEST_PAGE =
  "https://home.ss.ge/ka/udzravi-qoneba/l/bina/iyideba?cityIdList=95";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

interface Work {
  guest: { needed: boolean; urgent: boolean };
  accounts: Array<{ userId: string; email: string; password: string; urgent: boolean }>;
  verifications: Array<{ id: string; email: string; password: string }>;
  pollMs: number;
}

interface Results {
  guest?: { token?: string; error?: string };
  accounts?: Array<{ userId: string; accessToken?: string; error?: string }>;
  verifications?: Array<{ id: string; accessToken?: string; error?: string }>;
}

function log(msg: string): void {
  console.log(`${new Date().toISOString().slice(11, 19)} ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function mask(email: string): string {
  const [user, domain] = email.split("@");
  return `${(user || "").slice(0, 3)}…@${domain || "?"}`;
}

async function api<T>(method: "GET" | "POST", body?: unknown): Promise<T> {
  const res = await fetch(`${SERVER}/api/internal/ssge-relay`, {
    method,
    headers: {
      Authorization: `Bearer ${SECRET}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`${method} relay endpoint → HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

async function fetchGuestToken(): Promise<string> {
  const res = await fetch(GUEST_PAGE, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "ka-GE,ka;q=0.9,en;q=0.8",
    },
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error(`guest page HTTP ${res.status}`);
  const html = await res.text();
  const match =
    html.match(/"credentialsToken"\s*:\s*"([^"]+)"/) ??
    html.match(/credentialsToken\\":\\"([^\\"]+)/);
  if (!match?.[1]) {
    throw new Error(
      /Just a moment|cf-chl/i.test(html)
        ? "guest page is Cloudflare-challenged from this connection too"
        : `credentialsToken not in page (${html.length} bytes)`
    );
  }
  return match[1];
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

async function pass(): Promise<number> {
  const work = await api<Work>("GET");
  const results: Results = {};
  let did = 0;

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
  return work.pollMs;
}

async function main(): Promise<void> {
  if (!SERVER || !SECRET) {
    console.error("Set SSGE_RELAY_URL and SSGE_RELAY_SECRET (env or .env.relay).");
    process.exit(1);
  }
  log(`ss.ge token relay → ${SERVER}${ONCE ? " (single pass)" : ""}`);

  let backoffMs = 5_000;
  for (;;) {
    let waitMs: number;
    try {
      waitMs = await pass();
      backoffMs = 5_000;
    } catch (err) {
      log(`pass failed: ${err instanceof Error ? err.message : String(err)} — retrying in ${backoffMs / 1000}s`);
      waitMs = backoffMs;
      backoffMs = Math.min(backoffMs * 2, 60_000);
    }
    if (ONCE) return;
    await sleep(Math.max(1_000, waitMs));
  }
}

void main();
