/**
 * Build ss.ge create-draft JSON from a normalized listing.
 */
import type { MyhomeListing } from "@/lib/myhome-parser";
import { normalizeListingForSsgePrefill } from "@/lib/cross-platform-prefill";
import {
  shouldEnableAdditionalInfoToggle,
  ADDITIONAL_INFO_TOGGLES,
  compactToggleLabel,
} from "@/lib/ssge-mappings";
import {
  reverseSsgeBuildingStatusId,
  reverseSsgeCommercialTypeId,
  reverseSsgeConditionId,
  reverseSsgeCurrencyIds,
  reverseSsgeDealTypeId,
  reverseSsgeLandTypeId,
  reverseSsgeProjectId,
  reverseSsgePropertyTypeId,
  reverseSsgeToiletId,
} from "@/lib/ssge-api-reverse";
import type { SsgeLocationIds } from "@/lib/ssge-api-location";

/** Georgian rawData label → API boolean field (parse AMENITY_MAP inverted). */
const RAW_TO_API_AMENITY: Record<string, string> = {
  კონდიციონერი: "airConditioning",
  "აივანი": "balcony",
  სარდაფი: "basement",
  "კაბელური ტელევიზია": "cableTelevision",
  "საკაბელო ტელევიზია": "cableTelevision",
  ტელევიზია: "tv",
  "სასმელი წყალი": "drinkingWater",
  წყალი: "water",
  "შეუფერხებელი დენი": "electricity",
  ელექტროენერგია: "electricity",
  ლიფტი: "elevator",
  მაცივარი: "fridge",
  ავეჯი: "furniture",
  გარაჟი: "garage",
  ავტოფარეხი: "garage",
  "მინა-პაკეტი": "glazedWindows",
  "მინა პაკეტი": "glazedWindows",
  "ცხელი წყალი": "hotWater",
  ინტერნეტი: "internet",
  "რკინის კარი": "ironDoor",
  გაზი: "naturalGas",
  დაცვა: "securityAlarm",
  სიგნალიზაცია: "securityAlarm",
  კანალიზაცია: "sewage",
  სათავსო: "storage",
  ტელეფონი: "telephone",
  "სარეცხი მანქანა": "washingMachine",
  "Wi-Fi": "wiFi",
  აუზი: "withPool",
  "ხედი ეზოზე": "viewOnYard",
  "ხედი ქუჩაზე": "viewOnStreet",
  მყუდრო: "comfortable",
  ნათელი: "light",
  "ჩაშენებული სამზარეულო": "withBuiltInKitchen",
  "ბოლო სართული": "lastFloor",
};

const TOGGLE_TO_API: Record<string, string> = {
  ლიფტი: "elevator",
  ავეჯი: "furniture",
  გარაჟი: "garage",
  "ცენტ.გათბობა": "heating",
  "ჩაშენებული სამზარეულო": "withBuiltInKitchen",
  კონდიციონერი: "airConditioning",
  "საკაბელო ტელევიზია": "cableTelevision",
  მაცივარი: "fridge",
  "მინა-პაკეტი": "glazedWindows",
  ინტერნეტი: "internet",
  სიგნალიზაცია: "securityAlarm",
  ტელეფონი: "telephone",
  "სასმელი წყალი": "drinkingWater",
  "ცხელი წყალი": "hotWater",
  "რკინის კარი": "ironDoor",
  "სარეცხი მანქანა": "washingMachine",
  აუზი: "withPool",
  ელექტროენერგია: "electricity",
  კანალიზაცია: "sewage",
  აივანი: "balcony",
  სარდაფი: "basement",
  სათავსო: "storage",
  "ბოლო სართული": "lastFloor",
};

export interface SsgeDraftImage {
  applicationImageId: number;
  fileName: string;
  isMain: boolean;
  is360: boolean;
  orderNo: number;
  imageRotation: number;
}

export interface SsgeDraftPayload {
  realEstateTypeId: number;
  realEstateDealTypeId: number;
  cityId: number;
  subdistrictId?: number | null;
  streetId?: number | null;
  streetNumber?: string | null;
  currencyId: number;
  showSiteCurrencyId: number;
  priceType: number;
  realEstateApplicationId: number;
  moderationBlockCategories: null;
  rooms?: number | null;
  bedrooms?: number | null;
  toilet?: number | null;
  status?: number | null;
  project?: number | null;
  state?: number | null;
  totalArea?: number | null;
  areaOfHouse?: number | null;
  areaOfYard?: number | null;
  kitchenArea?: number | null;
  floor?: number | string | null;
  floors?: number | null;
  price?: number | null;
  priceUsd?: number | null;
  unitPrice?: number | null;
  unitPriceUsd?: number | null;
  descriptionGe?: string | null;
  cadastralCode?: string | null;
  commercialRealEstateType?: number | null;
  landType?: number | null;
  phoneNumbers?: Array<{
    phoneNumber: string;
    isMain: boolean;
    hasViber: boolean;
    hasWhatsapp: boolean;
    isApproved: boolean;
  }>;
  images?: SsgeDraftImage[];
  [key: string]: unknown;
}

