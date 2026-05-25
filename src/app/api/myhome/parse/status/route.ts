import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getQueuePosition, getQueueStats } from "@/lib/parse-queue";

export async function GET(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const listingId = request.nextUrl.searchParams.get("listingId");
  if (!listingId) {
    return NextResponse.json({ error: "listingId is required" }, { status: 400 });
  }

  const listing = await db.parsedListing.findFirst({
    where: { id: listingId, userId },
  });

  if (!listing) {
    return NextResponse.json({ error: "Listing not found" }, { status: 404 });
  }

  const queuePosition = getQueuePosition(listingId);
  const stats = getQueueStats();

  return NextResponse.json({
    status: listing.postStatus,
    queuePosition: queuePosition >= 0 ? queuePosition + 1 : null,
    queueRunning: stats.running,
    queueWaiting: stats.queued,
    listing: listing.postStatus !== "PARSING" ? listing : null,
  });
}
