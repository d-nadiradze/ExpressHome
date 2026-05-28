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

const globalStore = globalThis as unknown as {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prefillQueue?: PrefillJob<any>[];
  prefillRunning?: number;
};

function getQueue() {
  if (!globalStore.prefillQueue) {
    globalStore.prefillQueue = [];
  }
  return globalStore.prefillQueue;
}

function getRunning() {
  return globalStore.prefillRunning ?? 0;
}

function setRunning(n: number) {
  globalStore.prefillRunning = n;
}

function processNext() {
  const queue = getQueue();
  if (getRunning() >= MAX_CONCURRENT || queue.length === 0) return;
  setRunning(getRunning() + 1);
  const job = queue.shift()!;

  job
    .run()
    .then(job.resolve)
    .catch(job.reject)
    .finally(() => {
      setRunning(getRunning() - 1);
      processNext();
    });
}

export function enqueuePrefill<T>(id: string, run: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    getQueue().push({ id, run, resolve, reject });
    processNext();
  });
}

export function getPrefillQueueStats() {
  return { queued: getQueue().length, running: getRunning() };
}

export function getPrefillQueuePosition(id: string): number {
  return getQueue().findIndex((j) => j.id === id);
}
