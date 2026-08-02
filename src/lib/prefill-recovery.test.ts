/**
 * Regression tests for the "Queue position N, 0% forever" wedge.
 *
 * Needs Redis on REDIS_URL (npm run redis:up).
 * Run: npx tsx src/lib/prefill-recovery.test.ts
 */
import assert from "node:assert/strict";
import IORedis from "ioredis";
import { Queue, Worker } from "bullmq";
import type { Browser, BrowserContext } from "playwright";
import { createLimiter, LimiterBusyError } from "./concurrency-limit";
import { withDeadline, JobDeadlineError } from "./job-deadline";
import { closeBrowserSession } from "./browser-lifecycle";
import { getPrefillQueue, closeAllQueues, redisConnection } from "./bullmq-queue";
import {
  abortPrefillJob,
  completePrefillJob,
  createPrefillReporter,
  flushPrefillProgress,
  getPrefillProgress,
  getPrefillStatusPayload,
  initPrefillProgress,
  isPrefillCancelled,
  markPrefillFailedIfPending,
  MYHOME_API_PREFILL_STEPS,
  MYHOME_PREFILL_STEPS,
  SSGE_API_PREFILL_STEPS,
} from "./prefill-progress-redis";

let passed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`ok ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}`);
    throw err;
  }
}

function neverResolves(): Promise<never> {
  return new Promise<never>(() => {});
}

/** Backdate the stored progress so it is older than the enqueue grace window. */
async function backdateProgress(redis: IORedis, jobId: string): Promise<void> {
  const key = `prefill:progress:${jobId}`;
  const raw = await redis.get(key);
  assert.ok(raw, "progress state should exist");
  const state = JSON.parse(raw) as { updatedAt: number };
  state.updatedAt = Date.now() - 60_000;
  await redis.set(key, JSON.stringify(state), "EX", 300);
}

