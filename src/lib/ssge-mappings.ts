/**
 * Translation tables for prefilling the ss.ge create-listing form
 * (https://home.ss.ge/ka/udzravi-qoneba/create) from a `MyhomeListing`.
 *
 * MyHome and ss.ge use Georgian labels that mostly overlap, but in a few cases
 * the chip text differs slightly. Centralising the mappings here keeps
 * `ssge-parser.ts` purely about Playwright wiring.
 */

/** Property type chip text on ss.ge keyed by the value stored in MyhomeListing.propertyType. */
export const PROPERTY_TYPE_TO_SSGE: Record<string, string> = {
  "ბინა": "ბინა",
  "კერძო სახლი": "კერძო სახლი",
  "აგარაკი": "აგარაკი",
  "მიწის ნაკვეთი": "მიწის ნაკვეთი",
  "კომერციული ფართი": "კომერციული",
  "კომერციული": "კომერციული",
  "სასტუმრო": "სასტუმრო",
};

/** Deal type chip text on ss.ge keyed by MyhomeListing.dealType. */
export const DEAL_TYPE_TO_SSGE: Record<string, string> = {
  "იყიდება": "იყიდება",
  "ქირავდება": "ქირავდება",
  "ქირავდება დღიურად": "ქირავდება დღიურად",
  "გირავდება": "გირავდება",
};

/**
 * Step 5 (დამატებითი ინფორმაცია → სტატუსი*) on ss.ge mirrors MyHome's
 * `buildingStatus` field.
 */
export const BUILDING_STATUS_TO_SSGE: Record<string, string> = {
  "ახალი აშენებული": "ახალი აშენებული",
  "მშენებარე": "მშენებარე",
  "ძველი აშენებული": "ძველი აშენებული",
};

/**
 * Land plot status (სტატუსი) — ss.ge chips end with „მიწა“; myhome uses shorter labels.
 * Cross-prefill maps equivalent values in both directions.
 */
export const LAND_PLOT_STATUS_SSGE_TO_MYHOME: Record<string, string> = {
  "სასოფლო-სამეურნეო მიწა": "სასოფლო-სამეურნეო",
  "არასასოფლო-სამეურნეო მიწა": "არა სასოფლო-სამეურნეო",
  "კომერციული მიწა": "კომერციული",
  "სპეციალური მიწა": "სპეციალური",
  "საინვესტიციო მიწა": "საინვესტიციო",
  "ფერმერული მიწა": "ფერმა",
};

export const LAND_PLOT_STATUS_MYHOME_TO_SSGE: Record<string, string> = {
  "სასოფლო-სამეურნეო": "სასოფლო-სამეურნეო მიწა",
  "არა სასოფლო-სამეურნეო": "არასასოფლო-სამეურნეო მიწა",
  კომერციული: "კომერციული მიწა",
  სპეციალური: "სპეციალური მიწა",
  საინვესტიციო: "საინვესტიციო მიწა",
  ფერმა: "ფერმერული მიწა",
};

/** ss.ge create-form chip label for any known land-status variant. */
export const LAND_PLOT_STATUS_TO_SSGE: Record<string, string> = {
  ...Object.fromEntries(
    Object.keys(LAND_PLOT_STATUS_SSGE_TO_MYHOME).map((k) => [k, k])
  ),
  ...LAND_PLOT_STATUS_MYHOME_TO_SSGE,
};

/** ss.ge API `applicationData.landType` → create-form chip label. */
export const SSGE_LAND_TYPE_BY_ID: Record<number, string> = {
  1: "სასოფლო-სამეურნეო მიწა",
  2: "არასასოფლო-სამეურნეო მიწა",
  3: "კომერციული მიწა",
  4: "სპეციალური მიწა",
  5: "საინვესტიციო მიწა",
  6: "ფერმერული მიწა",
};

function compactLandPlotStatus(s: string): string {
  return s.replace(/\s+/g, "").replace(/მიწა$/gi, "").toLowerCase();
}

