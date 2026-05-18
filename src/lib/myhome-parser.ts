import {
  chromium,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from "playwright";
import {
  ADDITIONAL_PARAM_LABELS,
  CHIP_ROW_PARAM_LABELS,
  FURNITURE_LABELS,
  LABEL_CANONICAL,
  PREFERENCE_PARAM_LABELS,
  PREFILL_NUMERIC_LABELS,
  RAW_DATA_HANDLED_LABELS,
} from "@/lib/additional-params";
import { resolveImagesForPlaywright } from "@/lib/listing-images";


export interface MyhomeListing {
  title: string;
  propertyType: string;
  dealType: string;
  buildingStatus: string;
  condition: string;
  city: string;
  address: string;
  street: string;
  streetNumber: string;
  cadastralCode: string;
  price: string;
  pricePerSqm: string;
  currency: string;
  area: string;
  rooms: string;
  bedrooms: string;
  floor: string;
  totalFloors: string;
  projectType: string;
  bathrooms: string;
  balconyArea: string;
  verandaArea: string;
  loggiaArea: string;
  description: string;
  images: string[];
  rawData: Record<string, string>;
}

export interface MyhomeCredentials {
  email: string;
  password: string;
}

let browserInstance: Browser | null = null;

/** Reused visible browser session so repeat pre-fills skip login (~5–15s). */
let postSession: {
  email: string;
  browser: Browser;
  context: BrowserContext;
} | null = null;

const PREFILL_PAUSE_MS = 40;
const CHIP_CLICK_TIMEOUT_MS = 1500;
const DROPDOWN_PAUSE_MS = 60;
const LUK_DROPDOWN_PAUSE_MS = 400;

async function prefillPause(page: Page, ms = PREFILL_PAUSE_MS) {
  if (ms > 0) await page.waitForTimeout(ms);
}

/** Wait until a chip label exists (form section rendered). */
async function waitForChipLabel(page: Page, label: string, timeout = 2000) {
  await page
    .waitForFunction(
      (text) => {
        for (const el of document.querySelectorAll("span, div, button, p")) {
          if (el.children.length > 0) continue;
          if (el.textContent?.trim() === text) return true;
        }
        return false;
      },
      label,
      { timeout }
    )
    .catch(() => null);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Normalize form field labels (trim, drop trailing *). */
function normFieldLabel(text: string): string {
  return (text || "").replace(/\s*\*\s*$/, "").trim().replace(/\s+/g, " ");
}

/** Luk select fields that use exact label match (no startsWith). */
const EXACT_LUK_FIELD_LABELS = new Set([
  "პროექტის ტიპი",
  "გათბობა",
  "მისაღები",
  "სათავსო",
  "სათავსოს ტიპი",
  "ხედი",
  "შესასვლელი",
]);

/** Dropdown option variants — prefer listing form (often genitive: თუხარელის). */
function projectTypeOptionVariants(value: string): string[] {
  const raw = normFieldLabel(dedupeRepeatedLabelValue(value));
  if (!raw) return [];
  const ordered: string[] = [raw];
  if (/ის$/u.test(raw)) ordered.push(raw.replace(/ის$/u, "ი"));
  else if (/ი$/u.test(raw) && !/ის$/u.test(raw)) ordered.push(`${raw}ს`);
  return [...new Set(ordered)];
}

/** Parsed rawData may use გათბობა; tolerate old typo key გათბომა. */
function getRawPreferenceValue(
  listing: MyhomeListing,
  label: string
): string {
  const rd = listing.rawData || {};
  const direct = rd[label]?.trim();
  if (direct) return direct;
  if (label === "გათბობა") return rd["გათბომა"]?.trim() || "";
  return "";
}

async function scrollToFormField(page: Page, label: string): Promise<void> {
  const exactHeadings = new Set([
    "სათავსო",
    "მისაღები",
    "აივანი",
    "ლოჯია",
    "ვერანდა",
    "ჭერის სიმაღლე",
  ]);
  const locator = exactHeadings.has(label)
    ? page
        .locator("h2, h3, h4, label, span, p, div")
        .filter({ hasText: new RegExp(`^${escapeRegExp(label)}\\s*\\*?$`, "u") })
    : page
        .locator("label, span, p, h2, h3, h4, div")
        .filter({ hasText: new RegExp(label.replace(/\./g, "\\."), "iu") });

  await locator.first().scrollIntoViewIfNeeded().catch(() => {});
  await prefillPause(page, 30);
}

/** Section heading → dropdown placeholder (…ტიპი) → option value. */
const NESTED_LUK_TYPE_SECTIONS = [
  {
    section: "მისაღები",
    dropdownHint: "მისაღების ტიპი",
    valueKeys: ["მისაღები", "მისაღების ტიპი"],
    areaKey: "მისაღების ფართი",
  },
  {
    section: "სათავსო",
    dropdownHint: "სათავსოს ტიპი",
    valueKeys: ["სათავსო", "სათავსოს ტიპი"],
    areaKey: "სათავსოს ფართი",
  },
] as const;

const NESTED_DROPDOWN_PLACEHOLDERS = new Set([
  "სათავსოს ტიპი",
  "მისაღების ტიპი",
  "აირჩიეთ",
]);

/** e.g. „სტუდიო/25 მ²“ or „საკუჭნაო/8 მ²“ → type + area. */
function parseNestedTypeAndArea(value: string): { type: string; area: string } {
  const v = value.trim();
  if (!v) return { type: "", area: "" };

  const slash = v.match(/^(.+?)\/(\d+(?:[.,]\d+)?)\s*(?:მ²|m²)?\s*$/iu);
  if (slash) {
    return {
      type: slash[1].trim(),
      area: normalizeAreaForInput(slash[2]),
    };
  }

  const spaced = v.match(/^(.+?)\s+(\d+(?:[.,]\d+)?)\s*(?:მ²|m²)\s*$/iu);
  if (spaced) {
    return {
      type: spaced[1].trim(),
      area: normalizeAreaForInput(spaced[2]),
    };
  }

  return { type: v, area: "" };
}

function getNestedSectionTypeValue(
  listing: MyhomeListing,
  valueKeys: readonly string[]
): string {
  for (const key of valueKeys) {
    const v = listing.rawData?.[key]?.trim();
    if (!v || v === "კი" || v === "არა") continue;
    const { type } = parseNestedTypeAndArea(v);
    const pick = type || v;
    if (NESTED_DROPDOWN_PLACEHOLDERS.has(pick)) continue;
    return pick;
  }
  return "";
}

/** e.g. „2/12 მ²“ → count before /, area after. */
function parseBalconyCountAndArea(value: string): { count: string; area: string } {
  const v = value.trim();
  if (!v) return { count: "", area: "" };

  const slash = v.match(/^(\d+)\s*\/\s*(\d+(?:[.,]\d+)?)\s*(?:მ²|m²)?\s*$/iu);
  if (slash) {
    return {
      count: slash[1],
      area: normalizeAreaForInput(slash[2]),
    };
  }

  if (/მ²|m²/i.test(v)) {
    return { count: "", area: normalizeAreaForInput(v) };
  }

  if (/^\d+$/.test(v)) return { count: v, area: "" };
  return { count: "", area: "" };
}

function applyBalconyParsedFields(listing: MyhomeListing): void {
  const rd = listing.rawData || {};
  const countDirect = rd["აივნის რაოდენობა"]?.trim();
  const areaDirect = rd["აივნის ფართი"]?.trim();
  const fromMain = rd["აივანი"]?.trim() || listing.balconyArea?.trim() || "";
  const { count, area } = parseBalconyCountAndArea(fromMain);

  if (countDirect) rd["აივნის რაოდენობა"] = countDirect.replace(/[^\d]/g, "") || countDirect;
  else if (count) rd["აივნის რაოდენობა"] = count;

  if (areaDirect) {
    rd["აივნის ფართი"] = normalizeAreaForInput(areaDirect);
    listing.balconyArea = rd["აივნის ფართი"];
  } else if (area) {
    rd["აივნის ფართი"] = area;
    listing.balconyArea = area;
  }
}

function getBalconyCountValue(listing: MyhomeListing): string {
  const direct = listing.rawData?.["აივნის რაოდენობა"]?.trim();
  if (direct) return direct.replace(/[^\d]/g, "") || direct;
  const { count } = parseBalconyCountAndArea(
    listing.rawData?.["აივანი"]?.trim() || listing.balconyArea || ""
  );
  return count;
}

function getBalconyAreaValue(listing: MyhomeListing): string {
  const direct = listing.rawData?.["აივნის ფართი"]?.trim();
  if (direct) return normalizeAreaForInput(direct);
  const { area } = parseBalconyCountAndArea(listing.rawData?.["აივანი"]?.trim() || "");
  if (area) return area;
  return listing.balconyArea ? normalizeAreaForInput(listing.balconyArea) : "";
}

async function prefillBalconyFields(
  page: Page,
  listing: MyhomeListing
): Promise<void> {
  const count = getBalconyCountValue(listing);
  const area = getBalconyAreaValue(listing);
  if (!count && !area) return;

  await scrollToFormField(page, "აივანი");
  await prefillPause(page, 120);

  if (count) {
    await fillInputInNestedSection(page, "აივანი", "აივნის რაოდენობა", count);
    await prefillPause(page, 80);
  }
  if (area) {
    await fillInputInNestedSection(page, "აივანი", "ფართი", area);
  }
}

/** e.g. „8 მ²“, „1/12 მ²“ → area (after / when slash present). */
function parseSectionAreaValue(value: string): string {
  const v = value.trim();
  if (!v) return "";

  const slash = v.match(/^(\d+)\s*\/\s*(\d+(?:[.,]\d+)?)\s*(?:მ²|m²)?\s*$/iu);
  if (slash) return normalizeAreaForInput(slash[2]);

  if (/მ²|m²/i.test(v)) return normalizeAreaForInput(v);

  const digits = v.match(/^(\d+(?:[.,]\d+)?)\s*$/);
  if (digits) return digits[1].replace(",", ".");
  return normalizeAreaForInput(v);
}

function applyLoggiaParsedFields(listing: MyhomeListing): void {
  const rd = listing.rawData || {};
  const areaDirect = rd["ლოჯიის ფართი"]?.trim();
  const fromMain = rd["ლოჯია"]?.trim() || listing.loggiaArea?.trim() || "";
  const parsed = parseSectionAreaValue(fromMain);

  if (areaDirect) {
    rd["ლოჯიის ფართი"] = normalizeAreaForInput(areaDirect);
    listing.loggiaArea = rd["ლოჯიის ფართი"];
  } else if (parsed) {
    rd["ლოჯიის ფართი"] = parsed;
    listing.loggiaArea = parsed;
  }
}

function getLoggiaAreaValue(listing: MyhomeListing): string {
  const direct = listing.rawData?.["ლოჯიის ფართი"]?.trim();
  if (direct) return normalizeAreaForInput(direct);
  return parseSectionAreaValue(
    listing.rawData?.["ლოჯია"]?.trim() || listing.loggiaArea || ""
  );
}

async function prefillLoggiaFields(
  page: Page,
  listing: MyhomeListing
): Promise<void> {
  const area = getLoggiaAreaValue(listing);
  if (!area) return;

  await scrollToFormField(page, "ლოჯია");
  await prefillPause(page, 120);
  await fillInputInNestedSection(page, "ლოჯია", "ფართი", area);
}

function applyVerandaParsedFields(listing: MyhomeListing): void {
  const rd = listing.rawData || {};
  const areaDirect = rd["ვერანდის ფართი"]?.trim();
  const fromMain = rd["ვერანდა"]?.trim() || listing.verandaArea?.trim() || "";
  const parsed = parseSectionAreaValue(fromMain);

  if (areaDirect) {
    rd["ვერანდის ფართი"] = normalizeAreaForInput(areaDirect);
    listing.verandaArea = rd["ვერანდის ფართი"];
  } else if (parsed) {
    rd["ვერანდის ფართი"] = parsed;
    listing.verandaArea = parsed;
  }
}

function getVerandaAreaValue(listing: MyhomeListing): string {
  const direct = listing.rawData?.["ვერანდის ფართი"]?.trim();
  if (direct) return normalizeAreaForInput(direct);
  return parseSectionAreaValue(
    listing.rawData?.["ვერანდა"]?.trim() || listing.verandaArea || ""
  );
}

async function prefillVerandaFields(
  page: Page,
  listing: MyhomeListing
): Promise<void> {
  const area = getVerandaAreaValue(listing);
  if (!area) return;

  await scrollToFormField(page, "ვერანდა");
  await prefillPause(page, 120);
  await fillInputInNestedSection(page, "ვერანდა", "ფართი", area);
}

/** e.g. „100“, „100 სმ“, „3.2 მ“ → numeric value for form (keeps cm as-is). */
function parseCeilingHeightValue(value: string): string {
  const v = value.trim();
  if (!v) return "";

  const cm = v.match(/^(\d+(?:[.,]\d+)?)\s*(?:სმ|cm)\b/iu);
  if (cm) return cm[1].replace(",", ".");

  const meters = v.match(/^(\d+(?:[.,]\d+)?)\s*(?:მ|m)\b/iu);
  if (meters) return meters[1].replace(",", ".");

  const digits = v.match(/^(\d+(?:[.,]\d+)?)\s*$/);
  if (digits) return digits[1].replace(",", ".");

  const any = v.match(/(\d+(?:[.,]\d+)?)/);
  return any ? any[1].replace(",", ".") : "";
}

function applyCeilingHeightParsedFields(listing: MyhomeListing): void {
  const rd = listing.rawData || {};
  const raw = rd["ჭერის სიმაღლე"]?.trim();
  if (!raw) return;
  const parsed = parseCeilingHeightValue(raw);
  if (parsed) rd["ჭერის სიმაღლე"] = parsed;
}

function getCeilingHeightValue(listing: MyhomeListing): string {
  const raw = listing.rawData?.["ჭერის სიმაღლე"]?.trim();
  if (!raw) return "";
  return parseCeilingHeightValue(raw);
}

const CEILING_HEIGHT_FIELD_LABEL = "ჭერის სიმაღლე";
const CEILING_HEIGHT_INPUT_HINT = "ჩაწერეთ ჭერის სიმაღლე";

/** Label above input + placeholder „ჩაწერეთ ჭერის სიმაღლე“ (create form). */
async function fillCeilingHeightField(page: Page, value: string): Promise<boolean> {
  const val = value.trim();
  if (!val) return false;

  const labelRe = /^ჭერის\s*სიმაღლე\s*\*?$/u;
  const placeholderRe = /ჩაწერეთ\s*ჭერის\s*სიმაღლე/iu;

  async function tryPlaywrightInput(input: Locator): Promise<boolean> {
    if (!(await input.isVisible({ timeout: 2500 }).catch(() => false))) return false;
    await input.scrollIntoViewIfNeeded().catch(() => {});
    await input.click({ timeout: 2000 }).catch(() => {});
    await input.fill("", { timeout: 2000 }).catch(() => {});
    await input.fill(val, { timeout: 2000 }).catch(() => {});
    const current = (await input.inputValue().catch(() => "")).trim();
    if (current === val || current.replace(",", ".") === val) return true;

    await input.click({ timeout: 2000 }).catch(() => {});
    await page.keyboard.press("Control+A").catch(() => {});
    await page.keyboard.type(val, { delay: 25 }).catch(() => {});
    const afterType = (await input.inputValue().catch(() => "")).trim();
    return afterType === val || afterType.replace(",", ".") === val;
  }

  const playwrightTargets = [
    page.getByPlaceholder(placeholderRe),
    page.locator('input[placeholder*="ჩაწერეთ"][placeholder*="ჭერის" i]'),
    page
      .locator("div, motion.div")
      .filter({ has: page.locator("span, label, p").filter({ hasText: labelRe }) })
      .locator("input")
      .first(),
    page
      .locator("div, motion.div")
      .filter({ has: page.getByText(labelRe, { exact: true }) })
      .locator("input")
      .first(),
  ];

  for (const target of playwrightTargets) {
    if (await tryPlaywrightInput(target.first())) return true;
  }

  const filled = await page.evaluate(
    ({ val, fieldLabel }) => {
      function norm(s: string) {
        return (s || "").replace(/\s*\*\s*$/, "").trim().replace(/\s+/g, " ");
      }

      const inputSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      )?.set;
      if (!inputSetter) return false;

      function setReactValue(input: HTMLInputElement, next: string): boolean {
        input.focus();
        inputSetter!.call(input, next);
        input.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            cancelable: true,
            inputType: "insertText",
            data: next,
          })
        );
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.blur();
        return (input.value || "").trim() === next;
      }

      function inputMatchesCeiling(input: HTMLInputElement): boolean {
        const ph = norm(input.placeholder || "");
        return (
          ph.includes("ჩაწერეთ") &&
          ph.includes("ჭერის") &&
          ph.includes("სიმაღლე")
        );
      }

      for (const input of document.querySelectorAll("input")) {
        const type = (input.getAttribute("type") || "text").toLowerCase();
        if (type === "hidden" || type === "checkbox" || type === "radio") continue;
        if (!inputMatchesCeiling(input)) continue;
        if (setReactValue(input, val)) return true;
      }

      for (const el of document.querySelectorAll("span, label, p")) {
        const t = norm(el.textContent || "");
        if (t !== fieldLabel) continue;
        if (el.children.length > 3) continue;

        let node: Element | null = el.parentElement;
        for (let depth = 0; depth < 12 && node; depth++) {
          for (const input of node.querySelectorAll("input")) {
            const inp = input as HTMLInputElement;
            const type = (inp.getAttribute("type") || "text").toLowerCase();
            if (type === "hidden" || type === "checkbox" || type === "radio") continue;
            if (setReactValue(inp, val)) return true;
          }
          node = node.parentElement;
        }
      }

      return false;
    },
    { val, fieldLabel: CEILING_HEIGHT_FIELD_LABEL }
  );

  return filled;
}

async function fillInputByPlaceholder(
  page: Page,
  placeholderHint: string,
  value: string
): Promise<boolean> {
  const val = value.trim();
  if (!val) return false;

  const filled = await page.evaluate(
    ({ hint, val }) => {
      function norm(s: string) {
        return (s || "").replace(/\s+/g, " ").trim();
      }
      function hintMatches(text: string) {
        const t = norm(text);
        const h = norm(hint);
        return t === h || t.includes(h) || h.includes(t);
      }

      const inputSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      )?.set;
      if (!inputSetter) return false;

      function fillInput(input: HTMLInputElement): boolean {
        inputSetter!.call(input, val);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }

      for (const input of document.querySelectorAll("input")) {
        const type = (input.getAttribute("type") || "text").toLowerCase();
        if (type === "hidden" || type === "checkbox" || type === "radio") continue;
        const ph = norm(input.placeholder || input.getAttribute("aria-placeholder") || "");
        if (ph && hintMatches(ph) && fillInput(input)) return true;
      }

      for (const lbl of document.querySelectorAll("label")) {
        const forAttr = lbl.getAttribute("for");
        const inputFromFor = forAttr
          ? (document.getElementById(forAttr) as HTMLInputElement | null)
          : null;
        const inputInLabel = lbl.querySelector("input") as HTMLInputElement | null;
        const candidates = [inputFromFor, inputInLabel].filter(Boolean) as HTMLInputElement[];

        for (const span of lbl.querySelectorAll("span")) {
          if (!hintMatches(span.textContent || "")) continue;
          for (const input of candidates) {
            if (fillInput(input)) return true;
          }
        }

        if (hintMatches(lbl.textContent || "")) {
          for (const input of candidates) {
            if (fillInput(input)) return true;
          }
        }
      }

      for (const el of document.querySelectorAll("span, p, label")) {
        if (!hintMatches(el.textContent || "")) continue;
        if ((el.textContent || "").length > 120) continue;
        let node: Element | null = el.parentElement;
        for (let depth = 0; depth < 10 && node; depth++) {
          const input = node.querySelector("input") as HTMLInputElement | null;
          if (input && fillInput(input)) return true;
          node = node.parentElement;
        }
      }

      return false;
    },
    { hint: placeholderHint, val }
  );

  if (filled) return true;

  const hintRe = new RegExp(escapeRegExp(placeholderHint).replace(/\s+/g, "\\s*"), "iu");
  const locators = [
    page.getByPlaceholder(hintRe),
    page.getByLabel(hintRe),
    page.locator('input[placeholder*="ჭერის სიმაღლე" i]'),
    page.locator('input[placeholder*="ჩაწერეთ" i]'),
  ];

  for (const locator of locators) {
    const input = locator.first();
    if (await input.isVisible({ timeout: 1200 }).catch(() => false)) {
      await input.scrollIntoViewIfNeeded().catch(() => {});
      await input.fill(val);
      return true;
    }
  }

  return false;
}

async function prefillCeilingHeightFields(
  page: Page,
  listing: MyhomeListing
): Promise<void> {
  const height = getCeilingHeightValue(listing);
  if (!height) return;

  await scrollToFormField(page, CEILING_HEIGHT_FIELD_LABEL);
  await prefillPause(page, 200);

  if (await fillCeilingHeightField(page, height)) return;

  await fillInputByPlaceholder(page, CEILING_HEIGHT_INPUT_HINT, height);
  await fillLabeledInput(page, CEILING_HEIGHT_FIELD_LABEL, height);
}

function getNestedSectionAreaValue(
  listing: MyhomeListing,
  areaKey: string,
  valueKeys: readonly string[]
): string {
  const direct = listing.rawData?.[areaKey]?.trim();
  if (direct) return normalizeAreaForInput(direct);

  for (const key of valueKeys) {
    const v = listing.rawData?.[key]?.trim();
    if (!v) continue;
    const { area } = parseNestedTypeAndArea(v);
    if (area) return area;
  }
  return "";
}

