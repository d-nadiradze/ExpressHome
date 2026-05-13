import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { decrypt } from "@/lib/encryption";
import { createMyhomePost } from "@/lib/myhome-parser";

export async function POST(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { listingId } = await request.json();

    if (!listingId) {
      return NextResponse.json({ error: "Listing ID is required" }, { status: 400 });
    }

    // Get the parsed listing
    const listing = await db.parsedListing.findFirst({
      where: { id: listingId, userId },
    });

    if (!listing) {
      return NextResponse.json({ error: "Listing not found" }, { status: 404 });
    }

    // Get user's myhome credentials
    const myhomeAccount = await db.myhomeAccount.findUnique({
      where: { userId },
    });

    if (!myhomeAccount || !myhomeAccount.isVerified) {
      return NextResponse.json(
        { error: "You must link your myhome.ge account first" },
        { status: 400 }
      );
    }

    // Decrypt password
    const password = decrypt(myhomeAccount.myhomePassword);

    // Mark as in-progress
    await db.parsedListing.update({
      where: { id: listingId },
      data: { postStatus: "PENDING" },
    });

    // Pre-fill the form in a visible browser
    const result = await createMyhomePost(
      { email: myhomeAccount.myhomeEmail, password },
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
      }
    );

    if (!result.success) {
      await db.parsedListing.update({
        where: { id: listingId },
        data: { postStatus: "FAILED" },
      });
      return NextResponse.json(
        { error: result.error || "Failed to pre-fill form" },
        { status: 422 }
      );
    }

    // Keep PENDING since user still needs to review and submit in the browser
    return NextResponse.json({ success: true, postUrl: result.postUrl });
  } catch (error) {
    console.error("Create post error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
