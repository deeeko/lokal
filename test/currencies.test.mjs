// Multi-currency: the shared registry (site <-> agent), decimals-aware amounts (cNGN 6, IDRX 2, wARS 18, wCOP 18),
// rounding down only, the corridors, the currency in Lokal tag memos and tag preferences, the currency_unavailable
// refusal, the status server's paid token, and the rates feed. No network (Textile, Blockscout and RPC are faked).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { getAddress } from "viem";
import * as reg from "../src/currencies.mjs";
import * as site from "../site/assets/core.js";
import { AGENT_ADDRESS, CORRIDORS, TOKENS } from "../src/config.mjs";
import { getCorridor, measuredReceived, notQuoting, parseCurrency, payoutCorridor, refusal } from "../src/guards.mjs";
import { fmtToken } from "../src/pay.mjs";
import * as node from "../src/ntags.mjs";
import { registrationError } from "../src/registrations.mjs";
import { classifyNtagDeposit, NTAG_MIN, ntagCorridor, watch } from "../src/watch.mjs";
import { depositEvent, reasonCode, tokenSymbol } from "../src/status-report.mjs";
import { PAID_TOKENS, REASONS, validateEvent } from "../lib/status.mjs";
import { buildRate, currencyQuote, hasAnyRate } from "../lib/rate.mjs";
import {
  agentPaidUsd, buildTransfer, estimateReceive, expectedPayoutUnits, fmtToken as cliToken, parseArgs, parseCurrencyArg, UsageError,
} from "../src/ntag.mjs";

