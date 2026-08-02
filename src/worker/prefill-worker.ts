/**
 * Unified browser worker — handles both PARSE and PREFILL jobs.
 *
 * Run with:   npm run worker
 * Docker:     node node_modules/tsx/dist/cli.mjs src/worker/prefill-worker.ts
 *
 * All Playwright browser work for prefills runs here, isolated from Next.js.
 * Listing parse uses HTTP only: ss.ge fetch in this worker, myhome API in the app.
 *
 * Concurrency:
 *   PARSE_MAX_CONCURRENT  — parallel listing parses   (default 3)
 *   PREFILL_MAX_CONCURRENT — parallel form prefills   (default 2)
 */

// Load environment variables when running outside Docker
import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

import { Worker, type Job } from "bullmq";
import {
  PREFILL_QUEUE_NAME,
  PARSE_QUEUE_NAME,
  redisConnection,
  type PrefillJobData,
  type ParseJobData,
} from "@/lib/bullmq-queue";
import { runMyhomePrefillJob, runSsgePrefillJob } from "@/lib/prefill-runner";
import {
  abortPrefillJob,
  markPrefillFailedIfPending,
} from "@/lib/prefill-progress-redis";
import { withDeadline } from "@/lib/job-deadline";
import { closeAllBrowsers, registerBrowserShutdownHooks } from "@/lib/browser-lifecycle";
import { db } from "@/lib/db";
import { parseSsgeListingViaFetch } from "@/lib/ssge-fetch-parser";
import { isValidSsgeUrl } from "@/lib/utils";

const PARSE_CONCURRENCY = parseInt(process.env.PARSE_MAX_CONCURRENT || "3", 10);
const PREFILL_CONCURRENCY = parseInt(process.env.PREFILL_MAX_CONCURRENT || "2", 10);
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

const PREFILL_JOB_TIMEOUT_MS = parseInt(
  process.env.PREFILL_JOB_TIMEOUT_MS || "900000",
  10
);
const PARSE_JOB_TIMEOUT_MS = parseInt(
  process.env.PARSE_JOB_TIMEOUT_MS || "180000",
  10
);

console.log(
  `[worker] Starting — parse concurrency=${PARSE_CONCURRENCY}, prefill concurrency=${PREFILL_CONCURRENCY}, redis=${REDIS_URL}`
);

// ---- Parse job processor ---------------------------------------------------

async function processParseJob(job: Job<ParseJobData>): Promise<void> {
  return withDeadline(
    `Parse job ${job.id}`,
    PARSE_JOB_TIMEOUT_MS,
    runParseJob(job),
    () => {
      console.error(`[worker] Parse job ${job.id} hit its deadline`);
      void db.parsedListing
        .update({ where: { id: job.data.listingId }, data: { postStatus: "FAILED" } })
        .catch(() => null);
    }
  );
}

async function runParseJob(job: Job<ParseJobData>): Promise<void> {
  const { listingId, url, userId } = job.data;
  console.log(`[worker] Parse job ${job.id} — ${url}`);

  try {
    // Worker only handles ss.ge parse jobs (plain HTTP fetch, ~2s).
    // myhome.ge parse runs in-process in Next.js (see parse-queue.ts).
    if (!isValidSsgeUrl(url)) {
      console.warn(`[worker] Unexpected non-ssge parse job for ${url} — skipping`);
      return;
    }
    const result = await parseSsgeListingViaFetch(url);

    if (!result.success || !result.data) {
      await db.parsedListing.update({
        where: { id: listingId },
        data: { postStatus: "FAILED" },
      });
      console.warn(`[worker] Parse failed for ${listingId}: ${result.error}`);
      return;
    }

    const d = result.data;
    await db.parsedListing.update({
      where: { id: listingId },
      data: {
        title: d.title,
        propertyType: d.propertyType,
        dealType: d.dealType,
        buildingStatus: d.buildingStatus,
        condition: d.condition,
        city: d.city,
        address: d.address,
        street: d.street,
        streetNumber: d.streetNumber,
        cadastralCode: d.cadastralCode,
        price: d.price,
        pricePerSqm: d.pricePerSqm,
        currency: d.currency,
        area: d.area,
        rooms: d.rooms,
        bedrooms: d.bedrooms,
        floor: d.floor,
        totalFloors: d.totalFloors,
        projectType: d.projectType,
        bathrooms: d.bathrooms,
        balconyArea: d.balconyArea,
        verandaArea: d.verandaArea,
        loggiaArea: d.loggiaArea,
        description: d.description,
        images: d.images,
        rawData: d.rawData,
        postStatus: "PENDING",
      },
    });
    console.log(`[worker] Parse OK for ${listingId} — "${d.title}"`);
  } catch (error) {
    console.error(`[worker] Parse exception for ${listingId}:`, error);
    await db.parsedListing
      .update({ where: { id: listingId }, data: { postStatus: "FAILED" } })
      .catch(() => {});
    throw error; // let BullMQ mark the job as failed (triggers retry if attempts > 1)
  }

  void userId; // used for future scoping if needed
}

