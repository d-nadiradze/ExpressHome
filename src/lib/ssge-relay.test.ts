/**
 * ss.ge token relay — the parts that need no Redis/DB.
 * The pull/push round-trip is exercised against the real stack on the VPS.
 */
import assert from "node:assert/strict";
import {
  isRelayConfigured,
  isValidRelaySecret,
  mintUserRelayToken,
  relayRequired,
} from "@/lib/ssge-relay";

// Unconfigured: nothing is accepted and the endpoint should hide itself.
delete process.env.SSGE_RELAY_SECRET;
delete process.env.SSGE_RELAY_LOCAL_FALLBACK;
assert.equal(isRelayConfigured(), false);
assert.equal(relayRequired(), false, "no relay → local chain allowed");
assert.equal(isValidRelaySecret("Bearer anything"), false);
assert.equal(isValidRelaySecret(null), false);
assert.throws(() => mintUserRelayToken("abc"), /SSGE_RELAY_SECRET/);

process.env.SSGE_RELAY_SECRET = "s3cret-value-123";
assert.equal(isRelayConfigured(), true);
assert.equal(relayRequired(), true, "relay configured → local Chromium/Playwright chain off");
process.env.SSGE_RELAY_LOCAL_FALLBACK = "true";
assert.equal(relayRequired(), false, "explicit override re-enables the local chain");
delete process.env.SSGE_RELAY_LOCAL_FALLBACK;

// Per-user tokens: deterministic, user-bound, secret-bound, not the secret.
const userId = "clx1234567890abcdefghij";
const token = mintUserRelayToken(userId);
assert.match(token, /^u\.clx1234567890abcdefghij\.[0-9a-f]{64}$/);
assert.equal(mintUserRelayToken(userId), token, "stable for the same user");
assert.notEqual(mintUserRelayToken("clx1234567890abcdefghik"), token, "differs per user");
assert.equal(isValidRelaySecret(`Bearer ${token}`), false, "user token is not the admin secret");
process.env.SSGE_RELAY_SECRET = "other-secret";
assert.notEqual(mintUserRelayToken(userId), token, "rotating the secret invalidates tokens");
process.env.SSGE_RELAY_SECRET = "s3cret-value-123";
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
