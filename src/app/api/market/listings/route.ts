import { NextRequest, NextResponse } from "next/server";
import { MarketPlatform, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  MARKET_CITY_KA,
  MARKET_DEAL_TYPE_KA,
  isMarketPropertyType,
  marketNewWindowMs,
} from "@/lib/market-constants";

const LIST_LIMIT = 80;
const MAX_MINUTES = 60 * 24 * 30; // 30 days

function parsePlatform(value: string | null): MarketPlatform | undefined {
  if (!value) return undefined;
  const upper = value.toUpperCase();
  if (upper === "MYHOME" || upper === "SSGE") return upper;
  return undefined;
}

function parseMinutes(value: string | null): number | null {
  if (value == null || value.trim() === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return null;
  return Math.min(n, MAX_MINUTES);
}

export async function GET(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = request.nextUrl;
  const section = searchParams.get("section") || "special";
  if (section !== "new" && section !== "special") {
    return NextResponse.json(
      { error: "section must be new or special" },
      { status: 400 }
    );
  }

  const propertyType = searchParams.get("propertyType");
  if (propertyType && !isMarketPropertyType(propertyType)) {
    return NextResponse.json({ error: "Unknown propertyType" }, { status: 400 });
  }

  const platform = parsePlatform(searchParams.get("platform"));
  if (searchParams.get("platform") && !platform) {
    return NextResponse.json({ error: "platform must be MYHOME or SSGE" }, { status: 400 });
  }

  const minutesParam = searchParams.get("minutes");
  const minutes = parseMinutes(minutesParam);
  if (minutesParam != null && minutesParam.trim() !== "" && minutes == null) {
    return NextResponse.json(
      { error: "minutes must be a positive integer" },
      { status: 400 }
    );
  }

  const where: Prisma.MarketListingWhereInput = {
    sellerType: "OWNER",
    dealType: MARKET_DEAL_TYPE_KA,
    city: { in: [MARKET_CITY_KA, "Tbilisi", "tbilisi"] },
  };

  if (propertyType) where.propertyType = propertyType;
  if (platform) where.platform = platform;

  let windowMs = marketNewWindowMs();
  if (section === "special") {
    where.isSpecial = true;
  } else {
    windowMs = minutes != null ? minutes * 60_000 : marketNewWindowMs();
    where.firstSeenAt = { gte: new Date(Date.now() - windowMs) };
  }

  const [listings, total, sync] = await Promise.all([
    db.marketListing.findMany({
      where,
      orderBy:
        section === "new"
          ? [{ firstSeenAt: "desc" }, { sourcePostedAt: "desc" }]
          : [{ lastSeenAt: "desc" }, { sourcePostedAt: "desc" }],
      take: LIST_LIMIT,
      select: {
        id: true,
        platform: true,
        externalId: true,
        url: true,
        sellerType: true,
        propertyType: true,
        dealType: true,
        city: true,
        district: true,
        street: true,
        streetNumber: true,
        area: true,
        rooms: true,
        floor: true,
        cadastralCode: true,
        price: true,
        currency: true,
        title: true,
        imageUrl: true,
        sourcePostedAt: true,
        firstSeenAt: true,
        lastSeenAt: true,
        isSpecial: true,
      },
    }),
    db.marketListing.count({ where }),
    db.marketSyncState.findUnique({ where: { id: "singleton" } }),
  ]);

  return NextResponse.json({
    section,
    listings,
    total,
    limit: LIST_LIMIT,
    minutes: section === "new" ? minutes : null,
    windowMs: section === "new" ? windowMs : null,
    lastPolledAt: sync?.lastPolledAt ?? null,
    lastError: sync?.lastError ?? null,
    newWindowMs: marketNewWindowMs(),
  });
}
