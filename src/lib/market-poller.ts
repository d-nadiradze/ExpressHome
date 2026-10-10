/**
 * Background poll: search myhome/ss.ge JSON APIs, upsert MarketListing rows,
 * fetch details only for newly discovered IDs, recompute isSpecial.
 */
import { MarketPlatform, MarketSellerType, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  MARKET_CITY_KA,
  MARKET_DEAL_TYPE_KA,
  MARKET_PROPERTY_TYPES,
  SSGE_MARKET_TYPE_IDS,
  isMarketMyhomeEnabled,
  marketAgencyPages,
  marketDetailMaxPerPoll,
  marketOwnerPages,
  marketPageSize,
  marketPollJitterMs,
  marketRequestPauseMs,
  type MarketPropertyType,
} from "@/lib/market-constants";
import { buildAgencyIndex, findAgencyDuplicateIndexed } from "@/lib/market-duplicate";
import {
  MyhomeApiCooldownError,
  fetchMyhomeMarketDetail,
  searchMyhomeMarket,
} from "@/lib/market-search-myhome";
import { fetchSsgeMarketDetail, searchSsgeMarket } from "@/lib/market-search-ssge";
import type { MarketCard, MarketSellerSlice } from "@/lib/market-types";

const SYNC_ID = "singleton";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Human-ish gap between two portal requests: mean ±50%. */
async function pace(): Promise<void> {
  const mean = marketRequestPauseMs();
  if (mean <= 0) return;
  await sleep(Math.round(mean * (0.5 + Math.random())));
}

