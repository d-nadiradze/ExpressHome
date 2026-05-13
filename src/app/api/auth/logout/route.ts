import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { clearSessionCookie } from "@/lib/auth";

export async function POST(request: NextRequest) {
  const userId = request.headers.get("x-user-id");

  if (userId) {
    await db.session.deleteMany({ where: { userId } });
  }

  await clearSessionCookie();
  return NextResponse.json({ success: true });
}
