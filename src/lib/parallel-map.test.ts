import assert from "assert";
import { mapWithConcurrency, parseConcurrency } from "@/lib/parallel-map";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
  {
    // Results follow input order even when later items finish first, because the
    // first photo becomes the listing's main image.
    const items = [40, 30, 20, 10, 0];
    const out = await mapWithConcurrency(items, 5, async (ms, i) => {
      await sleep(ms);
      return `${i}:${ms}`;
    });
    assert.deepStrictEqual(out, ["0:40", "1:30", "2:20", "3:10", "4:0"]);
    console.log("ok: preserves input order");
  }

  {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await sleep(5);
      inFlight--;
      return null;
    });
    assert.strictEqual(peak, 4, `expected peak 4, got ${peak}`);
    console.log("ok: respects the concurrency cap");
  }

  {
    const out = await mapWithConcurrency([], 4, async () => "x");
    assert.deepStrictEqual(out, []);
    console.log("ok: empty input is a no-op");
  }

  {
    // A rejecting task surfaces once, and siblings must not leave the process
    // with an unhandled rejection.
    let unhandled: unknown;
    const onUnhandled = (err: unknown) => {
      unhandled = err;
    };
    process.on("unhandledRejection", onUnhandled);

    let started = 0;
    await assert.rejects(
      mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (n) => {
        started++;
        await sleep(5);
        if (n === 1) throw new Error("boom");
        return n;
      }),
      /boom/
    );
    await sleep(30);
    process.off("unhandledRejection", onUnhandled);

    assert.strictEqual(unhandled, undefined, "no unhandled rejection expected");
    assert.ok(started < 6, `expected an early stop, started ${started}`);
    console.log("ok: reports the first failure and stops pulling work");
  }

  {
    assert.strictEqual(parseConcurrency(undefined, 6), 6);
    assert.strictEqual(parseConcurrency("", 6), 6);
    assert.strictEqual(parseConcurrency("0", 6), 6);
    assert.strictEqual(parseConcurrency("-2", 6), 6);
    assert.strictEqual(parseConcurrency("nope", 6), 6);
    assert.strictEqual(parseConcurrency("8", 6), 8);
    console.log("ok: parseConcurrency falls back on bad values");
  }

  console.log("\nAll parallel-map tests passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
