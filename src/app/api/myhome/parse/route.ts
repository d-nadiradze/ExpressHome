import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { parseListing } from "@/lib/myhome-parser";
import { isValidMyhomeUrl } from "@/lib/utils";

export async function POST(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { url } = await request.json();

    if (!url) {
      return NextResponse.json({ error: "URL is required" }, { status: 400 });
    }

    if (!isValidMyhomeUrl(url)) {
      return NextResponse.json(
        { error: "Invalid URL. Must be a myhome.ge link." },
        { status: 400 }
      );
    }

    // Parse the listing
    const result = await parseListing(url);

    if (!result.success || !result.data) {
      return NextResponse.json(
        { error: result.error || "Failed to parse listing" },
        { status: 422 }
      );
    }

    const d = result.data; // price in USD from listing page currency toggle
    const listing = await db.parsedListing.create({
      data: {
        userId,
        sourceUrl: url,
        title: d.title,
        propertyType: d.propertyType,
        dealType: d.dealType,
        buildingStatus: d.buildingStatus,
        condition: d.condition,
        city: d.city,
        address: d.address,
        street: d.street,
        streetNumber: d.streetNumber,
        cadastralCode: d.cadastralCode,
        price: d.price,
        pricePerSqm: d.pricePerSqm,
        currency: d.currency,
        area: d.area,
        rooms: d.rooms,
        bedrooms: d.bedrooms,
        floor: d.floor,
        totalFloors: d.totalFloors,
        projectType: d.projectType,
        bathrooms: d.bathrooms,
        balconyArea: d.balconyArea,
        verandaArea: d.verandaArea,
        loggiaArea: d.loggiaArea,
        description: d.description,
        images: d.images,
        rawData: d.rawData,
        postStatus: "PENDING",
      },
    });

    return NextResponse.json({ success: true, listing });
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
      "verandaArea", "loggiaArea", "description", "images",
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
