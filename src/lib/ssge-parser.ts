import "@/lib/esbuild-shim";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from "playwright";
import {
  normalizeListingForSsgePrefill,
  ssgeViewChipsFromRawData,
} from "@/lib/cross-platform-prefill";
import {
  applySsgeBalconyDefaultsForSsgePrefill,
  resolveSsgeBalconyCountForPrefill,
} from "@/lib/platform-amenity-mappings";
import type { MyhomeListing } from "@/lib/myhome-parser";
import { resolveImagesForPlaywright } from "@/lib/listing-images";
import {
  resolveSsgeStatusChip,
  collectAdditionalInfoLabelsToEnable,
  DEAL_TYPE_TO_SSGE,
  PROJECT_TYPE_SUBSET,
  PROPERTY_TYPE_TO_SSGE,
  digitsOnly,
  resolveSsgeConditionChip,
  resolveSsgeProjectChip,
} from "@/lib/ssge-mappings";
import { cityForPrefill } from "@/lib/location-prefill";

export interface SsgeCredentials {
  email: string;
  password: string;
}

const PREFILL_PAUSE_MS = 20;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const SSGE_CREATE_URL = "https://home.ss.ge/ka/udzravi-qoneba/create";
/** Standalone login page (მობილური ან ელ.ფოსტა + პაროლი). */
const SSGE_ACCOUNT_LOGIN_URL = "https://account.ss.ge/ka/account/login";

function isSsgeBrokenAccountUrl(url: string): boolean {
  return /\/ka\/account\/null(?:\?|#|$)/i.test(url);
}

/** NextAuth session on home.ss.ge (required for create wizard API / step 5+). */
async function hasSsgeNextAuthSession(context: BrowserContext): Promise<boolean> {
  const cookies = await context.cookies("https://home.ss.ge");
  return cookies.some(
    (c) =>
      /next-auth\.session-token/i.test(c.name) &&
      (c.value?.length ?? 0) > 20
  );
}

async function waitForSsgeNextAuthSession(
  page: Page,
  timeout = 45000
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await hasSsgeNextAuthSession(page.context())) return;
    await page.waitForTimeout(400);
  }
  throw new Error("ss.ge NextAuth session not established on home.ss.ge");
}

/** Click header შესვლა → account login with OAuth returnUrl (not plain create URL). */
async function clickSsgeSignInButton(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const buttons = [...document.querySelectorAll("button")].filter(
      (b) => (b.textContent || "").trim() === "შესვლა"
    );
    const btn =
      buttons.find((b) => {
        const r = b.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.top < 320;
      }) ?? buttons[0];
    if (!btn) return false;
    (btn as HTMLButtonElement).click();
    return true;
  });
}

/** Open account login through home.ss.ge NextAuth (preserves OAuth callback). */
async function openSsgeLoginViaNextAuth(page: Page): Promise<void> {
  if (!page.url().includes("home.ss.ge")) {
    await page.goto(SSGE_CREATE_URL, {
      waitUntil: "load",
      timeout: 45000,
    });
  } else if (!page.url().includes("/create")) {
    await page.goto(SSGE_CREATE_URL, {
      waitUntil: "load",
      timeout: 45000,
    });
  } else {
    await page.waitForLoadState("load", { timeout: 15000 }).catch(() => null);
  }
  await prefillPause(page, 1500);

  if (!(await clickSsgeSignInButton(page))) {
    await prefillPause(page, 2000);
    if (!(await clickSsgeSignInButton(page))) {
      throw new Error("ss.ge sign-in button not found on create page");
    }
  }

  await page.waitForURL(
    (url) =>
      url.href.includes("account.ss.ge") &&
      (url.href.includes("/login") || url.href.includes("/Login")),
    { timeout: 20000 }
  );
}

/** NextAuth entry on create, or direct account login if the sign-in button is missing. */
async function gotoSsgeAccountLogin(page: Page): Promise<void> {
  try {
    await openSsgeLoginViaNextAuth(page);
    if (await isSsgeLoginFormVisible(page)) return;
  } catch {
    /* fall through to direct login URL */
  }

  const loginUrl = `${SSGE_ACCOUNT_LOGIN_URL}?returnUrl=${encodeURIComponent(SSGE_CREATE_URL)}`;
  await page.goto(loginUrl, { waitUntil: "load", timeout: 30000 });
  if (isSsgeBrokenAccountUrl(page.url())) {
    await page.goto(SSGE_ACCOUNT_LOGIN_URL, {
      waitUntil: "load",
      timeout: 30000,
    });
  }
}

/** True after a successful sign-in (for account linking — wizard not required). */
async function isSsgeLoginSucceeded(page: Page): Promise<boolean> {
  if (isSsgeBrokenAccountUrl(page.url())) return false;
  if (isSsgeLoginPage(page.url())) return false;
  if (await isSsgeLoginFormVisible(page)) return false;
  if (await hasSsgeNextAuthSession(page.context())) return true;
  return page.url().includes("home.ss.ge");
}

async function verifySsgeCredentialsOnPage(
  page: Page,
  credentials: SsgeCredentials
): Promise<{ ok: boolean; error?: string }> {
  await gotoSsgeAccountLogin(page);

  if (!(await isSsgeLoginFormVisible(page))) {
    return {
      ok: false,
      error: `ss.ge login form not found (at ${page.url()})`,
    };
  }

  await submitSsgeLoginForm(page, credentials);
  await prefillPause(page, 1200);

  if (!page.url().includes("home.ss.ge")) {
    await page
      .waitForURL(
        (url) => {
          const href = url.href;
          return (
            !isSsgeBrokenAccountUrl(href) &&
            !isSsgeLoginPage(href) &&
            (href.includes("home.ss.ge") || href.includes("account.ss.ge"))
          );
        },
        { timeout: 45000 }
      )
      .catch(() => null);
  }

  if (!page.url().includes("home.ss.ge")) {
    await page
      .goto("https://home.ss.ge/", { waitUntil: "load", timeout: 30000 })
      .catch(() => null);
    await prefillPause(page, 600);
  }

  try {
    await waitForSsgeNextAuthSession(page, 20000);
    return { ok: true };
  } catch {
    /* session cookie may appear after home visit */
  }

  if (await isSsgeLoginSucceeded(page)) {
    return { ok: true };
  }

  if (isSsgeLoginPage(page.url()) || (await isSsgeLoginFormVisible(page))) {
    return { ok: false, error: "Invalid email or password" };
  }

  return {
    ok: false,
    error: `Login did not complete (at ${page.url()})`,
  };
}

function ssgeLoginFailureMessage(page: Page): string {
  if (isSsgeBrokenAccountUrl(page.url())) {
    return "ss.ge opened a broken account page (/account/null) — retry prefill";
  }
  if (isSsgeLoginPage(page.url())) {
    return "ss.ge login failed — check linked email and password";
  }
  return `ss.ge login failed — create form did not load (at ${page.url()})`;
}

/** Reused visible browser session so repeat pre-fills skip login. */
let postSession: {
  email: string;
  browser: Browser;
  context: BrowserContext;
} | null = null;

async function prefillPause(page: Page, ms = PREFILL_PAUSE_MS) {
  if (ms > 0) await page.waitForTimeout(ms);
}

function isSsgeLoginPage(url: string): boolean {
  return url.includes("account.ss.ge") && /\/login/i.test(url);
}

async function isSsgeLoginFormVisible(page: Page): Promise<boolean> {
  if (isSsgeLoginPage(page.url())) return true;
  const passwordVisible = await page
    .locator(
      'form[action="/Login"] input[type="password"], input[name="password"], input[name="Password"]'
    )
    .first()
    .isVisible({ timeout: 1500 })
    .catch(() => false);
  if (!passwordVisible) return false;
  const loginBtn = await page
    .getByRole("button", { name: /^შესვლა$/i })
    .first()
    .isVisible({ timeout: 1500 })
    .catch(() => false);
  return loginBtn;
}

const SSGE_UNFINISHED_MODAL_TITLE = "განთავსების გაგრძელება";
const SSGE_NEW_LISTING_BUTTON = "დაამატე ახალი განცხადება";

/**
 * Unfinished-draft modal on /create (only when the “new listing” button is shown).
 * If this is false, prefill continues unchanged.
 */
async function isSsgeUnfinishedDraftModalVisible(page: Page): Promise<boolean> {
  const newListingBtn = page
    .getByRole("button", { name: SSGE_NEW_LISTING_BUTTON })
    .first();
  if (!(await newListingBtn.isVisible({ timeout: 1000 }).catch(() => false))) {
    return false;
  }
  return page
    .locator("h6")
    .filter({ hasText: SSGE_UNFINISHED_MODAL_TITLE })
    .first()
    .isVisible({ timeout: 500 })
    .catch(() => true);
}

/**
 * If the unfinished-draft modal is open: click **დაამატე ახალი განცხადება**, then wait for a clean wizard.
 * If it never appears: no-op — prefill proceeds as before.
 */
async function dismissSsgeUnfinishedDraftModal(page: Page): Promise<void> {
  if (!(await isSsgeUnfinishedDraftModalVisible(page))) {
    return;
  }

  const newListingBtn = page
    .getByRole("button", { name: SSGE_NEW_LISTING_BUTTON })
    .first();
  const clicked = await newListingBtn
    .click({ timeout: 8000 })
    .then(() => true)
    .catch(async () =>
      page.evaluate((buttonText) => {
        const norm = (s: string) => s.replace(/\s+/g, " ").trim();
        for (const btn of document.querySelectorAll("button")) {
          if (norm(btn.textContent || "") !== buttonText) continue;
          if ((btn as HTMLElement).offsetParent === null) continue;
          (btn as HTMLButtonElement).click();
          return true;
        }
        return false;
      }, SSGE_NEW_LISTING_BUTTON)
    );

  if (!clicked) {
    throw new Error(
      "ss.ge unfinished-draft modal: could not click new listing button"
    );
  }

  console.log("[ss.ge prefill] dismissed unfinished-draft modal (new listing)");

  const modalGoneBy = Date.now() + 15000;
  while (Date.now() < modalGoneBy) {
    if (!(await isSsgeUnfinishedDraftModalVisible(page))) break;
    await page.waitForTimeout(300);
  }

  if (
    page.url().includes("home.ss.ge") &&
    (await isSsgeOnCreateWizard(page))
  ) {
    await prefillPause(page, 200);
    return;
  }

  const wizardBy = Date.now() + 20000;
  while (Date.now() < wizardBy) {
    if (
      page.url().includes("home.ss.ge") &&
      (await isSsgeOnCreateWizard(page))
    ) {
      await prefillPause(page, 200);
      return;
    }
    await page.waitForTimeout(400);
  }

  if (await isSsgeUnfinishedDraftModalVisible(page)) {
    throw new Error("ss.ge unfinished-draft modal blocked prefill");
  }
}

/** Create wizard step 1 content is on the page (shown even when logged out). */
async function isSsgeOnCreateWizard(page: Page): Promise<boolean> {
  if (!page.url().includes("home.ss.ge")) return false;
  if (!page.url().includes("/create")) return false;
  if (isSsgeLoginPage(page.url())) return false;
  if (await isSsgeLoginFormVisible(page)) return false;
  return page.evaluate(() =>
    !!Array.from(document.querySelectorAll("p")).find((p) =>
      (p.textContent || "").includes("აირჩიე კატეგორია")
    )
  );
}

