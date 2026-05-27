import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { initPrefillProgress } from "@/lib/prefill-progress";
import { runSsgePrefillJob } from "@/lib/prefill-runner";

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

    const jobId = `ssge-${listingId}-${Date.now()}`;
    initPrefillProgress(jobId, "ssge", listingId, userId);

    void runSsgePrefillJob(jobId, listingId, userId);

    return NextResponse.json(
      { success: true, jobId, platform: "ssge" },
      { status: 202 }
    );
  } catch (error) {
    console.error("Create ss.ge post error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
