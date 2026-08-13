/**
 * Run: npx tsx src/lib/listing-url.test.ts
 */
import assert from "node:assert/strict";
import {
  extractMyhomeListingIdFromUrl,
  normalizeListingUrl,
} from "./listing-url";

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}`);
    throw err;
  }
}

test("extracts /pr/{id}/", () => {
  assert.equal(
    extractMyhomeListingIdFromUrl("https://www.myhome.ge/pr/25010057/foo/"),
    "25010057"
  );
});

test("extracts /udzravi-qoneba/{id}/slug/", () => {
  assert.equal(
    extractMyhomeListingIdFromUrl(
      "https://www.myhome.ge/udzravi-qoneba/25128941/qiravdeba-2-otaxiani-bina-did-dighomshi/"
    ),
    "25128941"
  );
});

test("extracts /udzravi-qoneba/{slug}-{id}/", () => {
  assert.equal(
    extractMyhomeListingIdFromUrl(
      "https://www.myhome.ge/udzravi-qoneba/iyideba-3-otaxiani-bina-san-zonashi-25495762/"
    ),
    "25495762"
  );
});

test("normalize maps slug SEO url to /pr/{id}/", () => {
  assert.equal(
    normalizeListingUrl(
      "https://www.myhome.ge/udzravi-qoneba/iyideba-3-otaxiani-bina-san-zonashi-25495762/"
    ),
    "https://www.myhome.ge/pr/25495762/"
  );
});

console.log("listing-url tests passed");
