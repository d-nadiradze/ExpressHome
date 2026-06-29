/**
 * Reverse lookups: Georgian listing labels → ss.ge API numeric ids.
 */
import {
  resolveSsgeCommercialTypeChip,
  resolveSsgeProjectChip,
  resolveSsgeStatusChip,
  resolveSsgeConditionChip,
  isCommercialPropertyType,
} from "@/lib/ssge-mappings";
import {
  SSGE_BUILDING_STATUS,
  SSGE_COMMERCIAL_TYPE,
  SSGE_CONDITION,
  SSGE_DEAL_TYPE,
  SSGE_LAND_TYPE,
  SSGE_PROJECT_TYPE,
  SSGE_PROPERTY_TYPE,
  SSGE_TOILET,
} from "@/lib/ssge-api-constants";
import { reverseByLabel } from "@/lib/myhome-api-reverse";

export { reverseByLabel };

export function reverseSsgePropertyTypeId(propertyType: string): number | undefined {
  const pt = (propertyType || "").trim();
  if (!pt) return undefined;
  const direct = reverseByLabel(SSGE_PROPERTY_TYPE, pt);
  if (direct) return direct;
  if (/ბინა/i.test(pt)) return 5;
  if (/კერძო\s*სახლ/i.test(pt)) return 4;
  if (/აგარაკ/i.test(pt)) return 1;
  if (/მიწ/i.test(pt)) return 3;
  if (isCommercialPropertyType(pt)) return 6;
  return undefined;
}

export function reverseSsgeDealTypeId(dealType: string): number | undefined {
  const dt = (dealType || "").trim();
  if (!dt) return undefined;
  if (/ქირავდება\s*დღიურად/i.test(dt)) return 3;
  if (/ქირავდება/i.test(dt)) return 1;
  if (/გირავდება/i.test(dt)) return 2;
  if (/იყიდება/i.test(dt)) return 4;
  return reverseByLabel(SSGE_DEAL_TYPE, dt);
}

export function reverseSsgeCurrencyIds(currency: string): {
  currencyId: number;
  showSiteCurrencyId: number;
} {
  const c = (currency || "USD").trim().toUpperCase();
  if (c === "GEL" || c === "₾") {
    return { currencyId: 1, showSiteCurrencyId: 1 };
  }
  return { currencyId: 2, showSiteCurrencyId: 2 };
}

export function reverseSsgeBuildingStatusId(
  buildingStatus: string,
  rawData?: Record<string, string> | null,
  propertyType?: string
): number | undefined {
  const fromListing = resolveSsgeStatusChip(
    buildingStatus || rawData?.["სტატუსი"] || "",
    propertyType
  );
  if (fromListing) {
    const id = reverseByLabel(SSGE_BUILDING_STATUS, fromListing);
    if (id !== undefined) return id;
  }
  return reverseByLabel(SSGE_BUILDING_STATUS, buildingStatus);
}

export function reverseSsgeConditionId(
  condition: string,
  rawData?: Record<string, string> | null
): number | undefined {
  const label = resolveSsgeConditionChip(
    condition || rawData?.["მდგომარეობა"] || ""
  );
  if (label) {
    const id = reverseByLabel(SSGE_CONDITION, label);
    if (id !== undefined) return id;
  }
  return reverseByLabel(SSGE_CONDITION, condition);
}

export function reverseSsgeProjectId(
  projectType: string,
  rawData?: Record<string, string> | null
): number | undefined {
  const label = resolveSsgeProjectChip(
    projectType || rawData?.["პროექტი"] || rawData?.["პროექტის ტიპი"] || "",
    rawData || {}
  );
  if (label) {
    const id = reverseByLabel(SSGE_PROJECT_TYPE, label);
    if (id !== undefined) return id;
  }
  return reverseByLabel(SSGE_PROJECT_TYPE, projectType);
}

export function reverseSsgeToiletId(bathrooms: string): number | undefined {
  const s = (bathrooms || "").trim();
  if (!s) return undefined;
  if (/საერთო/i.test(s)) return 422;
  if (/3\+|3\s*\+/i.test(s)) return 421;
  const n = parseInt(s.match(/(\d+)/)?.[1] || s, 10);
  if (n === 1) return 418;
  if (n === 2) return 419;
  if (n === 3) return 420;
  if (n >= 4) return 421;
  return reverseByLabel(SSGE_TOILET, s);
}

export function reverseSsgeCommercialTypeId(
  propertyType: string,
  rawData?: Record<string, string> | null
): number | undefined {
  if (!isCommercialPropertyType(propertyType)) return undefined;
  const chip = resolveSsgeCommercialTypeChip(
    rawData?.["კომერციული ფართის ტიპი"] ||
      rawData?.["სტატუსი"] ||
      propertyType
  );
  if (chip) {
    const id = reverseByLabel(SSGE_COMMERCIAL_TYPE, chip);
    if (id !== undefined) return id;
  }
  return 31;
}

export function reverseSsgeLandTypeId(
  propertyType: string,
  rawData?: Record<string, string> | null
): number | undefined {
  if (!/მიწ/i.test(propertyType || "")) return undefined;
  const status =
    rawData?.["მიწის ნაკვეთი"] || rawData?.["სტატუსი"] || "";
  return reverseByLabel(SSGE_LAND_TYPE, status);
}

export function reverseSsgeCityId(city: string): number {
  const c = (city || "თბილისი").trim();
  const id = reverseByLabel(
    Object.fromEntries(
      Object.entries({ 95: "თბილისი", 96: "ბათუმი", 73: "ქუთაისი", 79: "რუსთავი" })
    ),
    c
  );
  return id ?? 95;
}
