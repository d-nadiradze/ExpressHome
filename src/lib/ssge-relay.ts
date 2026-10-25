/**
 * ss.ge token relay — server side.
 *
 * Since 2026-10-22 ss.ge fronts home.ss.ge and account.ss.ge — the only hosts
 * that mint api-gateway bearer tokens — with an interactive Cloudflare
 * Turnstile. It blocks every automated path from every server IP we tested
 * (VPS IPv4/IPv6, Cloudflare WARP, GitHub runners; headless and headful
 * Chromium alike). api-gateway.ss.ge itself stays open: it only needs a valid
 * 1-hour JWT.
 *
 * A small client (`scripts/ssge-token-relay.ts`) running on an ordinary
 * residential connection polls `GET /api/internal/ssge-relay` for work, mints
 * the tokens there over plain HTTP (no browser, ~3 s each) and POSTs them
 * back. This module is the server half: it hands out work, stores results,
 * tracks which accounts to keep warm, and lets a job wait briefly for a token
 * it just asked for.
 *
 * Shared state lives in Redis (Next app + worker) and in the existing
 * per-account token cache in MySQL (`SsgeAccount.accessToken`).
 */
import { timingSafeEqual } from "node:crypto";
import IORedis from "ioredis";
import { redisConnection } from "@/lib/bullmq-queue";
import { db } from "@/lib/db";
import { decrypt } from "@/lib/encryption";
import {
  decodeJwtExpiryMs,
  getCachedSsgeApiAccessToken,
  saveSsgeApiToken,
} from "@/lib/ssge-api-token-cache";

const PREFIX = "ssge:relay:";
const KEY_HEARTBEAT = `${PREFIX}heartbeat`;
const KEY_GUEST = `${PREFIX}guest`;
const KEY_GUEST_URGENT = `${PREFIX}guest-urgent`;
const KEY_GUEST_ERROR = `${PREFIX}guest-error`;
const keyWant = (userId: string) => `${PREFIX}want:${userId}`;
const keyUrgent = (userId: string) => `${PREFIX}urgent:${userId}`;
const keyError = (userId: string) => `${PREFIX}error:${userId}`;
const keyVerify = (id: string) => `${PREFIX}verify:${id}`;
const keyVerifyResult = (id: string) => `${PREFIX}verify-result:${id}`;

/** Relay counts as online if it polled within this window. */
const HEARTBEAT_TTL_S = parseInt(process.env.SSGE_RELAY_HEARTBEAT_TTL_S || "180", 10);
/** Accounts stay on the keep-warm list this long after their last use. */
const KEEP_WARM_MS = parseInt(process.env.SSGE_RELAY_KEEP_WARM_MS || String(24 * 3600_000), 10);
/** Refresh a token this far before it expires. */
const REFRESH_AHEAD_MS = parseInt(process.env.SSGE_RELAY_REFRESH_AHEAD_MS || "900000", 10);
/** How long a job waits for the relay to deliver a token it asked for. */
const WAIT_MS = parseInt(process.env.SSGE_RELAY_WAIT_MS || "60000", 10);
const WAIT_POLL_MS = 2000;
const URGENT_TTL_S = 180;
const ERROR_TTL_S = 600;
const VERIFY_TTL_S = 180;
/** Guest tokens from ss.ge are ~1 h; treat as expiring a bit early. */
const TOKEN_SKEW_MS = 120_000;

export interface RelayGuestToken {
  token: string;
  expiresAt: number;
}

export interface RelayAccountWork {
  userId: string;
  email: string;
  password: string;
  /** A job is waiting on this right now — do it first. */
  urgent: boolean;
  /** Current token expiry (ms) if any; informational. */
  expiresAt: number | null;
}

export interface RelayVerifyWork {
  id: string;
  email: string;
  password: string;
}

export interface RelayWork {
  guest: { needed: boolean; urgent: boolean };
  accounts: RelayAccountWork[];
  verifications: RelayVerifyWork[];
  /** Suggested poll interval for the client (ms). */
  pollMs: number;
}

export interface RelayResults {
  guest?: { token?: string; error?: string };
  accounts?: Array<{ userId: string; accessToken?: string; error?: string }>;
  verifications?: Array<{ id: string; accessToken?: string; error?: string }>;
}

// ---- Redis client (lazy singleton per process) ----------------------------

const globalStore = globalThis as unknown as { _ssgeRelayRedis?: IORedis };

