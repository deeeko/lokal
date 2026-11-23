// Refunds (src/refund.mjs): the rules, every refusal, the record-before-send flow, crash recovery with --retry, the
// refund caps, autopilot never paying a refunded deposit, a paid deposit never refunded, and auto-refund. A fake chain
// and in-memory files (test/fakes.mjs): nothing touches the network or the real state files.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getAddress, parseUnits } from "viem";
import { AGENT_ADDRESS, TOKENS } from "../src/config.mjs";
import { assertRefundCap, dailyUsedUnits, refusal, refundUsedUnits, walletUsedUnits } from "../src/guards.mjs";
import { encodeNtagTransfer } from "../src/ntags.mjs";
import {
  depositorBlocker, findDepositRecord, parseDepositKey, refundDeposit, refundRecordBlocker, refundRows, refundUsdUnits, SENDING_STALE_MS,
} from "../src/refund.mjs";
import { watch } from "../src/watch.mjs";
import { refundEvent } from "../src/status-report.mjs";
import { validateEvent } from "../lib/status.mjs";
import { ADA, OWN, PAYER, REG, REG_UNITS, fakePreview, h, key, refundDeps, world } from "./fakes.mjs";

const run = (w, opts = {}) => watch({ execute: true, polls: 1, io: w.io, ...opts });
const unmatched = (n, units = 7_000_000n) => world({ deposits: [{ n, block: 901, units }] });
/** A world where autopilot has already logged deposit 1 (7 USDT) as unmatched. */
async function unmatchedWorld(opts = {}) {
  const w = world({ deposits: [{ n: 1, block: 901, units: 7_000_000n }], ...opts });
  await run(w);
  assert.equal(w.mem.log.filter((e) => e.type === "unmatched_deposit").length, 1);
  return w;
}

test("deposit keys: <tx>:<logIndex>, lower-cased; anything else is refused with the expected form", () => {
  assert.deepEqual(parseDepositKey(`${h(1).toUpperCase().replace("0X", "0x")}:4`), { key: `${h(1)}:4`, tx: h(1), logIndex: 4 });
  for (const bad of ["", "0x12:1", `${h(1)}`, `${h(1)}:x`, `${h(1)}:-1`]) assert.throws(() => parseDepositKey(bad), /<tx hash>:<logIndex>/);
});

test("records: paid or payout-recorded deposits are never refundable; refused, unmatched and ambiguous ones are", () => {
  const k = { key: `${h(9)}:2`, tx: h(9), logIndex: 2 };
  const dep = { tx: h(9), logIndex: 2, payer: PAYER };
  assert.equal(findDepositRecord(k, { requests: [{ id: "r_1", deposit: dep, paidAt: "x" }] }).payout.paid, true);
  assert.equal(findDepositRecord(k, { requests: [{ id: "r_1", deposit: dep, error: "boom" }] }).payout.paid, false, "a failed payout is still a payout");
  assert.ok(findDepositRecord(k, { registrations: { a: { hash: "0xa", deposit: dep } } }).payout);
  const refusedNtag = { [k.key]: { status: "refused", reason: "unknown LokalPay tag", token: "USDT", amount: "5", deposit: dep, tag: "zed" } };
  const r = findDepositRecord(k, { ntagPayments: refusedNtag });
  assert.equal(r.payout, null);
  assert.equal(r.refundable.category, "refused");
  assert.equal(r.refundable.source.kind, "ntag");
  for (const touched of [{ paidAt: "x" }, { retrying: "x" }, { hashes: { swap: h(3) } }]) {
    const t = findDepositRecord(k, { ntagPayments: { [k.key]: { ...refusedNtag[k.key], ...touched } } });
    assert.ok(t.payout, `a refused tag payment that was then ${Object.keys(touched)[0]} is a payout`);
  }
  const reg = findDepositRecord(k, { registrations: { a: { hash: REG.hash, from: REG.from, dir: "usdt-cngn", amount: "5.03", refused: { [k.key]: { ...dep, reason: "self-payment" } } } } });
  assert.equal(reg.refundable.source.kind, "registration");
  assert.equal(reg.refundable.token, "USDT");
  const um = findDepositRecord(k, { receipts: [{ type: "unmatched_deposit", tx: h(9), logIndex: 2, from: PAYER, token: "USDT", amount: "7.00" }] });
  assert.equal(um.refundable.category, "unmatched");
  const used = findDepositRecord(k, { receipts: [{ type: "unmatched_deposit", reason: "registration already used", tx: h(9), logIndex: 2 }] });
  assert.match(used.refundable.reason, /already used/);
  assert.equal(findDepositRecord(k, { receipts: [{ type: "ambiguous_deposit", tx: h(9), logIndex: 2 }] }).refundable.category, "ambiguous");
  assert.equal(findDepositRecord(k, { receipts: [{ type: "unmatched_deposit", tx: h(9), logIndex: 5 }] }).refundable, null, "another log of the same tx");
  assert.equal(findDepositRecord(k, { receipts: [{ type: "preflight_failed", tx: h(9) }] }).refundable, null, "autopilot will retry it: not refundable");
  // payout wins over a refusal record
  assert.ok(findDepositRecord(k, { requests: [{ id: "r", deposit: dep, paidAt: "x" }], receipts: [{ type: "unmatched_deposit", tx: h(9), logIndex: 2 }] }).payout);
});

