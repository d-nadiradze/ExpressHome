/**
 * Resolve ss.ge city/street → numeric location ids.
 */
import streetsData from "@/data/tbilisi-streets-ssge.json";
import {
  SSGE_API_BASE,
  SSGE_HOME_ORIGIN,
} from "@/lib/ssge-api-constants";
import type { SsgeApiSession } from "@/lib/ssge-api-auth";
import { reverseSsgeCityId } from "@/lib/ssge-api-reverse";
import { scoreStreetNameMatch } from "@/lib/street-dictionary";

interface StreetRow {
  id: number;
  title: string;
  subDistrictId: number;
  district?: string;
  subDistrict?: string;
}

const STREETS = streetsData as StreetRow[];

export interface SsgeLocationIds {
  cityId: number;
  subdistrictId: number | null;
  streetId: number | null;
}

export function resolveSsgeLocationFromJson(
  city: string,
  street: string
): SsgeLocationIds {
  const cityId = reverseSsgeCityId(city);
  if (!street.trim()) {
    return { cityId, subdistrictId: null, streetId: null };
  }

  let best: { row: StreetRow; score: number } | null = null;
  for (const row of STREETS) {
    const score = scoreStreetNameMatch(street, row.title);
    if (score > 0 && (!best || score > best.score)) {
      best = { row, score };
    }
  }

  if (!best || best.score < 300) {
    return { cityId, subdistrictId: null, streetId: null };
  }

  return {
    cityId,
    subdistrictId: best.row.subDistrictId,
    streetId: best.row.id,
  };
}

export async function resolveSsgeLocationIds(
  session: SsgeApiSession,
  city: string,
  street: string
): Promise<SsgeLocationIds> {
  const fromJson = resolveSsgeLocationFromJson(city, street);
  if (fromJson.streetId) return fromJson;

  const q = street.trim();
  if (!q) return fromJson;

  try {
    const params = new URLSearchParams({
      cityId: String(fromJson.cityId),
      street: q,
    });
    const res = await fetch(
      `${SSGE_API_BASE}/RealEstate/find-location-by-street?${params}`,
      { headers: session.headers }
    );
    if (!res.ok) return fromJson;
    const data = (await res.json()) as {
      streetId?: number;
      subdistrictId?: number;
      cityId?: number;
    };
    if (!data.streetId) return fromJson;
    return {
      cityId: data.cityId ?? fromJson.cityId,
      subdistrictId: data.subdistrictId ?? null,
      streetId: data.streetId,
    };
  } catch {
    return fromJson;
  }
}

export function ssgeListingUrl(applicationId: number): string {
  return `${SSGE_HOME_ORIGIN}/ka/udzravi-qoneba/bina-iyideba-${applicationId}`;
}
