import { db } from "@/lib/db";
import { decrypt } from "@/lib/encryption";
import { createMyhomePost } from "@/lib/myhome-parser";
import { createSsgePost } from "@/lib/ssge-parser";
import { enqueuePrefill } from "@/lib/prefill-queue";
import {
  completePrefillJob,
  createPrefillReporter,
  failPrefillJob,
  markPrefillRunning,
} from "@/lib/prefill-progress";

function listingPayload(listing: {
  title: string | null;
  propertyType: string | null;
  dealType: string | null;
  buildingStatus: string | null;
  condition: string | null;
  city: string | null;
  address: string | null;
  street: string | null;
  streetNumber: string | null;
  cadastralCode: string | null;
  price: string | null;
  pricePerSqm: string | null;
  currency: string | null;
  area: string | null;
  rooms: string | null;
  bedrooms: string | null;
  floor: string | null;
  totalFloors: string | null;
  projectType: string | null;
  bathrooms: string | null;
  balconyArea: string | null;
  verandaArea: string | null;
  loggiaArea: string | null;
  description: string | null;
  images: unknown;
  rawData: unknown;
  sourceUrl: string;
}) {
  return {
    title: listing.title || "",
    propertyType: listing.propertyType || "",
    dealType: listing.dealType || "",
    buildingStatus: listing.buildingStatus || "",
    condition: listing.condition || "",
    city: listing.city || "",
    address: listing.address || "",
    street: listing.street || "",
    streetNumber: listing.streetNumber || "",
    cadastralCode: listing.cadastralCode || "",
    price: listing.price || "",
    pricePerSqm: listing.pricePerSqm || "",
    currency: listing.currency || "USD",
    area: listing.area || "",
    rooms: listing.rooms || "",
    bedrooms: listing.bedrooms || "",
    floor: listing.floor || "",
    totalFloors: listing.totalFloors || "",
    projectType: listing.projectType || "",
    bathrooms: listing.bathrooms || "",
    balconyArea: listing.balconyArea || "",
    verandaArea: listing.verandaArea || "",
    loggiaArea: listing.loggiaArea || "",
    description: listing.description || "",
    images: (listing.images as string[]) || [],
    rawData: (listing.rawData as Record<string, string>) || {},
  };
}

export async function runMyhomePrefillJob(jobId: string, listingId: string, userId: string) {
  const reporter = createPrefillReporter(jobId);
  markPrefillRunning(jobId);

  try {
    const listing = await db.parsedListing.findFirst({
      where: { id: listingId, userId },
    });
    if (!listing) {
      failPrefillJob(jobId, "Listing not found");
      return;
    }

    const myhomeAccount = await db.myhomeAccount.findUnique({ where: { userId } });
    if (!myhomeAccount?.isVerified) {
      failPrefillJob(jobId, "myhome.ge account not linked");
      return;
    }

    await db.parsedListing.update({
      where: { id: listingId },
      data: { postStatus: "PENDING" },
    });

    reporter.info("Queued — starting myhome.ge prefill");

    const password = decrypt(myhomeAccount.myhomePassword);
    const result = await enqueuePrefill(`myhome-${listingId}`, () =>
      createMyhomePost(
        { email: myhomeAccount.myhomeEmail, password },
        listingPayload(listing),
        { listingId, userId, sourceUrl: listing.sourceUrl, reporter }
      )
    );

    if (!result.success) {
      await db.parsedListing.update({
        where: { id: listingId },
        data: { postStatus: "FAILED" },
      });
      failPrefillJob(jobId, result.error || "Failed to pre-fill form");
      return;
    }

    if (result.postUrl) {
      await db.parsedListing.update({
        where: { id: listingId },
        data: { postUrl: result.postUrl },
      });
    }

    completePrefillJob(jobId, result.postUrl);
  } catch (error) {
    await db.parsedListing
      .update({
        where: { id: listingId },
        data: { postStatus: "FAILED" },
      })
      .catch(() => null);
    failPrefillJob(
      jobId,
      error instanceof Error ? error.message : "Prefill failed unexpectedly"
    );
  }
}

export async function runSsgePrefillJob(jobId: string, listingId: string, userId: string) {
  const reporter = createPrefillReporter(jobId);
  markPrefillRunning(jobId);

  try {
    const listing = await db.parsedListing.findFirst({
      where: { id: listingId, userId },
    });
    if (!listing) {
      failPrefillJob(jobId, "Listing not found");
      return;
    }

    const ssgeAccount = await db.ssgeAccount.findUnique({ where: { userId } });
    if (!ssgeAccount?.isVerified) {
      failPrefillJob(jobId, "ss.ge account not linked");
      return;
    }

    await db.parsedListing.update({
      where: { id: listingId },
      data: { ssgePostStatus: "PENDING" },
    });

    reporter.info("Queued — starting ss.ge prefill");

    const password = decrypt(ssgeAccount.ssgePassword);
    const result = await enqueuePrefill(`ssge-${listingId}`, () =>
      createSsgePost(
        { email: ssgeAccount.ssgeEmail, password },
        listingPayload(listing),
        { listingId, userId, sourceUrl: listing.sourceUrl, reporter }
      )
    );

    if (!result.success) {
      await db.parsedListing.update({
        where: { id: listingId },
        data: { ssgePostStatus: "FAILED" },
      });
      failPrefillJob(jobId, result.error || "Failed to pre-fill form");
      return;
    }

    if (result.postUrl) {
      await db.parsedListing.update({
        where: { id: listingId },
        data: { ssgePostUrl: result.postUrl },
      });
    }

    completePrefillJob(jobId, result.postUrl);
  } catch (error) {
    await db.parsedListing
      .update({
        where: { id: listingId },
        data: { ssgePostStatus: "FAILED" },
      })
      .catch(() => null);
    failPrefillJob(
      jobId,
      error instanceof Error ? error.message : "Prefill failed unexpectedly"
    );
  }
}
