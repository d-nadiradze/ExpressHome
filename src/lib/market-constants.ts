/**
 * Shared constants for the Tbilisi owner-listing market cache.
 *
 * Scope (v1): Tbilisi × იყიდება × 4 property types × myhome.ge + ss.ge.
 */

export const MARKET_CITY_KA = "თბილისი";
export const MARKET_DEAL_TYPE_KA = "იყიდება";

export const MARKET_PROPERTY_TYPES = [
  "ბინა",
  "კერძო სახლი",
  "კომერციული ფართი",
  "მიწის ნაკვეთი",
] as const;

export type MarketPropertyType = (typeof MARKET_PROPERTY_TYPES)[number];

export const MYHOME_TBILISI_CITY_ID = 1;
export const MYHOME_SALE_DEAL_TYPE_ID = 1;

/** myhome.ge `real_estate_types[]` for the four UI types. */
export const MYHOME_MARKET_TYPE_IDS: Record<MarketPropertyType, number> = {
  ბინა: 1,
  "კერძო სახლი": 2,
  "კომერციული ფართი": 5,
  "მიწის ნაკვეთი": 4,
};

export const SSGE_TBILISI_CITY_ID = 95;
export const SSGE_SALE_DEAL_TYPE_ID = 4;

/** ss.ge `realEstateType` ids. Commercial also searches type 6 (კომერციული). */
export const SSGE_MARKET_TYPE_IDS: Record<MarketPropertyType, number[]> = {
  ბინა: [5],
  "კერძო სახლი": [4],
  "კომერციული ფართი": [7, 6],
  "მიწის ნაკვეთი": [3],
};

export function isMarketPropertyType(value: string | null | undefined): value is MarketPropertyType {
  return (MARKET_PROPERTY_TYPES as readonly string[]).includes(value ?? "");
}

export function canonicalizeMarketPropertyType(value: string | null | undefined): MarketPropertyType | null {
  const v = (value ?? "").trim();
  if (isMarketPropertyType(v)) return v;
  if (v === "კომერციული") return "კომერციული ფართი";
  return null;
}

/*
 * Poll footprint. The poller shares the VPS IP and the ss.ge guest/account
 * tokens with real parses and prefills, so it must not look like a scraper:
 * the original 12-minute cadence was ~6-7k requests/day per portal in neat
 * bursts. Defaults now: hourly ± jitter, 3 pages per type, paced requests —
 * roughly 600-700 ss.ge requests/day.
 */
export function marketPollIntervalMs(): number {
  return parseInt(process.env.MARKET_POLL_INTERVAL_MS || "3600000", 10);
}

/** Random delay added before each tick so polls do not land on a fixed clock. */
export function marketPollJitterMs(): number {
  return Math.max(0, parseInt(process.env.MARKET_POLL_JITTER_MS || "300000", 10));
}

/** Mean pause between consecutive portal requests inside one tick (±50%). */
export function marketRequestPauseMs(): number {
  return Math.max(0, parseInt(process.env.MARKET_POLL_REQUEST_PAUSE_MS || "2000", 10));
}

export function isMarketPollEnabled(): boolean {
  return process.env.MARKET_POLL_ENABLED !== "false";
}

/**
 * myhome's statements API has rejected anonymous clients since 2026-10-09,
 * so polling it only produces 401s and bot-looking traffic. Off until there
 * is a working data source; flip MARKET_POLL_MYHOME=true to re-enable.
 */
export function isMarketMyhomeEnabled(): boolean {
  return process.env.MARKET_POLL_MYHOME === "true";
}

export function marketOwnerPages(): number {
  return Math.max(1, parseInt(process.env.MARKET_POLL_OWNER_PAGES || "1", 10));
}

export function marketAgencyPages(): number {
  return Math.max(1, parseInt(process.env.MARKET_POLL_AGENCY_PAGES || "2", 10));
}

export function marketPageSize(): number {
  return Math.max(8, parseInt(process.env.MARKET_POLL_PAGE_SIZE || "20", 10));
}

export function marketDetailMaxPerPoll(): number {
  return Math.max(0, parseInt(process.env.MARKET_DETAIL_MAX_PER_POLL || "15", 10));
}

/** Owner rows with firstSeenAt inside this window appear in “New owner uploads”. */
export function marketNewWindowMs(): number {
  return parseInt(process.env.MARKET_NEW_WINDOW_MS || String(48 * 60 * 60 * 1000), 10);
}

export const MARKET_AREA_TOLERANCE_M2 = 2;
export const MARKET_REQUEST_GAP_MS = parseInt(process.env.MARKET_REQUEST_GAP_MS || "400", 10);
export const MARKET_FETCH_TIMEOUT_MS = parseInt(process.env.MARKET_FETCH_TIMEOUT_MS || "20000", 10);

export const MARKET_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
