/**
 * ss.ge token relay — the parts that need no Redis/DB.
 * The pull/push round-trip is exercised against the real stack on the VPS.
 */
import assert from "node:assert/strict";
import { isRelayConfigured, isValidRelaySecret } from "@/lib/ssge-relay";

// Unconfigured: nothing is accepted and the endpoint should hide itself.
delete process.env.SSGE_RELAY_SECRET;
assert.equal(isRelayConfigured(), false);
assert.equal(isValidRelaySecret("Bearer anything"), false);
assert.equal(isValidRelaySecret(null), false);

process.env.SSGE_RELAY_SECRET = "s3cret-value-123";
assert.equal(isRelayConfigured(), true);
assert.equal(isValidRelaySecret("Bearer s3cret-value-123"), true, "Bearer prefix accepted");
assert.equal(isValidRelaySecret("bearer s3cret-value-123"), true, "prefix is case-insensitive");
assert.equal(isValidRelaySecret("s3cret-value-123"), true, "bare secret accepted");
assert.equal(isValidRelaySecret("Bearer s3cret-value-124"), false, "wrong secret rejected");
assert.equal(isValidRelaySecret("Bearer s3cret-value-12"), false, "length mismatch rejected");
assert.equal(isValidRelaySecret(""), false);
assert.equal(isValidRelaySecret(null), false);

// Whitespace-only secret counts as unset.
process.env.SSGE_RELAY_SECRET = "   ";
assert.equal(isRelayConfigured(), false);
assert.equal(isValidRelaySecret("Bearer    "), false);

console.log("ssge-relay.test.ts: all assertions passed");
