import { NextRequest, NextResponse } from "next/server";
import { getPrefillStatusPayload } from "@/lib/prefill-progress";

export async function GET(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const jobId = request.nextUrl.searchParams.get("jobId");
  if (!jobId) {
    return NextResponse.json({ error: "jobId is required" }, { status: 400 });
  }

  const payload = getPrefillStatusPayload(jobId);
  if (!payload) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  if (payload.userId !== userId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return NextResponse.json(payload);
}
