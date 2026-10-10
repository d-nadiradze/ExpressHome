/**
 * myhome.ge listing parser.
 *
 *   1. tnet API: GET https://api-statements.tnet.ge/v1/statements/{id}
 *      (x-website-key: myhome) — ~400 ms when it is open to anonymous
 *      clients. Since 2026-10-09 it answers 401 Unauthorized everywhere.
 *   2. Listing page: https://www.myhome.ge/pr/{id}/ — the server-rendered
 *      `__NEXT_DATA__` carries the same `statement` object (react-query
 *      dehydrated state). Fetched through the Cloudflare-aware chain
 *      (fetch → curl → Chromium, clearance cookie reused afterwards).
 *
 * Both sources go through the same mapper. After an API 401/403 the API is
 * skipped for a cooldown so every parse does not pay for a dead request.
 */
import type { MyhomeListing } from "@/lib/myhome-parser";
import { extractMyhomeListingIdFromUrl } from "@/lib/listing-url";
import { createCooldown, formatCooldownMs } from "@/lib/retry-cooldown";
import { fetchHtmlResilient } from "@/lib/ssge-challenge-fetch";
import {
  MYHOME_CURRENCY,
  MYHOME_DEAL_TYPE,
  MYHOME_REAL_ESTATE_TYPE,
  MYHOME_STATUS,
  MYHOME_CONDITION,
  MYHOME_PROJECT_TYPE,
  MYHOME_ROOM_TYPE,
  MYHOME_BEDROOM_TYPE,
  MYHOME_BATHROOM_TYPE,
  MYHOME_HOT_WATER_TYPE,
  MYHOME_HEATING_TYPE,
  MYHOME_PARKING_TYPE,
  MYHOME_STOREROOM_TYPE,
  MYHOME_DOOR_WINDOW_TYPE,
  MYHOME_MATERIAL_TYPE,
} from "@/lib/myhome-api-constants";

const API_BASE = "https://api-statements.tnet.ge/v1/statements";
const FETCH_TIMEOUT_MS = parseInt(process.env.PARSE_GOTO_TIMEOUT_MS || "20000", 10);
/** After the API rejects us (401/403), go straight to the page for this long. */
const API_AUTH_RETRY_MS = parseInt(process.env.MYHOME_API_AUTH_RETRY_MS || "900000", 10);

const apiCooldown = createCooldown(API_AUTH_RETRY_MS);

const HEADERS = {
  "x-website-key": "myhome",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
  Accept: "application/json",
  "Accept-Language": "ka-GE,ka;q=0.9,en;q=0.8",
};

// ---- Helpers ----------------------------------------------------------------