test("refund records: refunded, too small, in progress and failed stop a new refund; --retry only after a failure or 10 min", () => {
  const now = Date.parse("2026-11-21T12:00:00Z");
  assert.equal(refundRecordBlocker(null), null);
  assert.match(refundRecordBlocker(null, { retry: true }), /no failed refund/);
  assert.match(refundRecordBlocker({ id: "k", status: "refunded", refundTx: h(5), refundNo: "RF-0000-0000" }), /already refunded/);
  assert.match(refundRecordBlocker({ id: "k", status: "too_small_to_refund" }), /too_small_to_refund/);
  const sending = { id: "k", status: "sending", startedAt: new Date(now - 60_000).toISOString() };
  assert.match(refundRecordBlocker(sending, { now }), /in progress/);
  assert.match(refundRecordBlocker(sending, { now, retry: true }), /in progress/, "a fresh sending record waits even with --retry");
  assert.equal(refundRecordBlocker({ ...sending, startedAt: new Date(now - SENDING_STALE_MS).toISOString() }, { now, retry: true }), null);
  assert.match(refundRecordBlocker({ id: "k", status: "failed", error: "x" }), /not retried automatically.*--retry/);
  assert.equal(refundRecordBlocker({ id: "k", status: "failed" }, { retry: true }), null);
});

test("depositors that are never refunded: the agent, own wallets (top-ups), known contracts, the zero address", () => {
  const opts = { agent: AGENT_ADDRESS, own: [OWN], contracts: [TOKENS.USDT.address] };
  assert.match(depositorBlocker(AGENT_ADDRESS, opts), /agent itself/);
  assert.match(depositorBlocker(getAddress(OWN), opts), /top-up/);
  assert.match(depositorBlocker(TOKENS.USDT.address.toLowerCase(), opts), /contract/);
  assert.match(depositorBlocker("0x0000000000000000000000000000000000000000", opts), /zero address/);
  assert.match(depositorBlocker("nope", opts), /not a valid address/);
  assert.equal(depositorBlocker(PAYER, opts), null);
});