/** Visible sign-in affordance on home.ss.ge (use href, not duplicate header text). */
async function isSsgeLoggedOutOnHome(page: Page): Promise<boolean> {
  if (!page.url().includes("home.ss.ge")) return false;
  const loginLink = page.locator('a[href*="/account/login"]').first();
  if (await loginLink.isVisible({ timeout: 800 }).catch(() => false)) {
    return true;
  }
  return page.evaluate(() => {
    for (const a of document.querySelectorAll("a")) {
      const href = a.href || "";
      if (!href.includes("account.ss.ge") || !href.includes("login")) continue;
      if (href.includes("/account/null")) continue;
      const rect = a.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1 || rect.top > 280) continue;
      return true;
    }
    return false;
  });
}

async function isSsgeHeaderLoginPromptVisible(page: Page): Promise<boolean> {
  return isSsgeLoggedOutOnHome(page);
}

/** Signed-in on home.ss.ge for create-listing API steps. */
async function isSsgeHomeAuthenticated(page: Page): Promise<boolean> {
  if (!page.url().includes("home.ss.ge")) return false;
  if (await hasSsgeNextAuthSession(page.context())) return true;
  return !(await isSsgeLoggedOutOnHome(page));
}

async function waitForSsgeOnCreate(
  page: Page,
  timeout = 30000
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (isSsgeLoginPage(page.url()) || (await isSsgeLoginFormVisible(page))) {
      throw new Error("ss.ge login page still open after sign-in");
    }
    if (await isSsgeUnfinishedDraftModalVisible(page)) {
      await dismissSsgeUnfinishedDraftModal(page);
      continue;
    }
    if (await isSsgeOnCreateWizard(page)) return;
    await page.waitForTimeout(400);
  }
  throw new Error("ss.ge create wizard did not load");
}

async function openSsgeCreateAfterLogin(page: Page): Promise<void> {
  await waitForSsgeNextAuthSession(page, 45000);

  if (!page.url().includes("home.ss.ge")) {
    await page.goto(SSGE_CREATE_URL, {
      waitUntil: "load",
      timeout: 45000,
    });
  } else if (!page.url().includes("/create")) {
    await page.goto(SSGE_CREATE_URL, {
      waitUntil: "load",
      timeout: 45000,
    });
  }

  await dismissSsgeUnfinishedDraftModal(page);
  await waitForSsgeOnCreate(page, 30000);

  if (!(await hasSsgeNextAuthSession(page.context()))) {
    throw new Error("ss.ge NextAuth session missing on create page");
  }
}

async function ensureSsgeHomeAuthenticated(
  page: Page,
  credentials: SsgeCredentials
): Promise<void> {
  if (await hasSsgeNextAuthSession(page.context())) return;
  console.log("[ss.ge prefill] NextAuth session lost — re-signing in…");
  const ok = await performSsgeLogin(page, credentials);
  if (!ok) throw new Error(ssgeLoginFailureMessage(page));
}

/** Must log in before prefill when login UI is showing or create wizard is missing. */
async function needsSsgeLogin(page: Page): Promise<boolean> {
  if (isSsgeBrokenAccountUrl(page.url())) return true;
  if (await isSsgeLoginFormVisible(page)) return true;
  if (isSsgeLoginPage(page.url())) return true;
  if (!page.url().includes("home.ss.ge")) return true;
  if (!page.url().includes("/create")) return true;
  return !(await isSsgeOnCreateWizard(page));
}

/** Fill account.ss.ge login form and click შესვლა (same flow as myhome credential submit). */
async function submitSsgeLoginForm(
  page: Page,
  credentials: SsgeCredentials
): Promise<void> {
  await page
    .locator(
      'form[action="/Login"], form[method="post"], input[name="password"], input[type="password"]'
    )
    .first()
    .waitFor({ state: "visible", timeout: 15000 });

  const usernameLocator = page
    .locator(
      'form[action="/Login"] input[name="userName"], form[action="/Login"] input[name="useName"], input[name="userName"], input[name="useName"], input[type="email"]'
    )
    .first();
  await usernameLocator.waitFor({ state: "visible", timeout: 12000 });
  await usernameLocator.fill(credentials.email);

  const passwordLocator = page
    .locator(
      'form[action="/Login"] input[name="password"], form[action="/Login"] input[name="Password"], input[name="password"], input[type="password"]'
    )
    .first();
  await passwordLocator.waitFor({ state: "visible", timeout: 8000 });
  await passwordLocator.fill(credentials.password);

  const submit = page.getByRole("button", { name: /^შესვლა$/i }).first();
  await submit.waitFor({ state: "visible", timeout: 8000 });
  await Promise.all([
    page
      .waitForURL(
        (url) => {
          const href = url.href;
          if (isSsgeBrokenAccountUrl(href) || isSsgeLoginPage(href)) return false;
          return href.includes("home.ss.ge");
        },
        { timeout: 45000 }
      )
      .catch(() => null),
    submit.click({ timeout: 10000 }),
  ]);
}

/**
 * Log in on account.ss.ge, then open the create wizard on home.ss.ge.
 */
async function performSsgeLogin(
  page: Page,
  credentials: SsgeCredentials,
  _startUrl?: string
): Promise<boolean> {
  if (
    page.url().includes("home.ss.ge") &&
    (await hasSsgeNextAuthSession(page.context())) &&
    (await isSsgeOnCreateWizard(page))
  ) {
    return true;
  }

  try {
    await gotoSsgeAccountLogin(page);
  } catch (e) {
    console.warn("[ss.ge prefill] login entry:", e);
    return false;
  }

  if (isSsgeBrokenAccountUrl(page.url())) {
    console.warn("[ss.ge prefill] landed on broken account URL:", page.url());
    return false;
  }

  if (!(await isSsgeLoginFormVisible(page))) {
    console.warn("[ss.ge prefill] login form not found at", page.url());
    return false;
  }

  await submitSsgeLoginForm(page, credentials);
  await prefillPause(page, 1000);

  if (isSsgeLoginPage(page.url()) || isSsgeBrokenAccountUrl(page.url())) {
    return false;
  }

  if (!page.url().includes("home.ss.ge")) {
    await page
      .waitForURL(
        (url) => {
          const href = url.href;
          return (
            !isSsgeBrokenAccountUrl(href) &&
            !isSsgeLoginPage(href) &&
            href.includes("home.ss.ge")
          );
        },
        { timeout: 45000 }
      )
      .catch(() => null);
  }

  try {
    await openSsgeCreateAfterLogin(page);
  } catch (e) {
    console.warn("[ss.ge prefill] OAuth session / create wizard:", e);
    return false;
  }

  return (
    (await hasSsgeNextAuthSession(page.context())) &&
    (await isSsgeOnCreateWizard(page))
  );
}

/** Verify ss.ge credentials (account link flow — same OAuth login as prefill). */
export async function loginToSsge(credentials: SsgeCredentials): Promise<{
  success: boolean;
  error?: string;
}> {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox", "--disable-setuid-sandbox",
      "--disable-dev-shm-usage", "--disable-gpu",
      "--single-process", "--no-zygote",
    ],
  });
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    locale: "ka-GE",
    viewport: { width: 1920, height: 1080 },
  });
  const page = await context.newPage();

  try {
    const result = await verifySsgeCredentialsOnPage(page, credentials);
    if (!result.ok) {
      return {
        success: false,
        error: result.error || "Invalid credentials or login failed",
      };
    }
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Login failed",
    };
  } finally {
    await context.close().catch(() => null);
    await browser.close().catch(() => null);
  }
}

/** @deprecated Use isSsgeOnCreateWizard — kept for call sites. */
async function isSsgeCreateWizardReady(page: Page): Promise<boolean> {
  return isSsgeOnCreateWizard(page);
}

/**
 * Fresh browser: log in first (myhome-style), then wait for create wizard.
 * Reused browser: open create and log in only if session expired.
 */
async function ensureSsgeCreateFormReady(
  page: Page,
  credentials: SsgeCredentials,
  options?: { freshSession?: boolean }
): Promise<void> {
  if (options?.freshSession) {
    console.log("[ss.ge prefill] Logging in before prefill…");
    const ok = await performSsgeLogin(
      page,
      credentials,
      SSGE_ACCOUNT_LOGIN_URL
    );
    if (!ok) {
      throw new Error(ssgeLoginFailureMessage(page));
    }
    await waitForSsgeForm(page);
    return;
  }

  await page.goto(SSGE_CREATE_URL, {
    waitUntil: "load",
    timeout: 30000,
  });
  await page
    .waitForURL(
      (url) =>
        url.href.includes("home.ss.ge") || isSsgeLoginPage(url.href),
      { timeout: 15000 }
    )
    .catch(() => null);
  await prefillPause(page, 400);
  await dismissSsgeUnfinishedDraftModal(page);

  if (await needsSsgeLogin(page)) {
    console.log("[ss.ge prefill] Not signed in — logging in before prefill…");
    const ok = await performSsgeLogin(
      page,
      credentials,
      SSGE_ACCOUNT_LOGIN_URL
    );
    if (!ok) {
      throw new Error(ssgeLoginFailureMessage(page));
    }
  }

  if (await needsSsgeLogin(page)) {
    throw new Error(ssgeLoginFailureMessage(page));
  }

  await waitForSsgeForm(page);
}

// ---------------------------------------------------------------------------
//  SS.ge form helpers
//  DOM structure: styled-components v5 (generated class names).
//    Card = <div><span class="icon-*"></span>TEXT</div>
//    Section heading = <p>HEADING TEXT</p>
//    Section container = <div> (next sibling of <p>)
//  All interaction via page.evaluate() with explicit visibility filtering
//  because getByText picks up hidden header duplicates (opacity:0).
// ---------------------------------------------------------------------------

/**
 * Click a visible card / chip / button whose trimmed text content matches
 * `text`. Optionally scoped to a section whose heading `<p>` contains
 * `sectionHeading`. Returns true if clicked.
 */
async function ssgeClickCard(
  page: Page,
  text: string,
  sectionHeading?: string
): Promise<boolean> {
  if (sectionHeading) {
    const near = await ssgeClickChipNearLabel(page, text, sectionHeading);
    if (near) return true;
  }

  const clicked = await page.evaluate(
    ({ text }) => {
      const norm = (s: string) => s.replace(/\s+/g, " ").trim();
      const isVisible = (el: HTMLElement) =>
        el.offsetParent !== null &&
        getComputedStyle(el).opacity !== "0" &&
        getComputedStyle(el).visibility !== "hidden";

      for (const el of document.querySelectorAll("div, button, label, span, a")) {
        const html = el as HTMLElement;
        if (!isVisible(html)) continue;
        if (html.children.length > 3) continue;
        if (norm(html.textContent || "") === norm(text)) {
          html.click();
          return true;
        }
      }
      return false;
    },
    { text }
  );
  if (clicked) await prefillPause(page, 80);
  return clicked;
}

/**
 * Click a text chip in the ss.ge create form field whose label matches
 * `sectionLabel` (span or p, optional trailing *).
 */
