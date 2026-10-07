/**
 * Resolve a Bearer JWT for api-gateway.ss.ge when the public HTML guest-token
 * page is blocked (common for datacenter IPs → HTTP 403).
 *
 * Preference order for a known user: cached token → fresh login with their
 * linked ss.ge account. For anonymous/market work: SSGE_API_BEARER env, then
 * any verified account's cached token, then one verified login.
 */
import { db } from "@/lib/db";
import { decrypt } from "@/lib/encryption";
import { loginSsgeApi } from "@/lib/ssge-api-auth";
import {
  getCachedSsgeApiAccessToken,
  isSsgeTokenCacheEnabled,
} from "@/lib/ssge-api-token-cache";

export async function resolveSsgeBearerForUser(
  userId: string
): Promise<string | null> {
  const cached = await getCachedSsgeApiAccessToken(userId);
  if (cached) return cached;

  const account = await db.ssgeAccount.findUnique({
    where: { userId },
    select: {
      ssgeEmail: true,
      ssgePassword: true,
      isVerified: true,
    },
  });
  if (!account?.isVerified) return null;

  let password: string;
  try {
    password = decrypt(account.ssgePassword);
  } catch {
    return null;
  }
  if (!password) return null;

  const auth = await loginSsgeApi(
    { email: account.ssgeEmail, password },
    { userId }
  );
  return auth.session?.accessToken ?? null;
}

export async function resolveSsgeBearerAny(): Promise<string | null> {
  const fromEnv = process.env.SSGE_API_BEARER?.trim();
  if (fromEnv) return fromEnv;

  if (isSsgeTokenCacheEnabled()) {
    const withToken = await db.ssgeAccount.findMany({
      where: {
        isVerified: true,
        accessToken: { not: null },
        tokenExpiryDate: { gt: new Date(Date.now() + 60_000) },
      },
      select: { userId: true },
      take: 5,
      orderBy: { lastLoginAt: "desc" },
    });
    for (const row of withToken) {
      const token = await getCachedSsgeApiAccessToken(row.userId);
      if (token) return token;
    }
  }

  const anyVerified = await db.ssgeAccount.findFirst({
    where: { isVerified: true },
    select: { userId: true },
    orderBy: { lastLoginAt: "desc" },
  });
  if (!anyVerified) return null;
  return resolveSsgeBearerForUser(anyVerified.userId);
}