function lookupLandPlotByCompact<T extends string>(
  value: string,
  table: Record<string, T>
): T | "" {
  const v = value.replace(/\s+/g, " ").trim();
  if (!v) return "";
  if (table[v]) return table[v];
  const c = compactLandPlotStatus(v);
  for (const [key, mapped] of Object.entries(table)) {
    if (compactLandPlotStatus(key) === c) return mapped;
  }
  return "";
}

/** myhome.ge მიწის ნაკვეთი / სტატუსი chip label. */
export function mapLandPlotStatusForMyhome(value: string): string {
  const mapped = lookupLandPlotByCompact(value, LAND_PLOT_STATUS_SSGE_TO_MYHOME);
  if (mapped) return mapped;
  if (LAND_PLOT_STATUS_MYHOME_TO_SSGE[value.trim()]) return value.trim();
  return value.replace(/\s+/g, " ").trim();
}

/** ss.ge create-form land status chip label. */
export function mapLandPlotStatusForSsge(value: string): string {
  const mapped = lookupLandPlotByCompact(value, LAND_PLOT_STATUS_MYHOME_TO_SSGE);
  if (mapped) return mapped;
  if (LAND_PLOT_STATUS_SSGE_TO_MYHOME[value.trim()]) return value.trim();
  return value.replace(/\s+/g, " ").trim();
}

export function isKnownLandPlotStatus(value: string | undefined | null): boolean {
  const v = value?.trim() || "";
  if (!v) return false;
  if (LAND_PLOT_STATUS_TO_SSGE[v]) return true;
  return !!lookupLandPlotByCompact(v, LAND_PLOT_STATUS_SSGE_TO_MYHOME);
}

/** Resolve listing status / land type → ss.ge სტატუსი chip text. */
export function resolveSsgeStatusChip(
  value: string,
  propertyType?: string
): string {
  const v = value.replace(/\s+/g, " ").trim();
  if (!v) return "";

  const ssgeLand = mapLandPlotStatusForSsge(v);
  if (isKnownLandPlotStatus(v)) return ssgeLand;

  if (BUILDING_STATUS_TO_SSGE[v]) return BUILDING_STATUS_TO_SSGE[v];

  const isLand =
    /მიწის\s*ნაკვეთი/i.test(propertyType || "") || /მიწა$/i.test(v);
  if (isLand) {
    for (const label of Object.keys(LAND_PLOT_STATUS_SSGE_TO_MYHOME)) {
      if (v === label || v.includes(label) || label.includes(v)) return label;
    }
  }

  return v;
}

/**
 * Step 5 (დამატებითი ინფორმაცია → მდგომარეობა) on ss.ge mirrors MyHome's
 * `condition` field.
 */
/** ss.ge create form chip labels (step 5 → მდგომარეობა). */
export const CONDITION_TO_SSGE: Record<string, string> = {
  "გარემონტებული": "გარემონტებული",
  "ახალი გარემონტებული": "ახალი რემონტით",
  "ძველი გარემონტებული": "ძველი რემონტით",
  "ახალი რემონტი": "ახალი რემონტით",
  "ძველი რემონტი": "ძველი რემონტით",
  "ახალი რემონტით": "ახალი რემონტით",
  "ძველი რემონტით": "ძველი რემონტით",
  "მიმდინარე რემონტი": "მიმდინარე რემონტი",
  "სარემონტო": "სარემონტო",
  "თეთრი კარკასი": "თეთრი კარკასი",
  "შავი კარკასი": "შავი კარკასი",
  "მწვანე კარკასი": "მწვანე კარკასი",
};

/** Resolve parsed/listing condition text → ss.ge create-form chip label. */
export function resolveSsgeConditionChip(value: string): string {
  const v = value.trim();
  if (!v) return "";
  if (CONDITION_TO_SSGE[v]) return CONDITION_TO_SSGE[v];
  if (/გარემონტებული/i.test(v)) {
    if (/ახალი/i.test(v)) return CONDITION_TO_SSGE["ახალი გარემონტებული"];
    if (/ძველი/i.test(v)) return CONDITION_TO_SSGE["ძველი გარემონტებული"];
    return CONDITION_TO_SSGE["გარემონტებული"];
  }
  if (/რემონტ/i.test(v)) {
    if (/ახალი/i.test(v)) return CONDITION_TO_SSGE["ახალი რემონტით"];
    if (/ძველი/i.test(v)) return CONDITION_TO_SSGE["ძველი რემონტით"];
    if (/მიმდინარე/i.test(v)) return CONDITION_TO_SSGE["მიმდინარე რემონტი"];
  }
  return "";
}

