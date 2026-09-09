/**
 * Run: npx tsx src/lib/market-duplicate.test.ts
 */
import assert from "node:assert/strict";
import {
  addressBucketKey,
  addressDuplicate,
  buildAgencyIndex,
  cadastralDuplicate,
  findAgencyDuplicate,
  findAgencyDuplicateIndexed,
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

test("addressBucketKey is null without street, number, floor or area", () => {
  const full = {
    sellerType: "OWNER",
    propertyType: "ბინა",
    city: "თბილისი",
    street: "პეკინის გამზირი",
    streetNumber: "12",
    floor: "5",
    area: "64",
  };
  assert.ok(addressBucketKey(full));
  assert.equal(addressBucketKey({ ...full, streetNumber: "" }), null);
  assert.equal(addressBucketKey({ ...full, floor: "" }), null);
  assert.equal(addressBucketKey({ ...full, area: "" }), null);
  assert.equal(addressBucketKey({ ...full, street: "" }), null);
});

test("bucket key ignores spelling and city variants so copies land together", () => {
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
  assert.equal(addressBucketKey(owner), addressBucketKey(agency));
});

test("indexed matcher agrees with the linear one", () => {
  const agencies = [
    { id: "a1", sellerType: "AGENCY", propertyType: "ბინა", cadastralCode: "01.10.01.001" },
    {
      id: "a2",
      sellerType: "AGENT",
      propertyType: "ბინა",
      city: "თბილისი",
      street: "პეკინის გამზირი",
      streetNumber: "12ა",
      floor: "5",
      area: "66",
      cadastralCode: "",
    },
  ];
  const index = buildAgencyIndex(agencies);

  const byCadastral = {
    id: "o1",
    sellerType: "OWNER",
    propertyType: "ბინა",
    cadastralCode: "01.10.01.001",
  };
  const byAddress = {
    id: "o2",
    sellerType: "OWNER",
    propertyType: "ბინა",
    city: "Tbilisi",
    street: "პეკინის გამზ.",
    streetNumber: "12ა",
    floor: "5",
    area: "64.5",
    cadastralCode: "",
  };
  const original = {
    id: "o3",
    sellerType: "OWNER",
    propertyType: "ბინა",
    city: "თბილისი",
    street: "ირინა შტენბერგის ქ.",
    streetNumber: "4",
    floor: "2",
    area: "77",
    cadastralCode: "",
  };

  for (const owner of [byCadastral, byAddress, original]) {
    const linear = findAgencyDuplicate(owner, agencies);
    const indexed = findAgencyDuplicateIndexed(owner, index);
    assert.equal(Boolean(indexed), Boolean(linear), `verdict for ${owner.id}`);
    assert.equal(indexed?.reason, linear?.reason, `reason for ${owner.id}`);
  }

  assert.equal(findAgencyDuplicateIndexed(original, index), null);
});

test("indexed matcher never matches a listing against itself", () => {
  const row = {
    id: "same",
    sellerType: "AGENCY",
    propertyType: "ბინა",
    cadastralCode: "01.02.03",
  };
  assert.equal(findAgencyDuplicateIndexed(row, buildAgencyIndex([row])), null);
});

console.log("market-duplicate tests passed");
