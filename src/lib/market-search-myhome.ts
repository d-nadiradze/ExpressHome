/**
 * myhome.ge search + detail clients (JSON API, no HTML).
 *
 * List: GET https://api-statements.tnet.ge/v1/statements
 * Detail: GET https://api-statements.tnet.ge/v1/statements/{id}
 * Owner filter: owner=1 → user_type.type === "physical"
 */
import {
  MARKET_CITY_KA,
  MARKET_DEAL_TYPE_KA,
  MYHOME_MARKET_TYPE_IDS,
  MYHOME_SALE_DEAL_TYPE_ID,
  MYHOME_TBILISI_CITY_ID,
  type MarketPropertyType,
} from "@/lib/market-constants";
import { asArray, asRecord, marketFetch, numStr, str } from "@/lib/market-http";
import type { MarketCard, MarketSellerSlice } from "@/lib/market-types";
import { createCooldown, formatCooldownMs } from "@/lib/retry-cooldown";
import { splitStreetHouseNumber } from "@/lib/street-dictionary";
import type { MarketSellerType } from "@prisma/client";

const API_BASE = "https://api-statements.tnet.ge/v1/statements";

const HEADERS = {
  "x-website-key": "myhome",
  Accept: "application/json",
  "Accept-Language": "ka-GE,ka;q=0.9,en;q=0.8",
};

/**
 * The tnet API started answering 401 to anonymous clients on 2026-10-09.
 * One rejection parks every myhome market call for this long so a poll tick
 * logs a single line instead of one error per type × slice × page × detail.
 */
const API_AUTH_RETRY_MS = parseInt(process.env.MYHOME_API_AUTH_RETRY_MS || "900000", 10);
const apiCooldown = createCooldown(API_AUTH_RETRY_MS);

/** Thrown without a network call while the API is parked; pollers skip quietly. */
export class MyhomeApiCooldownError extends Error {
  constructor(reason: string, remainingMs: number) {
    super(`myhome API parked (${reason}); retry in ${formatCooldownMs(remainingMs)}`);
  }
}

async function myhomeApiFetch(url: string, what: string): Promise<Response> {
  const cooling = apiCooldown.get();
  if (cooling) throw new MyhomeApiCooldownError(cooling.reason, cooling.remainingMs);
  const res = await marketFetch(url, { headers: HEADERS });
  if (res.status === 401 || res.status === 403) {
    apiCooldown.fail(undefined, `HTTP ${res.status}`);
    console.warn(
      `[market] myhome API rejected ${what} (HTTP ${res.status}) — skipping myhome for ${formatCooldownMs(API_AUTH_RETRY_MS)}`
    );
  } else if (res.ok) {
    apiCooldown.clear();
  }
  return res;
}

function mapSellerType(userType: string | undefined): MarketSellerType {
  const t = (userType ?? "").toLowerCase();
  if (t === "physical") return "OWNER";
  if (t === "agent") return "AGENT";
  if (t === "developer") return "AGENCY";
  return "UNKNOWN";
}

function pickPrice(price: unknown): { price: string; currency: string } {
  const obj = asRecord(price);
  if (!obj) return { price: "", currency: "USD" };
  const usd = asRecord(obj["2"]);
  const gel = asRecord(obj["1"]);
  if (usd?.price_total != null && usd.price_total !== "") {
    return { price: numStr(usd.price_total), currency: "USD" };
  }
  if (gel?.price_total != null && gel.price_total !== "") {
    return { price: numStr(gel.price_total), currency: "GEL" };
  }
  return { price: "", currency: "USD" };
}

