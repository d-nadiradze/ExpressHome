/**
 * Normalize listings parsed on one platform for prefill on the other.
 *
 * Shared model: `MyhomeListing` (used by both ss.ge and myhome.ge parsers).
 * - ss.ge → myhome: https://statements.myhome.ge/ka/statement/create
 * - myhome → ss.ge: https://home.ss.ge/ka/udzravi-qoneba/create
 */

import type { MyhomeListing } from "@/lib/myhome-parser";
import {
  CONDITION_TO_SSGE,
  isKnownLandPlotStatus,
  mapLandPlotStatusForMyhome,
  mapLandPlotStatusForSsge,
  PROPERTY_TYPE_TO_SSGE,
  VIEW_TO_SSGE,
  applyProjectTypeDefaults,
} from "@/lib/ssge-mappings";
import { cityForPrefill } from "@/lib/location-prefill";
import {
  applyMyhomeAmenityAliasesToSsgeRaw,
  applySsgeAmenityAliasesToMyhomeRaw,
  applySsgeBalconyDefaultsForMyhome,
  applySsgeBalconyDefaultsForSsgePrefill,
  isTruthyAmenityValue,
} from "@/lib/platform-amenity-mappings";
import { applyStreetCrossfill } from "@/lib/street-crossfill";
import { sanitizeBuildingStatusValue } from "@/lib/building-status-sanitize";

const SSGE_HOST = /(?:^|\/\/)(?:[^/]+\.)?ss\.ge\b/i;
const MYHOME_HOST = /(?:^|\/\/)(?:[^/]+\.)?myhome\.ge\b/i;

export function isSsgeSourceUrl(url: string | null | undefined): boolean {
  return !!url && SSGE_HOST.test(url);
}

export function isMyhomeSourceUrl(url: string | null | undefined): boolean {
  return !!url && MYHOME_HOST.test(url);
}

/** ss.ge property chip → myhome create-form chip. */
const SSGE_TO_MYHOME_PROPERTY_TYPE: Record<string, string> = {
  ბინა: "ბინა",
  "კერძო სახლი": "კერძო სახლი",
  აგარაკი: "აგარაკი",
  "მიწის ნაკვეთი": "მიწის ნაკვეთი",
  კომერციული: "კომერციული ფართი",
  "კომერციული ფართი": "კომერციული ფართი",
  სასტუმრო: "სასტუმრო",
};

/** ss.ge / shared → myhome condition chip labels. */
const SSGE_TO_MYHOME_CONDITION: Record<string, string> = {
  გარემონტებული: "ახალი გარემონტებული",
  "ახალი რემონტით": "ახალი გარემონტებული",
  "ახალი გარემონტებული": "ახალი გარემონტებული",
  "ახალი რემონტი": "ახალი გარემონტებული",
  "ძველი რემონტით": "ძველი გარემონტებული",
  "ძველი გარემონტებული": "ძველი გარემონტებული",
  "ძველი რემონტი": "ძველი გარემონტებული",
  "მიმდინარე რემონტი": "მიმდინარე რემონტი",
  სარემონტო: "სარემონტო",
  "თეთრი კარკასი": "თეთრი კარკასი",
  "შავი კარკასი": "შავი კარკასი",
  "მწვანე კარკასი": "მწვანე კარკასი",
};

const PARKING_MEANS_GARAGE =
  /ავტოფარეხ|გარაჟ|პარკინგ|პარკირებ/i;

/** ss.ge „სხვა ინფორმაცია“ / comment chips → myhome rawData["ხედი"]. */
const SSGE_VIEW_CHIP_LABELS = [
  "ხედი ეზოზე",
  "ხედი ქუჩაზე",
  "ნათელი",
  "მყუდრო",
  "მცხელო",
] as const;

function mapPropertyTypeForMyhome(value: string): string {
  const v = value.trim();
  if (!v) return "";
  return SSGE_TO_MYHOME_PROPERTY_TYPE[v] || v;
}

function mapConditionForMyhome(value: string): string {
  const v = value.trim();
  if (!v) return "";
  if (SSGE_TO_MYHOME_CONDITION[v]) return SSGE_TO_MYHOME_CONDITION[v];
  if (/გარემონტებული/i.test(v)) {
    if (/ახალი/i.test(v)) return "ახალი გარემონტებული";
    if (/ძველი/i.test(v)) return "ძველი გარემონტებული";
    return "ახალი გარემონტებული";
  }
  if (/რემონტ/i.test(v)) {
    if (/ახალი/i.test(v)) return "ახალი გარემონტებული";
    if (/ძველი/i.test(v)) return "ძველი გარემონტებული";
    if (/მიმდინარე/i.test(v)) return "მიმდინარე რემონტი";
    if (/სარემონტო/i.test(v)) return "სარემონტო";
  }
  return v;
}

