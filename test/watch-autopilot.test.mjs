// Autopilot end to end with a fake chain, in-memory state files and a fake pay(): nothing touches the network or disk.
// Covers the money-safety rules around nTag memos, refusals, failed writes and the nTag list loader.
import test from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, erc20Abi, getAddress } from "viem";
import { AGENT_ADDRESS, TOKENS } from "../src/config.mjs";
import { refusal } from "../src/guards.mjs";
import { encodeNtagTransfer, tagSuffix } from "../src/ntags.mjs";
import { NTAG_BAD_MEMO, watch } from "../src/watch.mjs";

const USDT = TOKENS.USDT.address;
const ADA = "0x2222222222222222222222222222222222222222";
const EVE = "0x5555555555555555555555555555555555555555";
const PAYER = "0x4444444444444444444444444444444444444444";
const SAFE = "0x6666666666666666666666666666666666666666"; // a smart-contract wallet
const T0 = 1_700_000_000;
const h = (n) => "0x" + n.toString(16).padStart(64, "0");
const hex = (s) => Buffer.from(s, "utf8").toString("hex");
const word = (v) => BigInt(v).toString(16).padStart(64, "0");
const transferData = (units) => encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [AGENT_ADDRESS, units] });
/** transfer(agent, units) followed by arbitrary raw bytes (what a broken site or wallet might send). */
const transferWith = (units, tailHex) => "0xa9059cbb" + word(AGENT_ADDRESS) + word(units) + tailHex;

const ADA_CLAIM = { hash: h(1), from: ADA, block: 10, position: 0, time: T0 + 10, value: "0", op: { t: "ada" } };
const REG = { hash: h(2), from: EVE, block: 5, position: 0, time: T0 + 5, req: { a: "5.03", d: "usdt-cngn", e: T0 + 5 + 86400, n: "Eve" } };
const REG_UNITS = 5_030_000n;

/**
 * A fake world. deposits: [{ n, block, units, input, from?, to? }] (one Transfer log each, to the agent, in USDT).
 * Returns { io, mem, calls, out } for watch({ io }).
 */
function world({ deposits = [], requests = [], regs = [], ops = [ADA_CLAIM], cursor = "900", over = {} } = {}) {
  const mem = { requests: structuredClone(requests), reg: {}, ntag: {}, state: { cursor }, log: [], saved: [] };
  const calls = [];
  const out = [];
  const txs = new Map();
  const logs = deposits.map((d) => {
    const hash = h(1000 + d.n);
    const from = d.from ?? PAYER;
    txs.set(hash, { from, to: d.to ?? USDT, input: d.input, transactionIndex: 1 });
    return { address: USDT, transactionHash: hash, logIndex: 3, blockNumber: BigInt(d.block), transactionIndex: 1, args: { from, to: AGENT_ADDRESS, value: d.units } };
  });
  const clone = (x) => structuredClone(x);
  const io = {
    makePub: () => ({
      getBlockNumber: async () => 1000n,
      getLogs: async ({ fromBlock, toBlock }) => logs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock),
      getTransaction: async ({ hash }) => txs.get(hash),
      getBlock: async ({ blockNumber }) => ({ timestamp: BigInt(T0) + BigInt(blockNumber) }),
    }),
    loadAccount: () => ({ address: AGENT_ADDRESS }),
    loadState: () => clone(mem.state),
    saveState: (s) => { mem.state = clone(s); mem.saved.push(s.cursor); },
    loadRequests: () => clone(mem.requests),
    saveRequests: (l) => { mem.requests = clone(l); },
    loadRegState: () => clone(mem.reg),
    saveRegState: (s) => { mem.reg = clone(s); },
    loadNtagPayments: () => clone(mem.ntag),
    saveNtagPayments: (s) => { mem.ntag = clone(s); },
    log: (e) => mem.log.push(e),
    pay: async (args) => {
      calls.push(args);
      return { hashes: { swap: h(7000 + calls.length), payout: h(8000 + calls.length) }, receiptNo: `NP-${calls.length}`, receiptUrl: "u", paid: "1" };
    },
    preflight: async () => ({}),
    discoverRegistrations: async () => regs,
    indexedHeight: async () => 1000n,
    loadNtagOpsCache: async () => ({ ops, head: { block: 999, position: 0 } }),
    refreshNtagOpsCache: async (c) => c,
    verifyRegistrationOnchain: async (_pub, reg) => ({ from: getAddress(reg.from) }),
    verifyNtagOpOnchain: async (_pub, op) => ({ from: getAddress(op.from) }),
    ntagUsdFloor: async () => {},
    print: (s) => out.push(s),
    sleep: async () => {},
    ...over,
  };
  return { io, mem, calls, out };
}

const run = (w, opts = {}) => watch({ execute: true, polls: 1, io: w.io, ...opts });
const key = (n) => `${h(1000 + n)}:3`;

