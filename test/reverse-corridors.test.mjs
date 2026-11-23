// The reverse corridors idrx-usdt, wars-usdt and wcop-usdt (the payer sends IDRX, wARS or wCOP, the recipient gets
// USD₮), next to cngn-usdt: definitions and decimals, which entry points accept them, amounts in each token's own
// decimals, the caps valued from the preview (USD₮ bought), and the live $1 floor. No network (Textile is faked).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { AGENT_ADDRESS, CORRIDORS, PAYOUT_CORRIDORS, REVERSE_CORRIDORS, TOKENS } from "../src/config.mjs";
import { getCorridor, getPayCorridor, getPayoutCorridor, parseAmount } from "../src/guards.mjs";
import { currencyOfReverse, reverseCorridorFor } from "../src/currencies.mjs";
import { registrationError } from "../src/registrations.mjs";
import { ntagUsdFloor } from "../src/watch.mjs";
import * as site from "../site/assets/core.js";

const REV = ["idrx-usdt", "wars-usdt", "wcop-usdt"];

test("reverse corridors: ids, sell/buy, decimals (IDRX 2, wARS 18, wCOP 18, USD₮ 6), valued by the USD₮ bought", () => {
  assert.deepEqual(Object.keys(REVERSE_CORRIDORS), REV);
  assert.deepEqual(Object.keys(PAYOUT_CORRIDORS), [...Object.keys(CORRIDORS), ...REV]);
  const want = { "idrx-usdt": ["IDRX", 2, "idrx"], "wars-usdt": ["WARS", 18, "wars"], "wcop-usdt": ["WCOP", 18, "wcop"] };
  for (const id of REV) {
    const c = getPayoutCorridor(id);
    const [sell, decimals, from] = want[id];
    assert.equal(c.id, id);
    assert.equal(c.sell, sell);
    assert.equal(c.buy, "USDT");
    assert.equal(c.usd, "buy", `${id}: the caps count the USD₮ bought, like cngn-usdt`);
    assert.equal(c.from, from);
    assert.equal(c.currency, undefined, `${id}: pays out dollars, not a local currency`);
    assert.equal(c.sellToken.decimals, decimals);
    assert.equal(c.buyToken.decimals, 6);
    assert.equal(c.sellToken.address, TOKENS[sell].address);
    assert.equal(reverseCorridorFor(from), id);
    assert.equal(currencyOfReverse(id).code, from);
    // the site agrees
    const s = site.REVERSE_CORRIDORS[id];
    assert.equal(site.TOKENS[s.sell].address, c.sellToken.address);
    assert.equal(site.TOKENS[s.sell].decimals, decimals);
    assert.equal(s.buy, "USDT");
    assert.equal(s.from, from);
  }
  assert.deepEqual(Object.keys(site.REVERSE_CORRIDORS), REV);
  assert.equal(CORRIDORS["cngn-usdt"].usd, "buy");
  assert.equal(currencyOfReverse("cngn-usdt").code, "cngn");
  assert.equal(currencyOfReverse("usdt-idrx"), null);
  assert.equal(site.currencyOfReverse("wars-usdt").code, "wars");
});

test("reverse corridors: pay / quote and contract autopilot accept them; payment links, requests and registrations don't", () => {
  for (const id of REV) {
    assert.equal(getPayCorridor(id).id, id);
    assert.throws(() => getCorridor(id), /payments through the contracts and direct payouts only/);
    const r = { a: "5.00", d: id, e: 2_000_000_000, n: "Ada" };
    assert.equal(registrationError(r, 1_999_999_000), "unknown corridor");
    assert.equal(site.registrationError(r, 1_999_999_000), "unknown corridor");
  }
  assert.equal(getPayoutCorridor("cngn-usdt").id, "cngn-usdt");
  assert.equal(getPayoutCorridor("usdt-idrx").id, "usdt-idrx");
  assert.throws(() => getPayoutCorridor("idrx-cngn"), /Unknown corridor/);
});