/** Fallback when parse has no project type or value is not on ss.ge / myhome forms. */
export const DEFAULT_PROJECT_TYPE = "არასტანდარტული";

/** myhome.ge პროექტის ტიპი dropdown options (sync with myhome-parser PROJECT_TYPE_ALIASES). */
export const MYHOME_PROJECT_TYPE_LABELS = new Set([
  "არასტანდარტული",
  "თუხარელის",
  "იტალიური ეზო",
  "ლენინგრადის",
  "ყავლაშვილის",
  "ჩეხური",
  "ხრუშოვის",
  "საერთო საცხოვრებელი",
  "დუპლექსი",
  "ტრიპლექსი",
  "m2-ის კომპლექსი",
  "OPTIMA m2-ისკან",
  "METRA PARK",
]);

function normProjectLabel(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Sync with myhome-parser PROJECT_TYPE_ALIASES. */
const MYHOME_PROJECT_TYPE_ALIASES: Record<string, string[]> = {
  "არასტანდარტული": ["არასტანდარტული"],
  "თუხარელის": ["თუხარელის", "თუხარელი"],
  "იტალიური ეზო": ["იტალიური ეზო", "თბილისური ეზო"],
  "ლენინგრადის": ["ლენინგრადის", "ლენინგრადი"],
  "ყავლაშვილის": ["ყავლაშვილის", "ყავლაშვილი"],
  "ჩეხური": ["ჩეხური"],
  "ხრუშოვის": ["ხრუშოვის", "ხრუშოვი", "ხრუშოვკა"],
  "საერთო საცხოვრებელი": ["საერთო საცხოვრებელი"],
  "დუპლექსი": ["დუპლექსი", "დუპლექს"],
  "ტრიპლექსი": ["ტრიპლექსი", "ტრიპლექს"],
  "m2-ის კომპლექსი": [
    "m2-ის კომპლექსი",
    "m2 კომპლექსი",
    "m2-ს კომპლექსი",
    "მ2 დეველოპმენტ",
    "მ2 დეველოპმენტი",
    "m2 დეველოპმენტ",
    "m2 დეველოპმენტი",
    "M2 დეველოპმენტ",
    "M2 დეველოპმენტი",
  ],
  "OPTIMA m2-ისკან": ["OPTIMA m2-ისკან", "optima m2-ისკან", "ოპტიმა m2"],
  "METRA PARK": [
    "METRA PARK",
    "metra park",
    "მეტრა პარკი",
    "METRA PARK (მეტრა პარკი)",
    "metra park (მეტრა პარკი)",
  ],
};

function projectTypeParseCandidates(raw: string): string[] {
  const v = normProjectLabel(raw);
  if (!v) return [];
  const out = new Set<string>([v]);
  const paren = v.match(/^(.+?)\s*\(([^)]+)\)\s*$/u);
  if (paren) {
    out.add(paren[1].trim());
    out.add(paren[2].trim());
  }
  const stripped = v.replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();
  if (stripped) out.add(stripped);
  return [...out];
}

function resolveMyhomeProjectTypeFromAliases(raw: string): string | null {
  for (const candidate of projectTypeParseCandidates(raw)) {
    const lower = candidate.toLowerCase();
    for (const [option, aliases] of Object.entries(MYHOME_PROJECT_TYPE_ALIASES)) {
      if (option.toLowerCase() === lower) return option;
      for (const alias of aliases) {
        if (alias.toLowerCase() === lower) return option;
      }
    }
  }
  return null;
}

