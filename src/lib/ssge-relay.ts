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
 * Relay clients (`src/relay/client.ts`) run on ordinary residential
 * connections, poll `GET /api/internal/ssge-relay` for work, mint the tokens
 * there over plain HTTP (no browser, ~3 s each) and POST them back. Two kinds:
 *
 *   admin  — authenticates with SSGE_RELAY_SECRET itself; may mint for every
 *            linked account (receives decrypted ss.ge passwords).
 *   user   — one per staff PC, authenticates with a per-user token derived
 *            from the secret (`mintUserRelayToken`); mints the shared guest
 *            token and its *own* account token only, so no PC ever sees
 *            another user's password. As long as any one PC is on, parsing
 *            works; a user's own PC being on is what keeps their publishing
 *            working.
 *
 * Work items are claimed in Redis so several online relays do not all mint
 * the same token. Shared state lives in Redis (Next app + worker) and in the
 * existing per-account token cache in MySQL (`SsgeAccount.accessToken`).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
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
const KEY_HEARTBEAT = `${PREFIX}heartbeat`; // any relay
const KEY_LAST_SEEN = `${PREFIX}last-seen`; // any relay, persistent
const KEY_GUEST = `${PREFIX}guest`;
const KEY_GUEST_URGENT = `${PREFIX}guest-urgent`;
const KEY_GUEST_ERROR = `${PREFIX}guest-error`;
const KEY_WAKE = `${PREFIX}wake`;
const keyHb = (relayId: string) => `${PREFIX}hb:${relayId}`;
const keyLastSeen = (relayId: string) => `${PREFIX}seen:${relayId}`;
const keyWant = (userId: string) => `${PREFIX}want:${userId}`;
const keyUrgent = (userId: string) => `${PREFIX}urgent:${userId}`;
const keyError = (userId: string) => `${PREFIX}error:${userId}`;
const keyVerify = (id: string) => `${PREFIX}verify:${id}`;
const keyVerifyResult = (id: string) => `${PREFIX}verify-result:${id}`;
const keyPageWant = (id: string) => `${PREFIX}page-want:${id}`;
const keyPageResult = (id: string) => `${PREFIX}page-result:${id}`;
const keyApiWant = (id: string) => `${PREFIX}api-want:${id}`;
const keyApiResult = (id: string) => `${PREFIX}api-result:${id}`;
const keyClaim = (item: string) => `${PREFIX}claim:${item}`;

export const ADMIN_RELAY_ID = "admin";

/** Relay counts as online if it polled within this window. */
const HEARTBEAT_TTL_S = parseInt(process.env.SSGE_RELAY_HEARTBEAT_TTL_S || "180", 10);
/** Accounts stay on the keep-warm list this long after their last use. */
const KEEP_WARM_MS = parseInt(process.env.SSGE_RELAY_KEEP_WARM_MS || String(24 * 3600_000), 10);
/** Refresh a token this far before it expires. */
const REFRESH_AHEAD_MS = parseInt(process.env.SSGE_RELAY_REFRESH_AHEAD_MS || "900000", 10);
/** How long a job waits for the relay to deliver a token it asked for. */
const WAIT_MS = parseInt(process.env.SSGE_RELAY_WAIT_MS || "60000", 10);
const WAIT_POLL_MS = 2000;
/** How often a prefill waits for the relay result. Kept short — the relay is already on the call. */
const API_RESULT_POLL_MS = 200;
const URGENT_TTL_S = 180;
const ERROR_TTL_S = 600;
const VERIFY_TTL_S = 180;
const PAGE_TTL_S = 120;
const PAGE_HTML_MAX_CHARS = 1_000_000;
const API_TTL_S = 180;
const API_WAIT_MS = parseInt(process.env.SSGE_RELAY_API_WAIT_MS || "120000", 10);
const API_BODY_MAX_CHARS = 8_000_000;
const API_RESULT_MAX_CHARS = 2_000_000;
const API_CLAIM_TTL_S = 180;
/** A claimed work item is left to its relay this long before another may take it. */
const CLAIM_TTL_S = parseInt(process.env.SSGE_RELAY_CLAIM_TTL_S || "60", 10);
/** Guest mint failed because ss.ge no longer embeds the token — don't hammer. */
const GUEST_STRUCTURAL_ERROR_TTL_S = 1800;
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