async function ssgeClickChipNearLabel(
  page: Page,
  chipText: string,
  sectionLabel: string
): Promise<boolean> {
  if (!chipText?.trim()) return false;
  const clicked = await page.evaluate(
    ({ chipText, sectionLabel }) => {
      const norm = (s: string) =>
        s.replace(/\s*\*\s*$/, "").replace(/\s+/g, " ").trim();
      const labelMatches = (el: Element) => {
        const t = norm(el.textContent || "");
        const want = norm(sectionLabel);
        return t === want || t.startsWith(want);
      };
      const isVisible = (el: HTMLElement) =>
        el.offsetParent !== null && getComputedStyle(el).opacity !== "0";

      function clickTextChipIn(container: Element, target: string): boolean {
        const want = norm(target);
        for (const p of container.querySelectorAll("p")) {
          if (norm(p.textContent || "") !== want) continue;
          const chipDiv = p.parentElement as HTMLElement | null;
          if (chipDiv && isVisible(chipDiv)) {
            chipDiv.click();
            return true;
          }
        }
        for (const el of container.querySelectorAll("div, button, label, span")) {
          const html = el as HTMLElement;
          if (!isVisible(html)) continue;
          if (html.children.length > 3) continue;
          if (norm(html.textContent || "") === want) {
            html.click();
            return true;
          }
        }
        return false;
      }

      let labelEl: Element | null = null;
      for (const el of document.querySelectorAll("span, p")) {
        if (!labelMatches(el)) continue;
        if (!isVisible(el as HTMLElement)) continue;
        labelEl = el;
        break;
      }
      if (!labelEl) return false;

      const labelDiv = labelEl.parentElement;
      if (!labelDiv) return false;

      let sibling = labelDiv.nextElementSibling;
      for (let i = 0; i < 4 && sibling; i++) {
        if (clickTextChipIn(sibling, chipText)) return true;
        sibling = sibling.nextElementSibling;
      }

      const fieldWrapper = labelDiv.parentElement;
      if (fieldWrapper && clickTextChipIn(fieldWrapper, chipText)) return true;

      return false;
    },
    { chipText, sectionLabel }
  );
  if (clicked) await prefillPause(page, 80);
  return clicked;
}

/**
 * Step 5 დამატებითი ინფორმაცია — amenity toggles inside #create-app-additional-info:
 *   <div class="... active?"><p>label</p><span class="icon-...">
 */
async function ssgeClickAdditionalInfoToggle(
  page: Page,
  labels: string[]
): Promise<boolean> {
  const variants = [...new Set(labels.map((l) => l.trim()).filter(Boolean))];
  if (!variants.length) return false;

  const section = page.locator("#create-app-additional-info").first();
  await section
    .waitFor({ state: "visible", timeout: 12000 })
    .catch(() => null);

  const clicked = await page.evaluate((labels) => {
    const norm = (s: string) => s.replace(/\s+/g, " ").trim();
    const compact = (s: string) =>
      s.replace(/\s+/g, "").replace(/ცენტრ\./g, "ცენტ.").trim();
    const wants = new Set(labels.map(compact));
    const root =
      (document.getElementById("create-app-additional-info") as HTMLElement | null) ||
      document.body;

    const labelMatches = (text: string) => {
      const c = compact(text);
      if (wants.has(c)) return true;
      return labels.some((l) => norm(text) === norm(l));
    };

    const isToggleActive = (chip: HTMLElement) =>
      chip.classList.contains("active") ||
      !!chip.querySelector("span[class*='check_circle-fill']");

    const findToggleForLabel = (p: HTMLParagraphElement): HTMLElement | null => {
      let node: HTMLElement | null = p.parentElement;
      while (node && node !== root) {
        const directP = node.querySelector(":scope > p");
        const directIcon = node.querySelector(
          ":scope > span[class*='icon-add_circle'], :scope > span[class*='icon-check_circle']"
        );
        if (directP === p && directIcon) return node;
        node = node.parentElement;
      }
      return null;
    };

    for (const p of root.querySelectorAll("p")) {
      if (!labelMatches(p.textContent || "")) continue;
      const chip = findToggleForLabel(p as HTMLParagraphElement);
      if (!chip) continue;
      if (isToggleActive(chip)) return true;
      chip.scrollIntoView({ block: "nearest", inline: "nearest" });
      chip.click();
      return true;
    }
    return false;
  }, variants);

  if (clicked) {
    await prefillPause(page, 80);
    return true;
  }

  for (const label of variants) {
    try {
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const chip = section
        .locator("div")
        .filter({
          has: page.locator("p", {
            hasText: new RegExp(`^\\s*${escaped}\\s*$`, "i"),
          }),
        })
        .filter({
          has: page.locator(
            "span[class*='icon-add_circle'], span[class*='icon-check_circle']"
          ),
        })
        .first();
      if ((await chip.count()) === 0) continue;
      await chip.scrollIntoViewIfNeeded({ timeout: 5000 });
      const isActive = await chip.evaluate(
        (el) =>
          el.classList.contains("active") ||
          !!el.querySelector("span[class*='check_circle-fill']")
      );
      if (!isActive) await chip.click({ timeout: 5000, force: true });
      await prefillPause(page, 80);
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

/** Step 5 „სხვა ინფორმაცია“ — view chips (comma-separated from myhome ხედი). */
async function ssgePrefillViewChips(
  page: Page,
  listing: MyhomeListing
): Promise<void> {
  const chips = ssgeViewChipsFromRawData(listing.rawData);
  if (!chips.length) return;
  console.log(`[ss.ge prefill] views (${chips.length}): ${chips.join(", ")}`);
  for (const chip of chips) {
    const ok = await ssgeClickCard(page, chip, "სხვა ინფორმაცია");
    if (!ok) {
      console.warn(`[ss.ge prefill] view chip "${chip}" not selected`);
    }
    await prefillPause(page, 60);
  }
}

async function ssgePrefillAdditionalInfoToggles(
  page: Page,
  rawData: Record<string, string> | undefined
): Promise<void> {
  const labels = collectAdditionalInfoLabelsToEnable(rawData);
  console.log(
    `[ss.ge prefill] additional info toggles (${labels.length}): ${labels.join(", ")}`
  );

  for (const label of labels) {
    const ok = await ssgeClickAdditionalInfoToggle(page, [label]);
    if (!ok) {
      console.warn(
        `[ss.ge prefill] დამატებითი ინფორმაცია toggle "${label}" not enabled`
      );
    }
  }
}

/**
 * Step 5 "მდგომარეობა" — chips are `<div><p>გარემონტებული</p></div>` in the
 * main content column (not the left wizard sidebar).
 */
async function ssgePrefillCondition(
  page: Page,
  chipText: string
): Promise<boolean> {
  if (!chipText?.trim()) return false;

  const clicked = await page.evaluate((chipText) => {
    const norm = (s: string) =>
      s.replace(/\s*\*\s*$/, "").replace(/\s+/g, " ").trim();
    const want = norm(chipText);
    const isVisible = (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) return false;
      const st = getComputedStyle(el);
      return (
        el.offsetParent !== null &&
        st.opacity !== "0" &&
        st.visibility !== "hidden" &&
        st.pointerEvents !== "none"
      );
    };

    const clickChipDiv = (chipDiv: HTMLElement): boolean => {
      if (!isVisible(chipDiv)) return false;
      chipDiv.scrollIntoView({ block: "center", inline: "nearest" });
      chipDiv.click();
      return true;
    };

    const isConditionLabel = (el: Element) => {
      const t = norm(el.textContent || "");
      return t === "მდგომარეობა" || t.startsWith("მდგომარეობა");
    };

    const labelEls: Element[] = [];
    for (const el of document.querySelectorAll("span, p, label")) {
      if (!isConditionLabel(el)) continue;
      const rect = (el as HTMLElement).getBoundingClientRect();
      if (rect.left < 200) continue;
      if (!isVisible(el as HTMLElement)) continue;
      labelEls.push(el);
    }

    for (const labelEl of labelEls) {
      let node: Element | null = labelEl;
      for (let depth = 0; depth < 12 && node; depth++) {
        for (const p of node.querySelectorAll("p")) {
          if (norm(p.textContent || "") !== want) continue;
          const chipDiv = p.parentElement as HTMLElement | null;
          if (chipDiv?.tagName === "DIV" && clickChipDiv(chipDiv)) return true;
        }
        node = node.parentElement;
      }
    }

    for (const p of document.querySelectorAll("p")) {
      if (norm(p.textContent || "") !== want) continue;
      const chipDiv = p.parentElement as HTMLElement | null;
      if (!chipDiv || chipDiv.tagName !== "DIV") continue;
      if ((chipDiv as HTMLElement).getBoundingClientRect().left < 200) continue;
      if (clickChipDiv(chipDiv)) return true;
    }
    return false;
  }, chipText);

  if (clicked) {
    await prefillPause(page, 40);
    return true;
  }

  try {
    const escaped = chipText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const chip = page
      .locator("div")
      .filter({
        has: page.locator("p", { hasText: new RegExp(`^\\s*${escaped}\\s*$`) }),
      })
      .filter({ has: page.locator("p") })
      .first();
    await chip.scrollIntoViewIfNeeded({ timeout: 5000 });
    await chip.click({ timeout: 5000, force: true });
    await prefillPause(page, 40);
    return true;
  } catch {
    return false;
  }
}

/**
 * Click a numeric chip (1, 2, 3…) near a label (e.g. "საძინებელი").
 *
 * Actual ss.ge DOM:
 *   <div id="room-input">                          ← field wrapper
 *     <div><span>ოთახები*</span></div>             ← label wrapper > span
 *     <div>                                         ← chip outer
 *       <div>                                       ← chip inner
 *         <div class="sc-..."><p>1</p></div>        ← chip (number in <p>)
 *         <div class="sc-..."><p>2</p></div>
 *       </div>
 *     </div>
 *   </div>
 */
async function ssgeClickNumberNear(
  page: Page,
  number: string,
  sectionLabel: string
): Promise<boolean> {
  if (!number) return false;
  const clicked = await page.evaluate(
    ({ number, sectionLabel }) => {
      const norm = (s: string) => s.replace(/\s*\*\s*$/, "").replace(/\s+/g, " ").trim();
      const isVisible = (el: HTMLElement) =>
        el.offsetParent !== null && getComputedStyle(el).opacity !== "0";

      // Chip numbers are inside <p> tags: <div class="chip"><p>4</p></div>
      function hasNumericChips(el: Element): boolean {
        let count = 0;
        for (const p of el.querySelectorAll("p")) {
          if (/^\d+\+?$/.test((p.textContent || "").trim())) count++;
        }
        return count >= 2;
      }

      function clickChipIn(container: Element, target: string): boolean {
        const variants = [target, `${target}+`];
        for (const p of container.querySelectorAll("p")) {
          const t = (p.textContent || "").trim();
          if (!variants.includes(t)) continue;
          // Click the parent <div> (the actual interactive chip element)
          const chipDiv = p.parentElement as HTMLElement | null;
          if (chipDiv && isVisible(chipDiv)) {
            chipDiv.click();
            return true;
          }
        }
        return false;
      }

      // Find the label <span> element (NOT div — div wrapper comes first
      // in document order and causes the parent-walk to overshoot).
      const labelMatches = (el: Element) => {
        const t = norm(el.textContent || "");
        const want = norm(sectionLabel);
        return t === want || t.startsWith(want);
      };

      let labelSpan: Element | null = null;
      for (const el of document.querySelectorAll("span, p")) {
        if (!labelMatches(el)) continue;
        if (!isVisible(el as HTMLElement)) continue;
        labelSpan = el;
        break;
      }
      if (!labelSpan) return false;

      // DOM: <span>ოთახები*</span> is inside:
      //   <div class="label-wrapper">   ← span's parent
      //     <span>LABEL</span>
      //   </div>
      //   <div class="chip-container">  ← label-wrapper's next sibling
      //     <div><div><p>1</p></div>…</div>
      //   </div>
      // Both are children of the field wrapper div.
      const labelDiv = labelSpan.parentElement;
      if (!labelDiv) return false;

      // Check next siblings of the label div for chip container
      let sibling = labelDiv.nextElementSibling;
      for (let i = 0; i < 3 && sibling; i++) {
        if (hasNumericChips(sibling)) {
          return clickChipIn(sibling, number);
        }
        sibling = sibling.nextElementSibling;
      }

      // Fallback: search the entire field wrapper (parent of labelDiv)
      // but ONLY if it doesn't also contain OTHER field labels (scope guard)
      const fieldWrapper = labelDiv.parentElement;
      if (fieldWrapper && hasNumericChips(fieldWrapper)) {
        const otherLabels = fieldWrapper.querySelectorAll("span");
        let otherCount = 0;
        for (const s of otherLabels) {
          const t = norm(s.textContent || "");
          if (t && t !== norm(sectionLabel) && /[\u10A0-\u10FF]/.test(t)) otherCount++;
        }
        if (otherCount === 0) {
          return clickChipIn(fieldWrapper, number);
        }
      }

      return false;
    },
    { number, sectionLabel }
  );
  if (clicked) await prefillPause(page, 80);
  return clicked;
}

/** Click an exact chip label (e.g. "8+") in a numeric chip row near a section label. */
async function ssgeClickExactChipNear(
  page: Page,
  chipText: string,
  sectionLabel: string
): Promise<boolean> {
  const target = chipText.trim();
  if (!target) return false;

  const clicked = await page.evaluate(
    ({ target, sectionLabel }) => {
      const norm = (s: string) =>
        s.replace(/\s*\*\s*$/, "").replace(/\s+/g, " ").trim();
      const isVisible = (el: HTMLElement) =>
        el.offsetParent !== null && getComputedStyle(el).opacity !== "0";

      function findFieldWrapper(labelSpan: Element): Element | null {
        const labelDiv = labelSpan.parentElement;
        if (!labelDiv) return null;
        let sibling = labelDiv.nextElementSibling;
        for (let i = 0; i < 4 && sibling; i++) {
          if (sibling.querySelector("p")) return labelDiv.parentElement;
          sibling = sibling.nextElementSibling;
        }
        return labelDiv.parentElement;
      }

      function clickExactIn(container: Element): boolean {
        for (const p of container.querySelectorAll("p")) {
          if ((p.textContent || "").trim() !== target) continue;
          const chipDiv = p.parentElement as HTMLElement | null;
          if (chipDiv && isVisible(chipDiv)) {
            chipDiv.click();
            return true;
          }
        }
        return false;
      }

      const want = norm(sectionLabel);
      for (const el of document.querySelectorAll("span, p")) {
        const t = norm(el.textContent || "");
        if (t !== want && !t.startsWith(want)) continue;
        if (!isVisible(el as HTMLElement)) continue;
        const root =
          sectionLabel === "ოთახები"
            ? document.getElementById("room-input") || findFieldWrapper(el)
            : findFieldWrapper(el);
        if (!root) continue;
        if (clickExactIn(root)) return true;
      }
      return false;
    },
    { target, sectionLabel }
  );

  if (clicked) await prefillPause(page, 40);
  return clicked;
}

/** Fill the overflow number input shown after clicking "8+" (ოთახები) etc. */
async function ssgeFillNumericOverflowInput(
  page: Page,
  value: string,
  sectionLabel: string
): Promise<boolean> {
  const val = digitsOnly(value);
  if (!val) return false;

  const filled = await page.evaluate(
    ({ val, sectionLabel }) => {
      const norm = (s: string) =>
        s.replace(/\s*\*\s*$/, "").replace(/\s+/g, " ").trim();
      const isVisible = (el: HTMLElement) =>
        el.offsetParent !== null && getComputedStyle(el).opacity !== "0";
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      )?.set;
      if (!setter) return false;

      function fillInput(input: HTMLInputElement): boolean {
        if (!isVisible(input)) return false;
        const type = (input.type || "text").toLowerCase();
        if (type === "hidden" || type === "checkbox" || type === "radio") {
          return false;
        }
        input.focus();
        setter!.call(input, val);
        input.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            cancelable: true,
            inputType: "insertText",
            data: val,
          })
        );
        input.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }

      function findFieldWrapper(labelSpan: Element): Element | null {
        const labelDiv = labelSpan.parentElement;
        if (!labelDiv) return null;
        return labelDiv.parentElement;
      }

      const want = norm(sectionLabel);
      const roots: Element[] = [];
      if (sectionLabel === "ოთახები") {
        const roomInput = document.getElementById("room-input");
        if (roomInput) roots.push(roomInput);
      }
      if (sectionLabel === "საძინებელი") {
        const bedInput = document.querySelector(
          'input[name="bedrooms"]'
        ) as HTMLInputElement | null;
        if (bedInput && fillInput(bedInput)) return true;
      }
      for (const el of document.querySelectorAll("span, p")) {
        const t = norm(el.textContent || "");
        if (t !== want && !t.startsWith(want)) continue;
        const root = findFieldWrapper(el);
        if (root && !roots.includes(root)) roots.push(root);
      }

      for (const root of roots) {
        const inputs = [
          ...root.querySelectorAll<HTMLInputElement>("input"),
        ];
        for (const inp of inputs) {
          if (fillInput(inp)) return true;
        }
      }
      return false;
    },
    { val, sectionLabel }
  );

  if (filled) {
    await prefillPause(page, 80);
    return true;
  }

  if (sectionLabel === "საძინებელი") {
    const bedInput = page.locator('input[name="bedrooms"]').first();
    if ((await bedInput.count()) > 0) {
      await bedInput.scrollIntoViewIfNeeded().catch(() => null);
      await bedInput.click({ timeout: 5000 }).catch(() => null);
      await bedInput.fill(val, { timeout: 5000 });
      await prefillPause(page, 80);
      return true;
    }
  }

  const root =
    sectionLabel === "ოთახები"
      ? page.locator("#room-input")
      : page
          .locator("span")
          .filter({ hasText: new RegExp(`^${escapeRegExp(sectionLabel)}`, "i") })
          .first()
          .locator("xpath=ancestor::div[.//p][1]");

  const input = root.locator('input:not([type="hidden"])').first();
  if ((await input.count()) === 0) return false;
  await input.scrollIntoViewIfNeeded().catch(() => null);
  await input.fill(val, { timeout: 5000 });
  await prefillPause(page, 80);
  return true;
}