function isKnownSsgeProjectLabel(value: string): boolean {
  const v = normProjectLabel(value);
  if (!v) return false;
  if (PROJECT_TYPE_TO_SSGE[v]) return true;
  if (PROJECT_TYPE_SUBSET.includes(v as (typeof PROJECT_TYPE_SUBSET)[number])) {
    return true;
  }
  return Object.values(PROJECT_TYPE_TO_SSGE).some(
    (label) => v === label || v.includes(label) || label.includes(v)
  );
}

function isKnownMyhomeProjectLabel(value: string): boolean {
  const v = normProjectLabel(value);
  if (!v) return false;
  if (MYHOME_PROJECT_TYPE_LABELS.has(v)) return true;
  if (isKnownSsgeProjectLabel(v)) return true;
  return false;
}

/** Canonical project label for storage + prefill (defaults to არასტანდარტული). */
export function resolveProjectTypeCanonical(
  projectType: string,
  rawData: Record<string, string> = {}
): string {
  const candidates = [
    projectType?.trim(),
    rawData["პროექტის ტიპი"]?.trim(),
    rawData["პროექტი"]?.trim(),
  ].filter(Boolean) as string[];

  for (const raw of candidates) {
    const fromAlias = resolveMyhomeProjectTypeFromAliases(raw);
    if (fromAlias) return fromAlias;

    const v = normProjectLabel(raw);
    if (PROJECT_TYPE_TO_SSGE[v]) return PROJECT_TYPE_TO_SSGE[v];
    if (PROJECT_TYPE_SUBSET.includes(v as (typeof PROJECT_TYPE_SUBSET)[number])) {
      return v;
    }
    if (MYHOME_PROJECT_TYPE_LABELS.has(v)) return v;
  }

  return DEFAULT_PROJECT_TYPE;
}

/** Write canonical project type into rawData; returns value used. */
export function applyProjectTypeDefaults(
  rawData: Record<string, string>,
  projectType: string,
  options?: { propertyType?: string }
): string {
  const pt = (options?.propertyType || "").trim();
  const hasParsedProject = [
    projectType,
    rawData["პროექტის ტიპი"],
    rawData["პროექტი"],
  ].some((s) => s?.trim());

  if (/მიწის\s*ნაკვეთი/i.test(pt) && !hasParsedProject) {
    return "";
  }

  const canonical = resolveProjectTypeCanonical(projectType, rawData);
  if (/მიწის\s*ნაკვეთი/i.test(pt) && canonical === DEFAULT_PROJECT_TYPE) {
    return "";
  }

  rawData["პროექტი"] = canonical;
  rawData["პროექტის ტიპი"] = canonical;
  return canonical;
}

/** Resolve parsed/listing project (პროექტი / პროექტის ტიპი) → ss.ge chip. */
export function resolveSsgeProjectChip(
  projectType: string,
  rawData: Record<string, string> = {}
): string {
  const canonical = resolveProjectTypeCanonical(projectType, rawData);
  if (PROJECT_TYPE_TO_SSGE[canonical]) return PROJECT_TYPE_TO_SSGE[canonical];
  if (
    PROJECT_TYPE_SUBSET.includes(
      canonical as (typeof PROJECT_TYPE_SUBSET)[number]
    )
  ) {
    return canonical;
  }
  if (isKnownSsgeProjectLabel(canonical)) {
    for (const [key, label] of Object.entries(PROJECT_TYPE_TO_SSGE)) {
      if (canonical === key || canonical === label) return label;
    }
    return canonical;
  }
  return DEFAULT_PROJECT_TYPE;
}

/**
 * Step 4 (`დეტალური ინფორმაცია` → "სართულის ტიპი" / "პროექტის ტიპი" chip-row).
 * Only this subset of values clicks a chip; anything else falls through to the
 * full project list in step 5.
 */
export const PROJECT_TYPE_SUBSET = ["დუპლექსი", "ტრიპლექსი", "სხვენი"] as const;

/**
 * Step 5 (`დამატებითი ინფორმაცია` → "პროექტი") full chip list.
 * MyHome uses a few alternate spellings — accept both keys but emit ss.ge label.
 */
