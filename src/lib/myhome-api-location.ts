/**
 * Resolve myhome.ge location ids (city, district, urban, street, coordinates)
 * for the API create payload.
 */
import tbilisiStreets from "@/data/tbilisi-streets-myhome.json";
import { cityForPrefill } from "@/lib/location-prefill";
import { resolveListingDistrict } from "@/lib/parser-districts";
import {
  hasStreetType,
  scoreStreetNameMatch,
} from "@/lib/street-dictionary";
import type { MyhomeListing } from "@/lib/myhome-parser";

const LOCATIONS_API = "https://api-locations.tnet.ge/v2";
const FETCH_TIMEOUT_MS = parseInt(process.env.PARSE_GOTO_TIMEOUT_MS || "20000", 10);

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export interface MyhomeLocationIds {
  city_id: number;
  street_id: number;
  location_id: number;
  district_id: number;
  urban_id: number;
  longitude: string;
  latitude: string;
  streetDisplay: string;
}

interface StreetRow {
  id: number;
  urban_id: number;
  district_id: number;
  city_id: number;
  city_name: string;
  urban_name: string;
  district_name: string;
  display_name: string;
  longitude: number;
  latitude: number;
}

const TBILISI_STREETS = tbilisiStreets as StreetRow[];

interface LocationSuggestion {
  id?: number;
  location_id?: number;
  name?: string;
  display_name?: string;
  locations?: string[];
}

function streetScore(want: string, candidate: string): number {
  return scoreStreetNameMatch(want, candidate);
}

/**
 * Choose the street string that best preserves the street-type token (ქუჩა /
 * გამზირი / …). Fields without a type lose precision at match time, so prefer
 * the first candidate that carries one, falling back to the first non-empty.
 */
function pickStreetQuery(candidates: (string | null | undefined)[]): string {
  const values = candidates
    .map((c) => c?.trim())
    .filter((c): c is string => Boolean(c));
  return values.find((v) => hasStreetType(v)) ?? values[0] ?? "";
}

function districtHint(listing: MyhomeListing): string {
  return (
    listing.rawData?.["რაიონი"] ||
    listing.rawData?.["უბანი"] ||
    listing.rawData?.["მიკრო-რაიონი"] ||
    resolveListingDistrict(listing) ||
    ""
  ).trim();
}

