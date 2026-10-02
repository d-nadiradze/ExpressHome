/**
 * Pre-uploaded myhome photos.
 *
 * myhome's upload server takes 1–15s per photo, which made it ~95% of a
 * prefill's wall time. So photos are pushed to myhome in the background as
 * soon as a listing is parsed (or its photos change), and the resulting
 * image ids are kept on the listing row. A prefill that finds a cache for
 * the exact photo set it is about to publish skips the upload step entirely.
 *
 * The cache is keyed by the listing's `images` array, so any edit to the
 * photos invalidates it. Cached urls are HEAD-checked right before use in
 * case myhome purged an unattached upload.
 */
import { createHash } from "crypto";
import IORedis from "ioredis";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { decrypt } from "@/lib/encryption";
import {
  getMyhomePreuploadQueue,
  redisConnection,
} from "@/lib/bullmq-queue";
import { resolveImagesForPlaywright } from "@/lib/listing-images";
import {
  loginMyhomeApi,
  uploadListingImages,
  type UploadedImage,
} from "@/lib/myhome-api-prefill";

export interface MyhomeImageCache {
  key: string;
  images: UploadedImage[];
  uploadedAt: string;
}

const LOCK_PREFIX = "myhome:preupload:";
/** Longer than any sane upload run; the lock is only a hint for prefills to wait. */
const LOCK_TTL_S = parseInt(process.env.MYHOME_PREUPLOAD_LOCK_TTL_S || "600", 10);
const HEAD_TIMEOUT_MS = 5000;

export function isMyhomePreuploadEnabled(): boolean {
  return process.env.MYHOME_PREUPLOAD !== "false";
}

/** How long a prefill waits for an in-flight pre-upload before uploading itself. */
export function preuploadWaitMs(): number {
  return parseInt(process.env.MYHOME_PREUPLOAD_WAIT_MS || "120000", 10);
}

export function imageCacheKey(images: unknown): string {
  const list = Array.isArray(images) ? images.map(String) : [];
  return createHash("sha1").update(JSON.stringify(list)).digest("hex");
}

export function parseImageCache(raw: unknown): MyhomeImageCache | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Partial<MyhomeImageCache>;
  if (typeof c.key !== "string" || !Array.isArray(c.images)) return null;
  const images = c.images.filter(
    (i): i is UploadedImage =>
      !!i && typeof i.id === "number" && typeof i.url === "string" && i.url.length > 0
  );
  if (images.length === 0) return null;
  return { key: c.key, images, uploadedAt: String(c.uploadedAt || "") };
}

// ---- Redis lock (lazy singleton per process) ------------------------------

const globalStore = globalThis as unknown as { _preuploadRedis?: IORedis };

function getRedis(): IORedis {
  if (!globalStore._preuploadRedis) {
    globalStore._preuploadRedis = new IORedis({
      ...(redisConnection as object),
      maxRetriesPerRequest: 3,
      commandTimeout: 10_000,
    });
    globalStore._preuploadRedis.on("error", (err: Error) =>
      console.error("[myhome-preupload] Redis error:", err.message)
    );
  }
  return globalStore._preuploadRedis;
}

async function acquireLock(listingId: string, key: string): Promise<boolean> {
  try {
    const r = await getRedis().set(`${LOCK_PREFIX}${listingId}`, key, "EX", LOCK_TTL_S, "NX");
    return r === "OK";
  } catch {
    return true; // Redis trouble must not stop the upload itself.
  }
}

async function releaseLock(listingId: string): Promise<void> {
  await getRedis().del(`${LOCK_PREFIX}${listingId}`).catch(() => undefined);
}

async function lockedKey(listingId: string): Promise<string | null> {
  try {
    return await getRedis().get(`${LOCK_PREFIX}${listingId}`);
  } catch {
    return null;
  }
}

// ---- Enqueue ---------------------------------------------------------------

/**
 * Schedules a pre-upload for the listing's current photo set. Safe to call
 * often: the job id carries the photo-set key, so an identical request while
 * one is already queued is dropped by BullMQ.
 */