export const PROJECT_TYPE_TO_SSGE: Record<string, string> = {
  "დუპლექსი": "დუპლექსი",
  "ტრიპლექსი": "ტრიპლექსი",
  "სხვენი": "სხვენი",
  "ლუქსი": "ლუქსი",
  "კავკასიური": "კავკასიური",
  "თბილისური ეზო": "თბილისური ეზო",
  "მოსკოვის": "მოსკოვის",
  "ქალაქური": "ქალაქური",
  "ჩეხური": "ჩეხური",
  "ხრუშჩოვის": "ხრუშჩოვის",
  "თუხარელის": "თუხარელის",
  "ვერსი": "ვერსი",
  "იყალთოს": "იყალთოს",
  "მერონიშენი": "მერონიშენი",
  "მეტრომშენის": "მეტრომშენის",
  "არასტანდარტული": "არასტანდარტული",
  "კიევლების": "კიევლების",
  "ცალკე საცხოვრებელი": "ცალკე საცხოვრებელი",
};

/**
 * Step 5 (დამატებითი ინფორმაცია) toggle chips on ss.ge create form.
 * Each maps the exact <p> label on the form to rawData keys from the listing.
 */
export interface AdditionalInfoToggle {
  /** Text label of the chip on ss.ge create form (<p> inside toggle div). */
  ssgeLabel: string;
  /** Alternate spellings on listing vs create form. */
  ssgeLabelAliases?: string[];
  /** Keys to look up in MyhomeListing.rawData. */
  rawDataKeys: string[];
}

/** Normalize toggle labels: "ცენტრ. გათბობა" → "ცენტ.გათბობა". */
export function compactToggleLabel(s: string): string {
  return s
    .replace(/\s+/g, "")
    .replace(/ცენტრ\./g, "ცენტ.")
    .trim();
}

