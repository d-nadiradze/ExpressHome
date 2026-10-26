import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { encrypt } from "@/lib/encryption";
import { loginToSsge } from "@/lib/ssge-parser";
import { LimiterBusyError } from "@/lib/concurrency-limit";
import { browserLoginLimiter } from "@/lib/server-limits";
import {
  canRelayMintForUser,
  relayOfflineNote,
  relayRequired,
  verifyCredentialsViaRelay,
} from "@/lib/ssge-relay";
import { saveSsgeApiToken } from "@/lib/ssge-api-token-cache";

/**
 * Verify ss.ge credentials. With a token relay online the real login runs
 * there (home.ss.ge is Turnstile-blocked from the server) — the admin relay
 * or this user's own PC. Without any relay configured, fall back to the
 * headless-browser login.
 */
async function verifySsgeCredentials(
  userId: string,
  email: string,
  password: string
): Promise<{ success: boolean; accessToken?: string; error?: string }> {
  if (await canRelayMintForUser(userId)) {
    try {
      const accessToken = await verifyCredentialsViaRelay(email, password, userId);
      if (accessToken) return { success: true, accessToken };
      return {
        success: false,
        error: "verification timed out — please try again in a minute",
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : "login failed" };
    }
  }
  if (relayRequired()) {
    return { success: false, error: (await relayOfflineNote(userId)) ?? "ss.ge relay is offline" };
  }
  return browserLoginLimiter().run(() => loginToSsge({ email, password }));
}

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

    const loginResult = await verifySsgeCredentials(userId, email, password);

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

    // The relay already minted a token while verifying — keep it so the first
    // publish does not need another login.
    if (loginResult.accessToken) {
      await saveSsgeApiToken(userId, loginResult.accessToken).catch(() => null);
    }

    return NextResponse.json({ success: true, message: "ss.ge account linked successfully" });
  } catch (error) {
    if (error instanceof LimiterBusyError) {
      return NextResponse.json(
        { error: "Another account verification is in progress. Please try again shortly." },
        { status: 503 }
      );
    }
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
