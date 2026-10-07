/**
 * ss.ge search + detail clients (JSON API).
 *
 * Search: POST https://api-gateway.ss.ge/v1/RealEstate/LegendSearch
 * Detail: GET  https://api-gateway.ss.ge/v1/RealEstate/details?applicationId=
 * Auth:   anonymous credentialsToken from home.ss.ge SSR (cached in memory;
 *         fetched via curl/Chromium when Cloudflare challenges plain fetch),
 *         else a linked account's JWT.
 * Owner:  advancedSearch.individualEntityOnly = true
 */
import { decodeJwtExpiryMs } from "@/lib/ssge-api-token-cache";
import {
  MARKET_CITY_KA,
  MARKET_DEAL_TYPE_KA,
  SSGE_MARKET_TYPE_IDS,
  SSGE_SALE_DEAL_TYPE_ID,
  SSGE_TBILISI_CITY_ID,
  type MarketPropertyType,
} from "@/lib/market-constants";
import { asArray, asRecord, marketFetch, numStr, str } from "@/lib/market-http";
import type { MarketCard, MarketSellerSlice } from "@/lib/market-types";
import { SSGE_API_BASE, SSGE_HOME_ORIGIN } from "@/lib/ssge-api-constants";
import { fetchSsgeHtmlResilient } from "@/lib/ssge-challenge-fetch";
import type { MarketSellerType } from "@prisma/client";

const TOKEN_SKEW_MS = 120_000;
const TOKEN_PAGE = `${SSGE_HOME_ORIGIN}/ka/udzravi-qoneba/l/bina/iyideba?cityIdList=${SSGE_TBILISI_CITY_ID}`;

let cachedToken: { value: string; expiresAt: number } | null = null;

function mapSellerType(userType: unknown, externalCompanyId: unknown): MarketSellerType {
  if (userType != null && userType !== "") {
    const n = Number(userType);
    if (n === 0) return "OWNER";
    if (n === 1) return "AGENT";
    if (n === 2 || n === 3) return "AGENCY";
  }
  // LegendSearch often omits userInfo; owner-only search already filtered individuals.
  if (externalCompanyId) return "AGENCY";
  return "OWNER";
}