function parsePostedAt(value: unknown): Date | null {
  const s = str(value);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function listingUrl(id: string, slug: string): string {
  if (slug) return `https://www.myhome.ge/ka/pr/${id}/${slug}/`;
  return `https://www.myhome.ge/pr/${id}/`;
}

function mapCard(raw: unknown, propertyType: MarketPropertyType): MarketCard | null {
  const s = asRecord(raw);
  if (!s) return null;
  const id = str(s.id);
  if (!id) return null;

  const userType = asRecord(s.user_type);
  const sellerType = mapSellerType(str(userType?.type));
  const address = str(s.address);
  const split = splitStreetHouseNumber(address);
  const { price, currency } = pickPrice(s.price);
  const images = asArray(s.images);
  const firstImage = asRecord(images[0]);

  return {
    platform: "MYHOME",
    externalId: id,
    url: listingUrl(id, str(s.dynamic_slug)),
    sellerType,
    propertyType,
    dealType: MARKET_DEAL_TYPE_KA,
    city: str(s.city_name) || MARKET_CITY_KA,
    district: str(s.district_name),
    street: split.street,
    streetNumber: split.number,
    area: numStr(s.area),
    rooms: numStr(s.room ?? s.room_type_id),
    floor: numStr(s.floor),
    cadastralCode: str(s.rs_code),
    price,
    currency,
    title: str(s.dynamic_title) || address,
    imageUrl: str(firstImage?.thumb ?? firstImage?.large),
    sourcePostedAt: parsePostedAt(s.last_updated ?? s.created_at ?? s.order_date),
  };
}

function buildSearchUrl(
  propertyType: MarketPropertyType,
  slice: MarketSellerSlice,
  page: number,
  pageSize: number
): string {
  const params = new URLSearchParams();
  params.append("cities[]", String(MYHOME_TBILISI_CITY_ID));
  params.append("deal_types[]", String(MYHOME_SALE_DEAL_TYPE_ID));
  params.append("real_estate_types[]", String(MYHOME_MARKET_TYPE_IDS[propertyType]));
  if (slice === "owner") params.set("owner", "1");
  params.set("page", String(page));
  params.set("Page", String(page));
  params.set("limit", String(pageSize));
  params.set("PageSize", String(pageSize));
  return `${API_BASE}?${params.toString()}`;
}

function extractItems(json: unknown): unknown[] {
  const root = asRecord(json);
  if (!root) return [];
  const data = asRecord(root.data) ?? root;
  const nested = asArray(data.data);
  if (nested.length) return nested;
  const items = asArray(data.items);
  if (items.length) return items;
  const statements = asArray(data.statements);
  if (statements.length) return statements;
  return asArray(root.data);
}

export async function searchMyhomeMarket(
  propertyType: MarketPropertyType,
  slice: MarketSellerSlice,
  page: number,
  pageSize: number
): Promise<MarketCard[]> {
  const url = buildSearchUrl(propertyType, slice, page, pageSize);
  const res = await myhomeApiFetch(url, `search ${propertyType} ${slice} p${page}`);
  if (!res.ok) {
    throw new Error(`myhome search HTTP ${res.status} (${propertyType} ${slice} p${page})`);
  }
  const json: unknown = await res.json();
  const cards = extractItems(json)
    .map((item) => mapCard(item, propertyType))
    .filter((c): c is MarketCard => c != null);

  if (slice === "owner") {
    return cards.filter((c) => c.sellerType === "OWNER");
  }
  return cards.filter((c) => c.sellerType === "AGENCY" || c.sellerType === "AGENT");
}

export async function fetchMyhomeMarketDetail(
  externalId: string
): Promise<Partial<Pick<MarketCard, "cadastralCode" | "street" | "streetNumber" | "sourcePostedAt" | "floor" | "area">>> {
  const res = await myhomeApiFetch(`${API_BASE}/${externalId}`, `detail ${externalId}`);
  if (!res.ok) {
    throw new Error(`myhome detail HTTP ${res.status} for ${externalId}`);
  }
  const json: unknown = await res.json();
  const root = asRecord(json);
  const data = asRecord(root?.data);
  const statement = asRecord(data?.statement) ?? data;
  if (!statement) return {};

  const address = str(statement.address);
  const split = splitStreetHouseNumber(address);
  return {
    cadastralCode: str(statement.rs_code),
    street: split.street || undefined,
    streetNumber: split.number || undefined,
    floor: numStr(statement.floor) || undefined,
    area: numStr(statement.area) || undefined,
    sourcePostedAt: parsePostedAt(statement.last_updated ?? statement.created_at) ?? undefined,
  };
}
