import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { encrypt } from "@/lib/encryption";
import { loginToMyhome } from "@/lib/myhome-parser";

// GET: check if user has linked myhome account
export async function GET(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const account = await db.myhomeAccount.findUnique({
    where: { userId },
    select: { myhomeEmail: true, isVerified: true, lastLoginAt: true, updatedAt: true },
  });

  return NextResponse.json({ account });
}

// POST: link or update myhome account
export async function POST(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { email, password } = await request.json();

    if (!email || !password) {
      return NextResponse.json(
        { error: "Myhome email and password are required" },
        { status: 400 }
      );
    }

    // Verify credentials by attempting login
    const loginResult = await loginToMyhome({ email, password });

    if (!loginResult.success) {
      return NextResponse.json(
        { error: `Myhome login failed: ${loginResult.error}` },
        { status: 400 }
      );
    }

    // Encrypt password before storing
    const encryptedPassword = encrypt(password);

    await db.myhomeAccount.upsert({
      where: { userId },
      update: {
        myhomeEmail: email,
        myhomePassword: encryptedPassword,
        isVerified: true,
        lastLoginAt: new Date(),
      },
      create: {
        userId,
        myhomeEmail: email,
        myhomePassword: encryptedPassword,
        isVerified: true,
        lastLoginAt: new Date(),
      },
    });

    return NextResponse.json({ success: true, message: "Myhome account linked successfully" });
  } catch (error) {
    console.error("Link account error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// DELETE: unlink myhome account
export async function DELETE(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  await db.myhomeAccount.deleteMany({ where: { userId } });
  return NextResponse.json({ success: true });
}
