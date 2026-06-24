/**
 * Run: npx tsx src/lib/ssge-mappings.test.ts
 */
import assert from "node:assert/strict";
import {
  isCommercialPropertyType,
  isMyhomeCommercialTypeValue,
  resolveSsgeCommercialTypeChip,
} from "./ssge-mappings";
import { normalizeListingForSsgePrefill } from "./cross-platform-prefill";
import type { MyhomeListing } from "./myhome-parser";

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}`);
    throw err;
  }
}

test("detects commercial property types", () => {
  assert.equal(isCommercialPropertyType("კომერციული"), true);
  assert.equal(isCommercialPropertyType("კომერციული ფართი"), true);
  assert.equal(isCommercialPropertyType("ბინა"), false);
});

test("maps myhome universal status to ss.ge commercial space chip", () => {
  assert.equal(resolveSsgeCommercialTypeChip("უნივერსალური"), "კომერციული ფართი");
  assert.equal(isMyhomeCommercialTypeValue("უნივერსალური"), true);
  assert.equal(isMyhomeCommercialTypeValue("ახალი აშენებული"), false);
});

test("maps other myhome commercial statuses", () => {
  assert.equal(resolveSsgeCommercialTypeChip("საოფისე"), "საოფისე ფართი");
  assert.equal(resolveSsgeCommercialTypeChip("სავაჭრო"), "სავაჭრო ობიექტი");
  assert.equal(
    resolveSsgeCommercialTypeChip("სასაწყობე"),
    "სასაწყობე/საწარმოო ფართი"
  );
  assert.equal(resolveSsgeCommercialTypeChip("ავტოფარეხი"), "გარაჟი");
});

test("normalizes myhome commercial listing for ss.ge prefill", () => {
  const listing: MyhomeListing = {
    title: "კომერციული ფართი",
    propertyType: "კომერციული ფართი",
    dealType: "იყიდება",
    buildingStatus: "უნივერსალური",
    condition: "გარემონტებული",
    city: "თბილისი",
    address: "",
    street: "",
    streetNumber: "",
    cadastralCode: "",
    price: "100000",
    pricePerSqm: "",
    currency: "USD",
    area: "120",
    rooms: "",
    bedrooms: "",
    floor: "",
    totalFloors: "",
    projectType: "",
    bathrooms: "",
    balconyArea: "",
    verandaArea: "",
    loggiaArea: "",
    description: "",
    images: [],
    rawData: { სტატუსი: "უნივერსალური" },
    ownerName: "",
    mobileNumber: "",
  };

  const normalized = normalizeListingForSsgePrefill(listing);
  assert.equal(normalized.propertyType, "კომერციული");
  assert.equal(
    normalized.rawData?.["კომერციული ფართის ტიპი"],
    "კომერციული ფართი"
  );
  assert.equal(normalized.rawData?.["სტატუსი"], undefined);
  assert.equal(normalized.buildingStatus, "");
  assert.equal(normalized.projectType, "");
});

console.log("ssge-mappings tests passed");
