/**
 * Maps a parsed listing to the broker Google Sheet row layout (Georgian headers).
 */

import {
  extractAreaDigits,
  resolveListingDisplayArea,
} from "@/lib/listing-area";

export const BROKER_SHEET_HEADERS = [
  "სახელი",
  "ნომერი",
  "თარიღი",
  "myhome ID",
  "ss ID",
  "ფასი",
  "საკომისიო",
  "m2",
  "რაიონი",
  "მისამართი",
  "კორპუსი",
  "რემონტი",
  "სართული",
  "ოთახი",
  "საძინებელი",
  "კომენტარი",
] as const;

export const BROKER_SHEET_COLUMN_COUNT = BROKER_SHEET_HEADERS.length;

/** Always 16 cells (A–P); prevents Sheets from dropping leading empty columns on append. */
export function padBrokerSheetRow(row: string[]): string[] {
  const out = row.map((c) => (c ?? "").trim());
  while (out.length < BROKER_SHEET_COLUMN_COUNT) out.push("");
  return out.slice(0, BROKER_SHEET_COLUMN_COUNT);
}

export type BrokerSheetListing = {
  sourceUrl: string;
  postUrl?: string | null;
  ssgePostUrl?: string | null;
  propertyType?: string | null;
  price?: string | null;
  currency?: string | null;
  area?: string | null;
  city?: string | null;
  address?: string | null;
  street?: string | null;
  streetNumber?: string | null;
  buildingStatus?: string | null;
  condition?: string | null;
  floor?: string | null;
  totalFloors?: string | null;
  rooms?: string | null;
  bedrooms?: string | null;
  description?: string | null;
  cadastralCode?: string | null;
  createdAt: Date;
  rawData?: Record<string, string> | null;
};