test("refund of an unmatched deposit: dry run writes and sends nothing; --execute records 'sending' first, then refunds", async () => {
  const w = await unmatchedWorld();
  const { deps, events } = refundDeps(w);
  const dry = await refundDeposit(key(1), deps);
  assert.equal(dry.dryRun, true);
  assert.equal(w.sent.length, 0);
  assert.deepEqual(w.mem.refunds, {});
  assert.ok(w.out.some((l) => /Gas: ~50000 gas/.test(l)), "the dry run shows a gas estimate");
  assert.equal(events.locks, 0, "a dry run never takes the lock");

  let statusAtSend = null;
  w.wallet.onSend = ({ args }) => { statusAtSend = w.mem.refunds[key(1)]?.status; assert.equal(args[0], getAddress(PAYER)); assert.equal(args[1], 7_000_000n); };
  const res = await refundDeposit(key(1), deps, { execute: true });
  assert.equal(statusAtSend, "sending", "recorded BEFORE the transfer was sent");
  assert.equal(res.status, "refunded");
  assert.equal(events.confirms, 1);
  assert.deepEqual([events.locks, events.releases], [1, 1], "the lock is taken after the yes and released");
  const rec = w.mem.refunds[key(1)];
  assert.equal(rec.status, "refunded");
  assert.equal(rec.refundTx, w.sent[0].hash);
  assert.match(rec.refundNo, /^RF-[0-9A-F]{4}-[0-9A-F]{4}$/);
  assert.equal(rec.amount, "7");
  const line = w.mem.log.find((e) => e.kind === "refund");
  assert.equal(line.hashes.refund, rec.refundTx);
  assert.equal(line.hashes.payout, undefined, "a refund is never a payout");
  assert.equal(events.reports.length, 1);
  const ev = refundEvent(events.reports[0]);
  assert.equal(validateEvent(ev).error, undefined);
  assert.equal(ev.kind, "deposit");
  assert.equal(ev.status, "refunded");

  // and never twice
  await assert.rejects(refundDeposit(key(1), deps, { execute: true, yes: true }), /already refunded/);
  assert.equal(w.sent.length, 1);
});

test("refusals: no record, a paid deposit, a top-up, the agent's own swap output, a short balance, low gas, the refund cap", async () => {
  // autopilot has never seen it
  const fresh = unmatched(1);
  await assert.rejects(refundDeposit(key(1), refundDeps(fresh).deps), /no refusal, unmatched or ambiguous record/);

  // a top-up from an own wallet, logged as unmatched
  const top = await unmatchedWorld({ deposits: [{ n: 1, block: 901, units: 7_000_000n, from: OWN }] });
  await assert.rejects(refundDeposit(key(1), refundDeps(top).deps), /top-up/);

  // the agent's own transaction (e.g. a swap output): a record that says unmatched is still refused
  const own = await unmatchedWorld();
  own.pub.getTransactionReceipt = async () => ({ status: "success", from: AGENT_ADDRESS, logs: [] });
  await assert.rejects(refundDeposit(key(1), refundDeps(own).deps), /sent by the agent itself/);

  // a Textile reactor the agent swapped with (from its payout receipts)
  const reactor = "0x9999999999999999999999999999999999999999";
  const rx = await unmatchedWorld({ deposits: [{ n: 1, block: 901, units: 7_000_000n, from: reactor }] });
  rx.mem.log.push({ corridor: "usdt-cngn", hashes: { payout: h(42) }, reactor });
  await assert.rejects(refundDeposit(key(1), refundDeps(rx).deps), /Textile reactor/);

  // short balance
  const poor = await unmatchedWorld({ chain: { balances: { [TOKENS.USDT.address.toLowerCase()]: 6_000_000n } } });
  await assert.rejects(refundDeposit(key(1), refundDeps(poor).deps, { execute: true, yes: true }), /holds 6 USDT; the refund needs 7/);
  assert.equal(poor.sent.length, 0);
  assert.deepEqual(poor.mem.refunds, {}, "nothing recorded when a check fails");

  // no CELO for gas
  const dry = await unmatchedWorld({ chain: { celo: 1000n } });
  await assert.rejects(refundDeposit(key(1), refundDeps(dry).deps, { execute: true, yes: true }), /CELO for gas/);

  // the refund cap (MAX_DAILY_REFUND_USD = 100): 95 USD refunded today, 7 more is over
  const capped = await unmatchedWorld();
  capped.mem.log.push({ at: new Date().toISOString(), kind: "refund", usd: "95", hashes: { refund: h(77) } });
  await assert.rejects(refundDeposit(key(1), refundDeps(capped).deps, { execute: true, yes: true }), /MAX_DAILY_REFUND_USD/);

  // a different log of the same tx, or a log that isn't a deposit to the agent
  const other = await unmatchedWorld();
  await assert.rejects(refundDeposit(`${h(1001)}:9`, refundDeps(other).deps), /no refusal, unmatched or ambiguous record/);
});

