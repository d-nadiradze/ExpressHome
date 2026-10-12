import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { encrypt } from "@/lib/encryption";
import { loginMyhomeApi } from "@/lib/myhome-api-prefill";
import { loginToMyhome } from "@/lib/myhome-parser";
import { LimiterBusyError } from "@/lib/concurrency-limit";
import { browserLoginLimiter } from "@/lib/server-limits";

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

    // Verify credentials the same way prefills and photo uploads authenticate:
    // one HTTP call to accounts.tnet.ge (~250 ms from the VPS). The old
    // headless-browser check ran inside this 280 MB container and reported
    // every timeout / anti-bot interstitial as "Invalid credentials".
    const apiLogin = await loginMyhomeApi({ email, password });

    if (!apiLogin.success) {
      if (apiLogin.invalidCredentials) {
        return NextResponse.json(
          { error: `Myhome login failed: ${apiLogin.error}` },
          { status: 400 }
        );
      }

      // The API itself was unreachable/blocked — only then try a real browser,
      // and say what actually went wrong if that fails too.
      console.warn(`[myhome link] API login unavailable (${apiLogin.error}); trying browser`);
      const browserLogin = await browserLoginLimiter().run(() =>
        loginToMyhome({ email, password })
      );
      if (!browserLogin.success) {
        return NextResponse.json(
          {
            error: `Could not reach myhome's login service to verify the account (${apiLogin.error}; browser: ${browserLogin.error}). Please try again in a few minutes.`,
          },
          { status: 502 }
        );
      }
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
    if (error instanceof LimiterBusyError) {
      return NextResponse.json(
        { error: "Another account verification is in progress. Please try again shortly." },
        { status: 503 }
      );
    }
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
