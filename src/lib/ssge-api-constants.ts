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

/** Condition (field `state`). */
export const SSGE_CONDITION: Record<number, string> = {
  8: "შავი კარკასი",
  9: "მწვანე კარკასი",
  10: "თეთრი კარკასი",
  11: "ძველი რემონტით",
  12: "სარემონტო",
  15: "მიმდინარე რემონტი",
  16: "ახალი რემონტით",
  35: "გარემონტებული",
};

/** Bathroom count (field `toilet`). */
export const SSGE_TOILET: Record<number, string> = {
  418: "1",
  419: "2",
  420: "3",
  421: "3+",
  422: "საერთო",
};

/** Project type (field `project`). Partial map — extend as verified. */
export const SSGE_PROJECT_TYPE: Record<number, string> = {
  4: "ლუქსი",
  5: "დუპლექსი",
  17: "კავკასიური",
  18: "თბილისური ეზო",
  19: "მოსკოვის",
  20: "ქალაქური",
  25: "ჩეხური",
  26: "ხრუშჩოვის",
  27: "ვერსი",
  28: "იყალთოს",
  29: "თუხარელის",
  30: "მერონიშენი",
  36: "არასტანდარტული",
  38: "კიევლების",
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