export async function enqueueMyhomePreupload(
  listingId: string,
  userId: string,
  images: unknown
): Promise<void> {
  if (!isMyhomePreuploadEnabled()) return;
  if (!Array.isArray(images) || images.length === 0) return;
  const key = imageCacheKey(images);
  try {
    await getMyhomePreuploadQueue().add(
      "preupload",
      { listingId, userId },
      { jobId: `preupload-${listingId}-${key.slice(0, 12)}` }
    );
  } catch (err) {
    console.warn(
      `[myhome-preupload] could not enqueue ${listingId}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// ---- Worker job ------------------------------------------------------------

export async function runMyhomePreuploadJob(listingId: string, userId: string): Promise<void> {
  const listing = await db.parsedListing.findFirst({
    where: { id: listingId, userId },
    select: { images: true, myhomeImageCache: true },
  });
  if (!listing) return;

  const images = Array.isArray(listing.images) ? (listing.images as string[]) : [];
  if (images.length === 0) return;
  const key = imageCacheKey(images);

  const existing = parseImageCache(listing.myhomeImageCache);
  if (existing?.key === key) {
    console.log(`[myhome-preupload] ${listingId}: already cached`);
    return;
  }

  const account = await db.myhomeAccount.findUnique({ where: { userId } });
  if (!account?.isVerified) {
    console.log(`[myhome-preupload] ${listingId}: no linked myhome account — skipped`);
    return;
  }

  if (!(await acquireLock(listingId, key))) {
    console.log(`[myhome-preupload] ${listingId}: another pre-upload is running — skipped`);
    return;
  }

  const started = Date.now();
  try {
    const auth = await loginMyhomeApi({
      email: account.myhomeEmail,
      password: decrypt(account.myhomePassword),
    });
    if (!auth.success || !auth.session) {
      throw new Error(auth.error || "myhome login failed");
    }

    const { paths, cleanup } = await resolveImagesForPlaywright(images, listingId, userId);
    let uploaded: UploadedImage[];
    try {
      uploaded = await uploadListingImages(paths, auth.session);
    } finally {
      await cleanup();
    }

    // A partial set would publish a listing missing photos; only a full set counts.
    if (uploaded.length === 0 || uploaded.length < Math.min(paths.length, images.length)) {
      throw new Error(`uploaded ${uploaded.length}/${images.length} photo(s)`);
    }

    // The photo set may have changed while uploading; never cache a stale set.
    const fresh = await db.parsedListing.findUnique({
      where: { id: listingId },
      select: { images: true },
    });
    if (!fresh || imageCacheKey(fresh.images) !== key) {
      console.log(`[myhome-preupload] ${listingId}: photos changed mid-upload — discarded`);
      return;
    }

    const cache: MyhomeImageCache = {
      key,
      images: uploaded,
      uploadedAt: new Date().toISOString(),
    };
    await db.parsedListing.update({
      where: { id: listingId },
      data: { myhomeImageCache: cache as unknown as Prisma.InputJsonValue },
    });
    console.log(
      `[myhome-preupload] ${listingId}: ${uploaded.length} photo(s) ready in ${Date.now() - started}ms`
    );
  } finally {
    await releaseLock(listingId);
  }
}

// ---- Prefill side ----------------------------------------------------------

async function urlExists(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "HEAD",
      signal: AbortSignal.timeout(HEAD_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function cacheMatching(listingId: string, key: string): Promise<MyhomeImageCache | null> {
  const row = await db.parsedListing.findUnique({
    where: { id: listingId },
    select: { myhomeImageCache: true },
  });
  const cache = parseImageCache(row?.myhomeImageCache);
  return cache?.key === key ? cache : null;
}

/**
 * Photos already on myhome for exactly this image set, or null if the prefill
 * has to upload them itself. Waits for a pre-upload that is mid-flight, since
 * finishing one is faster than starting another.
 */
export async function resolvePreuploadedImages(
  listingId: string,
  images: string[],
  log: (message: string) => void = () => undefined
): Promise<UploadedImage[] | null> {
  if (!isMyhomePreuploadEnabled() || images.length === 0) return null;
  const key = imageCacheKey(images);

  let cache = await cacheMatching(listingId, key);

  if (!cache && (await lockedKey(listingId)) === key) {
    const deadline = Date.now() + preuploadWaitMs();
    log("Photos are still being pre-uploaded to myhome — waiting for them");
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
      cache = await cacheMatching(listingId, key);
      if (cache) break;
      if ((await lockedKey(listingId)) !== key) break;
    }
  }

  if (!cache) return null;

  const checks = await Promise.all(cache.images.map((img) => urlExists(img.url)));
  if (checks.every(Boolean)) return cache.images;

  log("Pre-uploaded photos are no longer on myhome — uploading again");
  await db.parsedListing
    .update({ where: { id: listingId }, data: { myhomeImageCache: Prisma.DbNull } })
    .catch(() => undefined);
  return null;
}
