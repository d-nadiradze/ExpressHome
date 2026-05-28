import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isValidListingUrl } from "@/lib/utils";
import { enqueueParseJob } from "@/lib/parse-queue";
import {
  findExistingParsedListing,
  normalizeListingUrl,
} from "@/lib/listing-url";

export async function POST(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = await request.json();
    const { url, reparse, listingId } = body;

    if (reparse) {
      if (!listingId) {
        return NextResponse.json({ error: "Listing ID is required" }, { status: 400 });
      }

      const existing = await db.parsedListing.findFirst({
        where: { id: listingId, userId },
      });

      if (!existing) {
        return NextResponse.json({ error: "Listing not found" }, { status: 404 });
      }

      if (existing.postStatus !== "PARSING") {
        await db.parsedListing.update({
          where: { id: existing.id },
          data: { postStatus: "PARSING" },
        });
        enqueueParseJob({
          listingId: existing.id,
          url: existing.sourceUrl,
          userId,
        });
      }

      return NextResponse.json(
        { success: true, listingId: existing.id, reparse: true },
        { status: 202 }
      );
    }

    if (!url) {
      return NextResponse.json({ error: "URL is required" }, { status: 400 });
    }

    if (!isValidListingUrl(url)) {
      return NextResponse.json(
        { error: "Invalid URL. Must be a myhome.ge or ss.ge link." },
        { status: 400 }
      );
    }

    const normalizedUrl = normalizeListingUrl(url);
    const existing = await findExistingParsedListing(userId, url);

    if (existing) {
      if (existing.postStatus === "PARSING") {
        return NextResponse.json(
          { success: true, listingId: existing.id },
          { status: 202 }
        );
      }

      if (
        existing.postStatus === "PENDING" ||
        existing.postStatus === "POSTED"
      ) {
        return NextResponse.json({
          success: true,
          listingId: existing.id,
          cached: true,
        });
      }

      if (existing.postStatus === "FAILED") {
        await db.parsedListing.update({
          where: { id: existing.id },
          data: { postStatus: "PARSING", sourceUrl: normalizedUrl },
        });
        enqueueParseJob({
          listingId: existing.id,
          url: normalizedUrl,
          userId,
        });
        return NextResponse.json(
          { success: true, listingId: existing.id },
          { status: 202 }
        );
      }
    }

    const listing = await db.parsedListing.create({
      data: {
        userId,
        sourceUrl: normalizedUrl,
        postStatus: "PARSING",
      },
    });

    enqueueParseJob({ listingId: listing.id, url: normalizedUrl, userId });

    return NextResponse.json(
      { success: true, listingId: listing.id },
      { status: 202 }
    );
  } catch (error) {
    console.error("Parse error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// GET: list user's parsed listings
export async function GET(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const listings = await db.parsedListing.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      sourceUrl: true,
      title: true,
      price: true,
      currency: true,
      description: true,
      address: true,
      rooms: true,
      area: true,
      floor: true,
      totalFloors: true,
      images: true,
      rawData: true,
      postStatus: true,
      postUrl: true,
      createdAt: true,
    },
  });

  return NextResponse.json({ listings });
}

// PUT: update a parsed listing
export async function PUT(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = await request.json();
    const { id } = body;

    if (!id) {
      return NextResponse.json({ error: "Listing ID is required" }, { status: 400 });
    }

    const existing = await db.parsedListing.findFirst({
      where: { id, userId },
    });

    if (!existing) {
      return NextResponse.json({ error: "Listing not found" }, { status: 404 });
    }

    const updatableFields = [
      "title", "propertyType", "dealType", "buildingStatus", "condition",
      "city", "address", "street", "streetNumber", "cadastralCode",
      "price", "pricePerSqm", "currency", "area", "rooms", "bedrooms",
      "floor", "totalFloors", "projectType", "bathrooms", "balconyArea",
      "verandaArea", "loggiaArea", "description", "images", "rawData",
    ] as const;

    const data: Record<string, unknown> = {};
    for (const field of updatableFields) {
      if (body[field] !== undefined) data[field] = body[field];
    }

    const listing = await db.parsedListing.update({
      where: { id },
      data,
    });

    return NextResponse.json({ success: true, listing });
  } catch (error) {
    console.error("Update listing error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// DELETE: remove a parsed listing
export async function DELETE(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { id } = await request.json();

    if (!id) {
      return NextResponse.json({ error: "Listing ID is required" }, { status: 400 });
    }

    const existing = await db.parsedListing.findFirst({
      where: { id, userId },
    });

    if (!existing) {
      return NextResponse.json({ error: "Listing not found" }, { status: 404 });
    }

    await db.parsedListing.delete({ where: { id } });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Delete listing error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
