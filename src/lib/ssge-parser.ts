import "@/lib/esbuild-shim";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import type { MyhomeListing } from "@/lib/myhome-parser";
import { resolveImagesForPlaywright } from "@/lib/listing-images";
import {
  ADDITIONAL_INFO_TOGGLES,
  BUILDING_STATUS_TO_SSGE,
  CONDITION_TO_SSGE,
  DEAL_TYPE_TO_SSGE,
  PROJECT_TYPE_SUBSET,
  PROJECT_TYPE_TO_SSGE,
  PROPERTY_TYPE_TO_SSGE,
  VIEW_TO_SSGE,
  digitsOnly,
  isTruthyRawValue,
} from "@/lib/ssge-mappings";

export interface SsgeCredentials {
  email: string;
  password: string;
}

const PREFILL_PAUSE_MS = 80;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const SSGE_CREATE_URL = "https://home.ss.ge/ka/udzravi-qoneba/create";
/** Standalone login page (მობილური ან ელ.ფოსტა + პაროლი). */
const SSGE_ACCOUNT_LOGIN_URL = "https://account.ss.ge/ka/account/login";

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
  return url.includes("account.ss.ge") && url.includes("/login");
}

/** Fill account.ss.ge login form (POST /Login — see DevTools on account.ss.ge). */
async function fillSsgeLoginForm(
  page: Page,
  credentials: SsgeCredentials
): Promise<void> {
  // Placeholders are visual-only; inputs use name attributes on the server form.
  const usernameLocator = page
    .locator(
      'form[action="/Login"] input[name="useName"], form[action="/Login"] input[name="userName"], input[name="useName"], input[name="userName"]'
    )
    .first();
  await usernameLocator.waitFor({ state: "visible", timeout: 20000 });
  await usernameLocator.fill(credentials.email);

  const passwordLocator = page
    .locator(
      'form[action="/Login"] input[name="password"], form[action="/Login"] input[name="Password"], input[name="password"], input[type="password"]'
    )
    .first();
  await passwordLocator.waitFor({ state: "visible", timeout: 10000 });
  await passwordLocator.fill(credentials.password);

  const submit = page
    .locator('form[action="/Login"] button[type="submit"]')
    .or(page.getByRole("button", { name: /^შესვლა$/i }))
    .first();
  await submit.click({ timeout: 10000 });
}

/**
 * Submit credentials on account.ss.ge and wait until login completes.
 * Returns false when still on the login page (bad credentials or error).
 */
