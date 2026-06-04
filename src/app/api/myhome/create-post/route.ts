import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { initPrefillProgress } from "@/lib/prefill-progress-redis";
import { getPrefillQueue } from "@/lib/bullmq-queue";

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

    const myhomeAccount = await db.myhomeAccount.findUnique({
      where: { userId },
    });

    if (!myhomeAccount || !myhomeAccount.isVerified) {
      return NextResponse.json(
        { error: "You must link your myhome.ge account first" },
        { status: 400 }
      );
    }

    const jobId = `myhome-${listingId}-${Date.now()}`;
    await initPrefillProgress(jobId, "myhome", listingId, userId);

    await getPrefillQueue().add(jobId, {
      type: "myhome",
      jobId,
      listingId,
      userId,
    });

    return NextResponse.json(
      { success: true, jobId, platform: "myhome" },
      { status: 202 }
    );
  } catch (error) {
    console.error("Create post error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
