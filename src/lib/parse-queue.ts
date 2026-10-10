/**
 * Parse queue.
 *
 * Every listing parse (ss.ge and myhome.ge) is a BullMQ job handled by the
 * worker. myhome used to run in-process in the web container because it was
 * a single ~400 ms API call; since the tnet API closed to anonymous clients
 * the fallback is the Cloudflare-protected listing page, which may need the
 * worker's headless Chromium (and its memory budget).
 */
import { getParseQueue } from "@/lib/bullmq-queue";

interface ParseJob {
  listingId: string;
  url: string;
  userId: string;
}

/** myhome masks phone numbers for anonymous callers ("579550***") — drop those. */
export function stripMaskedPhone(data: {
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
  void getParseQueue().add(job.listingId, {
    listingId: job.listingId,
    url: job.url,
    userId: job.userId,
  });
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
