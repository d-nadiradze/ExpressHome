import "@/lib/esbuild-shim";
import {
  chromium,
  type Browser,
  type BrowserContext,
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
  if (clicked) await prefillPause(page, 200);
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
  if (clicked) await prefillPause(page, 200);
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
    await prefillPause(page, 180);
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
      await prefillPause(page, 180);
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
    await prefillPause(page, 150);
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
    await prefillPause(page, 250);
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
    await chip.scrollIntoViewIfNeeded({ timeout: 8000 });
    await chip.click({ timeout: 8000, force: true });
    await prefillPause(page, 250);
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
  if (clicked) await prefillPause(page, 200);
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

  if (clicked) await prefillPause(page, 250);
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
    await prefillPause(page, 200);
    return true;
  }

  if (sectionLabel === "საძინებელი") {
    const bedInput = page.locator('input[name="bedrooms"]').first();
    if ((await bedInput.count()) > 0) {
      await bedInput.scrollIntoViewIfNeeded().catch(() => null);
      await bedInput.click({ timeout: 5000 }).catch(() => null);
      await bedInput.fill(val, { timeout: 5000 });
      await prefillPause(page, 200);
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
  await prefillPause(page, 200);
  return true;
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

  const overflowChip = `${maxChip}+`;
  console.log(
    `[ss.ge prefill] ${sectionLabel} ${num} > ${maxChip}: click "${overflowChip}" and type ${digits}`
  );

  const plusOk = await ssgeClickExactChipNear(page, overflowChip, sectionLabel);
  if (!plusOk) {
    if (sectionLabel === "საძინებელი") {
      console.log(
        `[ss.ge prefill] ${sectionLabel}: "${overflowChip}" chip not found — filling input[name="bedrooms"] directly`
      );
    } else {
      console.warn(
        `[ss.ge prefill] ${sectionLabel} overflow chip "${overflowChip}" not clicked`
      );
      return false;
    }
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
      { timeout: 8000 }
    )
    .catch(() => null);

  await prefillPause(page, 350);

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

function ssgeStreetQueries(street: string): string[] {
  const s = (street || "").replace(/\s+/g, " ").trim();
  if (!s) return [];

  const queries: string[] = [s];

  const withoutPrefix = s.replace(/^[ა-ჰ]{1,2}\.\s*/iu, "").trim();
  if (withoutPrefix && withoutPrefix !== s) {
    queries.push(withoutPrefix);
    const wpBase = withoutPrefix
      .replace(/\s+(ქ\.?|ქუჩა|შეს\.?|შესახვევი)\s*$/iu, "")
      .trim();
    if (wpBase && wpBase !== withoutPrefix) {
      queries.push(`${wpBase} ქ.`);
      queries.push(wpBase);
    }
  }

  const parenCleaned = s.replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();
  if (parenCleaned && parenCleaned !== s) {
    queries.push(parenCleaned);
  }

  queries.push(s.replace(/\s*შეს\.?/iu, " შეს. ").replace(/\s+/g, " ").trim());
  queries.push(s.replace(/\./g, " ").replace(/\s+/g, " ").trim());

  const base = s.replace(/\s+(ქ\.?|ქუჩა|შეს\.?|შესახვევი)\s*$/iu, "").trim();
  if (base) {
    queries.push(base, `${base} ქ`, `${base} ქ.`, `${base} ქუჩა`,
      `${base} შეს.`, `${base} შესახვევი`);
  }

  return [...new Set(queries)].filter(Boolean);
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
    await prefillPause(page, 100);
  }

  await control.click({ timeout: 8000 });
  await input.click({ timeout: 5000 });
  await input.fill("");
  await input.pressSequentially(target, { delay: 18 });
  await prefillPause(page, 400);

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
    for (let i = 0; i < optionCount; i++) {
      const text = (await options.nth(i).textContent())?.trim() || "";
      const score = ssgeOptionScore(target, text);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    const minScore = hiddenInputName === "choose-street" ? 120 : 80;
    if (bestScore < minScore) {
      console.warn(
        `[ss.ge prefill] react-select "${hiddenInputName}": weak match for "${target}" (score ${bestScore})`
      );
      await page.keyboard.press("Escape").catch(() => null);
      return false;
    }
    await options.nth(bestIdx).click({ timeout: 5000 });
  }

  await prefillPause(page, 200);

  const selected = await readReactSelectValue(control);
  const ok = ssgeSelectionMatches(target, selected);
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
    .waitFor({ state: "visible", timeout: 20000 })
    .catch(() => null);
  await prefillPause(page, 200);

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
        { timeout: 10000 }
      )
      .catch(() => null);
    await prefillPause(page, 400);
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
    await prefillPause(page, 150);
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
  await targetLabel.click({ timeout: 8000, force: true });
  await prefillPause(page, 350);

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
      { timeout: 10000 }
    )
    .catch(() => null);

  const showOnSite = targetLabel.getByText("გამოჩნდეს საიტზე");
  if ((await showOnSite.count()) > 0) {
    await showOnSite.first().click({ timeout: 3000 }).catch(() => null);
    await prefillPause(page, 200);
  }

  const input = targetLabel.locator('input[type="number"]');
  const hasInput = await input
    .waitFor({ state: "visible", timeout: 10000 })
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

  await prefillPause(page, 200);

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
          options.listingId,
          options.userId
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

    // Bedrooms — chips 1–9, then "9+" or input[name="bedrooms"] for 10+
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
          { timeout: 8000 }
        )
        .catch(() => null);
      await prefillPause(page, 300);
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
    await goToSsgeStep(page, "დამატებითი ინფორმაცია");

    const conditionRaw =
      listing.condition?.trim() || listing.rawData?.["მდგომარეობა"]?.trim() || "";
    const conditionChip = resolveSsgeConditionChip(conditionRaw);
    if (conditionChip) {
      await page
        .locator("span, p, label")
        .filter({ hasText: /^მდგომარეობა/ })
        .first()
        .waitFor({ state: "visible", timeout: 10000 })
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
