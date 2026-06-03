/**
 * Building status (სტატუსი) values scraped from ss.ge / myhome listing pages are
 * sometimes glued: label + chip + duplicate chip with no spaces, e.g.
 * „სტატუსიძველი აშენებულიძველი აშენებული“ → „ძველი აშენებული“.
 */

export const KNOWN_BUILDING_STATUS_CHIPS = [
  "ახალი აშენებული",
  "ძველი აშენებული",
  "მშენებარე",
] as const;

function dedupeRepeatedHalf(value: string): string {
  const v = value.replace(/\s+/g, " ").trim();
  if (!v) return "";
  for (let len = Math.floor(v.length / 2); len >= 3; len--) {
    if (v.slice(0, len) === v.slice(len, len * 2)) return v.slice(0, len);
  }
  return v;
}

function compactGeorgian(s: string): string {
  return s.replace(/\s+/g, "");
}

/** Normalize scraped / cross-prefilled building status to a single known chip label. */
export function sanitizeBuildingStatusValue(value: string): string {
  let v = dedupeRepeatedHalf((value || "").replace(/\s+/g, " ").trim());
  if (!v) return "";

  const compactAll = compactGeorgian(v);
  if (compactAll.startsWith("სტატუსი")) {
    v = dedupeRepeatedHalf(
      v.replace(/^სტატუსი\s*/iu, "").trim() ||
        compactAll.replace(/^სტატუსი/iu, "")
    );
  }

  const compact = compactGeorgian(v);
  for (const chip of KNOWN_BUILDING_STATUS_CHIPS) {
    if (v === chip) return chip;
    const chipCompact = compactGeorgian(chip);
    if (compact === chipCompact + chipCompact) return chip;
    if (compact.startsWith(chipCompact)) {
      const tail = compact.slice(chipCompact.length);
      if (tail === chipCompact) return chip;
    }
  }

  return dedupeRepeatedHalf(v);
}
