/**
 * Run: npx tsx src/lib/ssge-api-token-cache.test.ts
 */
import assert from "node:assert/strict";
import { decodeJwtExpiryMs } from "./ssge-api-token-cache";

function b64url(obj: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

const token = `hdr.${b64url({ exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
const exp = decodeJwtExpiryMs(token);
assert.ok(exp && exp > Date.now());

const bad = decodeJwtExpiryMs("not-a-jwt");
assert.equal(bad, null);

console.log("All ssge-api-token-cache tests passed.");
