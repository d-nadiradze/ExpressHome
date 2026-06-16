/**
 * Run: npx tsx src/lib/listing-area.test.ts
 */
import assert from "node:assert/strict";
import { resolveListingDisplayArea } from "./listing-area";

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}`);
    throw err;
  }
}

test("კერძო სახლი prefers სახლის ფართი for Quick specs m²", () => {
  assert.equal(
    resolveListingDisplayArea("", "კერძო სახლი", { "სახლის ფართი": "180" }),
    "180"
  );
});

test("ბინა keeps general area", () => {
  assert.equal(
    resolveListingDisplayArea("115", "ბინა", { "სახლის ფართი": "180" }),
    "115"
  );
});

console.log("All listing-area tests passed.");
