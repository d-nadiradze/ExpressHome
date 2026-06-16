import { NextRequest, NextResponse } from "next/server";
import { cancelPrefillJob } from "@/lib/prefill-progress-redis";

export async function POST(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { jobId } = await request.json();
    if (!jobId) {
      return NextResponse.json({ error: "jobId is required" }, { status: 400 });
    }

    const result = await cancelPrefillJob(jobId, userId);
    if (!result.cancelled) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Cancel prefill error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
