import { NextResponse } from "next/server";
import { getBuildId } from "@/lib/build-id";

export const dynamic = "force-dynamic";

/** Public, unauthenticated: tells open tabs which build is serving them. */
export function GET() {
  return NextResponse.json(
    { buildId: getBuildId() },
    { headers: { "Cache-Control": "no-store" } }
  );
}
