/**
 * Run: npx tsx src/lib/street-crossfill.test.ts
 */
import assert from "node:assert/strict";
import {
  crossfillStreetForTarget,
  formatMyhomeMicroStreet,
  formatSsgeMicroStreet,
  parseMyhomeMicroStreet,
  parseSsgeMicroStreet,
} from "./street-crossfill";

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}`);
    throw err;
  }
}

// —— Temka ——
test("parse myhome micro + quarter", () => {
  const c = parseMyhomeMicroStreet("თემქა - III მ/რ I კვარტ");
  assert.deepEqual(c, {
    district: "თემქა",
    kind: "micro-quarter",
    micro: "III",
    quarter: "I",
  });
});

test("parse myhome XI II", () => {
  const c = parseMyhomeMicroStreet("თემქა - XI მ/რ II კვარტ");
  assert.deepEqual(c, {
    district: "თემქა",
    kind: "micro-quarter",
    micro: "XI",
    quarter: "II",
  });
});

test("parse myhome zghvisubani IX", () => {
  const c = parseMyhomeMicroStreet("თემქა - ზღვისუბანი IX");
  assert.deepEqual(c, {
    district: "თემქა",
    kind: "micro-quarter",
    micro: "I",
    quarter: "IX",
    temkaZghvisubani: true,
  });
});

test("parse myhome zghvisubani X კვარტ.", () => {
  const c = parseMyhomeMicroStreet("თემქა - ზღვისუბანი X კვარტ.");
  assert.deepEqual(c, {
    district: "თემქა",
    kind: "micro-quarter",
    micro: "I",
    quarter: "X",
    temkaZghvisubani: true,
  });
  assert.equal(
    formatMyhomeMicroStreet(c!),
    "თემქა - ზღვისუბანი X კვარტ."
  );
});

test("myhome zghvisubani not rewritten on myhome crossfill", () => {
  const src = "თემქა - ზღვისუბანი X კვარტ.";
  assert.equal(crossfillStreetForTarget(src, "myhome"), null);
});

test("parse ss.ge micro + quarter", () => {
  const c = parseSsgeMicroStreet("III მიკრორაიონი, I კვარტალი - თემქა");
  assert.deepEqual(c, {
    district: "თემქა",
    kind: "micro-quarter",
    micro: "III",
    quarter: "I",
  });
});

test("parse ss.ge micro only temka", () => {
  const c = parseSsgeMicroStreet("IV მიკრორაიონი - თემქა");
  assert.deepEqual(c, { district: "თემქა", kind: "micro", micro: "IV" });
});

test("myhome → ss.ge crossfill temka", () => {
  assert.equal(
    crossfillStreetForTarget("თემქა - XI მ/რ II კვარტ", "ssge"),
    "XI მიკრორაიონი, II კვარტალი - თემქა"
  );
});

test("ss.ge temka zghvisubani → myhome", () => {
  assert.equal(
    crossfillStreetForTarget("I მიკრორაიონი, X კვარტალი - თემქა", "myhome"),
    "თემქა - ზღვისუბანი X კვარტ."
  );
});

test("round-trip temka", () => {
  const src = "თემქა - III მ/რ IV კვარტ";
  const ssge = crossfillStreetForTarget(src, "ssge");
  assert.ok(ssge);
  assert.equal(crossfillStreetForTarget(ssge!, "myhome"), src);
});

// —— Gldani ——
test("parse myhome gldani III a", () => {
  const c = parseMyhomeMicroStreet("გლდანი - III ა მ/რ");
  assert.deepEqual(c, { district: "გლდანი", kind: "micro", micro: "III ა" });
});

test("parse myhome gldani georgian micro", () => {
  const c = parseMyhomeMicroStreet("გლდანი - ა მ/რ");
  assert.deepEqual(c, { district: "გლდანი", kind: "micro", micro: "ა" });
});

test("gldani crossfill both ways", () => {
  assert.equal(
    crossfillStreetForTarget("გლდანი - V მ/რ", "ssge"),
    "V მიკრორაიონი - გლდანი"
  );
  assert.equal(
    crossfillStreetForTarget("III ა მიკრორაიონი - გლდანი", "myhome"),
    "გლდანი - III ა მ/რ"
  );
});

// —— Varketili ——
test("parse myhome varketili III", () => {
  const c = parseMyhomeMicroStreet("ვარკეთილი III - I მ/რ");
  assert.deepEqual(c, { district: "ვარკეთილი", kind: "micro", micro: "I" });
});

test("varketili crossfill", () => {
  assert.equal(
    crossfillStreetForTarget("ვარკეთილი III - IV მ/რ", "ssge"),
    "IV მიკრორაიონი - ვარკეთილი"
  );
  assert.equal(
    crossfillStreetForTarget("II მიკრორაიონი - ვარკეთილი", "myhome"),
    "ვარკეთილი III - II მ/რ"
  );
});

test("ss.ge varketili row without district suffix", () => {
  const c = parseSsgeMicroStreet("IV მიკრორაიონი, II რიგი");
  assert.deepEqual(c, {
    district: "ვარკეთილი",
    kind: "micro",
    micro: "IV",
    extra: "II რიგი",
  });
  assert.equal(
    formatSsgeMicroStreet(c!),
    "IV მიკრორაიონი, II რიგი"
  );
});

// —— Vazisubani ——
test("vazisubani crossfill", () => {
  assert.equal(
    crossfillStreetForTarget("ვაზისუბანი - III მ/რ", "ssge"),
    "III მიკრორაიონი - ვაზისუბანი"
  );
  assert.equal(
    crossfillStreetForTarget("I მიკრორაიონი - ვაზისუბანი", "myhome"),
    "ვაზისუბანი - I მ/რ"
  );
});

test("vazisubani micro + quarter (კ.)", () => {
  assert.equal(
    crossfillStreetForTarget("ვაზისუბანი - IV მ/რ II კ.", "ssge"),
    "IV მიკრორაიონი, II კვარტალი - ვაზისუბანი"
  );
  assert.equal(
    crossfillStreetForTarget("IV მიკრორაიონი, I კვარტალი - ვაზისუბანი", "myhome"),
    "ვაზისუბანი - IV მ/რ I კ."
  );
});

test("vazisubani settlement micro", () => {
  assert.equal(
    crossfillStreetForTarget("ვაზისუბნის დას. - III მ/რ", "ssge"),
    "III მიკრორაიონი - ვაზისუბანი"
  );
  const c = parseMyhomeMicroStreet("ვაზისუბნის დას. - II ა მ/რ");
  assert.deepEqual(c, {
    district: "ვაზისუბანი",
    kind: "micro",
    micro: "II ა",
    myhomeHead: "ვაზისუბნის დას.",
  });
});

// —— Zemo Plato ——
test("zemo plato crossfill", () => {
  assert.equal(
    crossfillStreetForTarget("II მიკრორაიონი - ზემო პლატო", "myhome"),
    "ვარკეთილი III - II მ/რ"
  );
});

// —— Vaja-Pshavela (quarter-only) ——
test("vaja quarter-only crossfill", () => {
  assert.equal(
    crossfillStreetForTarget("ვაჟა-ფშაველა - III კვარტ.", "ssge"),
    "III კვარტალი - ვაჟა ფშაველა"
  );
  assert.equal(
    crossfillStreetForTarget("V კვარტალი - ვაჟა ფშაველა", "myhome"),
    "ვაჟა-ფშაველა - V კვარტ."
  );
});

test("vaja round-trip", () => {
  const src = "ვაჟა-ფშაველა - I კვარტ.";
  const ssge = crossfillStreetForTarget(src, "ssge");
  assert.ok(ssge);
  assert.equal(crossfillStreetForTarget(ssge!, "myhome"), src);
});

// —— Dighomi Massif (quarter-only) ——
test("dighomi massif crossfill", () => {
  assert.equal(
    crossfillStreetForTarget("დიღმის მასივი - VI კვარტ.", "ssge"),
    "VI კვარტალი - დიღმის მასივი"
  );
  assert.equal(
    crossfillStreetForTarget("II კვარტალი - დიღმის მასივი", "myhome"),
    "დიღმის მასივი - II კვარტ."
  );
});

// —— Nutsubidze plateau ——
test("nutsubidze plateau crossfill", () => {
  assert.equal(
    crossfillStreetForTarget("ნუცუბიძის პლ. III-მ/რ", "ssge"),
    "ნუცუბიძის III პლატო"
  );
  assert.equal(
    crossfillStreetForTarget("ნუცუბიძის IV პლატო", "myhome"),
    "ნუცუბიძის პლ. IV-მ/რ"
  );
});

test("nutsubidze plateau with quarter maps to plateau", () => {
  assert.equal(
    crossfillStreetForTarget("ნუცუბიძის პლ. II მ/რ, I კვარტ.", "ssge"),
    "ნუცუბიძის II პლატო"
  );
});

// —— No conversion ——
test("named street no conversion", () => {
  assert.equal(
    crossfillStreetForTarget("ავშნის III შესახვევი", "ssge"),
    null
  );
});

test("already ss.ge label returns null", () => {
  assert.equal(
    crossfillStreetForTarget("XI მიკრორაიონი, II კვარტალი - თემქა", "ssge"),
    null
  );
});

console.log("\nAll street-crossfill tests passed.");