test("amounts are parsed in the sell token's own decimals", () => {
  assert.equal(parseAmount("184,070.50", 2), "184070.50");
  assert.throws(() => parseAmount("1.234", 2), /at most 2 decimal places/);
  assert.equal(parseAmount("17652.123456789012345678", 18), "17652.123456789012345678");
  assert.throws(() => parseAmount("0", 18), /greater than zero/);
  assert.equal(parseAmount("$10"), "10");
  assert.throws(() => parseAmount("1.1234567"), /Invalid amount/, "6 decimals by default, as before");
});

test("pre-flight: the caps are counted in USD from the preview (USD₮ bought), the amount in the sell token's decimals", async (t) => {
  const real = globalThis.fetch;
  const prev = process.env.CONTACTS_FILE;
  const tmp = `${os.tmpdir()}/lokal-contacts-rev-${process.pid}.json`;
  fs.writeFileSync(tmp, JSON.stringify({ contacts: {}, own_wallets: [] }));
  process.env.CONTACTS_FILE = tmp;
  t.after(() => {
    globalThis.fetch = real;
    if (prev === undefined) delete process.env.CONTACTS_FILE; else process.env.CONTACTS_FILE = prev;
    fs.rmSync(tmp, { force: true });
  });
  const { preflight } = await import("../src/pay.mjs");
  const seen = [];
  let answer = null;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    seen.push(body);
    return new Response(JSON.stringify({ data: answer(body) }), { status: 200 });
  };
  const rec = { recipientAddress: "0x2222222222222222222222222222222222222222", payer: "0x4444444444444444444444444444444444444444", agent: AGENT_ADDRESS };
  for (const [id, amount, units] of [["idrx-usdt", "184070.5", 18_407_050n], ["wars-usdt", "17652.5", 17_652_500_000_000_000_000_000n], ["wcop-usdt", "34556", 34_556n * 10n ** 18n]]) {
    answer = () => ({ status: "preview", buyAmount: "10004700", takerPays: String(units), feeAmount: "1" });
    const r = await preflight({ ...rec, amount, corridor: id });
    assert.equal(r.sellAmount, units, `${id}: ${amount} in the token's own decimals`);
    assert.equal(seen.at(-1).sellToken, getPayoutCorridor(id).sellToken.address);
    assert.equal(seen.at(-1).buyToken, TOKENS.USDT.address);
    assert.equal(seen.at(-1).sellAmount, String(units));
    // worth more than the per-payment cap once valued: refused (a permanent refusal for a contract payment)
    answer = () => ({ status: "preview", buyAmount: "25010000", takerPays: String(units), feeAmount: "1" });
    await assert.rejects(preflight({ ...rec, amount, corridor: id }), (e) => e.permanent && /per-payout cap/.test(e.message));
  }
  // no price right now: like cngn-usdt, a plain error (autopilot stops and tries again), never another currency
  answer = () => ({ status: "no_quote", reason: "no_makers_online" });
  await assert.rejects(preflight({ ...rec, amount: "184070.5", corridor: "idrx-usdt" }), (e) => !e.permanent && /No indicative price/.test(e.message));
});

test("the $1 floor: a live preview under $1 is a permanent refusal for every local -> dollars corridor; USD₮ swaps aren't checked", async () => {
  const calls = [];
  const pv = (buyAmount, status = "preview") => async (...a) => { calls.push(a); return { status, buyAmount }; };
  const cases = [["idrx-usdt", TOKENS.IDRX, 999_999n, "9999.99 IDRX"], ["wars-usdt", TOKENS.WARS, 1_000n * 10n ** 18n, "1000 wARS"], ["wcop-usdt", TOKENS.WCOP, 2_500n * 10n ** 18n, "2500 wCOP"]];
  for (const [id, tok, units, text] of cases) {
    await assert.rejects(ntagUsdFloor(id, units, pv("999999")), (e) => e.permanent === true && e.message.startsWith(text) && /below the 1 USD minimum/.test(e.message));
    assert.deepEqual(calls.at(-1), [tok.address, TOKENS.USDT.address, String(units)]);
    await ntagUsdFloor(id, units, pv("1000000"));
    await ntagUsdFloor(id, units, pv(undefined, "no_quote")); // no price: left to pre-flight
  }
  const n = calls.length;
  await ntagUsdFloor("usdt-idrx", 1_000_000n, pv("1"));
  assert.equal(calls.length, n);
});