async function fillInputInNestedSection(
  page: Page,
  sectionHeading: string,
  inputLabel: string,
  value: string
): Promise<boolean> {
  const val = value.trim();
  if (!val) return false;

  const filled = await page.evaluate(
    ({ sectionHeading, inputLabel, val }) => {
      function norm(s: string) {
        return (s || "").replace(/\s*\*\s*$/, "").trim().replace(/\s+/g, " ");
      }
      function headingMatches(t: string) {
        const n = norm(t);
        if (sectionHeading === "სათავსო") return n === "სათავსო";
        if (sectionHeading === "აივანი") return n === "აივანი";
        if (sectionHeading === "ლოჯია") return n === "ლოჯია";
        if (sectionHeading === "ვერანდა") return n === "ვერანდა";
        if (sectionHeading === "ჭერის სიმაღლე") {
          return (
            n === "ჭერის სიმაღლე" ||
            (n.includes("ჭერის") && n.includes("სიმაღლე"))
          );
        }
        return n === sectionHeading;
      }

      function inputLabelMatches(t: string, target: string) {
        const n = norm(t);
        const l = norm(target);
        return n === l || n.startsWith(l);
      }

      const inputSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      )?.set;
      if (!inputSetter) return false;

      function tryFillInRoot(root: Element): boolean {
        for (const lbl of root.querySelectorAll("label")) {
          for (const span of lbl.querySelectorAll("span")) {
            if (!inputLabelMatches(span.textContent || "", inputLabel)) continue;
            const forAttr = lbl.getAttribute("for");
            const input = forAttr
              ? (document.getElementById(forAttr) as HTMLInputElement | null)
              : (lbl.querySelector("input") as HTMLInputElement | null);
            if (!input || !inputSetter) continue;
            inputSetter.call(input, val);
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
            return true;
          }
        }
        return false;
      }

      function tryFillSingleInputInRoot(root: Element): boolean {
        const inputs: HTMLInputElement[] = [];
        for (const input of root.querySelectorAll("input")) {
          const type = (input.getAttribute("type") || "text").toLowerCase();
          if (type === "hidden" || type === "checkbox" || type === "radio") continue;
          if (input.closest("[class*='luk-custom-select']")) continue;
          inputs.push(input);
        }
        if (inputs.length !== 1 || !inputSetter) return false;
        inputSetter.call(inputs[0], val);
        inputs[0].dispatchEvent(new Event("input", { bubbles: true }));
        inputs[0].dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }

      for (const el of document.querySelectorAll("h2,h3,h4,label,span,p,div,motion.div")) {
        if (!headingMatches(el.textContent || "")) continue;
        let node: Element | null = el;
        for (let depth = 0; depth < 22 && node; depth++) {
          if (tryFillInRoot(node)) return true;
          if (
            sectionHeading === "ჭერის სიმაღლე" &&
            inputLabel === "ფართი" &&
            tryFillSingleInputInRoot(node)
          ) {
            return true;
          }
          node = node.parentElement;
        }
      }
      return false;
    },
    { sectionHeading, inputLabel, val }
  );

  if (filled) return true;

  const headingPattern =
    sectionHeading === "ჭერის სიმაღლე"
      ? /^ჭერის\s*სიმაღლე\s*\*?$/u
      : nestedSectionHeadingPattern(sectionHeading);

  const section = page
    .locator("motion.div, div")
    .filter({
      has: page
        .locator("label, span, p, h2, h3, h4")
        .filter({ hasText: headingPattern }),
    })
    .filter({
      has: page
        .locator("label")
        .filter({ hasText: new RegExp(`^${escapeRegExp(inputLabel)}`, "iu") }),
    })
    .last();

  let input = section.locator("label input, input").first();
  if (!(await input.isVisible({ timeout: 800 }).catch(() => false))) {
    const sectionOnly = page
      .locator("motion.div, div")
      .filter({
        has: page
          .locator("label, span, p, h2, h3, h4")
          .filter({ hasText: headingPattern }),
      })
      .last();
    input = sectionOnly.locator("input").first();
  }
  if (await input.isVisible({ timeout: 1500 }).catch(() => false)) {
    await input.fill(val);
    return true;
  }
  return false;
}

async function markLukSelectInSection(
  page: Page,
  sectionHeading: string
): Promise<boolean> {
  return page.evaluate((heading) => {
    document
      .querySelectorAll("[data-prefill-luk-field],[data-prefill-luk-trigger]")
      .forEach((el) => {
        el.removeAttribute("data-prefill-luk-field");
        el.removeAttribute("data-prefill-luk-trigger");
        if (el.getAttribute("data-prefill-field-label") === heading) {
          el.removeAttribute("data-prefill-field-label");
        }
      });

    function norm(s: string) {
      return (s || "").replace(/\s*\*\s*$/, "").trim().replace(/\s+/g, " ");
    }
    function headingMatches(t: string) {
      const n = norm(t);
      if (heading === "სათავსო") return n === "სათავსო";
      return n === heading;
    }

    for (const el of document.querySelectorAll("h2,h3,h4,label,span,p,motion.div,div")) {
      if (!headingMatches(el.textContent || "")) continue;
      if (
        el.tagName !== "H2" &&
        el.tagName !== "H3" &&
        el.tagName !== "H4" &&
        el.children.length > 4
      ) {
        continue;
      }

      let node: Element | null = el;
      for (let depth = 0; depth < 20 && node; depth++) {
        const selects = node.querySelectorAll(
          ".luk-custom-select,[class*='luk-custom-select'],[role='combobox']"
        );
        if (selects.length > 0) {
          const sel = selects[0];
          sel.setAttribute("data-prefill-luk-field", heading);
          sel.setAttribute("data-prefill-luk-trigger", "1");
          sel.setAttribute("data-prefill-field-label", heading);
          return true;
        }
        node = node.parentElement;
      }
    }
    return false;
  }, sectionHeading);
}

function nestedSectionHeadingPattern(sectionHeading: string): RegExp {
  return new RegExp(`^${escapeRegExp(sectionHeading)}\\s*\\*?$`, "u");
}

/** Luk select for სათავსო / მისაღები blocks — placeholder is „…ტიპი“, not the section title. */
async function locateNestedSectionLukSelect(
  page: Page,
  sectionHeading: string,
  dropdownHint: string
): Promise<Locator> {
  const heading = page
    .locator("h2, h3, h4, label, span, p, div")
    .filter({ hasText: nestedSectionHeadingPattern(sectionHeading) })
    .first();

  await heading.scrollIntoViewIfNeeded().catch(() => {});

  const hintRe = new RegExp(escapeRegExp(dropdownHint), "iu");
  const hintReLoose = new RegExp(dropdownHint.replace(/\s+/g, "\\s*"), "iu");

  const inRow = heading
    .locator(
      "xpath=ancestor::*[.//*[contains(@class,'luk-custom-select') or @role='combobox']][1]"
    )
    .locator("[class*='luk-custom-select'], [role='combobox']")
    .filter({ hasText: hintReLoose })
    .first();

  if (await inRow.count()) return inRow;

  const byHint = page
    .locator("[class*='luk-custom-select'], [role='combobox']")
    .filter({ hasText: hintRe })
    .first();

  if (await byHint.count()) return byHint;

  return heading
    .locator(
      "xpath=following::*[contains(@class,'luk-custom-select') or @role='combobox'][1]"
    )
    .first();
}

async function openNestedSectionLukSelect(
  page: Page,
  select: Locator
): Promise<void> {
  await select.scrollIntoViewIfNeeded().catch(() => {});
  const openers = [
    select.locator("[class*='indicator']").first(),
    select.locator("[class*='control']").first(),
    select.locator("[class*='value-container']").first(),
    select,
  ];
  for (const opener of openers) {
    if (await opener.isVisible({ timeout: 500 }).catch(() => false)) {
      await opener.click({ timeout: CHIP_CLICK_TIMEOUT_MS, force: true });
      return;
    }
  }
  await select.click({ timeout: CHIP_CLICK_TIMEOUT_MS, force: true });
}

/** Click option inside the marked luk menu (works for portaled menus — no Y band). */
async function pickLukMenuVariants(
  page: Page,
  sectionLabel: string,
  variants: string[]
): Promise<boolean> {
  await markLukFieldMenu(page);

  const menu = page.locator("[data-prefill-luk-menu='1']");
  const menuVisible = await menu.isVisible({ timeout: 2000 }).catch(() => false);

  if (menuVisible) {
    for (const variant of variants) {
      const options = menu.locator(
        '[role="option"], [class*="option"], [class*="menu-list"] > div, li'
      );
      const count = await options.count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        const opt = options.nth(i);
        const text = ((await opt.textContent().catch(() => "")) || "").trim();
        if (!optionTextMatchesVariant(text, variant)) continue;
        await opt.scrollIntoViewIfNeeded().catch(() => {});
        await opt.dispatchEvent("mousedown");
        await opt.click({ force: true, timeout: CHIP_CLICK_TIMEOUT_MS });
        await prefillPause(page, 220);
        if (await lukFieldShowsValue(page, sectionLabel, variants)) return true;
        if (await lukSelectSelectionApplied(page, sectionLabel, variants)) return true;
        await markLukFieldMenu(page);
      }

      const exact = menu.getByText(variant, { exact: true }).first();
      if (await exact.isVisible({ timeout: 1000 }).catch(() => false)) {
        await exact.dispatchEvent("mousedown");
        await exact.click({ force: true, timeout: CHIP_CLICK_TIMEOUT_MS });
        await prefillPause(page, 220);
        if (await lukFieldShowsValue(page, sectionLabel, variants)) return true;
        if (await lukSelectSelectionApplied(page, sectionLabel, variants)) return true;
        await markLukFieldMenu(page);
      }

      if (await clickLukMenuOption(page, variant)) {
        await prefillPause(page, 220);
        if (await lukFieldShowsValue(page, sectionLabel, variants)) return true;
        if (await lukSelectSelectionApplied(page, sectionLabel, variants)) return true;
        await markLukFieldMenu(page);
      }
    }
  }

  return false;
}

async function clickLukOptionVariants(
  page: Page,
  sectionLabel: string,
  variants: string[],
  menuTopY: number,
  menuBottomY: number
): Promise<boolean> {
  if (await pickLukMenuVariants(page, sectionLabel, variants)) return true;

  if (await clickVisibleLukMenuItem(page, variants, menuTopY, menuBottomY)) {
    return true;
  }

  for (const variant of variants) {
    const inMenu = page
      .locator(
        "[class*='luk-custom-select__menu'] [class*='option'], [class*='menu-list'] > div, [role='listbox'] [role='option']"
      )
      .filter({ hasText: new RegExp(`^${escapeRegExp(variant)}$`, "u") })
      .filter({ visible: true })
      .first();
    if (await inMenu.isVisible({ timeout: 1200 }).catch(() => false)) {
      await inMenu.dispatchEvent("mousedown");
      await inMenu.click({ force: true, timeout: CHIP_CLICK_TIMEOUT_MS });
      await prefillPause(page, 280);
      if (await lukFieldShowsValue(page, sectionLabel, variants)) return true;
    }

    const byText = page.getByText(variant, { exact: true }).filter({ visible: true });
    const count = await byText.count();
    for (let i = 0; i < count; i++) {
      const opt = byText.nth(i);
      const box = await opt.boundingBox().catch(() => null);
      if (!box || box.height < 6 || box.height > 56) continue;
      if (box.y < menuTopY - 8 || box.y > menuBottomY) continue;
      await opt.dispatchEvent("mousedown");
      await opt.click({ force: true, timeout: CHIP_CLICK_TIMEOUT_MS });
      await prefillPause(page, 280);
      if (await lukFieldShowsValue(page, sectionLabel, variants)) return true;
    }
  }
  return false;
}

async function prefillNestedSectionTypeDropdown(
  page: Page,
  sectionHeading: string,
  dropdownHint: string,
  rawValue: string
): Promise<boolean> {
  const variants = dropdownOptionVariants(rawValue, sectionHeading);
  if (!variants.length) return false;

  await scrollToFormField(page, sectionHeading);
  await prefillPause(page, 120);

  if (await lukFieldShowsValue(page, sectionHeading, variants)) return true;

  await closeOpenDropdowns(page);

  const select = await locateNestedSectionLukSelect(
    page,
    sectionHeading,
    dropdownHint
  );

  if (!(await select.isVisible({ timeout: 2500 }).catch(() => false))) {
    return (
      (await prefillLukDropdownField(page, sectionHeading, rawValue)) ||
      (await prefillLukDropdownField(page, dropdownHint, rawValue))
    );
  }

  await select.evaluate(
    (el, label) => {
      el.setAttribute("data-prefill-luk-trigger", "1");
      el.setAttribute("data-prefill-luk-field", label);
      el.setAttribute("data-prefill-field-label", label);
    },
    sectionHeading
  );

  await openNestedSectionLukSelect(page, select);
  await waitForLukSelectOptions(page, 1);
  await prefillPause(page, LUK_DROPDOWN_PAUSE_MS);

  const rootBox = await select.boundingBox().catch(() => null);
  const menuTopY = rootBox ? rootBox.y + rootBox.height : 0;
  const menuBottomY = menuTopY + 480;

  if (await pickLukMenuVariants(page, sectionHeading, variants)) return true;
  if (await clickLukOptionVariants(page, sectionHeading, variants, menuTopY, menuBottomY)) {
    if (await lukFieldShowsValue(page, sectionHeading, variants)) return true;
    if (await lukSelectSelectionApplied(page, sectionHeading, variants)) return true;
  }

  if (
    (await prefillLukDropdownField(page, sectionHeading, rawValue)) ||
    (await prefillLukDropdownField(page, dropdownHint, rawValue))
  ) {
    return true;
  }

  await closeOpenDropdowns(page);
  return false;
}

async function expandCreateFormSections(page: Page): Promise<void> {
  await page
    .getByRole("button", { name: "ყველა პარამეტრი" })
    .click({ timeout: CHIP_CLICK_TIMEOUT_MS })
    .catch(() => expandAllParameterSections(page));
  await page
    .getByText(/დამატებითი პარამეტრები/i)
    .first()
    .click({ timeout: CHIP_CLICK_TIMEOUT_MS })
    .catch(() => {});
  await prefillPause(page, 120);
}

async function markLukFieldTrigger(
  page: Page,
  sectionLabel: string
): Promise<boolean> {
  return page.evaluate(
    ({ label, exactLabels }) => {
      const exactLabelSet = new Set(exactLabels);

      document.querySelectorAll("[data-prefill-luk-trigger]").forEach((el) => {
        el.removeAttribute("data-prefill-luk-trigger");
        el.removeAttribute("data-prefill-field-label");
      });

      function norm(s: string) {
        return (s || "").replace(/\s*\*\s*$/, "").trim().replace(/\s+/g, " ");
      }
      function labelMatches(text: string) {
        const t = norm(text).replace(/\s*\*$/, "");
        const l = norm(label);
        if (exactLabelSet.has(l)) return t === l;
        return t === l || t.startsWith(l);
      }

      for (const el of document.querySelectorAll(
        "label, span, p, div, motion.div, h2, h3, h4"
      )) {
        if (!labelMatches(el.textContent || "")) continue;
        let node: Element | null = el.parentElement;
        for (let depth = 0; depth < 16 && node; depth++) {
        const sel =
          node.querySelector(".luk-custom-select") ||
          node.querySelector("[class*='luk-custom-select']") ||
          node.querySelector("[class*='custom-select']") ||
          node.querySelector("[role='combobox']") ||
          node.querySelector("[aria-haspopup='listbox']");
          if (sel) {
            sel.setAttribute("data-prefill-luk-trigger", "1");
            sel.setAttribute("data-prefill-field-label", label);
            return true;
          }
          node = node.parentElement;
        }
      }
      return false;
    },
    { label: sectionLabel, exactLabels: [...EXACT_LUK_FIELD_LABELS] }
  );
}

async function lukFieldShowsValue(
  page: Page,
  sectionLabel: string,
  variants: string[]
): Promise<boolean> {
  return page.evaluate(
    ({ sectionLabel, variants: targets }) => {
      function norm(s: string) {
        return (s || "").replace(/\s+/g, " ").trim();
      }
      function exactMatch(text: string) {
        const t = norm(text);
        if (!t || /აირჩიეთ/i.test(t)) return false;
        return targets.some((target) => {
          const o = norm(target);
          return t === o || t === o.replace(/ის$/u, "ი") || t === `${o}ს`;
        });
      }

      const trigger = document.querySelector(
        `[data-prefill-field-label="${sectionLabel}"]`
      );
      if (!trigger) return false;

      const valueParts = trigger.querySelectorAll(
        "[class*='single-value'], [class*='singleValue'], [class*='value-container'] > *"
      );
      for (const el of valueParts) {
        if (exactMatch(el.textContent || "")) return true;
      }

      const control = trigger.querySelector(
        "[class*='control'], [class*='value-container']"
      );
      if (control && exactMatch(control.textContent || "")) return true;

      return exactMatch(trigger.textContent || "");
    },
    { sectionLabel, variants }
  );
}

async function markLukFieldMenu(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    document.querySelectorAll("[data-prefill-luk-menu]").forEach((el) => {
      el.removeAttribute("data-prefill-luk-menu");
    });

    const trigger = document.querySelector("[data-prefill-luk-trigger='1']");
    if (!trigger) return false;

    function markMenu(menu: Element | null): boolean {
      if (!menu) return false;
      const style = window.getComputedStyle(menu);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const r = menu.getBoundingClientRect();
      if (r.height < 20 || r.width < 40) return false;
      menu.setAttribute("data-prefill-luk-menu", "1");
      return true;
    }

    const controlsId = trigger.getAttribute("aria-controls");
    if (controlsId) {
      const linked = document.getElementById(controlsId);
      if (markMenu(linked)) return true;
    }

    const lukRoot =
      trigger.closest("[class*='luk-custom-select']")?.parentElement || trigger.parentElement;
    if (lukRoot) {
      for (const menu of lukRoot.querySelectorAll(
        '[role="listbox"], [class*="menu"], [class*="dropdown"]'
      )) {
        if (markMenu(menu)) return true;
      }
    }

    const tr = trigger.getBoundingClientRect();
    let best: Element | null = null;
    let bestScore = Infinity;
    for (const menu of document.querySelectorAll('[role="listbox"]')) {
      const style = window.getComputedStyle(menu);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const r = menu.getBoundingClientRect();
      if (r.height < 24 || r.width < 50) continue;
      if (r.top < tr.bottom - 8) continue;
      const score = r.top - tr.bottom;
      if (score >= 0 && score < bestScore) {
        bestScore = score;
        best = menu;
      }
    }
    return markMenu(best);
  });
}

function optionTextMatchesVariant(text: string, variant: string): boolean {
  const t = (text || "").replace(/\s+/g, " ").trim();
  const o = variant.replace(/\s+/g, " ").trim();
  if (!t || !o) return false;
  return t === o || t === o.replace(/ის$/u, "ი") || t === `${o}ს`;
}

async function clickLukMenuOption(page: Page, variant: string): Promise<boolean> {
  const marked = await page.evaluate((target) => {
    document.querySelectorAll("[data-prefill-luk-option]").forEach((el) => {
      el.removeAttribute("data-prefill-luk-option");
    });
    const menu = document.querySelector("[data-prefill-luk-menu='1']");
    if (!menu) return false;

    function norm(s: string) {
      return (s || "").replace(/\s+/g, " ").trim();
    }
    function matches(t: string) {
      const o = norm(target);
      return t === o || t === o.replace(/ის$/u, "ი") || t === `${o}ს`;
    }

    const candidates: { el: Element; depth: number; len: number }[] = [];
    for (const el of menu.querySelectorAll(
      '[role="option"], [class*="option"], li, div, span, p'
    )) {
      const t = norm(el.textContent || "");
      if (!matches(t)) continue;
      if (t.length > 60) continue;
      let depth = 0;
      let p: Element | null = el.parentElement;
      while (p && p !== menu) {
        depth++;
        p = p.parentElement;
      }
      candidates.push({ el, depth, len: t.length });
    }

    candidates.sort((a, b) => b.depth - a.depth || a.len - b.len);
    const pick = candidates[0]?.el;
    if (!pick) return false;

    const clickTarget =
      pick.closest("[role='option']") ||
      pick.closest('[class*="option"]') ||
      pick.closest("li") ||
      pick;
    clickTarget.setAttribute("data-prefill-luk-option", "1");
    return true;
  }, variant);

  if (!marked) return false;

  const opt = page.locator("[data-prefill-luk-option='1']").first();
  await opt.scrollIntoViewIfNeeded().catch(() => {});
  const box = await opt.boundingBox().catch(() => null);
  if (box) {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  } else {
    await opt.click({ timeout: CHIP_CLICK_TIMEOUT_MS, force: true });
  }
  return true;
}

/** Luk/custom-select on statements.myhome.ge — Playwright-only clicks, menu scoped to field. */
async function prefillLukDropdownField(
  page: Page,
  sectionLabel: string,
  optionText: string,
  placeholder?: string
): Promise<boolean> {
  const value = optionText.trim();
  if (!value) return false;

  const variants =
    sectionLabel === "პროექტის ტიპი"
      ? projectTypeOptionVariants(value)
      : dropdownOptionVariants(value, sectionLabel);

  await scrollToFormField(page, sectionLabel);

  for (let attempt = 0; attempt < 3; attempt++) {
    await closeOpenDropdowns(page);

    const marked = await markLukFieldTrigger(page, sectionLabel);
    if (marked) {
      const trigger = page.locator("[data-prefill-luk-trigger='1']").first();
      await trigger.scrollIntoViewIfNeeded().catch(() => {});
      const inner = trigger
        .locator(
          "[class*='control'], [class*='indicator'], [class*='value-container']"
        )
        .first();
      if (await inner.isVisible({ timeout: 500 }).catch(() => false)) {
        await inner.click({ timeout: CHIP_CLICK_TIMEOUT_MS, force: true });
      } else {
        await trigger.click({ timeout: CHIP_CLICK_TIMEOUT_MS, force: true });
      }
    } else {
      const label = page
        .locator("label, span, p")
        .filter({ hasText: new RegExp(`^${escapeRegExp(sectionLabel)}`, "iu") })
        .first();
      const select = label
        .locator(
          "xpath=ancestor::*[position()<=10]//*[contains(@class,'luk-custom-select') or contains(@class,'custom-select')][1]"
        )
        .first();
      await select.click({ timeout: CHIP_CLICK_TIMEOUT_MS, force: true }).catch(() => {});
    }

    await prefillPause(page, LUK_DROPDOWN_PAUSE_MS);
    await markLukFieldMenu(page);

    const menu = page.locator("[data-prefill-luk-menu='1']");
    for (const variant of variants) {
      const options = menu.locator('[role="option"], [class*="option"]');
      const count = await options.count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        const opt = options.nth(i);
        const text = ((await opt.textContent().catch(() => "")) || "").trim();
        if (!optionTextMatchesVariant(text, variant)) continue;
        await opt.scrollIntoViewIfNeeded().catch(() => {});
        await opt.click({ timeout: CHIP_CLICK_TIMEOUT_MS, force: true });
        await prefillPause(page, 120);
        if (await lukFieldShowsValue(page, sectionLabel, variants)) return true;
        await markLukFieldMenu(page);
      }

      if (await clickLukMenuOption(page, variant)) {
        await prefillPause(page, 120);
        if (await lukFieldShowsValue(page, sectionLabel, variants)) return true;
        await markLukFieldMenu(page);
      }
    }

    if (sectionLabel !== "პროექტის ტიპი") {
      const searchInput = page
        .locator("[data-prefill-luk-trigger='1'] input")
        .first();
      if (await searchInput.isVisible({ timeout: 400 }).catch(() => false)) {
        await searchInput.fill(variants[0]);
        await prefillPause(page, 200);
        const filtered = menu.locator('[role="option"], [class*="option"]').first();
        if (await filtered.isVisible({ timeout: 500 }).catch(() => false)) {
          const text = ((await filtered.textContent().catch(() => "")) || "").trim();
          if (optionTextMatchesVariant(text, variants[0])) {
            await filtered.click({ timeout: CHIP_CLICK_TIMEOUT_MS, force: true });
            if (await lukFieldShowsValue(page, sectionLabel, variants)) return true;
          }
        }
      }
    }
  }

  return false;
}

function projectTypeSearchPrefix(value: string): string {
  const v = value.trim();
  if (v.length <= 6) return v;
  return v.slice(0, 8);
}

async function projectTypeSelectionApplied(
  page: Page,
  variants: string[]
): Promise<boolean> {
  return lukSelectSelectionApplied(page, "პროექტის ტიპი", variants);
}

