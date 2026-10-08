/**
 * In-process limiter: per-call queue-wait override.
 *
 * Run: npx tsx src/lib/concurrency-limit.test.ts
 */
import assert from "node:assert/strict";
import { createLimiter, LimiterBusyError } from "./concurrency-limit";

async function main() {
  // Default wait is long (like BROWSER_MAX_WAIT_MS=600000), one slot.
  const limiter = createLimiter({ maxConcurrent: 1, maxQueueWaitMs: 600_000 });

  const releaseFirst = await limiter.acquire();
  assert.equal(limiter.active, 1);

  // A caller with a short per-call wait must fail fast instead of queueing.
  const started = Date.now();
  await assert.rejects(
    () => limiter.acquire({ maxQueueWaitMs: 50 }),
    (err: unknown) => err instanceof LimiterBusyError
  );
  const waited = Date.now() - started;
  assert.ok(waited < 2_000, `expected fast failure, waited ${waited}ms`);
  assert.equal(limiter.queued, 0, "timed-out waiter is removed from the queue");
  console.log("ok short per-call wait fails fast");

  // Once the slot is free, the same short wait succeeds immediately.
  releaseFirst();
  const releaseSecond = await limiter.acquire({ maxQueueWaitMs: 50 });
  assert.equal(limiter.active, 1);
  releaseSecond();
  assert.equal(limiter.active, 0);
  console.log("ok acquire succeeds when a slot is free");

  // Without an override the limiter default still applies (waiter stays queued).
  const releaseThird = await limiter.acquire();
  const pending = limiter.acquire();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(limiter.queued, 1, "default long wait keeps the waiter queued");
  releaseThird();
  (await pending)();
  console.log("ok default wait unchanged");

  console.log("concurrency-limit tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