test("malformed or wrapped nTag memos are refused and recorded, never matched to a registration by amount", async () => {
  const memos = [
    transferWith(REG_UNITS, hex("NTP:Ada")), // uppercase
    transferWith(REG_UNITS, hex("NTP:@ada")), // "@" kept
    transferWith(REG_UNITS, hex("NTP:pay")), // reserved
    transferWith(REG_UNITS, hex("NTP:ada\n")), // trailing newline
    transferWith(REG_UNITS, hex("NTP:ada") + "deadbeef"), // non-ERC-8021 junk after the memo
    transferWith(REG_UNITS, "deadbeef"), // extra bytes, no memo at all
    transferWith(REG_UNITS, "00".repeat(40) + "80218021802180218021802180218021"), // a broken ERC-8021 suffix
  ];
  const deposits = memos.map((input, i) => ({ n: i + 1, block: 901 + i, units: REG_UNITS, input }));
  // A smart wallet (execTransaction) whose inner call is a valid nTag transfer: the outer input does not decode.
  const inner = encodeNtagTransfer(AGENT_ADDRESS, REG_UNITS, "ada").slice(2);
  deposits.push({ n: 20, block: 920, units: REG_UNITS, from: SAFE, to: SAFE, input: "0x6a761202" + word(USDT) + word(0) + inner });
  // Control: a plain transfer (with a valid attribution suffix) of the same amount still pays the registration.
  deposits.push({ n: 30, block: 930, units: REG_UNITS, input: transferData(REG_UNITS) + tagSuffix() });
  const w = world({ deposits, regs: [REG] });
  await run(w);
  assert.equal(w.calls.length, 1, "only the plain transfer is paid");
  assert.equal(w.calls[0].registrationId, REG.hash);
  assert.equal(w.mem.reg[REG.hash.toLowerCase()].deposit.tx, h(1030));
  for (const d of deposits.slice(0, -1)) {
    const rec = w.mem.ntag[key(d.n)];
    assert.equal(rec?.status, "refused", `deposit ${d.n} recorded as refused`);
    assert.equal(rec.reason, NTAG_BAD_MEMO);
  }
  assert.equal(w.mem.log.filter((e) => e.type === "refused_deposit").length, deposits.length - 1);
});

test("a valid memo pays the tag owner, never the registration with the same amount", async () => {
  const w = world({ deposits: [{ n: 1, block: 901, units: REG_UNITS, input: encodeNtagTransfer(AGENT_ADDRESS, REG_UNITS, "ada") }], regs: [REG] });
  await run(w);
  assert.equal(w.calls.length, 1);
  assert.equal(w.calls[0].ntag, "ada");
  assert.equal(w.calls[0].recipientAddress, getAddress(ADA));
  assert.ok(w.mem.ntag[key(1)].paidAt);
  assert.deepEqual(w.mem.reg, {});
});