function dropdownOptionVariants(value: string, sectionLabel: string): string[] {
  if (sectionLabel === "პროექტის ტიპი") return projectTypeOptionVariants(value);
  const raw = normFieldLabel(dedupeRepeatedLabelValue(value));
  if (!raw) return [];

  const ordered: string[] = [raw];
  if (/ის$/u.test(raw)) ordered.push(raw.replace(/ის$/u, "ი"));
  else if (/ი$/u.test(raw) && !/ის$/u.test(raw)) ordered.push(`${raw}ს`);

  if (
    sectionLabel === "სათავსო" ||
    sectionLabel === "სათავსოს ტიპი" ||
    sectionLabel === "მისაღები"
  ) {
    if (raw === "კი") ordered.push("დიახ", "არის", "გათული");
    if (raw === "არა") ordered.push("არ არის", "არა");
    const digits = raw.match(/^(\d+)$/);
    if (digits) ordered.push(`${digits[1]} ადგილი`, `${digits[1]} ადგილის`);
    if (/საკუჭნაო/i.test(raw)) ordered.push("საკუჭნაო");
    if (/სარდაფ/i.test(raw)) ordered.push("სარდაფი");
    if (/სხვენ/i.test(raw)) ordered.push("სხვენი");
    if (/გარე\s*სათავსო/i.test(raw)) ordered.push("გარე სათავსო");
    if (/საერთო/i.test(raw)) ordered.push("საერთო სათავსო");
    if (/სტუდიო/i.test(raw)) ordered.push("სტუდიო");
    if (/გამოყოფილ/i.test(raw)) ordered.push("გამოყოფილი");
    if (/ერთიან/i.test(raw)) ordered.push("ერთიანი", "ერთ - ოთახიანი");
  }

  return [...new Set(ordered)];
}

async function lukSelectSelectionApplied(
  page: Page,
  sectionLabel: string,
  variants: string[]
): Promise<boolean> {
  if (await lukFieldShowsValue(page, sectionLabel, variants)) return true;
  return page.evaluate(
    ({ sectionLabel, targets }) => {
      function norm(s: string) {
        return (s || "").replace(/\s+/g, " ").trim();
      }
      const trigger =
        document.querySelector(`[data-prefill-luk-field="${sectionLabel}"]`) ||
        document.querySelector(`[data-prefill-field-label="${sectionLabel}"]`);
      if (!trigger) return false;
      const valueEl =
        trigger.querySelector(
          "[class*='single-value'], [class*='singleValue'], [class*='placeholder']"
        ) || trigger;
      const t = norm(valueEl.textContent || "");
      if (!t || /აირჩიეთ/i.test(t)) return false;
      return targets.some((target) => {
        const o = norm(target);
        return (
          t.includes(o) ||
          t.includes(o.replace(/ის$/u, "ი")) ||
          t.includes(`${o}ს`)
        );
      });
    },
    { sectionLabel, targets: variants }
  );
}

async function markLukSelectRoot(page: Page, sectionLabel: string): Promise<boolean> {
  return page.evaluate((label) => {
    document.querySelectorAll("[data-prefill-luk-field]").forEach((el) => {
      el.removeAttribute("data-prefill-luk-field");
    });
    document.querySelectorAll("[data-prefill-field-label]").forEach((el) => {
      if (el.getAttribute("data-prefill-luk-field")) return;
      el.removeAttribute("data-prefill-field-label");
    });

    function norm(s: string) {
      return (s || "").replace(/\s*\*\s*$/, "").trim().replace(/\s+/g, " ");
    }

    function pickSelect(select: Element, labelEl: Element): boolean {
      select.setAttribute("data-prefill-luk-field", label);
      select.setAttribute("data-prefill-field-label", label);
      return true;
    }

    function findSelectNearLabel(labelEl: Element): Element | null {
      const findIn = (root: Element): Element | null =>
        root.querySelector(".luk-custom-select") ||
        root.querySelector("[class*='luk-custom-select']") ||
        root.querySelector("[role='combobox']");

      let sib: Element | null = labelEl.nextElementSibling;
      for (let i = 0; i < 6 && sib; i++) {
        const sel =
          (sib.classList?.toString().includes("luk-custom-select") ? sib : null) ||
          findIn(sib);
        if (sel) return sel;
        sib = sib.nextElementSibling;
      }

      const parent = labelEl.parentElement;
      if (parent) {
        const kids = Array.from(parent.children);
        const idx = kids.indexOf(labelEl);
        for (let j = idx + 1; j < kids.length && j < idx + 5; j++) {
          const child = kids[j];
          const sel =
            (child.classList?.toString().includes("luk-custom-select") ? child : null) ||
            findIn(child);
          if (sel) return sel;
        }
      }

      const lr = labelEl.getBoundingClientRect();
      let best: Element | null = null;
      let bestScore = Infinity;
      let node: Element | null = labelEl.parentElement;
      for (let depth = 0; depth < 14 && node; depth++) {
        for (const sel of node.querySelectorAll(
          ".luk-custom-select, [class*='luk-custom-select'], [role='combobox']"
        )) {
          const sr = sel.getBoundingClientRect();
          if (sr.width < 40 || sr.height < 10) continue;
          const dy = Math.abs(sr.top - lr.top);
          const dx = Math.abs(sr.left - lr.left);
          if (dy > 120) continue;
          const score = dy * 3 + dx;
          if (score < bestScore) {
            bestScore = score;
            best = sel;
          }
        }
        node = node.parentElement;
      }
      return best;
    }

    for (const el of document.querySelectorAll("label, span, p")) {
      const t = norm(el.textContent || "");
      if (t !== label) continue;
      if (el.children.length > 2) continue;

      const sel = findSelectNearLabel(el);
      if (sel && pickSelect(sel, el)) return true;
    }
    return false;
  }, sectionLabel);
}

async function markProjectTypeSelectRoot(page: Page): Promise<boolean> {
  return markLukSelectRoot(page, "პროექტის ტიპი");
}

async function markLukSelectOption(page: Page, variants: string[]): Promise<boolean> {
  return page.evaluate((targets) => {
    document.querySelectorAll("[data-prefill-luk-option]").forEach((el) => {
      el.removeAttribute("data-prefill-luk-option");
    });

    function norm(s: string) {
      return (s || "").replace(/\s+/g, " ").trim();
    }
    function matches(t: string) {
      if (!t || t.length > 60) return false;
      return targets.some((target) => {
        const o = norm(target);
        return t === o || t === o.replace(/ის$/u, "ი") || t === `${o}ს`;
      });
    }

    const menus = Array.from(
      document.querySelectorAll(
        '[role="listbox"], [class*="menu"], [class*="MenuList"], [class*="menu-list"]'
      )
    ).filter((el) => {
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const r = el.getBoundingClientRect();
      return r.height > 16 && r.width > 40;
    });

    const candidates: { el: Element; depth: number }[] = [];
    for (const menu of menus) {
      for (const el of menu.querySelectorAll(
        '[role="option"], [class*="option"], div, span, li, p'
      )) {
        const t = norm(el.textContent || "");
        if (!matches(t)) continue;
        if (el.children.length > 0) {
          const onlyChildMatch =
            el.children.length === 1 &&
            matches(norm(el.children[0].textContent || ""));
          if (!onlyChildMatch && t.length > norm(variants[0]).length + 8) continue;
        }
        let depth = 0;
        let p: Element | null = el.parentElement;
        while (p && p !== menu) {
          depth++;
          p = p.parentElement;
        }
        candidates.push({ el, depth });
      }
    }

    candidates.sort((a, b) => b.depth - a.depth);
    const pick = candidates[0]?.el;
    if (!pick) return false;

    const clickTarget =
      pick.closest("[role='option']") ||
      pick.closest('[class*="option"]') ||
      pick.closest("li") ||
      pick;
    clickTarget.setAttribute("data-prefill-luk-option", "1");
    return true;
  }, variants);
}

async function markProjectTypeOption(page: Page, variants: string[]): Promise<boolean> {
  return markLukSelectOption(page, variants);
}

async function clickMarkedLukOption(page: Page): Promise<boolean> {
  const opt = page.locator("[data-prefill-luk-option='1']").first();
  if (!(await opt.isVisible({ timeout: 1500 }).catch(() => false))) return false;

  await opt.scrollIntoViewIfNeeded().catch(() => {});
  await opt.dispatchEvent("mousedown");
  const box = await opt.boundingBox().catch(() => null);
  if (box) {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  } else {
    await opt.click({ timeout: CHIP_CLICK_TIMEOUT_MS, force: true });
  }
  await opt.dispatchEvent("mouseup");
  return true;
}

async function clickMarkedProjectTypeOption(page: Page): Promise<boolean> {
  return clickMarkedLukOption(page);
}

async function waitForLukSelectOptions(page: Page, minCount = 1): Promise<void> {
  await page
    .waitForFunction(
      (min) => {
        function countOptions(root: ParentNode) {
          let n = 0;
          for (const el of root.querySelectorAll(
            '[role="option"], [class*="option"], [class*="menu-list"] > div, [class*="MenuList"] > div'
          )) {
            const t = (el.textContent || "").replace(/\s+/g, " ").trim();
            if (!t || t.length > 60) continue;
            if (/აირჩიეთ|არ\s*მოიძებნ|not\s*found|no\s*options/i.test(t)) continue;
            const r = el.getBoundingClientRect();
            if (r.height > 2 && r.width > 2) n++;
          }
          return n;
        }
        for (const lb of document.querySelectorAll(
          '[role="listbox"], [class*="menu"], [class*="MenuList"]'
        )) {
          const style = window.getComputedStyle(lb);
          if (style.display === "none" || style.visibility === "hidden") continue;
          if (countOptions(lb) >= min) return true;
        }
        return countOptions(document.body) >= min;
      },
      minCount,
      { timeout: 10000 }
    )
    .catch(() => {});
}

async function waitForProjectTypeOptions(page: Page, minCount = 1): Promise<void> {
  return waitForLukSelectOptions(page, minCount);
}

async function typeProjectTypeFilter(page: Page, text: string): Promise<void> {
  const candidates = [
    page.locator("[data-prefill-project-type-root='1'] input"),
    page.locator("[class*='luk-custom-select'] input").filter({ visible: true }),
    page.locator("[class*='menu'] input").filter({ visible: true }),
    page.locator("input:focus"),
  ];

  for (const input of candidates) {
    if (!(await input.isVisible({ timeout: 500 }).catch(() => false))) continue;
    await input.click({ force: true });
    await input.press("Control+a").catch(() => input.press("Meta+a"));
    await input.pressSequentially(text, { delay: 50 });
    return;
  }

  await page.keyboard.type(text, { delay: 50 });
}

async function selectProjectTypeOption(page: Page, variant: string): Promise<boolean> {
  for (const v of projectTypeOptionVariants(variant)) {
    const picked = await page.evaluate((optionText) => {
      function norm(s: string) {
        return (s || "").replace(/\s+/g, " ").trim();
      }
      const target = norm(optionText);
      for (const el of document.querySelectorAll(
        "[role='option'], [class*='option'], [class*='menu-list'] > div, li"
      )) {
        const t = norm(el.textContent || "");
        if (t !== target && t !== target.replace(/ის$/u, "ი") && t !== `${target}ს`) {
          continue;
        }
        const clickEl =
          el.closest("[role='option']") ||
          el.closest('[class*="option"]') ||
          el;
        (clickEl as HTMLElement).dispatchEvent(
          new MouseEvent("mousedown", { bubbles: true })
        );
        (clickEl as HTMLElement).click();
        return true;
      }
      return false;
    }, v);

    if (picked) return true;

    const exact = page
      .locator("[role='option'], [class*='option'], [class*='menu-list'] > div")
      .filter({ hasText: new RegExp(`^${escapeRegExp(v)}$`, "u") })
      .filter({ visible: true })
      .first();
    if (await exact.isVisible({ timeout: 1500 }).catch(() => false)) {
      await exact.dispatchEvent("mousedown");
      await exact.click({ timeout: CHIP_CLICK_TIMEOUT_MS, force: true });
      return true;
    }
  }
  return false;
}

async function openProjectTypeDropdown(page: Page): Promise<boolean> {
  if (!(await markProjectTypeSelectRoot(page))) return false;

  const selectRoot = page.locator("[data-prefill-project-type-root='1']").first();
  await selectRoot.scrollIntoViewIfNeeded().catch(() => {});

  const openers = [
    selectRoot.locator("[class*='indicator']").first(),
    selectRoot.locator("[class*='control']").first(),
    selectRoot.locator("[class*='value-container']").first(),
    selectRoot,
  ];

  for (const opener of openers) {
    if (await opener.isVisible({ timeout: 400 }).catch(() => false)) {
      await opener.click({ timeout: CHIP_CLICK_TIMEOUT_MS, force: true });
      await prefillPause(page, 350);
      return true;
    }
  }
  return false;
}

/** Click visible menu row (full list loads on open — no filter typing). */
async function clickVisibleLukMenuItem(
  page: Page,
  variants: string[],
  menuTopY: number,
  menuBottomY?: number
): Promise<boolean> {
  if (!variants.length) return false;
  const maxY = menuBottomY ?? menuTopY + 360;
  const matches = page.getByText(
    new RegExp(`^(${variants.map(escapeRegExp).join("|")})$`, "u"),
    { exact: true }
  );
  const count = await matches.count();

  let bestIdx = -1;
  let bestDist = Infinity;

  for (let i = 0; i < count; i++) {
    const opt = matches.nth(i);
    if (!(await opt.isVisible({ timeout: 800 }).catch(() => false))) continue;

    const box = await opt.boundingBox().catch(() => null);
    if (!box || box.height < 6 || box.height > 56) continue;
    if (box.y < menuTopY - 4 || box.y > maxY) continue;

    const dist = Math.abs(box.y - menuTopY);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }

  if (bestIdx >= 0) {
    const opt = matches.nth(bestIdx);
    await opt.scrollIntoViewIfNeeded().catch(() => {});
    await opt.dispatchEvent("mousedown");
    const box = await opt.boundingBox().catch(() => null);
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.up();
    } else {
      await opt.click({ force: true, timeout: CHIP_CLICK_TIMEOUT_MS });
    }
    await prefillPause(page, 350);
    return true;
  }

  return false;
}

async function clickVisibleProjectTypeMenuItem(
  page: Page,
  variant: string,
  menuTopY: number
): Promise<boolean> {
  return clickVisibleLukMenuItem(page, projectTypeOptionVariants(variant), menuTopY);
}

/** Luk select (პროექტის ტიპი, მისაღები, სათავსო, …) — open list, click exact option. */
async function prefillLukSelectByLabel(
  page: Page,
  sectionLabel: string,
  rawValue: string
): Promise<boolean> {
  const variants = dropdownOptionVariants(rawValue, sectionLabel);
  if (!variants.length) return false;

  await scrollToFormField(page, sectionLabel);
  await prefillPause(page, 80);

  if (await lukSelectSelectionApplied(page, sectionLabel, variants)) return true;
  if (!(await markLukSelectRoot(page, sectionLabel))) return false;

  const selectRoot = page.locator(`[data-prefill-luk-field="${sectionLabel}"]`).first();
  await selectRoot.scrollIntoViewIfNeeded().catch(() => {});
  const rootBox = await selectRoot.boundingBox().catch(() => null);
  const menuTopY = rootBox ? rootBox.y + rootBox.height : 0;
  const menuBottomY = rootBox ? menuTopY + 280 : menuTopY + 360;

  await closeOpenDropdowns(page);
  await prefillPause(page, 60);

  const opener = selectRoot
    .locator("[class*='indicator'], [class*='control'], [class*='value-container']")
    .first();
  await opener.click({ timeout: CHIP_CLICK_TIMEOUT_MS, force: true }).catch(() =>
    selectRoot.click({ timeout: CHIP_CLICK_TIMEOUT_MS, force: true })
  );

  await waitForLukSelectOptions(page, 1);
  await prefillPause(page, 250);

  if (await clickVisibleLukMenuItem(page, variants, menuTopY, menuBottomY)) {
    if (await lukSelectSelectionApplied(page, sectionLabel, variants)) return true;
  }

  for (const variant of variants) {
    if (await markLukSelectOption(page, [variant])) {
      await clickMarkedLukOption(page);
      await prefillPause(page, 300);
      if (await lukSelectSelectionApplied(page, sectionLabel, variants)) return true;
    }
  }

  for (const variant of variants) {
    const menu = page
      .locator("[class*='luk-custom-select__menu'], [class*='menu-list'], [role='listbox']")
      .last();
    const row = menu.getByText(variant, { exact: true }).first();
    if (await row.isVisible({ timeout: 1000 }).catch(() => false)) {
      await row.dispatchEvent("mousedown");
      await row.click({ force: true, timeout: CHIP_CLICK_TIMEOUT_MS });
      await prefillPause(page, 300);
      if (await lukSelectSelectionApplied(page, sectionLabel, variants)) return true;
    }
  }

  await closeOpenDropdowns(page);
  return false;
}

/** პროექტის ტიპი — open list, click exact option (e.g. თუხარელის). */
async function prefillProjectTypeField(page: Page, rawValue: string): Promise<boolean> {
  await expandCreateFormSections(page);
  return prefillLukSelectByLabel(page, "პროექტის ტიპი", rawValue);
}

/** Chip row or dropdown (გათბობა may be either on the create form). */
async function prefillPreferenceField(
  page: Page,
  sectionLabel: string,
  value: string,
  placeholder?: string
): Promise<boolean> {
  await scrollToFormField(page, sectionLabel);
  await clickChipInSection(page, sectionLabel, value);
  await prefillPause(page, 80);
  const chipOk = await page.evaluate(
    ({ sectionLabel, value }) => {
      function norm(s: string) {
        return (s || "").replace(/\s+/g, " ").trim();
      }
      for (const el of document.querySelectorAll("label, span, p, motion.div, div")) {
        if (norm(el.textContent || "") !== norm(sectionLabel)) continue;
        let node: Element | null = el.parentElement;
        for (let depth = 0; depth < 12 && node; depth++) {
          for (const chip of node.querySelectorAll(
            "motion.div, button, [role=button], [class*='rounded']"
          )) {
            const t = norm(chip.textContent || "");
            if (t !== norm(value)) continue;
            const cls = chip.className?.toString() || "";
            if (/border-green|bg-green|selected|active|checked|primary/i.test(cls)) {
              return true;
            }
            if (chip.getAttribute("aria-pressed") === "true") return true;
          }
          node = node.parentElement;
        }
      }
      return false;
    },
    { sectionLabel, value }
  );
  if (chipOk) return true;

  return prefillLukDropdownField(page, sectionLabel, value, placeholder);
}

/**
 * Playwright click on count chips (ოთახი, საძინებელი) — reliable React state vs evaluate .click().
 */
async function prefillCountChipPlaywright(
  page: Page,
  sectionLabels: string[],
  rawValue: string
): Promise<boolean> {
  const chip = normalizeCountChipValue(rawValue);
  if (!chip) return false;
  const chipRe = new RegExp(`^${escapeRegExp(chip)}\\+?$`, "u");

  for (const label of sectionLabels) {
    const labelRe = new RegExp(`^${escapeRegExp(label)}(?:\\s*\\*)?$`, "iu");
    const labelLocators = page.locator("label, span, p, div, motion.div").filter({
      hasText: labelRe,
    });
    const n = await labelLocators.count();

    for (let i = 0; i < n; i++) {
      const labelEl = labelLocators.nth(i);
      if (!(await labelEl.isVisible({ timeout: 500 }).catch(() => false))) continue;

      let scope = labelEl;
      for (let depth = 0; depth < 10; depth++) {
        const chips = scope.getByText(chipRe, { exact: true });
        const chipCount = await chips.count();
        for (let c = 0; c < chipCount; c++) {
          const chipEl = chips.nth(c);
          if (!(await chipEl.isVisible({ timeout: 300 }).catch(() => false))) continue;
          await chipEl.click({ timeout: CHIP_CLICK_TIMEOUT_MS, force: true });
          await prefillPause(page, 40);
          return true;
        }
        const parent = scope.locator("xpath=..");
        if ((await parent.count()) === 0) break;
        scope = parent;
      }
    }
  }

  return false;
}

/** Open პროექტის ტიპი luk-select and pick option (e.g. თუხარელის). */
async function selectProjectTypePlaywright(
  page: Page,
  rawValue: string
): Promise<boolean> {
  const value = dedupeRepeatedLabelValue(rawValue.trim());
  if (!value) return false;
  return prefillProjectTypeField(page, value);
}

// Click a chip inside a labeled section (სტატუსი, მდგომარეობა). Playwright click updates React state.
async function clickChipInSection(
  page: Page,
  sectionLabel: string,
  optionText: string
): Promise<void> {
  const value = optionText?.trim();
  if (!value) return;

  const marked = await page.evaluate(
    ({ sectionLabel, optionText }) => {
      function norm(s: string) {
        return s.replace(/\s*\*\s*$/, "").trim();
      }

      function chipRowIn(node: Element): Element | null {
        for (const child of Array.from(node.children)) {
          const chips = child.querySelectorAll(
            "motion.div,button,[role='button'],motion.div[class*='rounded'],div[class*='rounded'],label[class*='rounded']"
          );
          if (chips.length >= 2) return child;
        }
        return null;
      }

      function labelsMatch(text: string, label: string): boolean {
        const t = norm(text).replace(/\s+/g, " ");
        const l = norm(label);
        if (t === l || t.startsWith(l)) return true;
        if (l.includes("სვ") && l.includes("წერტილი") && t.includes("სვ") && t.includes("წერტილი")) {
          return true;
        }
        if (/^საძინებელი/i.test(l) && /^საძინებელი/i.test(t)) return true;
        if (/^ოთახ/i.test(l) && /^ოთახ/i.test(t)) return true;
        return false;
      }

      function optionMatches(text: string, option: string): boolean {
        const t = norm(text);
        const o = norm(option);
        if (t === o) return true;
        const tm = t.match(/^(\d+)\+?$/);
        const om = o.match(/^(\d+)\+?$/);
        if (tm && om && tm[1] === om[1]) return true;
        return false;
      }

      function findSectionRoot(label: string): Element | null {
        const nodes = document.querySelectorAll("label, span, p, div, h2, h3, h4");
        for (const el of nodes) {
          if (!labelsMatch(el.textContent || "", label)) continue;
          let node: Element | null = el;
          for (let depth = 0; depth < 8 && node; depth++) {
            const row = chipRowIn(node);
            if (row) return row;
            node = node.parentElement;
          }
        }
        return null;
      }

      document.querySelectorAll("[data-prefill-target]").forEach((el) => {
        el.removeAttribute("data-prefill-target");
      });

      const root = findSectionRoot(sectionLabel);
      if (!root) return false;

      const candidates = root.querySelectorAll(
        "motion.div,button,[role=button],motion.div[class*='rounded'],motion.div[class*='border'],div[class*='rounded'],label[class*='rounded'],span,motion.span,motion.p"
      );

      for (const el of candidates) {
        if (!optionMatches(el.textContent || "", optionText)) continue;
        const chip =
          el.closest("motion.div") ||
          el.closest("button") ||
          el.closest("[role='button']") ||
          el.closest("label[class*='rounded']") ||
          el.closest("[class*='cursor-pointer'], [class*='rounded']") ||
          el;
        chip.setAttribute("data-prefill-target", "1");
        return true;
      }
      return false;
    },
    { sectionLabel, optionText: value }
  );

  if (marked) {
    const clicked = await page.evaluate(() => {
      const el = document.querySelector(
        "[data-prefill-target='1']"
      ) as HTMLElement | null;
      if (!el) return false;
      el.click();
      el.removeAttribute("data-prefill-target");
      return true;
    });
    if (!clicked) {
      await page
        .locator("[data-prefill-target='1']")
        .first()
        .click({ timeout: CHIP_CLICK_TIMEOUT_MS })
        .catch(() => {});
    }
    await page.evaluate(() => {
      document.querySelectorAll("[data-prefill-target]").forEach((el) => {
        el.removeAttribute("data-prefill-target");
      });
    });
    return;
  }
}