function uniqueCards(cards: MarketCard[]): MarketCard[] {
  const seen = new Set<string>();
  const out: MarketCard[] = [];
  for (const card of cards) {
    const key = `${card.platform}:${card.externalId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(card);
  }
  return out;
}

/**
 * Collects one seller slice, deduplicating as it goes. Keyed by platform+id in
 * a Map rather than re-scanning the accumulated array per card, which on a
 * 1 GB host was both the CPU cost and a second copy of every card in memory.
 */
async function searchSlice(
  slice: MarketSellerSlice,
  pages: number,
  pageSize: number
): Promise<MarketCard[]> {
  const byKey = new Map<string, MarketCard>();

  const addPage = (page: MarketCard[]): number => {
    let added = 0;
    for (const card of page) {
      const key = `${card.platform}:${card.externalId}`;
      if (byKey.has(key)) continue;
      byKey.set(key, card);
      added++;
    }
    return added;
  };

  const myhomeEnabled = isMarketMyhomeEnabled();

  for (const propertyType of MARKET_PROPERTY_TYPES) {
    for (let page = 1; myhomeEnabled && page <= pages; page++) {
      try {
        await pace();
        const myhome = await searchMyhomeMarket(propertyType, slice, page, pageSize);
        if (myhome.length === 0) break;
        // Same ids again means the API ignored our paging — stop paging this type.
        if (addPage(myhome) === 0) break;
      } catch (err) {
        // Parked API: the first rejection already logged why; stay quiet.
        if (!(err instanceof MyhomeApiCooldownError)) {
          console.warn(`[market] myhome ${slice} ${propertyType} p${page}:`, err);
        }
        break;
      }
    }

    for (const typeId of SSGE_MARKET_TYPE_IDS[propertyType]) {
      for (let page = 1; page <= pages; page++) {
        try {
          await pace();
          const ssge = await searchSsgeMarket(propertyType, slice, page, pageSize, typeId);
          if (ssge.length === 0) break;
          if (addPage(ssge) === 0) break;
        } catch (err) {
          console.warn(`[market] ss.ge ${slice} ${propertyType}/${typeId} p${page}:`, err);
          break;
        }
      }
    }
  }

  return [...byKey.values()];
}

async function existingKeys(
  cards: MarketCard[]
): Promise<Set<string>> {
  if (cards.length === 0) return new Set();
  const rows = await db.marketListing.findMany({
    where: {
      OR: cards.map((c) => ({ platform: c.platform, externalId: c.externalId })),
    },
    select: { platform: true, externalId: true },
  });
  return new Set(rows.map((r) => `${r.platform}:${r.externalId}`));
}

function mergeDetail(
  card: MarketCard,
  detail: Partial<MarketCard>
): MarketCard {
  return {
    ...card,
    cadastralCode: detail.cadastralCode || card.cadastralCode,
    street: detail.street || card.street,
    streetNumber: detail.streetNumber || card.streetNumber,
    floor: detail.floor || card.floor,
    area: detail.area || card.area,
    sourcePostedAt: detail.sourcePostedAt ?? card.sourcePostedAt,
  };
}

async function enrichNewCards(cards: MarketCard[], known: Set<string>): Promise<MarketCard[]> {
  const cap = marketDetailMaxPerPoll();
  const fresh = cards.filter((c) => !known.has(`${c.platform}:${c.externalId}`));
  const toFetch = fresh.slice(0, cap);
  if (toFetch.length < fresh.length) {
    console.warn(
      `[market] detail cap ${cap} hit; skipping ${fresh.length - toFetch.length} new IDs this tick`
    );
  }

  const byKey = new Map(cards.map((c) => [`${c.platform}:${c.externalId}`, c]));

  for (const card of toFetch) {
    try {
      await pace();
      const detail =
        card.platform === "MYHOME"
          ? await fetchMyhomeMarketDetail(card.externalId)
          : await fetchSsgeMarketDetail(card.externalId);
      byKey.set(`${card.platform}:${card.externalId}`, mergeDetail(card, detail));
    } catch (err) {
      if (err instanceof MyhomeApiCooldownError) continue;
      console.warn(`[market] detail ${card.platform}:${card.externalId}:`, err);
    }
  }

  return [...byKey.values()];
}

function toUpsertData(card: MarketCard, now: Date): Prisma.MarketListingUncheckedCreateInput {
  return {
    platform: card.platform,
    externalId: card.externalId,
    url: card.url,
    sellerType: card.sellerType,
    propertyType: card.propertyType,
    dealType: card.dealType,
    city: card.city || MARKET_CITY_KA,
    district: card.district || null,
    street: card.street || null,
    streetNumber: card.streetNumber || null,
    area: card.area || null,
    rooms: card.rooms || null,
    floor: card.floor || null,
    cadastralCode: card.cadastralCode || null,
    price: card.price || null,
    currency: card.currency || null,
    title: card.title || null,
    imageUrl: card.imageUrl || null,
    sourcePostedAt: card.sourcePostedAt,
    lastSeenAt: now,
  };
}

async function upsertCards(cards: MarketCard[], now: Date): Promise<void> {
  for (const card of cards) {
    const data = toUpsertData(card, now);
    await db.marketListing.upsert({
      where: {
        platform_externalId: { platform: card.platform, externalId: card.externalId },
      },
      create: {
        ...data,
        firstSeenAt: now,
        isSpecial: card.sellerType === "OWNER",
      },
      update: {
        url: data.url,
        sellerType: data.sellerType,
        propertyType: data.propertyType,
        dealType: data.dealType,
        city: data.city,
        district: data.district,
        street: data.street || undefined,
        streetNumber: data.streetNumber || undefined,
        area: data.area || undefined,
        rooms: data.rooms || undefined,
        floor: data.floor || undefined,
        cadastralCode: data.cadastralCode || undefined,
        price: data.price,
        currency: data.currency,
        title: data.title,
        imageUrl: data.imageUrl || undefined,
        sourcePostedAt: data.sourcePostedAt ?? undefined,
        lastSeenAt: now,
      },
    });
  }
}

type MatchRow = {
  id: string;
  sellerType: MarketSellerType;
  platform: MarketPlatform;
  propertyType: string;
  city: string | null;
  street: string | null;
  streetNumber: string | null;
  area: string | null;
  floor: string | null;
  cadastralCode: string | null;
};

const MATCH_SELECT = {
  id: true,
  sellerType: true,
  platform: true,
  propertyType: true,
  city: true,
  street: true,
  streetNumber: true,
  area: true,
  floor: true,
  cadastralCode: true,
} as const;

const RECOMPUTE_PAGE_SIZE = 500;
const UPDATE_CHUNK = 500;

const MARKET_SCOPE: Prisma.MarketListingWhereInput = {
  dealType: MARKET_DEAL_TYPE_KA,
  city: { in: [MARKET_CITY_KA, "Tbilisi", "tbilisi"] },
  propertyType: { in: [...MARKET_PROPERTY_TYPES] },
};

/** Page through a slice so the worker never holds the whole table at once. */
async function forEachPage(
  sellerType: Prisma.MarketListingWhereInput["sellerType"],
  onPage: (rows: MatchRow[]) => void | Promise<void>
): Promise<number> {
  let cursor: string | undefined;
  let seen = 0;

  for (;;) {
    const rows: MatchRow[] = await db.marketListing.findMany({
      where: { ...MARKET_SCOPE, sellerType },
      select: MATCH_SELECT,
      orderBy: { id: "asc" },
      take: RECOMPUTE_PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (rows.length === 0) break;

    seen += rows.length;
    await onPage(rows);
    if (rows.length < RECOMPUTE_PAGE_SIZE) break;
    cursor = rows[rows.length - 1].id;
  }

  return seen;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

async function recomputeSpecial(): Promise<{ owners: number; special: number }> {
  // Only agency/agent rows are indexed; owners are streamed against the index.
  const agencyRows: MatchRow[] = [];
  await forEachPage({ in: ["AGENCY", "AGENT"] }, (rows) => {
    agencyRows.push(...rows);
  });
  const index = buildAgencyIndex(agencyRows);
  agencyRows.length = 0;

  const specialIds: string[] = [];
  const notSpecialIds: string[] = [];
  const matchCreates: { ownerListingId: string; agencyListingId: string; reason: string }[] = [];

  const owners = await forEachPage("OWNER", (rows) => {
    for (const owner of rows) {
      const hit = findAgencyDuplicateIndexed(owner, index);
      if (hit) {
        notSpecialIds.push(owner.id);
        matchCreates.push({
          ownerListingId: owner.id,
          agencyListingId: hit.listing.id,
          reason: hit.reason,
        });
      } else {
        specialIds.push(owner.id);
      }
    }
  });

  await db.$transaction(async (tx) => {
    await tx.marketListingMatch.deleteMany({});
    for (const batch of chunk(matchCreates, UPDATE_CHUNK)) {
      await tx.marketListingMatch.createMany({ data: batch, skipDuplicates: true });
    }
    for (const batch of chunk(specialIds, UPDATE_CHUNK)) {
      await tx.marketListing.updateMany({
        where: { id: { in: batch } },
        data: { isSpecial: true },
      });
    }
    for (const batch of chunk(notSpecialIds, UPDATE_CHUNK)) {
      await tx.marketListing.updateMany({
        where: { id: { in: batch } },
        data: { isSpecial: false },
      });
    }
    await tx.marketListing.updateMany({
      where: { sellerType: { not: "OWNER" }, isSpecial: true },
      data: { isSpecial: false },
    });
  });

  return { owners, special: specialIds.length };
}

async function writeSyncState(lastPolledAt: Date, lastError: string | null): Promise<void> {
  await db.marketSyncState.upsert({
    where: { id: SYNC_ID },
    create: { id: SYNC_ID, lastPolledAt, lastError },
    update: { lastPolledAt, lastError },
  });
}

export async function runMarketPoll(): Promise<void> {
  // Scheduled ticks fire on an exact clock; wait a random slice first so the
  // portals never see us at :00 every hour.
  const jitter = Math.round(Math.random() * marketPollJitterMs());
  if (jitter > 0) {
    console.log(`[market] poll in ${Math.round(jitter / 1000)}s (jitter)`);
    await sleep(jitter);
  }
  const now = new Date();
  console.log("[market] poll start");

  try {
    const ownerPages = marketOwnerPages();
    const agencyPages = marketAgencyPages();
    const pageSize = marketPageSize();

    const owners = await searchSlice("owner", ownerPages, pageSize);
    const agencies = await searchSlice("agency", agencyPages, pageSize);

    const cards = uniqueCards([...owners, ...agencies]);
    console.log(
      `[market] search returned ${owners.length} owner + ${agencies.length} agency cards (${cards.length} unique)`
    );

    const known = await existingKeys(cards);
    const enriched = await enrichNewCards(cards, known);
    await upsertCards(enriched, now);
    const stats = await recomputeSpecial();
    await writeSyncState(now, null);

    console.log(
      `[market] poll done — upserted ${enriched.length}, owners=${stats.owners}, special=${stats.special}`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[market] poll failed:", message);
    await writeSyncState(now, message).catch((writeErr) => {
      console.error("[market] failed to persist sync error:", writeErr);
    });
    throw err;
  }
}

export type { MarketPropertyType };
