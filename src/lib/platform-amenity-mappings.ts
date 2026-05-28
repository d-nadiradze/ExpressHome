/**
 * ss.ge ↔ myhome.ge amenity label aliases.
 *
 * ss.ge step 5 uses short toggles (e.g. "ცენტ.გათბობა").
 * myhome uses chip rows (e.g. გათბობა → "ცენტრალური გათბობა") or yes chips.
 */

export function compactAmenityLabel(s: string): string {
  return s
    .replace(/\s+/g, "")
    .replace(/ცენტრ\./g, "ცენტ.")
    .trim()
    .toLowerCase();
}

function isYesValue(v: string | undefined): boolean {
  const s = (v || "").trim();
  return s === "კი" || s === "დიახ" || s === "yes";
}

export function isTruthyAmenityValue(v: string | undefined): boolean {
  if (!v?.trim()) return false;
  const s = v.trim();
  if (s === "არა" || s.toLowerCase() === "no" || s === "0") return false;
  if (/^\d+([.,]\d+)?\s*(?:მ²|m²)?$/iu.test(s)) return false;
  return true;
}

/** ss.ge toggle ON → myhome preference row value (chip under h2). */
type MyhomePreferenceTarget = {
  row: string;
  value: string;
};

/** ss.ge toggle ON → myhome yes-style chip (property / corp / furniture). */
type MyhomeYesChipTarget = {
  chip: string;
};

type SsgeToMyhomeRule =
  | { kind: "preference"; target: MyhomePreferenceTarget }
  | { kind: "yesChip"; target: MyhomeYesChipTarget };

/**
 * ss.ge დამატებითი ინფორმაცია toggle labels (compact keys).
 * Multiple spellings point at the same rule.
 */
const SSGE_TO_MYHOME_RULES: Record<string, SsgeToMyhomeRule> = {
  // Heating: ss.ge abbreviated → myhome full chip label
  "ცენტ.გათბობა": {
    kind: "preference",
    target: { row: "გათბობა", value: "ცენტრალური გათბობა" },
  },

  // Parking: ss.ge გარაჟი toggle ↔ myhome პარკირება row
  გარაჟი: {
    kind: "preference",
    target: { row: "პარკირება", value: "ავტოფარეხი" },
  },

  // Same on both platforms (yes chip)
  აივანი: { kind: "yesChip", target: { chip: "აივანი" } },
  სარდაფი: { kind: "yesChip", target: { chip: "სარდაფი" } },
  ლიფტი: { kind: "yesChip", target: { chip: "ლიფტი" } },
  ავეჯი: { kind: "yesChip", target: { chip: "ავეჯი" } },
  "ბოლო სართული": { kind: "yesChip", target: { chip: "ბოლო სართული" } },
  "ბუნებრივი აირი": { kind: "yesChip", target: { chip: "ბუნებრივი აირი" } },
  სათავსო: { kind: "yesChip", target: { chip: "სათავსო" } },
  "ჩაშენებული სამზარეულო": {
    kind: "yesChip",
    target: { chip: "სამზარეულო + ტექნიკა" },
  },
  ინტერნეტი: { kind: "yesChip", target: { chip: "ინტერნეტი" } },
  "საკაბელო ტელევიზია": { kind: "yesChip", target: { chip: "ტელევიზია" } },
  ტელევიზია: { kind: "yesChip", target: { chip: "ტელევიზია" } },
  "სასმელი წყალი": { kind: "yesChip", target: { chip: "წყალი" } },
  წყალი: { kind: "yesChip", target: { chip: "წყალი" } },
  "დასაშვებია შინაური ცხოველები": {
    kind: "yesChip",
    target: { chip: "შინაური ცხოველები" },
  },
  "შინაური ცხოველები": { kind: "yesChip", target: { chip: "შინაური ცხოველები" } },
  "მინა-პაკეტი": { kind: "yesChip", target: { chip: "მინა პაკეტი" } },
  "მინა პაკეტი": { kind: "yesChip", target: { chip: "მინა პაკეტი" } },
  ეზო: { kind: "yesChip", target: { chip: "ეზო" } },
  ლოფტი: { kind: "yesChip", target: { chip: "ლოჯია" } },
  ლოჯია: { kind: "yesChip", target: { chip: "ლოჯია" } },
  კონდიციონერი: { kind: "yesChip", target: { chip: "კონდიციონერი" } },
  "სარეცხი მანქანა": { kind: "yesChip", target: { chip: "სარეცხი მანქანა" } },
  "ჭურჭლის სარეცხი მანქანა": {
    kind: "yesChip",
    target: { chip: "ჭურჭლის სარეცხი მანქანა" },
  },
  "ცხელი წყალი": { kind: "yesChip", target: { chip: "ცხელი წყალი" } },
  ელექტროენერგია: { kind: "yesChip", target: { chip: "ელექტროენერგია" } },
  კანალიზაცია: { kind: "yesChip", target: { chip: "კანალიზაცია" } },
  ტელეფონი: { kind: "yesChip", target: { chip: "ტელეფონი" } },
  ბუხარი: { kind: "yesChip", target: { chip: "ბუხარი" } },
  სიგნალიზაცია: { kind: "yesChip", target: { chip: "სიგნალიზაცია" } },
};