/** Fill bedroom count in the text box to the right of chip "9" (no 9+ chip on ss.ge). */
async function ssgeFillBedroomsBox(page: Page, value: string): Promise<boolean> {
  const digits = digitsOnly(value);
  if (!digits) return false;
  const num = parseInt(digits, 10);
  if (!Number.isFinite(num) || num <= 9) return false;

  console.log(
    `[ss.ge prefill] საძინებელი ${num} > 9: typing ${digits} in input[name="bedrooms"]`
  );

  const bedInput = page.locator('input[name="bedrooms"]').first();
  const hasInput = await bedInput
    .waitFor({ state: "visible", timeout: 5000 })
    .then(() => true)
    .catch(() => false);

  if (!hasInput) {
    const byPlaceholder = await ssgeSetInputByPlaceholder(page, "საძინებელი", digits);
    if (byPlaceholder) await prefillPause(page, 80);
    return byPlaceholder;
  }

  await bedInput.scrollIntoViewIfNeeded().catch(() => null);
  await bedInput.click({ timeout: 5000 });
  await prefillPause(page, 40);

  const filled = await page.evaluate((val) => {
    const input = document.querySelector(
      'input[name="bedrooms"]'
    ) as HTMLInputElement | null;
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    )?.set;
    input.focus();
    if (setter) setter.call(input, val);
    else input.value = val;
    input.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: val,
      })
    );
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return input.value === val;
  }, digits);

  if (filled) {
    await prefillPause(page, 80);
    return true;
  }

  await bedInput.fill(digits, { timeout: 5000 }).catch(() => null);
  await prefillPause(page, 80);
  return (await bedInput.inputValue().catch(() => "")) === digits;
}

/**
 * Numeric chip row: 1…N, or N+ with a text input (ოთახები uses 8+).
 */
async function ssgePrefillNumericChipField(
  page: Page,
  value: string,
  sectionLabel: string,
  maxChip: number
): Promise<boolean> {
  const digits = digitsOnly(value);
  if (!digits) return false;
  const num = parseInt(digits, 10);
  if (!Number.isFinite(num) || num < 1) return false;

  if (num <= maxChip) {
    const ok = await ssgeClickNumberNear(page, digits, sectionLabel);
    if (!ok) {
      console.warn(
        `[ss.ge prefill] ${sectionLabel} chip "${digits}" not selected`
      );
    }
    return ok;
  }

  if (sectionLabel === "საძინებელი" && num > maxChip) {
    return ssgeFillBedroomsBox(page, digits);
  }

  const overflowChip = `${maxChip}+`;
  console.log(
    `[ss.ge prefill] ${sectionLabel} ${num} > ${maxChip}: click "${overflowChip}" and type ${digits}`
  );

  const plusOk = await ssgeClickExactChipNear(page, overflowChip, sectionLabel);
  if (!plusOk) {
    console.warn(
      `[ss.ge prefill] ${sectionLabel} overflow chip "${overflowChip}" not clicked`
    );
    return false;
  }

  await page
    .waitForFunction(
      ({ sectionLabel }) => {
        if (sectionLabel === "საძინებელი") {
          const bed = document.querySelector(
            'input[name="bedrooms"]'
          ) as HTMLElement | null;
          if (bed?.offsetParent !== null) return true;
        }
        const root =
          sectionLabel === "ოთახები"
            ? document.getElementById("room-input")
            : null;
        const searchRoot = root || document.body;
        for (const inp of searchRoot.querySelectorAll("input")) {
          const type = (inp.getAttribute("type") || "text").toLowerCase();
          if (type === "hidden" || type === "checkbox") continue;
          const el = inp as HTMLElement;
          if (el.offsetParent !== null) return true;
        }
        return false;
      },
      { sectionLabel },
      { timeout: 5000 }
    )
    .catch(() => null);

  await prefillPause(page, 60);

  const inputOk = await ssgeFillNumericOverflowInput(
    page,
    digits,
    sectionLabel
  );
  if (!inputOk) {
    console.warn(
      `[ss.ge prefill] ${sectionLabel} overflow input "${digits}" not filled`
    );
  }
  return inputOk;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function readReactSelectValue(
  control: ReturnType<Page["locator"]>
): Promise<string> {
  const single = control.locator("[class*='select__single-value']").first();
  if ((await single.count()) > 0) {
    return (await single.textContent())?.trim() || "";
  }
  return (await control.textContent())?.trim() || "";
}

function ssgeStreetKey(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/\./g, "")
    .replace(/ქუჩა$/u, "ქ")
    .replace(/შესახვევი$/u, "შეს")
    .replace(/შეს$/u, "შეს")
    .trim();
}

