/** კერძო სახლი / აგარაკი — ss.ge shows house size as სახლის ფართი, not საერთო ფართი. */
export function isHouseLikePropertyType(
  propertyType: string | null | undefined
): boolean {
  const pt = (propertyType ?? "").trim();
  return /კერძო\s*სახლი|აგარაკი/i.test(pt);
}

export function extractAreaDigits(value: string | null | undefined): string {
  const v = (value ?? "").replace(/\s+/g, " ").trim();
  if (!v) return "";
  const m = v.match(/([\d]+(?:[.,]\d+)?)/);
  return m ? m[1].replace(",", ".") : "";
}

/**
 * Area shown in Quick specs (m²) and stored on listing.area when appropriate.
 * For houses, prefer rawData["სახლის ფართი"] over empty or lot-only total area.
 */
export function resolveListingDisplayArea(
  area: string | null | undefined,
  propertyType: string | null | undefined,
  rawData?: Record<string, string> | null
): string {
  const general = extractAreaDigits(area);
  const houseDigits = extractAreaDigits(rawData?.["სახლის ფართი"]);

  if (isHouseLikePropertyType(propertyType)) {
    return houseDigits || general;
  }
  return general || houseDigits;
}