/** myhome preference chip value → ss.ge toggle to enable. */
const MYHOME_PREFERENCE_TO_SSGE: Record<
  string,
  Record<string, string>
> = {
  გათბობა: {
    "ცენტრალური გათბობა": "ცენტ.გათბობა",
    "ცენტრ. გათბობა": "ცენტ.გათბობა",
    "ცენტრალური": "ცენტ.გათბობა",
    კი: "ცენტ.გათბობა",
  },
  გათბომა: {
    "ცენტრალური გათბობა": "ცენტ.გათბობა",
    კი: "ცენტ.გათბობა",
  },
  პარკირება: {
    ავტოფარეხი: "გარაჟი",
    გარაჟი: "გარაჟი",
    "პარკინგის ადგილი": "გარაჟი",
    "ეზოს პარკინგი": "გარაჟი",
    "მიწისქვეშა პარკინგი": "გარაჟი",
    "ფასიანი ავტოსადგომი": "გარაჟი",
  },
  "ცხელი წყალი": {
    "ცენტრალური ცხელი წყალი": "ცხელი წყალი",
    "ცენტრალური": "ცხელი წყალი",
    კი: "ცხელი წყალი",
  },
  "სამშენებლო მასალა": {
    ბლოკი: "ბლოკი",
    აგური: "აგური",
    "ხის მასალა": "ხის მასალა",
    "რკინა-ბეტონი": "რკინა-ბეტონი",
    კომბინირებული: "კომბინირებული",
  },
  "კარ-ფანჯარა": {
    ხე: "ხე",
    პლასტმასა: "პლასტმასა",
    ალუმინი: "ალუმინი",
  },
};

