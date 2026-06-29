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

interface StreetRow {
  id: number;
  title: string;
  subDistrictId: number;
  district?: string;
  subDistrict?: string;
}

const STREETS = streetsData as StreetRow[];

function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

function streetQueries(street: string): string[] {
  const s = (street || "").replace(/\s+/g, " ").trim();
  if (!s) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (q: string) => {
    const v = q.replace(/\s+/g, " ").trim();
    if (!v || seen.has(norm(v))) return;
    seen.add(norm(v));
    out.push(v);
  };

  push(s);
  const withoutSuffix = s.replace(/\s+(ქ\.?|ქუჩა|შეს\.?|შესახვევი)\s*$/iu, "").trim();
  if (withoutSuffix) {
    push(withoutSuffix);
    push(`${withoutSuffix} ქ.`);
  }
  return out;
}

function scoreStreetMatch(query: string, row: StreetRow): number {
  const q = norm(query);
  const title = norm(row.title);
  if (title === q) return 100;
  if (title.includes(q) || q.includes(title)) return 80;
  const qBase = q.replace(/\s+(ქ\.?|ქუჩა)$/iu, "").trim();
  const tBase = title.replace(/\s+(ქ\.?|ქუჩა)$/iu, "").trim();
  if (tBase === qBase) return 90;
  if (tBase.includes(qBase) || qBase.includes(tBase)) return 70;
  return 0;
}

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
  for (const query of streetQueries(street)) {
    for (const row of STREETS) {
      const score = scoreStreetMatch(query, row);
      if (!best || score > best.score) {
        best = { row, score };
      }
    }
  }

  if (!best || best.score < 60) {
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
