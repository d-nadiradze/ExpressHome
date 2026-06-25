/**
 * Run: npx tsx src/lib/google-sheets-row.test.ts
 */
import assert from "node:assert/strict";
import {
  abbreviateBuildingStatusForSheet,
  abbreviateConditionForSheet,
  buildBrokerSheetListingFromDb,
  extractMyhomeListingId,
  extractSsgeListingId,
  formatBrokerSheetPrice,
  listingToBrokerSheetRow,
  padBrokerSheetRow,
  resolveSheetBuildingStatus,
  resolveSheetCadastralComment,
  BROKER_SHEET_COLUMN_COUNT,
} from "./google-sheets-row";

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}`);
    throw err;
  }
}

test("myhome id from source url", () => {
  assert.equal(
    extractMyhomeListingId("https://www.myhome.ge/pr/25010057/foo/"),
    "25010057"
  );
});

test("myhome id from udzravi-qoneba seo url", () => {
  assert.equal(
    extractMyhomeListingId(
      "https://www.myhome.ge/udzravi-qoneba/25128941/qiravdeba-2-otaxiani-bina-did-dighomshi/"
    ),
    "25128941"
  );
});

test("ss id from post url", () => {
  assert.equal(
    extractSsgeListingId(
      "https://home.ss.ge/ka/udzravi-qoneba/35709761",
      "https://www.myhome.ge/pr/1/"
    ),
    "35709761"
  );
});

test("price with dollar suffix", () => {
  assert.equal(formatBrokerSheetPrice("400000", "USD"), "400000$");
});

test("building and condition abbreviations", () => {
  assert.equal(abbreviateBuildingStatusForSheet("ძველი აშენებული"), "ძვ/კორპ");
  assert.equal(abbreviateConditionForSheet("ახალი გარემონტებული"), "ახ/რემონტ");
});

test("padBrokerSheetRow keeps 16 columns when leading cells empty", () => {
  const padded = padBrokerSheetRow(["", "", "", "", "", "", "", "", "Nik", "592"]);
  assert.equal(padded.length, BROKER_SHEET_COLUMN_COUNT);
  assert.equal(padded[8], "Nik");
  assert.equal(padded[0], "");
});

test("myhome statement id from www and statements host", () => {
  assert.equal(
    extractMyhomeListingId(
      "https://www.myhome.ge/pr/25010057/foo/",
      "https://statements.myhome.ge/ka/statement/25010057"
    ),
    "25010057"
  );
});

test("ss.ge კერძო სახლი exports m2 from სახლის ფართი", () => {
  const listing = buildBrokerSheetListingFromDb({
    sourceUrl: "https://home.ss.ge/ka/udzravi-qoneba/24270189",
    postUrl: null,
    ssgePostUrl: "https://home.ss.ge/ka/udzravi-qoneba/24270189",
    propertyType: "კერძო სახლი",
    price: "240000",
    currency: "USD",
    area: "",
    city: "თბილისი",
    address: "",
    street: "ცინცაძე ს. ქ.",
    streetNumber: "12",
    buildingStatus: "ახალი აშენებული",
    condition: "ახალი გარემონტებული",
    floor: "",
    totalFloors: "",
    rooms: "5",
    bedrooms: "3",
    description: "",
    createdAt: new Date("2026-06-04T12:00:00Z"),
    rawData: {
      "სახლის ფართი": "144",
      "ეზოს ფართი": "200",
      "მესაკუთრე": "Nik",
      "ნომერი": "592211000",
    },
  });
  const row = listingToBrokerSheetRow(listing);
  assert.equal(row[7], "144");
});

test("myhome parsed row uses rawData სტატუსი/მდგომარეობა", () => {
  const listing = buildBrokerSheetListingFromDb({
    sourceUrl: "https://www.myhome.ge/pr/24953278/",
    postUrl: null,
    ssgePostUrl: null,
    propertyType: "ბინა",
    price: "333250",
    currency: "GEL",
    area: "115",
    city: "თბილისი",
    address: "",
    street: "თემქა - ზღვისუბანი X კვარტ",
    streetNumber: "",
    buildingStatus: "",
    condition: "",
    floor: "5",
    totalFloors: "5",
    rooms: "5",
    bedrooms: "3",
    description: "should not export",
    createdAt: new Date("2026-06-03T12:00:00Z"),
    rawData: {
      სტატუსი: "ძველი აშენებული",
      მდგომარეობა: "ახალი გარემონტებული",
      მესაკუთრე: "სერგი",
      ნომერი: "558016000",
      რაიონი: "თემქა",
    },
  });
  assert.equal(resolveSheetBuildingStatus(listing), "ძველი აშენებული");
  const row = listingToBrokerSheetRow(listing, {
    exportDate: new Date("2026-06-03T12:00:00Z"),
  });
  assert.equal(row[0], "სერგი");
  assert.equal(row[3], "");
  assert.equal(row[4], "");
  assert.equal(row[5], "333250₾");
  assert.equal(row[8], "თემქა");
  assert.equal(row[10], "ძვ/კორპ");
  assert.equal(row[11], "ახ/რემონტ");
  assert.equal(row[15], "");
});

test("cadastral code exports to კომენტარი", () => {
  const listing = buildBrokerSheetListingFromDb({
    sourceUrl: "https://home.ss.ge/ka/udzravi-qoneba/24270189",
    cadastralCode: "01.10.01.001.001.001",
    propertyType: "ბინა",
    price: "100000",
    currency: "USD",
    area: "50",
    city: "თბილისი",
    address: "",
    street: "",
    streetNumber: "",
    buildingStatus: "",
    condition: "",
    floor: "",
    totalFloors: "",
    rooms: "",
    bedrooms: "",
    description: "must not export as comment",
    createdAt: new Date(),
  });
  assert.equal(resolveSheetCadastralComment(listing), "01.10.01.001.001.001");
  const row = listingToBrokerSheetRow(listing);
  assert.equal(row[15], "01.10.01.001.001.001");
});

test("cadastral from rawData when DB field empty", () => {
  const listing = buildBrokerSheetListingFromDb({
    sourceUrl: "https://www.myhome.ge/pr/1/",
    cadastralCode: null,
    propertyType: "ბინა",
    price: "",
    currency: "USD",
    area: "",
    city: "",
    address: "",
    street: "",
    streetNumber: "",
    buildingStatus: "",
    condition: "",
    floor: "",
    totalFloors: "",
    rooms: "",
    bedrooms: "",
    createdAt: new Date(),
    rawData: { "საკადასტრო კოდი": "12.34.56.789" },
  });
  assert.equal(listingToBrokerSheetRow(listing)[15], "12.34.56.789");
});

test("broker row shape", () => {
  const row = listingToBrokerSheetRow(
    {
      sourceUrl: "https://www.myhome.ge/pr/25010057/",
      postUrl: null,
      ssgePostUrl: "https://home.ss.ge/ka/udzravi-qoneba/35709761",
      price: "400000",
      currency: "USD",
      area: "180",
      city: "ვაკე",
      street: "ფალიაშვილის ქ",
      streetNumber: "47 ა",
      buildingStatus: "ძველი აშენებული",
      condition: "ახალი გარემონტებული",
      floor: "5",
      totalFloors: "9",
      rooms: "4",
      bedrooms: "3",
      description: "Test comment",
      createdAt: new Date("2026-06-03T12:00:00Z"),
      rawData: {
        მესაკუთრე: "ნატა",
        ნომერი: "551156202",
        საკომისიო: "10000",
      },
    },
    { exportDate: new Date("2026-06-03T12:00:00Z") }
  );
  assert.equal(row[0], "ნატა");
  assert.equal(row[1], "551156202");
  assert.equal(row[3], "");
  assert.equal(row[4], "35709761");
  assert.equal(row[5], "400000$");
  assert.equal(row[6], "10000$");
  assert.equal(row[7], "180");
  assert.equal(row[9], "ფალიაშვილის ქ 47 ა");
  assert.equal(row[10], "ძვ/კორპ");
  assert.equal(row[11], "ახ/რემონტ");
  assert.equal(row[12], "5/9");
  assert.equal(row[15], "");
  assert.equal(row.length, 16);
});

console.log("All google-sheets-row tests passed.");