function parseNum(s: string | undefined | null): number | undefined {
  const n = parseFloat(String(s ?? "").replace(/[^\d.,]/g, "").replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function parseIntField(s: string | undefined | null): number | undefined {
  const m = String(s ?? "").match(/(\d+)/);
  if (!m) return undefined;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : undefined;
}

function applyAmenities(
  payload: Record<string, unknown>,
  rawData: Record<string, string>
): void {
  for (const [label, apiKey] of Object.entries(RAW_TO_API_AMENITY)) {
    const v = rawData[label];
    if (v && v.trim() && v.trim() !== "არა" && !/^\d+([.,]\d+)?\s*(?:მ²|m²)?$/iu.test(v.trim())) {
      payload[apiKey] = true;
    }
  }

  for (const toggle of ADDITIONAL_INFO_TOGGLES) {
    if (!shouldEnableAdditionalInfoToggle(rawData, toggle)) continue;
    const key =
      TOGGLE_TO_API[toggle.ssgeLabel] ||
      TOGGLE_TO_API[compactToggleLabel(toggle.ssgeLabel)];
    if (key) payload[key] = true;
  }
}

function extractPhone(listing: MyhomeListing): string {
  const raw = listing.rawData || {};
  return (
    raw["ნომერი"]?.trim() ||
    raw["ტელეფონი"]?.trim() ||
    raw["მობილური"]?.trim() ||
    ""
  ).replace(/\D/g, "").slice(-9);
}

export function buildBootstrapDraftPayload(
  listing: MyhomeListing,
  location: SsgeLocationIds,
  applicationId = 0
): SsgeDraftPayload {
  listing = normalizeListingForSsgePrefill(listing);
  const realEstateTypeId = reverseSsgePropertyTypeId(listing.propertyType) ?? 5;
  const realEstateDealTypeId = reverseSsgeDealTypeId(listing.dealType) ?? 4;
  const { currencyId, showSiteCurrencyId } = reverseSsgeCurrencyIds(
    listing.currency || "USD"
  );

  return {
    realEstateTypeId,
    realEstateDealTypeId,
    cityId: location.cityId,
    currencyId,
    showSiteCurrencyId,
    priceType: 1,
    moderationBlockCategories: null,
    realEstateApplicationId: applicationId,
  };
}

export function buildApplicationPayload(
  listing: MyhomeListing,
  location: SsgeLocationIds,
  applicationId: number,
  images: SsgeDraftImage[],
  options?: { gelRate?: number; usdRate?: number }
): SsgeDraftPayload {
  listing = normalizeListingForSsgePrefill(listing);
  const raw = listing.rawData || {};

  const realEstateTypeId = reverseSsgePropertyTypeId(listing.propertyType) ?? 5;
  const realEstateDealTypeId = reverseSsgeDealTypeId(listing.dealType) ?? 4;
  const { currencyId, showSiteCurrencyId } = reverseSsgeCurrencyIds(
    listing.currency || "USD"
  );

  const isLand = realEstateTypeId === 3;
  const isCommercial = realEstateTypeId === 6;
  const rooms =
    isLand || isCommercial
      ? null
      : parseIntField(listing.rooms) ?? null;
  const bedrooms =
    isLand || isCommercial
      ? 0
      : parseIntField(listing.bedrooms) ?? 0;

  const totalArea = parseNum(listing.area);
  const priceNum = parseNum(listing.price);
  const usdRate = options?.usdRate ?? 2.6462;
  const gelRate = options?.gelRate ?? 0.3779;

  let price: number | undefined;
  let priceUsd: number | undefined;
  if (currencyId === 2 && priceNum) {
    priceUsd = priceNum;
    price = Math.round(priceNum / gelRate);
  } else if (priceNum) {
    price = priceNum;
    priceUsd = Math.round(priceNum * gelRate);
  }

  const unitPrice =
    totalArea && price ? Math.round((price / totalArea) * 100) / 100 : undefined;
  const unitPriceUsd =
    totalArea && priceUsd
      ? Math.round((priceUsd / totalArea) * 100) / 100
      : undefined;

  const payload: SsgeDraftPayload = {
    realEstateTypeId,
    realEstateDealTypeId,
    cityId: location.cityId,
    subdistrictId: location.subdistrictId,
    streetId: location.streetId,
    streetNumber: listing.streetNumber?.trim() || "0",
    currencyId,
    showSiteCurrencyId,
    priceType: 1,
    moderationBlockCategories: null,
    realEstateApplicationId: applicationId,
    rooms,
    bedrooms,
    toilet: reverseSsgeToiletId(
      listing.bathrooms || raw["სველი წერტილი"] || raw["სვ.წერტილი"] || ""
    ),
    status: reverseSsgeBuildingStatusId(
      listing.buildingStatus,
      raw,
      listing.propertyType
    ),
    project: reverseSsgeProjectId(listing.projectType, raw),
    state: reverseSsgeConditionId(listing.condition, raw),
    totalArea: totalArea ?? null,
    areaOfHouse: parseNum(raw["სახლის ფართი"]) ?? null,
    areaOfYard: parseNum(raw["ეზოს ფართი"]) ?? null,
    kitchenArea: parseNum(raw["სამზარეულოს ფართი"]) ?? null,
    floor: parseIntField(listing.floor) ?? (listing.floor?.trim() || null),
    floors: parseIntField(listing.totalFloors) ?? null,
    price: price ?? null,
    priceUsd: priceUsd ?? null,
    unitPrice: unitPrice ?? null,
    unitPriceUsd: unitPriceUsd ?? null,
    descriptionGe: listing.description?.trim() || null,
    cadastralCode: listing.cadastralCode?.trim() || null,
    commercialRealEstateType:
      reverseSsgeCommercialTypeId(listing.propertyType, raw) ?? 0,
    images,
  };

  const landType = reverseSsgeLandTypeId(listing.propertyType, raw);
  if (landType) payload.landType = landType;

  applyAmenities(payload, raw);

  const phone = extractPhone(listing);
  if (phone.length >= 9) {
    payload.phoneNumbers = [
      {
        phoneNumber: phone,
        isMain: true,
        hasViber: true,
        hasWhatsapp: true,
        isApproved: false,
      },
    ];
  }

  return payload;
}