export interface RelayPageWork {
  id: string;
  url: string;
}

export interface RelayApiWork {
  id: string;
  method: string;
  path: string;
  body?: string;
  contentType?: string;
  authorization: string;
}

export interface RelayWork {
  /** Which relay the server thinks is asking (echo for client logs). */
  relay: { id: string; kind: RelayKind };
  guest: { needed: boolean; urgent: boolean };
  accounts: RelayAccountWork[];
  verifications: RelayVerifyWork[];
  /** Listing/search pages the server cannot fetch (403 from the VPS). */
  pages: RelayPageWork[];
  /** api-gateway calls Cloudflare blocks from the server IP. */
  api: RelayApiWork[];
  /** Suggested poll interval for the client (ms). */
  pollMs: number;
}

export interface RelayResults {
  guest?: { token?: string; error?: string };
  accounts?: Array<{ userId: string; accessToken?: string; error?: string }>;
  verifications?: Array<{ id: string; accessToken?: string; error?: string }>;
  pages?: Array<{ id: string; html?: string; error?: string }>;
  api?: Array<{ id: string; status?: number; body?: string; contentType?: string; error?: string }>;
}

export type RelayKind = "admin" | "user";

export interface RelayIdentity {
  kind: RelayKind;
  /** "admin" or the userId. */
  id: string;
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

/** Bump so relays sitting in a long-poll GET wake within a couple of hundred milliseconds. */
export async function signalRelayWake(): Promise<void> {
  try {
    await redis().incr(KEY_WAKE);
  } catch {
    /* a relay will notice on its next poll anyway */
  }
}

export async function readRelayWake(): Promise<string> {
  try {
    return (await redis().get(KEY_WAKE)) ?? "0";
  } catch {
    return "0";
  }
}

// ---- Configuration / auth ------------------------------------------------------

function secret(): string {
  return process.env.SSGE_RELAY_SECRET?.trim() ?? "";
}

export function isRelayConfigured(): boolean {
  return secret().length > 0;
}

/**
 * When a relay is configured, the server-side fetch → curl → Chromium chain
 * for ss.ge is pointless (Turnstile-blocked) and harmful: it holds the single
 * Chromium slot for 30-45 s per attempt, which stalls myhome parses that need
 * the browser for *their* challenge page. So it is off unless asked for.
 */
export function isRelayLocalFallbackEnabled(): boolean {
  return process.env.SSGE_RELAY_LOCAL_FALLBACK === "true";
}

/** True when ss.ge token minting must go through a relay (never locally). */
export function relayRequired(): boolean {
  return isRelayConfigured() && !isRelayLocalFallbackEnabled();
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function userTokenSignature(userId: string): string {
  return createHmac("sha256", secret()).update(`relay:user:${userId}`).digest("hex");
}

/**
 * Per-user relay token: `u.<userId>.<hmac>`. Derived from the server secret,
 * so nothing is stored; rotating SSGE_RELAY_SECRET invalidates every token.
 */
export function mintUserRelayToken(userId: string): string {
  if (!isRelayConfigured()) throw new Error("SSGE_RELAY_SECRET is not set");
  return `u.${userId}.${userTokenSignature(userId)}`;
}

/** Constant-time check of the admin secret (kept for the unit test). */
export function isValidRelaySecret(header: string | null): boolean {
  const expected = secret();
  if (!expected || !header) return false;
  return safeEqual(header.replace(/^Bearer\s+/i, "").trim(), expected);
}

/**
 * Identify the relay behind an Authorization header. Admin = the raw secret;
 * user = a token from `mintUserRelayToken` for an active user. Null = reject.
 */
export async function authenticateRelay(header: string | null): Promise<RelayIdentity | null> {
  if (!isRelayConfigured() || !header) return null;
  const presented = header.replace(/^Bearer\s+/i, "").trim();
  if (!presented) return null;
  if (isValidRelaySecret(presented)) return { kind: "admin", id: ADMIN_RELAY_ID };

  const parts = presented.split(".");
  if (parts.length !== 3 || parts[0] !== "u") return null;
  const [, userId, sig] = parts;
  if (!/^[a-z0-9]{10,40}$/i.test(userId)) return null;
  if (!safeEqual(sig, userTokenSignature(userId))) return null;
  const user = await db.user.findUnique({ where: { id: userId }, select: { isActive: true } });
  if (!user?.isActive) return null;
  return { kind: "user", id: userId };
}

// ---- Liveness ---------------------------------------------------------------

async function keyExists(key: string): Promise<boolean> {
  try {
    return (await redis().exists(key)) === 1;
  } catch {
    return false;
  }
}

/** Some relay (any kind) polled recently — enough for the shared guest token. */
export async function isAnyRelayAlive(): Promise<boolean> {
  if (!isRelayConfigured()) return false;
  return keyExists(KEY_HEARTBEAT);
}

/** @deprecated use isAnyRelayAlive */
export const isRelayAlive = isAnyRelayAlive;

export async function isAdminRelayAlive(): Promise<boolean> {
  if (!isRelayConfigured()) return false;
  return keyExists(keyHb(ADMIN_RELAY_ID));
}

export async function isUserRelayAlive(userId: string): Promise<boolean> {
  if (!isRelayConfigured()) return false;
  return keyExists(keyHb(userId));
}

/** Can some online relay mint an account token for this user right now? */
export async function canRelayMintForUser(userId: string): Promise<boolean> {
  if (!isRelayConfigured()) return false;
  return (await isAdminRelayAlive()) || (await isUserRelayAlive(userId));
}

async function readTimestamp(key: string): Promise<Date | null> {
  try {
    const v = await redis().get(key);
    return v ? new Date(parseInt(v, 10)) : null;
  } catch {
    return null;
  }
}

/** When any relay last checked in, or null. */
export async function relayLastSeen(): Promise<Date | null> {
  return (await readTimestamp(KEY_HEARTBEAT)) ?? readTimestamp(KEY_LAST_SEEN);
}

export async function onlineRelayIds(): Promise<string[]> {
  if (!isRelayConfigured()) return [];
  try {
    const keys = await scanKeys(`${PREFIX}hb:*`);
    return keys.map((k) => k.slice(`${PREFIX}hb:`.length));
  } catch {
    return [];
  }
}

export interface RelayStatus {
  configured: boolean;
  anyOnline: boolean;
  adminOnline: boolean;
  onlineCount: number;
  mine: { online: boolean; lastSeen: string | null };
  /** Whether this user's account token can be minted right now. */
  canMintForMe: boolean;
}

export async function relayStatusForUser(userId: string): Promise<RelayStatus> {
  if (!isRelayConfigured()) {
    return {
      configured: false,
      anyOnline: false,
      adminOnline: false,
      onlineCount: 0,
      mine: { online: false, lastSeen: null },
      canMintForMe: false,
    };
  }
  const ids = await onlineRelayIds();
  const mineOnline = ids.includes(userId);
  const adminOnline = ids.includes(ADMIN_RELAY_ID);
  const seen = await readTimestamp(keyLastSeen(userId));
  return {
    configured: true,
    anyOnline: ids.length > 0 || (await isAnyRelayAlive()),
    adminOnline,
    onlineCount: ids.length,
    mine: { online: mineOnline, lastSeen: seen?.toISOString() ?? null },
    canMintForMe: mineOnline || adminOnline,
  };
}

/**
 * One-line, actionable explanation for error messages when a relay is
 * configured but nothing suitable is online. Null when fine / unconfigured.
 * With `userId`, "suitable" means a relay that can mint that user's token.
 */
export async function relayOfflineNote(userId?: string): Promise<string | null> {
  if (!isRelayConfigured()) return null;
  if (userId) {
    if (await canRelayMintForUser(userId)) return null;
    const seen = await readTimestamp(keyLastSeen(userId));
    const since = seen ? `your relay was last online ${formatAgo(Date.now() - seen.getTime())} ago` : "your relay has never connected";
    return `ss.ge relay is OFFLINE for this account (${since}) — turn on the PC that runs the ExpressHome relay, or install it from Settings → Platform accounts → ss.ge`;
  }
  if (await isAnyRelayAlive()) return null;
  const seen = await relayLastSeen();
  const since = seen ? `last seen ${formatAgo(Date.now() - seen.getTime())} ago` : "never seen";
  return `no ss.ge relay is online (${since}) — ss.ge needs at least one PC with the ExpressHome relay running (Settings → Platform accounts → ss.ge)`;
}

function formatAgo(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d`;
}

/** Only home.ss.ge listing pages — the relay is not a general-purpose proxy. */
export function isAllowedSsgePageUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    return host === "home.ss.ge" || host === "www.home.ss.ge" || host === "ss.ge" || host === "www.ss.ge";
  } catch {
    return false;
  }
}

/**
 * Ask an online relay to GET a listing page the VPS cannot (Cloudflare 403)
 * and wait for the HTML. Returns null on timeout / no relay. Throws if a
 * relay fetched the URL and ss.ge answered with an error.
 */
export async function requestRelayListingHtml(url: string): Promise<string | null> {
  if (!isRelayConfigured() || !isAllowedSsgePageUrl(url)) return null;
  if (!(await isAnyRelayAlive())) return null;
  const r = redis();
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  await r.set(keyPageWant(id), JSON.stringify({ url }), "EX", PAGE_TTL_S);
  await signalRelayWake();
  const deadline = Date.now() + WAIT_MS;
  try {
    while (Date.now() < deadline) {
      await sleep(API_RESULT_POLL_MS);
      const raw = await r.get(keyPageResult(id));
      if (!raw) continue;
      const result = JSON.parse(raw) as { html?: string; error?: string };
      if (result.html) return result.html;
      throw new Error(result.error || "ss.ge relay could not fetch the listing page");
    }
    return null;
  } finally {
    await r.del(keyPageWant(id), keyPageResult(id), keyClaim(`page:${id}`)).catch(() => null);
  }
}

/** Path + query only, on api-gateway.ss.ge/v1. No other host, no traversal. */
export function isAllowedSsgeApiPath(path: string): boolean {
  if (!path.startsWith("/") || path.startsWith("//")) return false;
  if (path.includes("..") || path.includes("\\") || path.length > 500) return false;
  return /^\/[A-Za-z0-9_./?&=%+\-]+$/.test(path);
}

export interface RelayApiResult {
  status: number;
  body: string;
  contentType: string | null;
}

/**
 * Run one api-gateway call from a residential relay. Cloudflare now challenges
 * api-gateway.ss.ge from the server IP (create-draft, search, details), so the
 * bearer is useless until the request leaves a home/office connection.
 * Only `userId`'s own relay (or the admin relay) is given the bearer.
 */
export async function requestRelayApiCall(opts: {
  userId: string;
  method: string;
  path: string;
  body?: string;
  contentType?: string;
  authorization: string;
}): Promise<RelayApiResult> {
  if (!isRelayConfigured()) throw new Error("ss.ge relay is not configured");
  if (!isAllowedSsgeApiPath(opts.path)) throw new Error("refused ss.ge API path");
  const method = opts.method.toUpperCase();
  if (!["GET", "POST", "PUT", "DELETE", "PATCH"].includes(method)) {
    throw new Error("refused ss.ge API method");
  }
  if ((opts.body?.length ?? 0) > API_BODY_MAX_CHARS) {
    throw new Error("ss.ge API body is too large to send through the relay");
  }
  if (!(await canRelayMintForUser(opts.userId))) {
    throw new Error((await relayOfflineNote(opts.userId)) ?? "ss.ge relay is offline");
  }
  const r = redis();
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  await r.set(
    keyApiWant(id),
    JSON.stringify({
      userId: opts.userId,
      method,
      path: opts.path,
      body: opts.body ?? null,
      contentType: opts.contentType ?? "application/json",
      authorization: opts.authorization,
    }),
    "EX",
    API_TTL_S
  );
  await signalRelayWake();
  const deadline = Date.now() + API_WAIT_MS;
  try {
    while (Date.now() < deadline) {
      await sleep(API_RESULT_POLL_MS);
      const raw = await r.get(keyApiResult(id));
      if (!raw) continue;
      const result = JSON.parse(raw) as {
        status?: number;
        body?: string;
        contentType?: string | null;
        error?: string;
      };
      if (result.error && !result.status) throw new Error(result.error);
      return {
        status: result.status || 502,
        body: result.body ?? "",
        contentType: result.contentType ?? null,
      };
    }
    throw new Error(
      "ss.ge relay did not finish the API call in time — wait a minute (the office relay updates itself) and try again"
    );
  } finally {
    await r.del(keyApiWant(id), keyApiResult(id), keyClaim(`api:${id}`)).catch(() => null);
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
 * Ask the relays for a guest token and wait for it. Returns null on timeout.
 * Throws if a relay reported a hard failure for the guest page.
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

/** Remember that this account is in use so the relays keep its token fresh. */
export async function markAccountWanted(userId: string): Promise<void> {
  try {
    await redis().set(keyWant(userId), "1", "PX", KEEP_WARM_MS);
  } catch {
    /* best effort */
  }
}

/**
 * Ask for a fresh token for `userId` and wait for it to land in the
 * per-account cache. Returns null on timeout. Throws if a relay reported
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
 * Hand a not-yet-saved email/password to a relay for a real ss.ge login.
 * Only the admin relay or `userId`'s own relay will be offered it.
 * Resolves with the access token on success; throws with ss.ge's reason on
 * rejection; returns null if no relay answered in time.
 */
export async function verifyCredentialsViaRelay(
  email: string,
  password: string,
  userId: string
): Promise<string | null> {
  const r = redis();
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  await r.set(keyVerify(id), JSON.stringify({ email, password, userId }), "EX", VERIFY_TTL_S);
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
    await r.del(keyVerify(id), keyVerifyResult(id), keyClaim(`verify:${id}`)).catch(() => null);
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

/** Take `item` for `relayId` unless another relay holds it (claims expire). */
async function claim(item: string, relayId: string, ttlS = CLAIM_TTL_S): Promise<boolean> {
  const r = redis();
  const key = keyClaim(item);
  const ok = await r.set(key, relayId, "EX", ttlS, "NX");
  if (ok) return true;
  return (await r.get(key)) === relayId;
}

async function releaseClaim(item: string): Promise<void> {
  await redis().del(keyClaim(item)).catch(() => null);
}

export async function pullRelayWork(identity: RelayIdentity): Promise<RelayWork> {
  const r = redis();
  const now = String(Date.now());
  await r.set(KEY_HEARTBEAT, now, "EX", HEARTBEAT_TTL_S);
  await r.set(KEY_LAST_SEEN, now); // persists after the heartbeat expires, for "offline since"
  await r.set(keyHb(identity.id), now, "EX", HEARTBEAT_TTL_S);
  await r.set(keyLastSeen(identity.id), now);

  // Guest token: any relay keeps one warm; urgent if someone is waiting.
  // ss.ge stopped embedding credentialsToken in SSR (Oct 2026); after a
  // structural miss, skip minting until TTL unless a job is actually waiting.
  const guest = await getRelayGuestToken();
  const guestUrgent = (await r.exists(KEY_GUEST_URGENT)) === 1;
  const guestError = await r.get(KEY_GUEST_ERROR);
  let guestNeeded =
    (guestUrgent || !guest || guest.expiresAt - REFRESH_AHEAD_MS <= Date.now()) &&
    (guestUrgent || !guestError);
  if (guestNeeded && !(await claim("guest", identity.id))) guestNeeded = false;

  // Accounts. Admin: every wanted/urgent account. User: only itself — and
  // always, so its token is warm whenever its PC is on (one login per hour).
  const urgentKeys = await scanKeys(`${PREFIX}urgent:*`);
  const urgentIds = new Set(urgentKeys.map((k) => k.slice(`${PREFIX}urgent:`.length)));
  const candidateIds = new Set<string>();
  if (identity.kind === "admin") {
    for (const k of await scanKeys(`${PREFIX}want:*`)) candidateIds.add(k.slice(`${PREFIX}want:`.length));
    for (const id of urgentIds) candidateIds.add(id);
  } else {
    candidateIds.add(identity.id);
  }

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
      // The user's own relay is the natural owner of its token; admin takes
      // it only when that relay is offline, so claims rarely even collide.
      if (identity.kind === "admin" && (await isUserRelayAlive(row.userId)) && !urgent) continue;
      if (!(await claim(`acct:${row.userId}`, identity.id))) continue;
      let password: string;
      try {
        password = decrypt(row.ssgePassword);
      } catch {
        await releaseClaim(`acct:${row.userId}`);
        continue;
      }
      if (!password) {
        await releaseClaim(`acct:${row.userId}`);
        continue;
      }
      accounts.push({ userId: row.userId, email: row.ssgeEmail, password, urgent, expiresAt });
    }
    accounts.sort((a, b) => Number(b.urgent) - Number(a.urgent));
  }

  // Credential checks: admin sees all, a user relay only its own user's.
  const verifications: RelayVerifyWork[] = [];
  for (const k of await scanKeys(`${PREFIX}verify:*`)) {
    const id = k.slice(`${PREFIX}verify:`.length);
    if ((await r.exists(keyVerifyResult(id))) === 1) continue;
    const raw = await r.get(k);
    if (!raw) continue;
    try {
      const { email, password, userId } = JSON.parse(raw) as {
        email: string;
        password: string;
        userId?: string;
      };
      if (identity.kind === "user" && userId !== identity.id) continue;
      if (!(await claim(`verify:${id}`, identity.id))) continue;
      verifications.push({ id, email, password });
    } catch {
      /* skip malformed */
    }
  }

  const pages: RelayPageWork[] = [];
  for (const k of await scanKeys(`${PREFIX}page-want:*`)) {
    const id = k.slice(`${PREFIX}page-want:`.length);
    if ((await r.exists(keyPageResult(id))) === 1) continue;
    const raw = await r.get(k);
    if (!raw) continue;
    try {
      const { url } = JSON.parse(raw) as { url?: string };
      if (!url || !isAllowedSsgePageUrl(url)) continue;
      if (!(await claim(`page:${id}`, identity.id))) continue;
      pages.push({ id, url });
    } catch {
      /* skip malformed */
    }
  }

  const api: RelayApiWork[] = [];
  for (const k of await scanKeys(`${PREFIX}api-want:*`)) {
    if (api.length >= 4) break;
    const id = k.slice(`${PREFIX}api-want:`.length);
    if ((await r.exists(keyApiResult(id))) === 1) continue;
    const raw = await r.get(k);
    if (!raw) continue;
    try {
      const job = JSON.parse(raw) as {
        userId?: string;
        method?: string;
        path?: string;
        body?: string | null;
        contentType?: string;
        authorization?: string;
      };
      if (!job.userId || !job.path || !job.method || !job.authorization) continue;
      if (!isAllowedSsgeApiPath(job.path)) continue;
      if (identity.kind === "user" && job.userId !== identity.id) continue;
      if (!(await claim(`api:${id}`, identity.id, API_CLAIM_TTL_S))) continue;
      api.push({
        id,
        method: job.method,
        path: job.path,
        body: job.body ?? undefined,
        contentType: job.contentType,
        authorization: job.authorization,
      });
    } catch {
      /* skip malformed */
    }
  }

  return {
    relay: { id: identity.id, kind: identity.kind },
    guest: { needed: guestNeeded, urgent: guestUrgent },
    accounts,
    verifications,
    pages,
    api,
    // Idle polls are one small GET against our own server; keep them frequent
    // so a cold account's first publish waits seconds, not a quarter minute.
    // The GET itself long-polls while idle, so the client should come straight back.
    pollMs: 200,
  };
}

export async function pushRelayResults(
  identity: RelayIdentity,
  results: RelayResults
): Promise<{ guest: boolean; accounts: number; verifications: number; pages: number; api: number }> {
  const r = redis();
  let guestSaved = false;
  let accountsSaved = 0;
  let verificationsSaved = 0;
  let pagesSaved = 0;
  let apiSaved = 0;

  if (results.guest) {
    if (results.guest.token) {
      const exp = decodeJwtExpiryMs(results.guest.token) ?? Date.now() + 50 * 60_000;
      const ttlS = Math.max(60, Math.floor((exp - Date.now()) / 1000));
      await r.set(KEY_GUEST, JSON.stringify({ token: results.guest.token, expiresAt: exp }), "EX", ttlS);
      await r.del(KEY_GUEST_URGENT, KEY_GUEST_ERROR);
      guestSaved = true;
    } else if (results.guest.error) {
      const structural = /credentialsToken not in page|no longer embeds/i.test(results.guest.error);
      await r.set(
        KEY_GUEST_ERROR,
        results.guest.error.slice(0, 300),
        "EX",
        structural ? GUEST_STRUCTURAL_ERROR_TTL_S : ERROR_TTL_S
      );
      await r.del(KEY_GUEST_URGENT);
    }
    await releaseClaim("guest");
  }

  for (const a of results.accounts ?? []) {
    if (!a?.userId) continue;
    // A user relay may only ever report its own account.
    if (identity.kind === "user" && a.userId !== identity.id) continue;
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
      console.warn(`[ss.ge relay] login failed for ${a.userId} (via ${identity.id}): ${reason}`);
    }
    await releaseClaim(`acct:${a.userId}`);
  }

  for (const v of results.verifications ?? []) {
    if (!v?.id) continue;
    if (identity.kind === "user") {
      // Only the requesting user's relay may answer its verification.
      const raw = await r.get(keyVerify(v.id));
      const owner = raw ? (JSON.parse(raw) as { userId?: string }).userId : undefined;
      if (owner !== identity.id) continue;
    }
    await r.set(
      keyVerifyResult(v.id),
      JSON.stringify({ accessToken: v.accessToken, error: v.error }),
      "EX",
      VERIFY_TTL_S
    );
    await releaseClaim(`verify:${v.id}`);
    verificationsSaved++;
  }

  for (const p of results.pages ?? []) {
    if (!p?.id) continue;
    const html =
      typeof p.html === "string" && p.html.length > PAGE_HTML_MAX_CHARS
        ? p.html.slice(0, PAGE_HTML_MAX_CHARS)
        : p.html;
    await r.set(
      keyPageResult(p.id),
      JSON.stringify({ html, error: p.error }),
      "EX",
      PAGE_TTL_S
    );
    await releaseClaim(`page:${p.id}`);
    pagesSaved++;
  }

  for (const call of results.api ?? []) {
    if (!call?.id) continue;
    if (identity.kind === "user") {
      const raw = await r.get(keyApiWant(call.id));
      const owner = raw ? (JSON.parse(raw) as { userId?: string }).userId : undefined;
      if (owner !== identity.id) continue;
    }
    const body =
      typeof call.body === "string" && call.body.length > API_RESULT_MAX_CHARS
        ? call.body.slice(0, API_RESULT_MAX_CHARS)
        : (call.body ?? "");
    await r.set(
      keyApiResult(call.id),
      JSON.stringify({
        status: call.status ?? 0,
        body,
        contentType: call.contentType ?? null,
        error: call.error,
      }),
      "EX",
      API_TTL_S
    );
    await releaseClaim(`api:${call.id}`);
    apiSaved++;
  }

  return {
    guest: guestSaved,
    accounts: accountsSaved,
    verifications: verificationsSaved,
    pages: pagesSaved,
    api: apiSaved,
  };
}
