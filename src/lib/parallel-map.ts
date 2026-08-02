/**
 * Bounded-parallel map that keeps input order.
 *
 * Photo work (download from the source site, upload to myhome/ss.ge) is pure
 * network wait, so running it one item at a time wastes almost all of the
 * elapsed time. Order matters though: index 0 becomes the listing's main photo
 * and the rest keep their `orderNo`, so results are written back by index
 * rather than in completion order.
 */

export function parseConcurrency(raw: string | undefined, fallback: number): number {
  const parsed = parseInt(raw || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  if (items.length === 0) return results;

  const workers = Math.max(1, Math.min(concurrency, items.length));
  let nextIndex = 0;
  let firstError: unknown;

  async function worker(): Promise<void> {
    while (firstError === undefined) {
      const index = nextIndex++;
      if (index >= items.length) return;
      try {
        results[index] = await fn(items[index], index);
      } catch (err) {
        // Workers never reject, so a failure here cannot surface as an
        // unhandled rejection from the siblings still in flight.
        firstError = err ?? new Error("mapWithConcurrency task failed");
        return;
      }
    }
  }

  await Promise.all(Array.from({ length: workers }, () => worker()));
  if (firstError !== undefined) throw firstError;
  return results;
}