// ---- Prefill job processor -------------------------------------------------

/** Mark the listing row failed for a job that died outside the runner's own error handling. */
async function markListingPrefillFailed(
  type: PrefillJobData["type"],
  listingId: string
): Promise<void> {
  await db.parsedListing
    .update({
      where: { id: listingId },
      data:
        type === "ssge"
          ? { ssgePostStatus: "FAILED" }
          : { postStatus: "FAILED" },
    })
    .catch(() => null);
}

async function processPrefillJob(job: Job<PrefillJobData>): Promise<void> {
  const { type, jobId, listingId, userId } = job.data;
  console.log(`[worker] Prefill job ${job.id} — type=${type}, listingId=${listingId}`);

  let run: Promise<void>;
  if (type === "myhome") {
    run = runMyhomePrefillJob(jobId, listingId, userId);
  } else if (type === "ssge") {
    run = runSsgePrefillJob(jobId, listingId, userId);
  } else {
    throw new Error(`Unknown prefill job type: ${(job.data as { type: string }).type}`);
  }

  await withDeadline(
    `Prefill job ${jobId}`,
    PREFILL_JOB_TIMEOUT_MS,
    run,
    () => {
      console.error(
        `[worker] Prefill job ${jobId} hit its deadline — aborting browser session`
      );
      // Raises the cancel flag the runner's reporter polls, which closes the
      // browser and frees its Chromium slot for the jobs stuck behind it.
      void abortPrefillJob(
        jobId,
        `Prefill timed out after ${Math.round(PREFILL_JOB_TIMEOUT_MS / 1000)}s and was stopped`
      );
      void markListingPrefillFailed(type, listingId);
    }
  );
}

// ---- Workers ---------------------------------------------------------------

const parseWorker = new Worker<ParseJobData>(
  PARSE_QUEUE_NAME,
  processParseJob,
  {
    connection: redisConnection,
    concurrency: PARSE_CONCURRENCY,
    lockDuration: 120_000, // 2 min max per parse
  }
);

const prefillWorker = new Worker<PrefillJobData>(
  PREFILL_QUEUE_NAME,
  processPrefillJob,
  {
    connection: redisConnection,
    concurrency: PREFILL_CONCURRENCY,
    lockDuration: 600_000, // 10 min max per prefill
    // A prefill may already have created/published a listing before its lock
    // lapsed, so never re-run it: that would double-post and launch a second
    // browser on a host that is evidently already struggling.
    maxStalledCount: 0,
  }
);

for (const [name, w] of [["parse", parseWorker], ["prefill", prefillWorker]] as const) {
  w.on("completed", (job) => console.log(`[worker:${name}] Job ${job.id} completed`));
  w.on("failed", (job, err) => console.error(`[worker:${name}] Job ${job?.id} failed:`, err.message));
  w.on("error", (err) => console.error(`[worker:${name}] error:`, err));
}

// A prefill can leave the queue without the runner ever writing a result — a
// killed worker (stalled, maxStalledCount: 0) or a throw before the runner's own
// handlers. Settle the progress record so the UI reports the failure instead of
// polling a job that will never run.
prefillWorker.on("failed", (job, err) => {
  const jobId = job?.data?.jobId;
  if (!jobId) return;
  void markPrefillFailedIfPending(jobId, err.message || "Prefill failed");
  if (job?.data) void markListingPrefillFailed(job.data.type, job.data.listingId);
});

prefillWorker.on("stalled", (jobId) => {
  console.error(`[worker:prefill] Job ${jobId} stalled — worker lost its lock`);
  void abortPrefillJob(jobId, "Worker restarted while this prefill was running");
});

// ---- Recover stuck PARSING listings on startup ----------------------------

async function recoverStuckParseJobs() {
  try {
    const stuck = await db.parsedListing.updateMany({
      where: { postStatus: "PARSING" },
      data: { postStatus: "FAILED" },
    });
    if (stuck.count > 0) {
      console.log(`[worker] Recovered ${stuck.count} stuck PARSING listings → FAILED`);
    }
  } catch (err) {
    console.error("[worker] Failed to recover stuck parse jobs:", err);
  }
}

void recoverStuckParseJobs();

// ---- Graceful shutdown -----------------------------------------------------

registerBrowserShutdownHooks(async () => {
  console.log("[worker] Shutting down...");
  await Promise.all([parseWorker.close(), prefillWorker.close()]);
  await closeAllBrowsers();
});

console.log("[worker] Ready — listening for parse and prefill jobs.");