async function performSsgeLogin(
  page: Page,
  credentials: SsgeCredentials,
  startUrl: string
): Promise<boolean> {
  await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

  if (isSsgeLoginPage(page.url())) {
    await page
      .locator('form[action="/Login"], form[method="post"]')
      .first()
      .waitFor({ state: "visible", timeout: 20000 })
      .catch(() => null);
  }

  if (!isSsgeLoginPage(page.url())) {
    // Already authenticated for home.ss.ge (e.g. create page loaded).
    if (page.url().includes("home.ss.ge")) return true;
    // Open create page — ss.ge redirects to account login with OAuth returnUrl.
    await page.goto(SSGE_CREATE_URL, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
  }

  if (!isSsgeLoginPage(page.url())) {
    return page.url().includes("home.ss.ge");
  }

  await fillSsgeLoginForm(page, credentials);

  try {
    await page.waitForURL((url) => !isSsgeLoginPage(url.href), { timeout: 20000 });
    return true;
  } catch {
    const stillLogin = isSsgeLoginPage(page.url());
    if (stillLogin) return false;
    return page.url().includes("home.ss.ge") || page.url().includes("account.ss.ge");
  }
}

/** Verify ss.ge credentials via account.ss.ge login page. */
export async function loginToSsge(credentials: SsgeCredentials): Promise<{
  success: boolean;
  error?: string;
}> {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const context = await browser.newContext({ userAgent: USER_AGENT });
  const page = await context.newPage();

  try {
    const ok = await performSsgeLogin(page, credentials, SSGE_ACCOUNT_LOGIN_URL);
    if (!ok) {
      return { success: false, error: "Invalid credentials or login failed" };
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

/**
 * Login inside an existing browser session. Opens the create page first so
 * ss.ge supplies the correct OAuth returnUrl, then fills account.ss.ge if
 * redirected.
 */
async function ensurePostSessionLogin(
  page: Page,
  credentials: SsgeCredentials
): Promise<void> {
  const ok = await performSsgeLogin(page, credentials, SSGE_CREATE_URL);
  if (!ok) {
    throw new Error("ss.ge login failed — check linked credentials");
  }
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
  const clicked = await page.evaluate(
    ({ text, sectionHeading }) => {
      const norm = (s: string) => s.replace(/\s+/g, " ").trim();
      const isVisible = (el: HTMLElement) =>
        el.offsetParent !== null &&
        getComputedStyle(el).opacity !== "0" &&
        getComputedStyle(el).visibility !== "hidden";

      let scope: Element = document.body;

      // Narrow scope to the section container (sibling div after <p> heading)
      if (sectionHeading) {
        for (const p of document.querySelectorAll("p")) {
          if (norm(p.textContent || "") === norm(sectionHeading)) {
            const next = p.nextElementSibling;
            if (next) { scope = next; break; }
          }
        }
      }

      // Search for a visible element whose text matches
      for (const el of scope.querySelectorAll("div, button, label, span, a")) {
        const html = el as HTMLElement;
        if (!isVisible(html)) continue;
        // Skip containers with many children (they are wrappers, not chips)
        if (html.children.length > 3) continue;
        if (norm(html.textContent || "") === norm(text)) {
          html.click();
          return true;
        }
      }
      return false;
    },
    { text, sectionHeading: sectionHeading ?? null }
  );
  if (clicked) await prefillPause(page, 200);
  return clicked;
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
      let labelSpan: Element | null = null;
      for (const el of document.querySelectorAll("span")) {
        if (norm(el.textContent || "") !== norm(sectionLabel)) continue;
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
  if (clicked) await prefillPause(page, 200);
  return clicked;
}

/**
 * Interact with a react-select dropdown on ss.ge.
 * Finds the component by the hidden `<input name="...">` next to it,
 * clicks the control to open the menu, types to filter, then selects
 * the matching option.
 */
async function ssgeSelectReactOption(
  page: Page,
  hiddenInputName: string,
  value: string
): Promise<boolean> {
  if (!value?.trim()) return false;

  const control = page.locator(
    `input[name="${hiddenInputName}"]`
  ).locator("xpath=ancestor::div[.//div[contains(@class,'select__control')]]").first()
    .locator("div[class*='select__control']").first();

  const hasControl = await control
    .waitFor({ state: "visible", timeout: 8000 })
    .then(() => true)
    .catch(() => false);

  if (!hasControl) {
    console.warn(
      `[ss.ge prefill] react-select control not found for "${hiddenInputName}"`
    );
    return false;
  }

  // Click the control to open the dropdown menu
  await control.click({ timeout: 5000 });
  await prefillPause(page, 400);

  // Type into the react-select search input to filter options
  const searchInput = page.locator(
    "input[class*='select__input'], div[class*='select__input'] input"
  ).last();
  const hasSearch = await searchInput
    .waitFor({ state: "attached", timeout: 3000 })
    .then(() => true)
    .catch(() => false);
  if (hasSearch) {
    await searchInput.fill(value, { timeout: 3000 }).catch(() => null);
    await prefillPause(page, 600);
  }

  // Wait for the menu to appear and click the matching option
  const optionClicked = await page.evaluate(
    ({ value }) => {
      const norm = (s: string) => s.replace(/\s+/g, " ").trim();
      const target = norm(value);

      const options = document.querySelectorAll(
        "div[class*='select__option']"
      );
      for (const opt of options) {
        const text = norm(opt.textContent || "");
        if (text === target || text.includes(target) || target.includes(text)) {
          (opt as HTMLElement).click();
          return true;
        }
      }
      return false;
    },
    { value }
  );

  if (optionClicked) {
    await prefillPause(page, 300);
    return true;
  }

  // Fallback: press ArrowDown + Enter if text match failed
  await page.keyboard.press("ArrowDown").catch(() => null);
  await prefillPause(page, 150);
  await page.keyboard.press("Enter").catch(() => null);
  await prefillPause(page, 300);

  console.log(
    `[ss.ge prefill] react-select "${hiddenInputName}" → "${value}" (keyboard fallback)`
  );
  return true;
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
async function waitForSsgeForm(page: Page, timeout = 20000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const found = await page.evaluate(() =>
      !!Array.from(document.querySelectorAll("p")).find((p) =>
        (p.textContent || "").includes("აირჩიე კატეგორია") ||
        (p.textContent || "").includes("აირჩიეთ") ||
        (p.textContent || "").includes("საძინებელი")
      )
    );
    if (found) break;
    await page.waitForTimeout(500);
  }
  await prefillPause(page, 400);
}

/** True when listing currency is USD (handles "USD", "$", "usd"). */
function isUsdCurrency(currency: string | undefined | null): boolean {
  const c = (currency || "USD").trim().toUpperCase();
  if (c === "GEL" || c === "₾" || c.includes("LARI")) return false;
  return c === "USD" || c === "$" || c.startsWith("USD");
}

/**
 * Fill price on ss.ge step 7.
 * DOM: #create-app-price contains two <label> boxes side by side.
 *   Left  = GEL (child div text "₾")
 *   Right = USD (child div text "$")
 * Must CLICK the target label first so it gets class "active", then fill its input.
 */
async function ssgeFillPrice(
  page: Page,
  price: string,
  currency: string | undefined | null
): Promise<boolean> {
  const priceDigits = price.replace(/[^\d.]/g, "");
  if (!priceDigits) return false;

  const wantUsd = isUsdCurrency(currency);

  // Wait for price section (only present when logged in on step 7)
  const section = page.locator("#create-app-price");
  const hasSection = await section
    .waitFor({ state: "visible", timeout: 12000 })
    .then(() => true)
    .catch(() => false);

  if (!hasSection) {
    console.warn("[ss.ge prefill] #create-app-price not found");
    return false;
  }

  // Find which label index is GEL vs USD by checking direct currency symbol div
  const labelIndex = await section.evaluate((wantUsd) => {
    const root = document.getElementById("create-app-price");
    if (!root) return -1;

    const labels = [...root.querySelectorAll("label")].filter((lbl) =>
      lbl.querySelector('input[type="number"]')
    );

    if (labels.length < 2) return labels.length === 1 ? 0 : -1;

    const symOf = (lbl: Element): string | null => {
      // Symbol lives in a leaf div (not a wrapper that also contains the input value)
      for (const div of lbl.querySelectorAll("div")) {
        if (div.children.length > 0) continue;
        const t = (div.textContent || "").trim();
        if (t === "₾" || t === "$") return t;
      }
      return null;
    };

    let gelIdx = -1;
    let usdIdx = -1;
    labels.forEach((lbl, i) => {
      const sym = symOf(lbl);
      if (sym === "₾") gelIdx = i;
      if (sym === "$") usdIdx = i;
    });

    if (gelIdx >= 0 && usdIdx >= 0) {
      return wantUsd ? usdIdx : gelIdx;
    }

    // Fallback: left = GEL, right = USD (by screen position)
    const sorted = labels
      .map((lbl, i) => ({ i, left: lbl.getBoundingClientRect().left }))
      .sort((a, b) => a.left - b.left);
    return wantUsd ? sorted[sorted.length - 1].i : sorted[0].i;
  }, wantUsd);

  if (labelIndex < 0) {
    console.warn("[ss.ge prefill] price label index not found");
    return false;
  }

  const priceBoxes = section.locator('label:has(input[type="number"])');
  const boxCount = await priceBoxes.count();
  if (labelIndex >= boxCount) {
    console.warn(`[ss.ge prefill] price box index ${labelIndex} out of range (${boxCount})`);
    return false;
  }

  const targetLabel = priceBoxes.nth(labelIndex);
  await targetLabel.scrollIntoViewIfNeeded().catch(() => null);
  await targetLabel.click({ timeout: 5000 });
  await prefillPause(page, 300);

  // Wait until this box is the active currency (blue border / active class)
  await page
    .waitForFunction(
      (idx) => {
        const root = document.getElementById("create-app-price");
        if (!root) return false;
        const boxes = [...root.querySelectorAll("label")].filter((lbl) =>
          lbl.querySelector('input[type="number"]')
        );
        const box = boxes[idx] as HTMLElement | undefined;
        return !!box?.classList.contains("active");
      },
      labelIndex,
      { timeout: 5000 }
    )
    .catch(() => null);

  // "გამოჩნდეს საიტზე" under this box — sets which currency is shown on the listing
  const showOnSite = targetLabel.getByRole("button", { name: "გამოჩნდეს საიტზე" });
  if ((await showOnSite.count()) > 0) {
    await showOnSite.first().click({ timeout: 3000 }).catch(() => null);
    await prefillPause(page, 200);
  }

  const input = targetLabel.locator('input[type="number"]');
  await input.waitFor({ state: "visible", timeout: 5000 }).catch(() => null);
  await input.click({ timeout: 3000 }).catch(() => null);
  await input.fill("", { timeout: 2000 }).catch(() => null);
  await input.fill(priceDigits, { timeout: 5000 });

  // React controlled inputs sometimes ignore fill — set value + events as fallback
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

  await prefillPause(page, 200);

  console.log(
    `[ss.ge prefill] price ${priceDigits} in ${wantUsd ? "USD" : "GEL"} box (index ${labelIndex})`
  );
  return true;
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
    await prefillPause(page, 1200);
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
  _options: { listingId: string; userId: string }
): Promise<{ success: boolean; postUrl?: string; error?: string }> {
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
    page = await context.newPage();
  } else {
    if (postSession?.browser.isConnected()) {
      await postSession.context.close().catch(() => null);
      await postSession.browser.close().catch(() => null);
    }
    browser = await chromium.launch({
      headless,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--start-maximized"],
    });
    context = await browser.newContext({
      userAgent: USER_AGENT,
      locale: "ka-GE",
      viewport: null,
    });
    page = await context.newPage();
    postSession = { email: credentials.email, browser, context };
  }

  const cleanups: Array<() => Promise<void>> = [];

  try {
    if (!reuseSession) {
      await ensurePostSessionLogin(page, credentials);
    }

    // Navigate to the create-listing wizard
    await page.goto(SSGE_CREATE_URL, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    // Wait for the React SPA to render step 1
    await waitForSsgeForm(page);

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
    await prefillPause(page, 2000);

    // ---------------------------------------------------------------
    // WIZARD STEP 2 — სურათები (Images)
    // ---------------------------------------------------------------
    console.log("[ss.ge prefill] Step 2: images");
    await goToSsgeStep(page, "სურათები");

    if (listing.images?.length) {
      try {
        const { paths, cleanup } = await resolveImagesForPlaywright(
          listing.images,
          _options.listingId,
          _options.userId
        );
        cleanups.push(cleanup);
        if (paths.length) {
          const fileInput = page.locator('input[type="file"]').first();
          await fileInput.setInputFiles(paths, { timeout: 15000 }).catch(() => null);
          await prefillPause(page, 1000);
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

    if (listing.city) {
      await ssgeSelectReactOption(page, "choose-city", listing.city);
      await prefillPause(page, 600);
    }

    if (listing.street) {
      await ssgeSelectReactOption(page, "choose-street", listing.street);
      await prefillPause(page, 400);
    }

    // ---------------------------------------------------------------
    // WIZARD STEP 4 — დეტალური ინფორმაცია
    // ---------------------------------------------------------------
    console.log("[ss.ge prefill] Step 4: detailed info");
    await goToSsgeStep(page, "დეტალური ინფორმაცია");

    // Rooms (ოთახები)
    const roomsDigit = digitsOnly(listing.rooms);
    if (roomsDigit) {
      await ssgeClickNumberNear(page, roomsDigit, "ოთახები");
    }

    // Bedrooms section appears DYNAMICALLY after rooms is selected.
    // Wait for React to render it before trying to click.
    const bedroomsDigit = digitsOnly(listing.bedrooms);
    if (bedroomsDigit) {
      // Poll until "საძინებელი" label appears in the DOM (max 5s)
      await page.evaluate(() =>
        new Promise<void>((resolve) => {
          let attempts = 0;
          const poll = () => {
            for (const el of document.querySelectorAll("span")) {
              if ((el.textContent || "").includes("საძინებელი")) {
                resolve();
                return;
              }
            }
            if (++attempts < 25) setTimeout(poll, 200);
            else resolve();
          };
          poll();
        })
      );
      await prefillPause(page, 300);
      await ssgeClickNumberNear(page, bedroomsDigit, "საძინებელი");
    }

    // Area — placeholder depends on property type:
    //   ბინა → "საერთო ფართი"
    //   კერძო სახლი → "სახლის ფართი"
    if (listing.area) {
      const areaVal = digitsOnly(listing.area);
      const filled =
        (await ssgeSetInputByPlaceholder(page, "საერთო ფართი", areaVal)) ||
        (await ssgeSetInputByPlaceholder(page, "სახლის ფართი", areaVal));
      if (!filled) console.warn("[ss.ge prefill] area input not found");
    }

    // Yard area (ეზოს ფართი) — for კერძო სახლი / აგარაკი
    const yardArea = listing.rawData?.["ეზოს ფართი"]?.trim();
    if (yardArea) {
      await ssgeSetInputByPlaceholder(page, "ეზოს ფართი", digitsOnly(yardArea));
    }

    // Floor + total floors
    if (listing.floor) {
      await ssgeSetInputByPlaceholder(page, "სართული", digitsOnly(listing.floor));
    }
    if (listing.totalFloors) {
      await ssgeSetInputByPlaceholder(page, "სართულიანობა", digitsOnly(listing.totalFloors));
    }

    // Floor type subset (only duplex/triplex/loft chips)
    const rawProjectType = listing.rawData?.["პროექტის ტიპი"]?.trim() || "";
    if (
      rawProjectType &&
      PROJECT_TYPE_SUBSET.includes(rawProjectType as (typeof PROJECT_TYPE_SUBSET)[number])
    ) {
      await ssgeClickCard(page, rawProjectType);
    }

    // Balcony count (აივანი / ლოჯია)
    const balconyCount = digitsOnly(
      listing.rawData?.["აივნის რაოდენობა"] || listing.rawData?.["აივანი"] || ""
    );
    if (balconyCount) {
      await ssgeClickNumberNear(page, balconyCount, "აივანი");
    }

    // Bathrooms (სველი წერტილი)
    const bathroomsDigit = digitsOnly(
      listing.bathrooms ||
        listing.rawData?.["სვ.წერტილი"] ||
        listing.rawData?.["სველი წერტილი"] ||
        ""
    );
    if (bathroomsDigit) {
      await ssgeClickNumberNear(page, bathroomsDigit, "სველი წერტილი");
    }

    // Status (სტატუსი) — building status chips
    const buildingChip = BUILDING_STATUS_TO_SSGE[listing.buildingStatus?.trim() || ""];
    if (buildingChip) {
      await ssgeClickCard(page, buildingChip, "სტატუსი");
    }

    // Project type (პროექტი) — full list
    const projectChip = PROJECT_TYPE_TO_SSGE[rawProjectType];
    if (projectChip) {
      await ssgeClickCard(page, projectChip, "პროექტი");
    }

    // ---------------------------------------------------------------
    // WIZARD STEP 5 — დამატებითი ინფორმაცია
    // ---------------------------------------------------------------
    console.log("[ss.ge prefill] Step 5: additional info");
    await goToSsgeStep(page, "დამატებითი ინფორმაცია");

    // Condition (მდგომარეობა)
    const conditionChip = CONDITION_TO_SSGE[listing.condition?.trim() || ""];
    if (conditionChip) {
      await ssgeClickCard(page, conditionChip, "მდგომარეობა");
    }

    // View (სხვა ინფორმაცია)
    const viewValue = listing.rawData?.["ხედი"]?.trim();
    if (viewValue && VIEW_TO_SSGE[viewValue]) {
      await ssgeClickCard(page, VIEW_TO_SSGE[viewValue], "სხვა ინფორმაცია");
    }

    // ---------------------------------------------------------------
    // WIZARD STEP 6 — აღწერა (Description + Additional Info toggles)
    // ---------------------------------------------------------------
    console.log("[ss.ge prefill] Step 6: description");
    await goToSsgeStep(page, "აღწერა");

    // Additional info toggles (+) chips
    for (const toggle of ADDITIONAL_INFO_TOGGLES) {
      const hit = toggle.rawDataKeys.some((k) =>
        isTruthyRawValue(listing.rawData?.[k])
      );
      if (hit) {
        await ssgeClickCard(page, toggle.ssgeLabel, "დამატებითი ინფორმაცია");
      }
    }

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
      await ssgeFillPrice(page, listing.price, listing.currency);
    }

    console.log("[ss.ge prefill] Done — browser left open for review");
    return { success: true };
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