async function clickChipInSectionLabels(
  page: Page,
  sectionLabels: string[],
  optionText: string
): Promise<void> {
  const value = optionText?.trim();
  if (!value) return;
  for (const label of sectionLabels) {
    try {
      await clickChipInSection(page, label, value);
      return;
    } catch {
      /* try next label */
    }
  }
}

/** Click a chip by label inside a parent section (e.g. სხვა პარამეტრები → ინტერნეტი). */
async function clickChipInNamedSection(
  page: Page,
  parentSectionLabel: string,
  chipLabel: string
): Promise<void> {
  const value = chipLabel.trim();
  if (!value) return;

  const marked = await page.evaluate(
    ({ parentSectionLabel, chipLabel }) => {
      function norm(s: string) {
        return s.replace(/\s*\*\s*$/, "").trim();
      }

      function isSelected(el: Element): boolean {
        const chip =
          el.closest("button") ||
          el.closest("[role='button']") ||
          el.closest("label") ||
          el;
        if (chip.getAttribute("aria-pressed") === "true") return true;
        if (chip.getAttribute("aria-checked") === "true") return true;
        const cls = chip.className?.toString() || "";
        return /active|selected|checked|bg-primary|border-primary|ring/i.test(cls);
      }

      function sectionMatches(heading: string, target: string): boolean {
        const h = norm(heading);
        const t = norm(target);
        if (!h || !t) return false;
        if (h === t) return true;
        if (h.startsWith(t) || t.startsWith(h)) return true;
        if (h.includes(t) || t.includes(h)) return true;
        return false;
      }

      function chipTextMatches(text: string, target: string): boolean {
        const t = norm(text);
        const c = norm(target);
        if (t === c) return true;
        return t.includes(c) && t.length <= c.length + 24;
      }

      let sectionHost: Element | null = null;
      for (const el of document.querySelectorAll("label, span, p, div, h2, h3, h4")) {
        const t = norm(el.textContent || "");
        if (!sectionMatches(t, parentSectionLabel)) continue;
        if (t.length > parentSectionLabel.length + 50) continue;

        let node: Element | null = el;
        for (let depth = 0; depth < 10 && node; depth++) {
          const chipCount = node.querySelectorAll(
            "button, [role='button'], label[class*='rounded'], div[class*='rounded']"
          ).length;
          if (chipCount >= 2) {
            sectionHost = node;
            break;
          }
          node = node.parentElement;
        }
        if (sectionHost) break;
      }
      if (!sectionHost) return false;

      document.querySelectorAll("[data-prefill-target]").forEach((el) => {
        el.removeAttribute("data-prefill-target");
      });

      for (const el of sectionHost.querySelectorAll(
        "button, [role='button'], label[class*='rounded'], div[class*='rounded'], span, div"
      )) {
        if (el.children.length > 5) continue;
        if (!chipTextMatches(el.textContent || "", chipLabel)) continue;
        if (isSelected(el)) return "skip";
        const chip =
          el.closest("button") ||
          el.closest("[role='button']") ||
          el.closest("label[class*='rounded']") ||
          el.closest("[class*='cursor-pointer']") ||
          el;
        chip.setAttribute("data-prefill-target", "1");
        return true;
      }
      return false;
    },
    { parentSectionLabel, chipLabel: value }
  );

  if (marked === "skip") return;
  if (marked) {
    const clicked = await page.evaluate(() => {
      const el = document.querySelector(
        "[data-prefill-target='1']"
      ) as HTMLElement | null;
      if (!el) return false;
      el.click();
      el.removeAttribute("data-prefill-target");
      return true;
    });
    if (!clicked) {
      await page
        .locator("[data-prefill-target='1']")
        .first()
        .click({ timeout: CHIP_CLICK_TIMEOUT_MS })
        .catch(() => {});
    }
    await page.evaluate(() => {
      document.querySelectorAll("[data-prefill-target]").forEach((el) => {
        el.removeAttribute("data-prefill-target");
      });
    });
  }
}

type ChipClickTask = { section: string; chip: string };

/** Known chip-row fields on create form (label row → pick one chip). */
const CHIP_STYLE_ROW_LABELS = [
  "ცხელი წყალი",
  "სამშენებლო მასალა",
  "გათბობა",
  "პარკირება",
  "კარ-ფანჯარა",
] as const;

function buildEarlyFormChipTasks(listing: MyhomeListing): ChipClickTask[] {
  const tasks: ChipClickTask[] = [];
  if (listing.propertyType) {
    tasks.push({ section: "უძრავი ქონების ტიპი", chip: listing.propertyType });
  }
  if (listing.dealType) {
    tasks.push({ section: "გარიგების ტიპი", chip: listing.dealType });
  }
  const buildingStatus =
    listing.buildingStatus || listing.rawData?.["სტატუსი"] || "";
  const condition = listing.condition || listing.rawData?.["მდგომარეობა"] || "";
  if (buildingStatus) tasks.push({ section: "სტატუსი", chip: buildingStatus });
  if (condition) tasks.push({ section: "მდგომარეობა", chip: condition });
  return tasks;
}

const CHIP_SECTION_ALIASES: Record<string, string[]> = {
  "სველი წერტილი": [
    "სვ.წერტილი",
    "სვ.წერტილები",
    "სველი წერტილი",
    "სველი წერტილები",
  ],
  "ოთახი": ["ოთახი", "ოთახები"],
  "საძინებელი": ["საძინებელი", "საძინებლები"],
};

/** myhome.ge count chips (rooms, bathrooms) are often Framer Motion divs, not buttons. */
const COUNT_CHIP_SELECTORS =
  "motion.div,button,[role=button],label[class*='rounded'],label[class*='border'],[class*='cursor-pointer'][class*='rounded'],[class*='cursor-pointer'][class*='border'],motion.div[class*='rounded']";

function getBathroomsValue(listing: MyhomeListing): string {
  return (
    listing.bathrooms ||
    listing.rawData?.["სვ.წერტილი"] ||
    listing.rawData?.["სვ.წერტილები"] ||
    listing.rawData?.["სველი წერტილი"] ||
    listing.rawData?.["სველი წერტილები"] ||
    ""
  ).trim();
}

function getBedroomsValue(listing: MyhomeListing): string {
  return (
    listing.bedrooms ||
    listing.rawData?.["საძინებელი"] ||
    listing.rawData?.["საძინებლები"] ||
    ""
  ).trim();
}

function getProjectTypeValue(listing: MyhomeListing): string {
  return dedupeRepeatedLabelValue(
    listing.projectType || listing.rawData?.["პროექტის ტიპი"] || ""
  );
}

/** Listing UI often duplicates chip text: „თუხარელისთუხარელის“ → „თუხარელის“. */
function dedupeRepeatedLabelValue(value: string): string {
  const v = value.replace(/\s+/g, " ").trim();
  if (!v) return "";
  for (let len = Math.floor(v.length / 2); len >= 3; len--) {
    if (v.slice(0, len) === v.slice(len, len * 2)) return v.slice(0, len);
  }
  return v;
}

/** Match create-form count chips (1, 2, 10+). */
function normalizeCountChipValue(value: string): string {
  const digits = value.replace(/[^\d]/g, "");
  if (!digits) return value.trim();
  const n = parseInt(digits, 10);
  if (Number.isNaN(n)) return value.trim();
  if (n >= 10) return "10+";
  return String(n);
}

function buildExpandedFormChipTasks(listing: MyhomeListing): ChipClickTask[] {
  const tasks: ChipClickTask[] = [];

  if (listing.rooms) {
    tasks.push({
      section: "ოთახი",
      chip: normalizeCountChipValue(listing.rooms),
    });
  }
  const bedrooms = getBedroomsValue(listing);
  if (bedrooms) {
    tasks.push({ section: "საძინებელი", chip: normalizeCountChipValue(bedrooms) });
  }
  const bathrooms = getBathroomsValue(listing);
  if (bathrooms) {
    tasks.push({
      section: "სველი წერტილი",
      chip: normalizeCountChipValue(bathrooms),
    });
  }

  return tasks;
}

const FURNITURE_FORM_SECTION = "ავეჯი და ტექნიკა";

function listingHasFurniture(listing: MyhomeListing): boolean {
  const rd = listing.rawData || {};
  if (rd["ავეჯი"] === "კი") return true;
  if (rd["ავეჯი"] === "არა") return false;
  return FURNITURE_LABELS.some((item) => item !== "ავეჯი" && rd[item] === "კი");
}

function ensureFurnitureRawData(rawData: Record<string, string>): void {
  if (rawData["ავეჯი"] === "არა") return;
  const anyItem = FURNITURE_LABELS.some(
    (item) => item !== "ავეჯი" && rawData[item] === "კი"
  );
  if (anyItem || rawData["ავეჯი"] === "კი") {
    rawData["ავეჯი"] = "კი";
  }
}

function buildChipPrefillTasks(listing: MyhomeListing): ChipClickTask[] {
  const tasks: ChipClickTask[] = [];

  for (const label of CHIP_STYLE_ROW_LABELS) {
    const v = getRawPreferenceValue(listing, label);
    if (v && v !== "კი" && v !== "არა") {
      tasks.push({ section: label, chip: v });
    }
  }

  for (const label of collectYesAmenityLabels(listing)) {
    tasks.push({ section: "", chip: label });
  }

  if (listingHasFurniture(listing)) {
    tasks.push({ section: FURNITURE_FORM_SECTION, chip: "ავეჯი" });
  }

  for (const item of FURNITURE_LABELS) {
    if (item === "ავეჯი") continue;
    if (listing.rawData?.[item] === "კი") {
      tasks.push({ section: FURNITURE_FORM_SECTION, chip: item });
    }
  }

  return tasks;
}

function buildAllChipPrefillTasks(listing: MyhomeListing): ChipClickTask[] {
  return [
    ...buildEarlyFormChipTasks(listing),
    ...buildExpandedFormChipTasks(listing),
    ...buildChipPrefillTasks(listing),
  ];
}

/**
 * Batch-click chips on create form (property features, building features, furniture, chip rows).
 * One DOM scan + native clicks — avoids 6×N Playwright timeouts.
 */
async function batchPrefillChips(page: Page, tasks: ChipClickTask[]): Promise<number> {
  if (tasks.length === 0) return 0;

  const batchResult = await page.evaluate(
    ({ taskList, sectionAliases, countChipSelectors }) => {
    function norm(s: string) {
      return (s || "").replace(/\s*\*\s*$/, "").trim().replace(/\s+/g, " ");
    }

    function chipTextMatches(text: string, chip: string): boolean {
      const t = norm(text);
      const c = norm(chip);
      if (t === c) return true;
      if (t.includes(c) && t.length <= c.length + 40) return true;
      const tm = t.match(/^(\d+)\+?$/);
      const cm = c.match(/^(\d+)\+?$/);
      if (tm && cm && tm[1] === cm[1]) return true;
      return false;
    }

    function labelsMatch(text: string, label: string): boolean {
      const t = norm(text);
      const l = norm(label);
      if (t === l || t.startsWith(l)) return true;
      if (l.includes("სვ") && l.includes("წერტილი") && t.includes("სვ") && t.includes("წერტილი")) {
        return true;
      }
      if (/^საძინებელი/i.test(l) && /^საძინებელი/i.test(t)) return true;
      if (/^ოთახ/i.test(l) && /^ოთახ/i.test(t)) return true;
      return false;
    }

    function findChipRowByLabel(label: string): Element | null {
      function chipRowIn(node: Element): Element | null {
        for (const child of Array.from(node.children)) {
          const chips = child.querySelectorAll(
            "motion.div,button,[role=button],div[class*='rounded'],label[class*='rounded']"
          );
          if (chips.length >= 2) return child;
        }
        return null;
      }

      for (const el of document.querySelectorAll("label,span,p,motion.div")) {
        if (!labelsMatch(el.textContent || "", label)) continue;
        let node: Element | null = el;
        for (let depth = 0; depth < 10 && node; depth++) {
          const row = chipRowIn(node);
          if (row) return row;
          node = node.parentElement;
        }
      }
      return null;
    }

    function isChipSelected(el: Element): boolean {
      const chip = (el.closest(
        "button,[role=button],label,motion.div,div"
      ) || el) as HTMLElement;
      const cls = chip.className?.toString() || "";
      if (chip.getAttribute("aria-pressed") === "true") return true;
      if (chip.getAttribute("aria-checked") === "true") return true;
      if (/border-green|bg-green|selected|active|checked/i.test(cls)) return true;
      return false;
    }

    function isInsideClickableChip(el: Element): boolean {
      return !!el.closest("button,[role=button],label[class*='rounded']");
    }

    function findSectionContainer(sectionTitle: string): Element | null {
      const target = norm(sectionTitle);
      if (!target) return null;

      for (const el of document.querySelectorAll("h2,h3,h4")) {
        const t = norm(el.textContent || "");
        if (t !== target && !t.startsWith(target)) continue;
        if (t.length > target.length + 40) continue;

        let node: Element | null = el;
        for (let depth = 0; depth < 14 && node; depth++) {
          const chips = node.querySelectorAll(
            "button,[role=button],label[class*='rounded'],[class*='border']"
          );
          if (chips.length >= 2) return node;
          node = node.parentElement;
        }
      }

      for (const el of document.querySelectorAll("label,p,span,motion.div")) {
        if (isInsideClickableChip(el)) continue;
        const t = norm(el.textContent || "");
        if (t !== target && !t.startsWith(target)) continue;
        if (t.length > target.length + 40) continue;

        let node: Element | null = el;
        for (let depth = 0; depth < 12 && node; depth++) {
          const chips = node.querySelectorAll(
            "button,[role=button],[class*='rounded'],[class*='border']"
          );
          if (chips.length >= 3) return node;
          node = node.parentElement;
        }

        let sib: Element | null = el.nextElementSibling;
        for (let i = 0; i < 4 && sib; i++) {
          if (sib.querySelectorAll("button,[role=button],[class*='rounded']").length >= 2) {
            return sib;
          }
          sib = sib.nextElementSibling;
        }
      }
      return null;
    }

    const sectionTitles = [
      "ქონების მახასიათებლები",
      "კორპუსის / კომპლექსის მახასიათებლები",
      "კორპუსის/კომპლექსის მახასიათებლები",
      "ავეჯი და ტექნიკა",
      "ავეჯი",
      "ბეჯები",
      "ცხელი წყალი",
      "სამშენებლო მასალა",
      "გათბობა",
      "პარკირება",
      "კარ-ფანჯარა",
    ];
    const amenitySections = [
      "ქონების მახასიათებლები",
      "კორპუსის / კომპლექსის მახასიათებლები",
      "კორპუსის/კომპლექსის მახასიათებლები",
      "ბეჯები",
    ];

    const containers: { title: string; el: Element }[] = [];
    for (const title of sectionTitles) {
      const el = findSectionContainer(title);
      if (el) containers.push({ title: norm(title), el });
    }

    document.querySelectorAll("[data-prefill-chip]").forEach((el) => {
      el.removeAttribute("data-prefill-chip");
    });

    const amenityRoots = amenitySections
      .map((title) => findSectionContainer(title))
      .filter((el): el is Element => !!el);

    const playwrightIds: number[] = [];
    let clicked = 0;
    let markId = 0;

    function tryClickInRoot(root: Element, chip: string): boolean {
      const c = norm(chip);
      const selectors = countChipSelectors;

      for (const el of root.querySelectorAll(selectors)) {
        if (/^H[1-6]$/i.test(el.tagName)) continue;
        if (el.querySelector("h2,h3,h4")) continue;
        const t = norm(el.textContent || "");
        if (!t) continue;
        if (!chipTextMatches(t, c)) continue;

        const target = el as HTMLElement;
        if (/^H[1-6]$/i.test(target.tagName) || target.closest("h2,h3,h4")) continue;

        if (isChipSelected(target)) {
          clicked++;
          return true;
        }

        const id = String(markId++);
        target.setAttribute("data-prefill-chip", id);
        target.click();
        if (isChipSelected(target)) {
          target.removeAttribute("data-prefill-chip");
          clicked++;
          return true;
        }
        playwrightIds.push(Number(id));
        return true;
      }
      return false;
    }

    const sortedTasks = [...taskList].sort((a, b) => {
      if (a.chip === "ავეჯი" && b.chip !== "ავეჯი") return -1;
      if (b.chip === "ავეჯი" && a.chip !== "ავეჯი") return 1;
      return 0;
    });

    for (const task of sortedTasks) {
      const section = norm(task.section);
      const chip = norm(task.chip);
      if (!chip) continue;

      if (section) {
        const sectionNames = sectionAliases[section] || [section];
        const roots: Element[] = [];
        for (const name of sectionNames) {
          const row = findChipRowByLabel(name);
          if (row) roots.push(row);
          const container = findSectionContainer(name);
          if (container) roots.push(container);
        }
        if (section.includes("ავეჯი")) {
          const f = findSectionContainer("ავეჯი და ტექნიკა");
          if (f) roots.push(f);
        }
        const fromContainers = containers.find(
          (c) => sectionNames.some((n) => c.title === n || c.title.startsWith(n))
        )?.el;
        if (fromContainers) roots.push(fromContainers);

        const uniqueRoots = [...new Set(roots)];
        for (const root of uniqueRoots) {
          if (tryClickInRoot(root, chip)) break;
        }
        continue;
      }

      for (const root of amenityRoots) {
        if (tryClickInRoot(root, chip)) break;
      }
    }

    return { clicked, playwrightIds };
  },
    {
      taskList: tasks,
      sectionAliases: CHIP_SECTION_ALIASES,
      countChipSelectors: COUNT_CHIP_SELECTORS,
    }
  );

  if (batchResult.playwrightIds.length > 0) {
    await page.evaluate((ids) => {
      for (const id of ids) {
        const el = document.querySelector(
          `[data-prefill-chip="${id}"]`
        ) as HTMLElement | null;
        el?.click();
      }
    }, batchResult.playwrightIds);
  }

  let clicked = batchResult.clicked;
  for (const id of batchResult.playwrightIds) {
    const ok = await page
      .locator(`[data-prefill-chip="${id}"]`)
      .first()
      .click({ timeout: CHIP_CLICK_TIMEOUT_MS })
      .then(() => true)
      .catch(() => false);
    if (ok) clicked++;
  }

  await page.evaluate(() => {
    document.querySelectorAll("[data-prefill-chip]").forEach((el) => {
      el.removeAttribute("data-prefill-chip");
    });
  });

  return clicked;
}

function chipValueVariants(chip: string): string[] {
  const normalized = normalizeCountChipValue(chip);
  const digits = normalized.replace(/[^\d]/g, "");
  const variants = new Set<string>([normalized, chip.trim()]);
  if (digits) {
    variants.add(digits);
    variants.add(`${digits}+`);
    if (parseInt(digits, 10) >= 10) variants.add("10+");
  }
  return [...variants].filter(Boolean);
}

/**
 * Click numeric count chips (ოთახი, სველი წერტილი) — uses motion.div leaf nodes like the original fillForm.
 */
