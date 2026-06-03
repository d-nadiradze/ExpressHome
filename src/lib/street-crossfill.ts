/**
 * Bidirectional street label translation for Tbilisi microdistrict / quarter / plateau
 * blocks between myhome.ge and ss.ge naming conventions.
 */

export const TEMKA_DISTRICT = "თემქა" as const;

export type LocationBlockKind =
  | "micro"
  | "micro-quarter"
  | "quarter-only"
  | "plateau";

/** Canonical location block — district is the ss.ge location suffix when present. */
export interface MicroStreetCanonical {
  district: string;
  kind?: LocationBlockKind;
  micro: string;
  quarter?: string;
  /** ss.ge comma suffix after მიკრორაიონი (e.g. „II რიგი“), not a quarter. */
  extra?: string;
  /** myhome autocomplete prefix when it differs from the ss.ge district name. */
  myhomeHead?: string;
  /** Temka block listed as „ზღვისუბანი X კვარტ“ (not „I მ/რ X კვარტ“). */
  temkaZghvisubani?: boolean;
}

/** @deprecated Use MicroStreetCanonical */
export type TemkaMicroCanonical = MicroStreetCanonical & {
  district: typeof TEMKA_DISTRICT;
};

export type StreetCrossfillTarget = "myhome" | "ssge";

/** Longest suffixes first so „დიღმის მასივი“ matches before partial names. */
const SSGE_DISTRICT_SUFFIXES = [
  "დიღმის მასივი",
  "ვაჟა ფშაველა",
  "თემქა",
  "გლდანი",
  "ვარკეთილი",
  "ვაზისუბანი",
  "ზემო პლატო",
] as const;

const QUARTER_ONLY_SSGE_DISTRICTS = new Set<string>([
  "ვაჟა ფშაველა",
  "დიღმის მასივი",
]);

/** Districts where myhome uses „მ/რ“ + quarter (კვარტ / კ.) like ss.ge micro + კვარტალი. */
const MICRO_QUARTER_DISTRICTS = new Set<string>(["თემქა", "ვაზისუბანი"]);

const VAZISUBANI_SETTLEMENT_HEAD = "ვაზისუბნის დას.";

/** ss.ge suffix → myhome autocomplete head label. */
const MYHOME_HEAD_BY_SSGE_DISTRICT: Record<string, string> = {
  "ვაჟა ფშაველა": "ვაჟა-ფშაველა",
  "დიღმის მასივი": "დიღმის მასივი",
  თემქა: "თემქა",
  გლდანი: "გლდანი",
  ვარკეთილი: "ვარკეთილი III",
  ვაზისუბანი: "ვაზისუბანი",
  "ზემო პლატო": "ვარკეთილი III",
};

const NUTSUBIDZE_PLATEAU_DISTRICT = "ნუცუბიძის პლატო";

/** myhome Temka „ზღვისუბანი“ quarter labels → ss.ge I micro + quarter. */
const TEMKA_ZGHVISUBANI_QUARTER_TO_MICRO: Record<string, string> = {
  IV: "I",
  IX: "I",
  X: "I",
  XA: "I",
  XB: "I",
  Xა: "I",
  Xბ: "I",
};

function isTemkaZghvisubaniBlock(micro: string, quarter: string): boolean {
  return micro === "I" && Boolean(TEMKA_ZGHVISUBANI_QUARTER_TO_MICRO[quarter]);
}