function norm(s: unknown): string {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

function stripHtml(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface MyhomeApiImage {
  large?: string;
  thumb?: string;
  blur?: string;
  is_main?: boolean;
}

const MAX_IMAGES = 16;

/**
 * Pick the photo URLs to store for a parsed listing.
 *
 * `thumb` (770px) is the largest rendition WITHOUT the "myhome.ge" watermark;
 * `large` is watermarked and `blur` is a 1 KB placeholder. Never fall back to
 * `large` — that would re-post branded photos on the other portal.
 */
export function selectMyhomeImageUrls(images: MyhomeApiImage[] | undefined | null): string[] {
  return (images ?? [])
    .map((img) => img.thumb || "")
    .filter(Boolean)
    .slice(0, MAX_IMAGES);
}

function fail(message: string): { success: false; error: string } {
  console.log(`[myhome-api] ${message}`);
  return { success: false, error: message };
}

// ---- Statement → MyhomeListing ---------------------------------------------

/**
 * Map a tnet `statement` object (identical shape from the API and from the
 * page's dehydrated react-query state) to our listing model.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mapMyhomeStatement(s: any): MyhomeListing | null {
  if (!s || typeof s !== "object") return null;
  // ---- Price ---------------------------------------------------------------
  const currencyId: number = s.currency_id ?? 2;
  const currency = MYHOME_CURRENCY[currencyId] ?? "USD";
  const priceObj = s.price?.[String(currencyId)];
  const price = priceObj?.price_total ? String(priceObj.price_total) : "";
  const pricePerSqm = priceObj?.price_square ? String(priceObj.price_square) : "";

  // ---- Title ---------------------------------------------------------------
  const title = norm(s.seo?.h1 ?? s.dynamic_title ?? "");

  // ---- Address -------------------------------------------------------------
  const city = norm(s.city_name ?? "");
  const address = norm(s.address ?? "");
  const street = address;
  const streetNumber = "";

  // ---- Specs ---------------------------------------------------------------
  const area = s.area ? String(s.area) : "";
  const rooms = MYHOME_ROOM_TYPE[s.room_type_id] ?? (s.room_type_id ? String(s.room_type_id) : "");
  const bedrooms = MYHOME_BEDROOM_TYPE[s.bedroom_type_id] ?? (s.bedroom_type_id ? String(s.bedroom_type_id) : "");
  const bathrooms = MYHOME_BATHROOM_TYPE[s.bathroom_type_id] ?? (s.bathroom_type_id ? String(s.bathroom_type_id) : "");
  const floor = s.floor ? String(s.floor) : "";
  const totalFloors = s.total_floors ? String(s.total_floors) : "";
  const balconyArea = s.balcony_area ? String(s.balcony_area) : "";
  const loggiaArea = s.loggia_area ? String(s.loggia_area) : "";
  const verandaArea = s.porch_area ? String(s.porch_area) : "";
  const cadastralCode = norm(s.rs_code ?? "");

  // ---- Types ---------------------------------------------------------------
  const dealType = MYHOME_DEAL_TYPE[s.deal_type_id] ?? "";
  const propertyType = MYHOME_REAL_ESTATE_TYPE[s.real_estate_type_id] ?? "";
  const projectType = MYHOME_PROJECT_TYPE[s.project_type_id] ?? "";
  const buildingStatus = MYHOME_STATUS[s.status_id] ?? "";
  const condition = norm(s.condition ?? "") || (MYHOME_CONDITION[s.condition_id] ?? "");

  // ---- Description ---------------------------------------------------------
  const description = s.comment ? stripHtml(s.comment) : "";

  // ---- Images --------------------------------------------------------------
  const images = selectMyhomeImageUrls(s.images);

  // ---- Owner ---------------------------------------------------------------
  const ownerName = norm(s.owner_name ?? "");
  const mobileNumber = norm(s.user_phone_number ?? "");

  // ---- rawData: amenities + extra fields ----------------------------------
  const rawData: Record<string, string> = {};

  if (buildingStatus)  rawData["სტატუსი"] = buildingStatus;
  if (condition)       rawData["მდგომარეობა"] = condition;
  if (projectType)     rawData["პროექტი"] = projectType;
  if (projectType)     rawData["პროექტის ტიპი"] = projectType;
  if (balconyArea)     rawData["აივნის ფართი"] = balconyArea;
  if (s.balconies)     rawData["აივნის რაოდენობა"] = String(s.balconies);
  if (s.height)        rawData["ჭერის სიმაღლე"] = String(s.height);
  if (verandaArea)     rawData["ვერანდის ფართი"] = verandaArea;
  if (loggiaArea)      rawData["ლოჯიის ფართი"] = loggiaArea;
  if (ownerName)       rawData["მესაკუთრე"] = ownerName;
  if (mobileNumber)    rawData["ნომერი"] = mobileNumber;
  if (s.district_name) rawData["რაიონი"] = norm(s.district_name);
  if (s.urban_name)    rawData["მიკრო-რაიონი"] = norm(s.urban_name);
  if (s.yard_area)     rawData["ეზოს ფართი"] = String(s.yard_area);
  if (s.storeroom_area) rawData["სათავსოს ფართი"] = String(s.storeroom_area);

  // ID-based lookups (API may return id or string — prefer string from API if present)
  const hotWaterType = norm(s.hot_water_type ?? "") || (MYHOME_HOT_WATER_TYPE[s.hot_water_type_id] ?? "");
  const doorWindowType = norm(s.door_window_type ?? "") || (MYHOME_DOOR_WINDOW_TYPE[s.door_window_type_id] ?? "");
  const heatingType = MYHOME_HEATING_TYPE[s.heating_type_id] ?? "";
  const parkingType = MYHOME_PARKING_TYPE[s.parking_type_id] ?? "";
  const storeroomType = MYHOME_STOREROOM_TYPE[s.storeroom_type_id] ?? "";
  const materialType = MYHOME_MATERIAL_TYPE[s.material_type_id] ?? "";

  if (hotWaterType)   rawData["ცხელი წყლის ტიპი"] = hotWaterType;
  if (doorWindowType) rawData["კარი/ფანჯარა"] = doorWindowType;
  if (heatingType)    rawData["გათბობის ტიპი"] = heatingType;
  if (parkingType)    rawData["პარკინგი"] = parkingType;
  if (storeroomType)  rawData["სათავსო"] = storeroomType;
  if (materialType)   rawData["მასალა"] = materialType;

  // Parameters array → Georgian amenity names (already in Georgian)
  for (const param of s.parameters ?? []) {
    if (param.display_name) rawData[param.display_name] = "კი";
  }

  if (!title && !price) return null;

  return {
    title, propertyType, dealType, buildingStatus, condition,
    city, address, street, streetNumber, cadastralCode,
    price, pricePerSqm, currency, area,
    rooms, bedrooms, bathrooms, floor, totalFloors, projectType,
    balconyArea, verandaArea, loggiaArea,
    description, images, rawData, ownerName, mobileNumber,
  };
}

// ---- Source 1: tnet API -----------------------------------------------------

class ApiRejectedError extends Error {
  constructor(public readonly status: number, listingId: string) {
    super(`HTTP ${status} for listing ${listingId}`);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchStatementViaApi(listingId: string): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}/${listingId}`, {
      headers: HEADERS,
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      throw new ApiRejectedError(res.status, listingId);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} for listing ${listingId}`);
    const json = await res.json();
    const s = json?.data?.statement;
    if (!s) throw new Error(`No statement in API response for ${listingId}`);
    return s;
  } finally {
    clearTimeout(timer);
  }
}

// ---- Source 2: listing page `__NEXT_DATA__` --------------------------------

/**
 * Pull the `statement` out of a myhome.ge listing page. The page embeds the
 * react-query cache under `props.pageProps.dehydratedState.queries[]` with
 * key `["statements","details",{statementId}]`; the API response is nested
 * as `state.data.data.statement`. Exposed for tests.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractMyhomeStatementFromHtml(html: string, listingId?: string): any | null {
  const m = html.match(
    /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i
  );
  if (!m) return null;
  let next: unknown;
  try {
    next = JSON.parse(m[1]);
  } catch {
    return null;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pp = (next as any)?.props?.pageProps;
  const queries: unknown[] = pp?.dehydratedState?.queries ?? [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const candidates: any[] = [];
  for (const q of queries) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = (q as any)?.state?.data;
    const s = data?.data?.statement ?? data?.statement;
    if (s && typeof s === "object" && s.id != null) candidates.push(s);
  }
  if (pp?.statement?.id != null) candidates.push(pp.statement);
  if (listingId) {
    const exact = candidates.find((s) => String(s.id) === String(listingId));
    if (exact) return exact;
  }
  return candidates[0] ?? null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchStatementViaPage(listingId: string): Promise<{ statement: any; via: string }> {
  const { html, via } = await fetchHtmlResilient(`https://www.myhome.ge/pr/${listingId}/`);
  const statement = extractMyhomeStatementFromHtml(html, listingId);
  if (!statement) {
    throw new Error(`listing page (via ${via}) had no statement in __NEXT_DATA__`);
  }
  return { statement, via };
}

// ---- Main export ------------------------------------------------------------

export async function parseMyhomeViaApi(
  url: string
): Promise<{ success: boolean; data?: MyhomeListing; error?: string }> {
  const listingId = extractMyhomeListingIdFromUrl(url);
  if (!listingId) return fail("Invalid myhome.ge URL");

  const started = Date.now();
  const failures: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let statement: any = null;
  let source = "api";

  const cooling = apiCooldown.get();
  if (cooling) {
    failures.push(
      `api: skipped — ${cooling.reason} ${formatCooldownMs(Date.now() - cooling.failedAt)} ago, retry in ${formatCooldownMs(cooling.remainingMs)}`
    );
  } else {
    try {
      statement = await fetchStatementViaApi(listingId);
      apiCooldown.clear();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof ApiRejectedError) {
        apiCooldown.fail(undefined, `HTTP ${err.status}`);
        console.warn(
          `[myhome-api] API rejected us (HTTP ${err.status}) — using listing pages for the next ${formatCooldownMs(API_AUTH_RETRY_MS)}`
        );
      }
      failures.push(`api: ${message}`);
    }
  }

  if (!statement) {
    try {
      const page = await fetchStatementViaPage(listingId);
      statement = page.statement;
      source = `page/${page.via}`;
    } catch (err) {
      failures.push(`page: ${err instanceof Error ? err.message : String(err)}`);
      return fail(`${failures.join("; ")} (listing ${listingId})`);
    }
  }

  const data = mapMyhomeStatement(statement);
  if (!data) return fail(`Insufficient data in ${source} response for ${listingId}`);

  console.log(
    `[myhome-api] OK via ${source} in ${Date.now() - started}ms: "${data.title}" — ${data.price} ${data.currency}, ${data.rooms} rooms, ${data.area}m², floor ${data.floor}/${data.totalFloors}`
  );
  return { success: true, data };
}
