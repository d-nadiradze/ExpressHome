/**
 * ss.ge paid-service tariff resolution + publish payment helpers.
 */
import type { SsgeApiSession } from "@/lib/ssge-api-auth";
import { ssgeApiFetch } from "@/lib/ssge-api-auth";
import {
  DEFAULT_SSGE_SERVICE,
  DEFAULT_SSGE_SERVICE_DAYS,
} from "@/lib/ssge-api-constants";

export interface SsgeTariffDayOption {
  day: number;
  price: number;
  fullPrice: number | null;
}

export interface SsgePaidServiceSelection {
  paidService: string;
  days: number;
  price: number;
}

interface TariffDailyPrice {
  day?: number;
  price?: number;
  fullPrice?: number | null;
}

interface TariffGroup {
  dailyPrices?: TariffDailyPrice[];
}

interface TariffEntry {
  paidService?: string;
  paidServiceTariffs?: TariffGroup[];
}

function flattenTariffDays(entry: TariffEntry): SsgeTariffDayOption[] {
  const out: SsgeTariffDayOption[] = [];
  for (const group of entry.paidServiceTariffs ?? []) {
    for (const opt of group.dailyPrices ?? []) {
      if (typeof opt.day !== "number" || typeof opt.price !== "number") continue;
      out.push({
        day: opt.day,
        price: opt.price,
        fullPrice: opt.fullPrice ?? null,
      });
    }
  }
  return out.sort((a, b) => a.day - b.day);
}

/** Pick a tariff day — prefer env days when listed, else longest period. */
export function pickTariffDay(
  options: SsgeTariffDayOption[],
  preferredDays = DEFAULT_SSGE_SERVICE_DAYS
): SsgeTariffDayOption | null {
  if (!options.length) return null;
  const exact = options.find((o) => o.day === preferredDays);
  if (exact) return exact;
  return options.reduce((best, cur) => (cur.day > best.day ? cur : best));
}

export function resolvePaidServiceSelection(
  tariff: TariffEntry[],
  paidService = DEFAULT_SSGE_SERVICE,
  preferredDays = DEFAULT_SSGE_SERVICE_DAYS
): SsgePaidServiceSelection | { error: string } {
  const entry = tariff.find((t) => t.paidService === paidService);
  if (!entry) {
    return { error: `ss.ge tariff missing paid service "${paidService}"` };
  }

  const days = flattenTariffDays(entry);
  const picked = pickTariffDay(days, preferredDays);
  if (!picked) {
    return { error: `ss.ge tariff has no day options for "${paidService}"` };
  }

  if (picked.price <= 0) {
    return {
      error: `ss.ge "${paidService}" tariff resolved to ${picked.price} GEL (day=${picked.day})`,
    };
  }

  return {
    paidService,
    days: picked.day,
    price: picked.price,
  };
}

export async function fetchSsgePaidServiceTariff(
  session: SsgeApiSession,
  params: {
    realEstateDealTypeId: number;
    cityId: number;
    rubric?: string;
    specialType?: string;
  }
): Promise<{ tariff: TariffEntry[] } | { error: string }> {
  const qs = new URLSearchParams({
    rubric: params.rubric ?? "RealEstate",
    realEstateDealTypeId: String(params.realEstateDealTypeId),
    specialType: params.specialType ?? "None",
    cityId: String(params.cityId),
  });

  const res = await ssgeApiFetch(
    session,
    `/PaidService/paid-service-tariff?${qs.toString()}`
  );
  if (!res.ok) {
    return { error: `paid-service-tariff failed (HTTP ${res.status})` };
  }

  const tariff = (await res.json().catch(() => null)) as TariffEntry[] | null;
  if (!Array.isArray(tariff) || tariff.length === 0) {
    return { error: "paid-service-tariff returned empty" };
  }

  return { tariff };
}

export interface SsgePublishPaymentResult {
  success: boolean;
  error?: string;
  paymentUrl?: string;
  chargedGel?: number;
  serviceDays?: number;
}

interface CreateApplicationPaymentJson {
  payment?: {
    success?: boolean;
    data?: { redirectUrl?: string; amount?: number };
  };
  applicationId?: number;
  userMessage?: string;
  rawResponse?: string;
}

/** Parse create-application response — require explicit payment success. */
export function parseCreateApplicationPayment(
  res: Response,
  raw: string,
  expectedPrice?: number
): SsgePublishPaymentResult {
  let json: CreateApplicationPaymentJson = {};
  try {
    json = JSON.parse(raw) as CreateApplicationPaymentJson;
  } catch {
    return {
      success: false,
      error: `Publish response not JSON: ${raw.slice(0, 300)}`,
    };
  }

  if (!res.ok) {
    return {
      success: false,
      error:
        json.userMessage ||
        json.rawResponse ||
        raw.slice(0, 400) ||
        `HTTP ${res.status}`,
    };
  }

  if (json.payment?.success !== true) {
    return {
      success: false,
      error:
        json.userMessage ||
        json.rawResponse ||
        "Publish did not return payment.success (listing may be unpaid draft)",
    };
  }

  const charged = json.payment?.data?.amount;
  if (
    typeof expectedPrice === "number" &&
    expectedPrice > 0 &&
    typeof charged === "number" &&
    charged <= 0
  ) {
    return {
      success: false,
      error: `Publish payment amount was ${charged} GEL (expected ~${expectedPrice})`,
    };
  }

  return {
    success: true,
    paymentUrl: json.payment?.data?.redirectUrl,
    chargedGel: typeof charged === "number" ? charged : expectedPrice,
  };
}