test("a refused nTag deposit is recorded and a later rescan never pays it", async () => {
  const deposits = [{ n: 1, block: 901, units: 7_000_000n, input: encodeNtagTransfer(AGENT_ADDRESS, 7_000_000n, "ada") }];
  const w = world({ deposits, over: { preflight: async () => { throw refusal("over the per-wallet cap. Not paid automatically; review it manually."); } } });
  await run(w);
  const rec = w.mem.ntag[key(1)];
  assert.equal(rec.status, "refused");
  assert.match(rec.reason, /per-wallet cap/);
  assert.equal(rec.from, getAddress(ADA)); // enough to force-pay it later
  assert.equal(rec.claim, ADA_CLAIM.hash);
  // Rescan from before the deposit, with the cap no longer in the way: still not paid.
  w.mem.state = { cursor: "900" };
  w.io.preflight = async () => ({});
  await run(w);
  assert.equal(w.calls.length, 0);
  assert.ok(w.out.some((l) => /already handled \(refused/.test(l)));
});

test("an unknown tag is refused and recorded once (no owner, so it can never be force-paid)", async () => {
  const deposits = [{ n: 1, block: 901, units: 3_000_000n, input: encodeNtagTransfer(AGENT_ADDRESS, 3_000_000n, "nobody") }];
  const w = world({ deposits });
  await run(w);
  assert.equal(w.mem.ntag[key(1)].status, "refused");
  assert.equal(w.mem.ntag[key(1)].reason, "unknown Lokal tag");
  w.mem.state = { cursor: "900" };
  await run(w);
  assert.equal(w.mem.log.filter((e) => e.type === "refused_deposit").length, 1);
});

test("a refused registration deposit is recorded and a later rescan never pays it; the registration stays usable", async () => {
  const deposits = [{ n: 1, block: 901, units: REG_UNITS, input: transferData(REG_UNITS) }];
  const w = world({ deposits, regs: [REG], over: { preflight: async () => { throw refusal("self-payment. Not paid."); } } });
  await run(w);
  const rec = w.mem.reg[REG.hash.toLowerCase()];
  assert.equal(rec.deposit, undefined);
  assert.match(rec.refused[key(1)].reason, /self-payment/);
  w.mem.state = { cursor: "900" };
  w.io.preflight = async () => ({});
  await run(w);
  assert.equal(w.calls.length, 0);
  // A different deposit for the same registration is still paid.
  w.mem.state = { cursor: "900" };
  const w2 = world({ deposits: [...deposits, { n: 2, block: 950, units: REG_UNITS, input: transferData(REG_UNITS) }], regs: [REG] });
  w2.mem.reg = w.mem.reg;
  await run(w2);
  assert.equal(w2.calls.length, 1);
  assert.equal(w2.mem.reg[REG.hash.toLowerCase()].deposit.tx, h(1002));
});

test("a failed save never drops a deposit: it is handled again on the next poll (nTag, request, registration)", async () => {
  const failOnce = (name, w) => {
    const real = w.io[name];
    let failed = false;
    w.io[name] = (...a) => { if (!failed) { failed = true; throw new Error("disk full"); } return real(...a); };
  };
  // nTag: the record-before-pay save fails once.
  const n = world({ deposits: [{ n: 1, block: 901, units: 5_000_000n, input: encodeNtagTransfer(AGENT_ADDRESS, 5_000_000n, "ada") }] });
  failOnce("saveNtagPayments", n);
  await run(n, { polls: 2 });
  assert.equal(n.calls.length, 1);
  assert.ok(n.mem.ntag[key(1)].paidAt);
  assert.ok(n.out.some((l) => /disk full.*Nothing was skipped/.test(l)));
  assert.equal(n.mem.saved[0], "1000", "the cursor only moved after the deposit was handled");

  // A refusal record that fails to save is retried too.
  const r = world({ deposits: [{ n: 1, block: 901, units: 5_000_000n, input: transferWith(5_000_000n, hex("NTP:Ada")) }] });
  failOnce("saveNtagPayments", r);
  await run(r, { polls: 2 });
  assert.equal(r.mem.ntag[key(1)].status, "refused");

  // Request: the record-before-pay save fails once.
  const req = { v: 1, id: "r_test0001", name: "ada", amount: "3.01", dir: "usdt-cngn", created: (T0 - 100) * 1000, exp: (T0 + 99_999) * 1000 };
  const q = world({ deposits: [{ n: 1, block: 901, units: 3_010_000n, input: transferData(3_010_000n) }], requests: [req] });
  failOnce("saveRequests", q);
  await run(q, { polls: 2 });
  assert.equal(q.calls.length, 1);
  assert.ok(q.mem.requests[0].paidAt);

  // Registration: the record-before-pay save fails once.
  const g = world({ deposits: [{ n: 1, block: 901, units: REG_UNITS, input: transferData(REG_UNITS) }], regs: [REG] });
  failOnce("saveRegState", g);
  await run(g, { polls: 2 });
  assert.equal(g.calls.length, 1);
  assert.ok(g.mem.reg[REG.hash.toLowerCase()].paidAt);
});

test("a payout whose 'paid' record can't be saved stops autopilot and says it WAS paid (no retry possible)", async () => {
  const w = world({ deposits: [{ n: 1, block: 901, units: 5_000_000n, input: encodeNtagTransfer(AGENT_ADDRESS, 5_000_000n, "ada") }] });
  let saves = 0;
  const real = w.io.saveNtagPayments;
  w.io.saveNtagPayments = (s) => { if (++saves === 2) throw new Error("disk full"); return real(s); };
  await assert.rejects(run(w), /was PAID .*Do NOT retry/);
  assert.equal(w.calls.length, 1);
  const rec = w.mem.ntag[key(1)];
  assert.ok(rec.deposit && !rec.error && !rec.paidAt); // retry refuses it: "no saved error ... check Celoscan"
});

test("nTag list unavailable: requests before it are paid, the nTag deposit waits, nothing after it is skipped", async () => {
  const reqA = { v: 1, id: "r_aaaaaaaa", name: "ada", amount: "3.01", dir: "usdt-cngn", created: (T0 - 100) * 1000, exp: (T0 + 99_999) * 1000 };
  const reqB = { ...reqA, id: "r_bbbbbbbb", amount: "4.01" };
  const deposits = [
    { n: 1, block: 901, units: 3_010_000n, input: transferData(3_010_000n) },
    { n: 2, block: 902, units: 6_000_000n, input: encodeNtagTransfer(AGENT_ADDRESS, 6_000_000n, "ada") },
    { n: 3, block: 903, units: 4_010_000n, input: transferData(4_010_000n) },
  ];
  let clock = 0;
  let loads = 0;
  const w = world({
    deposits, requests: [reqA, reqB],
    over: {
      now: () => clock,
      loadNtagOpsCache: async () => {
        if (++loads === 1) throw new Error("More than 2000 pages of transactions to the agent; refusing to work from a partial Lokal tag list.");
        return { ops: [ADA_CLAIM], head: { block: 999, position: 0 } };
      },
      sleep: async () => { clock += 10 * 60_000; },
    },
  });
  await run(w, { polls: 1 });
  assert.deepEqual(w.calls.map((c) => c.requestId ?? c.ntag), ["r_aaaaaaaa"]);
  assert.equal(w.mem.state.cursor, "900", "cursor pinned before the waiting nTag deposit");
  assert.ok(w.out.some((l) => /waits: the Lokal tag list is not loaded/.test(l)));
  assert.equal(w.mem.log.filter((e) => e.type === "ntag_held").length, 1);
  assert.equal(w.mem.ntag[key(2)], undefined, "neither paid nor refused");

  // Same process, next polls: the list loads, the nTag deposit and the request after it are paid, in order.
  const w2 = world({ deposits, requests: [reqA, reqB] });
  let loads2 = 0;
  w2.io.loadNtagOpsCache = async () => {
    if (++loads2 === 1) throw new Error("Blockscout HTTP 502");
    return { ops: [ADA_CLAIM], head: { block: 999, position: 0 } };
  };
  let clock2 = 0;
  w2.io.now = () => clock2;
  w2.io.sleep = async () => { clock2 += 10 * 60_000; };
  await run(w2, { polls: 3 });
  assert.deepEqual(w2.calls.map((c) => c.requestId ?? c.ntag), ["r_aaaaaaaa", "ada", "r_bbbbbbbb"]);
  assert.equal(w2.mem.state.cursor, "1000");
});

test("a refresh failure makes nTag deposits above the last good height wait", async () => {
  let indexed = 1000n;
  const deposits = [{ n: 1, block: 1050, units: 5_000_000n, input: encodeNtagTransfer(AGENT_ADDRESS, 5_000_000n, "ada") }];
  const w = world({ deposits, cursor: "1000" });
  w.io.indexedHeight = async () => indexed;
  w.io.makePub = ((mk) => () => ({ ...mk(), getBlockNumber: async () => 1100n }))(w.io.makePub);
  w.io.refreshNtagOpsCache = async () => { throw new Error("Blockscout HTTP 503"); };
  w.io.sleep = async () => { indexed = 1100n; };
  await run(w, { polls: 2 });
  assert.equal(w.calls.length, 0, "deposit above the last good height waits");
  assert.equal(w.mem.state.cursor, "1000");
  assert.ok(w.out.some((l) => /Could not refresh the Lokal tag list/.test(l)));
});

test("a cap broken only by the firm quote is a permanent refusal: recorded, autopilot carries on", async () => {
  const req = { v: 1, id: "r_cccccccc", name: "ada", amount: "3.01", dir: "usdt-cngn", created: (T0 - 100) * 1000, exp: (T0 + 99_999) * 1000 };
  const deposits = [
    { n: 1, block: 901, units: 5_000_000n, input: encodeNtagTransfer(AGENT_ADDRESS, 5_000_000n, "ada") },
    { n: 2, block: 902, units: REG_UNITS, input: transferData(REG_UNITS) },
    { n: 3, block: 903, units: 3_010_000n, input: transferData(3_010_000n) },
  ];
  const w = world({ deposits, regs: [REG], requests: [req] });
  const realPay = w.io.pay;
  w.io.pay = async (args) => {
    if (args.ntag || args.registrationId) throw refusal("Amount 25.3 exceeds the per-payout cap of 25 USD (MAX_USD). Not paid automatically; review it manually.");
    return realPay(args);
  };
  await run(w);
  assert.equal(w.mem.ntag[key(1)].status, "refused");
  assert.match(w.mem.ntag[key(1)].reason, /per-payout cap/);
  const reg = w.mem.reg[REG.hash.toLowerCase()];
  assert.equal(reg.deposit, undefined, "registration deposit un-recorded (nothing was sent)");
  assert.match(reg.refused[key(2)].reason, /per-payout cap/);
  assert.deepEqual(w.calls.map((c) => c.requestId), ["r_cccccccc"], "autopilot carried on to the next deposit");
  assert.equal(w.mem.state.cursor, "1000");

  // Something was sent (hashes): still a stop, never a silent refusal.
  const s = world({ deposits: deposits.slice(0, 1) });
  s.io.pay = async () => { throw Object.assign(refusal("over the cap after the swap"), { hashes: { swap: h(9) } }); };
  await assert.rejects(run(s), /Payout to @ada failed/);
  assert.equal(s.mem.ntag[key(1)].hashes.swap, h(9));
});
