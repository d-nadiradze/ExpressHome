/**
 * ss.ge API authentication via HTTP (NextAuth + Identity Server OAuth chain).
 * Behind SSGE_HTTP_AUTH=true; falls back to Playwright on failure.
 */
import type { SsgeCredentials } from "@/lib/ssge-parser";
import { SSGE_CREATE_PATH, SSGE_HOME_ORIGIN } from "@/lib/ssge-api-constants";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const SSGE_CREATE_URL = `${SSGE_HOME_ORIGIN}${SSGE_CREATE_PATH}`;
const SSGE_ACCOUNT_ORIGIN = "https://account.ss.ge";
const MAX_REDIRECTS = 12;
const FETCH_TIMEOUT_MS = parseInt(process.env.PARSE_GOTO_TIMEOUT_MS || "20000", 10);

export function isSsgeHttpAuthEnabled(): boolean {
  return process.env.SSGE_HTTP_AUTH === "true";
}

class SimpleCookieJar {
  private store = new Map<string, string>();

  ingest(response: Response, requestUrl: string): void {
    const host = new URL(requestUrl).hostname;
    const setCookies =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : [];
    if (setCookies.length === 0) {
      const single = response.headers.get("set-cookie");
      if (single) setCookies.push(single);
    }
    for (const raw of setCookies) {
      const pair = raw.split(";")[0]?.trim();
      if (!pair) continue;
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const key = `${host}:${name}`;
      if (value === "" || /^deleted$/i.test(value)) {
        this.store.delete(key);
      } else {
        this.store.set(key, value);
      }
    }
  }

  headerFor(url: string): string | undefined {
    const host = new URL(url).hostname;
    const parts: string[] = [];
    for (const [key, value] of this.store) {
      if (key.startsWith(`${host}:`)) {
        parts.push(`${key.slice(host.length + 1)}=${value}`);
      }
    }
    return parts.length > 0 ? parts.join("; ") : undefined;
  }
}

async function httpFetch(
  jar: SimpleCookieJar,
  url: string,
  init: RequestInit = {}
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const headers = new Headers(init.headers);
    if (!headers.has("User-Agent")) headers.set("User-Agent", USER_AGENT);
    const cookie = jar.headerFor(url);
    if (cookie) headers.set("Cookie", cookie);
    const res = await fetch(url, { ...init, headers, signal: controller.signal });
    jar.ingest(res, url);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function followRedirects(
  jar: SimpleCookieJar,
  startUrl: string,
  init: RequestInit = {}
): Promise<{ response: Response; finalUrl: string }> {
  let url = startUrl;
  let method = init.method || "GET";
  let body = init.body;
  let headers = init.headers;

  for (let i = 0; i < MAX_REDIRECTS; i++) {
    const res = await httpFetch(jar, url, { ...init, method, body, headers });
    if (res.status < 300 || res.status >= 400) {
      return { response: res, finalUrl: url };
    }
    const location = res.headers.get("location");
    if (!location) return { response: res, finalUrl: url };
    url = new URL(location, url).href;
    method = "GET";
    body = undefined;
    headers = undefined;
  }
  throw new Error("ss.ge HTTP auth: too many redirects");
}

function parseAntiForgeryToken(html: string): string | null {
  const match =
    html.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/i) ||
    html.match(/value="([^"]+)"[^>]*name="__RequestVerificationToken"/i);
  return match?.[1]?.trim() || null;
}

function parseCsrfToken(json: unknown): string | null {
  if (!json || typeof json !== "object") return null;
  const token = (json as { csrfToken?: string }).csrfToken;
  return typeof token === "string" && token.trim() ? token.trim() : null;
}

async function fetchSessionAccessToken(
  jar: SimpleCookieJar
): Promise<string | null> {
  const res = await httpFetch(jar, `${SSGE_HOME_ORIGIN}/api/auth/session`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as {
    accessToken?: string;
  } | null;
  const token = body?.accessToken?.trim();
  return token || null;
}

/**
 * Replicate Playwright OAuth login with fetch + cookie jar.
 */
export async function loginSsgeApiHttp(
  credentials: SsgeCredentials
): Promise<{ success: boolean; accessToken?: string; error?: string }> {
  const jar = new SimpleCookieJar();

  try {
    await httpFetch(jar, SSGE_CREATE_URL, {
      headers: { Accept: "text/html" },
    });

    const csrfRes = await httpFetch(jar, `${SSGE_HOME_ORIGIN}/api/auth/csrf`, {
      headers: { Accept: "application/json" },
    });
    if (!csrfRes.ok) {
      return {
        success: false,
        error: `CSRF fetch failed (HTTP ${csrfRes.status})`,
      };
    }
    const csrfToken = parseCsrfToken(await csrfRes.json().catch(() => null));
    if (!csrfToken) {
      return { success: false, error: "CSRF token missing" };
    }

    const signinBody = new URLSearchParams({
      csrfToken,
      callbackUrl: SSGE_CREATE_URL,
      json: "true",
    });
    const signinRes = await httpFetch(
      jar,
      `${SSGE_HOME_ORIGIN}/api/auth/signin/identity-server4`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: signinBody.toString(),
        redirect: "manual",
      }
    );

    let authorizeUrl: string | null = null;
    if (signinRes.status >= 300 && signinRes.status < 400) {
      const loc = signinRes.headers.get("location");
      if (loc) authorizeUrl = new URL(loc, SSGE_HOME_ORIGIN).href;
    } else {
      const signinJson = (await signinRes.json().catch(() => null)) as {
        url?: string;
      } | null;
      if (signinJson?.url) authorizeUrl = signinJson.url;
    }
    if (!authorizeUrl) {
      return { success: false, error: "OAuth authorize URL missing" };
    }

    const { response: loginPageRes, finalUrl: loginPageUrl } =
      await followRedirects(jar, authorizeUrl);
    if (!loginPageRes.ok) {
      return {
        success: false,
        error: `Login page failed (HTTP ${loginPageRes.status})`,
      };
    }

    let loginHtml = await loginPageRes.text();
    let token = parseAntiForgeryToken(loginHtml);
    if (!token && loginPageUrl.includes("account.ss.ge")) {
      const retry = await httpFetch(jar, loginPageUrl, {
        headers: { Accept: "text/html" },
      });
      loginHtml = await retry.text();
      token = parseAntiForgeryToken(loginHtml);
    }
    if (!token) {
      return { success: false, error: "Login anti-forgery token missing" };
    }

    const loginAction = loginPageUrl.includes("/Login")
      ? loginPageUrl
      : `${SSGE_ACCOUNT_ORIGIN}/ka/account/Login`;

    const loginBody = new URLSearchParams({
      __RequestVerificationToken: token,
      userName: credentials.email,
      password: credentials.password,
      RememberMe: "false",
    });

    const { finalUrl: afterLoginUrl } = await followRedirects(jar, loginAction, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "text/html",
        Origin: SSGE_ACCOUNT_ORIGIN,
        Referer: loginPageUrl,
      },
      body: loginBody.toString(),
      redirect: "manual",
    });

    if (
      afterLoginUrl.includes("/login") ||
      afterLoginUrl.includes("/Login") ||
      afterLoginUrl.includes("/account/login")
    ) {
      return { success: false, error: "HTTP login rejected (still on login page)" };
    }

    const accessToken = await fetchSessionAccessToken(jar);
    if (!accessToken) {
      return { success: false, error: "accessToken missing from NextAuth session" };
    }
    return { success: true, accessToken };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error ? error.message : "ss.ge HTTP OAuth login failed",
    };
  }
}