function isLandPlotListing(listing: MyhomeListing): boolean {
  const pt = (listing.propertyType || "").trim();
  if (/მიწის\s*ნაკვეთი/i.test(pt)) return true;
  const land =
    listing.rawData?.["მიწის ნაკვეთი"]?.trim() ||
    listing.buildingStatus?.trim() ||
    listing.rawData?.["სტატუსი"]?.trim() ||
    "";
  return isKnownLandPlotStatus(land) || /მიწა$/i.test(land);
}

function mergeSsgeViewsIntoMyhomeRaw(raw: Record<string, string>): void {
  const parts = new Set<string>();
  const existing = raw["ხედი"]?.trim();
  if (existing) {
    for (const p of existing.split(/[,;]/)) {
      const t = p.trim();
      if (t) parts.add(t);
    }
  }
  for (const label of SSGE_VIEW_CHIP_LABELS) {
    if (raw[label] === "კი" || isTruthyAmenityValue(raw[label])) {
      parts.add(label);
      delete raw[label];
    }
  }
  if (parts.size) raw["ხედი"] = [...parts].join(", ");
}

function applySsgeParkingAndProject(
  listing: MyhomeListing,
  rawData: Record<string, string>
): { projectType: string } {
  const projectType = applyProjectTypeDefaults(
    rawData,
    listing.projectType || "",
    { propertyType: listing.propertyType }
  );

  if (
    (rawData["გარაჟი"] === "კი" || rawData["პარკინგი"] === "კი") &&
    !rawData["პარკირება"]
  ) {
    rawData["პარკირება"] = "ავტოფარეხი";
  }

  if (rawData["ავეჯი"] === "კი") {
    rawData["ავეჯი"] = "კი";
  }

  if (
    rawData["ჩაშენებული სამზარეულო"] === "კი" &&
    rawData["სამზარეულო + ტექნიკა"] !== "კი"
  ) {
    rawData["სამზარეულო + ტექნიკა"] = "კი";
  }

  return { projectType };
}

function resolveBuildingStatusForMyhome(
  buildingStatus: string,
  rawData: Record<string, string>
): string {
  const status = sanitizeBuildingStatusValue(
    buildingStatus.trim() ||
      rawData["სტატუსი"]?.trim() ||
      ""
  );
  if (!status || isKnownLandPlotStatus(status)) return "";
  return status;
}

/**
 * Prepare a listing parsed from ss.ge (or unknown source) for myhome.ge statement create prefill.
 */
export function normalizeListingForMyhomePrefill(
  listing: MyhomeListing,
  options?: { sourceUrl?: string | null }
): MyhomeListing {
  if (options?.sourceUrl && isMyhomeSourceUrl(options.sourceUrl)) {
    return listing;
  }

  const rawData = applySsgeAmenityAliasesToMyhomeRaw(listing.rawData || {});
  applySsgeBalconyDefaultsForMyhome(rawData);
  mergeSsgeViewsIntoMyhomeRaw(rawData);
  const { projectType } = applySsgeParkingAndProject(listing, rawData);

  let propertyType = mapPropertyTypeForMyhome(listing.propertyType || "");
  let buildingStatus = resolveBuildingStatusForMyhome(
    listing.buildingStatus || "",
    rawData
  );
  let condition = mapConditionForMyhome(
    listing.condition?.trim() || rawData["მდგომარეობა"]?.trim() || ""
  );

  const landTypeRaw =
    rawData["მიწის ნაკვეთი"]?.trim() ||
    (isKnownLandPlotStatus(buildingStatus) ? buildingStatus : "") ||
    (isKnownLandPlotStatus(rawData["სტატუსი"]) ? rawData["სტატუსი"] : "");
  const landType = landTypeRaw ? mapLandPlotStatusForMyhome(landTypeRaw) : "";

  if (isLandPlotListing({ ...listing, propertyType, rawData }) || landType) {
    propertyType = propertyType || "მიწის ნაკვეთი";
    if (landType) {
      rawData["მიწის ნაკვეთი"] = landType;
      buildingStatus = "";
      delete rawData["სტატუსი"];
    }
  } else if (buildingStatus && isKnownLandPlotStatus(buildingStatus)) {
    rawData["მიწის ნაკვეთი"] = mapLandPlotStatusForMyhome(buildingStatus);
    buildingStatus = "";
  }

  let area = listing.area?.trim() || "";
  const houseArea = rawData["სახლის ფართი"]?.trim();
  if (!area && houseArea) area = houseArea.replace(/[^\d.]/g, "");

  const city = cityForPrefill(listing.city || rawData["მდებარეობა"] || "");

  if (condition) rawData["მდგომარეობა"] = condition;
  if (buildingStatus && !isKnownLandPlotStatus(buildingStatus)) {
    rawData["სტატუსი"] = buildingStatus;
  }

  const yard = rawData["ეზოს ფართი"]?.trim();
  if (yard && !rawData["ეზო"]) rawData["ეზო"] = "კი";

  let pricePerSqm = listing.pricePerSqm?.trim() || "";
  if (!pricePerSqm && listing.price && area) {
    const p = parseFloat(listing.price.replace(/[^\d.]/g, ""));
    const a = parseFloat(area);
    if (p > 0 && a > 0) pricePerSqm = String(Math.round(p / a));
  }

  console.log(
    `[cross-prefill] ss.ge → myhome: type="${propertyType}", city="${city}", ` +
      `area=${area}, status="${buildingStatus || "-"}", project="${projectType || "-"}", ` +
      `views="${rawData["ხედი"] || "-"}", condition="${condition || "-"}"`
  );

  const balconyArea =
    rawData["აივნის ფართი"]?.trim() || listing.balconyArea?.trim() || "";

  const streetCrossfill = applyStreetCrossfill(
    {
      street: listing.street,
      address: listing.address,
      rawData,
    },
    "myhome"
  );

  return {
    ...listing,
    propertyType,
    dealType: listing.dealType?.trim() || "",
    buildingStatus: isLandPlotListing({ ...listing, propertyType, rawData })
      ? ""
      : buildingStatus,
    condition,
    projectType,
    city,
    street: streetCrossfill.street,
    area,
    pricePerSqm,
    balconyArea,
    currency: listing.currency?.trim() || "USD",
    rawData: streetCrossfill.rawData,
  };
}