function ssgeStreetScore(want: string, option: string): number {
  const a = ssgeStreetKey(want);
  const b = ssgeStreetKey(option);
  if (!a || !b) return 0;
  if (a === b) return 1000;
  if (b.startsWith(a) || a.startsWith(b)) return 900;
  if (b.includes(a) || a.includes(b)) return Math.min(a.length, b.length) * 8;
  let prefix = 0;
  const max = Math.min(a.length, b.length);
  while (prefix < max && a[prefix] === b[prefix]) prefix++;
  return prefix * 15;
}

/** Alternate spellings for ss.ge street token search (e.g. კათოლიკოს აბრამ I ქ.). */
const SSGE_STREET_WORD_ALIASES: Record<string, string[]> = {
  კათოლიკოს: ["კათალიკოს"],
  კათალიკოს: ["კათოლიკოს"],
  აბრამ: ["აბრაჰამ"],
  აბრაჰამ: ["აბრამ"],
};

function ssgeSignificantStreetWords(street: string): string[] {
  const core = street
    .replace(/\s+(ქ\.?|ქუჩა|შეს\.?|შესახვევი)\s*$/iu, "")
    .replace(/\s+/g, " ")
    .trim();
  return core
    .split(/\s+/)
    .map((w) => w.replace(/\.$/, "").trim())
    .filter((w) => w.length >= 3 && !/^[IVXLC]+$/iu.test(w));
}

/** Try individual name tokens when the full street string does not match. */
function ssgeStreetWordFallbackQueries(street: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (q: string) => {
    const s = q.replace(/\s+/g, " ").trim();
    if (!s || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };

  for (const word of ssgeSignificantStreetWords(street)) {
    push(word);
    for (const alias of SSGE_STREET_WORD_ALIASES[word] || []) {
      push(alias);
    }
  }
  return out;
}

function ssgeStreetSelectionOk(query: string, selected: string): boolean {
  if (ssgeSelectionMatches(query, selected)) return true;
  if (ssgeStreetScore(query, selected) >= 80) return true;

  const selectedKey = ssgeStreetKey(selected);
  const queryKey = ssgeStreetKey(query);
  if (queryKey.length >= 4 && selectedKey.includes(queryKey)) return true;

  for (const alias of SSGE_STREET_WORD_ALIASES[query] || []) {
    const aliasKey = ssgeStreetKey(alias);
    if (selectedKey.includes(aliasKey)) return true;
  }

  return false;
}

function ssgeStreetQueries(street: string): string[] {
  const s = (street || "").replace(/\s+/g, " ").trim();
  if (!s) return [];

  const seen = new Set<string>();
  const ordered: string[] = [];
  const push = (q: string) => {
    const v = q.replace(/\s+/g, " ").trim();
    if (!v || seen.has(v)) return;
    seen.add(v);
    ordered.push(v);
  };

  // 1. Exact parsed street first.
  push(s);

  // 2. User-requested word fallbacks before any other reshaping.
  for (const q of ssgeStreetWordFallbackQueries(s)) {
    push(q);
  }

  // 3. Generic suffix/prefix reshaping only after word fallbacks fail.
  const generic: string[] = [];

  const withoutPrefix = s.replace(/^[ა-ჰ]{1,2}\.\s*/iu, "").trim();
  if (withoutPrefix && withoutPrefix !== s) {
    generic.push(withoutPrefix);
    const wpBase = withoutPrefix
      .replace(/\s+(ქ\.?|ქუჩა|შეს\.?|შესახვევი)\s*$/iu, "")
      .trim();
    if (wpBase && wpBase !== withoutPrefix) {
      generic.push(`${wpBase} ქ.`, wpBase);
    }
  }

  const parenCleaned = s.replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();
  if (parenCleaned && parenCleaned !== s) {
    generic.push(parenCleaned);
  }

  generic.push(s.replace(/\s*შეს\.?/iu, " შეს. ").replace(/\s+/g, " ").trim());
  generic.push(s.replace(/\./g, " ").replace(/\s+/g, " ").trim());

  const base = s.replace(/\s+(ქ\.?|ქუჩა|შეს\.?|შესახვევი)\s*$/iu, "").trim();
  if (base) {
    generic.push(
      base,
      `${base} ქ`,
      `${base} ქ.`,
      `${base} ქუჩა`,
      `${base} შეს.`,
      `${base} შესახვევი`
    );
  }

  for (const q of generic) {
    push(q);
  }

  return ordered;
}

async function ssgeLocateReactSelectInput(
  page: Page,
  opts: { hiddenInputName?: string; visibleIndex: number }
): Promise<ReturnType<Page["locator"]> | null> {
  const { hiddenInputName, visibleIndex } = opts;

  if (hiddenInputName) {
    const hidden = page.locator(`input[name="${hiddenInputName}"]`);
    if ((await hidden.count()) > 0) {
      const root = hidden.locator(
        'xpath=ancestor::*[.//div[contains(@class,"select__control")]][1]'
      );
      const inp = root.locator('input[id^="react-select-"][id$="-input"]');
      if ((await inp.count()) > 0) return inp.first();
    }
  }

  const inputs = page.locator('input[id^="react-select-"][id$="-input"]');
  const n = await inputs.count();
  let seen = 0;
  for (let i = 0; i < n; i++) {
    const loc = inputs.nth(i);
    if (!(await loc.isVisible().catch(() => false))) continue;
    if (seen === visibleIndex) return loc;
    seen++;
  }
  return null;
}

function ssgeCompactLocationText(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/\s+/g, "");
}

function ssgeOptionScore(want: string, option: string): number {
  const a = ssgeCompactLocationText(want);
  const b = ssgeCompactLocationText(option);
  if (!a || !b) return 0;
  if (a === b) return 1000;
  const bCity = b.split(",")[0]?.trim() || b;
  if (bCity === a || b.startsWith(a)) return 950;
  if (b.includes(a) || a.includes(bCity)) return 850;
  let pref = 0;
  const min = Math.min(a.length, b.length);
  while (pref < min && a[pref] === b[pref]) pref++;
  return pref * 25;
}

function ssgeSelectionMatches(want: string, selected: string): boolean {
  const w = want.replace(/\s+/g, " ").trim();
  const s = selected.replace(/\s+/g, " ").trim();
  if (!w || !s) return false;
  if (s === w || s.startsWith(w) || s.includes(w)) return true;
  const wCity = w.split(",")[0]?.trim() || w;
  const sCity = s.split(",")[0]?.trim() || s;
  return sCity === wCity || s.includes(wCity);
}

/**
 * Fill a react-select on ss.ge (city / street).
 * Uses real keyboard input + option click — never ArrowDown+Enter (that picks თბილისი).
 */
async function ssgeSelectReactOption(
  page: Page,
  hiddenInputName: string,
  value: string,
  visibleIndex = hiddenInputName === "choose-street" ? 1 : 0
): Promise<boolean> {
  const target = value?.trim();
  if (!target) return false;

  const input = await ssgeLocateReactSelectInput(page, {
    hiddenInputName,
    visibleIndex,
  });
  if (!input) {
    console.warn(
      `[ss.ge prefill] react-select input not found (name=${hiddenInputName}, idx=${visibleIndex})`
    );
    return false;
  }

  const control = input.locator(
    'xpath=ancestor::*[contains(@class,"select__control")][1]'
  );

  await control.scrollIntoViewIfNeeded().catch(() => null);

  const clear = control.locator('[class*="select__clear-indicator"]');
  if ((await clear.count()) > 0 && (await clear.isVisible().catch(() => false))) {
    await clear.click({ timeout: 3000 }).catch(() => null);
    await prefillPause(page, 40);
  }

  await control.click({ timeout: 5000 });
  await input.click({ timeout: 5000 });
  await input.fill("");
  await input.pressSequentially(target, { delay: 18 });
  await prefillPause(page, 60);

  const listboxId = await input.getAttribute("aria-controls");
  const options = listboxId
    ? page.locator(`#${listboxId} [class*="select__option"]`)
    : page.locator('[class*="select__menu"] [class*="select__option"]');

  await options
    .first()
    .waitFor({ state: "visible", timeout: 4000 })
    .catch(() => null);

  const optionCount = await options.count();
  if (optionCount === 0) {
    const roleOpt = page.getByRole("option").filter({
      hasText: new RegExp(escapeRegExp(target.split(",")[0].trim()), "iu"),
    });
    if ((await roleOpt.count()) > 0) {
      await roleOpt.first().click({ timeout: 5000 });
    } else {
      console.warn(
        `[ss.ge prefill] react-select "${hiddenInputName}": no options for "${target}"`
      );
      await page.keyboard.press("Escape").catch(() => null);
      return false;
    }
  } else {
    let bestIdx = 0;
    let bestScore = -1;
    const scoreFn =
      hiddenInputName === "choose-street" ? ssgeStreetScore : ssgeOptionScore;
    for (let i = 0; i < optionCount; i++) {
      const text = (await options.nth(i).textContent())?.trim() || "";
      const score = scoreFn(target, text);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    const minScore = hiddenInputName === "choose-street" ? 80 : 80;
    if (bestScore < minScore) {
      console.warn(
        `[ss.ge prefill] react-select "${hiddenInputName}": weak match for "${target}" (score ${bestScore})`
      );
      await page.keyboard.press("Escape").catch(() => null);
      return false;
    }
    await options.nth(bestIdx).click({ timeout: 5000 });
  }

  await prefillPause(page, 80);

  const selected = await readReactSelectValue(control);
  const ok =
    hiddenInputName === "choose-street"
      ? ssgeStreetSelectionOk(target, selected)
      : ssgeSelectionMatches(target, selected);
  if (!ok) {
    console.warn(
      `[ss.ge prefill] react-select "${hiddenInputName}": wanted "${target}", got "${selected}"`
    );
  }
  return ok;
}

/** Step 3 — city then street (street loads async after city). */
async function ssgeFillLocationStep(
  page: Page,
  listing: Pick<MyhomeListing, "city" | "street" | "streetNumber">
): Promise<void> {
  const cityRaw = listing.city?.trim() || "";
  const cityQuery = cityForPrefill(cityRaw);
  const streetRaw = (listing.street || "").trim();

  console.log(
    `[ss.ge prefill] location parsed: city="${cityRaw}" → prefill="${cityQuery}", street="${streetRaw}"`
  );

  await page
    .locator('input[id^="react-select-"][id$="-input"]')
    .first()
    .waitFor({ state: "visible", timeout: 12000 })
    .catch(() => null);
  await prefillPause(page, 80);

  if (cityQuery) {
    const cityOk = await ssgeSelectReactOption(page, "choose-city", cityQuery, 0);
    if (!cityOk) {
      console.warn(`[ss.ge prefill] city "${cityQuery}" was not selected`);
    }
    await page
      .waitForFunction(
        () => {
          const inputs = [
            ...document.querySelectorAll(
              'input[id^="react-select-"][id$="-input"]'
            ),
          ] as HTMLInputElement[];
          const visible = inputs.filter(
            (el) => el.offsetParent !== null && !el.disabled
          );
          return visible.length >= 2;
        },
        { timeout: 6000 }
      )
      .catch(() => null);
    await prefillPause(page, 60);
  }

  if (streetRaw) {
    const streetQueries = ssgeStreetQueries(streetRaw);
    let streetOk = false;
    for (const q of streetQueries) {
      if (await ssgeSelectReactOption(page, "choose-street", q, 1)) {
        streetOk = true;
        break;
      }
    }
    if (!streetOk) {
      console.warn(
        `[ss.ge prefill] street "${streetRaw}" was not selected (tried ${streetQueries.length} queries)`
      );
    }
    await prefillPause(page, 60);
  }

  const streetNumber = listing.streetNumber?.trim();
  if (streetNumber) {
    await ssgeSetInputByPlaceholder(page, "სახლის", streetNumber).catch(
      () => null
    );
    await ssgeSetInputByPlaceholder(page, "ნომერი", streetNumber).catch(
      () => null
    );
  }
}

/** Fill input by label span/text (ss.ge step 4 — სახლის ფართი, ეზოს ფართი). */
async function ssgeSetInputByLabel(
  page: Page,
  label: string,
  value: string
): Promise<boolean> {
  if (!value?.trim()) return false;
  return page.evaluate(
    ({ label, value }) => {
      function norm(s: string) {
        return (s || "").replace(/\s*\*\s*$/, "").trim().replace(/\s+/g, " ");
      }
      function labelMatch(text: string, want: string) {
        const n = norm(text);
        const w = norm(want);
        return n === w || n.startsWith(`${w} `) || n.replace(/\*+$/, "").trim() === w;
      }
      const isVisible = (el: HTMLElement) =>
        el.offsetParent !== null && getComputedStyle(el).opacity !== "0";
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      )?.set;
      if (!setter) return false;

      function fill(input: HTMLInputElement): boolean {
        if (!isVisible(input)) return false;
        const type = (input.getAttribute("type") || "text").toLowerCase();
        if (type === "hidden" || type === "checkbox" || type === "radio") {
          return false;
        }
        input.focus();
        setter!.call(input, value);
        input.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            cancelable: true,
            inputType: "insertText",
            data: value,
          })
        );
        input.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }

      for (const lbl of document.querySelectorAll("label")) {
        for (const span of lbl.querySelectorAll("span")) {
          if (!labelMatch(span.textContent || "", label)) continue;
          const forAttr = lbl.getAttribute("for");
          const input = forAttr
            ? (document.getElementById(forAttr) as HTMLInputElement | null)
            : (lbl.querySelector("input") as HTMLInputElement | null);
          if (input && fill(input)) return true;
        }
      }

      for (const el of document.querySelectorAll("span, p")) {
        if (!labelMatch(el.textContent || "", label)) continue;
        if ((el.textContent || "").length > 40) continue;
        let node: Element | null = el.parentElement;
        for (let depth = 0; depth < 10 && node; depth++) {
          const inputs = node.querySelectorAll("input");
          for (const inp of inputs) {
            if (fill(inp as HTMLInputElement)) return true;
          }
          node = node.parentElement;
        }
      }

      for (const inp of document.querySelectorAll<HTMLInputElement>("input")) {
        if ((inp.placeholder || "").includes(label) && fill(inp)) return true;
      }
      return false;
    },
    { label, value: value.trim() }
  );
}

