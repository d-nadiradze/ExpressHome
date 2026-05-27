/** Shared Tbilisi district knowledge for listing parse + street prefill disambiguation. */

export interface ListingDistrictSource {
  title?: string;
  street?: string;
  address?: string;
  rawData?: Record<string, string>;
}

export interface ParserDistrict {
  /** Canonical district name shown in myhome street autocomplete options. */
  name: string;
  city: string;
  /** Phrases that indicate this district in listing titles / descriptions. */
  titleMarkers: string[];
  /** Street name cores that belong to this district (without trailing ქ./ქუჩა). */
  streets: string[];
  /** Substrings for wrong duplicate street options in other districts. */
  conflictingMarkers?: string[];
}

/** Expandable registry — add districts here as parser coverage grows. */
export const PARSER_DISTRICTS: ParserDistrict[] = [
  {
    name: "დიდი დიღომი",
    city: "თბილისი",
    titleMarkers: [
      "დიდი დიღომი",
      "დიდი დიღომში",
      "დიდი დიღომზე",
      "დიდი დიღომის",
      "დიდ დიღომი",
      "დიდ დიღომში",
      "დიდ დიღომზე",
      "დიდ დიღომის",
    ],
    streets: ["დემეტრე თავდადებულის"],
    conflictingMarkers: ["ტაბახმელა"],
  },
];

/** myhome create form may label the district field differently. */
export const DISTRICT_FIELD_LABELS = ["უბანი", "რაიონი", "ქალაქის უბანი"] as const;

function normalizeDistrictKey(text: string): string {
  return text.toLowerCase().replace(/\s+/g, "");
}

/** Street core for district lookup — mirrors myhome-parser streetCoreForMatch. */
export function streetCoreForDistrictMatch(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[ა-ჰ]\.\s*/iu, "")
    .replace(/^[ა-ჰ]{1,2}\.\s*/iu, "")
    .replace(/\s+(ქ\.?|ქუჩა|შესახვევი|ჩიხი|გამზ\.?)\s*$/iu, "")
    .trim();
}

export function findParserDistrict(name: string): ParserDistrict | null {
  const key = normalizeDistrictKey(name);
  if (!key) return null;
  return (
    PARSER_DISTRICTS.find((d) => normalizeDistrictKey(d.name) === key) || null
  );
}

/** Detect district from title / address text (e.g. „დიდ დიღომში“ → „დიდი დიღომი“). */
export function extractDistrictFromText(text: string): string | null {
  const s = text.replace(/\s+/g, " ").trim();
  if (!s) return null;

  for (const district of PARSER_DISTRICTS) {
    for (const marker of district.titleMarkers) {
      if (s.includes(marker)) return district.name;
    }
  }

  // Locative / genitive forms: „დიდ(?:ი)? დიღომ(?:ი|ში|ზე|ის)“
  if (/დიდ(?:ი)?\s+დიღომ(?:ი|ში|ზე|ის)?(?:\s|$|[,;.])/u.test(s)) {
    return "დიდი დიღომი";
  }

  return null;
}

/** Infer district from a parsed street name when the title did not mention it. */
export function districtForStreet(street: string): string | null {
  const core = streetCoreForDistrictMatch(street);
  if (!core) return null;

  const coreKey = normalizeDistrictKey(core);
  for (const district of PARSER_DISTRICTS) {
    for (const known of district.streets) {
      const knownKey = normalizeDistrictKey(streetCoreForDistrictMatch(known));
      if (!knownKey) continue;
      if (coreKey === knownKey || coreKey.includes(knownKey) || knownKey.includes(coreKey)) {
        return district.name;
      }
    }
  }
  return null;
}

export function resolveListingDistrict(
  listing: ListingDistrictSource
): string | null {
  const fromRaw = listing.rawData?.["უბანი"]?.trim();
  if (fromRaw) {
    const known = findParserDistrict(fromRaw);
    return known?.name || fromRaw;
  }

  const fromTitle = extractDistrictFromText(listing.title || "");
  if (fromTitle) return fromTitle;

  const fromAddress = extractDistrictFromText(listing.address || "");
  if (fromAddress) return fromAddress;

  const street =
    listing.street?.trim() || listing.rawData?.["ქუჩა"]?.trim() || "";
  return districtForStreet(street);
}