/** myhome yes chip → ss.ge toggle (when values are just "კი"). */
const MYHOME_YES_CHIP_TO_SSGE: Record<string, string> = {
  აივანი: "აივანი",
  სარდაფი: "სარდაფი",
  ლიფტი: "ლიფტი",
  ავეჯი: "ავეჯი",
  "ბოლო სართული": "ბოლო სართული",
  "ბუნებრივი აირი": "ბუნებრივი აირი",
  სათავსო: "სათავსო",
  "სამზარეულო + ტექნიკა": "ჩაშენებული სამზარეულო",
  სამზარეულო: "ჩაშენებული სამზარეულო",
  ინტერნეტი: "ინტერნეტი",
  ტელევიზია: "საკაბელო ტელევიზია",
  წყალი: "სასმელი წყალი",
  "შინაური ცხოველები": "დასაშვებია შინაური ცხოველები",
  "მინა პაკეტი": "მინა-პაკეტი",
  ეზო: "ეზო",
  ლოჯია: "ლოფტი",
  კონდიციონერი: "კონდიციონერი",
  "სარეცხი მანქანა": "სარეცხი მანქანა",
  "ჭურჭლის სარეცხი მანქანა": "სარეცხი მანქანა",
  "ცხელი წყალი": "ცხელი წყალი",
  ელექტროენერგია: "ელექტროენერგია",
  კანალიზაცია: "კანალიზაცია",
  ტელეფონი: "ტელეფონი",
  ბუხარი: "ბუხარი",
  სიგნალიზაცია: "სიგნალიზაცია",
  "სპორტ დარბაზი": "სპორტ დარბაზი",
  "დახურული აუზი": "აუზი",
  "ღია აუზი": "აუზი",
  საუნა: "საუნა",
  ჯაკუზი: "ჯაკუზი",
  დაცვა: "დაცვა",
  კონსიერჟი: "კონსიერჟი",
};

function findSsgeToMyhomeRule(key: string): SsgeToMyhomeRule | null {
  const trimmed = key.trim();
  if (SSGE_TO_MYHOME_RULES[trimmed]) return SSGE_TO_MYHOME_RULES[trimmed];
  const compact = compactAmenityLabel(trimmed);
  for (const [k, rule] of Object.entries(SSGE_TO_MYHOME_RULES)) {
    if (compactAmenityLabel(k) === compact) return rule;
  }
  return null;
}

/**
 * Apply ss.ge amenity keys/values to myhome rawData (preference rows + yes chips).
 */
export function applySsgeAmenityAliasesToMyhomeRaw(
  raw: Record<string, string>
): Record<string, string> {
  const out = { ...raw };

  for (const [key, val] of Object.entries({ ...out })) {
    if (!isTruthyAmenityValue(val)) continue;

    const rule = findSsgeToMyhomeRule(key);
    if (!rule) continue;

    if (rule.kind === "preference") {
      const { row, value } = rule.target;
      out[row] = value;
      if (compactAmenityLabel(key) !== compactAmenityLabel(row)) {
        delete out[key];
      }
    } else {
      const { chip } = rule.target;
      out[chip] = "კი";
      if (compactAmenityLabel(key) !== compactAmenityLabel(chip)) {
        delete out[key];
      }
    }
  }

  // Legacy typo key → proper row
  if (isYesValue(out["გათბომა"]) && !out["გათბობა"]) {
    out["გათბობა"] = "ცენტრალური გათბობა";
    delete out["გათბომა"];
  }

  if (isTruthyAmenityValue(out["გარაჟი"]) && !out["პარკირება"]) {
    out["პარკირება"] = "ავტოფარეხი";
  }

  return out;
}

/**
 * Apply myhome preference rows + yes chips to ss.ge toggle keys.
 */
export function applyMyhomeAmenityAliasesToSsgeRaw(
  raw: Record<string, string>
): Record<string, string> {
  const out = { ...raw };

  for (const [row, valueMap] of Object.entries(MYHOME_PREFERENCE_TO_SSGE)) {
    const val = out[row]?.trim();
    if (!val || val === "არა") continue;

    const direct = valueMap[val];
    if (direct) {
      out[direct] = "კი";
      continue;
    }

    const compactVal = compactAmenityLabel(val);
    for (const [myhomeVal, ssgeToggle] of Object.entries(valueMap)) {
      if (compactAmenityLabel(myhomeVal) === compactVal) {
        out[ssgeToggle] = "კი";
        break;
      }
    }
  }

  for (const [chip, ssgeToggle] of Object.entries(MYHOME_YES_CHIP_TO_SSGE)) {
    if (!isYesValue(out[chip])) continue;
    if (!out[ssgeToggle] || out[ssgeToggle] === "არა") {
      out[ssgeToggle] = "კი";
    }
  }

  // სათავსოს ტიპი სარდაფი → both toggles
  const storageType = out["სათავსოს ტიპი"]?.trim() || "";
  if (/სარდაფ/i.test(storageType)) {
    out["სარდაფი"] = "კი";
    out["სათავსო"] = out["სათავსო"] || "კი";
  }

  return out;
}

