/**
 * Run: npx tsx src/lib/myhome-api-form-fields.test.ts
 */
import assert from "node:assert/strict";
import {
  appendExtendedCreateFields,
  parametersForPropertyType,
  resolveListingParameterIds,
  type StatementMetadata,
} from "./myhome-api-form-fields";
import type { MyhomeListing } from "./myhome-parser";

const sampleMetadata: StatementMetadata = {
  statement_parameters: {
    "1": [
      { id: 2, display_name: "ინტერნეტი", deal_types: [1] },
      { id: 10, display_name: "ავეჯი", deal_types: [1] },
      { id: 43, display_name: "საწოლი", deal_types: [1] },
      { id: 6, display_name: "ლიფტი", deal_types: [1] },
      { id: 47, display_name: "სამზარეულო + ტექნიკა", deal_types: [1] },
    ],
  },
  build_years: [{ id: 2, display_name: "1955-2000" }],
  living_room_types: [{ id: 4, display_name: "სტუდიო" }],
};

function listing(rawData: Record<string, string>): MyhomeListing {
  return {
    title: "t",
    propertyType: "ბინა",
    dealType: "იყიდება",
    buildingStatus: "",
    condition: "",
    city: "თბილისი",
    address: "",
    street: "",
    streetNumber: "",
    cadastralCode: "",
    projectType: "",
    price: "1",
    pricePerSqm: "",
    currency: "USD",
    area: "50",
    rooms: "2",
    bedrooms: "1",
    bathrooms: "1",
    floor: "5",
    totalFloors: "10",
    balconyArea: "",
    verandaArea: "",
    loggiaArea: "",
    description: "",
    images: [],
    ownerName: "",
    mobileNumber: "",
    rawData,
  };
}

const params = parametersForPropertyType(sampleMetadata, 1);
assert.equal(params.length, 5);

const amenityIds = resolveListingParameterIds(
  listing({
    ინტერნეტი: "კი",
    ლიფტი: "კი",
    საწოლი: "კი",
    "სამზარეულო + ტექნიკა": "კი",
  }),
  sampleMetadata,
  1
);
assert.deepEqual(amenityIds.sort((a, b) => a - b), [2, 6, 10, 43, 47]);

const skipped = resolveListingParameterIds(
  listing({
    გათბობა: "ცენტრალური გათბომა",
    სტატუსი: "კი",
    აივანი: "კი",
  }),
  sampleMetadata,
  1
);
assert.deepEqual(skipped, []);

function extendedFields(rawData: Record<string, string>): Record<string, string> {
  const form = new FormData();
  appendExtendedCreateFields(form, listing(rawData), sampleMetadata);
  return Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)]));
}

// myhome listing 26123169: 1 balcony of 6 m².
const myhomeBalcony = extendedFields({ "აივნის ფართი": "6", "აივნის რაოდენობა": "1" });
assert.equal(myhomeBalcony.balcony_area, "6");
assert.equal(myhomeBalcony.balconies, "1");

// ss.ge balcony toggle after the myhome defaults ran ("1/1").
const ssgeBalcony = extendedFields({ აივანი: "2/1", "აივნის ფართი": "1" });
assert.equal(ssgeBalcony.balconies, "2");

// A count without an area is rejected by myhome, so neither is sent.
const countOnly = extendedFields({ "აივნის რაოდენობა": "2" });
assert.equal(countOnly.balconies, undefined);
assert.equal(countOnly.balcony_area, undefined);

const ceiling = extendedFields({ "ჭერის სიმაღლე": "3.2 მ" });
assert.equal(ceiling.height, "3.2");
assert.equal(ceiling.ceiling_height, undefined);

console.log("myhome-api-form-fields.test.ts: OK");
