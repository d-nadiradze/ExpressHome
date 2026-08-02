import { db } from "@/lib/db";
import { decrypt } from "@/lib/encryption";
import { closeMyhomePostSession, createMyhomePost } from "@/lib/myhome-parser";
import {
  createMyhomePostViaApi,
  isMyhomeApiPrefillEnabled,
  shouldFallbackToBrowserPrefill,
} from "@/lib/myhome-api-prefill";
import {
  isPartialSuccess,
  shouldRetryInBrowser,
  type PrefillAttemptResult,
} from "@/lib/prefill-fallback";
import { closeSsgePostSession, createSsgePost } from "@/lib/ssge-parser";
import {
  createSsgePostViaApi,
  isSsgeApiPrefillEnabled,
  shouldFallbackToBrowserPrefill as shouldSsgeFallbackToBrowser,
} from "@/lib/ssge-api-prefill";
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

  let closeJobSession: (() => Promise<void>) | undefined;
  const { reporter, dispose, isCancelled } = createCancellablePrefillReporter(
    jobId,
    () => closeJobSession?.() ?? closeMyhomePostSession()
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
    const credentials = { email: myhomeAccount.myhomeEmail, password };
    const payload = listingPayload(listing);
    const runOptions = {
      listingId,
      userId,
      sourceUrl: listing.sourceUrl,
      reporter,
      bindSessionClose: (close: () => Promise<void>) => {
        closeJobSession = close;
      },
    };

    let result: PrefillAttemptResult;

    if (isMyhomeApiPrefillEnabled()) {
      reporter.info("Using myhome API prefill (no browser)");
      result = await createMyhomePostViaApi(credentials, payload, runOptions);
      if (isPartialSuccess(result)) {
        console.warn(
          `[myhome API prefill] listing already created — not retrying in a browser: ${result.error}`
        );
        reporter.warn(
          `Listing was created on myhome.ge but a later step failed (${result.error}). ` +
            "Not retrying in a browser — that would post it twice."
        );
      } else if (shouldRetryInBrowser(result, shouldFallbackToBrowserPrefill())) {
        console.warn(
          `[myhome API prefill] failed — falling back to browser: ${result.error}`
        );
        reporter.warn(
          `API prefill failed (${result.error}) — falling back to browser`
        );
        result = await createMyhomePost(credentials, payload, runOptions);
      }
    } else {
      result = await createMyhomePost(credentials, payload, runOptions);
    }

    // A created listing settles as a partial success: the failed step is already
    // flagged as a warning, and the user needs the listing URL, not a bare error.
    if (!result.success && !isPartialSuccess(result)) {
      if (isCancelled() || result.error === "Prefill cancelled by user") {
        await (closeJobSession?.() ?? closeMyhomePostSession());
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
      await (closeJobSession?.() ?? closeMyhomePostSession());
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

  let closeJobSession: (() => Promise<void>) | undefined;
  const { reporter, dispose, isCancelled } = createCancellablePrefillReporter(
    jobId,
    () => closeJobSession?.() ?? closeSsgePostSession()
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

    const useApi = isSsgeApiPrefillEnabled();
    reporter.info(
      useApi
        ? "Queued — starting ss.ge API prefill (no wizard browser)"
        : "Queued — starting ss.ge browser prefill"
    );
    if (useApi) {
      // Only clears an idle headed reuse session — not another job's in-flight browser.
      await closeSsgePostSession();
    }

    const password = decrypt(ssgeAccount.ssgePassword);
    const listingInput = listingPayload(listing);
    const prefillOpts = {
      listingId,
      userId,
      sourceUrl: listing.sourceUrl,
      reporter,
      bindSessionClose: (close: () => Promise<void>) => {
        closeJobSession = close;
      },
    };

    let result: PrefillAttemptResult;
    if (useApi) {
      result = await createSsgePostViaApi(
        { email: ssgeAccount.ssgeEmail, password },
        listingInput,
        prefillOpts
      );
      if (isPartialSuccess(result)) {
        console.warn(
          `[ss.ge API prefill] paid publish is in doubt — not retrying in a browser: ${result.error}`
        );
        reporter.warn(
          `ss.ge publish failed after the draft was saved (${result.error}). ` +
            "Not retrying in a browser — that could publish and charge twice."
        );
      } else if (shouldRetryInBrowser(result, shouldSsgeFallbackToBrowser())) {
        console.warn(
          `[ss.ge API prefill] failed — falling back to browser: ${result.error}`
        );
        reporter.warn(
          `API prefill failed (${result.error}) — falling back to browser (headless=${process.env.SSGE_PREFILL_HEADLESS !== "false"})`
        );
        result = await createSsgePost(
          { email: ssgeAccount.ssgeEmail, password },
          listingInput,
          prefillOpts
        );
      }
    } else {
      result = await createSsgePost(
        { email: ssgeAccount.ssgeEmail, password },
        listingInput,
        prefillOpts
      );
    }

    // A saved draft settles as a partial success: the failed step is already
    // flagged as a warning, and the user needs the draft URL, not a bare error.
    if (!result.success && !isPartialSuccess(result)) {
      if (isCancelled() || result.error === "Prefill cancelled by user") {
        await (closeJobSession?.() ?? closeSsgePostSession());
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
      await (closeJobSession?.() ?? closeSsgePostSession());
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
