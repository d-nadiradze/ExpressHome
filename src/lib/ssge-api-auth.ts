/**
 * ss.ge API authentication — cached JWT, optional HTTP OAuth, Playwright fallback.
 */
import type { SsgeCredentials } from "@/lib/ssge-parser";
import { obtainSsgeApiAccessToken } from "@/lib/ssge-parser";
import {
  SSGE_API_BASE,
  SSGE_CREATE_PATH,
  SSGE_HOME_ORIGIN,
} from "@/lib/ssge-api-constants";
import { isSsgeHttpAuthEnabled, loginSsgeApiHttp } from "@/lib/ssge-api-http-auth";
import {
  getCachedSsgeApiAccessToken,
  invalidateSsgeApiToken,
  saveSsgeApiToken,
} from "@/lib/ssge-api-token-cache";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export interface SsgeApiSession {
  accessToken: string;
  headers: Record<string, string>;
}

export interface LoginSsgeApiOptions {
  userId?: string;
  /** Skip cache and obtain a fresh token (e.g. after 401). */
  forceRefresh?: boolean;
}

/** How ss.ge API Bearer token was obtained (for live prefill logs). */
export type SsgeApiAuthMethod = "cached" | "http" | "playwright";

export function ssgeAuthMethodMessage(method: SsgeApiAuthMethod | undefined): string {
  switch (method) {
    case "cached":
      return "Cached API token — no browser login";
    case "http":
      return "HTTP OAuth login — no browser";
    case "playwright":
      return "Headless browser OAuth login";
    default:
      return "Signed in to ss.ge API";
  }
}

export function ssgeApiHeaders(
  session: Pick<SsgeApiSession, "accessToken">
): Record<string, string> {
  return {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "ka-GE",
    Authorization: `Bearer ${session.accessToken}`,
    Origin: SSGE_HOME_ORIGIN,
    Referer: `${SSGE_HOME_ORIGIN}${SSGE_CREATE_PATH}`,
    "User-Agent": USER_AGENT,
    "Content-Type": "application/json",
  };
}

function toSession(accessToken: string): SsgeApiSession {
  return { accessToken, headers: ssgeApiHeaders({ accessToken }) };
}

async function obtainFreshAccessToken(
  credentials: SsgeCredentials
): Promise<{
  success: boolean;
  accessToken?: string;
  error?: string;
  authMethod?: SsgeApiAuthMethod;
}> {
  if (isSsgeHttpAuthEnabled()) {
    console.log("[ss.ge API auth] HTTP OAuth login (SSGE_HTTP_AUTH=true)…");
    const http = await loginSsgeApiHttp(credentials);
    if (http.success && http.accessToken) {
      return { ...http, authMethod: "http" };
    }
    console.warn(
      "[ss.ge API auth] HTTP OAuth failed, falling back to Playwright:",
      http.error
    );
  }

  console.log("[ss.ge API auth] Headless OAuth login for Bearer token…");
  const auth = await obtainSsgeApiAccessToken(credentials);
  return auth.success && auth.accessToken
    ? { ...auth, authMethod: "playwright" as const }
    : auth;
}

export async function loginSsgeApi(
  credentials: SsgeCredentials,
  options?: LoginSsgeApiOptions
): Promise<{
  success: boolean;
  session?: SsgeApiSession;
  error?: string;
  authMethod?: SsgeApiAuthMethod;
}> {
  const userId = options?.userId;

  if (userId && !options?.forceRefresh) {
    const cached = await getCachedSsgeApiAccessToken(userId);
    if (cached) {
      console.log("[ss.ge API auth] Using cached ss.ge API token");
      return { success: true, session: toSession(cached), authMethod: "cached" };
    }
  }

  const auth = await obtainFreshAccessToken(credentials);
  if (!auth.success || !auth.accessToken) {
    return { success: false, error: auth.error || "ss.ge API login failed" };
  }

  if (userId) {
    await saveSsgeApiToken(userId, auth.accessToken).catch((err) => {
      console.warn("[ss.ge API auth] Failed to save token cache:", err);
    });
  }

  return {
    success: true,
    session: toSession(auth.accessToken),
    authMethod: auth.authMethod,
  };
}

export async function invalidateAndRefreshSsgeApiSession(
  credentials: SsgeCredentials,
  userId: string
): Promise<{
  success: boolean;
  session?: SsgeApiSession;
  error?: string;
  authMethod?: SsgeApiAuthMethod;
}> {
  await invalidateSsgeApiToken(userId).catch(() => null);
  return loginSsgeApi(credentials, { userId, forceRefresh: true });
}

export async function closeSsgeApiSession(_session?: SsgeApiSession): Promise<void> {
  /* Browser session is closed inside obtainSsgeApiAccessToken. */
}

export async function ssgeApiFetch(
  session: SsgeApiSession,
  path: string,
  init?: RequestInit
): Promise<Response> {
  const url = path.startsWith("http") ? path : `${SSGE_API_BASE}${path}`;
  return fetch(url, {
    ...init,
    headers: { ...session.headers, ...(init?.headers as Record<string, string>) },
  });
}
