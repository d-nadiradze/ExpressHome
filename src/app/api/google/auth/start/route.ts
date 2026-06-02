import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { shouldUseSecureCookies } from "@/lib/auth";
import { getGoogleAuthUrl } from "@/lib/google-oauth";

const OAUTH_STATE_COOKIE = "google_oauth_state";

type OauthStatePayload = {
  state: string;
  userId: string;
  next: string;
};

function encodeStateCookie(payload: OauthStatePayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export async function GET(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const nextPath = request.nextUrl.searchParams.get("next") || "/dashboard/link-account";
  const next = nextPath.startsWith("/") ? nextPath : "/dashboard/link-account";
  const state = crypto.randomBytes(24).toString("hex");

  const redirectUrl = getGoogleAuthUrl(state);
  const response = NextResponse.redirect(redirectUrl);
  response.cookies.set(OAUTH_STATE_COOKIE, encodeStateCookie({ state, userId, next }), {
    httpOnly: true,
    secure: shouldUseSecureCookies(request),
    sameSite: "lax",
    maxAge: 60 * 10,
    path: "/",
  });
  return response;
}
