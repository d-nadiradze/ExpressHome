/**
 * Run: npx tsx src/lib/market-duplicate.test.ts
 */
import assert from "node:assert/strict";
import {
  addressDuplicate,
  cadastralDuplicate,
  findAgencyDuplicate,
  listingsAreDuplicates,
  normalizeCadastral,
  normalizeFloor,
  normalizeHouseNumber,
} from "./market-duplicate";

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}`);
    throw err;
  }
}

test("normalizes cadastral punctuation", () => {
  assert.equal(normalizeCadastral(" 01.10.01.001.001.001 "), "01.10.01.001.001.001");
  assert.equal(normalizeCadastral("01 10 01 001"), "011001001");
});

test("cadastral match is strongest", () => {
  assert.equal(
    cadastralDuplicate(
      { sellerType: "OWNER", propertyType: "ბინა", cadastralCode: "01.10.01.001" },
      { sellerType: "AGENCY", propertyType: "ბინა", cadastralCode: "01.10.01.001" }
    ),
    true
  );
  assert.equal(
    listingsAreDuplicates(
      {
        sellerType: "OWNER",
        propertyType: "ბინა",
        cadastralCode: "01.10.01.001",
        street: "other",
      },
      {
        sellerType: "AGENCY",
        propertyType: "კერძო სახლი",
        cadastralCode: "01.10.01.001",
      }
    ),
    "cadastral"
  );
});

test("empty cadastral does not match", () => {
  assert.equal(
    cadastralDuplicate(
      { sellerType: "OWNER", propertyType: "ბინა", cadastralCode: "" },
      { sellerType: "AGENCY", propertyType: "ბინა", cadastralCode: "" }
    ),
    false
  );
});

test("address match requires street, number, floor, area ±2, type", () => {
  const owner = {
    sellerType: "OWNER",
    propertyType: "ბინა",
    city: "თბილისი",
    street: "პეკინის გამზ.",
    streetNumber: "12ა",
    floor: "5",
    area: "64.5",
  };
  const agency = {
    sellerType: "AGENCY",
    propertyType: "ბინა",
    city: "Tbilisi",
    street: "პეკინის გამზირი",
    streetNumber: "12ა",
    floor: "5",
    area: "66",
  };
  assert.equal(addressDuplicate(owner, agency), true);
  assert.equal(listingsAreDuplicates(owner, agency), "address");
  assert.equal(addressDuplicate(owner, { ...agency, area: "70" }), false);
  assert.equal(addressDuplicate(owner, { ...agency, floor: "6" }), false);
  assert.equal(addressDuplicate(owner, { ...agency, streetNumber: "13" }), false);
  assert.equal(addressDuplicate(owner, { ...agency, propertyType: "კერძო სახლი" }), false);
});

test("missing floor or house number is not an address duplicate", () => {
  const base = {
    sellerType: "OWNER" as const,
    propertyType: "მიწის ნაკვეთი",
    city: "თბილისი",
    street: "აბაშიძის ქუჩა",
    area: "400",
  };
  assert.equal(
    addressDuplicate(
      { ...base, streetNumber: "10", floor: "" },
      { ...base, sellerType: "AGENCY", streetNumber: "10", floor: "" }
    ),
    false
  );
  assert.equal(
    addressDuplicate(
      { ...base, streetNumber: "", floor: "1" },
      { ...base, sellerType: "AGENCY", streetNumber: "", floor: "1" }
    ),
    false
  );
});

test("findAgencyDuplicate skips self and non-matches", () => {
  const owner = {
    id: "o1",
    sellerType: "OWNER",
    propertyType: "ბინა",
    cadastralCode: "01.02.03",
  };
  const hit = findAgencyDuplicate(owner, [
    { id: "o1", sellerType: "AGENCY", propertyType: "ბინა", cadastralCode: "01.02.03" },
    { id: "a1", sellerType: "AGENT", propertyType: "ბინა", cadastralCode: "01.02.03" },
  ]);
  assert.equal(hit?.listing.id, "a1");
  assert.equal(hit?.reason, "cadastral");
});

test("house number and floor helpers", () => {
  assert.equal(normalizeHouseNumber("№ 12 ა"), "12ა");
  assert.equal(normalizeFloor("სართული 7"), "7");
});

console.log("market-duplicate tests passed");
