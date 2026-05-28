/** Shared city resolution for listing location prefill (myhome + ss.ge). */

export const KNOWN_CITIES_FOR_PREFILL = [
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
  "ბორჯომი",
  "ზესტაფონი",
  "თერჯოლა",
  "სენაკი",
  "გაგრა",
  "გუდაური",
  "ბოლნისი",
  "ახალციხე",
  "ონი",
  "ჭიათურა",
  "აბაშა",
  "მარტვილი",
  "წყალტუბო",
  "სამტრედია",
  "ხონი",
  "ვანი",
  "ბაღდათი",
  "საჩხერე",
  "ტყიბული",
  "კასპი",
  "ქარელი",
  "დუშეთი",
  "სტეფანწმინდა",
  "ახმეტა",
  "გურჯაანი",
  "ყვარელი",
  "ლაგოდეხი",
  "დედოფლისწყარო",
  "საგარეჯო",
  "გარდაბანი",
  "მარნეული",
  "წალკა",
  "თეთრიწყარო",
  "დმანისი",
  "ახალქალაქი",
  "ნინოწმინდა",
  "ამბროლაური",
  "ლენტეხი",
  "მესტია",
  "ხობი",
  "წალენჯიხა",
  "ჩხოროწყუ",
  "თიანეთი",
  "ლანჩხუთი",
  "ჩოხატაური",
  "ხელვაჩაური",
  "შუახევი",
  "ქედა",
  "ურეკი",
  "გრიგოლეთი",
  "შეკვეთილი",
  "ანაკლია",
  "წნორი",
  "ახალსოფელი",
  "კობულეთი",
] as const;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cityMatchesInText(text: string, city: string): boolean {
  const re = new RegExp(
    `(?:^|[\\s,;.\\-/])${escapeRegExp(city)}(?:$|[\\s,;.\\-/])`,
    "u"
  );
  return re.test(text);
}

/** City only (e.g. ბათუმი), not "ბათუმი, აჭარის რეგიონი" or district names. */
export function cityForPrefill(city: string): string {
  const s = city.replace(/\s+/g, " ").trim();
  if (!s) return "";

  for (const part of s.split(",").map((p) => p.trim())) {
    if ((KNOWN_CITIES_FOR_PREFILL as readonly string[]).includes(part)) return part;
  }
  for (const c of KNOWN_CITIES_FOR_PREFILL) {
    if (cityMatchesInText(s, c)) return c;
  }
  return s.split(",")[0]?.trim() || s;
}
