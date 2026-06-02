import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function GET(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const account = await db.googleAccount.findUnique({
    where: { userId },
    select: {
      googleEmail: true,
      defaultSpreadsheetId: true,
      defaultSheetTab: true,
      updatedAt: true,
    },
  });

  return NextResponse.json({ account });
}

export async function PUT(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const spreadsheetId = typeof body?.spreadsheetId === "string" ? body.spreadsheetId.trim() : "";
  const sheetTab = typeof body?.sheetTab === "string" ? body.sheetTab.trim() : "";

  if (!spreadsheetId) {
    return NextResponse.json({ error: "Spreadsheet ID is required" }, { status: 400 });
  }

  const account = await db.googleAccount.findUnique({ where: { userId } });
  if (!account) {
    return NextResponse.json(
      { error: "Google account is not connected. Please connect first." },
      { status: 409 }
    );
  }

  await db.googleAccount.update({
    where: { userId },
    data: {
      defaultSpreadsheetId: spreadsheetId,
      defaultSheetTab: sheetTab || "Sheet1",
    },
  });

  return NextResponse.json({ success: true });
}
