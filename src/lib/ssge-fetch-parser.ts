/**
 * HTTP-based ss.ge listing parser.
 *
 * ss.ge has no bot protection — a plain fetch returns the full SSR HTML
 * with all listing data embedded in __NEXT_DATA__ (applicationData).
 * This is ~10x faster than Playwright (~2s vs ~15-20s).
 *
 * Field names verified against the live API (June 2025).
 */
import type { MyhomeListing } from "@/lib/myhome-parser";
import { sanitizeBuildingStatusValue } from "@/lib/building-status-sanitize";
import { resolveListingDisplayArea } from "@/lib/listing-area";
import { ssgeOriginalImageUrl } from "@/lib/ssge-image";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const FETCH_TIMEOUT_MS = parseInt(
  process.env.PARSE_GOTO_TIMEOUT_MS || "20000",
  10
);

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

const LAND_TYPE_BY_ID: Record<number, string> = {
  1: "სასოფლო-სამეურნეო მიწა",
  2: "არასასოფლო-სამეურნეო მიწა",
  3: "კომერციული მიწა",
  4: "სპეციალური მიწა",
  5: "საინვესტიციო მიწა",
  6: "ფერმერული მიწა",
};

const LAND_TYPE_LABELS = new Set(Object.values(LAND_TYPE_BY_ID));

/**
 * Maps ss.ge API boolean amenity fields → Georgian rawData keys used by the prefill system.
 * Only fields that are `true` (or truthy) on the app object get added to rawData as "კი".
 */
const AMENITY_MAP: Record<string, string> = {
  airConditioning:  "კონდიციონერი",
  balcony:          "აივანი",
  basement:         "სარდაფი",
  cableTelevision:  "კაბელური ტელევიზია",
  drinkingWater:    "სასმელი წყალი",
  electricity:      "შეუფერხებელი დენი",
  elevator:         "ლიფტი",
  fridge:           "მაცივარი",
  furniture:        "ავეჯი",
  garage:           "ავტოფარეხი",
  glazedWindows:    "მინაპაკეტი",
  hotWater:         "ცხელი წყალი",
  internet:         "ინტერნეტი",
  ironDoor:         "რკინის კარი",
  naturalGas:       "გაზი",
  securityAlarm:    "დაცვა",
  sewage:           "კანალიზაცია",
  storage:          "სათავსო",
  telephone:        "ტელეფონი",
  tv:               "ტელევიზია",
  washingMachine:   "სარეცხი მანქანა",
  water:            "წყალი",
  wiFi:             "Wi-Fi",
  withPool:         "აუზი",
  viewOnYard:       "ხედი ეზოზე",
  viewOnStreet:     "ხედი ქუჩაზე",
  comfortable:      "მყუდრო",
  light:            "ნათელი",
  withBuiltInKitchen: "ჩაშენებული სამზარეულო",
  lastFloor:        "ბოლო სართული",
};