async function prefillRowCountChip(
  page: Page,
  sectionLabels: string[],
  rawValue: string
): Promise<boolean> {
  const chip = normalizeCountChipValue(rawValue);
  if (!chip) return false;

  if (await prefillCountChipPlaywright(page, sectionLabels, rawValue)) {
    return true;
  }

  const marked = await page.evaluate(
    ({ sectionLabels, variants }) => {
      function norm(s: string) {
        return (s || "").replace(/\s*\*\s*$/, "").trim().replace(/\s+/g, " ");
      }

      function labelsMatch(text: string, label: string): boolean {
        const t = norm(text);
        const l = norm(label);
        if (!t || t.length > 45) return false;
        if (t === l) return true;
        if (t.includes("სვ") && t.includes("წერტილი")) return true;
        if (l.includes("სვ") && l.includes("წერტილი") && t.includes("სვ")) return true;
        if (/^საძინებელი/i.test(l) && /^საძინებელი/i.test(t)) return true;
        return false;
      }

      function tryGluedCount(parent: Element | null, prefixRe: RegExp): boolean {
        if (!parent) return false;
        const joined = (parent.textContent || "").replace(/\s+/g, "");
        const glued = joined.match(prefixRe);
        if (!glued) return false;
        const digit = glued[1];
        if (!variants.some((v) => v === digit || v.replace(/\+$/, "") === digit)) {
          return false;
        }
        for (const el of parent.querySelectorAll(
          "span,motion.div,div,button,p,label,motion.span"
        )) {
          if (el.children.length > 0) continue;
          const t = norm(el.textContent || "");
          if (t === digit || t === `${digit}+` || variants.includes(t)) {
            const target = (el.closest("[class*='rounded']") ||
              el.closest("button,[role=button]") ||
              el.closest("[class*='cursor-pointer']") ||
              el) as HTMLElement;
            document.querySelectorAll("[data-prefill-count-chip]").forEach((n) => {
              n.removeAttribute("data-prefill-count-chip");
            });
            target.setAttribute("data-prefill-count-chip", "1");
            return true;
          }
        }
        return false;
      }

      function findCountRowForLabels(): Element | null {
        for (const el of document.querySelectorAll("label,span,p,motion.div")) {
          if (!sectionLabels.some((label) => labelsMatch(el.textContent || "", label))) {
            continue;
          }
          let node: Element | null = el;
          for (let depth = 0; depth < 14 && node; depth++) {
            if (countDigitLeaves(node) >= 2) return node;
            node = node.parentElement;
          }
        }
        return null;
      }

      function countDigitLeaves(node: Element): number {
        let n = 0;
        node.querySelectorAll("span,motion.div,div,button,p,label").forEach((el) => {
          if (el.children.length > 0) return;
          if (/^\d+\+?$/.test(norm(el.textContent || ""))) n++;
        });
        return n;
      }

      function matchesVariant(text: string): boolean {
        const t = norm(text);
        return variants.some((v) => {
          const c = norm(v);
          if (t === c) return true;
          const tm = t.match(/^(\d+)\+?$/);
          const cm = c.match(/^(\d+)\+?$/);
          return !!(tm && cm && tm[1] === cm[1]);
        });
      }

      function markLeafChip(root: Element): boolean {
        for (const el of root.querySelectorAll(
          "span,motion.div,motion.span,motion.p,div,button,p,label,[class*='cursor-pointer']"
        )) {
          if (el.children.length > 0) continue;
          if (!matchesVariant(el.textContent || "")) continue;

          const target = (el.closest("[class*='rounded']") ||
            el.closest("button,[role=button]") ||
            el.parentElement ||
            el) as HTMLElement;

          document.querySelectorAll("[data-prefill-count-chip]").forEach((n) => {
            n.removeAttribute("data-prefill-count-chip");
          });
          target.setAttribute("data-prefill-count-chip", "1");
          return true;
        }
        return false;
      }

      for (const el of document.querySelectorAll("label,span,p,motion.div")) {
        if (!sectionLabels.some((label) => labelsMatch(el.textContent || "", label))) {
          continue;
        }
        const parent = el.parentElement;
        if (sectionLabels.some((l) => /^საძინებელი/i.test(l))) {
          if (tryGluedCount(parent, /^საძინებელი(\d+)$/iu)) return true;
        }
        if (sectionLabels.some((l) => l.includes("სვ"))) {
          if (tryGluedCount(parent, /^სვ[.\s]*წერტილი(?:ები)?(\d+)$/iu)) {
            return true;
          }
        }
      }

      const countRow = findCountRowForLabels();
      if (countRow && markLeafChip(countRow)) return true;

      for (const el of document.querySelectorAll("label,span,p,motion.div")) {
        if (!sectionLabels.some((label) => labelsMatch(el.textContent || "", label))) {
          continue;
        }
        let sib: Element | null = el.nextElementSibling;
        for (let i = 0; i < 6 && sib; i++) {
          if (countDigitLeaves(sib) >= 2 && markLeafChip(sib)) return true;
          sib = sib.nextElementSibling;
        }
      }

      return false;
    },
    { sectionLabels, variants: chipValueVariants(chip) }
  );

  if (marked) {
    await page
      .locator("[data-prefill-count-chip='1']")
      .first()
      .click({ timeout: CHIP_CLICK_TIMEOUT_MS, force: true })
      .catch(() => {});
    await page.evaluate(() => {
      document.querySelectorAll("[data-prefill-count-chip]").forEach((el) => {
        el.removeAttribute("data-prefill-count-chip");
      });
    });
    return true;
  }

  const isBedroomSection = sectionLabels.some((l) => /^საძინებელი/i.test(l));
  const excludeInLocator = isBedroomSection
    ? /ოთახი|ფართი|სართული/i
    : /ოთახი|საძინებელი|ფართი|სართული/i;

  for (const label of sectionLabels) {
    const labelRe = new RegExp(label.replace(/\./g, "\\."), "iu");
    const row = page
      .locator("label, div, span, p")
      .filter({ hasText: labelRe })
      .filter({ hasNotText: excludeInLocator })
      .first();
    if (!(await row.isVisible({ timeout: 600 }).catch(() => false))) continue;

    const chipLoc = row
      .locator("xpath=ancestor::*[1]")
      .locator("xpath=..")
      .getByText(new RegExp(`^${escapeRegExp(chip)}\\+?$`, "u"), { exact: true })
      .first();
    if (await chipLoc.isVisible({ timeout: 600 }).catch(() => false)) {
      await chipLoc.click({ timeout: CHIP_CLICK_TIMEOUT_MS, force: true });
      return true;
    }
  }

  return false;
}

async function prefillMainCountChips(
  page: Page,
  listing: MyhomeListing
): Promise<void> {
  await page
    .waitForFunction(
      () => {
        const body = document.body?.innerText || "";
        return body.includes("ოთახი") || body.includes("სვ");
      },
      { timeout: 8000 }
    )
    .catch(() => {});

  if (listing.rooms) {
    await prefillRowCountChip(page, CHIP_SECTION_ALIASES["ოთახი"], listing.rooms);
  }

  const bedrooms = getBedroomsValue(listing);
  if (bedrooms) {
    const bedroomChip = normalizeCountChipValue(bedrooms);
    let bedroomClicked = await prefillCountChipPlaywright(
      page,
      CHIP_SECTION_ALIASES["საძინებელი"],
      bedrooms
    );
    if (!bedroomClicked) {
      bedroomClicked = await prefillRowCountChip(
        page,
        CHIP_SECTION_ALIASES["საძინებელი"],
        bedrooms
      );
    }
    if (!bedroomClicked) {
      await clickChipInSectionLabels(
        page,
        CHIP_SECTION_ALIASES["საძინებელი"],
        bedroomChip
      );
    }
    if (!bedroomClicked) {
      await batchPrefillChips(page, [{ section: "საძინებელი", chip: bedroomChip }]);
    }
  }

  const bathrooms = getBathroomsValue(listing);
  if (bathrooms) {
    let clicked = await prefillRowCountChip(
      page,
      CHIP_SECTION_ALIASES["სველი წერტილი"],
      bathrooms
    );
    if (!clicked) {
      await clickChipInSectionLabels(
        page,
        CHIP_SECTION_ALIASES["სველი წერტილი"],
        normalizeCountChipValue(bathrooms)
      );
    }
    for (const label of CHIP_SECTION_ALIASES["სველი წერტილი"]) {
      await fillLabeledInput(page, label, normalizeNumericParam(bathrooms));
    }
  }
}

/** Dedicated pass for the general „ავეჯი“ toggle (easy to miss in batch). */
async function prefillGeneralFurnitureChip(page: Page): Promise<void> {
  const result = await page.evaluate(() => {
    function norm(s: string) {
      return (s || "").replace(/\s*\*\s*$/, "").trim().replace(/\s+/g, " ");
    }

    function isChipSelected(el: HTMLElement): boolean {
      const cls = el.className?.toString() || "";
      if (el.getAttribute("aria-pressed") === "true") return true;
      if (el.getAttribute("aria-checked") === "true") return true;
      if (/border-green|bg-green|selected|active|checked/i.test(cls)) return true;
      return false;
    }

    function findFurnitureRoot(): Element | null {
      for (const title of ["ავეჯი და ტექნიკა", "ავეჯი"]) {
        for (const el of document.querySelectorAll("h2,h3,h4,label,span,p")) {
          const t = norm(el.textContent || "");
          if (t !== title && !t.startsWith(title)) continue;
          if (el.closest("button,[role=button]")) continue;
          let node: Element | null = el;
          for (let depth = 0; depth < 14 && node; depth++) {
            const chips = node.querySelectorAll(
              "button,[role=button],label[class*='rounded']"
            );
            if (chips.length >= 3) return node;
            node = node.parentElement;
          }
        }
      }
      return null;
    }

    const root = findFurnitureRoot();
    if (!root) return { ok: false as const };

    for (const el of root.querySelectorAll(
      "button,[role=button],label[class*='rounded'],label[class*='border'],[class*='cursor-pointer']"
    )) {
      const t = norm(el.textContent || "");
      if (t !== "ავეჯი") continue;
      const target = el as HTMLElement;
      if (isChipSelected(target)) return { ok: true as const };
      target.click();
      if (isChipSelected(target)) return { ok: true as const };
      target.setAttribute("data-prefill-avzaji", "1");
      return { ok: false as const, needsPw: true as const };
    }

    return { ok: false as const };
  });

  if (result.ok) return;
  if ("needsPw" in result && result.needsPw) {
    await page
      .locator("[data-prefill-avzaji]")
      .first()
      .click({ timeout: CHIP_CLICK_TIMEOUT_MS })
      .catch(() => {});
    await page.evaluate(() => {
      document
        .querySelector("[data-prefill-avzaji]")
        ?.removeAttribute("data-prefill-avzaji");
    });
  }
}

const FURNITURE_LABEL_SET = new Set<string>(FURNITURE_LABELS);
const CHIP_ROW_LABEL_SET = new Set<string>(CHIP_ROW_PARAM_LABELS);

function shouldSkipYesChipPrefill(label: string): boolean {
  if (RAW_DATA_HANDLED_LABELS.has(label)) return true;
  if (PREFILL_NUMERIC_LABELS.has(label)) return true;
  if (PREFILL_LIST_FIELDS.some((f) => f.labels.includes(label))) return true;
  if (FURNITURE_LABEL_SET.has(label)) return true;
  if (CHIP_ROW_LABEL_SET.has(label)) return true;
  return false;
}

function collectYesAmenityLabels(listing: MyhomeListing): string[] {
  const labels: string[] = [];
  const seen = new Set<string>();

  for (const [label, raw] of Object.entries(listing.rawData || {})) {
    if (raw?.trim() !== "კი") continue;
    if (shouldSkipYesChipPrefill(label)) continue;
    const canon = LABEL_CANONICAL[label] || label;
    if (seen.has(canon)) continue;
    seen.add(canon);
    labels.push(canon);
  }

  return labels;
}

const CHIP_STYLE_SET = new Set<string>(CHIP_STYLE_ROW_LABELS);

async function expandAllParameterSections(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const el of document.querySelectorAll("button, a, span")) {
      const t = el.textContent?.trim() || "";
      if (t === "მეტის ნახვა" || t === "ყველა პარამეტრი") {
        (el as HTMLElement).click();
      }
    }
  });
}

async function fillInputByLabelEvaluate(
  page: Page,
  label: string,
  value: string
): Promise<void> {
  await page.evaluate(
    ({ labelText, val }) => {
      function norm(s: string) {
        return (s || "").replace(/\s*\*\s*$/, "").trim().replace(/\s+/g, " ");
      }

      const inputSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      )?.set;
      if (!inputSetter) return;

      function fillInput(input: HTMLInputElement): boolean {
        input.focus();
        inputSetter!.call(input, val);
        input.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            cancelable: true,
            inputType: "insertText",
            data: val,
          })
        );
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.blur();
        return true;
      }

      for (const lbl of document.querySelectorAll("label")) {
        for (const span of lbl.querySelectorAll("span")) {
          if (norm(span.textContent || "") !== norm(labelText)) continue;
          const forAttr = lbl.getAttribute("for");
          const input = forAttr
            ? (document.getElementById(forAttr) as HTMLInputElement | null)
            : (lbl.querySelector("input") as HTMLInputElement | null);
          if (input && fillInput(input)) return;
        }
      }

      for (const el of document.querySelectorAll("span, label, p")) {
        if (norm(el.textContent || "") !== norm(labelText)) continue;
        if (el.children.length > 3) continue;
        let node: Element | null = el.parentElement;
        for (let depth = 0; depth < 12 && node; depth++) {
          const input = node.querySelector("input") as HTMLInputElement | null;
          if (input && fillInput(input)) return;
          node = node.parentElement;
        }
      }
    },
    { labelText: label, val: value.trim() }
  );
}

async function fillLabeledInput(page: Page, label: string, value: string): Promise<void> {
  if (!value?.trim()) return;
  await fillInputByLabelEvaluate(page, label, value.trim());
}

async function selectAutocompleteOption(page: Page, value: string): Promise<void> {
  if (!value?.trim()) return;
  const text = value.trim();
  await prefillPause(page, 80);

  const picked = await page.evaluate((optionText) => {
    function norm(s: string) {
      return s.replace(/\s+/g, " ").trim();
    }
    const target = norm(optionText);
    for (const el of document.querySelectorAll(
      "[role='option'], [class*='option'], li, [class*='menu-item']"
    )) {
      const t = norm(el.textContent || "");
      if (t !== target && !t.includes(target)) continue;
      (el as HTMLElement).click();
      return true;
    }
    return false;
  }, text);

  if (picked) return;

  const options = page.locator(
    "[role='option'], [class*='option'], li, [class*='menu-item']"
  );
  const exact = options
    .filter({ hasText: new RegExp(`^${escapeRegExp(text)}$`, "u") })
    .first();
  if (await exact.isVisible({ timeout: 800 }).catch(() => false)) {
    await exact.click({ timeout: CHIP_CLICK_TIMEOUT_MS });
    return;
  }
  const partial = options.filter({ hasText: text }).first();
  if (await partial.isVisible({ timeout: 800 }).catch(() => false)) {
    await partial.click({ timeout: CHIP_CLICK_TIMEOUT_MS });
  }
}

async function fillLocationFields(
  page: Page,
  listing: Pick<MyhomeListing, "city" | "street" | "streetNumber" | "cadastralCode">
): Promise<void> {
  const city = listing.city?.trim() || "";
  const street = listing.street?.trim() || "";
  const streetNumber = listing.streetNumber?.trim() || "";
  const cadastralCode = listing.cadastralCode?.trim() || "";

  await page.evaluate(() => {
    for (const el of document.querySelectorAll("span, label, h2, h3")) {
      const t = el.textContent?.trim() || "";
      if (t === "მდებარეობა" || t === "ქუჩა" || t.includes("მისამართ")) {
        el.scrollIntoView({ block: "center", behavior: "instant" });
        break;
      }
    }
  });
  if (city) {
    await fillLabeledInput(page, "მდებარეობა", city);
    await selectAutocompleteOption(page, city);
  }

  if (street) {
    await fillLabeledInput(page, "ქუჩა", street);
    await selectAutocompleteOption(page, street);
  }

  if (streetNumber) {
    await fillLabeledInput(page, "ქუჩის ნომერი", streetNumber);
  }

  if (cadastralCode) {
    await fillLabeledInput(page, "საკადასტრო კოდი", cadastralCode);
  }
}

async function closeOpenDropdowns(page: Page): Promise<void> {
  const openCount = await page
    .locator(
      '[role="listbox"]:visible, [class*="luk-custom-select"][class*="open"], [class*="luk-custom-select--open"], [data-prefill-dropdown-open="1"]'
    )
    .count();
  if (openCount === 0) return;

  await page.keyboard.press("Escape").catch(() => {});
  await page.keyboard.press("Escape").catch(() => {});

  const stillOpen = await page
    .locator('[role="listbox"]:visible, [data-prefill-dropdown-open="1"]')
    .count();
  if (stillOpen > 0) {
    await page
      .locator("h1, h2, h3, form, main")
      .first()
      .click({ position: { x: 8, y: 8 }, force: true })
      .catch(() => page.mouse.click(12, 12));
  }

  await page.evaluate(() => {
    document.querySelectorAll("[data-prefill-dropdown-open]").forEach((el) => {
      el.removeAttribute("data-prefill-dropdown-open");
    });
  });

  await page
    .locator('[role="listbox"]:visible, [data-prefill-dropdown-open="1"]')
    .first()
    .waitFor({ state: "hidden", timeout: 1200 })
    .catch(() => {});
  await prefillPause(page, 40);
}

/** Click an option in myhome.ge luk-custom-select or ARIA listbox menus. */
async function clickOpenDropdownOption(
  page: Page,
  value: string,
  matchVariants?: string[]
): Promise<boolean> {
  const variants = matchVariants?.length ? matchVariants : [value];
  const clicked = await page.evaluate((targets) => {
    function norm(s: string) {
      return s.replace(/\s*\*\s*$/, "").trim();
    }

    function matchesTarget(t: string): boolean {
      return targets.some(
        (target) =>
          t === target ||
          t.includes(target) ||
          target.includes(t) ||
          t.replace(/ის$/u, "ი") === target ||
          target.replace(/ის$/u, "ი") === t
      );
    }

    function isVisible(el: Element): boolean {
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const r = el.getBoundingClientRect();
      return r.width > 2 && r.height > 2;
    }

    function tryClick(el: Element): boolean {
      if (!isVisible(el)) return false;
      (el as HTMLElement).click();
      return true;
    }

    const roots: Element[] = [];
    document
      .querySelectorAll(
        '[data-prefill-dropdown-open="1"], [role="listbox"], [class*="luk-custom-select"][class*="open"], [class*="luk-custom-select--open"], [class*="luk-select"], [class*="dropdown-menu"], [class*="select-dropdown"]'
      )
      .forEach((el) => {
        if (isVisible(el)) roots.push(el);
      });

    document.querySelectorAll("body > div, body > ul").forEach((el) => {
      const style = window.getComputedStyle(el);
      if (style.display === "none") return;
      const z = parseInt(style.zIndex || "0", 10);
      if (z < 100 && style.position !== "fixed") return;
      const r = el.getBoundingClientRect();
      if (r.height < 24 || r.width < 40) return;
      const t = el.textContent || "";
      const minLen = Math.min(...targets.map((target) => target.length));
      if (t.length > 400 || t.length < minLen) return;
      if (!targets.some((target) => t.includes(target))) return;
      const itemCount = el.querySelectorAll("li, [class*='item'], [role='option']").length;
      if (itemCount < 1) return;
      roots.push(el);
    });

    const tryInRoot = (root: Element): boolean => {
      for (const el of root.querySelectorAll("li, div, span, button, a, p")) {
        if (el.children.length > 4) continue;
        const t = norm(el.textContent || "");
        if (!matchesTarget(t) || t.length > 80) continue;
        if (tryClick(el)) return true;
      }
      return false;
    };

    for (const root of roots) {
      if (tryInRoot(root)) return true;
    }
    return false;
  }, variants);

  if (clicked) return true;

  const optionLoc = page.locator(
    "[role='listbox'] [role='option'], [role='option'], [class*='option'], [class*='menu-item'], [class*='luk-custom-select'] li, [class*='luk-custom-select'] div"
  );

  for (const variant of variants) {
    const exact = optionLoc
      .filter({ hasText: new RegExp(`^${escapeRegExp(variant)}$`, "u") })
      .filter({ visible: true })
      .first();
    if (await exact.isVisible({ timeout: 800 }).catch(() => false)) {
      await exact.click({ timeout: CHIP_CLICK_TIMEOUT_MS });
      return true;
    }

    const partial = optionLoc.filter({ hasText: variant }).filter({ visible: true }).first();
    if (await partial.isVisible({ timeout: 800 }).catch(() => false)) {
      await partial.click({ timeout: CHIP_CLICK_TIMEOUT_MS });
      return true;
    }

    const byText = page.getByText(variant, { exact: true }).filter({ visible: true }).last();
    if (await byText.isVisible({ timeout: 800 }).catch(() => false)) {
      await byText.click();
      return true;
    }
  }

  return false;
}

async function listFieldAlreadySet(
  page: Page,
  sectionLabel: string,
  value: string
): Promise<boolean> {
  return page.evaluate(
    ({ sectionLabel, value }) => {
      function norm(s: string) {
        return s.replace(/\s*\*\s*$/, "").trim();
      }

      function findFieldContainer(label: string): Element | null {
        const nodes = document.querySelectorAll("label, span, p, div, h2, h3, h4");
        for (const el of nodes) {
          const t = norm(el.textContent || "").replace(/\s+/g, " ");
          if (t !== label && !t.startsWith(label)) continue;
          let node: Element | null = el;
          for (let depth = 0; depth < 10 && node; depth++) {
            if (
              node.querySelector(
                ".luk-custom-select, [role='combobox'], select, [aria-haspopup='listbox']"
              )
            ) {
              return node;
            }
            node = node.parentElement;
          }
        }
        return null;
      }

      const root = findFieldContainer(sectionLabel);
      if (!root) return false;

      const custom =
        root.querySelector(".luk-custom-select") ||
        root.querySelector("[role='combobox']");
      if (custom && norm(custom.textContent || "").includes(value)) return true;

      const sel = root.querySelector("select") as HTMLSelectElement | null;
      const selected = sel?.selectedOptions?.[0]?.textContent?.trim() || "";
      return selected.includes(value);
    },
    { sectionLabel, value }
  );
}

async function selectListOptionInSection(
  page: Page,
  sectionLabel: string,
  optionText: string,
  placeholder?: string,
  options?: { closeDropdowns?: boolean }
): Promise<void> {
  const value = optionText.trim();
  if (!value) return;
  const closeDropdowns = options?.closeDropdowns !== false;
  if (closeDropdowns) await closeOpenDropdowns(page);
  if (await listFieldAlreadySet(page, sectionLabel, value)) return;
  const ok =
    (await prefillLukSelectByLabel(page, sectionLabel, value)) ||
    (await prefillLukDropdownField(page, sectionLabel, value, placeholder));
  if (!ok) throw new Error(`Could not select "${value}" for ${sectionLabel}`);
  if (closeDropdowns) await closeOpenDropdowns(page);
}

function listingLocation(listing: MyhomeListing) {
  return {
    city: listing.city || listing.rawData?.["მდებარეობა"] || "",
    street: listing.street || listing.rawData?.["ქუჩა"] || "",
    streetNumber: listing.streetNumber || listing.rawData?.["ქუჩის ნომერი"] || "",
    cadastralCode: listing.cadastralCode || listing.rawData?.["საკადასტრო კოდი"] || "",
  };
}

const PREFILL_NUMERIC_FIELDS: {
  labels: string[];
  getValue: (l: MyhomeListing) => string;
}[] = [
  {
    labels: ["სვ.წერტილი", "სვ.წერტილები", "სველი წერტილი", "სველი წერტილები"],
    getValue: (l) => getBathroomsValue(l),
  },
  { labels: ["აშენების წელი"], getValue: (l) => l.rawData?.["აშენების წელი"] || "" },
];

const PREFILL_LIST_FIELDS: {
  labels: string[];
  getValue: (l: MyhomeListing) => string;
  placeholder?: string;
}[] = [
  {
    labels: ["მისაღები"],
    getValue: (l) => getNestedSectionTypeValue(l, ["მისაღები", "მისაღების ტიპი"]),
  },
  {
    labels: ["სათავსო"],
    getValue: (l) => getNestedSectionTypeValue(l, ["სათავსო", "სათავსოს ტიპი"]),
  },
  {
    labels: ["სათავსოს ტიპი"],
    getValue: (l) => getNestedSectionTypeValue(l, ["სათავსო", "სათავსოს ტიპი"]),
  },
  { labels: ["ხედი"], getValue: (l) => l.rawData?.["ხედი"] || "" },
  { labels: ["შესასვლელი"], getValue: (l) => l.rawData?.["შესასვლელი"] || "" },
];

function normalizeAreaForInput(value: string): string {
  const m = value.match(/(\d+(?:[.,]\d+)?)/);
  return m ? m[1].replace(",", ".") : value.replace(/[^\d.,]/g, "");
}

function normalizeNumericParam(value: string): string {
  const trimmed = value.trim();
  if (/მ²|m²/i.test(trimmed)) return normalizeAreaForInput(trimmed);
  const slash = trimmed.match(/^(\d+)\s*\/\s*[\d.,]+/);
  if (slash) return slash[1];
  const digits = trimmed.match(/(\d+(?:[.,]\d+)?|>\s*\d+)/);
  return digits ? digits[1].replace(/\s+/g, "") : trimmed.replace(/[^\d.>/]/g, "");
}

function buildPostExpandChipTasks(listing: MyhomeListing): ChipClickTask[] {
  return [...buildExpandedFormChipTasks(listing), ...buildChipPrefillTasks(listing)];
}

