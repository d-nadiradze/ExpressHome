/**
 * Run: npx tsx src/lib/retry-cooldown.test.ts
 */
import assert from "node:assert/strict";
import { createCooldown, formatCooldownMs } from "./retry-cooldown";

async function main() {
  const cd = createCooldown(10_000);

  assert.equal(cd.get(), null, "fresh cooldown allows attempts");

  cd.fail(undefined, "Cloudflare challenge");
  const active = cd.get();
  assert.ok(active, "failure activates the cooldown");
  assert.equal(active.reason, "Cloudflare challenge");
  assert.ok(active.remainingMs > 9_000 && active.remainingMs <= 10_000);
  console.log("ok failure blocks further attempts");

  // Keys are independent (one ss.ge account's login failing must not block another's).
  assert.equal(cd.get("user-b"), null);
  cd.fail("user-b", "bad password", 50);
  assert.ok(cd.get("user-b"));
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(cd.get("user-b"), null, "cooldown expires on its own");
  assert.ok(cd.get(), "default key still active");
  console.log("ok keys are independent and expire");

  cd.clear();
  assert.equal(cd.get(), null, "clear() lifts the cooldown");
  cd.fail(undefined, "x", 0);
  assert.equal(cd.get(), null, "ms<=0 records nothing");
  console.log("ok clear and zero duration");

  assert.equal(formatCooldownMs(999), "1s");
  assert.equal(formatCooldownMs(45_000), "45s");
  assert.equal(formatCooldownMs(200_000), "3m 20s");
  assert.equal(formatCooldownMs(600_000), "10m");
  console.log("ok formatting");

  console.log("retry-cooldown tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
