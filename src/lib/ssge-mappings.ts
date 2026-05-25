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
 * Step 5 (დამატებითი ინფორმაცია → მდგომარეობა) on ss.ge mirrors MyHome's
 * `condition` field.
 */
export const CONDITION_TO_SSGE: Record<string, string> = {
  "ახალი გარემონტებული": "ახალი რემონტი",
  "ძველი გარემონტებული": "ძველი რემონტი",
  "მიმდინარე რემონტი": "მიმდინარე რემონტი",
  "სარემონტო": "სარემონტო",
  "თეთრი კარკასი": "თეთრი კარკასი",
  "შავი კარკასი": "შავი კარკასი",
  "მწვანე კარკასი": "მწვანე კარკასი",
  "თეთრი პლიუსი": "თეთრი პლიუსი",
};

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
 * Step 6 ("დამატებითი ინფორმაცია" toggle group on ss.ge). Each entry maps an
 * ss.ge toggle label to the MyHome rawData key (or a list of keys) that should
 * trigger it. If any of the listed keys has a truthy value in rawData
 * (anything that isn't "არა"/empty), the toggle is selected.
 */
export interface AdditionalInfoToggle {
  /** Text label of the chip on ss.ge. */
  ssgeLabel: string;
  /** Keys to look up in MyhomeListing.rawData. */
  rawDataKeys: string[];
}

export const ADDITIONAL_INFO_TOGGLES: AdditionalInfoToggle[] = [
  { ssgeLabel: "აივანი", rawDataKeys: ["აივანი", "აივნის რაოდენობა", "აივნის ფართი"] },
  { ssgeLabel: "სარდახი", rawDataKeys: ["სარდახი", "სარდაფი"] },
  { ssgeLabel: "ლოფტი", rawDataKeys: ["ლოფტი", "ლოჯია", "ლოჯიის ფართი"] },
  { ssgeLabel: "ეზო", rawDataKeys: ["ეზო", "ეზოს ფართი"] },
  { ssgeLabel: "გარაჟი", rawDataKeys: ["გარაჟი", "პარკირება"] },
  { ssgeLabel: "ცენტრალური გათბობა", rawDataKeys: ["ცენტრალური გათბობა", "გათბობა"] },
  { ssgeLabel: "ბომბსაცავი", rawDataKeys: ["ბომბსაცავი"] },
  { ssgeLabel: "ბუნებრივი აირი", rawDataKeys: ["ბუნებრივი აირი"] },
  { ssgeLabel: "სათავსო", rawDataKeys: ["სათავსო", "სათავსოს ფართი"] },
  { ssgeLabel: "ჩაშენებული სამზარეულო", rawDataKeys: ["სამზარეულო + ტექნიკა", "ჩაშენებული სამზარეულო"] },
];

/**
 * "Other info" chips on step 5 (სხვა ინფორმაცია): ხედი ეზოზე, ხედი ქუჩაზე,
 * ნათელი, etc. — selected when MyHome rawData["ხედი"] contains the same value.
 */
export const VIEW_TO_SSGE: Record<string, string> = {
  "ხედი ეზოზე": "ხედი ეზოზე",
  "ხედი ქუჩაზე": "ხედი ქუჩაზე",
  "ნათელი": "ნათელი",
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
