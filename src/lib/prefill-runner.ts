import { db } from "@/lib/db";
import { decrypt } from "@/lib/encryption";
import { closeMyhomePostSession, createMyhomePost } from "@/lib/myhome-parser";
import { closeSsgePostSession, createSsgePost } from "@/lib/ssge-parser";
import {
  completePrefillJob,
  createCancellablePrefillReporter,
  failPrefillJob,
  isPrefillCancelled,
  markPrefillRunning,
  PrefillCancelledError,
} from "@/lib/prefill-progress-redis";

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
  // Cancelled while waiting in the queue but picked up before removal
  if (await isPrefillCancelled(jobId)) return;

  const { reporter, dispose, isCancelled } = createCancellablePrefillReporter(
    jobId,
    () => closeMyhomePostSession()
  );
  await markPrefillRunning(jobId);

  try {
    const listing = await db.parsedListing.findFirst({
      where: { id: listingId, userId },
    });
    if (!listing) {
      await failPrefillJob(jobId, "Listing not found");
      return;
    }

    const myhomeAccount = await db.myhomeAccount.findUnique({ where: { userId } });
    if (!myhomeAccount?.isVerified) {
      await failPrefillJob(jobId, "myhome.ge account not linked");
      return;
    }

    await db.parsedListing.update({
      where: { id: listingId },
      data: { postStatus: "PENDING" },
    });

    reporter.info("Queued — starting myhome.ge prefill");

    const password = decrypt(myhomeAccount.myhomePassword);
    const result = await createMyhomePost(
      { email: myhomeAccount.myhomeEmail, password },
      listingPayload(listing),
      { listingId, userId, sourceUrl: listing.sourceUrl, reporter }
    );

    if (!result.success) {
      if (isCancelled() || result.error === "Prefill cancelled by user") {
        await closeMyhomePostSession();
        return;
      }
      await db.parsedListing.update({
        where: { id: listingId },
        data: { postStatus: "FAILED" },
      });
      await failPrefillJob(jobId, result.error || "Failed to pre-fill form");
      return;
    }

    if (result.postUrl) {
      await db.parsedListing.update({
        where: { id: listingId },
        data: { postUrl: result.postUrl },
      });
    }

    await completePrefillJob(jobId, result.postUrl);
  } catch (error) {
    if (error instanceof PrefillCancelledError || isCancelled()) {
      await closeMyhomePostSession();
      return;
    }
    await db.parsedListing
      .update({
        where: { id: listingId },
        data: { postStatus: "FAILED" },
      })
      .catch(() => null);
    await failPrefillJob(
      jobId,
      error instanceof Error ? error.message : "Prefill failed unexpectedly"
    );
  } finally {
    dispose();
  }
}

export async function runSsgePrefillJob(jobId: string, listingId: string, userId: string) {
  // Cancelled while waiting in the queue but picked up before removal
  if (await isPrefillCancelled(jobId)) return;

  const { reporter, dispose, isCancelled } = createCancellablePrefillReporter(
    jobId,
    () => closeSsgePostSession()
  );
  await markPrefillRunning(jobId);

  try {
    const listing = await db.parsedListing.findFirst({
      where: { id: listingId, userId },
    });
    if (!listing) {
      await failPrefillJob(jobId, "Listing not found");
      return;
    }

    const ssgeAccount = await db.ssgeAccount.findUnique({ where: { userId } });
    if (!ssgeAccount?.isVerified) {
      await failPrefillJob(jobId, "ss.ge account not linked");
      return;
    }

    await db.parsedListing.update({
      where: { id: listingId },
      data: { ssgePostStatus: "PENDING" },
    });

    reporter.info("Queued — starting ss.ge prefill");

    const password = decrypt(ssgeAccount.ssgePassword);
    const result = await createSsgePost(
      { email: ssgeAccount.ssgeEmail, password },
      listingPayload(listing),
      { listingId, userId, sourceUrl: listing.sourceUrl, reporter }
    );

    if (!result.success) {
      if (isCancelled() || result.error === "Prefill cancelled by user") {
        await closeSsgePostSession();
        return;
      }
      await db.parsedListing.update({
        where: { id: listingId },
        data: { ssgePostStatus: "FAILED" },
      });
      await failPrefillJob(jobId, result.error || "Failed to pre-fill form");
      return;
    }

    if (result.postUrl) {
      await db.parsedListing.update({
        where: { id: listingId },
        data: { ssgePostUrl: result.postUrl },
      });
    }

    await completePrefillJob(jobId, result.postUrl);
  } catch (error) {
    if (error instanceof PrefillCancelledError || isCancelled()) {
      await closeSsgePostSession();
      return;
    }
    await db.parsedListing
      .update({
        where: { id: listingId },
        data: { ssgePostStatus: "FAILED" },
      })
      .catch(() => null);
    await failPrefillJob(
      jobId,
      error instanceof Error ? error.message : "Prefill failed unexpectedly"
    );
  } finally {
    dispose();
  }
}
