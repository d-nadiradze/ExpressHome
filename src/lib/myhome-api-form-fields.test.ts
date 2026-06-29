/**
 * Run: npx tsx src/lib/myhome-api-form-fields.test.ts
 */
import assert from "node:assert/strict";
import {
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

console.log("myhome-api-form-fields.test.ts: OK");