async function applyAdditionalParametersPrefill(
  page: Page,
  listing: MyhomeListing
): Promise<void> {
  await expandCreateFormSections(page);
  await page
    .locator("h2,h3,h4")
    .filter({ hasText: /ავეჯი/i })
    .first()
    .scrollIntoViewIfNeeded()
    .catch(() => {});
  await batchPrefillChips(page, buildPostExpandChipTasks(listing));
  await scrollToFormField(page, "საძინებელი");
  await prefillMainCountChips(page, listing);
  if (listingHasFurniture(listing)) {
    await prefillGeneralFurnitureChip(page);
  }

  for (const field of PREFILL_NUMERIC_FIELDS) {
    let value = field.getValue(listing)?.trim();
    if (!value) continue;
    value = normalizeNumericParam(value);

    for (const label of field.labels) {
      await fillLabeledInput(page, label, value);
      break;
    }
  }

  await prefillBalconyFields(page, listing);
  await prefillLoggiaFields(page, listing);
  await prefillVerandaFields(page, listing);
  await prefillCeilingHeightFields(page, listing);

  for (const label of CHIP_STYLE_ROW_LABELS) {
    const value = getRawPreferenceValue(listing, label);
    if (!value || value === "კი" || value === "არა") continue;
    await closeOpenDropdowns(page);
    await prefillPreferenceField(page, label, value);
  }

  for (const nested of NESTED_LUK_TYPE_SECTIONS) {
    const value = getNestedSectionTypeValue(listing, nested.valueKeys);
    if (!value) continue;
    await closeOpenDropdowns(page);
    await prefillNestedSectionTypeDropdown(
      page,
      nested.section,
      nested.dropdownHint,
      value
    );
    if (nested.areaKey) {
      const sectionArea = getNestedSectionAreaValue(
        listing,
        nested.areaKey,
        nested.valueKeys
      );
      if (sectionArea) {
        await prefillPause(page, 120);
        await fillInputInNestedSection(page, nested.section, "ფართი", sectionArea);
      }
    }
    await prefillPause(page, 150);
  }

  const lukSelectPrefillOrder = ["ხედი", "შესასვლელი"] as const;

  await closeOpenDropdowns(page);
  for (const label of lukSelectPrefillOrder) {
    const value =
      listing.rawData?.[label]?.trim() ||
      PREFILL_LIST_FIELDS.find((f) => f.labels.includes(label))?.getValue(listing)?.trim() ||
      "";
    if (!value) continue;
    await closeOpenDropdowns(page);
    await scrollToFormField(page, label);
    await prefillLukSelectByLabel(page, label, value);
  }

  for (const field of PREFILL_LIST_FIELDS) {
    const value = field.getValue(listing)?.trim();
    if (!value) continue;
    for (const label of field.labels) {
      if (label === "პროექტის ტიპი") continue;
      if (
        label === "სათავსო" ||
        label === "სათავსოს ტიპი" ||
        label === "მისაღები"
      ) {
        continue;
      }
      if (lukSelectPrefillOrder.includes(label as (typeof lukSelectPrefillOrder)[number])) {
        continue;
      }
      await closeOpenDropdowns(page);
      await prefillLukSelectByLabel(page, label, value);
      break;
    }
  }

  const projectType = getProjectTypeValue(listing);
  if (projectType) {
    await closeOpenDropdowns(page);
    await prefillProjectTypeField(page, projectType);
  }
  await closeOpenDropdowns(page);
}

/** Close cookie/modals that block clicks on the listing page. */
async function dismissBlockingOverlays(page: Page): Promise<void> {
  for (let i = 0; i < 4; i++) {
    const hadOverlay = await page.evaluate(() => {
      let closed = false;
      const acceptLabels = [
        "გასაგებია",
        "გასაგები",
        "დათანხმება",
        "ყველას მიღება",
        "Accept",
        "Accept all",
        "OK",
        "Close",
        "×",
      ];

      document.querySelectorAll("dialog[open], [role='dialog']").forEach((dlg) => {
        dlg.querySelectorAll("button").forEach((btn) => {
          const t = (btn.textContent || "").trim();
          if (acceptLabels.some((l) => t === l || t.startsWith(l))) {
            (btn as HTMLElement).click();
            closed = true;
          }
        });
        const closeBtn = dlg.querySelector(
          'button[aria-label*="close" i], button[aria-label*="დახურვ" i], [data-testid*="close"]'
        );
        if (closeBtn) {
          (closeBtn as HTMLElement).click();
          closed = true;
        }
      });

      document.querySelectorAll("button").forEach((btn) => {
        const t = (btn.textContent || "").trim();
        if (!acceptLabels.some((l) => t === l || t.startsWith(l))) return;
        if (btn.closest("dialog[open], [role='dialog'], [class*='modal'], [class*='overlay']")) {
          (btn as HTMLElement).click();
          closed = true;
        }
      });

      return closed;
    });

    if (!hadOverlay) break;
    await page.waitForTimeout(350);
  }

  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(200);
}

async function isListingPriceUsd(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const priceRoot =
      document.querySelector("[class*='currency-usd']")?.parentElement?.parentElement ||
      document.querySelector("[class*='price']");
    if (priceRoot?.textContent?.includes("$")) return true;
    const sw = document.querySelector('[role="switch"][aria-label*="ვალუტა"]');
    return sw?.getAttribute("aria-checked") === "true";
  });
}

type PriceRowCurrencyState = { isUsd: boolean; toggled: boolean };

async function evaluatePriceRowCurrency(
  page: Page,
  anchorSelector: string,
  action: "check" | "toggle"
): Promise<PriceRowCurrencyState> {
  return page.evaluate(
    ({ anchorSel, action }) => {
      const anchor = document.querySelector(anchorSel) as HTMLInputElement | null;
      if (!anchor) return { isUsd: false, toggled: false };

      function findPriceRow(el: Element) {
        let best: Element | null = null;
        let node: Element | null = el.parentElement;
        for (let i = 0; i < 10 && node; i++) {
          const text = node.textContent || "";
          if (text.includes("შესაძლებელია გაცვლა")) break;
          if (
            text.includes("სრული ფასი") &&
            text.includes("კვ.") &&
            !text.includes("შესაძლებელია გაცვლა")
          ) {
            best = node;
          }
          node = node.parentElement;
        }
        return best || el.parentElement?.parentElement || el.parentElement;
      }

      function getCurrencySwitch(root: Element | null) {
        if (!root) return null;
        const switches = [...root.querySelectorAll('[role="switch"]')];
        for (const sw of switches) {
          const label = sw.getAttribute("aria-label") || "";
          if (/გაცვლა/i.test(label)) continue;
          if (/ვალუტა|GEL|USD|currency/i.test(label)) return sw;
        }
        for (const sw of switches) {
          const label = sw.getAttribute("aria-label") || "";
          if (!/გაცვლა/i.test(label)) return sw;
        }
        return null;
      }

      function symbolLooksActive(el: Element) {
        const cls = el.className?.toString() || "";
        if (/bg-(?!transparent)|bg-primary|bg-green|rounded-full/i.test(cls)) return true;
        const bg = getComputedStyle(el as HTMLElement).backgroundColor;
        return (
          !!bg &&
          bg !== "rgba(0, 0, 0, 0)" &&
          bg !== "transparent" &&
          !bg.includes("255, 255, 255")
        );
      }

      function priceRowShowsUsd() {
        const root = findPriceRow(anchor);
        if (!root) return false;

        const sw = getCurrencySwitch(root);
        if (sw?.getAttribute("aria-checked") === "true") return true;

        for (const el of root.querySelectorAll("button, span, div")) {
          const t = el.textContent?.trim();
          if (t === "$" && symbolLooksActive(el)) return true;
          if (t === "₾" && symbolLooksActive(el)) return false;
        }

        const parent = anchor.parentElement;
        if (parent) {
          const val = anchor.value || "";
          const before = (parent.textContent || "").split(val)[0] || "";
          if (before.includes("₾") && !before.includes("$")) return false;
          if (before.includes("$")) return true;
        }
        return false;
      }

      function clickUsdInPriceRow() {
        const root = findPriceRow(anchor);
        if (!root) return false;

        const tryClick = (el: HTMLElement | null) => {
          if (!el) return false;
          el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
          el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
          el.click();
          return priceRowShowsUsd();
        };

        for (const el of root.querySelectorAll("button, span, div, p")) {
          if (el.textContent?.trim() !== "$") continue;
          if (el.children.length > 2) continue;
          if (tryClick(el as HTMLElement)) return true;
        }

        const sw = getCurrencySwitch(root);
        if (sw && tryClick(sw as HTMLElement)) return true;

        return priceRowShowsUsd();
      }

      const isUsd = priceRowShowsUsd();
      if (action === "check") return { isUsd, toggled: false };
      if (isUsd) return { isUsd: true, toggled: true };
      return { isUsd: priceRowShowsUsd(), toggled: clickUsdInPriceRow() };
    },
    { anchorSel: anchorSelector, action }
  );
}

/** Playwright clicks for USD toggle — only targets elements inside the price row. */
async function clickUsdTogglePlaywright(
  page: Page,
  anchorSelector: string
): Promise<void> {
  const priceRow = page
    .locator(anchorSelector)
    .locator("xpath=ancestor::*[contains(., 'სრული ფასი')][1]");

  const dollar = priceRow.getByText("$", { exact: true }).last();
  if ((await dollar.count()) > 0) {
    await dollar.click({ force: true, timeout: 2000 }).catch(() => {});
    return;
  }

  const rowSwitch = priceRow.locator('[role="switch"]');
  if ((await rowSwitch.count()) > 0) {
    await rowSwitch.first().click({ force: true, timeout: 2000 }).catch(() => {});
    return;
  }

  const nearSwitch = page
    .locator(anchorSelector)
    .locator("xpath=ancestor::*[position()<=5]//button[@role='switch'][1]");
  if ((await nearSwitch.count()) > 0) {
    await nearSwitch.first().click({ force: true, timeout: 2000 }).catch(() => {});
  }
}

/** Toggle the ფასი currency switch to USD on the create form (₾ / $ pill next to price). */
async function switchPriceFieldToUsd(
  page: Page,
  anchorSelector = "#total_price"
): Promise<void> {
  await page.locator(anchorSelector).scrollIntoViewIfNeeded().catch(() => {});
  await dismissBlockingOverlays(page);

  let state = await evaluatePriceRowCurrency(page, anchorSelector, "check");
  if (state.isUsd) return;

  state = await evaluatePriceRowCurrency(page, anchorSelector, "toggle");
  if (!state.isUsd) {
    await clickUsdTogglePlaywright(page, anchorSelector);
    await prefillPause(page, 400);
    state = await evaluatePriceRowCurrency(page, anchorSelector, "check");
  }

  if (!state.isUsd) {
    await clickUsdTogglePlaywright(page, anchorSelector);
    await prefillPause(page, 400);
    await evaluatePriceRowCurrency(page, anchorSelector, "toggle");
  }
}

/** Slide/click the listing price currency toggle to USD (same as on myhome.ge). */
async function switchListingPriceToUsd(page: Page): Promise<void> {
  await dismissBlockingOverlays(page);

  await page
    .waitForSelector(
      "[class*='currency-gel'], [class*='currency-usd'], [class*='price'], [role='switch'][aria-label*='ვალუტა']",
      { timeout: 15000 }
    )
    .catch(() => null);

  if (await isListingPriceUsd(page)) return;

  const toggleViaDom = async () =>
    page.evaluate(() => {
      const isUsd = () => {
        const priceRoot =
          document.querySelector("[class*='currency-usd']")?.parentElement?.parentElement ||
          document.querySelector("[class*='price']");
        if (priceRoot?.textContent?.includes("$")) return true;
        const sw = document.querySelector('[role="switch"][aria-label*="ვალუტა"]');
        return sw?.getAttribute("aria-checked") === "true";
      };

      if (isUsd()) return true;

      const currencySwitch =
        document.querySelector('[role="switch"][aria-label*="ვალუტა"]') ||
        document.querySelector('[role="switch"][id*="headlessui-switch"]');

      if (currencySwitch) {
        (currencySwitch as HTMLElement).click();
        return isUsd();
      }

      const usd = document.querySelector("[class*='currency-usd']");
      const targets = [
        usd?.closest('[role="switch"]'),
        usd?.parentElement,
        usd,
      ].filter(Boolean) as HTMLElement[];

      for (const el of targets) {
        el.click();
        if (isUsd()) return true;
      }
      return false;
    });

  let ok = await toggleViaDom();
  if (!ok) {
    await dismissBlockingOverlays(page);
    ok = await toggleViaDom();
  }

  if (!ok) {
    const currencySwitch = page.locator('[role="switch"][aria-label*="ვალუტა"], [role="switch"][id*="headlessui-switch"]');
    if ((await currencySwitch.count()) > 0) {
      await currencySwitch.first().click({ force: true, timeout: 2000 }).catch(() => {});
    }
  }

  await page
    .waitForFunction(
      () => {
        const priceRoot =
          document.querySelector("[class*='currency-usd']")?.parentElement?.parentElement ||
          document.querySelector("[class*='price']");
        if (priceRoot?.textContent?.match(/\$\s*[\d,]/)) return true;
        const sw = document.querySelector('[role="switch"][aria-label*="ვალუტა"]');
        return sw?.getAttribute("aria-checked") === "true";
      },
      { timeout: 8000 }
    )
    .catch(() => page.waitForTimeout(800));
}

async function getBrowser(): Promise<Browser> {
  if (!browserInstance || !browserInstance.isConnected()) {
    browserInstance = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
  }
  return browserInstance;
}

// Login to myhome.ge with user's credentials
export async function loginToMyhome(credentials: MyhomeCredentials): Promise<{
  success: boolean;
  cookies?: string;
  error?: string;
}> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();

  try {
    // Navigate to TNET auth page (myhome.ge redirects here)
    await page.goto("https://auth.tnet.ge/ka/user/login/?Continue=https://www.myhome.ge/", {
      waitUntil: "networkidle",
      timeout: 30000,
    });

    // Fill in email (TNET uses name="Email" with type="text")
    await page.waitForSelector('input[name="Email"]', {
      timeout: 10000,
    });
    await page.fill('input[name="Email"]', credentials.email);

    // Fill in password
    await page.fill('input[name="Password"]', credentials.password);

    // Submit login form and wait for redirect away from auth.tnet.ge
    await page.click('[data-testid="login-form__button-submit"]');
    try {
      await page.waitForURL((url) => !url.href.includes("auth.tnet.ge"), {
        timeout: 20000,
      });
    } catch {
      return { success: false, error: "Invalid credentials or login failed" };
    }

    // Save cookies for future requests
    const cookies = await context.cookies();
    const cookieString = JSON.stringify(cookies);

    return { success: true, cookies: cookieString };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Login failed",
    };
  } finally {
    await context.close();
  }
}

