/**
 * Hedged photo uploads to myhome: a copy that hangs must not block the photo
 * for the whole timeout — a parallel copy is sent and the first answer wins.
 *
 * Run: npx tsx src/lib/myhome-api-upload.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Knobs are read at module load — set them before importing.
process.env.MYHOME_IMAGE_UPLOAD_HEDGE_MS = "100";
process.env.MYHOME_IMAGE_UPLOAD_TIMEOUT_MS = "2000";
process.env.MYHOME_IMAGE_UPLOAD_ATTEMPTS = "3";
process.env.MYHOME_IMAGE_UPLOAD_CONCURRENCY = "6";

const dir = mkdtempSync(path.join(tmpdir(), "mh-upload-"));
const photo = path.join(dir, "a.jpg");
writeFileSync(photo, Buffer.from("fake-jpeg"));
const session = { accessToken: "t", refreshToken: "r" };

type Behaviour = "hang" | "ok" | "http500";
let script: Behaviour[] = [];
let calls = 0;
let aborted = 0;

function okResponse(id: number) {
  return new Response(JSON.stringify({ result: true, data: { id, url: `https://cdn/${id}.jpg` } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

globalThis.fetch = ((_: unknown, init?: RequestInit) => {
  const n = ++calls;
  const behaviour = script[n - 1] ?? "ok";
  const signal = init?.signal as AbortSignal | undefined;
  return new Promise<Response>((resolve, reject) => {
    const onAbort = () => {
      aborted++;
      reject(new DOMException("This operation was aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (behaviour === "hang") return; // only the abort can settle it
    setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(behaviour === "ok" ? okResponse(n) : new Response("boom", { status: 500 }));
    }, 20);
  });
}) as typeof fetch;

async function main() {
const { uploadListingImages } = await import("./myhome-api-prefill");

async function run(name: string, s: Behaviour[], check: (r: { id: number }[], ms: number) => void) {
  script = s;
  calls = 0;
  aborted = 0;
  const started = Date.now();
  const result = await uploadListingImages([photo], session);
  check(result, Date.now() - started);
  console.log(`ok ${name}`);
}

// 1) First copy hangs; the hedge sent at 100 ms wins long before the 2 s timeout,
//    and the hung copy is aborted.
await run("hung copy is hedged and loses the race", ["hang", "ok"], (r, ms) => {
  assert.equal(r.length, 1);
  assert.equal(r[0].id, 2, "the second (hedged) copy should be the winner");
  assert.ok(ms < 1000, `took ${ms}ms — the hedge did not fire`);
  assert.equal(aborted, 1, "the hung copy must be aborted once the race is won");
});

// 2) A server-side failure triggers an immediate replacement copy.
await run("HTTP 500 is retried immediately", ["http500", "ok"], (r, ms) => {
  assert.equal(r.length, 1);
  assert.equal(r[0].id, 2);
  assert.ok(ms < 1500, `took ${ms}ms`);
});

// 3) Every copy fails -> photo is dropped, no more than ATTEMPTS copies sent.
await run("gives up after the copy cap", ["http500", "http500", "http500", "ok"], (r) => {
  assert.equal(r.length, 0);
  assert.equal(calls, 3, `sent ${calls} copies, cap is 3`);
});

// 4) Fast path: one copy, no hedge, nothing aborted.
await run("fast upload sends a single copy", ["ok"], (r) => {
  assert.equal(r.length, 1);
  assert.equal(calls, 1);
  assert.equal(aborted, 0);
});

rmSync(dir, { recursive: true, force: true });
console.log("myhome-api-upload tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
