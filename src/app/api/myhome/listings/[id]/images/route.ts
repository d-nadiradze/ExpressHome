import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  MAX_LISTING_IMAGES,
  readListingImageFile,
  saveListingImage,
} from "@/lib/listing-images";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: RouteContext) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: listingId } = await context.params;
  const fileId = request.nextUrl.searchParams.get("fileId");

  if (!fileId) {
    return NextResponse.json({ error: "fileId is required" }, { status: 400 });
  }

  const listing = await db.parsedListing.findFirst({
    where: { id: listingId, userId },
  });

  if (!listing) {
    return NextResponse.json({ error: "Listing not found" }, { status: 404 });
  }

  const images = (listing.images as string[]) || [];
  const hasFile = images.some((url) => url.includes(`fileId=${fileId}`));
  if (!hasFile) {
    return NextResponse.json({ error: "Image not found" }, { status: 404 });
  }

  const file = await readListingImageFile(userId, listingId, fileId);
  if (!file) {
    return NextResponse.json({ error: "Image file missing" }, { status: 404 });
  }

  return new NextResponse(new Uint8Array(file.buffer), {
    headers: {
      "Content-Type": file.mimeType,
      "Cache-Control": "private, max-age=3600",
    },
  });
}

export async function POST(request: NextRequest, context: RouteContext) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: listingId } = await context.params;

  const listing = await db.parsedListing.findFirst({
    where: { id: listingId, userId },
  });

  if (!listing) {
    return NextResponse.json({ error: "Listing not found" }, { status: 404 });
  }

  const existing = (listing.images as string[]) || [];
  const formData = await request.formData();
  const files = formData.getAll("files").filter((f): f is File => f instanceof File);

  if (files.length === 0) {
    return NextResponse.json({ error: "No files provided" }, { status: 400 });
  }

  if (existing.length + files.length > MAX_LISTING_IMAGES) {
    return NextResponse.json(
      {
        error: `Maximum ${MAX_LISTING_IMAGES} images per listing (${existing.length} already)`,
      },
      { status: 400 }
    );
  }

  const newUrls: string[] = [];

  try {
    for (const file of files) {
      const saved = await saveListingImage(userId, listingId, file);
      newUrls.push(saved.url);
    }
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to save image" },
      { status: 400 }
    );
  }

  const images = [...existing, ...newUrls];

  const updated = await db.parsedListing.update({
    where: { id: listingId },
    data: { images },
  });

  return NextResponse.json({
    success: true,
    urls: newUrls,
    images: updated.images,
  });
}
