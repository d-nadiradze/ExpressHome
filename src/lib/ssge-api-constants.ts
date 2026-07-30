/**
 * ss.ge api-gateway numeric enums (from OpenAPI client + capture verification).
 * Labels mirror parse output / ss.ge create-form Georgian chips.
 */

export const SSGE_API_BASE = "https://api-gateway.ss.ge/v1";
export const SSGE_HOME_ORIGIN = "https://home.ss.ge";
export const SSGE_CREATE_PATH = "/ka/udzravi-qoneba/create";

export const SSGE_PROPERTY_TYPE: Record<number, string> = {
  1: "აგარაკი",
  2: "სასტუმრო",
  3: "მიწის ნაკვეთი",
  4: "კერძო სახლი",
  5: "ბინა",
  6: "კომერციული",
  7: "კომერციული ფართი",
};

export const SSGE_DEAL_TYPE: Record<number, string> = {
  1: "ქირავდება",
  2: "გირავდება",
  3: "ქირავდება დღიურად",
  4: "იყიდება",
};

export const SSGE_CURRENCY: Record<number, string> = {
  1: "GEL",
  2: "USD",
};

export const SSGE_CITY: Record<number, string> = {
  3: "სიღნაღი",
  95: "თბილისი",
  96: "ბათუმი",
  73: "ქუთაისი",
  79: "რუსთავი",
};

/** Building status (field `status` on create-draft). */
export const SSGE_BUILDING_STATUS: Record<number, string> = {
  2: "ახალი აშენებული",
  3: "მშენებარე",
  453: "ძველი აშენებული",
};

/**
 * Condition (field `state`). Numeric ids verified against ss.ge localization
 * dictionary (RealEstateState{ID}) — do NOT reorder without re-checking.
 */
export const SSGE_CONDITION: Record<number, string> = {
  8: "შავი კარკასი",
  9: "თეთრი კარკასი",
  10: "სარემონტო",
  11: "მიმდინარე რემონტი",
  12: "ძველი რემონტით",
  15: "გარემონტებული",
  16: "ახალი რემონტით",
  35: "მწვანე კარკასი",
};

/**
 * Bathroom count (field `toilet`). Verified against ss.ge localization
 * dictionary (Toilet{ID}).
 */
export const SSGE_TOILET: Record<number, string> = {
  418: "1",
  419: "2",
  420: "3",
  421: "4",
  422: "5+",
  423: "არ აქვს",
};

/**
 * Project type (field `project`). Numeric ids verified against ss.ge
 * localization dictionary (ProjectType{ID}) — do NOT reorder without
 * re-checking; ss.ge's ids are non-sequential and easy to scramble.
 */
export const SSGE_PROJECT_TYPE: Record<number, string> = {
  4: "არასტანდარტული",
  5: "ყავლაშვილის",
  17: "ლენინგრადის",
  18: "ლვოვის",
  19: "კიევი",
  20: "თბილისური ეზო",
  25: "მოსკოვის",
  26: "ქალაქური",
  27: "ჩეხური",
  28: "ხრუშჩოვის",
  29: "თუხარელის",
  30: "ვეძისი",
  36: "იუგოსლავიის",
  38: "მეტრომშენის",
};

export const SSGE_LAND_TYPE: Record<number, string> = {
  1: "სასოფლო-სამეურნეო მიწა",
  2: "არასასოფლო-სამეურნეო მიწა",
  3: "კომერციული მიწა",
  4: "სპეციალური მიწა",
  5: "საინვესტიციო მიწა",
  6: "ფერმერული მიწა",
};

export const SSGE_COMMERCIAL_TYPE: Record<number, string> = {
  6: "სასაწყობე/საწარმოო ფართი",
  7: "საოფისე ფართი",
  13: "კვების ობიექტი",
  14: "გარაჟი",
  21: "სარდაფი",
  22: "სავაჭრო ობიექტი",
  31: "კომერციული ფართი",
};

export const DEFAULT_SSGE_SERVICE = "Standard";
export const DEFAULT_SSGE_SERVICE_DAYS = parseInt(
  process.env.SSGE_SERVICE_DAYS || "30",
  10
);
