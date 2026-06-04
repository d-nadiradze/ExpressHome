/**
 * Static lookup tables derived from:
 * GET https://api-statements.tnet.ge/v1/statements/statement-parameters?lang=ka&exclude_cities=1
 *
 * Use these instead of hardcoded IDs so field values stay correct if the API
 * ever returns only IDs (some fields already return the Georgian string directly,
 * but we keep the maps as fallbacks).
 */

export const MYHOME_CURRENCY: Record<number, string> = {
  1: "GEL",
  2: "USD",
};

export const MYHOME_REAL_ESTATE_TYPE: Record<number, string> = {
  1:  "ბინა",
  2:  "კერძო სახლი",
  3:  "აგარაკი",
  4:  "მიწის ნაკვეთი",
  5:  "კომერციული ფართი",
  6:  "სასტუმრო",
  9:  "სხვა",
  10: "სხვა",
  11: "სხვა",
};

export const MYHOME_DEAL_TYPE: Record<number, string> = {
  1:  "იყიდება",
  2:  "ქირავდება",
  3:  "გირავდება",
  7:  "ქირავდება დღიურად",
  10: "გაიცემა იჯარით",
};

/** Flat map of all status IDs across all real_estate_type groups */
export const MYHOME_STATUS: Record<number, string> = {
  1:  "ძველი აშენებული",
  2:  "ახალი აშენებული",
  3:  "მშენებარე",
  4:  "სასოფლო-სამეურნეო",
  5:  "არა სასოფლო-სამეურნეო",
  6:  "კომერციული",
  7:  "სპეციალური",
  8:  "საოფისე",
  9:  "სავაჭრო",
  10: "სასაწყობე",
  11: "საწარმოო",
  12: "კვების ობიექტი",
  13: "ავტოფარეხი",
  18: "საინვესტიციო",
  23: "დასრულებული",
  24: "უნივერსალური",
  25: "სარდაფი",
  26: "ნახევარსარდაფი",
  27: "მთლიანი შენობა",
  28: "ავტოსამრეცხაო",
  29: "ავტოსერვისი",
  30: "ფერმა",
};

export const MYHOME_CONDITION: Record<number, string> = {
  1: "ახალი გარემონტებული",
  2: "ძველი გარემონტებული",
  3: "მიმდინარე რემონტი",
  4: "სარემონტო",
  5: "თეთრი კარკასი",
  6: "შავი კარკასი",
  7: "მწვანე კარკასი",
  8: "თეთრი პლიუსი",
};

/** Flat map of all project_type IDs across all real_estate_type groups */
export const MYHOME_PROJECT_TYPE: Record<number, string> = {
  1:  "ლვოვის",
  2:  "ყავლაშვილის",
  3:  "თუხარელის",
  4:  "ხრუშოვის",
  5:  "ჩეხური",
  6:  "ქალაქური",
  7:  "მოსკოვის",
  8:  "არასტანდარტული",
  9:  "დუპლექსი",
  10: "ტრიპლექსი",
  11: "საერთო საცხოვრებელი",
  12: "თაუნჰაუსი",
  13: "ვილა",
  14: "m2-ის კომპლექსი",
  15: "OPTIMA m2-ისგან",
  16: "METRA PARK",
  17: "იტალიური ეზო",
  18: "ლენინგრადის",
};

/** room_type_id → display_name (note: id 6 is skipped, id 7 = "6 ოთახი") */
export const MYHOME_ROOM_TYPE: Record<number, string> = {
  1:  "1",
  2:  "2",
  3:  "3",
  4:  "4",
  5:  "5",
  7:  "6",
  8:  "7",
  9:  "8",
  10: "9",
  11: "10+",
};

export const MYHOME_BEDROOM_TYPE: Record<number, string> = {
  1:  "1",
  2:  "2",
  3:  "3",
  4:  "4",
  5:  "5",
  6:  "6",
  7:  "7",
  8:  "8",
  9:  "9",
  10: "10+",
};

export const MYHOME_BATHROOM_TYPE: Record<number, string> = {
  1: "1",
  2: "2",
  3: "3+",
  4: "საერთო",
};

export const MYHOME_HOT_WATER_TYPE: Record<number, string> = {
  1: "გაზის გამაცხელებელი",
  2: "ავზი",
  3: "დენის გამაცხელებელი",
  4: "მზის გამათბობელი",
  5: "ცხელი წყლის გარეშე",
  6: "ცენტრალური ცხელი წყალი",
  7: "ბუნებრივი ცხელი წყალი",
  8: "ინდივიდუალური",
};

export const MYHOME_HEATING_TYPE: Record<number, string> = {
  1: "ცენტრალური გათბობა",
  2: "გაზის გამათბობელი",
  3: "დენის გამათბობელი",
  5: "ცენტრალური+იატაკის გათბობა",
  6: "გათბობის გარეშე",
  7: "ინდივიდუალური",
  8: "იატაკის გათბობა",
};

export const MYHOME_PARKING_TYPE: Record<number, string> = {
  1: "ავტოფარეხი",
  2: "პარკინგის ადგილი",
  3: "პარკინგის გარეშე",
  4: "ეზოს პარკინგი",
  5: "მიწისქვეშა პარკინგი",
  6: "ფასიანი ავტოსადგომი",
};

export const MYHOME_STOREROOM_TYPE: Record<number, string> = {
  5:  "სარდაფი",
  6:  "სხვენი",
  7:  "საკუჭნაო",
  8:  "გარე სათავსო",
  9:  "საერთო სათავსო",
  10: "სარდაფი + სხვენი",
};

export const MYHOME_DOOR_WINDOW_TYPE: Record<number, string> = {
  1: "ხე",
  2: "პლასტმასა",
  3: "ალუმინი",
};

export const MYHOME_MATERIAL_TYPE: Record<number, string> = {
  1: "ბლოკი",
  2: "აგური",
  3: "ხის მასალა",
  4: "რკინა-ბეტონი",
  5: "კომბინირებული",
};
