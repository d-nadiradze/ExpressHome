/**
 * Extract city/street from ss.ge listing description when structured address is wrong.
 * Common case: address.cityTitle = თბილისი but description says
 * "ლოკაცია: სიღნაღის ცენტრი, ბიძინა კვერნაძის ქუჩა N9".
 */
import { cityForPrefill, KNOWN_CITIES_FOR_PREFILL } from "@/lib/location-prefill";
import type { MyhomeListing } from "@/lib/myhome-parser";

function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export interface DescriptionLocation {
  city?: string;
  street?: string;
  streetNumber?: string;
}

function cityFromLocationPart(raw: string): string {
  const s = norm(raw);
  if (!s) return "";

  const direct = cityForPrefill(s);
  if ((KNOWN_CITIES_FOR_PREFILL as readonly string[]).includes(direct)) {
    return direct;
  }

  const lower = s.toLowerCase();
  for (const c of KNOWN_CITIES_FOR_PREFILL) {
    const cl = c.toLowerCase();
    if (lower.includes(cl)) return c;
    // Inflected form: სიღნაღის ცენტრი → სიღნაღი
    const stem = cl.slice(0, Math.max(3, cl.length - 1));
    if (stem.length >= 3 && lower.includes(stem)) return c;
  }

  return direct;
}

/** Parse explicit "ლოკაცია:" / "მისამართი:" line from free-text description. */
export function extractDescriptionLocation(
  description: string
): DescriptionLocation {
  const text = norm(description);
  if (!text) return {};

  const m = text.match(/(?:ლოკაცია|მისამართი)\s*[:\-]\s*([^.!?\n]+)/iu);
  if (!m?.[1]) return {};

  let line = norm(m[1]);
  line = line
    .split(
      /(?:საკადასტრო\s+კოდი|ყველა\s+ოთახის|მთავარი\s+მახასიათებლები|დამატებითი\s+ინფორმაცია)/iu
    )[0]
    .trim();
  if (!line) return {};

  const parts = line.split(",").map((x) => norm(x)).filter(Boolean);
  const city = cityFromLocationPart(parts[0] || line) || undefined;

  const streetChunk = parts[1] || "";
  let street = "";
  let streetNumber = "";
  if (streetChunk) {
    const n = streetChunk.match(/\b(?:n|N|№)\s*([\dა-ჰA-Za-z\-\/]+)/u);
    if (n?.[1]) streetNumber = n[1];
    street = streetChunk
      .replace(/\b(?:n|N|№)\s*[\dა-ჰA-Za-z\-\/]+/gu, "")
      .replace(/\s*\([^)]*\)\s*/gu, " ")
      .trim();
  }

  return {
    city: city || undefined,
    street: street || undefined,
    streetNumber: streetNumber || undefined,
  };
}

/**
 * When description location disagrees with structured city (or street is empty),
 * prefer the explicit ლოკაცია line from the listing text.
 */
export function applySsgeDescriptionLocationFix(
  listing: MyhomeListing
): MyhomeListing {
  const descLoc = extractDescriptionLocation(listing.description || "");
  if (!descLoc.city && !descLoc.street) return listing;

  let city = listing.city?.trim() || "";
  let street = listing.street?.trim() || "";
  let streetNumber = listing.streetNumber?.trim() || "";
  let address = listing.address?.trim() || "";

  if (descLoc.city) {
    const normalizedDescCity = cityForPrefill(descLoc.city);
    const normalizedCurrent = cityForPrefill(city);
    if (
      !city ||
      (normalizedDescCity &&
        normalizedCurrent &&
        normalizedDescCity !== normalizedCurrent)
    ) {
      city = descLoc.city;
    }
  }

  if (!street && descLoc.street) street = descLoc.street;
  if (!streetNumber && descLoc.streetNumber) streetNumber = descLoc.streetNumber;

  if (street) {
    address = streetNumber ? `${street} ${streetNumber}` : street;
  }

  if (
    city === listing.city &&
    street === listing.street &&
    streetNumber === listing.streetNumber &&
    address === listing.address
  ) {
    return listing;
  }

  return {
    ...listing,
    city,
    street,
    streetNumber,
    address,
  };
}
