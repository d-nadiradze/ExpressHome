/**
 * ss.ge API authentication — Playwright OAuth login + Bearer token export.
 */
import type { SsgeCredentials } from "@/lib/ssge-parser";
import { obtainSsgeApiAccessToken } from "@/lib/ssge-parser";
import {
  SSGE_API_BASE,
  SSGE_CREATE_PATH,
  SSGE_HOME_ORIGIN,
} from "@/lib/ssge-api-constants";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export interface SsgeApiSession {
  accessToken: string;
  headers: Record<string, string>;
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

export async function loginSsgeApi(
  credentials: SsgeCredentials
): Promise<{ success: boolean; session?: SsgeApiSession; error?: string }> {
  const auth = await obtainSsgeApiAccessToken(credentials);
  if (!auth.success || !auth.accessToken) {
    return { success: false, error: auth.error || "ss.ge API login failed" };
  }
  const accessToken = auth.accessToken;
  return {
    success: true,
    session: { accessToken, headers: ssgeApiHeaders({ accessToken }) },
  };
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