// Parse a myhome.ge listing page
export async function parseListing(url: string): Promise<{
  success: boolean;
  data?: MyhomeListing;
  error?: string;
}> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    locale: "ka-GE",
  });
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await dismissBlockingOverlays(page);

    // Wait for the SPA to render listing content
    await page.waitForSelector("h1, h3", { timeout: 15000 }).catch(() => null);
    await page
      .waitForSelector(".swiper-slide img, [class*='price']", { timeout: 8000 })
      .catch(() => page.waitForTimeout(1500));

    await switchListingPriceToUsd(page);

    await page
      .getByRole("button", { name: /მეტის ნახვა/i })
      .first()
      .click({ timeout: 3000 })
      .catch(() =>
        page.evaluate(() => {
          document.querySelectorAll("button, a, span").forEach((el) => {
            if ((el.textContent?.trim() || "") === "მეტის ნახვა") {
              (el as HTMLElement).click();
            }
          });
        })
      );
    await page.waitForTimeout(600);
    await page
      .getByText("დამატებითი პარამეტრები", { exact: false })
      .first()
      .scrollIntoViewIfNeeded()
      .catch(() => {});

    const parseParams = {
      additionalLabels: [...ADDITIONAL_PARAM_LABELS],
      furnitureLabels: [...FURNITURE_LABELS],
      preferenceLabels: [...PREFERENCE_PARAM_LABELS],
      labelCanonical: LABEL_CANONICAL,
    };

    const data = await page.evaluate((opts) => {
      const additionalLabels: string[] = opts.additionalLabels;
      const furnitureLabels: string[] = opts.furnitureLabels;
      const preferenceLabels: string[] = opts.preferenceLabels;
      const labelCanonical: Record<string, string> = opts.labelCanonical;
      const WHITELIST = new Set(additionalLabels);
      const PREFERENCE_LABELS = new Set(preferenceLabels);

      const isWetPointLabel = (text: string) =>
        /^სვ\.?\s*წერტილ/i.test(text.replace(/\s+/g, " ").trim()) &&
        text.length <= 30;

      const isBedroomLabel = (text: string) =>
        /^საძინებელი/i.test(text.replace(/\s+/g, " ").trim()) &&
        text.length <= 25;

      const isProjectTypeLabel = (text: string) =>
        /^პროექტის\s*ტიპი/i.test(text.replace(/\s+/g, " ").trim()) &&
        text.length <= 30;

      const dedupeRepeated = (value: string): string => {
        const v = value.replace(/\s+/g, " ").trim();
        if (!v) return "";
        for (let len = Math.floor(v.length / 2); len >= 3; len--) {
          if (v.slice(0, len) === v.slice(len, len * 2)) return v.slice(0, len);
        }
        return v;
      };

      const canonicalLabel = (label: string) => {
        if (isWetPointLabel(label)) return "სვ.წერტილი";
        if (isBedroomLabel(label)) return "საძინებელი";
        if (isProjectTypeLabel(label)) return "პროექტის ტიპი";
        return labelCanonical[label] || label;
      };

      const isWhitelisted = (text: string) =>
        WHITELIST.has(text) ||
        Boolean(labelCanonical[text]) ||
        isWetPointLabel(text) ||
        isBedroomLabel(text) ||
        isProjectTypeLabel(text);

      const isYesNo = (v: string) => v === "კი" || v === "არა";

      const pickBestValue = (canon: string, candidates: string[]): string => {
        const usable = candidates.filter((v) => v && v.length <= 150 && v !== "არა");
        if (canon === "სვ.წერტილი" || canon === "საძინებელი") {
          return (
            usable.find((v) => /^\d+\+?$/.test(v.replace(/\s+/g, ""))) ||
            usable[0] ||
            ""
          );
        }
        if (canon === "აივანი") {
          const combined = usable.find((v) => /^\d+\s*\/\s*\d/.test(v));
          if (combined) return combined;
        }
        if (canon === "ლოჯია" || canon === "ვერანდა") {
          const withArea = usable.find((v) => /მ²|m²|\d+\s*\/\s*\d/i.test(v));
          if (withArea) return withArea;
        }
        if (canon === "ჭერის სიმაღლე") {
          const withHeight = usable.find(
            (v) => /\d/.test(v) && !isYesNo(v) && !/მ²|m²/i.test(v)
          );
          if (withHeight) return withHeight;
        }
        if (canon === "პროექტის ტიპი" || PREFERENCE_LABELS.has(canon)) {
          if (canon === "სათავსო" || canon === "მისაღები") {
            const typeHint =
              canon === "სათავსო" ? /^სათავსოს\s*ტიპი$/i : /^მისაღების\s*ტიპი$/i;
            const combined = usable.find(
              (v) => !isYesNo(v) && /\/\s*\d/.test(v) && !typeHint.test(v)
            );
            if (combined) return dedupeRepeated(combined);
          }
          const pref = usable.find((v) => !isYesNo(v) && v.length > 1);
          return pref ? dedupeRepeated(pref) : "";
        }
        return usable.find((v) => isYesNo(v)) || usable[0] || "";
      };

      const mergeParamValue = (
        out: Record<string, string>,
        canon: string,
        val: string
      ) => {
        if (!val || val === "არა") return;
        if (PREFERENCE_LABELS.has(canon) && isYesNo(val)) return;

        const existing = out[canon];
        if (!existing) {
          out[canon] = val;
          return;
        }
        if (PREFERENCE_LABELS.has(canon)) {
          if (isYesNo(existing) && !isYesNo(val)) out[canon] = val;
          return;
        }
        if (existing === "კი" && val !== "კი") out[canon] = val;
      };

      const collectWetPointFromFlexRows = (root: Element | Document) => {
        const out: Record<string, string> = {};
        const canon = "სვ.წერტილი";

        function setCount(value: string) {
          const digits = value.replace(/[^\d]/g, "");
          if (digits) out[canon] = digits;
        }

        root.querySelectorAll("span,label,p,motion.div,motion.div,motion.div,div").forEach((el) => {
          const t = (el.textContent || "").replace(/\s+/g, " ").trim();
          if (!isWetPointLabel(t)) return;
          if (el.children.length > 2) return;

          const parent = el.parentElement;
          if (parent) {
            const joined = (parent.textContent || "").replace(/\s+/g, "");
            const glued = joined.match(/^სვ[.\s]*წერტილი(?:ები)?(\d+)$/iu);
            if (glued) {
              setCount(glued[1]);
              return;
            }

            const children = Array.from(parent.children);
            const idx = children.indexOf(el);
            if (idx >= 0 && children[idx + 1]) {
              setCount(children[idx + 1].textContent || "");
            }
          }

          let row: Element | null = el.parentElement?.parentElement || null;
          for (let depth = 0; depth < 4 && row; depth++) {
            for (const child of row.children) {
              const ct = (child.textContent || "").trim();
              if (ct === t) continue;
              if (/^\d+\+?$/.test(ct)) {
                setCount(ct);
                return;
              }
            }
            row = row.parentElement;
          }
        });

        return out;
      };

      const collectBedroomsFromFlexRows = (root: Element | Document) => {
        const out: Record<string, string> = {};
        const canon = "საძინებელი";

        function setCount(value: string) {
          const digits = value.replace(/[^\d]/g, "");
          if (digits) out[canon] = digits;
        }

        root.querySelectorAll("span,label,p,motion.div,motion.div,motion.div,div").forEach((el) => {
          const t = (el.textContent || "").replace(/\s+/g, " ").trim();
          if (!isBedroomLabel(t)) return;
          if (el.children.length > 2) return;

          const parent = el.parentElement;
          if (parent) {
            const joined = (parent.textContent || "").replace(/\s+/g, "");
            const glued = joined.match(/^საძინებელი(\d+)$/iu);
            if (glued) {
              setCount(glued[1]);
              return;
            }

            const children = Array.from(parent.children);
            const idx = children.indexOf(el);
            if (idx >= 0 && children[idx + 1]) {
              setCount(children[idx + 1].textContent || "");
            }
          }

          let row: Element | null = el.parentElement?.parentElement || null;
          for (let depth = 0; depth < 4 && row; depth++) {
            for (const child of row.children) {
              const ct = (child.textContent || "").trim();
              if (ct === t) continue;
              if (/^\d+\+?$/.test(ct)) {
                setCount(ct);
                return;
              }
            }
            row = row.parentElement;
          }
        });

        return out;
      };

      const collectProjectTypeFromFlexRows = (root: Element | Document) => {
        const out: Record<string, string> = {};
        const canon = "პროექტის ტიპი";

        root.querySelectorAll("span,label,p,motion.div,div").forEach((el) => {
          const t = (el.textContent || "").replace(/\s+/g, " ").trim();
          if (!isProjectTypeLabel(t)) return;
          if (el.children.length > 2) return;

          const parent = el.parentElement;
          if (!parent) return;

          const joined = (parent.textContent || "").replace(/\s+/g, "");
          const glued = joined.match(/^პროექტისტიპი(.+)$/iu);
          if (glued) {
            const val = dedupeRepeated(glued[1]);
            if (val && !isYesNo(val)) out[canon] = val;
            return;
          }

          for (const child of parent.children) {
            const ct = (child.textContent || "").replace(/\s+/g, " ").trim();
            if (!ct || ct === t || isYesNo(ct)) continue;
            if (ct.length > 40) continue;
            out[canon] = dedupeRepeated(ct);
            return;
          }
        });

        return out;
      };

      const collectLabelValuePairs = (root: Element | Document) => {
        const out: Record<string, string> = {};
        root.querySelectorAll("div").forEach((container) => {
          const children = Array.from(container.children);
          if (children.length < 2 || children.length > 5) return;
          const texts = children.map((c) =>
            (c.textContent?.trim() || "").replace(/\s+/g, " ")
          );

          for (const text of texts) {
            if (!isWhitelisted(text)) continue;
            const canon = canonicalLabel(text);
            const candidates = texts.filter((v) => v !== text && v !== canon);
            const val = pickBestValue(canon, candidates);
            mergeParamValue(out, canon, val);
          }
        });
        return out;
      };

      const findSectionRoot = (headingText: string): Element => {
        for (const el of document.querySelectorAll("h1,h2,h3,h4,motion.div,motion.section,div,span,p")) {
          const t = el.textContent?.trim() || "";
          if (t !== headingText && !t.startsWith(headingText + " ")) continue;
          const section =
            el.closest("section") ||
            el.closest("motion.section") ||
            el.parentElement?.parentElement?.parentElement;
          if (section) return section;
        }
        return document.body;
      };

      const collectAdditionalParametersFromSection = () => {
        const params = collectLabelValuePairs(
          findSectionRoot("დამატებითი პარამეტრები")
        );
        const bodyParams = collectLabelValuePairs(document.body);
        for (const [k, v] of Object.entries(bodyParams)) {
          mergeParamValue(params, k, v);
        }

        const wetPoint = collectWetPointFromFlexRows(document.body);
        for (const [k, v] of Object.entries(wetPoint)) {
          mergeParamValue(params, k, v);
        }

        const bedroomsFlex = collectBedroomsFromFlexRows(document.body);
        for (const [k, v] of Object.entries(bedroomsFlex)) {
          mergeParamValue(params, k, v);
        }

        const projectTypeFlex = collectProjectTypeFromFlexRows(document.body);
        for (const [k, v] of Object.entries(projectTypeFlex)) {
          mergeParamValue(params, k, v);
        }

        const collectBalconyFromFlexRows = (root: Element | Document) => {
          const out: Record<string, string> = {};

          root.querySelectorAll("span,label,p,motion.div,motion.div,motion.div,motion.div,motion.div,div").forEach((el) => {
            const t = (el.textContent || "").replace(/\s+/g, " ").trim();
            if (t !== "აივანი") return;
            if (el.tagName !== "DIV" && el.children.length > 3) return;

            const parent = el.parentElement;
            if (!parent) return;

            const joined = (parent.textContent || "").replace(/\s+/g, "");
            const glued = joined.match(/^აივანი(\d+)\/(\d+(?:[.,]\d+)?)\s*(?:მ²|m²)?$/iu);
            if (glued) {
              out["აივნის რაოდენობა"] = glued[1];
              out["აივნის ფართი"] = glued[2].replace(",", ".");
              out["აივანი"] = `${glued[1]}/${glued[2]}`;
              return;
            }

            for (const child of parent.children) {
              const ct = (child.textContent || "").replace(/\s+/g, " ").trim();
              if (!ct || ct === t) continue;
              if (ct.length > 40) continue;
              const slash = ct.match(/^(\d+)\s*\/\s*(\d+(?:[.,]\d+)?)\s*(?:მ²|m²)?$/iu);
              if (slash) {
                out["აივნის რაოდენობა"] = slash[1];
                out["აივნის ფართი"] = slash[2].replace(",", ".");
                out["აივანი"] = `${slash[1]}/${slash[2]}`;
                return;
              }
            }
          });

          return out;
        };

        const balconyFlex = collectBalconyFromFlexRows(document.body);
        for (const [k, v] of Object.entries(balconyFlex)) {
          mergeParamValue(params, k, v);
        }

        const collectLoggiaFromFlexRows = (root: Element | Document) => {
          const out: Record<string, string> = {};

          root.querySelectorAll("span,label,p,motion.div,motion.div,motion.div,motion.div,motion.div,motion.div,motion.div,div").forEach((el) => {
            const t = (el.textContent || "").replace(/\s+/g, " ").trim();
            if (t !== "ლოჯია") return;
            if (el.tagName !== "DIV" && el.children.length > 3) return;

            const parent = el.parentElement;
            if (!parent) return;

            const joined = (parent.textContent || "").replace(/\s+/g, "");
            const gluedSlash = joined.match(/^ლოჯია(\d+)\/(\d+(?:[.,]\d+)?)\s*(?:მ²|m²)?$/iu);
            if (gluedSlash) {
              out["ლოჯიის ფართი"] = gluedSlash[2].replace(",", ".");
              out["ლოჯია"] = `${gluedSlash[1]}/${gluedSlash[2]}`;
              return;
            }

            const gluedArea = joined.match(/^ლოჯია(\d+(?:[.,]\d+)?)\s*(?:მ²|m²)?$/iu);
            if (gluedArea) {
              out["ლოჯიის ფართი"] = gluedArea[1].replace(",", ".");
              out["ლოჯია"] = gluedArea[1];
              return;
            }

            for (const child of parent.children) {
              const ct = (child.textContent || "").replace(/\s+/g, " ").trim();
              if (!ct || ct === t) continue;
              if (ct.length > 40) continue;
              const slash = ct.match(/^(\d+)\s*\/\s*(\d+(?:[.,]\d+)?)\s*(?:მ²|m²)?$/iu);
              if (slash) {
                out["ლოჯიის ფართი"] = slash[2].replace(",", ".");
                out["ლოჯია"] = `${slash[1]}/${slash[2]}`;
                return;
              }
              const areaOnly = ct.match(/^(\d+(?:[.,]\d+)?)\s*(?:მ²|m²)?$/iu);
              if (areaOnly) {
                out["ლოჯიის ფართი"] = areaOnly[1].replace(",", ".");
                out["ლოჯია"] = areaOnly[1];
                return;
              }
            }
          });

          return out;
        };

        const loggiaFlex = collectLoggiaFromFlexRows(document.body);
        for (const [k, v] of Object.entries(loggiaFlex)) {
          mergeParamValue(params, k, v);
        }

        const collectVerandaFromFlexRows = (root: Element | Document) => {
          const out: Record<string, string> = {};

          root.querySelectorAll("span,label,p,motion.div,motion.div,motion.div,motion.div,motion.div,motion.div,motion.div,motion.div,motion.div,div").forEach((el) => {
            const t = (el.textContent || "").replace(/\s+/g, " ").trim();
            if (t !== "ვერანდა") return;
            if (el.tagName !== "DIV" && el.children.length > 3) return;

            const parent = el.parentElement;
            if (!parent) return;

            const joined = (parent.textContent || "").replace(/\s+/g, "");
            const gluedSlash = joined.match(/^ვერანდა(\d+)\/(\d+(?:[.,]\d+)?)\s*(?:მ²|m²)?$/iu);
            if (gluedSlash) {
              out["ვერანდის ფართი"] = gluedSlash[2].replace(",", ".");
              out["ვერანდა"] = `${gluedSlash[1]}/${gluedSlash[2]}`;
              return;
            }

            const gluedArea = joined.match(/^ვერანდა(\d+(?:[.,]\d+)?)\s*(?:მ²|m²)?$/iu);
            if (gluedArea) {
              out["ვერანდის ფართი"] = gluedArea[1].replace(",", ".");
              out["ვერანდა"] = gluedArea[1];
              return;
            }

            for (const child of parent.children) {
              const ct = (child.textContent || "").replace(/\s+/g, " ").trim();
              if (!ct || ct === t) continue;
              if (ct.length > 40) continue;
              const slash = ct.match(/^(\d+)\s*\/\s*(\d+(?:[.,]\d+)?)\s*(?:მ²|m²)?$/iu);
              if (slash) {
                out["ვერანდის ფართი"] = slash[2].replace(",", ".");
                out["ვერანდა"] = `${slash[1]}/${slash[2]}`;
                return;
              }
              const areaOnly = ct.match(/^(\d+(?:[.,]\d+)?)\s*(?:მ²|m²)?$/iu);
              if (areaOnly) {
                out["ვერანდის ფართი"] = areaOnly[1].replace(",", ".");
                out["ვერანდა"] = areaOnly[1];
                return;
              }
            }
          });

          return out;
        };

        const verandaFlex = collectVerandaFromFlexRows(document.body);
        for (const [k, v] of Object.entries(verandaFlex)) {
          mergeParamValue(params, k, v);
        }

        const collectCeilingHeightFromFlexRows = (root: Element | Document) => {
          const out: Record<string, string> = {};

          root.querySelectorAll("span,label,p,motion.div,motion.div,motion.div,motion.div,motion.div,motion.div,motion.div,motion.div,motion.div,motion.div,motion.div,div").forEach((el) => {
            const t = (el.textContent || "").replace(/\s+/g, " ").trim();
            if (t !== "ჭერის სიმაღლე") return;
            if (el.tagName !== "DIV" && el.children.length > 3) return;

            const parent = el.parentElement;
            if (!parent) return;

            const joined = (parent.textContent || "").replace(/\s+/g, "");
            const glued = joined.match(
              /^ჭერისსიმაღლე(\d+(?:[.,]\d+)?)\s*(?:სმ|cm|მ|m)?$/iu
            );
            if (glued) {
              out["ჭერის სიმაღლე"] = glued[1].replace(",", ".");
              return;
            }

            for (const child of parent.children) {
              const ct = (child.textContent || "").replace(/\s+/g, " ").trim();
              if (!ct || ct === t) continue;
              if (ct.length > 40) continue;
              const height = ct.match(/^(\d+(?:[.,]\d+)?)\s*(?:სმ|cm|მ|m)?$/iu);
              if (height) {
                out["ჭერის სიმაღლე"] = height[1].replace(",", ".");
                return;
              }
            }
          });

          return out;
        };

        const ceilingFlex = collectCeilingHeightFromFlexRows(document.body);
        for (const [k, v] of Object.entries(ceilingFlex)) {
          mergeParamValue(params, k, v);
        }

        const collectGarageFromFlexRows = (root: Element | Document) => {
          const out: Record<string, string> = {};

          root.querySelectorAll("span,label,p,motion.div,motion.div,motion.div,div").forEach((el) => {
            const t = (el.textContent || "").replace(/\s+/g, " ").trim();
            if (t !== "სათავსო") return;
            if (el.tagName !== "DIV" && el.children.length > 3) return;

            const parent = el.parentElement;
            if (!parent) return;

            const joined = (parent.textContent || "").replace(/\s+/g, "");
            const glued = joined.match(/^სათავსო(?!სტიპი)(.+)$/iu);
            if (glued) {
              const chunk = glued[1];
              const slash = chunk.match(/^(.+?)\/(\d+(?:[.,]\d+)?)\s*(?:მ²|m²)?$/iu);
              if (slash) {
                out["სათავსო"] = dedupeRepeated(slash[1]);
                out["სათავსოს ფართი"] = slash[2].replace(",", ".");
              } else if (chunk && !isYesNo(chunk)) {
                out["სათავსო"] = dedupeRepeated(chunk);
              }
              return;
            }

            for (const child of parent.children) {
              const ct = (child.textContent || "").replace(/\s+/g, " ").trim();
              if (!ct || ct === t || isYesNo(ct)) continue;
              if (ct.length > 60) continue;
              const slash = ct.match(/^(.+?)\/(\d+(?:[.,]\d+)?)\s*(?:მ²|m²)?$/iu);
              if (slash) {
                out["სათავსო"] = dedupeRepeated(slash[1]);
                out["სათავსოს ფართი"] = slash[2].replace(",", ".");
              } else {
                out["სათავსო"] = dedupeRepeated(ct);
              }
              return;
            }
          });

          return out;
        };

        const garageFlex = collectGarageFromFlexRows(document.body);
        for (const [k, v] of Object.entries(garageFlex)) {
          mergeParamValue(params, k, v);
        }

        const collectLobbyFromFlexRows = (root: Element | Document) => {
          const out: Record<string, string> = {};

          root.querySelectorAll("span,label,p,motion.div,motion.div,motion.div,motion.div,div").forEach((el) => {
            const t = (el.textContent || "").replace(/\s+/g, " ").trim();
            if (t !== "მისაღები") return;
            if (el.tagName !== "DIV" && el.children.length > 3) return;

            const parent = el.parentElement;
            if (!parent) return;

            const joined = (parent.textContent || "").replace(/\s+/g, "");
            const glued = joined.match(/^მისაღების(?!ტიპი)(.+)$/iu);
            if (glued) {
              const chunk = glued[1];
              const slash = chunk.match(/^(.+?)\/(\d+(?:[.,]\d+)?)\s*(?:მ²|m²)?$/iu);
              if (slash) {
                out["მისაღები"] = dedupeRepeated(slash[1]);
                out["მისაღების ფართი"] = slash[2].replace(",", ".");
              } else if (chunk && !isYesNo(chunk)) {
                out["მისაღები"] = dedupeRepeated(chunk);
              }
              return;
            }

            for (const child of parent.children) {
              const ct = (child.textContent || "").replace(/\s+/g, " ").trim();
              if (!ct || ct === t || isYesNo(ct)) continue;
              if (ct.length > 60) continue;
              const slash = ct.match(/^(.+?)\/(\d+(?:[.,]\d+)?)\s*(?:მ²|m²)?$/iu);
              if (slash) {
                out["მისაღები"] = dedupeRepeated(slash[1]);
                out["მისაღების ფართი"] = slash[2].replace(",", ".");
              } else {
                out["მისაღები"] = dedupeRepeated(ct);
              }
              return;
            }
          });

          return out;
        };

        const lobbyFlex = collectLobbyFromFlexRows(document.body);
        for (const [k, v] of Object.entries(lobbyFlex)) {
          mergeParamValue(params, k, v);
        }

        const furnitureRoot = (() => {
          for (const title of ["ავეჯი და ტექნიკა", "ავეჯი"]) {
            const root = findSectionRoot(title);
            if (root && root !== document.body) return root;
          }
          return document.body;
        })();

        function furnitureLabelOnPage(label: string): boolean {
          const target = label.replace(/\s+/g, " ").trim();
          let found = false;
          furnitureRoot.querySelectorAll(
            "button,[role=button],label,div,span,p,motion.div"
          ).forEach((el) => {
            if (/^H[1-6]$/i.test(el.tagName)) return;
            const t = (el.textContent?.trim() || "").replace(/\s+/g, " ");
            if (t === target || (t.includes(target) && t.length <= target.length + 8)) {
              found = true;
            }
          });
          return found;
        }

        for (const label of furnitureLabels) {
          if (!furnitureLabelOnPage(label)) continue;
          const inSection = collectLabelValuePairs(furnitureRoot);
          if (inSection[label] === "არა") continue;
          params[label] = inSection[label] || "კი";
        }

        if (furnitureLabelOnPage("ავეჯი")) {
          params["ავეჯი"] = params["ავეჯი"] || "კი";
        }

        function splitNestedTypeAndAreaFields(
          out: Record<string, string>,
          typeKey: string,
          areaKey: string
        ) {
          const raw = out[typeKey];
          if (!raw) return;
          const slash = raw.match(/^(.+?)\/(\d+(?:[.,]\d+)?)\s*(?:მ²|m²)?\s*$/iu);
          if (!slash) return;
          out[typeKey] = slash[1].trim();
          out[areaKey] = slash[2].replace(",", ".");
        }
        splitNestedTypeAndAreaFields(params, "მისაღები", "მისაღების ფართი");
        splitNestedTypeAndAreaFields(params, "სათავსო", "სათავსოს ფართი");

        function splitBalconyCountAndAreaFields(out: Record<string, string>) {
          const raw = out["აივანი"];
          if (!raw) return;
          const slash = raw.match(/^(\d+)\s*\/\s*(\d+(?:[.,]\d+)?)\s*(?:მ²|m²)?\s*$/iu);
          if (!slash) return;
          out["აივნის რაოდენობა"] = slash[1];
          out["აივნის ფართი"] = slash[2].replace(",", ".");
        }
        splitBalconyCountAndAreaFields(params);

        function splitLoggiaAreaFields(out: Record<string, string>) {
          const raw = out["ლოჯია"];
          if (!raw) return;
          const slash = raw.match(/^(\d+)\s*\/\s*(\d+(?:[.,]\d+)?)\s*(?:მ²|m²)?\s*$/iu);
          if (slash) {
            out["ლოჯიის ფართი"] = slash[2].replace(",", ".");
            return;
          }
          if (/მ²|m²/i.test(raw) || /^\d+(?:[.,]\d+)?\s*$/.test(raw.trim())) {
            const m = raw.match(/(\d+(?:[.,]\d+)?)/);
            if (m) out["ლოჯიის ფართი"] = m[1].replace(",", ".");
          }
        }
        splitLoggiaAreaFields(params);

        function splitVerandaAreaFields(out: Record<string, string>) {
          const raw = out["ვერანდა"];
          if (!raw) return;
          const slash = raw.match(/^(\d+)\s*\/\s*(\d+(?:[.,]\d+)?)\s*(?:მ²|m²)?\s*$/iu);
          if (slash) {
            out["ვერანდის ფართი"] = slash[2].replace(",", ".");
            return;
          }
          if (/მ²|m²/i.test(raw) || /^\d+(?:[.,]\d+)?\s*$/.test(raw.trim())) {
            const m = raw.match(/(\d+(?:[.,]\d+)?)/);
            if (m) out["ვერანდის ფართი"] = m[1].replace(",", ".");
          }
        }
        splitVerandaAreaFields(params);

        return params;
      };

      // --- Images (main swiper gallery only, skip thumbnail strip) ---
      const mainSwiper = document.querySelector(".swiper:not(.swiper-thumbs)");
      const imageElements = mainSwiper
        ? mainSwiper.querySelectorAll(".swiper-slide:not(.swiper-slide-duplicate) img")
        : document.querySelectorAll(".swiper-slide:not(.swiper-slide-duplicate) img");
      const images: string[] = [];
      const seenPaths = new Set<string>();

      imageElements.forEach((img) => {
        const src =
          (img as HTMLImageElement).src ||
          (img as HTMLElement).getAttribute("data-src") || "";
        if (!src || src.includes("placeholder") || src.includes("data:")) return;
        try {
          const key = new URL(src).origin + new URL(src).pathname;
          if (seenPaths.has(key)) return;
          seenPaths.add(key);
        } catch {
          if (seenPaths.has(src)) return;
          seenPaths.add(src);
        }
        images.push(src);
      });

      // --- Title ---
      const title =
        document.querySelector("h1")?.textContent?.trim() ||
        document.querySelector("h3")?.textContent?.trim() ||
        document.title;

      // --- Deal type from title ---
      let dealType = "";
      const dealMap: [string, string][] = [
        ["ქირავდება დღიურად", "ქირავდება დღიურად"],
        ["იყიდება", "იყიდება"],
        ["ქირავდება", "ქირავდება"],
        ["გირავდება", "გირავდება"],
      ];
      for (const [keyword, value] of dealMap) {
        if (title.includes(keyword)) { dealType = value; break; }
      }

      // --- Property type from title ---
      let propertyType = "";
      const propMap: [string, string][] = [
        ["კერძო სახლი", "კერძო სახლი"],
        ["სახლი", "კერძო სახლი"],
        ["აგარაკი", "აგარაკი"],
        ["მიწის ნაკვეთი", "მიწის ნაკვეთი"],
        ["კომერციული ფართი", "კომერციული ფართი"],
        ["კომერციული", "კომერციული ფართი"],
        ["სასტუმრო", "სასტუმრო"],
        ["ბინა", "ბინა"],
        ["ბინის", "ბინა"],
      ];
      const lowerTitle = title.toLowerCase();
      for (const [keyword, value] of propMap) {
        if (lowerTitle.includes(keyword.toLowerCase())) { propertyType = value; break; }
      }

      // --- Price + Currency (after USD toggle on listing page) ---
      function isCurrencyActive(el: Element | null) {
        if (!el) return false;
        const cls = el.className?.toString() || "";
        return /active|selected|is-active|checked|on/i.test(cls);
      }

      let price = "";
      let currency = "USD";
      const usdEl = document.querySelector("[class*='currency-usd']");
      const gelEl = document.querySelector("[class*='currency-gel']");

      if (isCurrencyActive(gelEl) && !isCurrencyActive(usdEl)) {
        currency = "GEL";
      }

      function parseAmount(text: string) {
        const m = text.match(/([\d][\d\s,.]*)/);
        return m ? m[1].replace(/\s/g, "").replace(/,/g, "").trim() : "";
      }

      const priceRoots = [
        usdEl?.parentElement?.parentElement,
        gelEl?.parentElement?.parentElement,
        document.querySelector("[class*='price']"),
        usdEl?.closest("[class*='price']")?.parentElement,
      ].filter(Boolean) as Element[];

      for (const root of priceRoots) {
        if (price) break;
        const text = root.textContent?.trim() || "";
        if (currency === "USD" && text.includes("$")) {
          price = parseAmount(text);
        } else if (currency === "GEL" && text.includes("₾")) {
          price = parseAmount(text);
        } else if (!text.includes("₾") && !text.includes("$")) {
          price = parseAmount(text);
        }
      }

      if (!price) {
        document.querySelectorAll("div, span").forEach((el) => {
          if (price) return;
          const t = el.textContent?.trim() || "";
          if (t.length > 25 || el.children.length > 2) return;
          const usdMatch = t.match(/^(\d[\d\s,.]*)\s*\$$/);
          const gelMatch = t.match(/^(\d[\d,.]*)\s*₾$/);
          if (currency === "USD" && usdMatch) price = parseAmount(usdMatch[1]);
          if (currency === "GEL" && gelMatch) price = parseAmount(gelMatch[1]);
        });
      }

      // --- Address / street (pin line under title, e.g. "ფარავნის ქ") ---
      const ADDRESS_NOISE =
        /[₾$]|მ²|იპოთეკა|სესხი|ფასი|გადაფორმება|იყიდება|ქირავდება|გირავდება|ოთახიანი|მოითხოვე|დღეს\s+\d/i;

      function isStreetLine(text: string): boolean {
        const s = text.replace(/\s+/g, " ").trim();
        if (s.length < 3 || s.length > 70) return false;
        if (ADDRESS_NOISE.test(s)) return false;
        if (/ფართი|საძინებელი|სართული|ოთახი/.test(s) && /\d/.test(s)) return false;
        return /(\s+ქ\.?|\s+ქუჩა|\s+გამზ\.?)(\s+\d|$)/iu.test(s) || /\s+ქ\.?$/iu.test(s);
      }

      function isStreetNumber(value: string): boolean {
        const n = value.replace(/^№\s*/, "").trim();
        return /^\d+[ა-ჰa-z]?$/iu.test(n) && n.length <= 10;
      }

      function parseAddressParts(raw: string) {
        const text = raw.replace(/\s+/g, " ").trim();
        const withNumber = [
          /^(.+?)\s+მ\.\s*ქ\.\s*(\d+[ა-ჰa-z]?)$/iu,
          /^(.+?)\s+მ\.\s*ქუჩა\s*(\d+[ა-ჰa-z]?)$/iu,
          /^(.+?)\s+გამზ\.?\s*(\d+[ა-ჰa-z]?)$/iu,
          /^(.+?)\s+ქ\.\s*(\d+[ა-ჰa-z]?)$/iu,
          /^(.+?)\s+ქუჩა\s*№?\s*(\d+[ა-ჰa-z]?)$/iu,
        ];
        for (const re of withNumber) {
          const m = text.match(re);
          if (m) {
            return {
              street: `${m[1].trim()} ${text.includes("ქუჩა") ? "ქუჩა" : "ქ"}`,
              streetNumber: m[2].trim(),
            };
          }
        }
        const streetOnly = text.match(/^(.+?)\s+(ქ\.?|ქუჩა)$/iu);
        if (streetOnly) {
          return { street: text, streetNumber: "" };
        }
        if (isStreetLine(text)) {
          return { street: text, streetNumber: "" };
        }
        return { street: "", streetNumber: "" };
      }

      function extractStreetNearTitle(): string {
        const h1 = document.querySelector("h1");
        if (!h1) return "";

        const scanRoots: Element[] = [h1.parentElement, h1.parentElement?.parentElement].filter(
          (el): el is Element => !!el
        );

        for (const root of scanRoots) {
          for (const el of root.querySelectorAll("a, span, p, div")) {
            if (el.children.length > 3) continue;
            const t = el.textContent?.trim() || "";
            if (isStreetLine(t)) return t;
          }
        }
        return "";
      }

      function collectAddressCandidates(): string[] {
        const candidates: string[] = [];
        const push = (t: string) => {
          const s = t.replace(/\s+/g, " ").trim();
          if (!isStreetLine(s)) return;
          if (candidates.includes(s)) return;
          candidates.push(s);
        };

        const nearTitle = extractStreetNearTitle();
        if (nearTitle) push(nearTitle);

        document.querySelectorAll("a, span, p").forEach((el) => {
          if (el.children.length > 2) return;
          const t = el.textContent?.trim() || "";
          push(t);
        });

        return candidates;
      }

      let address = "";
      let city = "";
      let street = "";
      let streetNumber = "";

      street = extractStreetNearTitle();

      if (!street) {
        for (const cand of collectAddressCandidates()) {
          const parts = parseAddressParts(cand);
          if (parts.street) {
            address = cand;
            street = parts.street;
            streetNumber = parts.streetNumber;
            break;
          }
        }
      } else {
        address = street;
        const parts = parseAddressParts(street);
        street = parts.street || street;
        streetNumber = parts.streetNumber;
      }

      const cities = [
        "თბილისი",
        "ბათუმი",
        "ქუთაისი",
        "რუსთავი",
        "ზუგდიდი",
        "თელავი",
        "გორი",
        "ფოთი",
        "ხაშური",
        "ოზურგეთი",
        "ქობულეთი",
        "ბაკურიანი",
        "მცხეთა",
        "სიღნაღი",
      ];
      const pageText = document.body.textContent || "";
      for (const c of cities) {
        if (pageText.includes(c)) {
          city = c;
          break;
        }
      }

      // --- Specs: area, rooms, bedrooms, floor ---
      let area = "";
      let rooms = "";
      let bedrooms = "";
      let bathrooms = "";
      let floor = "";
      let totalFloors = "";
      const rawData: Record<string, string> = {};
      if (currency === "USD") rawData["priceSource"] = "site-usd-toggle";
      if (street) rawData["ქუჩა"] = street;
      if (streetNumber) rawData["ქუჩის ნომერი"] = streetNumber;
      if (city) rawData["მდებარეობა"] = city;

      const specLabels = [
        "ფართი",
        "ოთახი",
        "საძინებელი",
        "სართული",
        "სვ.წერტილი",
        "სვ.წერტილები",
        "სველი წერტილი",
        "სველი წერტილები",
      ];
      document.querySelectorAll("div").forEach((container) => {
        const children = Array.from(container.children);
        if (children.length < 2 || children.length > 4) return;
        const texts = children.map((c) => c.textContent?.trim() || "");

        for (const label of specLabels) {
          if (!texts.includes(label)) continue;
          for (const sibling of texts) {
            if (sibling === label) continue;
            if (label === "ფართი" && sibling.includes("მ²") && !area) {
              area = sibling.replace(/მ²/g, "").trim();
            }
            if (label === "ოთახი" && /^\d+$/.test(sibling) && !rooms) {
              rooms = sibling;
            }
            if (label === "საძინებელი" && /^\d+$/.test(sibling) && !bedrooms) {
              bedrooms = sibling;
            }
            if (label === "სართული") {
              const fm = sibling.match(/(\d+)\s*\/\s*(\d+)/);
              if (fm && !floor) { floor = fm[1]; totalFloors = fm[2]; }
            }
            if (
              (label === "სვ.წერტილი" ||
                label === "სვ.წერტილები" ||
                label === "სველი წერტილი" ||
                label === "სველი წერტილები") &&
              /^\d+\+?$/.test(sibling) &&
              !bathrooms
            ) {
              bathrooms = sibling.replace(/[^\d]/g, "") || sibling;
            }
          }
        }
      });

      // --- Additional parameters section ---
      let buildingStatus = "";
      let condition = "";
      let projectType = "";
      let balconyArea = "";
      let verandaArea = "";
      let loggiaArea = "";
      let cadastralCode = "";

      const structuredFromAdditional: Record<string, (v: string) => void> = {
        "სტატუსი": (v) => { if (!buildingStatus) buildingStatus = v; },
        "მდგომარეობა": (v) => { if (!condition) condition = v; },
        "პროექტის ტიპი": (v) => {
          if (!projectType) projectType = dedupeRepeated(v);
        },
        "საძინებელი": (v) => {
          if (!bedrooms) bedrooms = v.replace(/[^\d]/g, "") || v;
        },
        "სვ.წერტილი": (v) => { if (!bathrooms) bathrooms = v.replace(/[^\d]/g, "") || v; },
        "სვ.წერტილები": (v) => { if (!bathrooms) bathrooms = v.replace(/[^\d]/g, "") || v; },
        "სველი წერტილი": (v) => { if (!bathrooms) bathrooms = v.replace(/[^\d]/g, "") || v; },
        "სველი წერტილები": (v) => { if (!bathrooms) bathrooms = v.replace(/[^\d]/g, "") || v; },
        "აივანი": (v) => { if (!balconyArea) balconyArea = v; },
        "ვერანდა": (v) => { if (!verandaArea) verandaArea = v; },
        "ლოჯია": (v) => { if (!loggiaArea) loggiaArea = v; },
        "საკადასტრო კოდი": (v) => { if (!cadastralCode) cadastralCode = v; },
        "მდებარეობა": (v) => {
          if (!city) city = v.split(",")[0].trim();
        },
        "ქუჩა": (v) => {
          if (!street && isStreetLine(v)) {
            const parts = parseAddressParts(v);
            street = parts.street || v.trim();
            if (!streetNumber && parts.streetNumber) streetNumber = parts.streetNumber;
          }
        },
        "ქუჩის ნომერი": (v) => {
          if (!streetNumber && isStreetNumber(v)) {
            streetNumber = v.replace(/^№\s*/, "").trim();
          }
        },
      };

      const sectionParams = collectAdditionalParametersFromSection();
      for (const [label, value] of Object.entries(sectionParams)) {
        structuredFromAdditional[label]?.(value);
        rawData[label] = value;
      }

      if (street) rawData["ქუჩა"] = street;
      if (streetNumber) rawData["ქუჩის ნომერი"] = streetNumber;
      if (city) rawData["მდებარეობა"] = city;

      // --- Description ("მოკლე აღწერა") ---
      let description = "";
      document.querySelectorAll("div, section").forEach((el) => {
        if (description) return;
        const t = el.textContent?.trim() || "";
        if (t.startsWith("მოკლე აღწერა") && t.length > 15) {
          description = t.replace("მოკლე აღწერა", "").trim();
          description = description.replace(/ნაკლების ნახვა\s*\^?$/i, "").replace(/მეტის ნახვა\s*$/i, "").trim();
        }
      });

      // --- ID ---
      document.querySelectorAll("span").forEach((sp) => {
        const t = sp.textContent?.trim() || "";
        if (t.startsWith("ID:")) rawData["ID"] = t.replace("ID:", "").trim();
      });

      // --- Price per m² (from page in USD, or calculated) ---
      let pricePerSqm = "";
      document.querySelectorAll("div, span").forEach((el) => {
        if (pricePerSqm) return;
        const t = el.textContent?.trim() || "";
        if (!t.includes("მ²") || t.length > 40) return;
        if (currency === "USD" && t.includes("$")) {
          const m = t.match(/([\d][\d\s,.]*)\s*\$?\s*\/\s*მ²/i) || t.match(/\$\s*([\d][\d\s,.]*)/);
          if (m) pricePerSqm = parseAmount(m[1] || m[0]);
        }
      });
      if (!pricePerSqm) {
      const numericPrice = parseFloat(price.replace(/[,.\s]/g, ""));
      const numericArea = parseFloat(area.replace(/[^\d.]/g, ""));
      if (numericPrice > 0 && numericArea > 0) {
        pricePerSqm = Math.round(numericPrice / numericArea).toString();
        }
      }

      return {
        title,
        propertyType,
        dealType,
        buildingStatus,
        condition,
        city,
        address,
        street,
        streetNumber,
        cadastralCode,
        price,
        pricePerSqm,
        currency,
        area,
        rooms,
        bedrooms,
        floor,
        totalFloors,
        projectType,
        bathrooms,
        balconyArea,
        verandaArea,
        loggiaArea,
        description,
        images: images.slice(0, 16),
        rawData,
      };
    }, parseParams);

    if (data?.rawData) {
      ensureFurnitureRawData(data.rawData);
    }
    if (data) {
      applyBalconyParsedFields(data);
      applyLoggiaParsedFields(data);
      applyVerandaParsedFields(data);
      applyCeilingHeightParsedFields(data);
      if (data.projectType) {
        data.projectType = dedupeRepeatedLabelValue(data.projectType);
      }
      const rawProject = data.rawData?.["პროექტის ტიპი"];
      if (rawProject) {
        data.rawData["პროექტის ტიპი"] = dedupeRepeatedLabelValue(rawProject);
        if (!data.projectType) data.projectType = data.rawData["პროექტის ტიპი"];
      }
      if (!data.bedrooms && data.rawData?.["საძინებელი"]) {
        data.bedrooms = data.rawData["საძინებელი"].replace(/[^\d]/g, "") || data.rawData["საძინებელი"];
      }
    }

    return { success: true, data };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to parse listing",
    };
  } finally {
    await context.close();
  }
}

