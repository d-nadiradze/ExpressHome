/**
 * Run: npx tsx src/lib/building-status-sanitize.test.ts
 *
 * Regression: listing scrape glues სტატუსი label + duplicated chip into one string
 * (seen on myhome create-form prefill as an invalid preference value).
 */
import assert from "node:assert/strict";
import { sanitizeBuildingStatusValue } from "./building-status-sanitize";

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}`);
    throw err;
  }
}

test("glued label + duplicated ძველი აშენებული (ss.ge / flex scrape)", () => {
  assert.equal(
    sanitizeBuildingStatusValue(
      "სტატუსიძველი აშენებულიძველი აშენებული"
    ),
    "ძველი აშენებული"
  );
});

test("spaced duplicate still dedupes", () => {
  assert.equal(
    sanitizeBuildingStatusValue("ძველი აშენებული ძველი აშენებული"),
    "ძველი აშენებული"
  );
});

test("clean chip unchanged", () => {
  assert.equal(
    sanitizeBuildingStatusValue("ახალი აშენებული"),
    "ახალი აშენებული"
  );
});

test("glued label prefix with spaces", () => {
  assert.equal(
    sanitizeBuildingStatusValue("სტატუსი ძველი აშენებული"),
    "ძველი აშენებული"
  );
});

console.log("building-status-sanitize: all passed");