function norm(s: unknown): string {
  return String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractNextData(html: string): Record<string, unknown> | null {
  const match = html.match(
    /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i
  );
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getApp(nextData: Record<string, unknown>): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (nextData as any)?.props?.pageProps?.applicationData ?? null;
}

/**
 * ss.ge description can be:
 *   - a plain string
 *   - an array of strings / objects
 *   - an object with a text/value/body key
 */
function extractDescription(raw: unknown): string {
  if (!raw) return "";
  if (typeof raw === "string") return norm(raw);
  if (Array.isArray(raw)) {
    return raw
      .map((item) =>
        typeof item === "string"
          ? item
          : norm(item?.text ?? item?.value ?? item?.body ?? item?.description ?? "")
      )
      .filter(Boolean)
      .join("\n");
  }
  if (typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const val = obj.text ?? obj.value ?? obj.body ?? obj.description ?? obj.content ?? "";
    return extractDescription(val);
  }
  return norm(String(raw));
}

function extractArea(s: unknown): string {
  const m = norm(s).match(/([\d]+(?:[.,]\d+)?)/);
  return m ? m[1].replace(",", ".") : "";
}

export async function parseSsgeListingViaFetch(url: string): Promise<{
  success: boolean;
  data?: MyhomeListing;
  error?: string;
}> {
  let html: string;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ka-GE,ka;q=0.9,en;q=0.8",
        "Cache-Control": "no-cache",
      },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      return { success: false, error: `HTTP ${res.status} from ss.ge` };
    }
    html = await res.text();
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Fetch failed",
    };
  }

  const nextData = extractNextData(html);
  if (!nextData) {
    return { success: false, error: "No __NEXT_DATA__ in ss.ge page" };
  }

  const app = getApp(nextData);
  if (!app) {
    return { success: false, error: "No applicationData in ss.ge __NEXT_DATA__" };
  }

  // ---- Title ---------------------------------------------------------------
  const title = norm(app.title);

  // ---- Address -------------------------------------------------------------
  const addr = app.address ?? {};
  let city = norm(addr.cityTitle ?? addr.cityName ?? addr.city ?? "");
  if (!city && title) {
    const m = title.match(/([Ⴀ-ჿ]+)ში\b/u);
    if (m) city = norm(m[1]);
  }
  const street = norm(addr.streetTitle ?? addr.street ?? "");
  const streetNumber = norm(addr.streetNumber ?? "");
  const address = street
    ? streetNumber ? `${street} ${streetNumber}` : street
    : "";
  // District info — useful for prefill location fields
  const districtTitle    = norm(addr.districtTitle ?? "");
  const subdistrictTitle = norm(addr.subdistrictTitle ?? "");

  // ---- Price ---------------------------------------------------------------
  let price = "";
  let currency = "USD";
  let pricePerSqm = "";
  const priceData = app.price ?? null;
  if (priceData) {
    const usdNum = Number(priceData.priceUsd ?? 0);
    const gelNum = Number(priceData.priceGeo ?? 0);
    if (usdNum > 0) {
      price = String(priceData.priceUsd);
      pricePerSqm = String(priceData.unitPriceUsd ?? "");
      currency = "USD";
    } else if (gelNum > 0) {
      price = String(priceData.priceGeo);
      pricePerSqm = String(priceData.unitPriceGeo ?? "");
      currency = "GEL";
    }
  }

  // ---- Images --------------------------------------------------------------
  const appImages: Array<{ fileName?: string }> = app.appImages ?? [];
  const images = appImages
    .map((img) => (img.fileName ?? "").split("?")[0])
    .filter(Boolean)
    .map((f) => ssgeOriginalImageUrl(f) ?? f)
    .slice(0, 16);

  // ---- Property / Deal type ------------------------------------------------
  let propertyType = norm(app.realEstateType ?? "");
  let dealType = norm(app.realEstateDealType ?? "");

  if (!dealType) {
    for (const [re, dt] of DEAL_TYPE_KEYWORDS) {
      if (re.test(title)) { dealType = dt; break; }
    }
  }
  if (!propertyType) {
    for (const [re, pt] of PROPERTY_TYPE_KEYWORDS) {
      if (re.test(title)) { propertyType = pt; break; }
    }
  }

  // ---- Specs (real field names from the API) --------------------------------
  let area = extractArea(app.totalArea ?? "");
  const rooms       = norm(app.rooms ?? "");
  const bedrooms    = norm(app.bedrooms ?? "");
  const floor       = norm(app.floor ?? "");
  const totalFloors = norm(app.floors ?? "");          // NOTE: "floors" not "totalFloors"
  const bathrooms   = norm(app.toilet ?? "");          // NOTE: "toilet" not "bathrooms"
  const projectType = norm(app.project ?? "");         // NOTE: "project" not "projectType"
  const cadastralCode = norm(app.cadastralCode ?? "");
  if (app.description && typeof app.description !== "string") {
    console.log("[ss.ge] description shape:", JSON.stringify(app.description).slice(0, 200));
  }
  const description = extractDescription(app.description);

  // ---- Building status / condition -----------------------------------------
  // NOTE: "realEstateStatus" and "state" — not "status"/"condition"
  let buildingStatus = sanitizeBuildingStatusValue(norm(app.realEstateStatus ?? ""));
  const condition   = norm(app.state ?? "");

  // ---- Land plot type ------------------------------------------------------
  let landPlotType = "";
  if (app.landType != null) {
    landPlotType = LAND_TYPE_BY_ID[Number(app.landType)] ?? "";
  }
  if (LAND_TYPE_LABELS.has(buildingStatus) && !landPlotType) {
    landPlotType = buildingStatus;
    buildingStatus = "";
  }

  // ---- rawData: amenities + extra areas ------------------------------------
  const rawData: Record<string, string> = {};

  // Boolean amenities
  for (const [apiKey, georgianLabel] of Object.entries(AMENITY_MAP)) {
    if (app[apiKey]) rawData[georgianLabel] = "კი";
  }

  // Heating — map api "heating" boolean to system label
  if (app.heating) rawData["გათბობა"] = "კი";

  // Structured fields
  if (buildingStatus) rawData["სტატუსი"] = buildingStatus;
  if (condition)      rawData["მდგომარეობა"] = condition;
  if (projectType)    rawData["პროექტი"] = projectType;
  if (projectType)    rawData["პროექტის ტიპი"] = projectType;
  if (rooms)          rawData["ოთახი"] = rooms;
  if (bedrooms)       rawData["საძინებელი"] = bedrooms;

  if (landPlotType && LAND_TYPE_LABELS.has(landPlotType)) {
    rawData["მიწის ნაკვეთი"] = landPlotType;
  }

  // District / subdistrict for location prefill
  if (districtTitle)    rawData["რაიონი"] = districtTitle;
  if (subdistrictTitle) rawData["მიკრო-რაიონი"] = subdistrictTitle;

  // Extra areas
  const houseArea = extractArea(app.areaOfHouse ?? "");
  const yardArea  = extractArea(app.areaOfYard ?? "");
  const kitchenArea = extractArea(app.kitchenArea ?? "");
  if (houseArea) rawData["სახლის ფართი"] = houseArea;
  if (yardArea) rawData["ეზოს ფართი"] = yardArea;
  if (kitchenArea) rawData["სამზარეულოს ფართი"] = kitchenArea;

  area = resolveListingDisplayArea(
    area || houseArea,
    propertyType,
    rawData
  );

  // Balcony/loggia from balcony_Loggia field
  const balconyLoggia = norm(app.balcony_Loggia ?? "");
  if (balconyLoggia) rawData["აივანი/ლოჯია"] = balconyLoggia;

  // Owner contact
  const phones: Array<{ phoneNumber?: string }> = app.applicationPhones ?? [];
  const mobileNumber = norm(phones[0]?.phoneNumber ?? "");
  const ownerName = norm(app.contactPerson ?? "");
  if (ownerName)    rawData["მესაკუთრე"] = ownerName;
  if (mobileNumber) rawData["ნომერი"] = mobileNumber;

  if (!title && !price && images.length === 0) {
    return {
      success: false,
      error: "ss.ge __NEXT_DATA__ had no usable listing data",
    };
  }

  console.log(
    `[ss.ge fetch-parse] OK: "${title}" — ${price} ${currency}, ${rooms} rooms, ${area} m², floor ${floor}/${totalFloors}`
  );

  return {
    success: true,
    data: {
      title,
      propertyType,
      dealType,
      buildingStatus,
      condition,
      city,
      address,
      street,
      streetNumber,
      cadastralCode,
      price,
      pricePerSqm,
      currency,
      area,
      rooms,
      bedrooms,
      floor,
      totalFloors,
      projectType,
      bathrooms,
      balconyArea: "",
      verandaArea: "",
      loggiaArea: "",
      description,
      images,
      rawData,
      ownerName,
      mobileNumber,
    },
  };
}
