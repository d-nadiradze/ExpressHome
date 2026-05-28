import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { encrypt } from "@/lib/encryption";
import { loginToSsge } from "@/lib/ssge-parser";

export async function GET(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const account = await db.ssgeAccount.findUnique({
    where: { userId },
    select: { ssgeEmail: true, isVerified: true, lastLoginAt: true, updatedAt: true },
  });

  return NextResponse.json({ account });
}

export async function POST(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { email, password } = await request.json();

    if (!email || !password) {
      return NextResponse.json(
        { error: "ss.ge email and password are required" },
        { status: 400 }
      );
    }

    const loginResult = await loginToSsge({ email, password });

    if (!loginResult.success) {
      return NextResponse.json(
        { error: `ss.ge login failed: ${loginResult.error}` },
        { status: 400 }
      );
    }

    const encryptedPassword = encrypt(password);

    await db.ssgeAccount.upsert({
      where: { userId },
      update: {
        ssgeEmail: email,
        ssgePassword: encryptedPassword,
        isVerified: true,
        lastLoginAt: new Date(),
      },
      create: {
        userId,
        ssgeEmail: email,
        ssgePassword: encryptedPassword,
        isVerified: true,
        lastLoginAt: new Date(),
      },
    });

    return NextResponse.json({ success: true, message: "ss.ge account linked successfully" });
  } catch (error) {
    console.error("Link ss.ge account error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  await db.ssgeAccount.deleteMany({ where: { userId } });
  return NextResponse.json({ success: true });
}
