/**
 * Hard deadlines for queue jobs.
 *
 * BullMQ keeps renewing the lock of a job while its processor is running, so
 * "active" is only ever as bounded as the processor itself. One wedged job — a
 * Chromium that stopped answering, a socket that never closes — would otherwise
 * keep its concurrency slot for good and the queue backs up behind it with no
 * error recorded anywhere.
 */

export class JobDeadlineError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} exceeded its ${Math.round(ms / 1000)}s deadline`);
    this.name = "JobDeadlineError";
  }
}

/**
 * Rejects with JobDeadlineError when `work` outlives `ms`. The underlying
 * promise keeps running — it cannot be cancelled — so `onExpire` is where the
 * job's resources are torn down (abort flag, browser session) before the
 * concurrency slot is handed back.
 *
 * `ms <= 0` disables the deadline.
 */
export function withDeadline<T>(
  label: string,
  ms: number,
  work: Promise<T>,
  onExpire?: () => void
): Promise<T> {
  if (ms <= 0) return work;

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        onExpire?.();
      } catch (err) {
        console.error(`[job-deadline] ${label} expiry handler failed:`, err);
      }
      reject(new JobDeadlineError(label, ms));
    }, ms);

    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