const block = (f, start, end) => {
  const s = fs.readFileSync(new URL(f, import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const a = s.indexOf("\n", s.indexOf(start)) + 1;
  const b = s.indexOf(end);
  assert.ok(a > 0 && b > a, `${f}: markers found`);
  return s.slice(a, b);
};

// ---------- registry ----------

test("registry: the currencies block is byte-identical in core.js and src/currencies.mjs", () => {
  const S = "// ---------- currencies: start", E = "// ---------- currencies: end";
  assert.equal(block("../site/assets/core.js", S, E), block("../src/currencies.mjs", S, E));
  assert.deepEqual(site.CURRENCIES, reg.CURRENCIES);
});

test("registry: the four currencies, their tokens and decimals (Celo mainnet, Textile FX vs USD₮)", () => {
  const by = Object.fromEntries(reg.CURRENCIES.map((c) => [c.code, c]));
  assert.deepEqual(reg.CURRENCY_CODES, ["cngn", "idrx", "wars", "wcop"]);
  assert.equal(reg.DEFAULT_CURRENCY, "cngn");
  assert.deepEqual([by.cngn.address, by.cngn.decimals], ["0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f", 6]);
  assert.deepEqual([by.idrx.address, by.idrx.decimals], ["0x18Bc5bcC660cf2B9cE3cd51a404aFe1a0cBD3C22", 2]);
  assert.deepEqual([by.wars.address, by.wars.decimals], ["0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D", 18]);
  assert.deepEqual([by.wcop.address, by.wcop.decimals], ["0x8a1D45e102e886510e891d2Ec656a708991e2D76", 18]);
  assert.equal(reg.USDT_ADDRESS, "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e");
  for (const c of reg.CURRENCIES) {
    assert.equal(getAddress(c.address), c.address, `${c.code}: checksummed`);
    assert.ok(c.flag && c.symbol && c.label && c.locale && c.city, c.code);
    assert.ok(c.places <= c.decimals, `${c.code}: never shows more places than the token has`);
  }
});

test("registry: agent TOKENS / CORRIDORS and the site's agree (ids, addresses, decimals, sell/buy)", () => {
  assert.deepEqual(Object.keys(CORRIDORS).sort(), Object.keys(site.CORRIDORS).sort());
  assert.deepEqual(Object.keys(CORRIDORS), ["usdt-cngn", "cngn-usdt", "usdt-idrx", "usdt-wars", "usdt-wcop"]);
  for (const id of Object.keys(CORRIDORS)) {
    const a = getCorridor(id), s = site.CORRIDORS[id];
    assert.equal(a.sellToken.address, site.TOKENS[s.sell].address, `${id} sell`);
    assert.equal(a.buyToken.address, site.TOKENS[s.buy].address, `${id} buy`);
    assert.equal(a.buyToken.decimals, site.TOKENS[s.buy].decimals, `${id} decimals`);
    assert.equal(a.currency ?? null, s.currency ?? null, `${id} currency`);
    if (a.currency) assert.equal(a.usd, "sell", `${id}: the caps use the USD₮ sold`);
  }
  assert.equal(TOKENS.IDRX.decimals, 2);
  assert.equal(TOKENS.WARS.decimals, 18);
  assert.equal(site.tokenSymbol(TOKENS.WCOP.address), "wCOP");
  assert.equal(site.tokenUnits(123_45n, TOKENS.IDRX.address), 123.45);
  assert.equal(site.corridorOf("toString"), null);
});

test("registry: currency names from people (CLI --to, agent --to-currency)", () => {
  const cases = {
    naira: "cngn", NGN: "cngn", cngn: "cngn", nigeria: "cngn",
    rupiah: "idrx", IDRX: "idrx", idr: "idrx", " Rupiah ": "idrx",
    "argentina-peso": "wars", ars: "wars", wARS: "wars", "Peso (AR)": "wars", "argentine peso": "wars",
    "colombia-peso": "wcop", COP: "wcop", wcop: "wcop", "Peso (CO)": "wcop", colombia_peso: "wcop",
  };
  for (const [input, code] of Object.entries(cases)) {
    assert.equal(reg.findCurrency(input)?.code, code, input);
    assert.equal(parseCurrency(input), code, input);
    assert.equal(parseCurrencyArg(input), code, input);
  }
  for (const bad of ["", "peso", "usd", "wbrl", "brl", null, "toString"]) {
    assert.equal(reg.findCurrency(bad), null, String(bad));
    assert.throws(() => parseCurrency(bad), /Unknown currency/);
  }
  assert.equal(payoutCorridor("rupiah"), "usdt-idrx");
  assert.equal(reg.currencyOfCorridor("usdt-wcop").code, "wcop");
  assert.equal(reg.currencyOfCorridor("cngn-usdt"), null);
});

// ---------- amounts: decimals-aware, rounded down ----------

test("amounts: every currency is formatted from its own decimals and rounded DOWN, never up", () => {
  // the real $5 previews of 21 Nov 2026
  assert.equal(reg.formatCurrencyUnits(7_212_837_087n, "cngn"), "₦7,212.83");
  assert.equal(reg.formatCurrencyUnits(9_196_778n, "idrx"), "Rp 91,967"); // 91,967.78 -> 91,967
  assert.equal(reg.formatCurrencyUnits(9_196_778n, "idrx", 2), "Rp 91,967.78");
  assert.equal(reg.formatCurrencyUnits(8_848_744_731_732_098_509_750n, "wars"), "ARS 8,848.74"); // .7447… -> .74
  assert.equal(reg.formatCurrencyUnits(17_332_846_760_883_735_766_889n, "wcop"), "COP 17,332");
  assert.equal(reg.formatCurrencyUnits(999_999n, "cngn"), "₦0.99"); // 0.999999 is never shown as 1.00
  assert.equal(reg.formatCurrencyUnits(99n, "idrx"), "Rp 0");
  assert.equal(reg.formatCurrencyUnits(10n ** 18n - 1n, "wars"), "ARS 0.99");
  assert.equal(reg.unitsToDecimal(10n ** 18n - 1n, 18), "0.999999999999999999");
  assert.equal(reg.unitsToDecimal(1_005n, 2, 0), "10");
  assert.equal(reg.unitsToDecimal(0n, 6, 2), "0.00");
  assert.throws(() => reg.unitsToDecimal(-1n, 6), /negative/);
  // estimates (numbers): floor too, and nothing silly for bad input
  assert.equal(reg.formatCurrency(18_393.89 * 25, "idrx"), "Rp 459,847");
  assert.equal(reg.formatCurrency(1444.3658 * 10, "cngn"), "₦14,443.65");
  assert.equal(reg.formatCurrency(1.999, "wars"), "ARS 1.99");
  for (const bad of [NaN, -1, Infinity, "5", null]) assert.equal(reg.formatCurrency(bad, "wcop"), "—");
  assert.match(reg.nativeCurrency(92_035.51, "idrx"), /92\.035/); // the country's own grouping, for a tooltip
});

test("amounts: the agent writes each token's exact decimals (fmtToken) and pays only what was measured", () => {
  assert.equal(fmtToken(9_196_778n, TOKENS.IDRX), "91967.78");
  assert.equal(fmtToken(8_848_744_731_732_098_509_750n, TOKENS.WARS), "8848.74473173209850975");
  assert.equal(fmtToken(5_000_000n, TOKENS.USDT), "5");
  // the payout is the measured balance change, never more than the swap's own Transfer events (any decimals)
  const big = 17_332_846_760_883_735_766_889n;
  assert.equal(measuredReceived(big + 10n ** 18n, big), big); // a deposit landing at the same moment is not paid on
  assert.equal(measuredReceived(big, big + 1n), big);
  assert.equal(measuredReceived(9_196_778n, 9_196_778n), 9_196_778n);
  assert.equal(measuredReceived(-5n, 9_196_778n), 0n);
});

// ---------- corridors in the guards / pay pre-flight ----------

test("currency_unavailable: a local currency that isn't quoting is a permanent refusal, never another currency", () => {
  const e = notQuoting(getCorridor("usdt-wcop"), "no_quote", "no_valid_quote");
  assert.equal(e.permanent, true);
  assert.match(e.message, /^currency_unavailable: Peso \(CO\) \(wCOP\) isn't available/);
  assert.match(e.message, /never paid in another currency/);
  assert.equal(reasonCode(e.message), "currency_unavailable");
  // cngn-usdt (dollars out) keeps the old behaviour: a plain error that stops autopilot until there is a price
  const d = notQuoting(getCorridor("cngn-usdt"), "no_quote");
  assert.equal(d.permanent, undefined);
  assert.match(d.message, /No indicative price right now/);
});

test("pre-flight per currency: amounts in USD₮ base units, a no-quote refused as currency_unavailable", async (t) => {
  const real = globalThis.fetch;
  // CI has no contacts.json: use an empty temporary one (never the operator's real file).
  const prevContacts = process.env.CONTACTS_FILE;
  const tmpContacts = `${(await import("node:os")).tmpdir()}/lokal-contacts-${process.pid}.json`;
  fs.writeFileSync(tmpContacts, JSON.stringify({ contacts: {}, own_wallets: [] }));
  process.env.CONTACTS_FILE = tmpContacts;
  t.after(() => {
    globalThis.fetch = real;
    if (prevContacts === undefined) delete process.env.CONTACTS_FILE; else process.env.CONTACTS_FILE = prevContacts;
    fs.rmSync(tmpContacts, { force: true });
  });
  const { preflight } = await import("../src/pay.mjs");
  const seen = [];
  let answer = null;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push(body);
    return new Response(JSON.stringify({ data: answer(body) }), { status: 200 });
  };
  const rec = { recipientAddress: "0x2222222222222222222222222222222222222222", payer: "0x4444444444444444444444444444444444444444", agent: AGENT_ADDRESS };
  for (const [id, buy] of [["usdt-idrx", "9196778"], ["usdt-wars", "8848744731732098509750"], ["usdt-wcop", "17332846760883735766889"]]) {
    answer = () => ({ status: "preview", buyAmount: buy, takerPays: "5000000", feeAmount: "999" });
    const r = await preflight({ ...rec, amount: "5", corridor: id });
    assert.equal(r.sellAmount, 5_000_000n, `${id}: USD₮ has 6 decimals`);
    assert.equal(r.c.buyToken.address, getCorridor(id).buyToken.address);
    assert.equal(seen.at(-1).sellAmount, "5000000");
    assert.equal(seen.at(-1).buyToken, getCorridor(id).buyToken.address);
  }
  answer = () => ({ status: "no_quote", reason: "no_makers_online" });
  await assert.rejects(preflight({ ...rec, amount: "5", corridor: "usdt-wcop" }), (e) => e.permanent && /^currency_unavailable/.test(e.message));
  // over the per-payment cap is refused before any price is asked, whatever the currency
  const n = seen.length;
  await assert.rejects(preflight({ ...rec, amount: "25.01", corridor: "usdt-idrx" }), (e) => e.permanent && /per-payout cap/.test(e.message));
  assert.equal(seen.length, n);
});

// ---------- registrations / payment links ----------

test("Get paid registrations: the new corridors are valid on the site and the agent alike, with the same $ limits", () => {
  const T = 1_800_000_000;
  const ok = { a: "5.03", d: "usdt-cngn", e: T + 3600, n: "Budi" };
  const cases = [
    { ...ok, d: "usdt-idrx" }, { ...ok, d: "usdt-wars" }, { ...ok, d: "usdt-wcop" }, { ...ok, d: "usdt-idrx", a: "24.99" },
    { ...ok, d: "usdt-idrx", a: "25" }, { ...ok, d: "usdt-wcop", a: "0.99" }, { ...ok, d: "usdt-wbrl" }, { ...ok, d: "toString" },
    { ...ok, d: "constructor" }, { ...ok, d: "USDT-IDRX" },
  ];
  const want = [null, null, null, null, "amount must be $1 to $24.99", "amount must be $1 to $24.99", "unknown corridor", "unknown corridor", "unknown corridor", "unknown corridor"];
  cases.forEach((c, i) => {
    assert.equal(registrationError(c, T), want[i], JSON.stringify(c));
    assert.equal(site.registrationError(c, T), want[i], `site: ${JSON.stringify(c)}`);
  });
  const data = site.encodeRegistration({ ...ok, d: "usdt-wars" });
  assert.equal(site.decodeRegistration(data).d, "usdt-wars");
});

// ---------- Lokal tag memos and preferences (ported block) ----------

const AGENT = AGENT_ADDRESS;
const hex = (s) => Buffer.from(s, "utf8").toString("hex");

test("tag memo: NTP:<tag>:<code> names the currency; no code (or naira) keeps the original bytes", () => {
  for (const m of [site, node]) {
    const plain = m.encodeNtagTransfer(AGENT, 5_000_000n, "budi");
    assert.equal(m.encodeNtagTransfer(AGENT, 5_000_000n, "budi", "cngn"), plain, "naira = the old memo");
    assert.equal(m.encodeNtagTransfer(AGENT, 5_000_000n, "budi", undefined), plain);
    assert.ok(plain.includes(hex("NTP:budi") + m.tagSuffix()));
    for (const code of ["idrx", "wars", "wcop"]) {
      const data = m.encodeNtagTransfer(AGENT, 5_000_000n, "budi", code);
      assert.ok(data.includes(hex(`NTP:budi:${code}`)), code);
      assert.deepEqual(m.decodeNtagPayment(data), { tag: "budi", currency: code });
      assert.equal(m.decodeNtagMemo(data), "budi");
    }
    assert.deepEqual(m.decodeNtagPayment(plain), { tag: "budi", currency: null });
    assert.throws(() => m.encodeNtagTransfer(AGENT, 5_000_000n, "budi", "wbrl"), /unknown currency/);
    assert.throws(() => m.encodeNtagTransfer(AGENT, 5_000_000n, "budi", "IDRX"), /unknown currency/);
  }
  const base = "0xa9059cbb" + "00".repeat(12) + AGENT.slice(2).toLowerCase() + (5_000_000n).toString(16).padStart(64, "0");
  const bad = ["NTP:budi:", "NTP:budi:wbrl", "NTP:budi:IDRX", "NTP:budi:idrx:x", "NTP:budi::idrx", "NTP:Budi:idrx", "NTP::idrx"];
  for (const memo of bad) {
    assert.equal(site.decodeNtagPayment(base + hex(memo)), null, memo);
    assert.equal(node.decodeNtagPayment(base + hex(memo)), null, memo);
    assert.equal(node.looksLikeNtagAttempt(base + hex(memo)), true, `${memo}: refused by autopilot, never matched by amount`);
  }
  assert.deepEqual(node.decodeNtagPayment(base + hex("NTP:budi:cngn")), { tag: "budi", currency: "cngn" });
  assert.deepEqual(node.NTAG_CURRENCIES, reg.CURRENCY_CODES);
});

test("tag preference: {t, c} claims or updates the currency a tag owner prefers, resolved like names", () => {
  const BUDI = "0x2222222222222222222222222222222222222222", EVE = "0x5555555555555555555555555555555555555555";
  let n = 0;
  const op = (from, body) => { n++; return { hash: "0x" + n.toString(16).padStart(64, "0"), from, block: 100 + n, position: 0, time: 1_800_000_000 + n, value: "0", op: body }; };
  for (const m of [site, node]) {
    n = 0;
    assert.equal(m.ntagOpError({ t: "budi", c: "idrx" }), null);
    assert.equal(m.ntagOpError({ t: "budi", n: "Budi", c: "wcop" }), null);
    assert.equal(m.ntagOpError({ t: "budi", c: "wbrl" }), "unknown currency");
    assert.equal(m.ntagOpError({ t: "budi", c: 1 }), "unknown currency");
    assert.equal(m.ntagOpError({ t: "", c: "idrx" }), "a release has no currency");
    assert.equal(m.ntagOpError({ t: "budi", x: "idrx" }), "unexpected field");
    const ops = [
      op(BUDI, { t: "budi", c: "idrx" }), // 1 claim with a preference
      op(BUDI, { t: "budi", c: "idrx" }), // 2 same again: noop
      op(BUDI, { t: "budi", c: "wars" }), // 3 updated
      op(BUDI, { t: "budi", n: "Budi" }), // 4 renamed, preference kept
      op(EVE, { t: "budi", c: "cngn" }), // 5 taken: never changes Budi's preference
      op(BUDI, { t: "budi", c: "wbrl" }), // 6 invalid
      op(EVE, { t: "eve" }), // 7 no preference: naira by default
    ];
    const st = m.resolveNtags(ops);
    assert.deepEqual([...st.statuses.values()], ["claimed", "noop", "updated", "renamed", "taken", "invalid", "claimed"]);
    assert.equal(m.ownerOf(st, "budi").currency, "wars");
    assert.equal(m.ownerOf(st, "budi").name, "Budi");
    assert.equal(m.ownerOf(st, "eve").currency, undefined);
    // the claim tx a preference change sends
    const data = m.encodeNtagClaim({ t: "budi", c: "idrx" });
    assert.deepEqual(m.decodeNtagOp(data), { t: "budi", c: "idrx" });
    assert.deepEqual(m.decodeNtagOp(m.encodeNtagClaim({ t: "budi", n: "Budi S", c: "wcop" })), { t: "budi", n: "Budi S", c: "wcop" });
    assert.throws(() => m.encodeNtagClaim({ t: "budi", c: "usd" }), /unknown currency/);
    // releasing and claiming again starts without a preference
    const st2 = m.resolveNtags([...ops, op(BUDI, { t: "" }), op(BUDI, { t: "budi_s" })]);
    assert.equal(m.ownerOf(st2, "budi_s").currency, undefined);
  }
});

// ---------- autopilot ----------

const USDT = TOKENS.USDT.address, CNGN = TOKENS.CNGN.address;
const BUDI = "0x2222222222222222222222222222222222222222", PAYER = "0x4444444444444444444444444444444444444444";
const claim = { hash: "0x" + "1".padStart(64, "0"), from: BUDI, block: 10, position: 0, time: 1_700_000_010, value: "0", op: { t: "budi", c: "idrx" } };
const dep = (currency, token = USDT, units = 5_000_000n) => ({
  key: "0x" + "9".repeat(64) + ":3", tag: "budi", currency, token, value: units, payer: PAYER, block: 100, position: 1,
  tx: { from: PAYER, to: token, input: node.encodeNtagTransfer(AGENT, units, "budi", currency ?? undefined) },
});

test("autopilot: the memo's currency picks the corridor; no code is naira even if the owner prefers rupiah", () => {
  assert.equal(ntagCorridor(USDT, "idrx"), "usdt-idrx");
  assert.equal(ntagCorridor(USDT, "wars"), "usdt-wars");
  assert.equal(ntagCorridor(USDT), "usdt-cngn");
  assert.equal(ntagCorridor(USDT, "wbrl"), null);
  assert.equal(ntagCorridor(CNGN, "idrx"), null);
  for (const id of ["usdt-idrx", "usdt-wars", "usdt-wcop"]) assert.equal(NTAG_MIN[id], "1");
  const d = classifyNtagDeposit(dep("wcop"), [claim], {}, AGENT);
  assert.deepEqual([d.action, d.corridor, d.currency], ["pay", "usdt-wcop", "wcop"]);
  const plain = classifyNtagDeposit(dep(null), [claim], {}, AGENT);
  assert.deepEqual([plain.action, plain.corridor], ["pay", "usdt-cngn"], "the memo decides, never a silent switch");
  const c = classifyNtagDeposit({ ...dep(null, CNGN, 15_000_000_000n), currency: "idrx" }, [claim], {}, AGENT);
  assert.equal(c.action, "refuse");
  assert.match(c.reason, /memo/);
});

function world(deposits, pay) {
  const mem = { ntag: {}, state: { cursor: "900" }, log: [], reports: [] };
  const txs = new Map();
  const logs = deposits.map((d, i) => {
    const hash = "0x" + (1000 + i).toString(16).padStart(64, "0");
    txs.set(hash, { from: PAYER, to: USDT, input: d.input, transactionIndex: 1 });
    return { address: USDT, transactionHash: hash, logIndex: 3, blockNumber: BigInt(901 + i), transactionIndex: 1, args: { from: PAYER, to: AGENT, value: d.units } };
  });
  const calls = [];
  const io = {
    makePub: () => ({
      getBlockNumber: async () => 1000n,
      getLogs: async ({ fromBlock, toBlock }) => logs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock),
      getTransaction: async ({ hash }) => txs.get(hash),
      getBlock: async ({ blockNumber }) => ({ timestamp: 1_700_000_000n + BigInt(blockNumber) }),
    }),
    loadAccount: () => ({ address: AGENT }),
    loadState: () => structuredClone(mem.state), saveState: (s) => { mem.state = structuredClone(s); },
    loadRequests: () => [], saveRequests: () => {}, loadRegState: () => ({}), saveRegState: () => {},
    loadNtagPayments: () => structuredClone(mem.ntag), saveNtagPayments: (s) => { mem.ntag = structuredClone(s); },
    log: (e) => mem.log.push(e),
    pay: async (args) => { calls.push(args); return pay(args); },
    preflight: async () => ({}),
    discoverRegistrations: async () => [], indexedHeight: async () => 1000n,
    loadNtagOpsCache: async () => ({ ops: [claim], head: { block: 999, position: 0 } }), refreshNtagOpsCache: async (c) => c,
    verifyRegistrationOnchain: async () => ({}), verifyNtagOpOnchain: async (_p, o) => ({ from: getAddress(o.from) }),
    ntagUsdFloor: async () => {}, print: () => {}, sleep: async () => {}, readReceipts: () => [],
    makeStatus: () => ({ enabled: true, report: (e) => mem.reports.push(e), syncRecords: () => 0, flush: async () => ({}), close: async () => {} }),
  };
  return { io, mem, calls };
}

test("autopilot e2e: pays in the chosen currency; status events carry the paid token and amount", async () => {
  const w = world([{ units: 5_000_000n, input: node.encodeNtagTransfer(AGENT, 5_000_000n, "budi", "wars") }],
    () => ({ hashes: { swap: "0x" + "7".repeat(64), payout: "0x" + "8".repeat(64) }, receiptNo: "NP-8888-8888", receiptUrl: "u", paid: "8848.74473173209850975", paidToken: "wARS", usd: "5" }));
  await watch({ execute: true, polls: 1, io: w.io });
  assert.equal(w.calls.length, 1);
  assert.equal(w.calls[0].corridor, "usdt-wars");
  assert.equal(w.calls[0].recipientAddress, getAddress(BUDI));
  const rec = Object.values(w.mem.ntag)[0];
  assert.equal(rec.dir, "usdt-wars");
  assert.equal(rec.currency, "wars");
  assert.ok(rec.paidAt);
  const paid = w.mem.reports.find((e) => e.status === "paid");
  assert.equal(paid.paidToken, "wARS");
  assert.equal(paid.paidAmount, "8848.74473173209850975");
  assert.equal(validateEvent(paid).error, undefined, "the status server accepts it");
});

test("autopilot e2e: a currency that stops quoting is refused (currency_unavailable), recorded, reported, and never paid otherwise", async () => {
  const w = world([{ units: 5_000_000n, input: node.encodeNtagTransfer(AGENT, 5_000_000n, "budi", "wcop") }], (args) => {
    throw notQuoting(getCorridor(args.corridor), "no_quote", "no_valid_quote"); // the firm quote: nothing was sent
  });
  await watch({ execute: true, polls: 1, io: w.io });
  assert.equal(w.calls.length, 1, "asked once, in wCOP only");
  const rec = Object.values(w.mem.ntag)[0];
  assert.equal(rec.status, "refused");
  assert.match(rec.reason, /^currency_unavailable/);
  const ev = w.mem.reports.find((e) => e.status === "refused");
  assert.equal(ev.reason, "currency_unavailable");
  assert.equal(validateEvent(ev).error, undefined);
  // a rescan never pays it (also not in naira)
  await watch({ execute: true, polls: 1, io: { ...w.io, loadState: () => ({ cursor: "900" }) } });
  assert.equal(w.calls.length, 1);
});

// ---------- status server ----------

test("status: the paid token is any registry token; currency_unavailable is a known reason", () => {
  assert.deepEqual(PAID_TOKENS, ["USDT", "cNGN", "IDRX", "wARS", "wCOP"]);
  assert.ok(REASONS.includes("currency_unavailable"));
  for (const [i, o] of [["IDRX", "IDRX"], ["wars", "wARS"], ["WCOP", "wCOP"], ["USD₮", "USDT"], ["cngn", "cNGN"], ["CELO", "CELO"], ["wbrl", undefined]]) assert.equal(tokenSymbol(i), o, i);
  const ev = depositEvent({
    kind: "ntag", key: "0x" + "a".repeat(64) + ":1", tag: "budi", recipient: BUDI, token: "USDT", amount: "5", corridor: "usdt-idrx",
    payer: PAYER, status: "paid", res: { hashes: { payout: "0x" + "b".repeat(64) }, receiptNo: site.receiptNo("0x" + "b".repeat(64)), paid: "91967.78", usd: "5" },
  });
  assert.equal(ev.paidToken, "IDRX", "from the corridor when pay() did not say");
  assert.equal(validateEvent(ev).error, undefined);
  assert.equal(validateEvent({ ...ev, paidToken: "wBRL" }).error, "bad paidToken");
});

// ---------- rates feed ----------

const fakeTextile = (table) => async (url, init) => {
  if (String(url).includes("tickers")) return new Response(JSON.stringify([{ bid: "1444", ask: "1443", last_price: "1444" }]), { status: 200 });
  const b = JSON.parse(init.body);
  const data = table(b);
  return data instanceof Error ? Promise.reject(data) : new Response(JSON.stringify({ data }), { status: 200 });
};
const byAddr = Object.fromEntries(reg.CURRENCIES.map((c) => [c.address, c.code]));

test("rates: every currency, a thin market read from a smaller preview, graceful partial failure", async () => {
  const quotes = {
    cngn: (u) => ({ status: "preview", buyAmount: String(BigInt(u) * 1444n * 1000n / 1000n * 1n), availableSellAmount: "42573180000" }),
    idrx: (u) => ({ status: "preview", buyAmount: String((BigInt(u) * 18393n * 100n) / 1_000_000n), availableSellAmount: "115629670000" }),
    wars: () => new Error("socket hang up"),
    wcop: (u) => (BigInt(u) > 6_710_000n ? { status: "no_quote", reason: "no_valid_quote" } : { status: "preview", buyAmount: String((BigInt(u) * 3460n * 10n ** 18n) / 1_000_000n), availableSellAmount: "6710000" }),
  };
  const fetchImpl = fakeTextile((b) => {
    if (b.buyToken === reg.USDT_ADDRESS) return { status: "preview", buyAmount: "9968215" }; // cNGN or CELO -> USD₮
    return quotes[byAddr[b.buyToken]](b.sellAmount);
  });
  const r = await buildRate({ timeoutMs: 1000, fetchImpl });
  assert.equal(r.base, "USDT");
  assert.equal(r.rates.idrx, 18393);
  assert.equal(r.rates.wcop, 3460, "from the $1 preview");
  assert.equal(r.maxUsd.wcop, 6.71);
  assert.equal(r.available.wars, false);
  assert.equal(r.rates.wars, null);
  assert.deepEqual(Object.keys(r.rates), ["cngn", "idrx", "wars", "wcop"]);
  assert.ok(r.errors.some((e) => /wars/.test(e)));
  assert.equal(r.effectiveRate, r.rates.cngn, "the old naira field still works");
  assert.ok(r.at && r.fetchedAt);
  assert.ok(hasAnyRate(r));
  // the site reads the same body
  const s = site.ratesFrom(r);
  assert.equal(s.available.wars, false);
  assert.equal(s.rates.idrx, 18393);
  // an old rate.json (naira only) still gives naira, and the other currencies show as unavailable
  const old = site.ratesFrom({ effectiveRate: 1441.8, previewUsd: 10 });
  assert.deepEqual(old.available, { cngn: true, idrx: false, wars: false, wcop: false });
  const q = await currencyQuote(reg.currencyOf("wcop"), { fetchImpl: fakeTextile(() => ({ status: "no_quote", reason: "no_makers_online" })) });
  assert.equal(q.available, false);
});

// ---------- lokal CLI ----------

test("lokal CLI: --to picks what they receive; the summary says how much in that currency", () => {
  assert.equal(parseArgs(["send", "ada", "10", "--to", "rupiah"]).flags.to, "rupiah");
  assert.equal(parseArgs(["send", "ada", "10", "--to=colombia-peso"]).flags.to, "colombia-peso");
  assert.throws(() => parseArgs(["send", "ada", "10", "--to", "rupiah", "--dollars"]), UsageError);
  assert.throws(() => parseArgs(["send", "ada", "10", "--to", "rupiah", "--naira"]), UsageError);
  assert.throws(() => parseCurrencyArg("pesos"), UsageError);
  const rate = { rates: { cngn: 1444.3658, idrx: 18393.89, wars: 1768.5091, wcop: 3460.58 }, available: { cngn: true, idrx: true, wars: true, wcop: false } };
  assert.equal(estimateReceive("USDT", 10_000_000n, rate, "idrx").text, "≈ Rp 183,938 in rupiah (IDRX)");
  assert.equal(estimateReceive("USDT", 10_000_000n, rate, "idrx").rateText, "$1 ≈ Rp 18,393");
  assert.equal(estimateReceive("USDT", 10_000_000n, rate, "wars").text, "≈ ARS 17,685.09 in Argentine pesos (wARS)");
  assert.equal(estimateReceive("USDT", 10_000_000n, rate, "wcop").text, null, "not quoting: no estimate");
  assert.equal(estimateReceive("USDT", 10_000_000n, { effectiveRate: 1444.3658 }).text, "≈ ₦14,443.66 in naira (cNGN)");
  const tx = buildTransfer({ token: "USDT", units: 5_000_000n, tag: "ada", currency: "wcop" });
  assert.deepEqual(node.decodeNtagPayment(tx.data), { tag: "ada", currency: "wcop" });
  assert.equal(buildTransfer({ token: "USDT", units: 5_000_000n, tag: "ada" }).data, node.encodeNtagTransfer(AGENT, 5_000_000n, "ada"));
  assert.throws(() => buildTransfer({ token: "CNGN", units: 5_000_000n, tag: "ada", currency: "idrx" }), UsageError);
  assert.equal(cliToken(9_196_778n, "IDRX"), "Rp 91,967 IDRX");
  assert.equal(cliToken(8_848_744_731_732_098_509_750n, "WARS"), "ARS 8,848.74 wARS");
});

test("lokal CLI: payouts in any currency are matched and counted in dollars by their own decimals", () => {
  const rate = { rates: { cngn: 1400, idrx: 18_000, wars: 1_800, wcop: 3_500 } };
  assert.equal(expectedPayoutUnits("USDT", 5_000_000n, rate, "idrx"), 9_000_000n); // Rp 90,000.00 at 2 decimals
  assert.equal(expectedPayoutUnits("USDT", 5_000_000n, rate, "wars"), 9_000n * 10n ** 18n); // ARS 9,000 at 18 decimals
  assert.equal(expectedPayoutUnits("USDT", 5_000_000n, rate, "cngn"), 7_000_000_000n);
  assert.equal(expectedPayoutUnits("USDT", 5_000_000n, {}, "wcop"), null);
  const owner = BUDI, agent = AGENT;
  const t = (token, units) => ({ from: agent, to: owner, token, units, time: 2000 });
  const items = [t(TOKENS.USDT.address, 5_000_000n), t(TOKENS.IDRX.address, 9_000_000n), t(TOKENS.WARS.address, 1_800n * 10n ** 18n), t(TOKENS.CNGN.address, 1_400_000_000n)];
  // $5 + Rp 90,000 ($5) + ARS 1,800 ($1) + ₦1,400 ($1) = $12
  assert.equal(agentPaidUsd(items, { owner, sinceSec: 1000, ngnPerUsd: 1400, perUsd: rate.rates }), 12_000_000n);
  // without a rupiah rate that payout can't be valued (and is left out, never guessed)
  assert.equal(agentPaidUsd(items, { owner, sinceSec: 1000, ngnPerUsd: 1400, perUsd: { wars: 1800 } }), 7_000_000n);
});

test("refusal helper is unchanged", () => assert.equal(refusal("x").permanent, true));

test("same-amount rule: links in different currencies are all paid in USD₮, so one USD₮ amount is in use only once", async () => {
  const { registrationStatuses, matchRegistration } = await import("../src/registrations.mjs");
  const T = 1_800_000_000;
  const reg = (n, d, a = "5.03") => ({ hash: "0x" + String(n).padStart(64, "0"), from: BUDI, block: 100 + n, position: 0, time: T, req: { a, d, e: T + 7200, n: "B" } });
  const regs = [reg(1, "usdt-cngn"), reg(2, "usdt-idrx"), reg(3, "usdt-wcop", "6.10"), reg(4, "cngn-usdt")];
  const want = [["0x" + "1".padStart(64, "0"), "active"], ["0x" + "2".padStart(64, "0"), "in-use"], ["0x" + "3".padStart(64, "0"), "active"], ["0x" + "4".padStart(64, "0"), "active"]];
  assert.deepEqual([...registrationStatuses(regs, T + 60)], want);
  assert.deepEqual([...site.registrationStatuses(regs, T + 60)], want);
  // a USD₮ deposit of 5.03 pays only the first link (naira); the rupiah link with the same amount is never paid
  const m = matchRegistration({ token: USDT, value: 5_030_000n, timeMs: (T + 60) * 1000 }, regs);
  assert.equal(m.reg.req.d, "usdt-cngn");
  const w = matchRegistration({ token: USDT, value: 6_100_000n, timeMs: (T + 60) * 1000 }, regs);
  assert.equal(w.reg.req.d, "usdt-wcop");
  assert.deepEqual(site.NTAG_CURRENCIES, site.CURRENCY_CODES);
});
