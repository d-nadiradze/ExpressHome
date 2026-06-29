/**
 * ss.ge listing prefill via api-gateway HTTP APIs.
 *
 * Flow:
 *   1. Cached JWT or Playwright/HTTP OAuth login → Bearer accessToken
 *   2. DELETE delete-draft (clear stale)
 *   3. POST create-draft (bootstrap) → applicationId
 *   4. POST upload-image per photo
 *   5. POST create-draft (full payload)
 *   6. POST PaidService/create-application (balance pay) when SSGE_AUTO_PUBLISH=true
 */
import { readFile } from "fs/promises";
import path from "path";
import type { MyhomeListing } from "@/lib/myhome-parser";
import type { SsgeCredentials } from "@/lib/ssge-parser";
import { normalizeListingForSsgePrefill } from "@/lib/cross-platform-prefill";
import {
  closeSsgeApiSession,
  invalidateAndRefreshSsgeApiSession,
  loginSsgeApi,
  ssgeApiFetch,
  ssgeAuthMethodMessage,
  type SsgeApiSession,
} from "@/lib/ssge-api-auth";
import {
  fetchSsgePaidServiceTariff,
  parseCreateApplicationPayment,
  resolvePaidServiceSelection,
} from "@/lib/ssge-api-payment";
import {
  buildApplicationPayload,
  buildBootstrapDraftPayload,
  type SsgeDraftImage,
} from "@/lib/ssge-api-form-fields";
import { resolveSsgeLocationIds } from "@/lib/ssge-api-location";
import {
  resolveImagesForPlaywright,
} from "@/lib/listing-images";
import {
  noopPrefillReporter,
  type PrefillReporter,
} from "@/lib/prefill-progress";

const FETCH_TIMEOUT_MS = parseInt(process.env.PARSE_GOTO_TIMEOUT_MS || "20000", 10);

export function isSsgeApiPrefillEnabled(): boolean {
  return process.env.SSGE_API_PREFILL === "true";
}

export function shouldFallbackToBrowserPrefill(): boolean {
  return process.env.SSGE_API_PREFILL_FALLBACK !== "false";
}

interface SsgeApiFetchContext {
  session: SsgeApiSession;
  authRetried: boolean;
  refreshOn401: () => Promise<boolean>;
}

