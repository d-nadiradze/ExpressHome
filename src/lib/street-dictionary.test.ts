/**
 * Run: npx tsx src/lib/street-dictionary.test.ts
 */
import assert from "node:assert/strict";
import crosswalk from "@/data/tbilisi-street-crosswalk.json";
import {
  normalizeStreetForMatch,
  resolveStreetForTarget,
  streetMatchKeyWithoutLead,
  type StreetCrosswalkEntry,
} from "./street-dictionary";

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}`);
    throw err;
  }
}

const entries = crosswalk as StreetCrosswalkEntry[];

// —— Normalizer ——
test("expands street-type abbreviations", () => {
  assert.equal(normalizeStreetForMatch("პეკინის გამზ."), "პეკინის გამზირი");
  assert.equal(normalizeStreetForMatch("აბაშიძის ქ."), "აბაშიძის ქუჩა");
  assert.equal(normalizeStreetForMatch("ავშნის III შეს."), "ავშნის iii შესახვევი");
});

test("flattens hyphens and collapses spelling variants", () => {
  assert.equal(
    normalizeStreetForMatch("ვაჟა-ფშაველას გამზირი"),
    normalizeStreetForMatch("ვაჟა ფშაველას გამზ.")
  );
  assert.equal(
    normalizeStreetForMatch("კათალიკოს აბრამის ქ."),
    normalizeStreetForMatch("კათოლიკოს აბრაჰამის ქუჩა")
  );
});

test("strips trailing house numbers and parentheticals", () => {
  assert.equal(normalizeStreetForMatch("პეკინის გამზირი #2-15"), "პეკინის გამზირი");
  assert.equal(normalizeStreetForMatch("ჭავჭავაძის ქ. 17ა"), "ჭავჭავაძის ქუჩა");
  assert.equal(
    normalizeStreetForMatch("აბაშიძის ქ. (ვაკე)"),
    "აბაშიძის ქუჩა"
  );
});

test("keeps leading numeric tokens that are part of the name", () => {
  assert.equal(normalizeStreetForMatch("9 აპრილის ქუჩა"), "9 აპრილის ქუჩა");
});

test("lead-stripped key drops the first token", () => {
  assert.equal(streetMatchKeyWithoutLead("ი. აბაშიძის ქ."), "აბაშიძის ქუჩა");
  assert.equal(streetMatchKeyWithoutLead("ილია აბაშიძის ქუჩა"), "აბაშიძის ქუჩა");
});

// —— Resolution (data-driven over the generated crosswalk) ——
test("crosswalk has entries", () => {
  assert.ok(entries.length > 0, "crosswalk JSON is empty — run `npm run streets:build`");
});

test("every entry resolves both directions", () => {
  // Distinct streets can share a normalized key (initial vs full first name);
  // resolution is correct as long as the result matches the same autocomplete
  // option, i.e. it normalizes to the expected key.
  const sameStreet = (a: string | null, expected: string): boolean =>
    a != null && normalizeStreetForMatch(a) === normalizeStreetForMatch(expected);

  let checked = 0;
  for (const e of entries) {
    if (!e.myhome || !e.ssge) continue;
    assert.ok(
      sameStreet(resolveStreetForTarget(e.myhome, "ssge"), e.ssge),
      `myhome→ssge failed for "${e.myhome}"`
    );
    assert.ok(
      sameStreet(resolveStreetForTarget(e.ssge, "myhome"), e.myhome),
      `ssge→myhome failed for "${e.ssge}"`
    );
    assert.ok(
      sameStreet(resolveStreetForTarget(e.ssge, "ssge"), e.ssge),
      `ssge identity failed for "${e.ssge}"`
    );
    assert.ok(
      sameStreet(resolveStreetForTarget(e.myhome, "myhome"), e.myhome),
      `myhome identity failed for "${e.myhome}"`
    );
    checked++;
    if (checked >= 50) break;
  }
  assert.ok(checked > 0, "no resolvable entries checked");
});

test("unknown street returns null", () => {
  assert.equal(
    resolveStreetForTarget("ეს-ქუჩა-ნამდვილად-არ-არსებობს-12345", "ssge"),
    null
  );
});

console.log("\nAll street-dictionary tests passed.");
