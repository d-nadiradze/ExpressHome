import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { encrypt } from "@/lib/encryption";
import { publicUrl } from "@/lib/auth";
import { exchangeGoogleCode } from "@/lib/google-oauth";

const OAUTH_STATE_COOKIE = "google_oauth_state";

type OauthStatePayload = {
  state: string;
  userId: string;
  next: string;
};

function decodeStateCookie(value: string | undefined): OauthStatePayload | null {
  if (!value) return null;
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as OauthStatePayload;
  } catch {
    return null;
  }
}

function errorRedirect(request: NextRequest, path: string, message: string) {
  const url = publicUrl(path, request);
  url.searchParams.set("googleError", message);
  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const decoded = decodeStateCookie(request.cookies.get(OAUTH_STATE_COOKIE)?.value);
  const nextPath = decoded?.next?.startsWith("/") ? decoded.next : "/dashboard/link-account";

  if (!code || !state || !decoded) {
    return errorRedirect(request, nextPath, "Google authentication failed");
  }
  if (decoded.userId !== userId || decoded.state !== state) {
    return errorRedirect(request, nextPath, "Invalid Google OAuth state");
  }

  try {
    const tokenData = await exchangeGoogleCode(code);
    await db.googleAccount.upsert({
      where: { userId },
      update: {
        googleEmail: tokenData.email,
        accessToken: encrypt(tokenData.accessToken),
        refreshToken: encrypt(tokenData.refreshToken),
        tokenExpiryDate: tokenData.expiryDate,
      },
      create: {
        userId,
        googleEmail: tokenData.email,
        accessToken: encrypt(tokenData.accessToken),
        refreshToken: encrypt(tokenData.refreshToken),
        tokenExpiryDate: tokenData.expiryDate,
      },
    });

    const successUrl = publicUrl(nextPath, request);
    successUrl.searchParams.set("googleConnected", "1");
    const response = NextResponse.redirect(successUrl);
    response.cookies.delete(OAUTH_STATE_COOKIE);
    return response;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Google authentication failed";
    const response = errorRedirect(request, nextPath, message);
    response.cookies.delete(OAUTH_STATE_COOKIE);
    return response;
  }
}
