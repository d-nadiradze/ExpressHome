/**
 * Resolve myhome.ge location ids (city, district, urban, street, coordinates)
 * for the API create payload.
 */
import tbilisiStreets from "@/data/tbilisi-streets-myhome.json";
import { cityForPrefill } from "@/lib/location-prefill";
import { resolveListingDistrict } from "@/lib/parser-districts";
import { normalizeStreetForMatch } from "@/lib/street-dictionary";
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

function streetScore(want: string, candidate: string): number {
  const a = normalizeStreetForMatch(want);
  const b = normalizeStreetForMatch(candidate);
  if (!a || !b) return 0;
  if (a === b) return 1000;
  if (b.startsWith(a) || a.startsWith(b)) return 900;
  if (b.includes(a) || a.includes(b)) return Math.min(a.length, b.length) * 10;
  return 0;
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

function resolveFromTbilisiJson(
  streetQuery: string,
  districtHintText: string
): StreetRow | null {
  const want = streetQuery.trim();
  if (!want) return null;

  let best: StreetRow | null = null;
  let bestScore = 0;

  for (const row of TBILISI_STREETS) {
    let score = streetScore(want, row.display_name);
    if (districtHintText) {
      const d = districtHintText.toLowerCase();
      if (row.urban_name.toLowerCase().includes(d) || row.district_name.toLowerCase().includes(d)) {
        score += 50;
      }
      if (d.includes(row.urban_name.toLowerCase()) || d.includes(row.district_name.toLowerCase())) {
        score += 40;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = row;
    }
  }

  return bestScore >= 80 ? best : null;
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
    const cities = await fetchJson<{
      data?: Array<{ id: number; display_name?: string; name?: string }>;
    }>(`${LOCATIONS_API}/suggestions?q=${q}&with_visible_in_cities=1`);

    const items = cities.data ?? [];
    const urbanNeedle = (urbanName || districtName).toLowerCase();
    for (const item of items) {
      const label = (item.display_name || item.name || "").toLowerCase();
      if (urbanNeedle && label.includes(urbanNeedle)) return item.id;
    }
    if (items[0]?.id) return items[0].id;

    if (districtName) {
      const dq = encodeURIComponent(districtName);
      const districts = await fetchJson<{ data?: Array<{ id: number }> }>(
        `${LOCATIONS_API}/suggestions?q=${dq}&with_visible_in_cities=1`
      );
      return districts.data?.[0]?.id;
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
  const street =
    listing.street?.trim() ||
    listing.rawData?.["ქუჩა"]?.trim() ||
    listing.address?.trim() ||
    "";
  if (!street) return null;

  const hint = districtHint(listing);
  const row = resolveFromTbilisiJson(street, hint);

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
    const locRes = await fetchJson<{ data?: Array<{ id: number }> }>(
      `${LOCATIONS_API}/suggestions?q=${cityQ}&with_visible_in_cities=1`
    );
    const locationId = locRes.data?.[0]?.id;
    if (!locationId) return null;

    const streetQ = encodeURIComponent(street);
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
