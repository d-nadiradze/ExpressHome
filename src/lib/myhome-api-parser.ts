/**
 * myhome.ge listing parser via the tnet API.
 *
 * Endpoint: GET https://api-statements.tnet.ge/v1/statements/{id}
 * Headers:  x-website-key: myhome
 *
 * ~400ms, no browser needed.
 */
import type { MyhomeListing } from "@/lib/myhome-parser";
import { extractMyhomeListingIdFromUrl } from "@/lib/listing-url";
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

function fail(message: string): { success: false; error: string } {
  console.log(`[myhome-api] ${message}`);
  return { success: false, error: message };
}

// ---- Main export ------------------------------------------------------------

export async function parseMyhomeViaApi(
  url: string
): Promise<{ success: boolean; data?: MyhomeListing; error?: string }> {
  const listingId = extractMyhomeListingIdFromUrl(url);
  if (!listingId) return fail("Invalid myhome.ge URL");

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(`${API_BASE}/${listingId}`, {
      headers: HEADERS,
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      return fail(`HTTP ${res.status} for listing ${listingId}`);
    }

    const json = await res.json();
    const s = json?.data?.statement;
    if (!s) {
      return fail(`No statement in API response for ${listingId}`);
    }

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
    const images: string[] = (s.images ?? [])
      .map((img: { thumb?: string }) => img.thumb ?? "")
      .filter(Boolean)
      .slice(0, 16);

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

    if (!title && !price) {
      return fail(`Insufficient data in API response for ${listingId}`);
    }

    console.log(`[myhome-api] OK: "${title}" — ${price} ${currency}, ${rooms} rooms, ${area}m², floor ${floor}/${totalFloors}`);

    return {
      success: true,
      data: {
        title, propertyType, dealType, buildingStatus, condition,
        city, address, street, streetNumber, cadastralCode,
        price, pricePerSqm, currency, area,
        rooms, bedrooms, bathrooms, floor, totalFloors, projectType,
        balconyArea, verandaArea, loggiaArea,
        description, images, rawData, ownerName, mobileNumber,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(`Request failed for ${listingId}: ${message}`);
  }
}