test("dust: a deposit worth under MIN_REFUND_USD is recorded as too_small_to_refund and never sent", async () => {
  const w = await unmatchedWorld({ deposits: [{ n: 1, block: 901, units: 400_000n }] });
  const { deps } = refundDeps(w);
  const res = await refundDeposit(key(1), deps, { execute: true, yes: true });
  assert.equal(res.status, "too_small_to_refund");
  assert.equal(w.sent.length, 0);
  assert.equal(w.mem.refunds[key(1)].status, "too_small_to_refund");
  await assert.rejects(refundDeposit(key(1), deps, { execute: true, yes: true }), /too_small_to_refund/);
  // the listing shows the same status before anything is recorded
  const w2 = await unmatchedWorld({ deposits: [{ n: 1, block: 901, units: 400_000n }] });
  assert.equal(refundRows({ receipts: w2.mem.log }, {})[0].status, "too_small_to_refund");
});

test("a paid deposit is never refunded (autopilot paid it first)", async () => {
  const w = world({ deposits: [{ n: 1, block: 901, units: 5_000_000n, input: encodeNtagTransfer(AGENT_ADDRESS, 5_000_000n, "ada") }] });
  await run(w);
  assert.equal(w.calls.length, 1);
  await assert.rejects(refundDeposit(key(1), refundDeps(w).deps, { execute: true, yes: true }), /PAID .*never refunded/);
  assert.equal(w.sent.length, 0);
  assert.deepEqual(w.mem.refunds, {});
});

test("a refunded deposit is never paid: autopilot skips any deposit with a refund record, also on a rescan", async () => {
  // deposit 1 is refused (unknown tag) and refunded; deposit 2 would match a registration but has a refund record too
  const deposits = [
    { n: 1, block: 901, units: 3_000_000n, input: encodeNtagTransfer(AGENT_ADDRESS, 3_000_000n, "nobody") },
    { n: 2, block: 902, units: REG_UNITS },
  ];
  const w = world({ deposits, regs: [REG] });
  w.mem.refunds[key(2)] = { id: key(2), status: "sending", startedAt: new Date().toISOString() };
  await run(w);
  assert.equal(w.calls.length, 0, "the deposit with a refund record is not paid");
  assert.ok(w.out.some((l) => /has a refund record \(sending\)/.test(l)));
  await refundDeposit(key(1), refundDeps(w).deps, { execute: true, yes: true });
  assert.equal(w.mem.refunds[key(1)].status, "refunded");
  // rescan from before both, with the tag now claimable: still nothing is paid
  w.mem.state = { cursor: "900" };
  w.mem.ntag = {};
  await run(w);
  assert.equal(w.calls.length, 0);
});

