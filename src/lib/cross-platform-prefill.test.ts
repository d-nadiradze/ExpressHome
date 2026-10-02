/**
 * Run: npx tsx src/lib/cross-platform-prefill.test.ts
 */
import assert from "node:assert/strict";
import {
  normalizeListingForMyhomePrefill,
  stripPhoneNumbersFromDescription,
} from "./cross-platform-prefill";
import type { MyhomeListing } from "./myhome-parser";

// myhome listing 26123169 carries the seller's WhatsApp number in its comment.
assert.equal(
  stripPhoneNumbersFromDescription(
    "მშვიდ და წყნარ ადგილას ვარ მეპატრონე დამიკავშირდით ვათსაფზე 599222352"
  ),
  "მშვიდ და წყნარ ადგილას ვარ მეპატრონე დამიკავშირდით ვათსაფზე"
);

for (const phone of ["599 22 23 52", "599-222-352", "+995 599 222 352", "995599222352"]) {
  assert.equal(stripPhoneNumbersFromDescription(`ტელ: ${phone} გმადლობთ`), "ტელ: გმადლობთ", phone);
}

// Prices, areas and floors stay untouched.
for (const text of [
  "💰 ფასი: 282 000$",
  "ფასი 550 000 000 ₾",
  "• ფართი: 123 კვ.მ • სართული: 8/19",
  "ს/კ 01.10.15.005.123",
]) {
  assert.equal(stripPhoneNumbersFromDescription(text), text, text);
}

// Line breaks survive the scrub.
assert.equal(
  stripPhoneNumbersFromDescription("პირველი\n\nმეორე 577123456\nმესამე"),
  "პირველი\n\nმეორე\nმესამე"
);

const listing: MyhomeListing = {
  title: "იყიდება 2 ოთახიანი ბინა კრწანისში",
  propertyType: "ბინა",
  dealType: "იყიდება",
  buildingStatus: "ახალი აშენებული",
  condition: "ახალი გარემონტებული",
  city: "თბილისი",
  address: "კრწანისის ქ.",
  street: "კრწანისის ქ.",
  streetNumber: "",
  cadastralCode: "",
  projectType: "არასტანდარტული",
  price: "157500",
  pricePerSqm: "3500",
  currency: "USD",
  area: "45",
  rooms: "2",
  bedrooms: "1",
  bathrooms: "1",
  floor: "7",
  totalFloors: "7",
  balconyArea: "6",
  verandaArea: "",
  loggiaArea: "",
  description: "დამიკავშირდით ვათსაფზე 599222352",
  images: [],
  ownerName: "ამალია",
  mobileNumber: "591941***",
  rawData: { მესაკუთრე: "ამალია", ნომერი: "591941***" },
};

const normalized = normalizeListingForMyhomePrefill(listing, {
  sourceUrl: "https://www.myhome.ge/udzravi-qoneba/iyideba-2-otaxiani-bina-krwanisshi-26123169/",
});
assert.equal(normalized.description, "დამიკავშირდით ვათსაფზე");
assert.equal(normalized.ownerName, undefined);
assert.equal(normalized.rawData["ნომერი"], undefined);

console.log("cross-platform-prefill.test.ts: OK");