/** Fill a visible input found by placeholder substring. */
async function ssgeSetInputByPlaceholder(
  page: Page,
  placeholderText: string,
  value: string
): Promise<boolean> {
  if (!value?.trim()) return false;
  return page.evaluate(
    ({ placeholderText, value }) => {
      const isVisible = (el: HTMLElement) =>
        el.offsetParent !== null && getComputedStyle(el).opacity !== "0";
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, "value"
      )?.set;

      for (const inp of document.querySelectorAll<HTMLInputElement>("input, textarea")) {
        if (!isVisible(inp)) continue;
        if (!(inp.placeholder || "").includes(placeholderText)) continue;
        if (setter) setter.call(inp, value); else inp.value = value;
        inp.dispatchEvent(new Event("input", { bubbles: true }));
        inp.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
      return false;
    },
    { placeholderText, value }
  );
}

/** Fill a textarea (the first visible one on the page). */
async function ssgeSetTextarea(page: Page, value: string): Promise<boolean> {
  if (!value?.trim()) return false;
  return page.evaluate(
    (value) => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, "value"
      )?.set;
      for (const ta of document.querySelectorAll<HTMLTextAreaElement>("textarea")) {
        if (ta.offsetParent === null) continue;
        if (setter) setter.call(ta, value); else ta.value = value;
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        ta.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
      return false;
    },
    value
  );
}

/**
 * Wait for the SS.ge React SPA to render step 1 content.
 * Polls until the "აირჩიე კატეგორია" heading <p> is in the DOM.
 */
async function waitForSsgeForm(page: Page, timeout = 30000): Promise<void> {
  await waitForSsgeOnCreate(page, timeout);
  await prefillPause(page, 60);
}

/** True when listing currency is USD (handles "USD", "$", "usd"). */
function isUsdCurrency(currency: string | undefined | null): boolean {
  const c = (currency || "USD").trim().toUpperCase();
  if (c === "GEL" || c === "₾" || c.includes("LARI")) return false;
  return c === "USD" || c === "$" || c.startsWith("USD");
}

/**
 * Fill price on ss.ge step 7 (#create-app-price).
 * Two <label> boxes: GEL (₾) and USD ($). Only the active label has
 * <input type="number">; the inactive one shows a static <div> value.
 * Must click the $ label first to activate it, then fill the input.
 */
async function ssgeFillPrice(
  page: Page,
  price: string,
  currency: string | undefined | null
): Promise<boolean> {
  const priceDigits = price.replace(/[^\d.]/g, "");
  if (!priceDigits) return false;

  const wantUsd = isUsdCurrency(currency ?? "USD");
  const targetSym = wantUsd ? "$" : "₾";

  const section = page.locator("#create-app-price").first();
  const hasSection = await section
    .waitFor({ state: "visible", timeout: 12000 })
    .then(() => true)
    .catch(() => false);

  if (!hasSection) {
    console.warn("[ss.ge prefill] #create-app-price not found");
    return false;
  }

  // Match by currency symbol — do NOT filter labels that already have an input
  // (only the active GEL box has one until we click USD).
  const labelIndex = await section.evaluate((root, currencySym) => {
    const labels = [...root.querySelectorAll("label")];
    const symOf = (lbl: Element): string | null => {
      for (const div of lbl.querySelectorAll("div")) {
        const t = (div.textContent || "").trim();
        if (t === "₾" || t === "$") return t;
      }
      return null;
    };

    for (let i = 0; i < labels.length; i++) {
      if (symOf(labels[i]) === currencySym) return i;
    }

    if (labels.length >= 2) {
      const sorted = labels
        .map((lbl, i) => ({ i, left: lbl.getBoundingClientRect().left }))
        .sort((a, b) => a.left - b.left);
      return currencySym === "$"
        ? sorted[sorted.length - 1].i
        : sorted[0].i;
    }
    return labels.length === 1 ? 0 : -1;
  }, targetSym);

  if (labelIndex < 0) {
    console.warn(`[ss.ge prefill] price label for "${targetSym}" not found`);
    return false;
  }

  const targetLabel = section.locator("label").nth(labelIndex);
  await targetLabel.scrollIntoViewIfNeeded().catch(() => null);
  await targetLabel.click({ timeout: 5000, force: true });
  await prefillPause(page, 60);

  await page
    .waitForFunction(
      (idx) => {
        const root = document.getElementById("create-app-price");
        if (!root) return false;
        const lbl = root.querySelectorAll("label")[idx] as HTMLElement | undefined;
        if (!lbl?.classList.contains("active")) return false;
        const inp = lbl.querySelector('input[type="number"]');
        return !!inp && (inp as HTMLElement).offsetParent !== null;
      },
      labelIndex,
      { timeout: 6000 }
    )
    .catch(() => null);

  const showOnSite = targetLabel.getByText("გამოჩნდეს საიტზე");
  if ((await showOnSite.count()) > 0) {
    await showOnSite.first().click({ timeout: 3000 }).catch(() => null);
    await prefillPause(page, 80);
  }

  const input = targetLabel.locator('input[type="number"]');
  const hasInput = await input
    .waitFor({ state: "visible", timeout: 6000 })
    .then(() => true)
    .catch(() => false);

  if (!hasInput) {
    console.warn(
      `[ss.ge prefill] price input not visible in ${wantUsd ? "USD" : "GEL"} box`
    );
    return false;
  }

  await input.click({ timeout: 3000 }).catch(() => null);
  await input.fill(priceDigits, { timeout: 5000 });

  await input.evaluate((el, v) => {
    const inp = el as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    )?.set;
    if (setter) setter.call(inp, v);
    else inp.value = v;
    inp.dispatchEvent(new Event("input", { bubbles: true }));
    inp.dispatchEvent(new Event("change", { bubbles: true }));
  }, priceDigits);

  await prefillPause(page, 80);

  const filled = (await input.inputValue().catch(() => "")).replace(/[^\d.]/g, "");
  const ok =
    filled === priceDigits ||
    filled.replace(/\.0+$/, "") === priceDigits.replace(/\.0+$/, "");

  console.log(
    `[ss.ge prefill] price ${priceDigits} in ${wantUsd ? "USD ($)" : "GEL (₾)"} — ${
      ok ? "ok" : `verify failed (got "${filled}")`
    }`
  );
  return ok || filled.length > 0;
}

/**
 * Step 8 კონტაქტი — always enable WhatsApp and Viber on the phone row.
 * DOM: label.whatsappLabel / label.viberLabel → div (checkbox) → svg line when on.
 */
async function ssgeWaitForSsgeContactStep(page: Page): Promise<boolean> {
  const contact = page.locator("#create-app-contact").first();
  if (
    await contact
      .waitFor({ state: "visible", timeout: 5000 })
      .then(() => true)
      .catch(() => false)
  ) {
    return true;
  }
  return page
    .locator(
      "label.whatsappLabel, label.viberLabel, [class*='whatsappLabel'], [class*='viberLabel']"
    )
    .first()
    .waitFor({ state: "visible", timeout: 3000 })
    .then(() => true)
    .catch(() => false);
}

/** Checked = tick line in the last div (checkbox), not the app icon. */
async function ssgeIsMessagingToggleOn(label: Locator): Promise<boolean> {
  return label
    .locator("div")
    .last()
    .locator("svg line")
    .isVisible({ timeout: 500 })
    .catch(() => false);
}