function stripQuarterSuffix(text: string): string {
  return text
    .trim()
    .replace(/\s*\.+\s*$/, "")
    .replace(/\s*(?:კვარტ|კ)(?:\.|$)?\s*$/iu, "")
    .trim();
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Normalize roman tokens (Xa, Xბ → XA, XB for canonical keys). */
export function normalizeRomanToken(token: string): string {
  const t = token.replace(/\s+/g, "").trim();
  if (!t) return "";
  const upper = t.toUpperCase();
  if (/^X[AB]$/i.test(upper)) return upper;
  if (/^X[ა]$/iu.test(t)) return "XA";
  if (/^X[ბ]$/iu.test(t)) return "XB";
  if (/^(I{1,3}|IV|VI{0,3}|IX|X{1,3}|XI{0,3}|VII|X[AB]?)$/i.test(upper)) {
    return upper;
  }
  return t;
}

function normalizeMicroLabel(raw: string): string {
  const parts = raw.replace(/\s+/g, " ").trim().split(/\s+/);
  if (parts.length === 0) return "";
  if (parts.length === 1) {
    const one = parts[0];
    const roman = normalizeRomanToken(one);
    return roman || one;
  }
  const roman = normalizeRomanToken(parts[0]);
  const georgian = parts[1];
  if (roman && georgian && /^[ა-ჰ]$/u.test(georgian)) {
    return `${roman} ${georgian}`;
  }
  return parts.map((p) => normalizeRomanToken(p) || p).join(" ");
}

function formatRomanForSsge(token: string): string {
  const parts = token.split(/\s+/);
  if (parts.length === 2 && /^[ა-ჰ]$/u.test(parts[1])) {
    return `${normalizeRomanToken(parts[0]) || parts[0]} ${parts[1]}`;
  }
  const n = normalizeRomanToken(token);
  if (n === "XA") return "Xa";
  if (n === "XB") return "Xb";
  return n || token;
}

function formatRomanForMyhome(token: string): string {
  return normalizeMicroLabel(token);
}

function myhomeHeadForDistrict(
  ssgeDistrict: string,
  canon?: Pick<MicroStreetCanonical, "myhomeHead">
): string {
  if (canon?.myhomeHead) return canon.myhomeHead;
  return MYHOME_HEAD_BY_SSGE_DISTRICT[ssgeDistrict] || ssgeDistrict;
}

function resolveMyhomeDistrict(head: string): {
  district: string;
  myhomeHead?: string;
} | null {
  const h = normalizeWhitespace(head);
  if (/^თემქა$/iu.test(h)) return { district: "თემქა" };
  if (/^გლდანი$/iu.test(h)) return { district: "გლდანი" };
  if (/^ვაზისუბანი$/iu.test(h)) return { district: "ვაზისუბანი" };
  if (/^ვაზისუბნის\s+დას\.?$/iu.test(h)) {
    return {
      district: "ვაზისუბანი",
      myhomeHead: VAZISUBANI_SETTLEMENT_HEAD,
    };
  }
  if (/^დიღმის\s+მასივი$/iu.test(h)) return { district: "დიღმის მასივი" };
  if (/^ვაჟა[\s-]*ფშაველა$/iu.test(h)) return { district: "ვაჟა ფშაველა" };
  if (/ვარკეთილი/i.test(h)) return { district: "ვარკეთილი" };
  return null;
}

function parseMyhomeNutsubidzePlateau(text: string): MicroStreetCanonical | null {
  const s = normalizeWhitespace(text);
  const plateauOnly = s.match(
    /^ნუცუბიძის\s+პლ\.?\s*([IVXLC]+)\s*[-–]?\s*მ\/?\s*რ\.?\s*$/iu
  );
  if (plateauOnly) {
    return {
      district: NUTSUBIDZE_PLATEAU_DISTRICT,
      kind: "plateau",
      micro: normalizeRomanToken(plateauOnly[1]),
    };
  }

  const plateauWithQuarter = s.match(
    /^ნუცუბიძის\s+პლ\.?\s*([IVXLC]+)\s+მ\/?\s*რ\.?\s*,\s*([IVXLC]+)\s*კვარტ/i
  );
  if (plateauWithQuarter) {
    return {
      district: NUTSUBIDZE_PLATEAU_DISTRICT,
      kind: "plateau",
      micro: normalizeRomanToken(plateauWithQuarter[1]),
      quarter: normalizeRomanToken(plateauWithQuarter[2]),
    };
  }

  return null;
}

function parseSsgeNutsubidzePlateau(text: string): MicroStreetCanonical | null {
  const s = normalizeWhitespace(text);
  const m = s.match(/^ნუცუბიძის\s+([IVXLC]+)\s+პლატო$/iu);
  if (!m) return null;
  return {
    district: NUTSUBIDZE_PLATEAU_DISTRICT,
    kind: "plateau",
    micro: normalizeRomanToken(m[1]),
  };
}

function parseMyhomeQuarterOnlyTail(
  district: string,
  tail: string
): MicroStreetCanonical | null {
  if (!QUARTER_ONLY_SSGE_DISTRICTS.has(district)) return null;
  const m = tail.match(/^([IVXLC]+)\s*კვარტ/i);
  if (!m) return null;
  return {
    district,
    kind: "quarter-only",
    micro: "",
    quarter: normalizeRomanToken(m[1]),
  };
}

function parseTemkaZghvisubaniTail(
  tail: string
): Pick<MicroStreetCanonical, "micro" | "quarter" | "kind" | "temkaZghvisubani"> | null {
  const m = tail.match(/^ზღვისუბანი\s+(.+)$/iu);
  if (!m) return null;
  const rest = stripQuarterSuffix(m[1]);
  const q = normalizeRomanToken(rest.replace(/\s+/g, " ").trim());
  if (!q) return null;
  return {
    kind: "micro-quarter",
    micro: TEMKA_ZGHVISUBANI_QUARTER_TO_MICRO[q] || "I",
    quarter: q,
    temkaZghvisubani: true,
  };
}

function parseMicroQuarterTail(
  tail: string
): Pick<MicroStreetCanonical, "micro" | "quarter" | "kind"> | null {
  const m = tail.match(
    /^(.+?)\s*მ\/?\s*რ\.?\s*,?\s*([IVXLC]+|X[abა-ჰ]?)\s*(?:კვარტ\.?|კ\.?)/iu
  );
  if (!m) return null;
  return {
    kind: "micro-quarter",
    micro: normalizeMicroLabel(m[1].trim()),
    quarter: normalizeRomanToken(m[2]),
  };
}

function parseMicroOnlyTail(tail: string): string | null {
  const m = tail.match(/^(.+?)\s*მ\/?\s*რ\.?/iu);
  if (!m) return null;
  const micro = normalizeMicroLabel(m[1].trim());
  return micro || null;
}

/** Parse myhome location block lines across supported districts. */
export function parseMyhomeMicroStreet(text: string): MicroStreetCanonical | null {
  const s = normalizeWhitespace(text);
  if (!s) return null;

  const plateau = parseMyhomeNutsubidzePlateau(s);
  if (plateau) return plateau;

  const dashParts = s.split(/\s-\s+/u);
  if (dashParts.length < 2) return null;

  const head = dashParts[0].trim();
  const resolved = resolveMyhomeDistrict(head);
  if (!resolved) return null;

  const { district, myhomeHead } = resolved;

  const tail = dashParts.slice(1).join(" - ").trim();
  if (!tail) return null;

  const quarterOnly = parseMyhomeQuarterOnlyTail(district, tail);
  if (quarterOnly) {
    return { ...quarterOnly, ...(myhomeHead ? { myhomeHead } : {}) };
  }

  if (district === "თემქა") {
    const z = parseTemkaZghvisubaniTail(tail);
    if (z) return { district, ...z };
  }

  const microQuarter = parseMicroQuarterTail(tail);
  if (microQuarter && MICRO_QUARTER_DISTRICTS.has(district)) {
    return { district, ...microQuarter, ...(myhomeHead ? { myhomeHead } : {}) };
  }

  const micro = parseMicroOnlyTail(tail);
  if (micro) {
    return {
      district,
      kind: "micro",
      micro,
      ...(myhomeHead ? { myhomeHead } : {}),
    };
  }

  return null;
}

function parseSsgeDistrictSuffix(s: string): {
  district: string;
  body: string;
} | null {
  for (const district of SSGE_DISTRICT_SUFFIXES) {
    const re = new RegExp(
      `\\s-\\s*${district.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`,
      "iu"
    );
    if (re.test(s)) {
      return {
        district,
        body: s.replace(re, "").trim(),
      };
    }
  }

  return null;
}

/** Parse ss.ge location block lines across supported districts. */
export function parseSsgeMicroStreet(text: string): MicroStreetCanonical | null {
  const s = normalizeWhitespace(text);
  if (!s) return null;

  const plateau = parseSsgeNutsubidzePlateau(s);
  if (plateau) return plateau;

  const withSuffix = parseSsgeDistrictSuffix(s);
  if (withSuffix) {
    const { district, body } = withSuffix;

    const quarterOnly = body.match(/^([IVXLC]+)\s+კვარტალი$/iu);
    if (quarterOnly && QUARTER_ONLY_SSGE_DISTRICTS.has(district)) {
      return {
        district,
        kind: "quarter-only",
        micro: "",
        quarter: normalizeRomanToken(quarterOnly[1]),
      };
    }

    const withQuarter = body.match(
      /^(.+?)\s+მიკრორაიონი\s*,\s*([IVXLC]+|X[abა-ჰ]?)\s+კვარტალი$/iu
    );
    if (withQuarter) {
      const micro = normalizeMicroLabel(withQuarter[1].trim());
      const quarter = normalizeRomanToken(withQuarter[2]);
      return {
        district,
        kind: "micro-quarter",
        micro,
        quarter,
        ...(district === "თემქა" && isTemkaZghvisubaniBlock(micro, quarter)
          ? { temkaZghvisubani: true }
          : {}),
      };
    }

    const withExtra = body.match(/^(.+?)\s+მიკრორაიონი\s*,\s*(.+)$/iu);
    if (withExtra && !/კვარტალი$/iu.test(withExtra[2])) {
      return {
        district,
        kind: "micro",
        micro: normalizeMicroLabel(withExtra[1].trim()),
        extra: withExtra[2].trim(),
      };
    }

    const microOnly = body.match(/^(.+?)\s+მიკრორაიონი$/iu);
    if (microOnly) {
      return {
        district,
        kind: "micro",
        micro: normalizeMicroLabel(microOnly[1].trim()),
      };
    }

    return null;
  }

  const rowOnly = s.match(/^(.+?)\s+მიკრორაიონი\s*,\s*(.+?\s+რიგი)\s*$/iu);
  if (rowOnly) {
    return {
      district: "ვარკეთილი",
      kind: "micro",
      micro: normalizeMicroLabel(rowOnly[1].trim()),
      extra: rowOnly[2].trim(),
    };
  }

  return null;
}

/** myhome autocomplete label for a canonical location block. */
export function formatMyhomeMicroStreet(canon: MicroStreetCanonical): string {
  const district = canon.district;
  const kind = canon.kind || (canon.quarter && canon.micro ? "micro-quarter" : "micro");

  if (kind === "plateau") {
    const n = formatRomanForMyhome(canon.micro);
    if (canon.quarter) {
      return `ნუცუბიძის პლ. ${n} მ/რ, ${formatRomanForMyhome(canon.quarter)} კვარტ.`;
    }
    return `ნუცუბიძის პლ. ${n}-მ/რ`;
  }

  if (kind === "quarter-only") {
    const head = myhomeHeadForDistrict(district, canon);
    const q = formatRomanForMyhome(canon.quarter || "");
    return `${head} - ${q} კვარტ.`;
  }

  const micro = formatRomanForMyhome(canon.micro);
  const head = myhomeHeadForDistrict(district, canon);

  if (district === "თემქა" && canon.temkaZghvisubani && canon.quarter) {
    const q = formatRomanForMyhome(canon.quarter);
    return `თემქა - ზღვისუბანი ${q} კვარტ.`;
  }

  if (district === "თემქა" && canon.quarter) {
    return `${district} - ${micro} მ/რ ${formatRomanForMyhome(canon.quarter)} კვარტ`;
  }

  if (district === "ვაზისუბანი" && kind === "micro-quarter" && canon.quarter) {
    const q = formatRomanForMyhome(canon.quarter);
    return `${head} - ${micro} მ/რ ${q} კ.`;
  }

  if (district === "ვარკეთილი" || district === "ზემო პლატო") {
    return `${myhomeHeadForDistrict(district === "ზემო პლატო" ? "ზემო პლატო" : "ვარკეთილი", canon)} - ${micro} მ/რ`;
  }

  if (district === "გლდანი") {
    return `${district} - ${micro} მ/რ`;
  }

  if (district === "ვაზისუბანი") {
    return `${head} - ${micro} მ/რ`;
  }

  return `${head} - ${micro} მ/რ`;
}

/** ss.ge location chip label for a canonical location block. */
export function formatSsgeMicroStreet(canon: MicroStreetCanonical): string {
  const district = canon.district;
  const kind = canon.kind || (canon.quarter && canon.micro ? "micro-quarter" : "micro");

  if (kind === "plateau") {
    const n = formatRomanForSsge(canon.micro);
    return `ნუცუბიძის ${n} პლატო`;
  }

  if (kind === "quarter-only") {
    const q = formatRomanForSsge(canon.quarter || "");
    return `${q} კვარტალი - ${district}`;
  }

  const micro = formatRomanForSsge(canon.micro);

  if (kind === "micro-quarter" && canon.quarter) {
    const quarter = formatRomanForSsge(canon.quarter);
    return `${micro} მიკრორაიონი, ${quarter} კვარტალი - ${district}`;
  }

  if (canon.extra) {
    if (/რიგი$/iu.test(canon.extra)) {
      return `${micro} მიკრორაიონი, ${canon.extra}`;
    }
    return `${micro} მიკრორაიონი, ${canon.extra} - ${district}`;
  }

  return `${micro} მიკრორაიონი - ${district}`;
}

function parseAnyMicroStreet(text: string): MicroStreetCanonical | null {
  return parseMyhomeMicroStreet(text) || parseSsgeMicroStreet(text);
}

/** Convert a street/address line to the target platform label when parseable. */
export function crossfillStreetForTarget(
  street: string,
  target: StreetCrossfillTarget
): string | null {
  const canon = parseAnyMicroStreet(street);
  if (!canon) return null;
  const formatted =
    target === "ssge"
      ? formatSsgeMicroStreet(canon)
      : formatMyhomeMicroStreet(canon);
  const normalized = normalizeWhitespace(street);
  const formattedNorm = normalizeWhitespace(formatted);
  if (formattedNorm === normalized) return null;
  // Valid myhome label — do not rewrite to a different myhome spelling.
  if (target === "myhome" && parseMyhomeMicroStreet(street)) {
    if (canon.temkaZghvisubani) return null;
    if (formattedNorm.replace(/\.\s*$/, "") === normalized.replace(/\.\s*$/, "")) {
      return null;
    }
  }
  return formatted;
}

/** Typeahead query order: converted label first, then original. */
export function streetCrossfillQueries(
  street: string,
  target: StreetCrossfillTarget
): string[] {
  const s = normalizeWhitespace(street);
  if (!s) return [];

  const seen = new Set<string>();
  const ordered: string[] = [];
  const push = (q: string) => {
    const v = normalizeWhitespace(q);
    if (!v || seen.has(v)) return;
    seen.add(v);
    ordered.push(v);
  };

  const converted = crossfillStreetForTarget(s, target);
  const parsedMyhome = target === "myhome" ? parseMyhomeMicroStreet(s) : null;
  if (parsedMyhome) {
    push(s);
    if (converted) push(converted);
  } else {
    if (converted) push(converted);
    push(s);
  }

  return ordered;
}

/** Apply crossfill to street and rawData when a location block is detected. */
export function applyStreetCrossfill(
  fields: {
    street?: string;
    address?: string;
    rawData?: Record<string, string>;
  },
  target: StreetCrossfillTarget
): { street: string; rawData: Record<string, string> } {
  const rawData = { ...(fields.rawData || {}) };
  let street =
    fields.street?.trim() || rawData["ქუჩა"]?.trim() || "";

  if (!street && fields.address?.trim()) {
    const fromAddress = crossfillStreetForTarget(fields.address.trim(), target);
    if (fromAddress) street = fromAddress;
    else {
      const canon = parseAnyMicroStreet(fields.address.trim());
      if (canon) {
        street =
          target === "ssge"
            ? formatSsgeMicroStreet(canon)
            : formatMyhomeMicroStreet(canon);
      }
    }
  }

  const converted = crossfillStreetForTarget(street, target);
  if (converted) {
    street = converted;
    rawData["ქუჩა"] = converted;
  } else if (street && !rawData["ქუჩა"]) {
    rawData["ქუჩა"] = street;
  }

  return { street, rawData };
}