test("retry --force-refused refuses a refunded LokalPay tag deposit (the CLI, offline, on temp files)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "np-refund-cli-"));
  const k = `${h(1001)}:3`;
  const env = {
    ...process.env, NODE_TEST_CONTEXT: undefined, CELO_AGENT_KEY_FILE: path.join(dir, "no-key.json"), AGENT_LOCK_FILE: path.join(dir, "agent.lock"),
    NTAG_PAYMENTS_FILE: path.join(dir, "ntag.json"), REFUNDS_FILE: path.join(dir, "refunds.json"), RECEIPTS_FILE: path.join(dir, "r.jsonl"),
    REQUESTS_FILE: path.join(dir, "req.json"), REGISTRATIONS_STATE_FILE: path.join(dir, "reg.json"), CONTACTS_FILE: path.join(dir, "contacts.json"),
  };
  delete env.NODE_TEST_CONTEXT;
  fs.writeFileSync(env.NTAG_PAYMENTS_FILE, JSON.stringify({ payments: { [k]: {
    id: k, tag: "ada", name: "@ada", from: getAddress(ADA), owner: getAddress(ADA), claim: h(1), token: "USDT", amount: "5", dir: "usdt-cngn",
    deposit: { payer: PAYER, tx: h(1001), logIndex: 3 }, status: "refused", reason: "over the per-wallet cap",
  } } }));
  fs.writeFileSync(env.REFUNDS_FILE, JSON.stringify({ refunds: { [k]: { id: k, status: "refunded", refundTx: h(5001) } } }));
  let out = "";
  try {
    execFileSync(process.execPath, ["src/agent.mjs", "retry", "--ntag", k, "--force-refused"], { env, cwd: path.join(import.meta.dirname, ".."), encoding: "utf8", stdio: "pipe" });
  } catch (e) { out = String(e.stderr) + String(e.stdout); }
  assert.match(out, /has a refund record \(refunded.*never paid/);
});

test("crash recovery: a failed send is recorded as failed (never auto-retried); --retry searches the chain first", async () => {
  // 1. the send throws: recorded "failed", an urgent alert, nothing retried
  const w = await unmatchedWorld({ chain: { failSend: true } });
  const { deps } = refundDeps(w);
  await assert.rejects(refundDeposit(key(1), deps, { execute: true, yes: true }), /failed: the transfer could not be sent/);
  assert.equal(w.mem.refunds[key(1)].status, "failed");
  assert.equal(w.mem.alerts.at(-1).kind, "refund_failed");
  await assert.rejects(refundDeposit(key(1), deps, { execute: true, yes: true }), /not retried automatically/);
  // 2. --retry with nothing onchain (the same records, a chain where sending works): sends once
  const sendWorld = await unmatchedWorld();
  sendWorld.mem.refunds = structuredClone(w.mem.refunds);
  const r2 = await refundDeposit(key(1), refundDeps(sendWorld).deps, { execute: true, yes: true, retry: true });
  assert.equal(r2.status, "refunded");
  assert.equal(r2.found, false);
  assert.equal(sendWorld.sent.length, 1);
  assert.equal(sendWorld.mem.refunds[key(1)].attempts, 2);
});