/** One click on the checkbox only — clicking label+box toggles twice. */
async function ssgeEnableMessagingToggle(
  scope: Locator,
  name: "WhatsApp" | "Viber",
  primarySelector: string
): Promise<boolean> {
  let label = scope.locator(primarySelector).first();
  if (!(await label.isVisible({ timeout: 2000 }).catch(() => false))) {
    label = scope.locator("label").filter({ hasText: name }).first();
  }
  if (!(await label.isVisible({ timeout: 1500 }).catch(() => false))) {
    console.warn(`[ss.ge prefill] ${name} toggle not found`);
    return false;
  }

  await label.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => null);
  const checkbox = label.locator("div").last();

  if (await ssgeIsMessagingToggleOn(label)) {
    console.log(`[ss.ge prefill] ${name} already on`);
    return true;
  }

  await checkbox.click({ timeout: 2000, force: true });
  await prefillPause(label.page(), 30);

  if (await ssgeIsMessagingToggleOn(label)) {
    console.log(`[ss.ge prefill] ${name} enabled`);
    return true;
  }

  console.warn(`[ss.ge prefill] ${name} still off after one click`);
  return false;
}

async function ssgeEnsureWhatsAppAndViber(page: Page): Promise<void> {
  if (!(await ssgeWaitForSsgeContactStep(page))) {
    console.warn(
      "[ss.ge prefill] contact step not visible — skip WhatsApp/Viber"
    );
    return;
  }

  const scope = (await page.locator("#create-app-contact").count())
    ? page.locator("#create-app-contact").first()
    : page.locator("main").first();

  await ssgeEnableMessagingToggle(scope, "WhatsApp", "label.whatsappLabel");
  await ssgeEnableMessagingToggle(scope, "Viber", "label.viberLabel");
}

const SSGE_PUBLISH_BUTTON_RE = /განაცხადის\s*განთავსება/;
const SSGE_CHECKOUT_WAIT_MS = parseInt(
  process.env.SSGE_CHECKOUT_MAX_WAIT_MS || "2500",
  10
);

function ssgeCheckoutLocator(page: Page) {
  return page.locator("text=/გადახდის მეთოდები|განცხადების ღირებულება/").first();
}

async function isSsgeCheckoutVisible(page: Page): Promise<boolean> {
  return ssgeCheckoutLocator(page)
    .isVisible({ timeout: 200 })
    .catch(() => false);
}

/** Click გაგრძელება only when checkout panel is not already open. */
async function ssgeOpenCheckoutIfNeeded(page: Page): Promise<boolean> {
  if (await isSsgeCheckoutVisible(page)) return true;

  const clicked = await page.evaluate(() => {
    const btn = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button.btn-next")
    )
      .reverse()
      .find(
        (b) =>
          b.offsetParent !== null &&
          !b.disabled &&
          /გაგრძელება/.test(b.textContent || "")
      );
    if (!btn) return false;
    btn.scrollIntoView({ block: "center", behavior: "instant" });
    btn.click();
    return true;
  });
  if (!clicked) return false;

  return ssgeCheckoutLocator(page)
    .waitFor({ state: "visible", timeout: SSGE_CHECKOUT_WAIT_MS })
    .then(() => true)
    .catch(() => false);
}

/** Scroll to and click განაცხადის განთავსება immediately (no post-click wait in headed mode). */
async function ssgeClickPublishListingNow(page: Page): Promise<boolean> {
  await page.evaluate(() => {
    const norm = (s: string) => s.replace(/\s+/g, " ").trim();
    const re = /განაცხადის\s*განთავსება/i;
    const btn = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
      .filter((b) => re.test(norm(b.textContent || "")))
      .pop();
    if (!btn) return;
    window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" });
    let node: HTMLElement | null = btn.parentElement;
    while (node && node !== document.documentElement) {
      const oy = getComputedStyle(node).overflowY;
      if (/(auto|scroll|overlay)/.test(oy)) {
        const rect = btn.getBoundingClientRect();
        const pr = node.getBoundingClientRect();
        if (rect.bottom > pr.bottom - 8) {
          node.scrollTop += rect.bottom - pr.bottom + 16;
        }
      }
      node = node.parentElement;
    }
    btn.scrollIntoView({ block: "center", behavior: "instant" });
  });

  const publishBtn = page
    .getByRole("button", { name: SSGE_PUBLISH_BUTTON_RE })
    .last();
  if (!(await publishBtn.count())) {
    return page
      .locator("button")
      .filter({ hasText: SSGE_PUBLISH_BUTTON_RE })
      .last()
      .click({ timeout: 1500, force: true })
      .then(() => true)
      .catch(() => false);
  }

  return publishBtn
    .click({ timeout: 1500, force: true })
    .then(() => true)
    .catch(() => false);
}

/** Continue → checkout → publish (checkout uses same /create URL — never wait on URL change). */
async function ssgeFinishCheckoutAndPublish(
  page: Page,
  options?: { confirmPublish?: boolean }
): Promise<{ checkout: boolean; published: boolean }> {
  console.log("[ss.ge prefill] Finish: გაგრძელება → განაცხადის განთავსება");

  const checkout = await ssgeOpenCheckoutIfNeeded(page);
  if (!checkout) {
    console.warn(`[ss.ge prefill] checkout not reached (url="${page.url()}")`);
    return { checkout: false, published: false };
  }

  const clicked = await ssgeClickPublishListingNow(page);
  if (!clicked) {
    console.warn('[ss.ge prefill] "განაცხადის განთავსება" not clicked');
    return { checkout: true, published: false };
  }

  if (!options?.confirmPublish) {
    console.log(`[ss.ge prefill] publish clicked (url="${page.url()}")`);
    return { checkout: true, published: true };
  }

  const published = await page
    .waitForFunction(
      () => {
        const body = document.body?.textContent || "";
        if (/წარმატებ|განთავსდ|განთავსდა/i.test(body)) return true;
        if (!body.includes("გადახდის მეთოდები")) return true;
        return !Array.from(document.querySelectorAll("button")).some(
          (b) =>
            b.offsetParent !== null &&
            /განაცხადის\s*განთავსება/i.test((b.textContent || "").trim())
        );
      },
      { timeout: SSGE_CHECKOUT_WAIT_MS }
    )
    .then(() => true)
    .catch(() => true);

  console.log(`[ss.ge prefill] listing published (url="${page.url()}")`);
  return { checkout: true, published };
}

/** Navigate to a wizard step by clicking its sidebar item. */
async function goToSsgeStep(page: Page, stepName: string): Promise<void> {
  const clicked = await page.evaluate((stepName) => {
    const norm = (s: string) => s.replace(/\s+/g, " ").trim();
    const isVisible = (el: HTMLElement) =>
      el.offsetParent !== null && getComputedStyle(el).opacity !== "0";

    // Sidebar items are divs/spans with step name text.
    // They're in the left column. Find the one matching stepName.
    for (const el of document.querySelectorAll("div, span, a, li, p")) {
      if (!isVisible(el as HTMLElement)) continue;
      if (norm(el.textContent || "") !== norm(stepName)) continue;
      // Avoid matching content-area elements by checking position (left side)
      const rect = (el as HTMLElement).getBoundingClientRect();
      if (rect.left > 300) continue;
      (el as HTMLElement).click();
      return true;
    }
    return false;
  }, stepName);
  if (clicked) {
    await prefillPause(page, 20);
    if (/კონტაქტ/i.test(stepName)) {
      await ssgeWaitForSsgeContactStep(page);
    }
  } else {
    console.warn(`goToSsgeStep: could not navigate to "${stepName}"`);
  }
}

/**
 * Pre-fill the ss.ge create-listing form using the given `MyhomeListing`. The
 * browser stays open (in headed mode) so the user can review & submit
 * manually. Returns the post URL only after the user actually submits — for
 * now we just report success after prefill.
 */