/** myhome property type → ss.ge create-form chip (inverse of PROPERTY_TYPE_TO_SSGE). */
export function mapPropertyTypeForSsge(value: string): string {
  const v = value.trim();
  if (!v) return "";
  if (PROPERTY_TYPE_TO_SSGE[v]) return PROPERTY_TYPE_TO_SSGE[v];
  if (v === "კომერციული ფართი" || v === "კომერციული") return "კომერციული";
  return v;
}

/** myhome condition → ss.ge chip label. */
export function mapConditionForSsge(value: string): string {
  const v = value.trim();
  if (!v) return "";
  for (const [myhome, ssge] of Object.entries(CONDITION_TO_SSGE)) {
    if (v === myhome) return ssge;
  }
  if (/გარემონტებული/i.test(v)) return CONDITION_TO_SSGE["გარემონტებული"] || v;
  if (/ახალი/i.test(v) && /რემონტ/i.test(v)) {
    return CONDITION_TO_SSGE["ახალი გარემონტებული"] || "ახალი რემონტით";
  }
  if (/ძველი/i.test(v) && /რემონტ/i.test(v)) {
    return CONDITION_TO_SSGE["ძველი გარემონტებული"] || "ძველი რემონტით";
  }
  return v;
}

function applyMyhomeParkingForSsge(raw: Record<string, string>): void {
  const parking = raw["პარკირება"]?.trim() || "";
  if (parking && PARKING_MEANS_GARAGE.test(parking)) {
    raw["გარაჟი"] = "კი";
  }
}

function normalizeViewsForSsge(raw: Record<string, string>): void {
  const parts = new Set<string>();
  const existing = raw["ხედი"]?.trim();
  if (existing) {
    for (const p of existing.split(/[,;]/)) {
      const t = p.trim();
      if (t) parts.add(t);
    }
  }
  for (const label of Object.keys(VIEW_TO_SSGE)) {
    if (raw[label] === "კი" || isTruthyAmenityValue(raw[label])) {
      parts.add(label);
      delete raw[label];
    }
  }
  if (parts.size) raw["ხედი"] = [...parts].join(", ");
}

function pickNumericField(...values: (string | undefined)[]): string {
  for (const v of values) {
    const t = v?.trim();
    if (!t) continue;
    const m = t.match(/(\d+)/);
    if (m) return m[1];
  }
  return "";
}

/**
 * Prepare a listing parsed from myhome.ge for ss.ge create prefill.
 */
