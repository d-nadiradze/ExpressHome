/**
 * Per-user cached Bearer JWT for ss.ge api-gateway (avoids Playwright on every prefill).
 */
import { db } from "@/lib/db";
import { decrypt, encrypt } from "@/lib/encryption";

const DEFAULT_SKEW_MS = parseInt(
  process.env.SSGE_TOKEN_CACHE_SKEW_MS || "120000",
  10
);

export function isSsgeTokenCacheEnabled(): boolean {
  return process.env.SSGE_TOKEN_CACHE !== "false";
}

/** Decode JWT exp (seconds) without verifying signature. */
export function decodeJwtExpiryMs(accessToken: string): number | null {
  const parts = accessToken.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8")
    ) as { exp?: number };
    if (typeof payload.exp !== "number" || payload.exp <= 0) return null;
    return payload.exp * 1000;
  } catch {
    return null;
  }
}

function expiryFromToken(accessToken: string): Date | null {
  const ms = decodeJwtExpiryMs(accessToken);
  return ms ? new Date(ms) : null;
}

function isTokenStillValid(expiry: Date | null | undefined, skewMs = DEFAULT_SKEW_MS): boolean {
  if (!expiry) return false;
  return expiry.getTime() - skewMs > Date.now();
}

export async function getCachedSsgeApiAccessToken(
  userId: string
): Promise<string | null> {
  if (!isSsgeTokenCacheEnabled()) return null;

  const account = await db.ssgeAccount.findUnique({
    where: { userId },
    select: { accessToken: true, tokenExpiryDate: true },
  });
  if (!account?.accessToken) return null;
  if (!isTokenStillValid(account.tokenExpiryDate)) return null;

  try {
    const accessToken = decrypt(account.accessToken);
    return accessToken || null;
  } catch {
    return null;
  }
}

export async function saveSsgeApiToken(
  userId: string,
  accessToken: string
): Promise<void> {
  const tokenExpiryDate = expiryFromToken(accessToken);
  await db.ssgeAccount.update({
    where: { userId },
    data: {
      accessToken: encrypt(accessToken),
      tokenExpiryDate,
      lastLoginAt: new Date(),
    },
  });
}

export async function invalidateSsgeApiToken(userId: string): Promise<void> {
  await db.ssgeAccount.update({
    where: { userId },
    data: { accessToken: null, tokenExpiryDate: null },
  });
}
