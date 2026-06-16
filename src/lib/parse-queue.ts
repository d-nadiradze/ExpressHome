/**
 * Parse queue.
 *
 * ss.ge  → BullMQ worker (plain HTTP fetch, ~2s, non-blocking)
 * myhome → in-process background task (Playwright, same speed as before refactor)
 *
 * The worker (src/worker/prefill-worker.ts) still handles ss.ge parse jobs
 * and all prefill jobs.
 */
import { getParseQueue } from "@/lib/bullmq-queue";
import { isValidSsgeUrl } from "@/lib/utils";

interface ParseJob {
  listingId: string;
  url: string;
  userId: string;
}

export function enqueueParseJob(job: ParseJob): void {
  if (isValidSsgeUrl(job.url)) {
    // ss.ge: fast HTTP fetch in the worker, no browser needed
    void getParseQueue().add(job.listingId, {
      listingId: job.listingId,
      url: job.url,
      userId: job.userId,
    });
  } else {
    // myhome.ge: run Playwright in-process (background) — same speed as before
    void runMyhomeParseInProcess(job);
  }
}

async function runMyhomeParseInProcess(job: ParseJob): Promise<void> {
  try {
    const { parseListing, revealMyhomeSellerPhone, isMaskedPhone } = await import(
      "@/lib/myhome-parser"
    );
    const { parseMyhomeViaApi } = await import("@/lib/myhome-api-parser");
    const { db } = await import("@/lib/db");

    // Try the fast API first (~400ms), fall back to Playwright (~15-20s)
    const result = await parseMyhomeViaApi(job.url, parseListing);

    if (!result.success || !result.data) {
      await db.parsedListing.update({
        where: { id: job.listingId },
        data: { postStatus: "FAILED" },
      });
      return;
    }

    const d = result.data;

    // The fast API only returns a masked seller number ("591645***"). The exact
    // number requires the browser reveal (reCAPTCHA-gated), so do it here when
    // what we have is still masked. The Playwright path already captures it.
    const currentPhone = d.rawData?.["ნომერი"] ?? d.mobileNumber ?? "";
    if (!currentPhone || isMaskedPhone(currentPhone)) {
      const exact = await revealMyhomeSellerPhone(job.url).catch(() => "");
      if (exact) {
        d.mobileNumber = exact;
        if (!d.rawData) d.rawData = {};
        d.rawData["ნომერი"] = exact;
        console.log(`[parse] myhome exact seller phone revealed: ${exact}`);
      } else if (currentPhone && isMaskedPhone(currentPhone)) {
        // Reveal failed — don't persist a masked number.
        delete d.rawData?.["ნომერი"];
        d.mobileNumber = "";
      }
    }
    await db.parsedListing.update({
      where: { id: job.listingId },
      data: {
        title: d.title,
        propertyType: d.propertyType,
        dealType: d.dealType,
        buildingStatus: d.buildingStatus,
        condition: d.condition,
        city: d.city,
        address: d.address,
        street: d.street,
        streetNumber: d.streetNumber,
        cadastralCode: d.cadastralCode,
        price: d.price,
        pricePerSqm: d.pricePerSqm,
        currency: d.currency,
        area: d.area,
        rooms: d.rooms,
        bedrooms: d.bedrooms,
        floor: d.floor,
        totalFloors: d.totalFloors,
        projectType: d.projectType,
        bathrooms: d.bathrooms,
        balconyArea: d.balconyArea,
        verandaArea: d.verandaArea,
        loggiaArea: d.loggiaArea,
        description: d.description,
        images: d.images,
        rawData: d.rawData,
        postStatus: "PENDING",
      },
    });
    console.log(`[parse] myhome OK: ${job.listingId} — "${d.title}"`);
  } catch (err) {
    console.error(`[parse] myhome failed for ${job.listingId}:`, err);
    try {
      const { db } = await import("@/lib/db");
      await db.parsedListing.update({
        where: { id: job.listingId },
        data: { postStatus: "FAILED" },
      });
    } catch {}
  }
}

/** Position is approximate — BullMQ queue position, 0-indexed from front. */
export async function getQueuePositionAsync(listingId: string): Promise<number> {
  try {
    const waiting = await getParseQueue().getWaiting();
    return waiting.findIndex((j) => j.data.listingId === listingId);
  } catch {
    return -1;
  }
}

/** Sync stub kept for API route compatibility — returns -1 (position unknown). */
export function getQueuePosition(_listingId: string): number {
  return -1;
}

export function getQueueStats() {
  return { queued: 0, running: 0 };
}

export async function recoverStuckJobs(): Promise<void> {}
