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
