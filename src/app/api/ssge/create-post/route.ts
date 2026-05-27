import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { decrypt } from "@/lib/encryption";
import { createSsgePost } from "@/lib/ssge-parser";
import { enqueuePrefill } from "@/lib/prefill-queue";

export async function POST(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { listingId } = await request.json();

    if (!listingId) {
      return NextResponse.json({ error: "Listing ID is required" }, { status: 400 });
    }

    const listing = await db.parsedListing.findFirst({
      where: { id: listingId, userId },
    });

    if (!listing) {
      return NextResponse.json({ error: "Listing not found" }, { status: 404 });
    }

    const ssgeAccount = await db.ssgeAccount.findUnique({
      where: { userId },
    });

    if (!ssgeAccount || !ssgeAccount.isVerified) {
      return NextResponse.json(
        { error: "You must link your ss.ge account first" },
        { status: 400 }
      );
    }

    const password = decrypt(ssgeAccount.ssgePassword);

    await db.parsedListing.update({
      where: { id: listingId },
      data: { ssgePostStatus: "PENDING" },
    });

    const result = await enqueuePrefill(
      `ssge-${listingId}`,
      () => createSsgePost(
      { email: ssgeAccount.ssgeEmail, password },
      {
        title: listing.title || "",
        propertyType: listing.propertyType || "",
        dealType: listing.dealType || "",
        buildingStatus: listing.buildingStatus || "",
        condition: listing.condition || "",
        city: listing.city || "",
        address: listing.address || "",
        street: listing.street || "",
        streetNumber: listing.streetNumber || "",
        cadastralCode: listing.cadastralCode || "",
        price: listing.price || "",
        pricePerSqm: listing.pricePerSqm || "",
        currency: listing.currency || "USD",
        area: listing.area || "",
        rooms: listing.rooms || "",
        bedrooms: listing.bedrooms || "",
        floor: listing.floor || "",
        totalFloors: listing.totalFloors || "",
        projectType: listing.projectType || "",
        bathrooms: listing.bathrooms || "",
        balconyArea: listing.balconyArea || "",
        verandaArea: listing.verandaArea || "",
        loggiaArea: listing.loggiaArea || "",
        description: listing.description || "",
        images: (listing.images as string[]) || [],
        rawData: (listing.rawData as Record<string, string>) || {},
      },
      { listingId, userId, sourceUrl: listing.sourceUrl }
    ));

    if (!result.success) {
      await db.parsedListing.update({
        where: { id: listingId },
        data: { ssgePostStatus: "FAILED" },
      });
      return NextResponse.json(
        { error: result.error || "Failed to pre-fill form" },
        { status: 422 }
      );
    }

    if (result.postUrl) {
      await db.parsedListing.update({
        where: { id: listingId },
        data: { ssgePostUrl: result.postUrl },
      });
    }

    return NextResponse.json({ success: true, postUrl: result.postUrl });
  } catch (error) {
    console.error("Create ss.ge post error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