async function requireRedis(): Promise<IORedis> {
  const url = process.env.REDIS_URL || "redis://localhost:6379";
  const deadline = Date.now() + (process.env.CI ? 20_000 : 3_000);
  let lastError: Error | null = null;

  while (Date.now() < deadline) {
    const redis = new IORedis(url, {
      maxRetriesPerRequest: 1,
      connectTimeout: 1500,
      lazyConnect: true,
      enableOfflineQueue: false,
      showFriendlyErrorStack: false,
      retryStrategy: () => null,
    });
    redis.on("error", () => {});
    try {
      await redis.connect();
      const pong = await redis.ping();
      assert.equal(pong, "PONG");
      return redis;
    } catch (err) {
      lastError = err as Error;
      await redis.quit().catch(() => null);
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  throw new Error(
    `prefill-recovery tests need Redis at ${url} ` +
      `(npm run redis:up / CI redis service). ${lastError?.message ?? ""}`
  );
}

async function main(): Promise<void> {
  const redis = await requireRedis();

  await test("leaked browser slot fails fast instead of waiting forever", async () => {
    const limiter = createLimiter({ maxConcurrent: 1, maxQueueWaitMs: 150 });

    // Slot taken and never released — exactly what a hung browser close did.
    await limiter.acquire();

    await assert.rejects(() => limiter.acquire(), LimiterBusyError);
    assert.equal(limiter.active, 1);
  });

  await test("released slot is handed to the next waiter", async () => {
    const limiter = createLimiter({ maxConcurrent: 1, maxQueueWaitMs: 2000 });
    const release = await limiter.acquire();

    const second = limiter.acquire();
    setTimeout(release, 20);
    const releaseSecond = await second;

    releaseSecond();
    assert.equal(limiter.active, 0);
  });

  await test("job deadline rejects and runs its teardown", async () => {
    let tornDown = false;

    await assert.rejects(
      () =>
        withDeadline("test job", 100, neverResolves(), () => {
          tornDown = true;
        }),
      JobDeadlineError
    );
    assert.equal(tornDown, true);
  });

  await test("job deadline stays out of the way of work that finishes", async () => {
    assert.equal(await withDeadline("fast job", 5000, Promise.resolve("done")), "done");
  });

  await test("hung browser close is bounded and never blocks the caller", async () => {
    process.env.BROWSER_CLOSE_TIMEOUT_MS = "200";

    const hungContext = { close: () => neverResolves() } as unknown as BrowserContext;
    const hungBrowser = {
      isConnected: () => true,
      close: () => neverResolves(),
    } as unknown as Browser;

    const startedAt = Date.now();
    await closeBrowserSession(hungBrowser, hungContext);
    const elapsed = Date.now() - startedAt;

    // One deadline per close (context, then browser) — the point is it returns.
    assert.ok(elapsed < 2000, `close took ${elapsed}ms`);
  });

  await test("abort raises the cancel flag and settles the job as failed", async () => {
    const jobId = `test-abort-${Date.now()}`;
    await initPrefillProgress(jobId, "myhome", "listing-1", "user-1");

    await abortPrefillJob(jobId, "Prefill timed out and was stopped");

    assert.equal(await isPrefillCancelled(jobId), true);
    const state = await getPrefillProgress(jobId);
    assert.equal(state?.status, "failed");
    assert.equal(state?.error, "Prefill timed out and was stopped");

    await redis.del(`prefill:progress:${jobId}`, `prefill:cancel:${jobId}`);
  });

  await test("a settled job is not overwritten by a later failure", async () => {
    const jobId = `test-terminal-${Date.now()}`;
    await initPrefillProgress(jobId, "ssge", "listing-2", "user-1");
    await markPrefillFailedIfPending(jobId, "first failure wins");
    await markPrefillFailedIfPending(jobId, "second failure is ignored");

    const state = await getPrefillProgress(jobId);
    assert.equal(state?.error, "first failure wins");

    await redis.del(`prefill:progress:${jobId}`);
  });

  await test("a queued job with no queue entry stops reporting 'queued'", async () => {
    const jobId = `test-lost-${Date.now()}`;
    await initPrefillProgress(jobId, "ssge", "listing-3", "user-1");
    await backdateProgress(redis, jobId);

    // Nothing was ever enqueued: the old code reported "Queue position …" here
    // until the 2h TTL expired, so the modal sat at 0% with no error.
    const payload = await getPrefillStatusPayload(jobId);
    assert.ok(payload);
    assert.equal(payload.status, "failed");
    assert.equal(payload.queuePosition, null);
    assert.match(payload.error ?? "", /no longer in the queue/i);

    await redis.del(`prefill:progress:${jobId}`);
  });

  await test("queue position is still reported for a genuinely waiting job", async () => {
    const queue = getPrefillQueue();
    await queue.pause();

    const jobId = `test-waiting-${Date.now()}`;
    await initPrefillProgress(jobId, "myhome", "listing-4", "user-1");
    await queue.add(
      jobId,
      { type: "myhome", jobId, listingId: "listing-4", userId: "user-1" },
      { jobId }
    );

    try {
      const payload = await getPrefillStatusPayload(jobId);
      assert.equal(payload?.status, "queued");
      assert.ok(
        payload?.queuePosition && payload.queuePosition >= 1,
        `expected a queue position, got ${payload?.queuePosition}`
      );
    } finally {
      await queue.getJob(jobId).then((j) => j?.remove().catch(() => null));
      await queue.resume();
      await redis.del(`prefill:progress:${jobId}`);
    }
  });

  await test("a wedged job frees its slot so the backlog drains", async () => {
    const queueName = `test-deadline-${Date.now()}`;
    const queue = new Queue(queueName, { connection: redisConnection });
    const processed: string[] = [];
    let expired = 0;

    const worker = new Worker(
      queueName,
      (job) =>
        withDeadline(
          `job ${job.name}`,
          300,
          job.name === "wedged"
            ? neverResolves()
            : Promise.resolve().then(() => {
                processed.push(job.name);
              }),
          () => {
            expired++;
          }
        ),
      { connection: redisConnection, concurrency: 1, maxStalledCount: 0 }
    );

    try {
      await queue.add("wedged", {});
      await queue.add("after-1", {});
      await queue.add("after-2", {});

      const deadline = Date.now() + 10_000;
      while (processed.length < 2 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }

      assert.equal(expired, 1, "the wedged job should have hit its deadline");
      assert.deepEqual(
        processed,
        ["after-1", "after-2"],
        "jobs queued behind the wedged one must still run"
      );
      assert.equal((await queue.getWaitingCount()) + (await queue.getActiveCount()), 0);
    } finally {
      await worker.close();
      await queue.obliterate({ force: true }).catch(() => null);
      await queue.close();
    }
  });

  await test("a successful myhome API run reports every step done", async () => {
    const jobId = `progress-race-${Date.now()}`;
    await initPrefillProgress(jobId, "myhome", "listing-race", "user-race");
    const reporter = createPrefillReporter(jobId);

    // The real sequence, fired without awaiting as the prefill code does.
    reporter.setSteps(MYHOME_API_PREFILL_STEPS);
    reporter.step("login");
    reporter.stepDone("login");
    reporter.step("fields");
    reporter.stepDone("fields", "Ateni Street");
    reporter.step("amenities", "3 parameter(s)");
    reporter.stepDone("amenities");
    reporter.step("images", "15 photo(s)");
    reporter.stepDone("images", "15 uploaded");
    reporter.step("publish");
    reporter.stepDone("publish", "uuid 1cf275f3…");
    reporter.step("checkout");
    reporter.stepDone("checkout", "Publish fee paid");
    await completePrefillJob(jobId, "https://statements.myhome.ge/ka/status/success");

    const state = await getPrefillProgress(jobId);
    assert.ok(state);
    assert.equal(state.status, "success");
    assert.deepEqual(
      state.steps.filter((s) => s.status !== "done").map((s) => s.id),
      [],
      "no step may be left pending or running once the job succeeded"
    );
    assert.equal(state.steps.length, MYHOME_API_PREFILL_STEPS.length);
    assert.ok(
      state.logs.some((l) => l.message.includes("Publish fee paid")),
      "the checkout detail should survive the later writes"
    );
    await redis.del(`prefill:progress:${jobId}`);
  });

  await test("the ss.ge API run replaces the browser-only step list", async () => {
    const jobId = `progress-ssge-${Date.now()}`;
    await initPrefillProgress(jobId, "ssge", "listing-ssge", "user-ssge");
    const reporter = createPrefillReporter(jobId);

    reporter.setSteps(SSGE_API_PREFILL_STEPS);
    for (const id of ["login", "location", "draft", "images", "save", "publish"]) {
      reporter.step(id);
      reporter.stepDone(id);
    }
    await completePrefillJob(jobId, "https://home.ss.ge/ka/my-statements");

    const state = await getPrefillProgress(jobId);
    assert.ok(state);
    assert.equal(state.status, "success");
    assert.deepEqual(
      state.steps.map((s) => s.id),
      SSGE_API_PREFILL_STEPS.map((s) => s.id),
      "the API stages, not step1..step8, should be on show"
    );
    assert.deepEqual(
      state.steps.filter((s) => s.status !== "done").map((s) => s.id),
      []
    );
    // Raw ids would leak into the log if a reported step were not in the list.
    assert.ok(state.logs.some((l) => l.message.includes("Resolving location")));
    await redis.del(`prefill:progress:${jobId}`);
  });

  await test("a browser fallback restores the browser step list", async () => {
    const jobId = `progress-fallback-${Date.now()}`;
    await initPrefillProgress(jobId, "myhome", "listing-fb", "user-fb");
    const reporter = createPrefillReporter(jobId);

    reporter.setSteps(MYHOME_API_PREFILL_STEPS);
    reporter.step("login");
    reporter.stepDone("login", "Failed");

    // What createMyhomePost does when the API attempt hands over.
    reporter.setSteps(MYHOME_PREFILL_STEPS);
    reporter.step("browser");
    await flushPrefillProgress(jobId);

    const state = await getPrefillProgress(jobId);
    assert.ok(state);
    assert.deepEqual(
      state.steps.map((s) => s.id),
      MYHOME_PREFILL_STEPS.map((s) => s.id)
    );
    assert.equal(state.steps.find((s) => s.id === "browser")?.status, "running");
    await redis.del(`prefill:progress:${jobId}`);
  });

  console.log(`\n${passed} passed`);
  await closeAllQueues();
  await redis.quit();
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
