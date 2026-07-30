/**
 * Run: npx tsx src/lib/ssge-api-reverse.test.ts
 */
import assert from "node:assert/strict";
import { reverseSsgeProjectId } from "./ssge-api-reverse";
import { resolveSsgeProjectChip } from "./ssge-mappings";

const raw = {
  პროექტი: "არასტანდარტული",
  "პროექტის ტიპი": "არასტანდარტული",
};

assert.equal(resolveSsgeProjectChip("არასტანდარტული", raw), "არასტანდარტული");
assert.equal(
  reverseSsgeProjectId("არასტანდარტული", raw),
  4,
  "არასტანდარტული must map to ss.ge id 4, not 36"
);

assert.equal(reverseSsgeProjectId("8", raw), 4, "myhome id 8 must not leak as ss.ge id 8");
assert.equal(reverseSsgeProjectId("ხრუშოვის", { ...raw, პროექტი: "ხრუშოვის" }), 28);
assert.equal(
  reverseSsgeProjectId("იტალიური ეზო", { ...raw, პროექტი: "იტალიური ეზო" }),
  20
);

console.log("ssge-api-reverse.test.ts: ok");