function redis(): IORedis {
  if (!globalStore._ssgeRelayRedis) {
    globalStore._ssgeRelayRedis = new IORedis({
      ...(redisConnection as object),
      lazyConnect: false,
      maxRetriesPerRequest: 3,
      commandTimeout: parseInt(process.env.SSGE_RELAY_REDIS_COMMAND_TIMEOUT_MS || "10000", 10),
    });
    globalStore._ssgeRelayRedis.on("error", (err: Error) =>
      console.error("[ss.ge relay] Redis error:", err.message)
    );
  }
  return globalStore._ssgeRelayRedis;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- Auth for the HTTP endpoint --------------------------------------------

export function isRelayConfigured(): boolean {
  return Boolean(process.env.SSGE_RELAY_SECRET?.trim());
}

/** Constant-time check of the relay client's bearer secret. */
export function isValidRelaySecret(header: string | null): boolean {
  const expected = process.env.SSGE_RELAY_SECRET?.trim();
  if (!expected || !header) return false;
  const presented = header.replace(/^Bearer\s+/i, "").trim();
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---- Liveness ---------------------------------------------------------------

export async function isRelayAlive(): Promise<boolean> {
  if (!isRelayConfigured()) return false;
  try {
    return (await redis().exists(KEY_HEARTBEAT)) === 1;
  } catch {
    return false;
  }
}

/** When the relay last checked in, or null. */
export async function relayLastSeen(): Promise<Date | null> {
  try {
    const v = await redis().get(KEY_HEARTBEAT);
    return v ? new Date(parseInt(v, 10)) : null;
  } catch {
    return null;
  }
}

// ---- Guest token -------------------------------------------------------------

export async function getRelayGuestToken(): Promise<RelayGuestToken | null> {
  try {
    const raw = await redis().get(KEY_GUEST);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RelayGuestToken;
    if (!parsed?.token || parsed.expiresAt - TOKEN_SKEW_MS <= Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Ask the relay for a guest token and wait for it. Returns null on timeout.
 * Throws if the relay reported a hard failure for the guest page.
 */
export async function requestRelayGuestToken(): Promise<RelayGuestToken | null> {
  const r = redis();
  await r.set(KEY_GUEST_URGENT, "1", "EX", URGENT_TTL_S);
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(WAIT_POLL_MS);
    const token = await getRelayGuestToken();
    if (token) return token;
    const error = await r.get(KEY_GUEST_ERROR).catch(() => null);
    if (error) throw new Error(`ss.ge relay could not fetch a guest token: ${error}`);
  }
  return null;
}

// ---- Account tokens ------------------------------------------------------------

/** Remember that this account is in use so the relay keeps its token fresh. */
export async function markAccountWanted(userId: string): Promise<void> {
  try {
    await redis().set(keyWant(userId), "1", "PX", KEEP_WARM_MS);
  } catch {
    /* best effort */
  }
}

/**
 * Ask the relay for a fresh token for `userId` and wait for it to land in the
 * per-account cache. Returns null on timeout. Throws if the relay reported
 * that ss.ge rejected the login (wrong password etc.), so callers surface that
 * immediately instead of waiting out the deadline.
 */
export async function requestRelayAccountToken(userId: string): Promise<string | null> {
  const r = redis();
  await r.set(keyUrgent(userId), "1", "EX", URGENT_TTL_S);
  await r.set(keyWant(userId), "1", "PX", KEEP_WARM_MS);
  await r.del(keyError(userId));
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(WAIT_POLL_MS);
    const token = await getCachedSsgeApiAccessToken(userId);
    if (token) return token;
    const error = await r.get(keyError(userId)).catch(() => null);
    if (error) throw new Error(error);
  }
  return null;
}

// ---- Credential verification (account linking) -----------------------------------

/**
 * Hand a not-yet-saved email/password to the relay for a real ss.ge login.
 * Resolves with the access token on success; throws with ss.ge's reason on
 * rejection; returns null if the relay did not answer in time.
 */
export async function verifyCredentialsViaRelay(
  email: string,
  password: string
): Promise<string | null> {
  const r = redis();
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  await r.set(keyVerify(id), JSON.stringify({ email, password }), "EX", VERIFY_TTL_S);
  const deadline = Date.now() + WAIT_MS;
  try {
    while (Date.now() < deadline) {
      await sleep(WAIT_POLL_MS);
      const raw = await r.get(keyVerifyResult(id));
      if (!raw) continue;
      const result = JSON.parse(raw) as { accessToken?: string; error?: string };
      if (result.accessToken) return result.accessToken;
      throw new Error(result.error || "ss.ge login failed");
    }
    return null;
  } finally {
    await r.del(keyVerify(id), keyVerifyResult(id)).catch(() => null);
  }
}

// ---- Work hand-off (used by the HTTP route) -------------------------------------------

async function scanKeys(pattern: string): Promise<string[]> {
  const r = redis();
  const found: string[] = [];
  let cursor = "0";
  do {
    const [next, keys] = await r.scan(cursor, "MATCH", pattern, "COUNT", 200);
    cursor = next;
    found.push(...keys);
  } while (cursor !== "0");
  return found;
}

export async function pullRelayWork(): Promise<RelayWork> {
  const r = redis();
  await r.set(KEY_HEARTBEAT, String(Date.now()), "EX", HEARTBEAT_TTL_S);

  // Guest token: always keep one warm; urgent if someone is waiting.
  const guest = await getRelayGuestToken();
  const guestUrgent = (await r.exists(KEY_GUEST_URGENT)) === 1;
  const guestNeeded =
    guestUrgent || !guest || guest.expiresAt - REFRESH_AHEAD_MS <= Date.now();

  // Accounts: those marked wanted (used in the last KEEP_WARM_MS) or urgent.
  const wantKeys = await scanKeys(`${PREFIX}want:*`);
  const urgentKeys = await scanKeys(`${PREFIX}urgent:*`);
  const urgentIds = new Set(urgentKeys.map((k) => k.slice(`${PREFIX}urgent:`.length)));
  const candidateIds = new Set<string>([
    ...wantKeys.map((k) => k.slice(`${PREFIX}want:`.length)),
    ...urgentIds,
  ]);

  const accounts: RelayAccountWork[] = [];
  if (candidateIds.size > 0) {
    const rows = await db.ssgeAccount.findMany({
      where: { userId: { in: [...candidateIds] }, isVerified: true },
      select: { userId: true, ssgeEmail: true, ssgePassword: true, tokenExpiryDate: true },
    });
    for (const row of rows) {
      const urgent = urgentIds.has(row.userId);
      const expiresAt = row.tokenExpiryDate?.getTime() ?? null;
      const fresh = expiresAt !== null && expiresAt - REFRESH_AHEAD_MS > Date.now();
      if (fresh && !urgent) continue;
      let password: string;
      try {
        password = decrypt(row.ssgePassword);
      } catch {
        continue;
      }
      if (!password) continue;
      accounts.push({ userId: row.userId, email: row.ssgeEmail, password, urgent, expiresAt });
    }
    accounts.sort((a, b) => Number(b.urgent) - Number(a.urgent));
  }

  const verifications: RelayVerifyWork[] = [];
  for (const k of await scanKeys(`${PREFIX}verify:*`)) {
    const id = k.slice(`${PREFIX}verify:`.length);
    if ((await r.exists(keyVerifyResult(id))) === 1) continue;
    const raw = await r.get(k);
    if (!raw) continue;
    try {
      const { email, password } = JSON.parse(raw) as { email: string; password: string };
      verifications.push({ id, email, password });
    } catch {
      /* skip malformed */
    }
  }

  const busy = guestUrgent || accounts.some((a) => a.urgent) || verifications.length > 0;
  return {
    guest: { needed: guestNeeded, urgent: guestUrgent },
    accounts,
    verifications,
    pollMs: busy ? 3000 : parseInt(process.env.SSGE_RELAY_POLL_MS || "15000", 10),
  };
}

export async function pushRelayResults(results: RelayResults): Promise<{
  guest: boolean;
  accounts: number;
  verifications: number;
}> {
  const r = redis();
  let guestSaved = false;
  let accountsSaved = 0;
  let verificationsSaved = 0;

  if (results.guest) {
    if (results.guest.token) {
      const exp = decodeJwtExpiryMs(results.guest.token) ?? Date.now() + 50 * 60_000;
      const ttlS = Math.max(60, Math.floor((exp - Date.now()) / 1000));
      await r.set(KEY_GUEST, JSON.stringify({ token: results.guest.token, expiresAt: exp }), "EX", ttlS);
      await r.del(KEY_GUEST_URGENT, KEY_GUEST_ERROR);
      guestSaved = true;
    } else if (results.guest.error) {
      await r.set(KEY_GUEST_ERROR, results.guest.error.slice(0, 300), "EX", ERROR_TTL_S);
      await r.del(KEY_GUEST_URGENT);
    }
  }

  for (const a of results.accounts ?? []) {
    if (!a?.userId) continue;
    if (a.accessToken) {
      await saveSsgeApiToken(a.userId, a.accessToken).catch((err) =>
        console.warn(`[ss.ge relay] could not save token for ${a.userId}:`, err)
      );
      await r.del(keyUrgent(a.userId), keyError(a.userId));
      accountsSaved++;
    } else {
      const reason = (a.error || "ss.ge login failed").slice(0, 300);
      await r.set(keyError(a.userId), reason, "EX", ERROR_TTL_S);
      await r.del(keyUrgent(a.userId));
      // Stop asking for an account ss.ge rejects; the next real use re-marks it.
      if (/rejected|password|credential|invalid/i.test(reason)) {
        await r.del(keyWant(a.userId));
      }
      console.warn(`[ss.ge relay] login failed for ${a.userId}: ${reason}`);
    }
  }

  for (const v of results.verifications ?? []) {
    if (!v?.id) continue;
    await r.set(
      keyVerifyResult(v.id),
      JSON.stringify({ accessToken: v.accessToken, error: v.error }),
      "EX",
      VERIFY_TTL_S
    );
    verificationsSaved++;
  }

  return { guest: guestSaved, accounts: accountsSaved, verifications: verificationsSaved };
}