async function ensurePostSessionLogin(
    page: Page,
    credentials: MyhomeCredentials
): Promise<void> {
  await page.goto("https://auth.tnet.ge/ka/user/login/?Continue=https://www.myhome.ge/", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await page.waitForSelector('input[name="Email"]', { timeout: 10000 });
  await page.fill('input[name="Email"]', credentials.email);
  await page.fill('input[name="Password"]', credentials.password);
  await page.click('[data-testid="login-form__button-submit"]');
  await page.waitForURL((url) => !url.href.includes("auth.tnet.ge"), {
    timeout: 20000,
  });
}

// Navigate to the photo gallery step and upload images via the hidden file input.
export async function uploadListingImages(
  page: Page,
  imagePaths: string[]
): Promise<void> {
  if (imagePaths.length === 0) return;

  const fileInput = page.locator(
    '.document-uploader input[type="file"][accept*=".webp"]'
  );

  // Try sidebar step for photos / description
  try {
    const photoStep = page
      .locator("button, a, li, [role='button']")
      .filter({ hasText: /ფოტო|აღწერა/ })
      .first();
    if (await photoStep.isVisible({ timeout: 3000 })) {
      await photoStep.click();
      await page.waitForTimeout(1000);
    }
  } catch {
    /* step may already be visible */
  }

  // Fallback: click Next until file input appears
  for (let i = 0; i < 6; i++) {
    if (await fileInput.isVisible({ timeout: 1500 }).catch(() => false)) break;
    const nextBtn = page
      .locator("button")
      .filter({ hasText: /^შემდეგი$/ })
      .first();
    if (await nextBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await nextBtn.click();
      await page.waitForTimeout(800);
    } else {
      break;
    }
  }

  await fileInput.waitFor({ state: "attached", timeout: 15000 });
  await fileInput.setInputFiles(imagePaths.slice(0, 16));

  // Wait for upload previews (thumbnails or img inside uploader)
  await page
    .locator(".document-uploader img, .document-uploader [class*='preview']")
    .first()
    .waitFor({ state: "visible", timeout: 60000 })
    .catch(() => page.waitForTimeout(5000));
}

// Login, navigate to create form, pre-fill fields, and upload photos.
// Visible browser stays open locally; headless mode closes after success (MYHOME_PREFILL_HEADLESS=true).
export async function createMyhomePost(
  credentials: MyhomeCredentials,
  listing: MyhomeListing,
  options: { listingId: string; userId: string }
): Promise<{ success: boolean; postUrl?: string; error?: string }> {
  const reuseSession =
      postSession?.email === credentials.email && postSession.browser.isConnected();

  const headless = process.env.MYHOME_PREFILL_HEADLESS === "true";

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
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      locale: "ka-GE",
    });
    await context.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (type === "media" || type === "font") {
        route.abort();
      } else {
        route.continue();
      }
    });
    page = await context.newPage();
    postSession = { email: credentials.email, browser, context };
  }

  try {
    if (listing.rawData) {
      ensureFurnitureRawData(listing.rawData);
    }

    if (!reuseSession) {
      await ensurePostSessionLogin(page, credentials);
    }

    await page.goto(
      "https://statements.myhome.ge/ka/statement/create?referrer=myhome",
      { waitUntil: "domcontentloaded", timeout: 30000 }
    );
    await page.waitForSelector("#total_price", { timeout: 20000 });
    await dismissBlockingOverlays(page);
    await prefillPause(page, 60);

    // Use DOM manipulation for fast, non-hanging form fill.
    // Chips = leaf span/div elements with exact text, click the rounded parent.
    // Inputs = found via label > span text, filled with React-compatible setter.
    async function fillForm(data: Record<string, string>) {
      await page.evaluate((d) => {
        // React-compatible input value setter
        const inputSetter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, "value"
        )?.set;
        const textareaSetter = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype, "value"
        )?.set;

        function setInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
          const setter = el.tagName === "TEXTAREA" ? textareaSetter : inputSetter;
          if (setter) {
            setter.call(el, value);
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }

        function fillInputByLabel(labelText: string, value: string) {
          if (!value) return;
          let filled = false;
          document.querySelectorAll("label").forEach((label) => {
            if (filled) return;
            const forAttr = label.getAttribute("for");
            // Check ALL spans inside the label, not just the first
            const spans = label.querySelectorAll("span");
            for (const span of spans) {
              const t = span.textContent?.trim()?.replace(/\s*\*\s*$/, "").trim();
              if (t === labelText) {
                const input = forAttr
                  ? (document.getElementById(forAttr) as HTMLInputElement)
                  : (label.querySelector("input") as HTMLInputElement);
                if (input?.tagName === "INPUT") {
                  setInputValue(input, value);
                  filled = true;
                }
                break;
              }
            }
          });
        }

        if (d.price) {
          const priceInput = document.getElementById("total_price") as HTMLInputElement;
          if (priceInput) setInputValue(priceInput, d.price.replace(/[^\d.]/g, ""));
        }

        if (d.pricePerSqm) {
          fillInputByLabel("კვ. ფასი", d.pricePerSqm.replace(/[^\d.]/g, ""));
        }

        fillInputByLabel("ფართი", d.area);

        fillInputByLabel("სართული", d.floor);
        fillInputByLabel("სართულები სულ", d.totalFloors);

        function chipVariants(value: string): string[] {
          const digits = value.replace(/[^\d]/g, "");
          if (!digits) return [value.trim()].filter(Boolean);
          const n = parseInt(digits, 10);
          const list = [String(n), `${n}+`];
          if (n >= 10) list.push("10+");
          return list;
        }

        function clickCountInRow(rowLabels: string[], value: string): boolean {
          if (!value?.trim()) return false;
          const variants = chipVariants(
            value === "10" ? "10+" : value.trim()
          );

          function norm(s: string) {
            return (s || "").replace(/\s*\*\s*$/, "").trim().replace(/\s+/g, " ");
          }

          function rowLabelMatches(text: string): boolean {
            const t = norm(text);
            if (!t || t.length > 45) return false;
            for (const label of rowLabels) {
              const l = norm(label);
              if (t === l) return true;
              if (t.includes("სვ") && t.includes("წერტილი")) return true;
              if (/^საძინებელი/i.test(l) && /^საძინებელი/i.test(t)) return true;
            }
            return false;
          }

          function tryGluedCountChip(parent: Element | null, re: RegExp): boolean {
            if (!parent) return false;
            const joined = (parent.textContent || "").replace(/\s+/g, "");
            const glued = joined.match(re);
            if (!glued) return false;
            const digit = glued[1];
            if (!variants.some((v) => v === digit || v.replace(/\+$/, "") === digit)) {
              return false;
            }
            for (const el of parent.querySelectorAll("span,motion.div,motion.div,div,button,p")) {
              if (el.children.length > 0) continue;
              const t = norm(el.textContent || "");
              if (t === digit || t === `${digit}+` || variants.includes(t)) {
                const chip = (el.closest("[class*='rounded']") || el) as HTMLElement;
                chip.click();
                return true;
              }
            }
            return false;
          }

          function digitCount(node: Element): number {
            let n = 0;
            node.querySelectorAll("span,motion.div,div,button,p").forEach((el) => {
              if (el.children.length > 0) return;
              if (/^\d+\+?$/.test(norm(el.textContent || ""))) n++;
            });
            return n;
          }

          let row: Element | null = null;
          for (const el of document.querySelectorAll("label,span,p,motion.div,div")) {
            if (!rowLabelMatches(el.textContent || "")) continue;
            const parent = el.parentElement;
            if (rowLabels.some((l) => /^საძინებელი/i.test(l))) {
              if (tryGluedCountChip(parent, /^საძინებელი(\d+)$/iu)) return true;
            }
            if (rowLabels.some((l) => l.includes("სვ"))) {
              if (tryGluedCountChip(parent, /^სვ[.\s]*წერტილი(?:ები)?(\d+)$/iu)) {
                return true;
              }
            }
            let node: Element | null = el;
            for (let depth = 0; depth < 14 && node; depth++) {
              if (digitCount(node) >= 2) {
                row = node;
                break;
              }
              node = node.parentElement;
            }
            if (row) break;
          }
          if (!row) return false;

          let clicked = false;
          for (const el of row.querySelectorAll("span,motion.div,div,button,p")) {
            if (clicked) break;
            if (el.children.length > 0) continue;
            const t = norm(el.textContent || "");
            if (!variants.includes(t)) {
              const tm = t.match(/^(\d+)\+?$/);
              if (!tm || !variants.some((v) => v.match(/^(\d+)/)?.[1] === tm[1])) {
                continue;
              }
            }
            const chip = (el.closest("[class*='rounded']") || el) as HTMLElement;
            chip.click();
            clicked = true;
          }
          return clicked;
        }

        if (d.rooms) {
          clickCountInRow(["ოთახი", "ოთახები"], d.rooms);
        }
        if (d.bedrooms) {
          clickCountInRow(["საძინებელი", "საძინებლები"], d.bedrooms);
        }
        if (d.bathrooms) {
          clickCountInRow(
            [
              "სვ.წერტილი",
              "სვ.წერტილები",
              "სველი წერტილი",
              "სველი წერტილები",
            ],
            d.bathrooms
          );
        }

        // Description
        if (d.description) {
          const ta = document.querySelector(
            'textarea[placeholder*="დამატებითი აღწერა"]'
          ) as HTMLTextAreaElement;
          if (ta) setInputValue(ta, d.description);
        }
      }, data);
    }

    const empty = {
      propertyType: "",
      dealType: "",
      buildingStatus: "",
      condition: "",
      city: "",
      street: "",
      streetNumber: "",
      cadastralCode: "",
      price: "",
      pricePerSqm: "",
      currency: "",
      area: "",
      rooms: "",
      floor: "",
      totalFloors: "",
      bathrooms: "",
      description: "",
    };

    await batchPrefillChips(page, buildEarlyFormChipTasks(listing));

    await fillLocationFields(page, listingLocation(listing));

    await switchPriceFieldToUsd(page, "#total_price");
    await prefillPause(page);

    const bedroomsForForm = getBedroomsValue(listing);
    const bathroomsForForm = getBathroomsValue(listing);

    await fillForm({
      ...empty,
      price: listing.price,
      pricePerSqm: listing.pricePerSqm,
      currency: "USD",
      area: listing.area,
      rooms: listing.rooms,
      bedrooms: bedroomsForForm,
      bathrooms: bathroomsForForm,
      floor: listing.floor,
      totalFloors: listing.totalFloors,
      description: listing.description,
    });

    await page
      .waitForFunction(
        () => {
          const t = document.body?.innerText || "";
          return t.includes("ოთახი") || t.includes("საძინებელი");
        },
        { timeout: 12000 }
      )
      .catch(() => {});

    if (listing.rooms) {
      await prefillCountChipPlaywright(page, CHIP_SECTION_ALIASES["ოთახი"], listing.rooms);
    }
    if (bedroomsForForm) {
      await scrollToFormField(page, "საძინებელი");
      await prefillCountChipPlaywright(
        page,
        CHIP_SECTION_ALIASES["საძინებელი"],
        bedroomsForForm
      );
    }
    if (bathroomsForForm) {
      await prefillCountChipPlaywright(
        page,
        CHIP_SECTION_ALIASES["სველი წერტილი"],
        bathroomsForForm
      );
    }

    await expandCreateFormSections(page);
    await prefillPause(page, 80);

    if (bedroomsForForm) {
      await scrollToFormField(page, "საძინებელი");
      await prefillRowCountChip(
        page,
        CHIP_SECTION_ALIASES["საძინებელი"],
        bedroomsForForm
      );
    }

    await prefillMainCountChips(page, listing);

    await applyAdditionalParametersPrefill(page, listing);

    // Upload images to photo gallery
    if (listing.images.length > 0) {
      const { paths, cleanup } = await resolveImagesForPlaywright(
        listing.images,
        options.listingId,
        options.userId
      );
      try {
        if (paths.length > 0) {
          await uploadListingImages(page, paths);
        }
      } finally {
        await cleanup();
      }
    }

    const postUrl = page.url();

    if (headless) {
      await browser.close();
    }

    return { success: true, postUrl };
  } catch (error) {
    if (headless) {
      await browser.close().catch(() => undefined);
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to create post",
    };
  }
  // Non-headless: browser stays open for user review (no finally close)
}
