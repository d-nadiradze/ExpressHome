import { google } from "googleapis";

const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/userinfo.email",
];

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export function getGoogleOAuthClient() {
  return new google.auth.OAuth2(
    requiredEnv("GOOGLE_CLIENT_ID"),
    requiredEnv("GOOGLE_CLIENT_SECRET"),
    requiredEnv("GOOGLE_OAUTH_REDIRECT_URI")
  );
}

export function getGoogleAuthUrl(state: string): string {
  const oauth2 = getGoogleOAuthClient();
  return oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: GOOGLE_SCOPES,
    state,
  });
}

export async function exchangeGoogleCode(code: string) {
  const oauth2 = getGoogleOAuthClient();
  const { tokens } = await oauth2.getToken(code);
  oauth2.setCredentials(tokens);

  const oauth2Api = google.oauth2({ auth: oauth2, version: "v2" });
  const me = await oauth2Api.userinfo.get();
  const email = me.data.email?.trim();
  if (!email) {
    throw new Error("Google account email is missing from OAuth profile");
  }

  if (!tokens.refresh_token) {
    throw new Error("Google did not return a refresh token");
  }

  return {
    email,
    accessToken: tokens.access_token || "",
    refreshToken: tokens.refresh_token,
    expiryDate: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
  };
}