export function normalizeListingForSsgePrefill(
  listing: MyhomeListing,
  options?: { sourceUrl?: string | null }
): MyhomeListing {
  if (options?.sourceUrl && isSsgeSourceUrl(options.sourceUrl)) {
    const bedrooms = pickNumericField(
      listing.bedrooms,
      listing.rawData?.["საძინებელი"]
    );
    const rooms = pickNumericField(
      listing.rooms,
      listing.rawData?.["ოთახი"],
      listing.rawData?.["ოთახები"]
    );
    if (!bedrooms && !rooms) return listing;
    return {
      ...listing,
      bedrooms: bedrooms || listing.bedrooms,
      rooms: rooms || listing.rooms,
    };
  }

  const rawData = applyMyhomeAmenityAliasesToSsgeRaw(listing.rawData || {});
  applySsgeBalconyDefaultsForSsgePrefill(rawData);
  applyMyhomeParkingForSsge(rawData);
  normalizeViewsForSsge(rawData);

  const propertyType = mapPropertyTypeForSsge(listing.propertyType || "");
  const dealType = listing.dealType?.trim() || "";

  let buildingStatus =
    listing.buildingStatus?.trim() || rawData["სტატუსი"]?.trim() || "";
  const landTypeRaw = rawData["მიწის ნაკვეთი"]?.trim() || "";
  const landTypeSsge = landTypeRaw
    ? mapLandPlotStatusForSsge(landTypeRaw)
    : "";

  if (isKnownLandPlotStatus(buildingStatus)) {
    rawData["მიწის ნაკვეთი"] = mapLandPlotStatusForSsge(buildingStatus);
    buildingStatus = "";
  } else if (landTypeSsge && isKnownLandPlotStatus(landTypeRaw)) {
    rawData["მიწის ნაკვეთი"] = landTypeSsge;
  } else if (buildingStatus) {
    rawData["სტატუსი"] = buildingStatus;
    delete rawData["მიწის ნაკვეთი"];
  }

  const condition = mapConditionForSsge(
    listing.condition?.trim() || rawData["მდგომარეობა"]?.trim() || ""
  );
  if (condition) rawData["მდგომარეობა"] = condition;

  const projectType = applyProjectTypeDefaults(
    rawData,
    listing.projectType || "",
    { propertyType }
  );

  let area = listing.area?.trim() || "";
  const houseArea = rawData["სახლის ფართი"]?.trim();
  if (!area && houseArea) area = houseArea.replace(/[^\d.]/g, "");

  const city = cityForPrefill(
    listing.city || rawData["მდებარეობა"] || ""
  );

  const rooms = pickNumericField(listing.rooms, rawData["ოთახი"]);
  const bedrooms = pickNumericField(
    listing.bedrooms,
    rawData["საძინებელი"]
  );
  const bathrooms = pickNumericField(
    listing.bathrooms,
    rawData["სვ.წერტილი"],
    rawData["სველი წერტილი"]
  );

  let streetNumber =
    listing.streetNumber?.trim() || rawData["ქუჩის ნომერი"]?.trim() || "";

  const streetCrossfill = applyStreetCrossfill(
    {
      street: listing.street,
      address: listing.address,
      rawData,
    },
    "ssge"
  );
  const street = streetCrossfill.street;

  if (rawData["ეზო"] === "კი" && rawData["ეზოს ფართი"]) {
    /* yard toggle uses ეზო key */
  }

  console.log(
    `[cross-prefill] myhome → ss.ge: type="${propertyType}", city="${city}", ` +
      `area=${area || "-"}, status="${buildingStatus || landTypeSsge || "-"}", ` +
      `project="${projectType || "-"}", views="${rawData["ხედი"] || "-"}", ` +
      `condition="${condition || "-"}"`
  );

  return {
    ...listing,
    propertyType,
    dealType,
    buildingStatus: isKnownLandPlotStatus(landTypeRaw) ? "" : buildingStatus,
    condition,
    projectType,
    city,
    street,
    streetNumber,
    area,
    rooms,
    bedrooms,
    bathrooms,
    currency: listing.currency?.trim() || "USD",
    rawData: streetCrossfill.rawData,
  };
}

/** Split myhome rawData["ხედი"] into ss.ge view chip labels. */
export function ssgeViewChipsFromRawData(
  rawData: Record<string, string> | undefined | null
): string[] {
  const raw = rawData?.["ხედი"]?.trim();
  if (!raw) return [];
  const chips: string[] = [];
  for (const part of raw.split(/[,;]/)) {
    const t = part.trim();
    if (!t) continue;
    const mapped = VIEW_TO_SSGE[t] || t;
    if (VIEW_TO_SSGE[t] || Object.values(VIEW_TO_SSGE).includes(mapped)) {
      chips.push(mapped);
    }
  }
  return [...new Set(chips)];
}
