/**
 * HTTP-first myhome.ge listing parser.
 *
 * Strategy:
 *   1. Get the Next.js buildId from the myhome.ge homepage (cached 30 min).
 *   2. Fetch /_next/data/{buildId}/ka/pr/{id}.json — returns full listing JSON
 *      without bot protection, much faster than loading the full page.
 *   3. If that fails, fall back to Playwright (parseListing from myhome-parser.ts).
 */
import type { MyhomeListing } from "@/lib/myhome-parser";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const FETCH_TIMEOUT_MS = parseInt(
  process.env.PARSE_GOTO_TIMEOUT_MS || "20000",
  10
);

const HEADERS = {
  "User-Agent": USER_AGENT,
  Accept: "application/json, text/html, */*;q=0.8",
  "Accept-Language": "ka-GE,ka;q=0.9,en;q=0.8",
  "Cache-Control": "no-cache",
};

// ---- Build ID cache ---------------------------------------------------------

let cachedBuildId: string | null = null;
let buildIdFetchedAt = 0;
const BUILD_ID_TTL_MS = 30 * 60 * 1000; // 30 minutes

async function getMyhomeBuildId(): Promise<string | null> {
  if (cachedBuildId && Date.now() - buildIdFetchedAt < BUILD_ID_TTL_MS) {
    return cachedBuildId;
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch("https://www.myhome.ge/", {
      headers: HEADERS,
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(/"buildId"\s*:\s*"([^"]+)"/);
    if (!m) return null;
    cachedBuildId = m[1];
    buildIdFetchedAt = Date.now();
    console.log(`[myhome] Cached buildId: ${cachedBuildId}`);
    return cachedBuildId;
  } catch {
    return null;
  }
}

// ---- Listing ID extraction --------------------------------------------------

function extractListingId(url: string): string | null {
  // https://www.myhome.ge/ka/pr/12345678
  const m = url.match(/\/pr\/(\d+)/);
  return m ? m[1] : null;
}

// ---- Helpers ----------------------------------------------------------------

function norm(s: unknown): string {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

function extractAreaDigits(s: unknown): string {
  const m = norm(s).match(/([\d]+(?:[.,]\d+)?)/);
  return m ? m[1].replace(",", ".") : "";
}

const DEAL_TYPE_KEYWORDS: [RegExp, string][] = [
  [/ქირავდება\s+დღიურად/i, "ქირავდება დღიურად"],
  [/ქირავდება/i, "ქირავდება"],
  [/იყიდება/i, "იყიდება"],
  [/გირავდება/i, "გირავდება"],
];

const PROPERTY_TYPE_KEYWORDS: [RegExp, string][] = [
  [/კერძო\s*სახლი/i, "კერძო სახლი"],
  [/მიწის\s*ნაკვეთი/i, "მიწის ნაკვეთი"],
  [/კომერციული\s*ფართი/i, "კომერციული ფართი"],
  [/კომერციული/i, "კომერციული ფართი"],
  [/სასტუმრო/i, "სასტუმრო"],
  [/აგარაკი/i, "აგარაკი"],
  [/ბინა/i, "ბინა"],
];

// ---- Data extraction from /_next/data/ JSON ---------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function tryExtractFromNextDataJson(json: any): MyhomeListing | null {
  try {
    const pp = json?.pageProps;
    if (!pp) return null;

    const listing =
      pp.listing ??
      pp.statementData ??
      pp.applicationData ??
      pp.data?.listing ??
      pp.data ??
      null;

    if (!listing) return null;

    const title = norm(
      listing.title ?? listing.headline ?? listing.name ??
      `${listing.dealType ?? ""} ${listing.propertyType ?? ""}`.trim()
    );

    let price = "", currency = "USD", pricePerSqm = "";
    const priceUsd = listing.priceUsd ?? listing.price_usd ?? listing.prices?.usd ?? listing.usdPrice ?? null;
    const priceGel = listing.priceGel ?? listing.price_gel ?? listing.prices?.gel ?? listing.gelPrice ?? listing.price ?? null;

    if (priceUsd != null && Number(priceUsd) > 0) {
      price = String(priceUsd); currency = "USD";
      pricePerSqm = String(listing.pricePerSqmUsd ?? listing.unitPriceUsd ?? "");
    } else if (priceGel != null && Number(priceGel) > 0) {
      price = String(priceGel); currency = "GEL";
      pricePerSqm = String(listing.pricePerSqmGel ?? listing.unitPriceGel ?? "");
    }

    const rawImages: unknown[] = listing.images ?? listing.photos ?? listing.media ?? listing.appImages ?? [];
    const images: string[] = [];
    for (const img of rawImages) {
      if (typeof img === "string") {
        images.push(img.split("?")[0]);
      } else if (img && typeof img === "object") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const src = (img as any).url ?? (img as any).src ?? (img as any).fileName ?? (img as any).path ?? "";
        if (src) images.push(String(src).split("?")[0]);
      }
      if (images.length >= 16) break;
    }

    if (!title && !price) return null;

    const addr = listing.address ?? listing.location ?? {};
    const city = norm(addr.city ?? addr.cityTitle ?? addr.cityName ?? listing.city ?? "");
    const street = norm(addr.street ?? addr.streetTitle ?? listing.street ?? "");
    const streetNumber = norm(addr.streetNumber ?? listing.streetNumber ?? "");
    const address = street ? (streetNumber ? `${street} ${streetNumber}` : street) : norm(listing.address ?? "");

    let dealType = norm(listing.dealType ?? listing.deal_type ?? listing.transactionType ?? "");
    let propertyType = norm(listing.propertyType ?? listing.property_type ?? listing.estatType ?? listing.estateType ?? "");

    if (!dealType) {
      for (const [re, dt] of DEAL_TYPE_KEYWORDS) { if (re.test(title)) { dealType = dt; break; } }
    }
    if (!propertyType) {
      for (const [re, pt] of PROPERTY_TYPE_KEYWORDS) { if (re.test(title)) { propertyType = pt; break; } }
    }

    const area = extractAreaDigits(listing.area ?? listing.totalArea ?? listing.squareMeter ?? "");
    const rooms = norm(listing.rooms ?? listing.roomsCount ?? "");
    const bedrooms = norm(listing.bedrooms ?? listing.bedroomsCount ?? "");
    const floor = norm(listing.floor ?? "");
    const totalFloors = norm(listing.totalFloors ?? listing.buildingFloors ?? "");
    const bathrooms = norm(listing.bathrooms ?? listing.wetPoints ?? "");
    const projectType = norm(listing.projectType ?? listing.project ?? "");
    const buildingStatus = norm(listing.status ?? listing.buildingStatus ?? "");
    const condition = norm(listing.condition ?? listing.renovation ?? "");
    const cadastralCode = norm(listing.cadastralCode ?? "");
    const description = norm(listing.description ?? listing.body ?? "");

    const balconyArea = extractAreaDigits(listing.balconyArea ?? "");
    const verandaArea = extractAreaDigits(listing.verandaArea ?? "");
    const loggiaArea = extractAreaDigits(listing.loggiaArea ?? "");

    const rawData: Record<string, string> = {};
    if (buildingStatus) rawData["სტატუსი"] = buildingStatus;
    if (condition) rawData["მდგომარეობა"] = condition;
    if (projectType) { rawData["პროექტი"] = projectType; rawData["პროექტის ტიპი"] = projectType; }
    if (balconyArea) rawData["აივნის ფართი"] = balconyArea;
    if (verandaArea) rawData["ვერანდის ფართი"] = verandaArea;
    if (loggiaArea) rawData["ლოჯიის ფართი"] = loggiaArea;

    const ownerName = norm(listing.ownerName ?? listing.owner?.name ?? "");
    const mobileNumber = norm(listing.phone ?? listing.phoneNumber ?? "");
    if (ownerName) rawData["მესაკუთრე"] = ownerName;
    if (mobileNumber) rawData["ნომერი"] = mobileNumber;

    return {
      title, propertyType, dealType, buildingStatus, condition,
      city, address, street, streetNumber, cadastralCode,
      price, pricePerSqm, currency, area, rooms, bedrooms,
      floor, totalFloors, projectType, bathrooms,
      balconyArea, verandaArea, loggiaArea,
      description, images, rawData, ownerName, mobileNumber,
    };
  } catch {
    return null;
  }
}