function balconyHeaderIsYesOnly(header: string): boolean {
  const h = header.trim();
  return h === "კი" || h === "დიახ" || h.toLowerCase() === "yes";
}

/**
 * ss.ge create form: აივანი is a numeric chip row. Parsed toggle „კი“ → count 1.
 */
export function applySsgeBalconyDefaultsForSsgePrefill(
  raw: Record<string, string>
): void {
  const header = raw["აივანი"]?.trim() || "";
  if (!header || header === "არა") return;

  const countKey = raw["აივნის რაოდენობა"]?.trim() || "";
  if (countKey && /\d/.test(countKey)) {
    if (balconyHeaderIsYesOnly(header)) {
      raw["აივანი"] = "კი";
    } else {
      raw["აივანი"] = countKey.replace(/[^\d]/g, "") || countKey;
    }
    return;
  }

  if (balconyHeaderIsYesOnly(header)) {
    raw["აივნის რაოდენობა"] = "1";
    raw["აივანი"] = "კი";
    return;
  }

  const slash = header.match(/^(\d+)\s*\/\s*(\d+)/);
  if (slash) {
    raw["აივნის რაოდენობა"] = slash[1];
    raw["აივნის ფართი"] = slash[2];
    raw["აივანი"] = "კი";
    return;
  }

  const digits = header.replace(/[^\d]/g, "");
  if (digits && !balconyHeaderIsYesOnly(header)) {
    raw["აივანი"] = digits;
  }
}

/** Resolve balcony count for ss.ge step 4 chip click. */
export function resolveSsgeBalconyCountForPrefill(
  raw: Record<string, string> | undefined | null
): string {
  if (!raw) return "";
  const working = { ...raw };
  applySsgeBalconyDefaultsForSsgePrefill(working);
  const n =
    working["აივნის რაოდენობა"]?.replace(/[^\d]/g, "") ||
    working["აივანი"]?.replace(/[^\d]/g, "") ||
    "";
  return n;
}

/**
 * ss.ge lists აივანი as a yes toggle only; myhome needs count + m² inputs.
 * When parsed value is „კი“, default to 1 balcony / 1 m².
 */
export function applySsgeBalconyDefaultsForMyhome(
  raw: Record<string, string>
): void {
  const header = raw["აივანი"]?.trim() || "";
  if (!header || header === "არა") return;

  const isYesOnly = balconyHeaderIsYesOnly(header);
  const hasSlashFormat = /\d+\s*\/\s*\d/.test(header);

  if (!isYesOnly && !hasSlashFormat) {
    const count = raw["აივნის რაოდენობა"]?.trim();
    const area = raw["აივნის ფართი"]?.trim();
    if (count || area) return;
  }

  if (hasSlashFormat && !isYesOnly) return;

  let count = raw["აივნის რაოდენობა"]?.replace(/[^\d]/g, "") || "";
  let area = raw["აივნის ფართი"]?.replace(/[^\d.]/g, "") || "";

  if (!count) count = "1";
  if (!area) area = "1";

  raw["აივნის რაოდენობა"] = count;
  raw["აივნის ფართი"] = area;
  raw["აივანი"] = `${count}/${area}`;
}

/** Export ss.ge toggle labels for documentation / tests. */
export const SSGE_ADDITIONAL_INFO_LABELS = [
  "აივანი",
  "სარდაფი",
  "ლიფტი",
  "ავეჯი",
  "გარაჟი",
  "ცენტ.გათბობა",
  "ბოლო სართული",
  "ბუნებრივი აირი",
  "სათავსო",
  "ჩაშენებული სამზარეულო",
] as const;