function parsePostedAt(value: unknown): Date | null {
  const s = str(value);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function listingUrl(id: string, detailUrl: string): string {
  if (detailUrl.startsWith("http")) return detailUrl;
  if (detailUrl.startsWith("/")) return `${SSGE_HOME_ORIGIN}${detailUrl}`;
  if (detailUrl) return `${SSGE_HOME_ORIGIN}/ka/udzravi-qoneba/${detailUrl}`;
  return `${SSGE_HOME_ORIGIN}/ka/udzravi-qoneba/${id}`;
}

function pickImage(appImages: unknown): string {
  const images = asArray(appImages);
  const main =
    images.find((img) => asRecord(img)?.isMain === true) ??
    images.find((img) => asRecord(img)?.isPrimary === true) ??
    images[0];
  const rec = asRecord(main);
  return str(
    rec?.fileName ??
      rec?.url ??
      rec?.thumbUrl ??
      rec?.imageUrl ??
      rec?.fileUrl
  );
}

function pickPrice(raw: unknown): { price: string; currency: string } {
  const rec = asRecord(raw);
  if (!rec) return { price: "", currency: "USD" };
  const nested = asRecord(rec.price) ?? rec;
  const usd = nested.priceUsd ?? nested.priceUSD ?? nested.price;
  const gel = nested.priceGeo ?? nested.priceGel ?? nested.priceTotal;
  const currencyId = Number(nested.currencyId ?? nested.currencyType ?? rec.currencyId ?? 2);
  if (currencyId === 1 && gel != null && gel !== "") {
    return { price: numStr(gel), currency: "GEL" };
  }
  if (usd != null && usd !== "") {
    return { price: numStr(usd), currency: "USD" };
  }
  if (gel != null && gel !== "") {
    return { price: numStr(gel), currency: "GEL" };
  }
  return { price: "", currency: "USD" };
}

function mapCard(raw: unknown, propertyType: MarketPropertyType): MarketCard | null {
  const s = asRecord(raw);
  if (!s) return null;
  const id = str(s.applicationId ?? s.id);
  if (!id) return null;

  const address = asRecord(s.address) ?? s;
  const userInfo = asRecord(s.userInfo);
  const sellerType = mapSellerType(
    userInfo?.userType ?? s.userType,
    userInfo?.externalCompanyId ?? s.externalCompanyId
  );
  const { price, currency } = pickPrice(s);

  return {
    platform: "SSGE",
    externalId: id,
    url: listingUrl(id, str(s.detailUrl)),
    sellerType,
    propertyType,
    dealType: MARKET_DEAL_TYPE_KA,
    city: str(address.cityTitle ?? s.cityTitle) || MARKET_CITY_KA,
    district: str(address.districtTitle ?? s.districtTitle),
    street: str(address.streetTitle ?? s.streetTitle),
    streetNumber: str(address.streetNumber ?? s.streetNumber),
    area: numStr(s.totalArea ?? s.area),
    rooms: numStr(s.numberOfBedrooms ?? s.rooms ?? s.roomNumber),
    floor: numStr(s.floorNumber ?? s.floor),
    cadastralCode: str(s.cadastralCode),
    price,
    currency,
    title: str(s.title) || str(address.streetTitle),
    imageUrl: pickImage(s.appImages ?? s.images),
    sourcePostedAt: parsePostedAt(s.createDate ?? s.orderDate ?? s.postedDate),
  };
}

function extractItems(json: unknown): unknown[] {
  const root = asRecord(json);
  if (!root) return [];
  const data = asRecord(root.data) ?? root;
  for (const key of [
    "realStateItemModel",
    "realEstateList",
    "realEstates",
    "realEstateItemList",
    "items",
    "applications",
    "result",
    "list",
  ]) {
    const arr = asArray(data[key] ?? root[key]);
    if (arr.length) return arr;
  }
  const nested = asRecord(data.data);
  if (nested) {
    for (const key of ["realEstateList", "items", "list"]) {
      const arr = asArray(nested[key]);
      if (arr.length) return arr;
    }
  }
  if (Array.isArray(root.data)) return root.data;
  if (Array.isArray(data.data)) return data.data;
  return [];
}

/**
 * One token fetch at a time: a market tick fires ~10 API calls at once, and
 * when the cache is cold each would otherwise escalate to curl/Chromium.
 */
let guestTokenInflight: Promise<string> | null = null;

async function fetchGuestToken(force = false): Promise<string> {
  if (!force && cachedToken && cachedToken.expiresAt - TOKEN_SKEW_MS > Date.now()) {
    return cachedToken.value;
  }
  if (!guestTokenInflight) {
    guestTokenInflight = fetchGuestTokenUncached().finally(() => {
      guestTokenInflight = null;
    });
  }
  return guestTokenInflight;
}

async function fetchGuestTokenUncached(): Promise<string> {
  // Escalates fetch → curl → Chromium when Cloudflare challenges this host's
  // TLS fingerprint (the case on the VPS); plain fetch elsewhere.
  const { html, via } = await fetchSsgeHtmlResilient(TOKEN_PAGE);
  const match =
    html.match(/"credentialsToken"\s*:\s*"([^"]+)"/) ??
    html.match(/credentialsToken\\":\\"([^\\"]+)/);
  const token = match?.[1];
  if (!token) {
    throw new Error(`ss.ge guest credentialsToken not found in SSR (via ${via})`);
  }

  const exp = decodeJwtExpiryMs(token);
  cachedToken = {
    value: token,
    expiresAt: exp ?? Date.now() + 50 * 60 * 1000,
  };
  if (via !== "fetch") {
    console.log(
      `[ss.ge market] guest token obtained via ${via}; cached until ${new Date(cachedToken.expiresAt).toISOString()}`
    );
  }
  return token;
}

interface ApiTokenOptions {
  /** Use this JWT as-is (e.g. a prefill session). */
  accessToken?: string;
  /** When falling back to a linked account, try this user's first. */
  preferUserId?: string;
}

async function resolveApiToken(
  options: ApiTokenOptions,
  forceGuestRefresh = false
): Promise<{ token: string; source: "provided" | "guest" | "account" }> {
  if (options.accessToken) return { token: options.accessToken, source: "provided" };
  try {
    return { token: await fetchGuestToken(forceGuestRefresh), source: "guest" };
  } catch (guestErr) {
    // Even curl/Chromium could not get a guest token; last resort is a linked
    // account's JWT (cached, else a login) or SSGE_API_BEARER.
    const { resolveSsgeBearerAny, resolveSsgeBearerForUser } = await import(
      "@/lib/ssge-server-bearer"
    );
    const accountToken =
      (options.preferUserId ? await resolveSsgeBearerForUser(options.preferUserId) : null) ??
      (await resolveSsgeBearerAny());
    if (accountToken) {
      console.warn(
        `[ss.ge market] guest token unavailable (${guestErr instanceof Error ? guestErr.message : String(guestErr)}) — using linked-account bearer`
      );
      return { token: accountToken, source: "account" };
    }
    throw guestErr;
  }
}

async function ssgeJson(
  path: string,
  init?: RequestInit,
  options?: ApiTokenOptions & { retried?: boolean }
): Promise<unknown> {
  const retried = options?.retried ?? false;
  const { token, source } = await resolveApiToken(options ?? {}, retried);
  const url = path.startsWith("http") ? path : `${SSGE_API_BASE}${path}`;
  const res = await marketFetch(url, {
    ...init,
    headers: {
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "ka-GE",
      Authorization: `Bearer ${token}`,
      Origin: SSGE_HOME_ORIGIN,
      Referer: `${SSGE_HOME_ORIGIN}/ka/udzravi-qoneba/l/bina/iyideba`,
      "Content-Type": "application/json",
      ...(init?.headers as Record<string, string> | undefined),
    },
  });

  if (res.status === 401 && !retried) {
    if (source === "guest") cachedToken = null;
    return ssgeJson(path, init, { ...options, retried: true });
  }
  if (!res.ok) {
    throw new Error(`ss.ge ${init?.method ?? "GET"} ${path} HTTP ${res.status}`);
  }
  const text = await res.text();
  if (!text.trim()) {
    throw new Error(`ss.ge empty body ${path} HTTP ${res.status}`);
  }
  return JSON.parse(text) as unknown;
}

export async function searchSsgeMarket(
  propertyType: MarketPropertyType,
  slice: MarketSellerSlice,
  page: number,
  pageSize: number,
  realEstateType: number
): Promise<MarketCard[]> {
  const body: Record<string, unknown> = {
    cityIdList: [SSGE_TBILISI_CITY_ID],
    realEstateType,
    realEstateDealType: SSGE_SALE_DEAL_TYPE_ID,
    page,
    pageSize,
    currencyId: 1,
  };
  if (slice === "owner") {
    body.advancedSearch = { individualEntityOnly: true };
  }

  const json = await ssgeJson("/RealEstate/LegendSearch", {
    method: "POST",
    body: JSON.stringify(body),
  });

  const cards = extractItems(json)
    .map((item) => mapCard(item, propertyType))
    .filter((c): c is MarketCard => c != null);

  if (slice === "owner") {
    return cards.filter((c) => c.sellerType === "OWNER" || c.sellerType === "UNKNOWN");
  }
  return cards.filter((c) => c.sellerType === "AGENCY" || c.sellerType === "AGENT");
}

/**
 * Full listing payload from api-gateway (same shape as __NEXT_DATA__ applicationData).
 * Used as a parse fallback when home.ss.ge HTML is blocked for datacenter IPs.
 */
export async function fetchSsgeApplicationDetails(
  applicationId: string,
  options?: ApiTokenOptions
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any | null> {
  const json = await ssgeJson(
    `/RealEstate/details?applicationId=${encodeURIComponent(applicationId)}`,
    { method: "PUT" },
    options
  );
  const root = asRecord(json);
  if (!root) return null;
  const data = asRecord(root.data) ?? root;
  return (
    asRecord(data?.applicationData) ??
    asRecord(data?.application) ??
    asRecord(data?.realEstate) ??
    data
  );
}

export async function fetchSsgeMarketDetail(
  externalId: string
): Promise<Partial<Pick<MarketCard, "cadastralCode" | "street" | "streetNumber" | "sourcePostedAt" | "floor" | "area">>> {
  // api-gateway only exposes this as PUT with the id in the query string;
  // GET/POST answer 405 and a body-only id returns a card without the address.
  const app = await fetchSsgeApplicationDetails(externalId);
  if (!app) return {};

  const address = asRecord(app.address) ?? app;
  return {
    cadastralCode: str(app.cadastralCode ?? app.rsCode ?? app.cadastreCode),
    street: str(address.streetTitle ?? app.streetTitle) || undefined,
    streetNumber: str(address.streetNumber ?? app.streetNumber) || undefined,
    floor: numStr(app.floorNumber ?? app.floor) || undefined,
    area: numStr(app.totalArea ?? app.area) || undefined,
    sourcePostedAt:
      parsePostedAt(app.createDate ?? app.orderDate ?? app.postedDate) ?? undefined,
  };
}
