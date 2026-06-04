/**
 * Shared BullMQ queue and Redis connection configuration.
 *
 * Imported by:
 *   - API routes (Next.js)  → to enqueue jobs
 *   - src/worker/prefill-worker.ts → to process jobs
 *
 * Redis URL defaults to redis://localhost:6379 in development and
 * redis://redis:6379 inside Docker (via REDIS_URL env var).
 */
import { Queue, type ConnectionOptions } from "bullmq";

function getRedisConnection(): ConnectionOptions {
  const url = process.env.REDIS_URL || "redis://localhost:6379";
  // BullMQ accepts a URL string directly via the `url` option on IORedis
  // but also accepts { host, port } — the cleanest way is to pass the URL.
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname,
      port: parseInt(parsed.port || "6379", 10),
      password: parsed.password || undefined,
      db: parsed.pathname ? parseInt(parsed.pathname.slice(1) || "0", 10) : 0,
      maxRetriesPerRequest: null, // required by BullMQ
    };
  } catch {
    return {
      host: "localhost",
      port: 6379,
      maxRetriesPerRequest: null,
    };
  }
}

export const redisConnection = getRedisConnection();

// ---- Queue names -----------------------------------------------------------

export const PREFILL_QUEUE_NAME = "prefill";
export const PARSE_QUEUE_NAME = "parse";

// ---- Prefill job data types ------------------------------------------------

export interface MyhomePrefillJobData {
  type: "myhome";
  jobId: string;
  listingId: string;
  userId: string;
  debug?: boolean;
}

export interface SsgePrefillJobData {
  type: "ssge";
  jobId: string;
  listingId: string;
  userId: string;
}

export type PrefillJobData = MyhomePrefillJobData | SsgePrefillJobData;

// ---- Parse job data types --------------------------------------------------

export interface ParseJobData {
  listingId: string;
  url: string;
  userId: string;
}

// ---- Queue singletons (lazy) -----------------------------------------------

let _prefillQueue: Queue<PrefillJobData> | null = null;
let _parseQueue: Queue<ParseJobData> | null = null;

export function getPrefillQueue(): Queue<PrefillJobData> {
  if (!_prefillQueue) {
    _prefillQueue = new Queue<PrefillJobData>(PREFILL_QUEUE_NAME, {
      connection: redisConnection,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: 100,
        removeOnFail: 200,
      },
    });
  }
  return _prefillQueue;
}

export function getParseQueue(): Queue<ParseJobData> {
  if (!_parseQueue) {
    _parseQueue = new Queue<ParseJobData>(PARSE_QUEUE_NAME, {
      connection: redisConnection,
      defaultJobOptions: {
        attempts: 2,           // retry once on transient failures
        removeOnComplete: 200,
        removeOnFail: 200,
      },
    });
  }
  return _parseQueue;
}

/** Call once on app shutdown to close queues gracefully. */
export async function closeAllQueues(): Promise<void> {
  await Promise.all([
    _prefillQueue?.close().finally(() => { _prefillQueue = null; }),
    _parseQueue?.close().finally(() => { _parseQueue = null; }),
  ]);
}
