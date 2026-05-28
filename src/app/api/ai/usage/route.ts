import { NextRequest, NextResponse } from "next/server";
import { getUserTokenUsageStatus } from "@/lib/ai-token-usage";

export async function GET(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const status = await getUserTokenUsageStatus(userId);
  return NextResponse.json(status);
}