function toCell(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function rawGet(raw: Record<string, string> | null | undefined, ...keys: string[]): string {
  if (!raw) return "";
  for (const key of keys) {
    const v = raw[key]?.trim();
    if (v) return v;
  }
  return "";
}

/** DD/MM/YYYY — matches typical broker sheet date column. */
export function formatBrokerSheetDate(date: Date): string {
  const d = String(date.getDate()).padStart(2, "0");
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const y = date.getFullYear();
  return `${d}/${m}/${y}`;
}

/** myhome.ge / statements.myhome.ge listing numeric id */
export function extractMyhomeListingId(
  sourceUrl: string,
  postUrl?: string | null
): string {
  for (const u of [postUrl, sourceUrl]) {
    if (!u || !/myhome\.ge/i.test(u)) continue;
    const pr = u.match(/\/pr\/(\d+)/i);
    if (pr) return pr[1];
    const statement = u.match(/\/statement[s]?\/(\d+)/i);
    if (statement) return statement[1];
    const queryId = u.match(/[?&](?:id|statement_id|application_id)=(\d+)/i);
    if (queryId) return queryId[1];
  }
  return "";
}

export function extractSsgeListingId(
  ssgePostUrl?: string | null,
  sourceUrl?: string
): string {
  for (const u of [ssgePostUrl, sourceUrl]) {
    if (!u || !/ss\.ge/i.test(u)) continue;
    const pathMatch = u.match(/\/(\d{5,})(?:\/|$|\?|#)/);
    if (pathMatch) return pathMatch[1];
  }
  return "";
}

/** e.g. 400000$ */
export function formatBrokerSheetPrice(
  price: string | null | undefined,
  currency: string | null | undefined
): string {
  const digits = (price ?? "").replace(/[^\d]/g, "");
  if (!digits) return "";
  const c = (currency ?? "USD").toUpperCase();
  const suffix =
    c === "GEL" || c === "₾" ? "₾" : c === "EUR" || c === "€" ? "€" : "$";
  return `${digits}${suffix}`;
}

export function formatBrokerSheetCommission(
  raw: Record<string, string> | null | undefined,
  currency: string | null | undefined
): string {
  const rawVal = rawGet(raw, "საკომისიო", "კომისია", "საკომისიოს ოდენობა");
  if (!rawVal) return "";
  if (/[$₾€]/.test(rawVal)) return rawVal;
  const digits = rawVal.replace(/[^\d]/g, "");
  if (!digits) return rawVal;
  return formatBrokerSheetPrice(digits, currency);
}

/** Building column shorthand (e.g. ძვ/კორპ). */
export function abbreviateBuildingStatusForSheet(status: string | null | undefined): string {
  const s = toCell(status);
  if (!s) return "";
  if (/ძველი\s*აშენებული/i.test(s)) return "ძვ/კორპ";
  if (/ახალი\s*აშენებული/i.test(s)) return "ახ/კორპ";
  if (/მშენებარე/i.test(s)) return "მშენ/კორპ";
  return s;
}

/** Renovation column shorthand (e.g. ახ/რემონტ). */
export function abbreviateConditionForSheet(condition: string | null | undefined): string {
  const s = toCell(condition);
  if (!s) return "";
  if (/ახალი\s*გარემონტებული/i.test(s)) return "ახ/რემონტ";
  if (/სარემონტო/i.test(s)) return "სარ/რემონტ";
  if (/თეთრი\s*კარკას/i.test(s)) return "თეთრ/კარკას";
  if (/ძველი\s*რემონტ/i.test(s)) return "ძვ/რემონტ";
  return s;
}

/** Prisma Json → string map for sheet export. */
export function normalizeListingRawData(raw: unknown): Record<string, string> | null {
  if (!raw) return null;
  let obj: Record<string, unknown> | null = null;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  } else if (typeof raw === "object" && !Array.isArray(raw)) {
    obj = raw as Record<string, unknown>;
  }
  if (!obj) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    const s = String(v).replace(/\s+/g, " ").trim();
    if (s) out[k] = s;
  }
  return Object.keys(out).length ? out : null;
}

export function resolveSheetBuildingStatus(listing: BrokerSheetListing): string {
  const raw = listing.rawData;
  return (
    toCell(listing.buildingStatus) ||
    rawGet(raw, "სტატუსი", "სტატუსი / კორპუსი")
  );
}

export function resolveSheetCondition(listing: BrokerSheetListing): string {
  const raw = listing.rawData;
  return toCell(listing.condition) || rawGet(raw, "მდგომარეობა");
}

export function resolveSheetRooms(listing: BrokerSheetListing): string {
  const raw = listing.rawData;
  const v =
    toCell(listing.rooms) ||
    rawGet(raw, "ოთახი", "ოთახები", "ოთახების რაოდენობა");
  const digits = v.replace(/[^\d]/g, "");
  return digits || v;
}

export function resolveSheetBedrooms(listing: BrokerSheetListing): string {
  const raw = listing.rawData;
  const v = toCell(listing.bedrooms) || rawGet(raw, "საძინებელი", "საძინებლები");
  const digits = v.replace(/[^\d]/g, "");
  return digits || v;
}

export function formatBrokerSheetAddress(listing: BrokerSheetListing): string {
  const street = toCell(listing.street);
  const num = toCell(listing.streetNumber);
  if (street || num) {
    return [street, num].filter(Boolean).join(" ").trim();
  }
  const raw = listing.rawData;
  const rawStreet = rawGet(raw, "ქუჩა");
  const rawNum = rawGet(raw, "ქუჩის ნომერი");
  if (rawStreet || rawNum) {
    return [rawStreet, rawNum].filter(Boolean).join(" ").trim();
  }
  return rawGet(raw, "მისამართი") || toCell(listing.address);
}

export function formatBrokerSheetDistrict(listing: BrokerSheetListing): string {
  const raw = listing.rawData;
  return (
    rawGet(raw, "რაიონი", "უბანი", "მიკრო-რაიონი", "მდებარეობა") ||
    toCell(listing.city)
  );
}

/** DB / API listing row → normalized broker sheet input (myhome + ss.ge). */
/** m² column — listing.area + ss.ge/myhome rawData (e.g. სახლის ფართი for houses). */
export function resolveSheetArea(listing: BrokerSheetListing): string {
  const fromListing = resolveListingDisplayArea(
    listing.area,
    listing.propertyType,
    listing.rawData
  );
  if (fromListing) return fromListing;

  const raw = listing.rawData;
  return extractAreaDigits(
    rawGet(
      raw,
      "სახლის ფართი",
      "ფართი",
      "ფართობა",
      "საერთო ფართი",
      "საერთო ფართი",
      "totalArea",
      "area"
    )
  );
}

export function buildBrokerSheetListingFromDb(listing: {
  sourceUrl: string;
  postUrl?: string | null;
  ssgePostUrl?: string | null;
  propertyType?: string | null;
  price?: string | null;
  currency?: string | null;
  area?: string | null;
  city?: string | null;
  address?: string | null;
  street?: string | null;
  streetNumber?: string | null;
  buildingStatus?: string | null;
  condition?: string | null;
  floor?: string | null;
  totalFloors?: string | null;
  rooms?: string | null;
  bedrooms?: string | null;
  description?: string | null;
  cadastralCode?: string | null;
  createdAt: Date;
  rawData?: unknown;
}): BrokerSheetListing {
  return {
    ...listing,
    rawData: normalizeListingRawData(listing.rawData),
  };
}

/** კომენტარი column — cadastral code when parsed (DB field or rawData). */
export function resolveSheetCadastralComment(listing: BrokerSheetListing): string {
  const fromDb = toCell(listing.cadastralCode);
  if (fromDb) return fromDb;
  return rawGet(listing.rawData, "საკადასტრო კოდი", "cadastralCode");
}

export function formatBrokerSheetFloor(
  floor: string | null | undefined,
  totalFloors: string | null | undefined
): string {
  const f = toCell(floor);
  const t = toCell(totalFloors);
  if (f && t) return `${f}/${t}`;
  return f || t;
}

export function listingToBrokerSheetRow(
  listing: BrokerSheetListing,
  options?: { exportDate?: Date }
): string[] {
  const exportDate = options?.exportDate ?? new Date();
  const area = resolveSheetArea(listing);
  const raw = listing.rawData ?? undefined;

  return [
    rawGet(raw, "მესაკუთრე", "სახელი", "მესაკუთრის სახელი", "აგენტი"),
    rawGet(raw, "ნომერი", "ტელეფონი", "მობილური", "ტელ"),
    formatBrokerSheetDate(exportDate),
    "",
    extractSsgeListingId(listing.ssgePostUrl, listing.sourceUrl),
    formatBrokerSheetPrice(listing.price, listing.currency),
    formatBrokerSheetCommission(raw, listing.currency),
    area,
    formatBrokerSheetDistrict(listing),
    formatBrokerSheetAddress(listing),
    abbreviateBuildingStatusForSheet(resolveSheetBuildingStatus(listing)),
    abbreviateConditionForSheet(resolveSheetCondition(listing)),
    formatBrokerSheetFloor(listing.floor, listing.totalFloors),
    resolveSheetRooms(listing),
    resolveSheetBedrooms(listing),
    resolveSheetCadastralComment(listing),
  ];
}
