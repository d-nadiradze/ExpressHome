/**
 * Run: npx tsx src/lib/ssge-api-payment.test.ts
 */
import assert from "node:assert/strict";
import {
  pickTariffDay,
  resolvePaidServiceSelection,
  parseCreateApplicationPayment,
} from "./ssge-api-payment";

const sampleTariff = [
  {
    paidService: "Standard",
    paidServiceTariffs: [
      {
        dailyPrices: [
          { day: 1, price: 0.1, fullPrice: null },
        ],
      },
    ],
  },
  {
    paidService: "SuperVip",
    paidServiceTariffs: [
      {
        dailyPrices: [{ day: 30, price: 180, fullPrice: null }],
      },
    ],
  },
];

const multiDayStandard = [
  {
    paidService: "Standard",
    paidServiceTariffs: [
      {
        dailyPrices: [
          { day: 7, price: 5, fullPrice: null },
          { day: 30, price: 15, fullPrice: null },
        ],
      },
    ],
  },
];

assert.deepEqual(pickTariffDay([{ day: 1, price: 0.1, fullPrice: null }], 30), {
  day: 1,
  price: 0.1,
  fullPrice: null,
});

assert.deepEqual(
  pickTariffDay(
    [
      { day: 7, price: 5, fullPrice: null },
      { day: 30, price: 15, fullPrice: null },
    ],
    30
  ),
  { day: 30, price: 15, fullPrice: null }
);

const resolved = resolvePaidServiceSelection(multiDayStandard, "Standard", 30);
assert.equal("paidService" in resolved && resolved.paidService, "Standard");
assert.equal("days" in resolved && resolved.days, 30);
assert.equal("price" in resolved && resolved.price, 15);

const cheap = resolvePaidServiceSelection(sampleTariff, "Standard", 30);
assert.equal("days" in cheap && cheap.days, 1);
assert.equal("price" in cheap && cheap.price, 0.1);

const zeroTariff = [
  {
    paidService: "Standard",
    paidServiceTariffs: [{ dailyPrices: [{ day: 30, price: 0, fullPrice: null }] }],
  },
];
const zeroPrice = resolvePaidServiceSelection(zeroTariff, "Standard", 30);
assert.ok("error" in zeroPrice);

const noPayment = parseCreateApplicationPayment(
  new Response(JSON.stringify({ applicationId: 123 }), { status: 200 }),
  JSON.stringify({ applicationId: 123 }),
  15
);
assert.equal(noPayment.success, false);

const okPayment = parseCreateApplicationPayment(
  new Response(JSON.stringify({ payment: { success: true, data: { amount: 15 } } }), {
    status: 200,
  }),
  JSON.stringify({ payment: { success: true, data: { amount: 15 } } }),
  15
);
assert.equal(okPayment.success, true);
assert.equal(okPayment.chargedGel, 15);

console.log("All ssge-api-payment tests passed.");