async function fetchWithTimeout(
  ctx: SsgeApiFetchContext,
  apiPath: string,
  init: RequestInit
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    let res = await ssgeApiFetch(ctx.session, apiPath, {
      ...init,
      signal: controller.signal,
    });
    if (res.status === 401 && !ctx.authRetried) {
      ctx.authRetried = true;
      console.log(
        "[ss.ge API prefill] 401 from api-gateway — refreshing Bearer token…"
      );
      if (await ctx.refreshOn401()) {
        res = await ssgeApiFetch(ctx.session, apiPath, {
          ...init,
          signal: controller.signal,
        });
      }
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function getCurrencyRates(
  ctx: SsgeApiFetchContext
): Promise<{ usdRate: number; gelRate: number }> {
  try {
    const res = await fetchWithTimeout(ctx, "/RealEstate/currency-rate", {
      method: "GET",
    });
    if (!res.ok) throw new Error("rate fetch failed");
    const data = (await res.json()) as { usdRate?: number; geoRate?: number };
    return {
      usdRate: data.usdRate ?? 2.6462,
      gelRate: data.geoRate ?? 0.3779,
    };
  } catch {
    return { usdRate: 2.6462, gelRate: 0.3779 };
  }
}

async function deleteExistingDraft(ctx: SsgeApiFetchContext): Promise<void> {
  await fetchWithTimeout(ctx, "/RealEstate/delete-draft", {
    method: "DELETE",
    body: JSON.stringify({}),
  }).catch(() => null);
}

async function createBootstrapDraft(
  ctx: SsgeApiFetchContext,
  payload: ReturnType<typeof buildBootstrapDraftPayload>
): Promise<{ applicationId: number; error?: string }> {
  const res = await fetchWithTimeout(ctx, "/RealEstate/create-draft", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  const json = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    applicationId?: number;
    userMessage?: string;
    rawResponse?: string;
  };
  if (!res.ok || !json.success || !json.applicationId) {
    return {
      applicationId: 0,
      error:
        json.userMessage ||
        json.rawResponse ||
        `Bootstrap create-draft failed (HTTP ${res.status})`,
    };
  }
  return { applicationId: json.applicationId };
}

interface UploadResult {
  applicationImageId: number;
  fileName: string;
}

async function uploadImage(
  ctx: SsgeApiFetchContext,
  applicationId: number,
  filePath: string
): Promise<UploadResult | { error: string }> {
  const buf = await readFile(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mime =
    ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  const b64 = buf.toString("base64");
  const content = `data:${mime};base64,${b64}`;

  const res = await fetchWithTimeout(ctx, "/RealEstate/upload-image", {
    method: "POST",
    body: JSON.stringify({ applicationId, content }),
  });
  const json = (await res.json().catch(() => ({}))) as {
    isSuccess?: boolean;
    imageId?: number;
    fileName?: string;
    errorMessage?: string;
  };
  if (!res.ok || !json.isSuccess || !json.imageId || !json.fileName) {
    return {
      error:
        json.errorMessage || `Image upload failed (HTTP ${res.status})`,
    };
  }
  return { applicationImageId: json.imageId, fileName: json.fileName };
}

async function saveFullDraft(
  ctx: SsgeApiFetchContext,
  payload: ReturnType<typeof buildApplicationPayload>
): Promise<{ success: boolean; applicationId?: number; error?: string }> {
  const res = await fetchWithTimeout(ctx, "/RealEstate/create-draft", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  const json = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    applicationId?: number;
    userMessage?: string;
    rawResponse?: string;
  };
  if (!res.ok || !json.success) {
    return {
      success: false,
      error:
        json.userMessage ||
        json.rawResponse ||
        `Save draft failed (HTTP ${res.status})`,
    };
  }
  return { success: true, applicationId: json.applicationId ?? payload.realEstateApplicationId };
}

async function loadDraft(
  ctx: SsgeApiFetchContext,
  applicationId: number
): Promise<Record<string, unknown> | null> {
  const res = await fetchWithTimeout(ctx, "/RealEstate/get-draft", {
    method: "GET",
  });
  if (!res.ok) return null;
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!json?.success || !json.realEstateApplicationId) return null;
  return json;
}

async function publishWithBalance(
  ctx: SsgeApiFetchContext,
  application: ReturnType<typeof buildApplicationPayload>
): Promise<{ success: boolean; error?: string; paymentUrl?: string }> {
  const draft =
    (await loadDraft(ctx, application.realEstateApplicationId)) ||
    application;

  const tariffResult = await fetchSsgePaidServiceTariff(ctx.session, {
    realEstateDealTypeId: application.realEstateDealTypeId,
    cityId: application.cityId,
  });
  if ("error" in tariffResult) {
    return { success: false, error: tariffResult.error };
  }

  const service = resolvePaidServiceSelection(tariffResult.tariff);
  if ("error" in service) {
    return { success: false, error: service.error };
  }

  console.log(
    `[ss.ge API prefill] Publish tariff: ${service.paidService} ${service.days}d = ${service.price} GEL`
  );

  const body = {
    application: {
      ...draft,
      ...application,
      moderationBlockCategories:
        (draft.moderationBlockCategories as unknown) ?? null,
      realEstateApplicationId: application.realEstateApplicationId,
    },
    paidServices: {
      source: "Create Application",
      sourceDevice: "ExpressHome API Prefill",
      isCreate: true,
      items: [
        {
          applicationId: application.realEstateApplicationId,
          rubric: "RealEstate",
          realEstateDealTypeId: application.realEstateDealTypeId,
          cityId: application.cityId,
          paidServices: [
            {
              paidService: service.paidService,
              days: service.days,
            },
          ],
        },
      ],
      purchaseOptions: {
        flow: 1,
        cardId: undefined,
        returnUrl: undefined,
      },
    },
  };

  const res = await fetchWithTimeout(
    ctx,
    "/PaidService/create-application",
    {
      method: "POST",
      body: JSON.stringify(body),
    }
  );

  const raw = await res.text();
  const parsed = parseCreateApplicationPayment(res, raw, service.price);
  if (!parsed.success) {
    return {
      success: false,
      error: `Balance payment failed: ${parsed.error}`,
    };
  }

  return {
    success: true,
    paymentUrl: parsed.paymentUrl,
  };
}

export async function createSsgePostViaApi(
  credentials: SsgeCredentials,
  listing: MyhomeListing,
  options: {
    listingId: string;
    userId: string;
    sourceUrl?: string | null;
    reporter?: PrefillReporter;
  }
): Promise<{ success: boolean; postUrl?: string; error?: string }> {
  const reporter = options.reporter ?? noopPrefillReporter;
  listing = normalizeListingForSsgePrefill(listing, {
    sourceUrl: options.sourceUrl,
  });

  const autoPublish =
    process.env.SSGE_AUTO_PUBLISH === "true" ||
    (process.env.SSGE_AUTO_PUBLISH !== "false" &&
      process.env.SSGE_PREFILL_HEADLESS === "true");

  let session: SsgeApiSession | undefined;

  try {
    reporter.step("login");
    const login = await loginSsgeApi(credentials, { userId: options.userId });
    if (!login.success || !login.session) {
      reporter.stepDone("login", login.error || "Login failed");
      return { success: false, error: login.error || "ss.ge API login failed" };
    }
    session = login.session;
    const loginMsg = ssgeAuthMethodMessage(login.authMethod);
    reporter.info(loginMsg);

    const apiCtx: SsgeApiFetchContext = {
      session,
      authRetried: false,
      refreshOn401: async () => {
        reporter.warn("API token expired — logging in again…");
        const refreshed = await invalidateAndRefreshSsgeApiSession(
          credentials,
          options.userId
        );
        if (!refreshed.success || !refreshed.session) return false;
        session = refreshed.session;
        apiCtx.session = refreshed.session;
        reporter.info(ssgeAuthMethodMessage(refreshed.authMethod));
        return true;
      },
    };

    reporter.stepDone("login", loginMsg);

    reporter.step("location");
    const location = await resolveSsgeLocationIds(
      apiCtx.session,
      listing.city,
      listing.street || listing.address
    );
    reporter.stepDone("location");

    const rates = await getCurrencyRates(apiCtx);

    reporter.step("draft");
    await deleteExistingDraft(apiCtx);

    const bootstrap = buildBootstrapDraftPayload(listing, location);
    const created = await createBootstrapDraft(apiCtx, bootstrap);
    if (!created.applicationId) {
      reporter.stepDone("draft", created.error || "Create draft failed");
      return { success: false, error: created.error || "Create draft failed" };
    }
    const applicationId = created.applicationId;
    reporter.stepDone("draft", `Draft ${applicationId}`);

    reporter.step("images");
    const resolved = await resolveImagesForPlaywright(
      listing.images,
      options.listingId,
      options.userId
    );
    const imagePaths = resolved.paths;

    const uploaded: SsgeDraftImage[] = [];
    try {
      for (let i = 0; i < imagePaths.length; i++) {
        const result = await uploadImage(apiCtx, applicationId, imagePaths[i]);
        if ("error" in result) {
          reporter.stepDone("images", result.error);
          return { success: false, error: result.error };
        }
        uploaded.push({
          applicationImageId: result.applicationImageId,
          fileName: result.fileName,
          isMain: i === 0,
          is360: false,
          orderNo: i,
          imageRotation: 0,
        });
      }
    } finally {
      await resolved.cleanup().catch(() => null);
    }
    reporter.stepDone("images", `${uploaded.length} uploaded`);

    reporter.step("save");
    const fullPayload = buildApplicationPayload(
      listing,
      location,
      applicationId,
      uploaded,
      { usdRate: rates.usdRate, gelRate: rates.gelRate }
    );
    const saved = await saveFullDraft(apiCtx, fullPayload);
    if (!saved.success) {
      reporter.stepDone("save", saved.error || "Save failed");
      return { success: false, error: saved.error || "Save draft failed" };
    }
    reporter.stepDone("save");

    const postUrl = `https://home.ss.ge/ka/udzravi-qoneba/bina-iyideba-${applicationId}`;

    if (!autoPublish) {
      reporter.stepDone("publish", "Skipped (auto-publish off)");
      return { success: true, postUrl };
    }

    reporter.step("publish");
    const paid = await publishWithBalance(apiCtx, fullPayload);
    if (!paid.success) {
      reporter.stepDone("publish", paid.error || "Payment failed");
      return { success: false, error: paid.error || "Publish/payment failed" };
    }
    reporter.stepDone("publish", "Published");

    return { success: true, postUrl: paid.paymentUrl || postUrl };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "ss.ge API prefill failed",
    };
  } finally {
    await closeSsgeApiSession(session);
  }
}
