/**
 * In-process concurrency limiter.
 *
 * The Next.js server runs work whose cost does not shrink with request count
 * (Playwright logins, myhome parses). Without a cap, one burst of users can
 * exhaust the container's CPU/RAM and every request — including unrelated page
 * loads — starts timing out behind nginx. These limiters bound that work.
 */

/** Thrown when a task waited longer than `maxQueueWaitMs` for a free slot. */
export class LimiterBusyError extends Error {
  constructor(message = "Server is busy, please try again") {
    super(message);
    this.name = "LimiterBusyError";
  }
}

export interface Limiter {
  run<T>(task: () => Promise<T>): Promise<T>;
  /**
   * Hold a slot until the returned release() is called.
   * Use when the limited resource outlives the launcher (e.g. a Playwright browser).
   */
  acquire(): Promise<() => void>;
  readonly active: number;
  readonly queued: number;
}

interface Waiter {
  resolve: () => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export function createLimiter(options: {
  maxConcurrent: number;
  /** 0 (default) waits indefinitely. */
  maxQueueWaitMs?: number;
}): Limiter {
  const maxConcurrent = Math.max(1, options.maxConcurrent);
  const maxQueueWaitMs = options.maxQueueWaitMs ?? 0;
  const waiters: Waiter[] = [];
  let active = 0;

  function acquireSlot(): Promise<void> {
    if (active < maxConcurrent) {
      active++;
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject };
      if (maxQueueWaitMs > 0) {
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new LimiterBusyError());
        }, maxQueueWaitMs);
      }
      waiters.push(waiter);
    });
  }

  function releaseSlot(): void {
    const next = waiters.shift();
    if (!next) {
      active--;
      return;
    }
    // Slot is handed straight to the next waiter, so `active` stays unchanged.
    if (next.timer) clearTimeout(next.timer);
    next.resolve();
  }

  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      await acquireSlot();
      try {
        return await task();
      } finally {
        releaseSlot();
      }
    },
    async acquire(): Promise<() => void> {
      await acquireSlot();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        releaseSlot();
      };
    },
    get active() {
      return active;
    },
    get queued() {
      return waiters.length;
    },
  };
}