test("crash between send and record: 'sending' blocks everything; --retry after 10 min finds the transfer and sends nothing", async () => {
  const w = await unmatchedWorld({ chain: { noReceipt: true } });
  const { deps } = refundDeps(w);
  // the transfer is broadcast (and mined), but the process never learns it: recorded failed with its tx
  await assert.rejects(refundDeposit(key(1), deps, { execute: true, yes: true }), /no receipt/);
  const rec = w.mem.refunds[key(1)];
  assert.equal(rec.status, "failed");
  assert.equal(rec.refundTx, w.sent[0].hash);
  // a hard crash instead: the record stays "sending" (simulate it), and nobody may touch the deposit
  w.mem.refunds[key(1)] = { ...rec, status: "sending", startedAt: new Date().toISOString() };
  await assert.rejects(refundDeposit(key(1), deps, { execute: true, yes: true, retry: true }), /in progress/);
  w.mem.state = { cursor: "900" };
  await run(w);
  assert.equal(w.calls.length, 0, "autopilot never pays a deposit whose refund is in flight");
  // 10 minutes later: --retry finds the mined transfer by its hash and marks it refunded, sending nothing
  w.mem.refunds[key(1)].startedAt = new Date(Date.now() - SENDING_STALE_MS - 1000).toISOString();
  const res = await refundDeposit(key(1), deps, { execute: true, yes: true, retry: true });
  assert.equal(res.status, "refunded");
  assert.equal(res.found, true);
  assert.equal(w.sent.length, 1, "nothing was sent again");
  assert.equal(w.mem.refunds[key(1)].refundTx, w.sent[0].hash);

  // without a saved hash: the chain search (Transfer logs from the agent to the payer) finds it too
  const w2 = await unmatchedWorld();
  const d2 = refundDeps(w2).deps;
  await refundDeposit(key(1), d2, { execute: true, yes: true });
  const mined = w2.mem.refunds[key(1)].refundTx;
  w2.mem.refunds[key(1)] = { ...w2.mem.refunds[key(1)], status: "failed", refundTx: undefined, startBlock: "1000" };
  w2.mem.log = w2.mem.log.filter((e) => e.kind !== "refund");
  const again = await refundDeposit(key(1), d2, { execute: true, yes: true, retry: true });
  assert.equal(again.found, true);
  assert.equal(again.refundTx, mined);
  assert.equal(w2.sent.length, 1);
});

test("a reverted refund is failed, with its tx; nothing is retried by itself", async () => {
  const w = await unmatchedWorld({ chain: { revert: true } });
  await assert.rejects(refundDeposit(key(1), refundDeps(w).deps, { execute: true, yes: true }), /reverted/);
  assert.equal(w.mem.refunds[key(1)].status, "failed");
  assert.equal(w.mem.refunds[key(1)].refundTx, w.sent[0].hash);
});

test("USD value of a refund: USD₮ 1:1, cNGN from a preview, other local tokens from the inverse price; no price refuses", async () => {
  assert.equal(await refundUsdUnits(TOKENS.USDT, 7_000_000n, fakePreview), 7_000_000n);
  assert.equal(await refundUsdUnits(TOKENS.CNGN, 15_000_000_000n, fakePreview), 10_000_000n);
  if (TOKENS.IDRX) {
    // 1 USD₮ = 16,000 IDRX (2 decimals): 160,000.00 IDRX is 10 USD
    assert.equal(await refundUsdUnits(TOKENS.IDRX, 16_000_000n, fakePreview), 10_000_000n);
  }
  await assert.rejects(refundUsdUnits(TOKENS.CNGN, 1n, async () => ({ status: "no_quote" })), /No cNGN price/);
});

test("caps: payout caps skip refund lines; refunds have their own rolling 24 h cap", () => {
  const now = Date.now();
  const at = new Date(now - 60_000).toISOString();
  const entries = [
    { at, usd: "10", hashes: { payout: h(1) }, recipient: ADA },
    { at, kind: "refund", usd: "20", hashes: { refund: h(2) }, recipient: ADA },
    { at, kind: "refund", usd: "30", hashes: { refund: h(3), payout: h(4) }, recipient: ADA }, // never counted as a payout
    { at: new Date(now - 25 * 3600_000).toISOString(), kind: "refund", usd: "99", hashes: { refund: h(5) } },
  ];
  assert.equal(dailyUsedUnits(entries, now), parseUnits("10", 6));
  assert.equal(walletUsedUnits(entries, ADA, now), parseUnits("10", 6));
  assert.equal(refundUsedUnits(entries, now), parseUnits("50", 6));
  assert.doesNotThrow(() => assertRefundCap(parseUnits("50", 6), parseUnits("50", 6), "100"));
  assert.throws(() => assertRefundCap(parseUnits("50", 6), parseUnits("50.000001", 6), "100"), /MAX_DAILY_REFUND_USD/);
});

