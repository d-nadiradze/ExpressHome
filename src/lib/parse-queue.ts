/**
 * Parse queue.
 *
 * ss.ge  → BullMQ worker (HTTP fetch via ssge-fetch-parser)
 * myhome → in-process background task (tnet API via myhome-api-parser)
 *
 * The worker handles ss.ge parse jobs and all prefill jobs.
 */
import { getParseQueue } from "@/lib/bullmq-queue";
import { isValidSsgeUrl } from "@/lib/utils";

interface ParseJob {
  listingId: string;
  url: string;
  userId: string;
}

function stripMaskedPhone(data: {
  mobileNumber?: string;
  rawData?: Record<string, string>;
}): void {
  const phone = data.rawData?.["ნომერი"] ?? data.mobileNumber ?? "";
  if (phone.includes("*")) {
    delete data.rawData?.["ნომერი"];
    data.mobileNumber = "";
  }
}

export function enqueueParseJob(job: ParseJob): void {
  if (isValidSsgeUrl(job.url)) {
    void getParseQueue().add(job.listingId, {
      listingId: job.listingId,
      url: job.url,
      userId: job.userId,
    });
  } else {
    void runMyhomeParseInProcess(job);
  }
}

async function runMyhomeParseInProcess(job: ParseJob): Promise<void> {
  try {
    const { parseMyhomeViaApi } = await import("@/lib/myhome-api-parser");
    const { db } = await import("@/lib/db");

    const result = await parseMyhomeViaApi(job.url);

    if (!result.success || !result.data) {
      console.warn(`[parse] myhome failed for ${job.listingId}: ${result.error ?? "unknown error"}`);
      await db.parsedListing.update({
        where: { id: job.listingId },
        data: { postStatus: "FAILED" },
      });
      return;
    }

    const d = result.data;
    stripMaskedPhone(d);

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
