/**
 * Relay status for the Settings page: is any relay online (ss.ge parsing),
 * is *my* relay online (my ss.ge publishing), when was it last seen.
 */
import { NextRequest, NextResponse } from "next/server";
import { relayStatusForUser } from "@/lib/ssge-relay";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const status = await relayStatusForUser(userId);
  return NextResponse.json(status, { headers: { "Cache-Control": "no-store" } });
}