test("refunds listing: refused, unmatched and ambiguous deposits with their status; paid ones never appear", async () => {
  const w = world({
    deposits: [
      { n: 1, block: 901, units: 7_000_000n }, // unmatched
      { n: 2, block: 902, units: 3_000_000n, input: encodeNtagTransfer(AGENT_ADDRESS, 3_000_000n, "nobody") }, // refused
      { n: 3, block: 903, units: 5_000_000n, input: encodeNtagTransfer(AGENT_ADDRESS, 5_000_000n, "ada") }, // paid
    ],
  });
  await run(w);
  await refundDeposit(key(1), refundDeps(w).deps, { execute: true, yes: true });
  const rows = refundRows({ requests: w.mem.requests, registrations: w.mem.reg, ntagPayments: w.mem.ntag, receipts: w.mem.log }, w.mem.refunds);
  const by = Object.fromEntries(rows.map((r) => [r.key, r]));
  assert.equal(by[key(1)].status, "refunded");
  assert.equal(by[key(2)].status, "refundable");
  assert.equal(by[key(2)].category, "refused");
  assert.equal(by[key(2)].payer, PAYER);
  assert.equal(by[key(3)], undefined, "a paid deposit is never listed");
});

test("auto-refund: refused tag deposits are refunded right away, at most 3 per payer per 24 h; unmatched ones never", async () => {
  const deposits = [1, 2, 3, 4].map((n) => ({ n, block: 900 + n, units: 3_000_000n, input: encodeNtagTransfer(AGENT_ADDRESS, 3_000_000n, "nobody") }));
  deposits.push({ n: 5, block: 905, units: 7_000_000n }); // unmatched
  const w = world({ deposits });
  await run(w, { autoRefund: true });
  assert.deepEqual([1, 2, 3, 4].map((n) => w.mem.refunds[key(n)]?.status), ["refunded", "refunded", "refunded", undefined]);
  assert.ok(w.mem.refunds[key(1)].auto);
  assert.equal(w.mem.refunds[key(5)], undefined, "unmatched deposits are always refunded by hand");
  assert.equal(w.sent.length, 3);
  assert.ok(w.out.some((l) => /already had 3 refunds in 24 hours/.test(l)));
  assert.equal(w.calls.length, 0);
});

test("auto-refund: a failed refund is recorded and alerted, and never stops autopilot", async () => {
  const deposits = [
    { n: 1, block: 901, units: 3_000_000n, input: encodeNtagTransfer(AGENT_ADDRESS, 3_000_000n, "nobody") },
    { n: 2, block: 902, units: 5_000_000n, input: encodeNtagTransfer(AGENT_ADDRESS, 5_000_000n, "ada") },
  ];
  const w = world({ deposits, chain: { failSend: true } });
  await run(w, { autoRefund: true });
  assert.equal(w.mem.refunds[key(1)].status, "failed");
  assert.ok(w.mem.alerts.some((a) => a.kind === "refund_failed"));
  assert.equal(w.calls.length, 1, "autopilot carried on and paid the next deposit");
  assert.equal(w.mem.state.cursor, "1000");
  // a refusal caused by a cap the firm quote broke is auto-refunded too
  const q = world({ deposits: deposits.slice(1) });
  q.io.pay = async () => { throw refusal("Amount 25.3 exceeds the per-payout cap of 25 USD (MAX_USD). Not paid automatically; review it manually."); };
  await run(q, { autoRefund: true });
  assert.equal(q.mem.refunds[key(2)].status, "refunded");
});

test("auto-refund is off without --execute, and a dry run never refunds", async () => {
  const w = world({ deposits: [{ n: 1, block: 901, units: 3_000_000n, input: encodeNtagTransfer(AGENT_ADDRESS, 3_000_000n, "nobody") }] });
  await watch({ execute: false, autoRefund: true, polls: 1, io: w.io });
  assert.equal(w.sent.length, 0);
  assert.deepEqual(w.mem.refunds, {});
  assert.ok(w.out.some((l) => /--auto-refund only works with --execute/.test(l)));
});