export const ADDITIONAL_INFO_TOGGLES: AdditionalInfoToggle[] = [
  { ssgeLabel: "აივანი", rawDataKeys: ["აივანი", "აივნის რაოდენობა", "აივნის ფართი"] },
  { ssgeLabel: "სარდაფი", rawDataKeys: ["სარდაფი", "სარდახი"] },
  { ssgeLabel: "ლიფტი", rawDataKeys: ["ლიფტი"] },
  { ssgeLabel: "ავეჯი", rawDataKeys: ["ავეჯი", "ავეჯით"] },
  {
    ssgeLabel: "გარაჟი",
    rawDataKeys: [
      "გარაჟი",
      "პარკირება",
      "პარკინგი",
      "ავტოფარეხი",
      "პარკინგის ადგილი",
      "ეზოს პარკინგი",
      "მიწისქვეშა პარკინგი",
    ],
  },
  {
    ssgeLabel: "ცენტ.გათბობა",
    ssgeLabelAliases: [
      "ცენტრ. გათბობა",
      "ცენტ. გათბობა",
      "ცენტრ.გათბობა",
      "ცენტრალური გათბობა",
    ],
    rawDataKeys: [
      "ცენტ.გათბობა",
      "ცენტ. გათბობა",
      "ცენტრ. გათბობა",
      "ცენტრ.გათბობა",
      "ცენტრალური გათბობა",
      "გათბობა",
      "გათბომა",
    ],
  },
  { ssgeLabel: "ბოლო სართული", rawDataKeys: ["ბოლო სართული"] },
  { ssgeLabel: "ბუნებრივი აირი", rawDataKeys: ["ბუნებრივი აირი"] },
  { ssgeLabel: "სათავსო", rawDataKeys: ["სათავსო", "სათავსოს ფართი"] },
  {
    ssgeLabel: "ჩაშენებული სამზარეულო",
    rawDataKeys: ["ჩაშენებული სამზარეულო", "სამზარეულო + ტექნიკა", "სამზარეულო"],
  },
  { ssgeLabel: "ლოფტი", rawDataKeys: ["ლოფტი", "ლოჯია", "ლოჯიის ფართი"] },
  { ssgeLabel: "ეზო", rawDataKeys: ["ეზო"] },
  { ssgeLabel: "ბომბსაცავი", rawDataKeys: ["ბომბსაცავი"] },
  {
    ssgeLabel: "კონდიციონერი",
    rawDataKeys: ["კონდიციონერი"],
  },
  {
    ssgeLabel: "საკაბელო ტელევიზია",
    ssgeLabelAliases: ["ტელევიზია", "საკაბელო ტელევიზია"],
    rawDataKeys: ["ტელევიზია", "საკაბელო ტელევიზია"],
  },
  { ssgeLabel: "მაცივარი", rawDataKeys: ["მაცივარი"] },
  {
    ssgeLabel: "მინა-პაკეტი",
    ssgeLabelAliases: ["მინა პაკეტი", "მინა-პაკეტი"],
    rawDataKeys: ["მინა-პაკეტი", "მინა პაკეტი"],
  },
  { ssgeLabel: "ინტერნეტი", rawDataKeys: ["ინტერნეტი"] },
  { ssgeLabel: "სიგნალიზაცია", rawDataKeys: ["სიგნალიზაცია"] },
  { ssgeLabel: "ტელეფონი", rawDataKeys: ["ტელეფონი"] },
  {
    ssgeLabel: "დასაშვებია შინაური ცხოველები",
    ssgeLabelAliases: ["შინაური ცხოველები", "ცხოველები"],
    rawDataKeys: ["დასაშვებია შინაური ცხოველები", "შინაური ცხოველები"],
  },
  {
    ssgeLabel: "სასმელი წყალი",
    ssgeLabelAliases: ["წყალი", "სასმელი წყალი"],
    rawDataKeys: ["სასმელი წყალი", "წყალი"],
  },
  { ssgeLabel: "ცხელი წყალი", rawDataKeys: ["ცხელი წყალი"] },
  {
    ssgeLabel: "რკინის კარი",
    ssgeLabelAliases: ["რკინის კარი", "რკინისკარი"],
    rawDataKeys: ["რკინის კარი"],
  },
  {
    ssgeLabel: "სარეცხი მანქანა",
    rawDataKeys: ["სარეცხი მანქანა", "ჭურჭლის სარეცხი მანქანა"],
  },
  {
    ssgeLabel: "აუზი",
    ssgeLabelAliases: ["ღია აუზი", "დახურული აუზი"],
    rawDataKeys: ["აუზი", "ღია აუზი", "დახურული აუზი"],
  },
  { ssgeLabel: "ელექტროენერგია", rawDataKeys: ["ელექტროენერგია"] },
  { ssgeLabel: "კანალიზაცია", rawDataKeys: ["კანალიზაცია"] },
  { ssgeLabel: "ბუხარი", rawDataKeys: ["ბუხარი"] },
];

/** rawData keys that are not amenity toggles on step 5. */
export const ADDITIONAL_INFO_RAWDATA_SKIP = new Set([
  "სტატუსი",
  "მდგომარეობა",
  "პროექტი",
  "პროექტის ტიპი",
  "ხედი",
  "სახლის ფართი",
  "ეზოს ფართი",
  "საკადასტრო კოდი",
  "სველი წერტილი",
  "სვ.წერტილი",
  "სვ.წერტილები",
]);

/** Amenity flag — not a bare m² number stored under an area key. */
export function isAmenityTruthyValue(v: string | undefined | null): boolean {
  if (!isTruthyRawValue(v)) return false;
  const s = String(v).trim();
  if (/^\d+([.,]\d+)?\s*(?:მ²|m²)?$/iu.test(s)) return false;
  return true;
}

