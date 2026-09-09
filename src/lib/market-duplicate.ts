import {
  MARKET_AREA_TOLERANCE_M2,
  MARKET_CITY_KA,
} from "@/lib/market-constants";
import { extractAreaDigits } from "@/lib/listing-area";
import { normalizeStreetForMatch } from "@/lib/street-dictionary";

export type DuplicateMatchReason = "cadastral" | "address";

export type DuplicateListingFields = {
  id?: string;
  sellerType: string;
  propertyType: string;
  city?: string | null;
  street?: string | null;
  streetNumber?: string | null;
  area?: string | null;
  floor?: string | null;
  cadastralCode?: string | null;
};

export function normalizeCadastral(value: string | null | undefined): string {
  return (value ?? "").replace(/[^\d.]/g, "").replace(/\.+/g, ".").replace(/^\.|\.$/g, "").trim();
}

export function normalizeHouseNumber(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[#№]/g, "")
    .replace(/\s+/g, "")
    .trim();
}

export function normalizeFloor(value: string | null | undefined): string {
  const digits = (value ?? "").replace(/[^\d-]/g, "");
  if (!digits) return "";
  const n = parseInt(digits, 10);
  return Number.isFinite(n) ? String(n) : "";
}

export function parseAreaM2(value: string | null | undefined): number | null {
  const digits = extractAreaDigits(value);
  if (!digits) return null;
  const n = parseFloat(digits);
  return Number.isFinite(n) ? n : null;
}

function cityKey(value: string | null | undefined): string {
  const v = (value ?? "").trim().toLowerCase();
  if (!v || v === MARKET_CITY_KA.toLowerCase() || v === "tbilisi") return MARKET_CITY_KA;
  return v;
}

export function cadastralDuplicate(
  a: DuplicateListingFields,
  b: DuplicateListingFields
): boolean {
  const left = normalizeCadastral(a.cadastralCode);
  const right = normalizeCadastral(b.cadastralCode);
  return Boolean(left) && left === right;
}

export function addressDuplicate(
  a: DuplicateListingFields,
  b: DuplicateListingFields
): boolean {
  if ((a.propertyType || "").trim() !== (b.propertyType || "").trim()) return false;
  if (cityKey(a.city) !== cityKey(b.city)) return false;

  const streetA = normalizeStreetForMatch(a.street);
  const streetB = normalizeStreetForMatch(b.street);
  if (!streetA || streetA !== streetB) return false;

  const numA = normalizeHouseNumber(a.streetNumber);
  const numB = normalizeHouseNumber(b.streetNumber);
  if (!numA || numA !== numB) return false;

  const floorA = normalizeFloor(a.floor);
  const floorB = normalizeFloor(b.floor);
  if (!floorA || floorA !== floorB) return false;

  const areaA = parseAreaM2(a.area);
  const areaB = parseAreaM2(b.area);
  if (areaA == null || areaB == null) return false;
  return Math.abs(areaA - areaB) <= MARKET_AREA_TOLERANCE_M2;
}

export function listingsAreDuplicates(
  a: DuplicateListingFields,
  b: DuplicateListingFields
): DuplicateMatchReason | null {
  if (cadastralDuplicate(a, b)) return "cadastral";
  if (addressDuplicate(a, b)) return "address";
  return null;
}

export function isAgencyLike(sellerType: string): boolean {
  return sellerType === "AGENCY" || sellerType === "AGENT";
}

export function findAgencyDuplicate<T extends DuplicateListingFields>(
  owner: T,
  agencies: T[]
): { listing: T; reason: DuplicateMatchReason } | null {
  for (const agency of agencies) {
    if (owner.id && agency.id && owner.id === agency.id) continue;
    const reason = listingsAreDuplicates(owner, agency);
    if (reason) return { listing: agency, reason };
  }
  return null;
}

/**
 * Bucket key for address matching. Area is excluded because it matches with a
 * ±2 m² tolerance, so it is compared inside the bucket instead of keyed on.
 * Returns null when the row lacks the fields address matching requires.
 */
export function addressBucketKey(
  listing: DuplicateListingFields
): string | null {
  const street = normalizeStreetForMatch(listing.street);
  const number = normalizeHouseNumber(listing.streetNumber);
  const floor = normalizeFloor(listing.floor);
  if (!street || !number || !floor) return null;
  if (parseAreaM2(listing.area) == null) return null;
  return [
    (listing.propertyType || "").trim(),
    cityKey(listing.city),
    street,
    number,
    floor,
  ].join("|");
}

export type AgencyIndex<T extends DuplicateListingFields> = {
  byCadastral: Map<string, T>;
  byAddress: Map<string, T[]>;
};

/**
 * Pre-groups agency/agent rows so each owner is checked against a handful of
 * candidates instead of every agency row (the poll was O(owners × agencies)).
 */
export function buildAgencyIndex<T extends DuplicateListingFields>(
  agencies: Iterable<T>
): AgencyIndex<T> {
  const byCadastral = new Map<string, T>();
  const byAddress = new Map<string, T[]>();

  for (const agency of agencies) {
    const cadastral = normalizeCadastral(agency.cadastralCode);
    if (cadastral && !byCadastral.has(cadastral)) {
      byCadastral.set(cadastral, agency);
    }

    const key = addressBucketKey(agency);
    if (key) {
      const bucket = byAddress.get(key);
      if (bucket) bucket.push(agency);
      else byAddress.set(key, [agency]);
    }
  }

  return { byCadastral, byAddress };
}

/** Same verdict as findAgencyDuplicate, but cadastral-first and index-backed. */
export function findAgencyDuplicateIndexed<T extends DuplicateListingFields>(
  owner: T,
  index: AgencyIndex<T>
): { listing: T; reason: DuplicateMatchReason } | null {
  const cadastral = normalizeCadastral(owner.cadastralCode);
  if (cadastral) {
    const hit = index.byCadastral.get(cadastral);
    if (hit && !(owner.id && hit.id === owner.id)) {
      return { listing: hit, reason: "cadastral" };
    }
  }

  const key = addressBucketKey(owner);
  if (key) {
    for (const candidate of index.byAddress.get(key) ?? []) {
      if (owner.id && candidate.id === owner.id) continue;
      if (addressDuplicate(owner, candidate)) {
        return { listing: candidate, reason: "address" };
      }
    }
  }

  return null;
}
