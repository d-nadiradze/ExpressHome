import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { appendListingToGoogleSheet } from "@/lib/google-sheets";

export async function POST(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const listingId = body?.listingId;
    const spreadsheetId =
      typeof body?.spreadsheetId === "string" ? body.spreadsheetId : undefined;
    const sheetTab = typeof body?.sheetTab === "string" ? body.sheetTab : undefined;

    if (!listingId || typeof listingId !== "string") {
      return NextResponse.json({ error: "Listing ID is required" }, { status: 400 });
    }

    const listing = await db.parsedListing.findFirst({
      where: { id: listingId, userId },
      select: {
        id: true,
        sourceUrl: true,
        title: true,
        propertyType: true,
        dealType: true,
        buildingStatus: true,
        condition: true,
        city: true,
        address: true,
        street: true,
        streetNumber: true,
        cadastralCode: true,
        price: true,
        pricePerSqm: true,
        currency: true,
        area: true,
        rooms: true,
        bedrooms: true,
        floor: true,
        totalFloors: true,
        projectType: true,
        bathrooms: true,
        balconyArea: true,
        verandaArea: true,
        loggiaArea: true,
        postStatus: true,
        ssgePostStatus: true,
        createdAt: true,
      },
    });

    if (!listing) {
      return NextResponse.json({ error: "Listing not found" }, { status: 404 });
    }

    if (listing.postStatus === "PARSING") {
      return NextResponse.json(
        { error: "Listing is still parsing. Please try again when parsing completes." },
        { status: 409 }
      );
    }

    const googleAccount = await db.googleAccount.findUnique({
      where: { userId },
      select: {
        userId: true,
        accessToken: true,
        refreshToken: true,
        tokenExpiryDate: true,
        defaultSpreadsheetId: true,
        defaultSheetTab: true,
      },
    });

    if (!googleAccount) {
      return NextResponse.json(
        { error: "Google account is not connected. Please connect Google first." },
        { status: 409 }
      );
    }

    await appendListingToGoogleSheet(listing, googleAccount, {
      spreadsheetId,
      sheetTab,
    });

    if (spreadsheetId || sheetTab) {
      await db.googleAccount.update({
        where: { userId },
        data: {
          defaultSpreadsheetId: spreadsheetId || googleAccount.defaultSpreadsheetId,
          defaultSheetTab: sheetTab || googleAccount.defaultSheetTab,
        },
      });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to export listing to Google Sheets";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
