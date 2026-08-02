/**
 * The invariant under test: a listing is never posted twice.
 *
 * Before this, a myhome API prefill that created the statement and then failed
 * on the publish fee handed over to the browser flow, which created a second
 * listing for the same parse.
 *
 * Run: npx tsx src/lib/prefill-fallback.test.ts
 */
import assert from "node:assert/strict";
import { isPartialSuccess, shouldRetryInBrowser } from "./prefill-fallback";

let passed = 0;

function test(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`ok ${name}`);
}

test("a failure before anything was created retries in a browser", () => {
  const result = { success: false, error: "login failed" };
  assert.equal(shouldRetryInBrowser(result, true), true);
  assert.equal(isPartialSuccess(result), false);
});

test("a created listing is never retried in a browser", () => {
  const result = {
    success: false,
    error: "Payment init failed (HTTP 422)",
    listingCreated: true,
    postUrl: "https://statements.myhome.ge/ka/user-profile/my-statements",
  };
  assert.equal(shouldRetryInBrowser(result, true), false);
  assert.equal(isPartialSuccess(result), true);
});

test("fallback stays off when it is disabled", () => {
  assert.equal(shouldRetryInBrowser({ success: false }, false), false);
});

test("a success never retries and is not partial", () => {
  const result = { success: true, postUrl: "https://home.ss.ge/x", listingCreated: true };
  assert.equal(shouldRetryInBrowser(result, true), false);
  assert.equal(isPartialSuccess(result), false);
});

console.log(`\n${passed} passed`);
