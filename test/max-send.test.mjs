// The "Max" button's arithmetic (site/assets/lokal-contracts.js maxSendable / unitsInputText): the smallest of the
// balance and the limits, rounded DOWN to what the amount field takes, never under the minimum. Pure, no DOM.
import test from "node:test";
import assert from "node:assert/strict";
import { maxSendable, unitsInputText, unitsFromCents, payDecimals } from "../site/assets/lokal-contracts.js";
import { parseMoneyInput } from "../site/assets/core.js";
import { maxReasonText } from "../site/assets/ntag-ui.js";

const U = (n, d) => BigInt(n) * 10n ** BigInt(d); // whole tokens -> base units

test("maxSendable: unknown balance gives null (the button stays off)", () => {
  assert.equal(maxSendable({ balanceUnits: null, decimals: 6, perPaymentMax: U(25, 6) }), null);
  assert.equal(maxSendable({ balanceUnits: undefined, decimals: 18 }), null);
  assert.equal(maxSendable({}), null);
});

// [name, input, expected { units, text, reason, ok }]
const CASES = [
  // 6 decimals (USD₮, cNGN)
  ["6d: balance binds", { balanceUnits: 12_345_678n, decimals: 6, perPaymentMax: U(25, 6), roomToday: U(25, 6), minUnits: U(1, 6) },
    { units: 12_340_000n, text: "12.34", reason: "balance", ok: true }],
  ["6d: per-payment binds", { balanceUnits: U(80, 6), decimals: 6, perPaymentMax: U(25, 6), roomToday: U(100, 6), minUnits: U(1, 6) },
    { units: U(25, 6), text: "25", reason: "perPayment", ok: true }],
  ["6d: today's room binds", { balanceUnits: U(80, 6), decimals: 6, perPaymentMax: U(25, 6), roomToday: 12_500_000n, minUnits: U(1, 6) },
    { units: 12_500_000n, text: "12.50", reason: "today", ok: true }],
  ["6d: rounds down, never up", { balanceUnits: 9_999_999n, decimals: 6, minUnits: U(1, 6) },
    { units: 9_990_000n, text: "9.99", reason: "balance", ok: true }],
  ["6d: balance under the $1 minimum", { balanceUnits: 990_000n, decimals: 6, perPaymentMax: U(25, 6), minUnits: U(1, 6) },
    { units: 990_000n, text: "", reason: "balance", ok: false }],
  ["6d: empty wallet", { balanceUnits: 0n, decimals: 6, perPaymentMax: U(25, 6), minUnits: U(1, 6) },
    { units: 0n, text: "", reason: "balance", ok: false }],
  ["6d: today's room under the minimum", { balanceUnits: U(50, 6), decimals: 6, perPaymentMax: U(25, 6), roomToday: 400_000n, minUnits: U(1, 6) },
    { units: 400_000n, text: "", reason: "today", ok: false }],
  ["6d: a tie goes to the balance (no limit line)", { balanceUnits: U(25, 6), decimals: 6, perPaymentMax: U(25, 6) },
    { units: U(25, 6), text: "25", reason: "balance", ok: true }],
  ["6d: the contract doesn't take the token (max 0)", { balanceUnits: U(5, 6), decimals: 6, perPaymentMax: 0n, minUnits: 0n },
    { units: 0n, text: "", reason: "perPayment", ok: false }],
  // 2 decimals (IDRX): the step is one unit, nothing to round
  ["2d: balance binds but is under the minimum",{ balanceUnits: 1_234_567n, decimals: 2, perPaymentMax: 41_234_500n, minUnits: 1_700_000n },
    { units: 1_234_567n, text: "", reason: "balance", ok: false }],
  ["2d: balance binds above the minimum", { balanceUnits: 30_000_055n, decimals: 2, perPaymentMax: 41_234_500n, minUnits: 1_700_000n },
    { units: 30_000_055n, text: "300000.55", reason: "balance", ok: true }],
  ["2d: per-payment binds", { balanceUnits: 99_000_000n, decimals: 2, perPaymentMax: 41_234_500n, minUnits: 1_700_000n },
    { units: 41_234_500n, text: "412345", reason: "perPayment", ok: true }],
  // 18 decimals (wARS, wCOP)
  ["18d: balance binds, rounded down to cents", { balanceUnits: 12_345_678_901_234_567_890_123n, decimals: 18, perPaymentMax: U(40_000, 18), minUnits: U(1_500, 18) },
    { units: U(12_345, 18) + 670_000_000_000_000_000n, text: "12345.67", reason: "balance", ok: true }],
  ["18d: today's room binds", { balanceUnits: U(90_000, 18), decimals: 18, perPaymentMax: U(40_000, 18), roomToday: U(20_000, 18) + 1n, minUnits: U(1_500, 18) },
    { units: U(20_000, 18), text: "20000", reason: "today", ok: true }],
  ["18d: a hair under the minimum", { balanceUnits: U(1_500, 18) - 1n, decimals: 18, minUnits: U(1_500, 18) },
    { units: U(1_499, 18) + 990_000_000_000_000_000n, text: "", reason: "balance", ok: false }],
  // pots: the pot's room and the guest's cap left
  ["pot: the pot's room binds", { balanceUnits: U(50, 6), decimals: 6, perPaymentMax: U(25, 6), potRoom: 7_250_000n, guestRoom: U(10, 6), minUnits: U(1, 6) },
    { units: 7_250_000n, text: "7.25", reason: "pot", ok: true }],
  ["pot: the guest cap binds", { balanceUnits: U(50, 6), decimals: 6, perPaymentMax: U(25, 6), potRoom: U(400, 6), guestRoom: 3_009_999n, minUnits: U(1, 6) },
    { units: 3_000_000n, text: "3", reason: "guest", ok: true }],
  ["pot: guest cap used up", { balanceUnits: U(50, 6), decimals: 6, potRoom: U(400, 6), guestRoom: 0n, minUnits: U(1, 6) },
    { units: 0n, text: "", reason: "guest", ok: false }],
  ["unknown limits are left out", { balanceUnits: 4_200_000n, decimals: 6, perPaymentMax: null, roomToday: undefined },
    { units: 4_200_000n, text: "4.20", reason: "balance", ok: true }],
];

