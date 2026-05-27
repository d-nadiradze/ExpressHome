const MAX_CONCURRENT = parseInt(
  process.env.PREFILL_MAX_CONCURRENT || "1",
  10
);

interface PrefillJob<T> {
  id: string;
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const queue: PrefillJob<any>[] = [];
let running = 0;

function processNext() {
  if (running >= MAX_CONCURRENT || queue.length === 0) return;
  running++;
  const job = queue.shift()!;

  job
    .run()
    .then(job.resolve)
    .catch(job.reject)
    .finally(() => {
      running--;
      processNext();
    });
}

export function enqueuePrefill<T>(id: string, run: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    queue.push({ id, run, resolve, reject });
    processNext();
  });
}

export function getPrefillQueueStats() {
  return { queued: queue.length, running };
}

export function getPrefillQueuePosition(id: string): number {
  return queue.findIndex((j) => j.id === id);
}