function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function suggestionLocationId(item: LocationSuggestion): number | undefined {
  const raw = item.location_id ?? item.id;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

function suggestionText(item: LocationSuggestion): string {
  const parts = [
    item.display_name,
    item.name,
    ...(Array.isArray(item.locations) ? item.locations : []),
  ]
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter(Boolean);
  return normalizeForMatch(parts.join(" "));
}

function pickBestSuggestionLocationId(
  items: LocationSuggestion[],
  query: string
): number | undefined {
  if (!items.length) return undefined;
  const q = normalizeForMatch(query);

  if (q) {
    // Prefer an exact/near-exact location text match for "village-like" inputs
    // (e.g. "ქვემო თელეთი"), otherwise we often pick unrelated "ქვემო ..." rows.
    const exact = items.find((item) => {
      const text = suggestionText(item);
      return text === q || text.includes(`, ${q}`) || text.includes(` ${q}`);
    });
    const exactId = exact ? suggestionLocationId(exact) : undefined;
    if (exactId) return exactId;
  }

  return items.map(suggestionLocationId).find((id): id is number => Boolean(id));
}

function resolveFromTbilisiJson(
  streetQuery: string,
  districtHintText: string
): StreetRow | null {
  const want = streetQuery.trim();
  if (!want) return null;

  let best: StreetRow | null = null;
  let bestScore = 0;

  for (const row of TBILISI_STREETS) {
    const nameScore = streetScore(want, row.display_name);
    if (nameScore <= 0) continue;

    // District hint only disambiguates between name matches of similar quality;
    // it is intentionally small so it can never override a street-type conflict
    // (a wrong type is penalized by ~600 in the name score).
    let score = nameScore;
    if (districtHintText) {
      const d = districtHintText.toLowerCase();
      const u = row.urban_name.toLowerCase();
      const dist = row.district_name.toLowerCase();
      if (u.includes(d) || dist.includes(d)) score += 40;
      if (d.includes(u) || d.includes(dist)) score += 30;
    }
    if (score > bestScore) {
      bestScore = score;
      best = row;
    }
  }

  return bestScore >= 300 ? best : null;
}

async function fetchJson<T>(url: string, headers?: Record<string, string>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": UA, ...headers },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** location_id for suggestions API — derived from urban search when street JSON lacks it. */
async function resolveLocationId(
  cityName: string,
  districtName: string,
  urbanName: string
): Promise<number | undefined> {
  try {
    const q = encodeURIComponent(cityName || "თბილისი");
    const cities = await fetchJson<{ data?: LocationSuggestion[] }>(
      `${LOCATIONS_API}/suggestions?q=${q}&with_visible_in_cities=1`
    );

    const items = cities.data ?? [];
    const urbanNeedle = (urbanName || districtName).toLowerCase();
    for (const item of items) {
      const label = suggestionText(item);
      if (urbanNeedle && label.includes(urbanNeedle)) {
        const id = suggestionLocationId(item);
        if (id) return id;
      }
    }
    const fallbackByCity = pickBestSuggestionLocationId(items, cityName);
    if (fallbackByCity) return fallbackByCity;

    if (districtName) {
      const dq = encodeURIComponent(districtName);
      const districts = await fetchJson<{ data?: LocationSuggestion[] }>(
        `${LOCATIONS_API}/suggestions?q=${dq}&with_visible_in_cities=1`
      );
      return pickBestSuggestionLocationId(districts.data ?? [], districtName);
    }
  } catch (e) {
    console.warn("[myhome-api-location] suggestions lookup failed:", e);
  }
  return undefined;
}

export async function resolveMyhomeLocationIds(
  listing: MyhomeListing
): Promise<MyhomeLocationIds | null> {
  const city = cityForPrefill(listing.city || listing.rawData?.["მდებარეობა"] || "");
  const street = pickStreetQuery([
    listing.street,
    listing.rawData?.["ქუჩა"],
    listing.address,
    city,
    listing.rawData?.["მდებარეობა"],
  ]);

  const hint = districtHint(listing);
  const row = street ? resolveFromTbilisiJson(street, hint) : null;

  if (row) {
    const location_id =
      (await resolveLocationId(row.city_name, row.district_name, row.urban_name)) ??
      row.district_id;

    return {
      city_id: row.city_id,
      street_id: row.id,
      location_id,
      district_id: row.district_id,
      urban_id: row.urban_id,
      longitude: String(row.longitude),
      latitude: String(row.latitude),
      streetDisplay: row.display_name.replace(/\s*ქ\.?\s*$/u, "").trim() || street,
    };
  }

  // Fallback: live streets API (non-Tbilisi or unknown street)
  try {
    const cityQ = encodeURIComponent(city || "თბილისი");
    const locRes = await fetchJson<{ data?: LocationSuggestion[] }>(
      `${LOCATIONS_API}/suggestions?q=${cityQ}&with_visible_in_cities=1`
    );
    const locationId = pickBestSuggestionLocationId(
      locRes.data ?? [],
      city || listing.rawData?.["მდებარეობა"] || ""
    );
    if (!locationId) return null;

    // When source has no street (common on some ss.ge regional listings), use
    // city text as a coarse query so locations API can return an "unaddressed
    // streets" fallback entry instead of hard-failing the whole API prefill.
    const streetQ = encodeURIComponent(street || city || "");
    const streets = await fetchJson<{
      data?: Array<{
        id: number;
        city_id: number;
        district_id: number;
        urban_id: number;
        display_name: string;
        longitude?: number;
        latitude?: number;
      }>;
    }>(
      `${LOCATIONS_API}/streets?q=${streetQ}&sort_by_location=1&location_id=${locationId}`
    );

    const match = streets.data?.[0];
    if (!match) return null;

    return {
      city_id: match.city_id,
      street_id: match.id,
      location_id: locationId,
      district_id: match.district_id,
      urban_id: match.urban_id,
      longitude: String(match.longitude ?? ""),
      latitude: String(match.latitude ?? ""),
      streetDisplay: match.display_name,
    };
  } catch (e) {
    console.warn("[myhome-api-location] live API fallback failed:", e);
    return null;
  }
}