function isUsableListing(l: MyhomeListing): boolean {
  return Boolean(l.title && (l.price || l.area || l.images.length > 0));
}

// ---- Main export ------------------------------------------------------------

/**
 * Parse a myhome.ge listing via /_next/data/ JSON first, Playwright fallback.
 * The `playwrightFallback` argument is parseListing() from myhome-parser.ts.
 */
export async function parseMyhomeListingWithFallback(
  url: string,
  playwrightFallback: (url: string) => Promise<{
    success: boolean;
    data?: MyhomeListing;
    error?: string;
  }>
): Promise<{ success: boolean; data?: MyhomeListing; error?: string }> {
  const listingId = extractListingId(url);

  // 1. Try /_next/data/ JSON endpoint (fast, no browser needed)
  if (listingId) {
    try {
      const buildId = await getMyhomeBuildId();
      if (buildId) {
        const dataUrl = `https://www.myhome.ge/_next/data/${buildId}/ka/pr/${listingId}.json`;
        console.log(`[myhome fetch] Trying: ${dataUrl}`);

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        const res = await fetch(dataUrl, { headers: HEADERS, signal: controller.signal });
        clearTimeout(timer);

        if (res.ok) {
          const json = await res.json();
          const listing = tryExtractFromNextDataJson(json);
          if (listing && isUsableListing(listing)) {
            console.log(`[myhome fetch] OK (no browser): "${listing.title}" — ${listing.price} ${listing.currency}`);
            return { success: true, data: listing };
          }
          console.log("[myhome fetch] /_next/data/ returned insufficient data, falling back to Playwright");
        } else if (res.status === 404) {
          // Build ID is stale — clear cache so next call refreshes it
          cachedBuildId = null;
          console.log("[myhome fetch] /_next/data/ 404 (stale buildId), falling back to Playwright");
        } else {
          console.log(`[myhome fetch] /_next/data/ HTTP ${res.status}, falling back to Playwright`);
        }
      }
    } catch (err) {
      console.log(`[myhome fetch] /_next/data/ error: ${err instanceof Error ? err.message : err}`);
    }
  }

  // 2. Playwright fallback
  console.log(`[myhome fetch] Using Playwright for ${url}`);
  return playwrightFallback(url);
}
