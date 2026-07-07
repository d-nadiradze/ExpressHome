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
import {
  normalizeStreetForMatch,
  scoreStreetNameMatch,
  streetMatchKeyWithoutLead,
} from "@/lib/street-dictionary";

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

function districtMatches(row: StreetRow, district?: string | null): boolean {
  const wanted = district?.trim();
  if (!wanted) return true;
  return (row.district || "").trim() === wanted;
}

function leadingStreetToken(raw: string): string {
  const tokens = normalizeStreetForMatch(raw).split(" ").filter(Boolean);
  return tokens[0] || "";
}

function leadTokenScore(want: string, candidate: string): number {
  if (!want || !candidate) return 0;
  if (want === candidate) return 3;
  if (want.length === 1 && candidate.startsWith(want)) return 2;
  if (candidate.length === 1 && want.startsWith(candidate)) return 2;
  return 0;
}

export function resolveSsgeLocationFromJson(
  city: string,
  street: string,
  district?: string | null
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

  if (!best) {
    const leadless = streetMatchKeyWithoutLead(street);
    if (leadless) {
      const candidates = STREETS.filter(
        (row) =>
          streetMatchKeyWithoutLead(row.title) === leadless &&
          districtMatches(row, district)
      );
      if (candidates.length) {
        const wantLead = leadingStreetToken(street);
        const ranked = candidates
          .map((row) => ({
            row,
            score: leadTokenScore(wantLead, leadingStreetToken(row.title)),
          }))
          .sort((a, b) => b.score - a.score);
        if (
          ranked.length === 1 ||
          ranked[0].score > ranked[1].score
        ) {
          best = { row: ranked[0].row, score: 900 + ranked[0].score };
        }
      }
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
  street: string,
  district?: string | null
): Promise<SsgeLocationIds> {
  const fromJson = resolveSsgeLocationFromJson(city, street, district);
  if (fromJson.streetId) return fromJson;

  const queries = street.trim() ? [street.trim()] : [];
  if (!queries.length) return fromJson;

  for (const q of queries) {
    try {
      const params = new URLSearchParams({
        cityId: String(fromJson.cityId),
        street: q,
      });
      const res = await fetch(
        `${SSGE_API_BASE}/RealEstate/find-location-by-street?${params}`,
        { headers: session.headers }
      );
      if (!res.ok) continue;
      const data = (await res.json()) as {
        streetId?: number;
        subdistrictId?: number;
        cityId?: number;
      };
      if (!data.streetId) continue;
      return {
        cityId: data.cityId ?? fromJson.cityId,
        subdistrictId: data.subdistrictId ?? null,
        streetId: data.streetId,
      };
    } catch {
      /* try next spelling */
    }
  }

  return fromJson;
}

export function ssgeListingUrl(applicationId: number): string {
  return `${SSGE_HOME_ORIGIN}/ka/udzravi-qoneba/bina-iyideba-${applicationId}`;
}