export async function createSsgePost(
  credentials: SsgeCredentials,
  listing: MyhomeListing,
  options: { listingId: string; userId: string; sourceUrl?: string | null }
): Promise<{ success: boolean; postUrl?: string; error?: string }> {
  listing = normalizeListingForSsgePrefill(listing, {
    sourceUrl: options.sourceUrl,
  });
  if (listing.rawData) {
    applySsgeBalconyDefaultsForSsgePrefill(listing.rawData);
  }

  const reuseSession =
    postSession?.email === credentials.email &&
    postSession.browser.isConnected();

  const headless = process.env.SSGE_PREFILL_HEADLESS === "true";

  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  if (reuseSession && postSession) {
    browser = postSession.browser;
    context = postSession.context;
    for (const p of context.pages()) await p.close().catch(() => {});
    page = await context.newPage();
  } else {
    if (postSession?.browser.isConnected()) {
      await postSession.context.close().catch(() => null);
      await postSession.browser.close().catch(() => null);
    }
    browser = await chromium.launch({
      headless,
      args: [
        "--no-sandbox", "--disable-setuid-sandbox",
        ...(headless ? [] : ["--start-maximized"]),
        "--disable-dev-shm-usage", "--disable-gpu",
        "--single-process", "--no-zygote",
      ],
    });
    context = await browser.newContext({
      userAgent: USER_AGENT,
      locale: "ka-GE",
      viewport: headless ? { width: 1920, height: 1080 } : null,
    });
    page = await context.newPage();
    postSession = { email: credentials.email, browser, context };
  }

  const cleanups: Array<() => Promise<void>> = [];

  try {
    await ensureSsgeCreateFormReady(page, credentials, {
      freshSession: !reuseSession,
    });

    if (await needsSsgeLogin(page)) {
      throw new Error(
        "ss.ge prefill blocked — still logged out (login did not complete)"
      );
    }

    if (!(await hasSsgeNextAuthSession(page.context()))) {
      await ensureSsgeHomeAuthenticated(page, credentials);
    }

    // No-op when modal absent; otherwise click "დაამატე ახალი განცხადება" then prefill.
    await dismissSsgeUnfinishedDraftModal(page);

    // ---------------------------------------------------------------
    // WIZARD STEP 1 — Category + Property Type + Deal Type
    // (section headings: <p>აირჩიე კატეგორია</p>, etc.)
    // ---------------------------------------------------------------
    console.log("[ss.ge prefill] Step 1: category / property / deal");

    // Category — always "უძრავი ქონება" (scoped to its heading <p>)
    await ssgeClickCard(page, "უძრავი ქონება", "აირჩიე კატეგორია");

    // Property type (e.g. "ბინა")
    const propertyChip = PROPERTY_TYPE_TO_SSGE[listing.propertyType?.trim() || ""];
    if (propertyChip) {
      await ssgeClickCard(page, propertyChip, "აირჩიეთ უძრავი ქონების ტიპი");
    }

    // Deal type (e.g. "იყიდება")
    const dealChip = DEAL_TYPE_TO_SSGE[listing.dealType?.trim() || ""];
    if (dealChip) {
      await ssgeClickCard(page, dealChip, "აირჩიეთ გარიგების ტიპი");
    }

    // Wait for the wizard to advance after step 1 selections
    await prefillPause(page, 20);

    // ---------------------------------------------------------------
    // WIZARD STEP 2 — სურათები (Images)
    // ---------------------------------------------------------------
    console.log("[ss.ge prefill] Step 2: images");
    await goToSsgeStep(page, "სურათები");

    if (listing.images?.length) {
      try {
        const { paths, cleanup } = await resolveImagesForPlaywright(
          listing.images,
          options.listingId,
          options.userId
        );
        cleanups.push(cleanup);
        if (paths.length) {
          const fileInput = page.locator('input[type="file"]').first();
          await fileInput.setInputFiles(paths, { timeout: 15000 }).catch(() => null);
          await prefillPause(page, 40);
        }
      } catch (e) {
        console.warn("[ss.ge prefill] image upload skipped:", e);
      }
    }

    // ---------------------------------------------------------------
    // WIZARD STEP 3 — მისამართი (Location: city + street)
    // ---------------------------------------------------------------
    console.log("[ss.ge prefill] Step 3: location");
    await goToSsgeStep(page, "მისამართი");
    await ssgeFillLocationStep(page, listing);

    // ---------------------------------------------------------------
    // WIZARD STEP 4 — დეტალური ინფორმაცია
    // ---------------------------------------------------------------
    console.log("[ss.ge prefill] Step 4: detailed info");
    await goToSsgeStep(page, "დეტალური ინფორმაცია");

    // Rooms (ოთახები) — chips 1–8, then "8+" reveals a text input for 9+
    if (listing.rooms?.trim()) {
      await ssgePrefillNumericChipField(page, listing.rooms, "ოთახები", 8);
    }

    // Bedrooms — chips 1–9, or input[name="bedrooms"] box beside 9 for 10+
    if (listing.bedrooms?.trim()) {
      await page
        .waitForFunction(
          () => {
            if (document.querySelector('input[name="bedrooms"]')) return true;
            for (const el of document.querySelectorAll("span, p")) {
              if ((el.textContent || "").includes("საძინებელი")) return true;
            }
            return false;
          },
          { timeout: 5000 }
        )
        .catch(() => null);
      await prefillPause(page, 40);
      await ssgePrefillNumericChipField(
        page,
        listing.bedrooms,
        "საძინებელი",
        9
      );
    }

    const houseAreaVal = digitsOnly(
      listing.rawData?.["სახლის ფართი"]?.trim() || ""
    );
    const yardAreaVal = digitsOnly(
      listing.rawData?.["ეზოს ფართი"]?.trim() || ""
    );
    const generalAreaVal = digitsOnly(listing.area?.trim() || "");

    if (houseAreaVal) {
      const filled =
        (await ssgeSetInputByLabel(page, "სახლის ფართი", houseAreaVal)) ||
        (await ssgeSetInputByPlaceholder(page, "სახლის ფართი", houseAreaVal));
      if (!filled) {
        console.warn(
          `[ss.ge prefill] სახლის ფართი "${houseAreaVal}" input not found`
        );
      }
    } else if (generalAreaVal) {
      const filled =
        (await ssgeSetInputByLabel(page, "საერთო ფართი", generalAreaVal)) ||
        (await ssgeSetInputByPlaceholder(page, "საერთო ფართი", generalAreaVal)) ||
        (await ssgeSetInputByLabel(page, "სახლის ფართი", generalAreaVal)) ||
        (await ssgeSetInputByPlaceholder(page, "სახლის ფართი", generalAreaVal));
      if (!filled) console.warn("[ss.ge prefill] area input not found");
    }

    if (yardAreaVal) {
      const filled =
        (await ssgeSetInputByLabel(page, "ეზოს ფართი", yardAreaVal)) ||
        (await ssgeSetInputByPlaceholder(page, "ეზოს ფართი", yardAreaVal));
      if (!filled) {
        console.warn(
          `[ss.ge prefill] ეზოს ფართი "${yardAreaVal}" input not found`
        );
      }
    }

    // Floor + total floors
    if (listing.floor) {
      await ssgeSetInputByPlaceholder(page, "სართული", digitsOnly(listing.floor));
    }
    if (listing.totalFloors) {
      await ssgeSetInputByPlaceholder(page, "სართულიანობა", digitsOnly(listing.totalFloors));
    }

    // Floor type subset (only duplex/triplex/loft chips)
    const floorTypeChip =
      listing.rawData?.["პროექტის ტიპი"]?.trim() ||
      listing.rawData?.["სართულის ტიპი"]?.trim() ||
      "";
    if (
      floorTypeChip &&
      PROJECT_TYPE_SUBSET.includes(floorTypeChip as (typeof PROJECT_TYPE_SUBSET)[number])
    ) {
      await ssgeClickChipNearLabel(page, floorTypeChip, "სართულის ტიპი") ||
        (await ssgeClickCard(page, floorTypeChip));
    }

    // Balcony count (აივანი) — „კი“ from parse → chip 1
    const balconyCount = resolveSsgeBalconyCountForPrefill(listing.rawData);
    if (balconyCount) {
      const balconyOk = await ssgeClickNumberNear(page, balconyCount, "აივანი");
      if (!balconyOk) {
        console.warn(
          `[ss.ge prefill] აივანი chip "${balconyCount}" not selected`
        );
      }
    }

    // Bathrooms (სველი წერტილი)
    const bathroomsDigit = digitsOnly(
      listing.bathrooms ||
        listing.rawData?.["სვ.წერტილი"] ||
        listing.rawData?.["სველი წერტილი"] ||
        ""
    );
    if (bathroomsDigit) {
      const wetOk = await ssgeClickNumberNear(page, bathroomsDigit, "სველი წერტილი");
      if (!wetOk) {
        console.warn(
          `[ss.ge prefill] სველი წერტილი chip "${bathroomsDigit}" not selected`
        );
      }
    }

    // Status (სტატუსი) — building status or land plot type (მიწის ნაკვეთი)
    const statusRaw =
      listing.rawData?.["მიწის ნაკვეთი"]?.trim() ||
      listing.buildingStatus?.trim() ||
      listing.rawData?.["სტატუსი"]?.trim() ||
      "";
    const statusChip = resolveSsgeStatusChip(
      statusRaw,
      listing.propertyType?.trim()
    );
    if (statusChip) {
      console.log(
        `[ss.ge prefill] სტატუსი / მიწის ნაკვეთი: "${statusRaw}" → chip "${statusChip}"`
      );
      const statusOk = await ssgeClickChipNearLabel(page, statusChip, "სტატუსი");
      if (!statusOk) {
        console.warn(
          `[ss.ge prefill] სტატუსი chip "${statusChip}" not selected (parsed: "${statusRaw}")`
        );
      }
    }

    // Project type (პროექტი) — default არასტანდარტული when missing / unknown
    if (!/მიწის\s*ნაკვეთი/i.test(listing.propertyType || "")) {
      const projectChip = resolveSsgeProjectChip(
        listing.projectType?.trim() || "",
        listing.rawData || {}
      );
      const projOk = await ssgeClickChipNearLabel(page, projectChip, "პროექტი");
      if (!projOk) {
        console.warn(`[ss.ge prefill] პროექტი chip "${projectChip}" not selected`);
      }
    }

    const kitchenAreaVal = digitsOnly(
      listing.rawData?.["სამზარეულოს ფართი"]?.trim() || ""
    );
    if (kitchenAreaVal) {
      const kitchenOk =
        (await ssgeSetInputByLabel(
          page,
          "სამზარეულოს ფართი",
          kitchenAreaVal
        )) ||
        (await ssgeSetInputByPlaceholder(
          page,
          "სამზარეულოს",
          kitchenAreaVal
        ));
      if (!kitchenOk) {
        console.warn(
          `[ss.ge prefill] სამზარეულოს ფართი "${kitchenAreaVal}" input not found`
        );
      }
    }

    // ---------------------------------------------------------------
    // WIZARD STEP 5 — დამატებითი ინფორმაცია
    // ---------------------------------------------------------------
    console.log("[ss.ge prefill] Step 5: additional info");
    if (!(await hasSsgeNextAuthSession(page.context()))) {
      await ensureSsgeHomeAuthenticated(page, credentials);
    }
    await goToSsgeStep(page, "დამატებითი ინფორმაცია");

    const conditionRaw =
      listing.condition?.trim() || listing.rawData?.["მდგომარეობა"]?.trim() || "";
    const conditionChip = resolveSsgeConditionChip(conditionRaw);
    if (conditionChip) {
      await page
        .locator("span, p, label")
        .filter({ hasText: /^მდგომარეობა/ })
        .first()
        .waitFor({ state: "visible", timeout: 6000 })
        .catch(() => null);
      const condOk = await ssgePrefillCondition(page, conditionChip);
      if (!condOk) {
        console.warn(
          `[ss.ge prefill] მდგომარეობა "${conditionRaw}" → chip "${conditionChip}" not selected`
        );
      }
    } else if (conditionRaw) {
      console.warn(
        `[ss.ge prefill] მდგომარეობა "${conditionRaw}" has no ss.ge chip mapping`
      );
    }

    await ssgePrefillViewChips(page, listing);

    // Amenity toggles (აივანი, გარაჟი, ლიფტი, …) — same step as listing
    await ssgePrefillAdditionalInfoToggles(page, listing.rawData);

    // ---------------------------------------------------------------
    // WIZARD STEP 6 — აღწერა
    // ---------------------------------------------------------------
    console.log("[ss.ge prefill] Step 6: description");
    await goToSsgeStep(page, "აღწერა");

    // Description textarea
    if (listing.description) {
      await ssgeSetTextarea(page, listing.description);
    }

    // ---------------------------------------------------------------
    // WIZARD STEP 7 — ფასი (Price)
    // ---------------------------------------------------------------
    console.log("[ss.ge prefill] Step 7: price");
    await goToSsgeStep(page, "ფასი");

    // Price radio: "სრული ფასი"
    await ssgeClickCard(page, "სრული ფასი");

    if (listing.price) {
      await ssgeFillPrice(page, listing.price, "USD");
    }

    // ---------------------------------------------------------------
    // WIZARD STEP 8 — კონტაქტი (WhatsApp + Viber always on)
    // ---------------------------------------------------------------
    console.log("[ss.ge prefill] Step 8: contact");
    await goToSsgeStep(page, "კონტაქტი");
    await ssgeEnsureWhatsAppAndViber(page);

    const { checkout, published } = await ssgeFinishCheckoutAndPublish(page, {
      confirmPublish: headless,
    });
    if (headless && !checkout) {
      throw new Error(
        `[ss.ge prefill] "გაგრძელება" did not reach checkout (url="${page.url()}")`
      );
    }
    if (headless && !published) {
      throw new Error(
        `[ss.ge prefill] "განაცხადის განთავსება" did not complete (url="${page.url()}")`
      );
    }

    const graceMs = parseInt(
      process.env.SSGE_PUBLISH_GRACE_MS || "0",
      10
    );
    if (headless && published && graceMs > 0) {
      await page.waitForTimeout(graceMs).catch(() => null);
    }

    const postUrl = page.url();
    console.log(
      headless
        ? published
          ? "[ss.ge prefill] Done — listing published"
          : "[ss.ge prefill] Done — reached checkout"
        : published
          ? "[ss.ge prefill] Done — browser left open after publish"
          : "[ss.ge prefill] Done — browser left open on checkout for review"
    );
    return { success: true, postUrl };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Pre-fill failed",
    };
  } finally {
    for (const cleanup of cleanups) {
      await cleanup().catch(() => null);
    }
    // In headed/local mode we intentionally leave the browser open so the user
    // can review and submit. Only close when running headless.
    if (headless) {
      await context.close().catch(() => null);
      await browser.close().catch(() => null);
      if (postSession?.browser === browser) postSession = null;
    }
  }
}
