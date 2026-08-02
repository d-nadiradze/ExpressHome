/**
 * Tests for myhome publish-fee resolution and image upload retries.
 *
 * The service type id used to be hardcoded (22), which the API rejected with
 * "422 service_types is required" and pushed every prefill onto the browser.
 *
 * Run: npx tsx src/lib/myhome-api-services.test.ts
 */
import assert from "node:assert/strict";

const realFetch = globalThis.fetch;

interface StubResponse {
  status?: number;
  body?: unknown;
}

/** Replace fetch with a scripted queue, returning the urls that were called. */
function stubFetch(responses: StubResponse[]): { urls: string[] } {
  const urls: string[] = [];
  let call = 0;

  globalThis.fetch = (async (input: string | URL | Request) => {
    urls.push(typeof input === "string" ? input : input.toString());
    const spec = responses[Math.min(call, responses.length - 1)];
    call++;
    const status = spec.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => spec.body,
      text: async () => JSON.stringify(spec.body ?? ""),
    } as unknown as Response;
  }) as typeof globalThis.fetch;

  return { urls };
}

let passed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`ok ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}`);
    throw err;
  } finally {
    globalThis.fetch = realFetch;
  }
}

const session = { accessToken: "token", refreshToken: "refresh" };

async function main(): Promise<void> {
  // Imported after the env is settled so module-level config picks it up.
  delete process.env.MYHOME_SERVICE_TYPE_ID;
  const { fetchRequiredServiceTypes } = await import("./myhome-api-prefill");

  await test("mandatory (marked) myhome services become service_types", async () => {
    stubFetch([
      {
        body: [
          {
            id: 7,
            icon: "add-statement",
            website_id: 2,
            marked: true,
            types: [{ id: 41, day: 30, price: 3 }],
          },
          {
            id: 8,
            icon: "myhome-vip",
            website_id: 2,
            marked: false,
            types: [{ id: 42, day: 7, price: 10 }],
          },
        ],
      },
    ]);

    const result = await fetchRequiredServiceTypes(session);
    assert.deepEqual(result.types, [{ id: 41, day: 30 }]);
    assert.equal(result.error, undefined);
  });

  await test("services wrapped in a data envelope are read too", async () => {
    stubFetch([
      {
        body: {
          data: [
            {
              id: 7,
              icon: "add-statement",
              website_id: 2,
              marked: true,
              types: [{ id: 55, selects: [{ value: 15 }] }],
            },
          ],
        },
      },
    ]);

    const result = await fetchRequiredServiceTypes(session);
    assert.deepEqual(result.types, [{ id: 55, day: 15 }]);
  });

  await test("no mandatory service means no payment is attempted", async () => {
    stubFetch([
      {
        body: [
          {
            id: 8,
            icon: "myhome-vip",
            website_id: 2,
            marked: false,
            types: [{ id: 42, day: 7 }],
          },
        ],
      },
    ]);

    const result = await fetchRequiredServiceTypes(session);
    assert.deepEqual(result.types, []);
    assert.equal(result.error, undefined);
  });

  await test("livo-only services are ignored", async () => {
    stubFetch([
      {
        body: [
          {
            id: 9,
            icon: "livo-vip",
            website_id: 1,
            marked: true,
            types: [{ id: 90, day: 30 }],
          },
        ],
      },
    ]);

    assert.deepEqual((await fetchRequiredServiceTypes(session)).types, []);
  });

  await test("a failing catalog reports an error instead of guessing an id", async () => {
    stubFetch([{ status: 401, body: { message: "Unauthenticated" } }]);

    const result = await fetchRequiredServiceTypes(session);
    assert.deepEqual(result.types, []);
    assert.match(result.error ?? "", /services catalog failed \(HTTP 401\)/);
  });

  await test("an explicit MYHOME_SERVICE_TYPE_ID override skips the catalog", async () => {
    process.env.MYHOME_SERVICE_TYPE_ID = "41";
    process.env.MYHOME_SERVICE_DAYS = "30";
    const { urls } = stubFetch([{ body: [] }]);

    try {
      const result = await fetchRequiredServiceTypes(session);
      assert.deepEqual(result.types, [{ id: 41, day: 30 }]);
      assert.equal(urls.length, 0, "override must not call the catalog");
    } finally {
      delete process.env.MYHOME_SERVICE_TYPE_ID;
    }
  });

  await test("a junk override falls back to the catalog", async () => {
    process.env.MYHOME_SERVICE_TYPE_ID = "not-a-number";
    stubFetch([{ body: [] }]);

    try {
      assert.deepEqual((await fetchRequiredServiceTypes(session)).types, []);
    } finally {
      delete process.env.MYHOME_SERVICE_TYPE_ID;
    }
  });

  console.log(`\n${passed} passed`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
