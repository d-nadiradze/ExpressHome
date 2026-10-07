/**
 * Run: npx tsx src/lib/listing-url-ssge.test.ts
 */
import assert from "node:assert/strict";
import { extractSsgeListingIdFromUrl } from "./listing-url";

assert.equal(
  extractSsgeListingIdFromUrl(
    "https://home.ss.ge/ka/udzravi-qoneba/iyideba-2-otaxiani-bina-did-dighomshi-36784185"
  ),
  "36784185"
);
assert.equal(
  extractSsgeListingIdFromUrl(
    "https://home.ss.ge/ka/udzravi-qoneba/iyideba-2-otaxiani-bina-did-dighomshi-36784185/"
  ),
  "36784185"
);
assert.equal(extractSsgeListingIdFromUrl("https://www.myhome.ge/pr/123/"), null);
assert.equal(extractSsgeListingIdFromUrl("https://example.com/foo-36784185"), null);

console.log("listing-url-ssge tests passed");