function optionContainsDistrict(option: string, districtName: string): boolean {
  const opt = option.replace(/\s+/g, " ").trim();
  if (!opt) return false;
  if (opt.includes(districtName)) return true;

  for (const segment of opt.split(/\s*\/\s*/)) {
    const part = segment.trim();
    if (!part) continue;
    if (normalizeDistrictKey(part) === normalizeDistrictKey(districtName)) return true;
    if (part.includes(districtName)) return true;
  }

  return normalizeDistrictKey(opt).includes(normalizeDistrictKey(districtName));
}

/** myhome street options: line 1 = street, line 2+ = „თბილისი / … / უბანი“. */
export function streetLineFromOption(optionText: string): string {
  const lines = optionText
    .split(/\n+/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return lines[0] || optionText.replace(/\s+/g, " ").trim();
}

export function locationPathFromOption(optionText: string): string {
  const lines = optionText
    .split(/\n+/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (lines.length <= 1) return "";
  return lines.slice(1).join(" ");
}

/** District match uses the location breadcrumb, not the duplicated street title. */
export function districtTextFromOption(optionText: string): string {
  const path = locationPathFromOption(optionText);
  return path || optionText.replace(/\s+/g, " ").trim();
}

function conflictingMarkersForDistrict(district: string): string[] {
  const known = findParserDistrict(district);
  const markers = new Set<string>(known?.conflictingMarkers || []);
  for (const d of PARSER_DISTRICTS) {
    if (d.name === district) continue;
    markers.add(d.name);
  }
  return [...markers];
}

/** True when autocomplete option clearly belongs to a different district. */
export function optionHasWrongDistrict(option: string, district: string): boolean {
  const districtText = districtTextFromOption(option);
  for (const marker of conflictingMarkersForDistrict(district)) {
    if (optionContainsDistrict(districtText, marker)) return true;
  }
  return false;
}

/** Prepend district-aware typeahead queries so myhome narrows street suggestions. */
export function prioritizeStreetQueriesForDistrict(
  queries: string[],
  street: string,
  district: string | null
): string[] {
  if (!district) return queries;

  const prioritized: string[] = [];
  const seen = new Set<string>();
  const push = (q: string) => {
    const s = q.replace(/\s+/g, " ").trim();
    if (!s || seen.has(s)) return;
    seen.add(s);
    prioritized.push(s);
  };

  const core = streetCoreForDistrictMatch(street);
  if (core) {
    push(`${core} ${district}`);
    push(`${core} ქ ${district}`);
    push(`${core} ქ. ${district}`);
    push(`${street} ${district}`);
  }
  push(district);

  for (const q of queries) push(q);
  return prioritized;
}

/** Boost street autocomplete options in the expected district; penalize other known districts. */
export function applyDistrictMatchBonus(
  streetScore: number,
  optionText: string,
  district: string | null
): number {
  if (!district) return streetScore;

  const districtText = districtTextFromOption(optionText);

  if (optionHasWrongDistrict(optionText, district)) {
    return -1;
  }

  if (optionContainsDistrict(districtText, district)) {
    return streetScore + 2000;
  }

  return streetScore;
}

export interface StreetOptionCandidate {
  index: number;
  text: string;
  score: number;
}

/** Pick best street option; when district is known, prefer options that mention it. */
export function rankStreetAutocompleteOptions(
  optionTexts: string[],
  want: string,
  district: string | null,
  scoreFn: (want: string, option: string, district: string | null) => number
): StreetOptionCandidate | null {
  const scored = optionTexts
    .map((text, index) => ({
      index,
      text: text.replace(/\s+/g, " ").trim(),
      score: scoreFn(want, text, district),
    }))
    .filter((c) => c.text && c.score >= 0);

  if (scored.length === 0) return null;

  if (district) {
    const districtMatches = scored.filter((c) =>
      optionContainsDistrict(districtTextFromOption(c.text), district)
    );
    if (districtMatches.length > 0) {
      districtMatches.sort((a, b) => b.score - a.score);
      return districtMatches[0];
    }

    const withoutWrong = scored.filter((c) => !optionHasWrongDistrict(c.text, district));
    if (withoutWrong.length > 0) {
      withoutWrong.sort((a, b) => b.score - a.score);
      return withoutWrong[0];
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored[0];
}