for (const [name, input, want] of CASES) {
  test(`maxSendable: ${name}`, () => {
    const got = maxSendable(input);
    assert.deepEqual(got, want);
    // never over the balance or any limit given
    for (const k of ["balanceUnits", "perPaymentMax", "roomToday", "potRoom", "guestRoom"]) if (input[k] != null) assert.ok(got.units <= BigInt(input[k]), k);
    // the text is exactly what the field reads back to the same units
    if (got.ok) {
      const p = parseMoneyInput(got.text);
      assert.equal(p.error, undefined);
      const units = BigInt(p.cents) * 10n ** BigInt(input.decimals - 2);
      assert.equal(units, got.units);
    }
  });
}

test("maxSendable: the text round-trips through the page's own parsing for every token", () => {
  for (const code of ["usdt", "cngn", "idrx", "wars", "wcop"]) {
    const d = payDecimals(code);
    const m = maxSendable({ balanceUnits: U(123, d) + 10n ** BigInt(d) / 3n, decimals: d, minUnits: U(1, d) });
    assert.equal(unitsFromCents(parseMoneyInput(m.text).cents, code), m.units, code);
  }
});

test("unitsInputText: plain digits, at most the field's decimals, rounded down", () => {
  assert.equal(unitsInputText(25_000_000n, 6), "25");
  assert.equal(unitsInputText(24_250_000n, 6), "24.25");
  assert.equal(unitsInputText(12_500_000n, 6), "12.50");
  assert.equal(unitsInputText(1_999_999n, 6), "1.99");
  assert.equal(unitsInputText(18_400_055n, 2), "184000.55");
  assert.equal(unitsInputText(18_400_000n, 2), "184000");
  assert.equal(unitsInputText(U(1_234_567, 18) + 5n, 18), "1234567");
  assert.equal(unitsInputText(7n, 0), "7");
  assert.equal(unitsInputText(123n, 6, 0), "0");
});

test("maxReasonText: one short line when a limit (not the balance) set Max", () => {
  assert.equal(maxReasonText("balance", "$13.37"), null);
  assert.equal(maxReasonText("perPayment", "$25"), "Max is $25: the most per payment.");
  assert.equal(maxReasonText("today", "$12", { who: "recipient", name: "@ada" }), "Max is $12: what @ada can still receive today.");
  assert.equal(maxReasonText("today", "$8", { who: "payer" }), "Max is $8: what you can still pay today.");
  assert.equal(maxReasonText("today", "$3", { who: "overall" }), "Max is $3: what the contract can still take today across everyone.");
  assert.equal(maxReasonText("pot", "$7.25", { who: "pot" }), "Max is $7.25: what this pot can still take.");
  assert.equal(maxReasonText("pot", "$4", { who: "host" }), "Max is $4: what the host's pots can still take today.");
  assert.equal(maxReasonText("pot", "$4", { who: "today" }), "Max is $4: what all pots can still take today.");
  assert.equal(maxReasonText("guest", "$5"), "Max is $5: the most you can still spray into this pot.");
});
