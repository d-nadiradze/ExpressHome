/**
 * Tests for myhome publish-fee resolution.
 *
 * The fixtures below are trimmed copies of real GET /v2/services responses: one
 * from an account with free statements left, one from an account that has used
 * them up (which is the only difference — the "add-statement" service appears).
 *
 * Run: npx tsx src/lib/myhome-api-services.test.ts
 */
import assert from "node:assert/strict";
import { fetchRequiredServiceTypes } from "./myhome-api-prefill";

const realFetch = globalThis.fetch;

function stubFetch(status: number, body: unknown): { calls: number } {
  const state = { calls: 0 };
  globalThis.fetch = (async () => {
    state.calls++;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  }) as typeof globalThis.fetch;
  return state;
}

const vips = [
  {
    id: 3,
    website_id: 2,
    key: "super-vip",
    icon: "super-vip",
    types: [{ id: 9, price: 9, days: [{ value: 1 }, { value: 2 }] }],
  },
];

const freeAccountCatalog = {
  result: true,
  data: [
    {
      website_id: 2,
      title: "Myhome",
      services: {
        vips,
        additional_services: [
          {
            id: 6,
            website_id: 2,
            key: "add-color",
            icon: "add-color",
            types: [{ id: 18, price: 0.3, days: [{ value: 1 }] }],
          },
        ],
      },
    },
  ],
};

const feeDueCatalog = {
  result: true,
  data: [
    {
      website_id: 2,
      title: "Myhome",
      services: {
        vips,
        additional_services: [
          {
            id: 6,
            website_id: 2,
            key: "add-color",
            icon: "add-color",
            types: [{ id: 18, price: 0.3, days: [{ value: 1 }] }],
          },
          {
            id: 5,
            website_id: 2,
            key: "add-statement",
            icon: "add-statement",
            disabled: true,
            types: [{ id: 22, price: 0.1 }],
          },
        ],
      },
    },
  ],
};

const session = { accessToken: "token", refreshToken: "refresh" };

let passed = 0;

async function test(name: string, fn: () => Promise<void>): Promise<void> {
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

async function main(): Promise<void> {
  delete process.env.MYHOME_SERVICE_TYPE_ID;

  await test("an exhausted free limit yields the add-statement fee", async () => {
    stubFetch(200, feeDueCatalog);
    const result = await fetchRequiredServiceTypes(session);
    // The fee service carries no period of its own; the site sends 30.
    assert.deepEqual(result.types, [{ id: 22, day: 30 }]);
    assert.equal(result.error, undefined);
  });

  await test("free statements left means nothing is charged", async () => {
    stubFetch(200, freeAccountCatalog);
    const result = await fetchRequiredServiceTypes(session);
    assert.deepEqual(result.types, []);
    assert.equal(result.error, undefined);
  });

  await test("optional promo services are never bought", async () => {
    stubFetch(200, {
      result: true,
      data: [
        {
          website_id: 2,
          services: {
            vips,
            additional_services: [
              {
                id: 27,
                website_id: 2,
                key: "myhome-facebook-boost",
                types: [{ id: 56, price: 49, days: [{ value: 3 }] }],
              },
            ],
          },
        },
      ],
    });
    assert.deepEqual((await fetchRequiredServiceTypes(session)).types, []);
  });

  await test("a livo-only website block is ignored", async () => {
    stubFetch(200, {
      result: true,
      data: [
        {
          website_id: 1,
          services: {
            additional_services: [
              { id: 5, website_id: 1, key: "add-statement", types: [{ id: 99 }] },
            ],
          },
        },
      ],
    });
    assert.deepEqual((await fetchRequiredServiceTypes(session)).types, []);
  });

  await test("a fee service with no purchasable type is an error, not a skip", async () => {
    stubFetch(200, {
      result: true,
      data: [
        {
          website_id: 2,
          services: {
            additional_services: [
              { id: 5, website_id: 2, key: "add-statement", types: [] },
            ],
          },
        },
      ],
    });
    const result = await fetchRequiredServiceTypes(session);
    assert.deepEqual(result.types, []);
    assert.match(result.error ?? "", /no purchasable type/);
  });

  await test("a failing catalog reports an error instead of guessing", async () => {
    stubFetch(401, { message: "Unauthenticated" });
    const result = await fetchRequiredServiceTypes(session);
    assert.deepEqual(result.types, []);
    assert.match(result.error ?? "", /services catalog failed \(HTTP 401\)/);
  });

  await test("an unexpected body shape is an error, not a silent skip", async () => {
    stubFetch(200, { result: true, data: null });
    const result = await fetchRequiredServiceTypes(session);
    assert.match(result.error ?? "", /no websites/);
  });

  await test("MYHOME_SERVICE_TYPE_ID overrides without calling the catalog", async () => {
    process.env.MYHOME_SERVICE_TYPE_ID = "22";
    process.env.MYHOME_SERVICE_DAYS = "30";
    const state = stubFetch(200, freeAccountCatalog);
    try {
      const result = await fetchRequiredServiceTypes(session);
      assert.deepEqual(result.types, [{ id: 22, day: 30 }]);
      assert.equal(state.calls, 0);
    } finally {
      delete process.env.MYHOME_SERVICE_TYPE_ID;
    }
  });

  await test("a junk override falls back to the catalog", async () => {
    process.env.MYHOME_SERVICE_TYPE_ID = "not-a-number";
    stubFetch(200, feeDueCatalog);
    try {
      assert.deepEqual((await fetchRequiredServiceTypes(session)).types, [
        { id: 22, day: 30 },
      ]);
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