/** True when parsed rawData says this amenity toggle should be on. */
export function shouldEnableAdditionalInfoToggle(
  rawData: Record<string, string> | undefined | null,
  toggle: AdditionalInfoToggle
): boolean {
  if (!rawData) return false;
  if (toggle.rawDataKeys.some((k) => isAmenityTruthyValue(rawData[k]))) {
    return true;
  }

  const compactSsge = compactToggleLabel(toggle.ssgeLabel);

  if (compactSsge.includes("გათბობა")) {
    const heating =
      rawData["გათბობა"]?.trim() || rawData["გათბომა"]?.trim() || "";
    if (
      heating &&
      heating !== "არა" &&
      (/ცენტ/i.test(heating) || heating === "კი")
    ) {
      return true;
    }
  }

  if (compactSsge === "გარაჟი") {
    const parking = rawData["პარკირება"]?.trim() || "";
    if (parking && parking !== "არა" && /ავტოფარეხ|გარაჟ|პარკინგ/i.test(parking)) {
      return true;
    }
  }

  if (compactSsge.includes("სამზარეულო")) {
    const kitchen =
      rawData["სამზარეულო + ტექნიკა"]?.trim() ||
      rawData["სამზარეულო"]?.trim() ||
      "";
    if (kitchen && kitchen !== "არა") return true;
  }

  if (compactSsge === "აივანი") {
    const header = rawData["აივანი"]?.trim() || "";
    if (header === "კი" || header === "დიახ") return true;
    const count = rawData["აივნის რაოდენობა"]?.trim() || "";
    const area = rawData["აივნის ფართი"]?.trim() || "";
    if (/\d/.test(count) || /\d/.test(area)) return true;
    if (/\d+\s*\/\s*\d/.test(header)) return true;
  }

  const variants = new Set(
    [toggle.ssgeLabel, ...(toggle.ssgeLabelAliases || []), ...toggle.rawDataKeys].map(
      compactToggleLabel
    )
  );
  return Object.entries(rawData).some(
    ([k, v]) =>
      isAmenityTruthyValue(v) && variants.has(compactToggleLabel(k))
  );
}

export function additionalInfoToggleLabels(toggle: AdditionalInfoToggle): string[] {
  return [
    toggle.ssgeLabel,
    ...(toggle.ssgeLabelAliases || []),
    ...toggle.rawDataKeys,
  ];
}

/**
 * ss.ge create-form labels to click on step 5, deduped by compact form.
 * Includes mapped toggles plus any other parsed rawData amenity keys.
 */
export function collectAdditionalInfoLabelsToEnable(
  rawData: Record<string, string> | undefined | null
): string[] {
  if (!rawData) return [];

  const byCompact = new Map<string, string>();

  const add = (label: string) => {
    const t = label.trim();
    if (!t) return;
    const c = compactToggleLabel(t);
    if (!byCompact.has(c)) byCompact.set(c, t);
  };

  for (const toggle of ADDITIONAL_INFO_TOGGLES) {
    if (!shouldEnableAdditionalInfoToggle(rawData, toggle)) continue;
    for (const l of additionalInfoToggleLabels(toggle)) add(l);
    add(toggle.ssgeLabel);
  }

  for (const [key, val] of Object.entries(rawData)) {
    if (ADDITIONAL_INFO_RAWDATA_SKIP.has(key)) continue;
    if (!isAmenityTruthyValue(val)) continue;
    add(key);
  }

  return [...byCompact.values()];
}

/**
 * "Other info" chips on step 5 (სხვა ინფორმაცია): ხედი ეზოზე, ხედი ქუჩაზე,
 * ნათელი, etc. — selected when MyHome rawData["ხედი"] contains the same value.
 */
export const VIEW_TO_SSGE: Record<string, string> = {
  "ხედი ეზოზე": "ხედი ეზოზე",
  "ხედი ქუჩაზე": "ხედი ქუჩაზე",
  "ნათელი": "ნათელი",
  "მყუდრო": "მყუდრო",
  "მცხელო": "მცხელო",
};

/** A "truthy" rawData value (used by additional-info toggles). */
export function isTruthyRawValue(v: string | undefined | null): boolean {
  if (!v) return false;
  const s = String(v).trim();
  if (!s) return false;
  if (s === "არა" || s.toLowerCase() === "no" || s === "0") return false;
  return true;
}

/** Strip non-digits — used for chip-count values like rooms/bedrooms. */
export function digitsOnly(value: string | undefined | null): string {
  if (!value) return "";
  const m = String(value).match(/\d+/);
  return m ? m[0] : "";
}
