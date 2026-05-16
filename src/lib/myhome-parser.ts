import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import {
  ADDITIONAL_PARAM_LABELS,
  CHIP_ROW_PARAM_LABELS,
  FURNITURE_LABELS,
  LABEL_CANONICAL,
  PREFERENCE_PARAM_LABELS,
  PREFILL_NUMERIC_LABELS,
  RAW_DATA_HANDLED_LABELS,
} from "@/lib/additional-params";

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
            "button, [role='button'], div[class*='rounded'], label[class*='rounded']"
          );
          if (chips.length >= 2) return child;
        }
        return null;
      }

      function labelsMatch(text: string, label: string): boolean {
        const t = norm(text);
        const l = norm(label);
        if (t === l) return true;
        if (l === "სვ.წერტილი" && t.startsWith("სველი წერტილი")) return true;
        if (t.startsWith("სველი წერტილი") && l === "სველი წერტილი") return true;
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
  "გათბომა",
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
    const v = listing.rawData?.[label]?.trim();
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
      if (t === l) return true;
      if (l === "სვ.წერტილი" && t.startsWith("სველი წერტილი")) return true;
      if (t === "სვ.წერტილი" && l.startsWith("სველი წერტილი")) return true;
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
      "გათბომა",
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
        return clickLeafChips({ textContent: glued[1] } as Element);
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

      function clickLeafChips(root: Element): boolean {
        let clicked = false;
        for (const el of root.querySelectorAll(
          "span,div,button,p,label,motion.div,motion.span,motion.p"
        )) {
          if (clicked) break;
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
          target.click();
          clicked = true;
        }
        return clicked;
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

        let node: Element | null = el;
        for (let depth = 0; depth < 14 && node; depth++) {
          if (countDigitLeaves(node) >= 2 && clickLeafChips(node)) return true;
          node = node.parentElement;
        }

        let sib: Element | null = el.nextElementSibling;
        for (let i = 0; i < 6 && sib; i++) {
          if (countDigitLeaves(sib) >= 2 && clickLeafChips(sib)) return true;
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

  for (const label of sectionLabels) {
    const labelRe = new RegExp(label.replace(/\./g, "\\."), "iu");
    const row = page
      .locator("label, div, span, p")
      .filter({ hasText: labelRe })
      .filter({ hasNotText: /ოთახი|საძინებელი|ფართი|სართული/i })
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
    await prefillRowCountChip(page, CHIP_SECTION_ALIASES["საძინებელი"], bedrooms);
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
      const inputSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      )?.set;
      if (!inputSetter) return;
      document.querySelectorAll("label").forEach((lbl) => {
        for (const span of lbl.querySelectorAll("span")) {
          const t = span.textContent?.trim()?.replace(/\s*\*\s*$/, "").trim();
          if (t !== labelText) continue;
          const forAttr = lbl.getAttribute("for");
          const input = forAttr
            ? (document.getElementById(forAttr) as HTMLInputElement)
            : (lbl.querySelector("input") as HTMLInputElement);
          if (input) {
            inputSetter.call(input, val);
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
          }
          return;
        }
      });
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
async function clickOpenDropdownOption(page: Page, value: string): Promise<boolean> {
  const clicked = await page.evaluate((optionText) => {
    function norm(s: string) {
      return s.replace(/\s*\*\s*$/, "").trim();
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
      if (t.length > 400 || t.length < optionText.length) return;
      if (!t.includes(optionText)) return;
      const itemCount = el.querySelectorAll("li, [class*='item'], [role='option']").length;
      if (itemCount < 1) return;
      roots.push(el);
    });

    const tryInRoot = (root: Element): boolean => {
      for (const el of root.querySelectorAll("li, div, span, button, a, p")) {
        if (el.children.length > 4) continue;
        const t = norm(el.textContent || "");
        if (t !== optionText) continue;
        if (tryClick(el)) return true;
      }
      for (const el of root.querySelectorAll("li, div, span, button, a, p")) {
        if (el.children.length > 4) continue;
        const t = norm(el.textContent || "");
        if (!t.includes(optionText) || t.length > 80) continue;
        if (tryClick(el)) return true;
      }
      return false;
    };

    for (const root of roots) {
      if (tryInRoot(root)) return true;
    }
    return false;
  }, value);

  if (clicked) return true;

  const optionLoc = page.locator(
    "[role='listbox'] [role='option'], [role='option'], [class*='option'], [class*='menu-item'], [class*='luk-custom-select'] li, [class*='luk-custom-select'] div"
  );

  const exact = optionLoc
    .filter({ hasText: new RegExp(`^${escapeRegExp(value)}$`, "u") })
    .filter({ visible: true })
    .first();
  if (await exact.isVisible({ timeout: 800 }).catch(() => false)) {
    await exact.click({ timeout: CHIP_CLICK_TIMEOUT_MS });
    return true;
  }

  const partial = optionLoc.filter({ hasText: value }).filter({ visible: true }).first();
  if (await partial.isVisible({ timeout: 800 }).catch(() => false)) {
    await partial.click({ timeout: CHIP_CLICK_TIMEOUT_MS });
    return true;
  }

  const byText = page.getByText(value, { exact: true }).filter({ visible: true }).last();
  if (await byText.isVisible({ timeout: 800 }).catch(() => false)) {
    await byText.click();
    return true;
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
          if (norm(el.textContent || "") !== label) continue;
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

  try {
    const marked = await page.evaluate(
      ({ sectionLabel, placeholder }) => {
        function norm(s: string) {
          return s.replace(/\s*\*\s*$/, "").trim();
        }

        function findFieldContainer(label: string): Element | null {
        const nodes = document.querySelectorAll("label, span, p, div, h2, h3, h4");
        for (const el of nodes) {
          if (norm(el.textContent || "") !== label) continue;
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

      document.querySelectorAll("[data-prefill-list-trigger]").forEach((el) => {
        el.removeAttribute("data-prefill-list-trigger");
      });

      const root = findFieldContainer(sectionLabel);
      if (!root) return false;

      const trigger =
        root.querySelector(".luk-custom-select") ||
        root.querySelector("[role='combobox']") ||
        root.querySelector("[aria-haspopup='listbox']") ||
        root.querySelector("select") ||
        Array.from(root.querySelectorAll("button, div")).find((el) => {
          if (!placeholder) return false;
          return norm(el.textContent || "").includes(placeholder);
        });

      if (!trigger) return false;
      trigger.setAttribute("data-prefill-list-trigger", "1");
      return true;
    },
    { sectionLabel, placeholder: placeholder || "" }
  );

  if (marked) {
    const opened = await page.evaluate(() => {
      const t = document.querySelector(
        "[data-prefill-list-trigger='1']"
      ) as HTMLElement | null;
      if (!t) return false;
      t.click();
      return true;
    });
    if (!opened) {
      await page
        .locator("[data-prefill-list-trigger='1']")
        .first()
        .click({ timeout: CHIP_CLICK_TIMEOUT_MS })
        .catch(() => {});
    }
  } else {
    const section = page
      .locator("label, span, p")
      .filter({
        hasText: new RegExp(`^${escapeRegExp(sectionLabel)}\\s*\\*?$`, "u"),
      })
      .first();
    const trigger = section
      .locator("xpath=ancestor::*[.//div[contains(@class,'luk-custom-select')]][1]")
      .locator(".luk-custom-select")
      .first();
    await trigger.click({ timeout: CHIP_CLICK_TIMEOUT_MS }).catch(async () => {
      await page
        .locator(".luk-custom-select")
        .filter({ hasText: placeholder || sectionLabel })
        .first()
        .click({ timeout: CHIP_CLICK_TIMEOUT_MS });
    });
  }

    await page.evaluate(() => {
      document.querySelectorAll("[data-prefill-dropdown-open]").forEach((el) => {
        el.removeAttribute("data-prefill-dropdown-open");
      });

      function markMenu(menu: Element | null) {
        if (menu) menu.setAttribute("data-prefill-dropdown-open", "1");
      }

      const t = document.querySelector("[data-prefill-list-trigger='1']");
      if (t) {
        let menu =
          t.nextElementSibling ||
          t.parentElement?.querySelector(
            '[class*="dropdown"], [class*="menu"], [class*="options"], ul'
          );
        if (!menu) {
          const root = t.closest("[class*='luk-custom-select']")?.parentElement;
          menu =
            root?.querySelector(
              '[class*="dropdown"], [class*="menu"], ul, [class*="open"]'
            ) || null;
        }
        markMenu(menu);
      }

      document.querySelectorAll("[class*='luk-custom-select']").forEach((el) => {
        const cls = el.className?.toString() || "";
        if (!cls.includes("open")) return;
        markMenu(
          el.querySelector('[class*="dropdown"], [class*="menu"], ul') || el
        );
      });
    });

    await prefillPause(page, DROPDOWN_PAUSE_MS);

    const selected = await clickOpenDropdownOption(page, value);
    if (!selected) {
      throw new Error(`Could not select "${value}" for ${sectionLabel}`);
    }
  } finally {
    await page.evaluate(() => {
      document.querySelectorAll("[data-prefill-list-trigger]").forEach((el) => {
        el.removeAttribute("data-prefill-list-trigger");
      });
    });
    if (closeDropdowns) await closeOpenDropdowns(page);
  }
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
  { labels: ["ჭერის სიმაღლე"], getValue: (l) => l.rawData?.["ჭერის სიმაღლე"] || "" },
  {
    labels: ["აივანი"],
    getValue: (l) => l.balconyArea || l.rawData?.["აივანი"] || "",
  },
  { labels: ["ლოჯია"], getValue: (l) => l.loggiaArea || l.rawData?.["ლოჯია"] || "" },
  {
    labels: ["ვერანდა"],
    getValue: (l) => l.verandaArea || l.rawData?.["ვერანდა"] || "",
  },
];

const PREFILL_LIST_FIELDS: {
  labels: string[];
  getValue: (l: MyhomeListing) => string;
  placeholder?: string;
}[] = [
  {
    labels: ["გათბობა"],
    getValue: (l) => l.rawData?.["გათბობა"] || "",
  },
  { labels: ["პარკირება"], getValue: (l) => l.rawData?.["პარკირება"] || "" },
  { labels: ["ცხელი წყალი"], getValue: (l) => l.rawData?.["ცხელი წყალი"] || "" },
  {
    labels: ["სამშენებლო მასალა"],
    getValue: (l) => l.rawData?.["სამშენებლო მასალა"] || "",
  },
  { labels: ["მისაღები"], getValue: (l) => l.rawData?.["მისაღები"] || "" },
  { labels: ["სათავსო"], getValue: (l) => l.rawData?.["სათავსო"] || "" },
  {
    labels: ["სათავსოს ტიპი"],
    getValue: (l) => l.rawData?.["სათავსოს ტიპი"] || "",
  },
  { labels: ["ხედი"], getValue: (l) => l.rawData?.["ხედი"] || "" },
  { labels: ["შესასვლელი"], getValue: (l) => l.rawData?.["შესასვლელი"] || "" },
  {
    labels: ["პროექტის ტიპი"],
    getValue: (l) => getProjectTypeValue(l),
    placeholder: "აირჩიეთ პროექტის ტიპი",
  },
];

async function prefillProjectTypeDropdown(
  page: Page,
  listing: MyhomeListing
): Promise<void> {
  const value = getProjectTypeValue(listing);
  if (!value) return;

  try {
    await selectListOptionInSection(
      page,
      "პროექტის ტიპი",
      value,
      "აირჩიეთ პროექტის ტიპი"
    );
    return;
  } catch {
    await closeOpenDropdowns(page);
  }

  const picked = await page.evaluate((optionText) => {
    function norm(s: string) {
      return (s || "").replace(/\s+/g, " ").trim();
    }
    const target = norm(optionText);
    if (!target) return false;

    function findFieldContainer(label: string): Element | null {
      for (const el of document.querySelectorAll("label, span, p, div, h2, h3, h4")) {
        const t = norm(el.textContent || "");
        if (t !== label && !t.startsWith(label)) continue;
        let node: Element | null = el;
        for (let depth = 0; depth < 10 && node; depth++) {
          if (
            node.querySelector(
              ".luk-custom-select, [role='combobox'], [aria-haspopup='listbox']"
            )
          ) {
            return node;
          }
          node = node.parentElement;
        }
      }
      return null;
    }

    const root = findFieldContainer("პროექტის ტიპი");
    if (!root) return false;

    const trigger =
      root.querySelector(".luk-custom-select") ||
      root.querySelector("[role='combobox']") ||
      root.querySelector("[aria-haspopup='listbox']");
    if (!trigger) return false;
    (trigger as HTMLElement).click();

    const options = document.querySelectorAll(
      "[role='option'], [class*='option'], [class*='menu-item'], li, button, div, span"
    );
    for (const el of options) {
      const t = norm(el.textContent || "");
      if (!t) continue;
      if (t === target || t.includes(target) || target.includes(t)) {
        (el as HTMLElement).click();
        return true;
      }
    }
    return false;
  }, value);

  if (!picked) {
    await page
      .getByText(value, { exact: false })
      .filter({ visible: true })
      .last()
      .click({ timeout: CHIP_CLICK_TIMEOUT_MS, force: true })
      .catch(() => {});
  }
  await closeOpenDropdowns(page);
}

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
  await expandAllParameterSections(page);
  await page
    .locator("h2,h3,h4")
    .filter({ hasText: /ავეჯი/i })
    .first()
    .scrollIntoViewIfNeeded()
    .catch(() => {});
  await batchPrefillChips(page, buildPostExpandChipTasks(listing));
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

  await prefillProjectTypeDropdown(page, listing);

  await closeOpenDropdowns(page);
  for (const field of PREFILL_LIST_FIELDS) {
    if (field.labels.some((l) => CHIP_STYLE_SET.has(l))) continue;
    if (field.labels.includes("პროექტის ტიპი")) continue;
    const value = field.getValue(listing)?.trim();
    if (!value) continue;
    for (const label of field.labels) {
      try {
        await selectListOptionInSection(page, label, value, field.placeholder, {
          closeDropdowns: false,
        });
        break;
      } catch {
        /* try alias label */
      }
    }
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
        if (canon === "პროექტის ტიპი" || PREFERENCE_LABELS.has(canon)) {
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

// Open a visible browser, login, navigate to create form, and pre-fill all fields.
// The browser stays open for the user to review and submit manually.
export async function createMyhomePost(
  credentials: MyhomeCredentials,
  listing: MyhomeListing
): Promise<{ success: boolean; postUrl?: string; error?: string }> {
  const reuseSession =
    postSession?.email === credentials.email && postSession.browser.isConnected();

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
      headless: false,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      locale: "ka-GE",
    });
    await context.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (type === "image" || type === "media" || type === "font") {
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

    await prefillRowCountChip(
      page,
      CHIP_SECTION_ALIASES["სველი წერტილი"],
      bathroomsForForm
    );

    await page
      .getByRole("button", { name: "ყველა პარამეტრი" })
      .click({ timeout: CHIP_CLICK_TIMEOUT_MS })
      .catch(() => expandAllParameterSections(page));
    await prefillPause(page, 80);
    await prefillMainCountChips(page, listing);

    await applyAdditionalParametersPrefill(page, listing);

    // Browser stays open for user review
    return {
      success: true,
      postUrl: page.url(),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to create post",
    };
  }
  // No finally block -- browser stays open intentionally
}
