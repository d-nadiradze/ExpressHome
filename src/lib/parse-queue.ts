import { db } from "@/lib/db";
import { parseListing } from "@/lib/myhome-parser";

interface ParseJob {
  listingId: string;
  url: string;
  userId: string;
}

const MAX_CONCURRENT = parseInt(process.env.PARSE_MAX_CONCURRENT || "2", 10);
const queue: ParseJob[] = [];
let running = 0;

export function enqueueParseJob(job: ParseJob) {
  queue.push(job);
  processNext();
}

async function processNext() {
  if (running >= MAX_CONCURRENT || queue.length === 0) return;
  running++;
  const job = queue.shift()!;

  try {
    const result = await parseListing(job.url);

    if (!result.success || !result.data) {
      await db.parsedListing.update({
        where: { id: job.listingId },
        data: { postStatus: "FAILED" },
      });
      return;
    }

    const d = result.data;
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
  } catch (error) {
    console.error(`Parse job failed for listing ${job.listingId}:`, error);
    await db.parsedListing
      .update({
        where: { id: job.listingId },
        data: { postStatus: "FAILED" },
      })
      .catch(() => {});
  } finally {
    running--;
    processNext();
  }
}

export function getQueuePosition(listingId: string): number {
  return queue.findIndex((j) => j.listingId === listingId);
}

export function getQueueStats() {
  return { queued: queue.length, running };
}

/** On startup, mark any stuck PARSING listings as FAILED so they can be retried. */
export async function recoverStuckJobs() {
  try {
    const stuck = await db.parsedListing.updateMany({
      where: { postStatus: "PARSING" },
      data: { postStatus: "FAILED" },
    });
    if (stuck.count > 0) {
      console.log(`Recovered ${stuck.count} stuck PARSING listings → FAILED`);
    }
  } catch (error) {
    console.error("Failed to recover stuck parsing jobs:", error);
  }
}
