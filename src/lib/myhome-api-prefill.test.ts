/**
 * Run: npx tsx src/lib/myhome-api-prefill.test.ts
 */
import assert from "node:assert/strict";
import { resolveMyhomePublishContact } from "./myhome-api-prefill";

const ok = resolveMyhomePublishContact({
  phone: "+995 597 05 78 57",
  name: "ზაზა",
});
assert.equal(ok.phone, "597057857");
assert.equal(ok.ownerName, "ზაზა");
assert.equal(ok.error, undefined);

const fromApiField = resolveMyhomePublishContact({
  phone: "597057857",
  name: "Agent",
});
assert.equal(fromApiField.phone, "597057857");
assert.equal(fromApiField.error, undefined);

const missing = resolveMyhomePublishContact({});
assert.ok(missing.error);
assert.equal(missing.phone, "");

console.log("myhome-api-prefill.test.ts: ok");
