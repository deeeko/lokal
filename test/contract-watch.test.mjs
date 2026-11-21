// Autopilot for payments through the contracts (src/contract-watch.mjs): event decoding, the inner transfer, the
// currency route for every token, and watch() end to end with a fake chain (mocked RPC), fake files and a fake pay().
// Nothing here touches the network or disk.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, erc20Abi, getAddress, parseEventLogs, toEventSelector, toFunctionSelector } from "viem";
import { AGENT_ADDRESS, LEGACY_CUTOVER_BLOCK, LOKAL_POTS, LOKAL_TAGS, LOKAL_TAGS_BLOCK, TOKENS } from "../src/config.mjs";
import { refusal } from "../src/guards.mjs";
import { encodeNtagTransfer, legacyNtagOps } from "../src/ntags.mjs";
import { classifyNtagDeposit, watch } from "../src/watch.mjs";
import { findDepositRecord, planRefund } from "../src/refund.mjs";
import {
  CONTRACT_MIN, POTS_ABI, TAGS_ABI, contractDepositRecords, currencyOfRef, decodeContractLog, innerTransfer, mergeLogs, routeFor, tokenCode,
} from "../src/contract-watch.mjs";
import { currencyOfRef as siteCurrencyOfRef, currencyRef, decodePotPaid, decodeTagPaid, payoutRoute } from "../site/assets/lokal-contracts.js";

const tagsDeployment = JSON.parse(fs.readFileSync(new URL("../contracts/deployments/LokalTags.json", import.meta.url), "utf8"));
const potsDeployment = JSON.parse(fs.readFileSync(new URL("../contracts/deployments/LokalPots.json", import.meta.url), "utf8"));

const USDT = TOKENS.USDT.address;
const CNGN = TOKENS.CNGN.address;
const IDRX = TOKENS.IDRX.address;
const WARS = TOKENS.WARS.address;
const WCOP = TOKENS.WCOP.address;
const ADA = getAddress("0x2222222222222222222222222222222222222222");
const HOST = getAddress("0x3333333333333333333333333333333333333333");
const PAYER = getAddress("0x4444444444444444444444444444444444444444");
const EVE = getAddress("0x5555555555555555555555555555555555555555");
const ZERO = "0x0000000000000000000000000000000000000000";
const B0 = Number(LOKAL_TAGS_BLOCK) + 1000; // payments happen after the deployment
const T0 = 1_790_000_000;
const h = (n) => "0x" + n.toString(16).padStart(64, "0");
const TRANSFER_TOPIC = toEventSelector("Transfer(address,address,uint256)");
const pad = (a) => "0x" + a.toLowerCase().replace(/^0x/, "").padStart(64, "0");

/** The raw log LokalTags emits for TagPaid. */
function tagPaidRaw({ tx, logIndex, block, tag = "ada", recipient = ADA, payer = PAYER, token = USDT, amount = 5_000_000n, ref = h(0) }) {
  const [abiItem] = TAGS_ABI;
  return {
    address: LOKAL_TAGS, transactionHash: tx, logIndex, blockNumber: BigInt(block), transactionIndex: 1,
    topics: encodeEventTopics({ abi: [abiItem], eventName: "TagPaid", args: { tagHash: h(0xabc), recipient, payer } }),
    data: encodeAbiParameters([{ type: "string" }, { type: "address" }, { type: "uint256" }, { type: "bytes32" }, { type: "uint256" }], [tag, token, amount, ref, 20_700n]),
  };
}
function potPaidRaw({ tx, logIndex, block, potId = 3n, host = HOST, payer = PAYER, token = USDT, amount = 2_000_000n }) {
  const [abiItem] = POTS_ABI;
  return {
    address: LOKAL_POTS, transactionHash: tx, logIndex, blockNumber: BigInt(block), transactionIndex: 1,
    topics: encodeEventTopics({ abi: [abiItem], eventName: "PotPaid", args: { potId, host, payer } }),
    data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint256" }], [token, amount, h(0), amount, amount]),
  };
}
const decoded = (raw) => parseEventLogs({ abi: [...TAGS_ABI, ...POTS_ABI], logs: [raw] })[0];
/** A Transfer log as it appears in a receipt. */
const transferRaw = ({ token, from, to, value, logIndex }) => ({ address: token, logIndex, topics: [TRANSFER_TOPIC, pad(from), pad(to)], data: "0x" + BigInt(value).toString(16).padStart(64, "0") });

// ---------- pure ----------

test("the ABI items autopilot uses are the verified ones (contracts/deployments)", () => {
  for (const [mine, dep] of [[TAGS_ABI, tagsDeployment.abi], [POTS_ABI, potsDeployment.abi]]) {
    for (const item of mine) {
      const real = dep.find((x) => x.type === item.type && x.name === item.name);
      assert.ok(real, `${item.name} exists in the deployment ABI`);
      if (item.type === "event") assert.equal(toEventSelector(item), toEventSelector(real), item.name);
      else assert.equal(toFunctionSelector(item), toFunctionSelector(real), item.name);
    }
  }
  assert.equal(tagsDeployment.address, LOKAL_TAGS);
  assert.equal(potsDeployment.address, LOKAL_POTS);
  assert.equal(BigInt(tagsDeployment.deployment.blockNumber), LOKAL_TAGS_BLOCK);
});

test("TagPaid and PotPaid decode the same in the agent (viem) and on the site (core.js codec)", () => {
  const raw = tagPaidRaw({ tx: h(1), logIndex: 7, block: B0, tag: "budi_2", token: IDRX, amount: 9_200_000n });
  const ev = decodeContractLog(decoded(raw));
  assert.deepEqual(
    { kind: ev.kind, key: ev.key, tag: ev.tag, recipient: ev.recipient, payer: ev.payer, token: ev.token, amount: ev.amount, block: ev.block },
    { kind: "tag", key: `${h(1)}:7`, tag: "budi_2", recipient: ADA, payer: PAYER, token: IDRX, amount: 9_200_000n, block: BigInt(B0) },
  );
  const site = decodeTagPaid({ ...raw, blockNumber: "0x" + B0.toString(16) });
  assert.equal(site.tag, "budi_2");
  assert.equal(site.recipient.toLowerCase(), ADA.toLowerCase());
  assert.equal(site.payer.toLowerCase(), PAYER.toLowerCase());
  assert.equal(site.token.toLowerCase(), IDRX.toLowerCase());
  assert.equal(site.amount, 9_200_000n);
  assert.equal(site.logIndex, 7);

  const praw = potPaidRaw({ tx: h(2), logIndex: 4, block: B0, potId: 12n, token: CNGN, amount: 2_882_000_000n });
  const pev = decodeContractLog(decoded(praw));
  assert.equal(pev.kind, "pot");
  assert.equal(pev.potId, 12n);
  assert.equal(pev.recipient, HOST);
  assert.equal(pev.token, CNGN);
  const psite = decodePotPaid(praw);
  assert.equal(psite.potId, 12n);
  assert.equal(psite.recipient.toLowerCase(), HOST.toLowerCase());
  assert.equal(psite.amount, 2_882_000_000n);

  // anything else is not a contract payment
  assert.equal(decodeContractLog({ ...decoded(raw), address: USDT }), null, "a TagPaid-shaped log from another address");
  assert.equal(decodeContractLog({ ...decoded(praw), address: LOKAL_TAGS }), null, "PotPaid only counts from LokalPots");
  assert.equal(decodeTagPaid(praw), null);
  assert.equal(decodePotPaid(raw), null);
});

test("the inner transfer: same token, from the payer, to the agent, exact amount, last one before the event", () => {
  const ev = { tx: h(9), logIndex: 6, token: USDT, payer: PAYER, amount: 5_000_000n };
  const logs = [
    transferRaw({ token: USDT, from: PAYER, to: AGENT_ADDRESS, value: 5_000_000n, logIndex: 1 }), // an earlier identical transfer
    transferRaw({ token: CNGN, from: PAYER, to: AGENT_ADDRESS, value: 5_000_000n, logIndex: 2 }), // other token
    transferRaw({ token: USDT, from: EVE, to: AGENT_ADDRESS, value: 5_000_000n, logIndex: 3 }), // other sender
    transferRaw({ token: USDT, from: PAYER, to: EVE, value: 5_000_000n, logIndex: 4 }), // not to the agent
    transferRaw({ token: USDT, from: PAYER, to: AGENT_ADDRESS, value: 5_000_000n, logIndex: 5 }), // <- the one
    transferRaw({ token: USDT, from: PAYER, to: AGENT_ADDRESS, value: 5_000_000n, logIndex: 8 }), // after the event
  ];
  assert.deepEqual(innerTransfer(ev, logs, AGENT_ADDRESS), { key: `${h(9)}:5`, logIndex: 5 });
  assert.equal(innerTransfer(ev, logs.filter((l) => l.logIndex !== 5 && l.logIndex !== 1), AGENT_ADDRESS), null);
  assert.equal(innerTransfer({ ...ev, amount: 4_999_999n }, logs, AGENT_ADDRESS), null);

  const transfers = [
    { transactionHash: h(9), logIndex: 5, blockNumber: 10n },
    { transactionHash: h(9), logIndex: 8, blockNumber: 10n },
    { transactionHash: h(8), logIndex: 0, blockNumber: 9n },
  ];
  const items = mergeLogs(transfers, [{ ...ev, block: 10n }], new Set([`${h(9)}:5`]));
  assert.deepEqual(items.map((i) => (i.contract ? "event" : `${i.transfer.transactionHash.slice(-1)}:${i.transfer.logIndex}`)), ["8:0", "event", "9:8"]);
});

test("currency route for all five tokens: tags, pots, and the site's payoutRoute agrees on every pair", () => {
  // nothing set: a tag pays USD₮ in naira, cNGN in dollars, a local token as is; a pot pays dollars
  assert.deepEqual(routeFor(USDT, null, "tag"), { mode: "swap", corridor: "usdt-cngn", receive: "cngn" });
  assert.deepEqual(routeFor(CNGN, ZERO, "tag"), { mode: "swap", corridor: "cngn-usdt", receive: "usdt" });
  assert.deepEqual(routeFor(IDRX, null, "tag"), { mode: "forward", receive: "idrx" });
  assert.deepEqual(routeFor(USDT, null, "pot"), { mode: "forward", receive: "usdt" });
  assert.deepEqual(routeFor(CNGN, null, "pot"), { mode: "swap", corridor: "cngn-usdt", receive: "usdt" });
  assert.equal(routeFor(WCOP, null, "pot"), null);
  // a receive token set: USD₮ converts into it, the same token passes through, any other pair is refused
  for (const [tok, code] of [[CNGN, "cngn"], [IDRX, "idrx"], [WARS, "wars"], [WCOP, "wcop"]]) {
    for (const kind of ["tag", "pot"]) {
      assert.deepEqual(routeFor(USDT, tok, kind), { mode: "swap", corridor: `usdt-${code}`, receive: code });
      assert.deepEqual(routeFor(tok, tok, kind), { mode: "forward", receive: code });
    }
  }
  assert.deepEqual(routeFor(USDT, USDT, "tag"), { mode: "forward", receive: "usdt" });
  assert.deepEqual(routeFor(CNGN, USDT, "tag"), { mode: "swap", corridor: "cngn-usdt", receive: "usdt" });
  assert.equal(routeFor(CNGN, IDRX, "tag"), null);
  assert.equal(routeFor(IDRX, USDT, "tag"), null);
  assert.equal(routeFor(EVE, null, "tag"), null, "unknown token");
  assert.equal(routeFor(USDT, EVE, "tag"), null, "unknown receive token");
  assert.deepEqual([USDT, CNGN, IDRX, WARS, WCOP].map(tokenCode), ["usdt", "cngn", "idrx", "wars", "wcop"]);
  // every case, both kinds, with and without a payer's choice: the site shows exactly what the agent does
  const all = [USDT, CNGN, IDRX, WARS, WCOP, EVE];
  for (const paid of all) for (const rt of [null, ZERO, ...all]) for (const kind of ["tag", "pot"]) {
    for (const chosen of [null, "usdt", "cngn", "idrx", "wars", "wcop", "eur"]) {
      assert.deepEqual(payoutRoute(paid, rt, kind, chosen), routeFor(paid, rt, kind, chosen), `${paid} -> ${rt} (${kind}, ${chosen})`);
    }
  }
});

test("the payer's choice travels in the ref ('cur:<code>') and wins over the recipient's default, then naira", () => {
  assert.equal(currencyRef("idrx"), "0x6375723a69647278" + "0".repeat(48));
  for (const code of ["usdt", "cngn", "idrx", "wars", "wcop"]) {
    assert.equal(currencyOfRef(currencyRef(code)), code);
    assert.equal(siteCurrencyOfRef(currencyRef(code)), code);
  }
  for (const bad of [h(0), h(1), "0x" + "63".repeat(32), currencyRef("idrx").slice(0, -2) + "01", "0x6375723a657572" + "0".repeat(50), "0x1234"]) {
    assert.equal(currencyOfRef(bad), null, bad);
    assert.equal(siteCurrencyOfRef(bad), null, bad);
  }
  assert.throws(() => currencyRef("eur"), /unknown currency/);
  // the choice wins over the default; a pot honours it too
  assert.deepEqual(routeFor(USDT, IDRX, "tag", "wars"), { mode: "swap", corridor: "usdt-wars", receive: "wars" });
  assert.deepEqual(routeFor(CNGN, IDRX, "tag", "usdt"), { mode: "swap", corridor: "cngn-usdt", receive: "usdt" });
  assert.deepEqual(routeFor(USDT, null, "pot", "cngn"), { mode: "swap", corridor: "usdt-cngn", receive: "cngn" });
  assert.deepEqual(routeFor(USDT, null, "tag", "usdt"), { mode: "forward", receive: "usdt" });
  assert.equal(routeFor(CNGN, null, "tag", "idrx"), null, "cNGN can only pay out dollars (or cNGN as is)");
  // no choice: the default, then naira
  assert.deepEqual(routeFor(USDT, WCOP, "tag", null), { mode: "swap", corridor: "usdt-wcop", receive: "wcop" });
  assert.deepEqual(routeFor(USDT, null, "tag", null), { mode: "swap", corridor: "usdt-cngn", receive: "cngn" });
});

test("cutover: legacy ops from the cutover block on are ignored; a memo to a tag held on the contract pays its contract owner", () => {
  const c = Number(LEGACY_CUTOVER_BLOCK);
  const ops = [{ block: c - 1, hash: "a" }, { block: c, hash: "b" }, { block: c + 5, hash: "c" }];
  assert.deepEqual(legacyNtagOps(ops).map((o) => o.hash), ["a"]);
  const dep = {
    key: `${h(77)}:2`, tag: "ada", token: USDT, value: 5_000_000n, payer: PAYER, block: c + 10, position: 1,
    tx: { from: PAYER, to: USDT, input: encodeNtagTransfer(AGENT_ADDRESS, 5_000_000n, "ada") },
  };
  const legacyAda = { hash: h(5), from: EVE, block: c - 100, position: 0, time: T0, value: "0", op: { t: "ada" } };
  const viaContract = classifyNtagDeposit(dep, [legacyAda], {}, AGENT_ADDRESS, { owner: ADA.toLowerCase(), name: null, hash: null, source: "contract" });
  assert.equal(viaContract.action, "pay");
  assert.equal(viaContract.entry.owner, ADA.toLowerCase(), "the contract owner wins");
  assert.equal(viaContract.op, null);
  const legacyOnly = classifyNtagDeposit(dep, [legacyAda], {}, AGENT_ADDRESS, null);
  assert.equal(legacyOnly.entry.owner, EVE.toLowerCase(), "not on the contract: the legacy owner keeps being paid");
});

// ---------- watch() end to end with a fake chain ----------

/**
 * A fake world after the deployment. payments: [{ n, block, kind: "tag"|"pot", token, amount, tag?, recipient?, potId?,
 * inner: true (the transfer into the agent is in the receipt and in the scanned Transfer logs) }]. deposits: plain
 * transfers [{ n, block, units, input }].
 */
function world({ payments = [], deposits = [], regs = [], receive = {}, cursor = String(B0 - 1), over = {} } = {}) {
  const mem = { requests: [], reg: {}, ntag: {}, contract: {}, refunds: {}, state: { cursor }, log: [], saved: [], alerts: [] };
  const calls = [];
  const forwards = [];
  const out = [];
  const txs = new Map();
  const receipts = new Map();
  const transferLogs = [];
  const contractLogs = [];
  for (const p of payments) {
    const tx = h(5000 + p.n);
    const token = p.token ?? USDT;
    const amount = p.amount ?? 5_000_000n;
    const raw = p.kind === "pot"
      ? potPaidRaw({ tx, logIndex: 4, block: p.block, potId: p.potId ?? 3n, host: p.recipient ?? HOST, token, amount })
      : tagPaidRaw({ tx, logIndex: 4, block: p.block, tag: p.tag ?? "ada", recipient: p.recipient ?? ADA, token, amount, ref: p.ref ?? h(0) });
    contractLogs.push(decoded(raw));
    const to = p.inner === false ? EVE : AGENT_ADDRESS;
    const inner = transferRaw({ token, from: PAYER, to, value: amount, logIndex: 3 });
    receipts.set(tx, { status: "success", from: PAYER, blockNumber: BigInt(p.block), logs: [inner, raw] });
    txs.set(tx, { from: PAYER, to: p.kind === "pot" ? LOKAL_POTS : LOKAL_TAGS, input: "0x9d5ef760", transactionIndex: 1 });
    if (to === AGENT_ADDRESS && (token === USDT || token === CNGN)) {
      transferLogs.push({ address: token, transactionHash: tx, logIndex: 3, blockNumber: BigInt(p.block), transactionIndex: 1, args: { from: PAYER, to: AGENT_ADDRESS, value: amount } });
    }
  }
  for (const d of deposits) {
    const tx = h(1000 + d.n);
    txs.set(tx, { from: PAYER, to: USDT, input: d.input, transactionIndex: 1 });
    transferLogs.push({ address: USDT, transactionHash: tx, logIndex: 3, blockNumber: BigInt(d.block), transactionIndex: 1, args: { from: PAYER, to: AGENT_ADDRESS, value: d.units } });
  }
  const clone = (x) => structuredClone(x);
  const latest = BigInt(B0 + 4000);
  const inRange = (l, a, b) => BigInt(l.blockNumber) >= BigInt(a) && BigInt(l.blockNumber) <= BigInt(b);
  const io = {
    makePub: () => ({
      getBlockNumber: async () => latest,
      getLogs: async ({ fromBlock, toBlock }) => transferLogs.filter((l) => inRange(l, fromBlock, toBlock)),
      getTransaction: async ({ hash }) => txs.get(hash),
      getTransactionReceipt: async ({ hash }) => receipts.get(hash),
      getBlock: async ({ blockNumber }) => ({ timestamp: BigInt(T0) + BigInt(blockNumber ?? latest) - BigInt(B0) }),
      getBalance: async () => 10n ** 19n,
      readContract: async ({ functionName }) => { if (functionName === "balanceOf") return 10n ** 24n; throw new Error(`fake chain: no ${functionName}`); },
    }),
    getContractLogs: async (_pub, { fromBlock, toBlock }) => contractLogs.filter((l) => inRange(l, fromBlock, toBlock)),
    readReceiveToken: async (_pub, holder) => ({ value: receive[holder] ?? ZERO, latest: false }),
    readTagOfAt: async (_pub, holder) => ({ value: holder === HOST ? "host" : holder === ADA ? "ada" : "", latest: false }),
    readTagInfoAt: async () => ({ value: [ZERO, "", 0n, ZERO, 0n, ZERO], latest: false }),
    readUsdValue: async (_pub, token, amount) => (token === CNGN ? BigInt(amount) / 1441n : BigInt(amount)),
    loadAccount: () => ({ address: AGENT_ADDRESS }),
    loadState: () => clone(mem.state),
    saveState: (s) => { mem.state = clone(s); mem.saved.push(s.cursor); },
    loadRequests: () => clone(mem.requests),
    saveRequests: (l) => { mem.requests = clone(l); },
    loadRegState: () => clone(mem.reg),
    saveRegState: (s) => { mem.reg = clone(s); },
    loadNtagPayments: () => clone(mem.ntag),
    saveNtagPayments: (s) => { mem.ntag = clone(s); },
    loadContractPayments: () => clone(mem.contract),
    saveContractPayments: (s) => { mem.contract = clone(s); },
    log: (e) => mem.log.push({ at: new Date().toISOString(), ...e }),
    readReceipts: () => clone(mem.log),
    loadRefunds: () => clone(mem.refunds),
    saveRefunds: (s) => { mem.refunds = clone(s); },
    makeStatus: () => null,
    makeAlerter: () => ({ enabled: true, channels: ["fake"], alert: (kind, text) => { mem.alerts.push({ kind, text }); return true; }, close: async () => {} }),
    version: () => "0.1.0+test",
    pay: async (args) => {
      calls.push(args);
      return { hashes: { swap: h(7000 + calls.length), payout: h(8000 + calls.length) }, receiptNo: `NP-${calls.length}`, receiptUrl: "u", paid: "1", untagged: [] };
    },
    forward: async (args) => {
      forwards.push(args);
      return { hashes: { payout: h(9000 + forwards.length) }, receiptNo: `NP-F${forwards.length}`, receiptUrl: "u", paid: "2", paidToken: "USDT", untagged: [] };
    },
    forwardPreflight: () => ({}),
    preflight: async () => ({}),
    discoverRegistrations: async () => regs,
    indexedHeight: async () => latest,
    loadNtagOpsCache: async () => ({ ops: [], head: null }),
    refreshNtagOpsCache: async (c) => c,
    verifyRegistrationOnchain: async (_pub, reg) => ({ from: getAddress(reg.from) }),
    verifyNtagOpOnchain: async (_pub, op) => ({ from: getAddress(op.from) }),
    ntagUsdFloor: async () => {},
    print: (s) => out.push(s),
    sleep: async () => {},
    ...over,
  };
  return { io, mem, calls, forwards, out };
}
const run = (w, opts = {}) => watch({ execute: true, polls: 1, io: w.io, ...opts });
const evKey = (n) => `${h(5000 + n)}:4`;

test("TagPaid pays the tag's holder in naira by default, exactly once, recorded before paying", async () => {
  const w = world({ payments: [{ n: 1, block: B0 + 10, kind: "tag", amount: 5_000_000n }] });
  let recordedBeforePay = false;
  const pay = w.io.pay;
  w.io.pay = async (args) => { recordedBeforePay = Boolean(w.mem.contract[evKey(1)]?.deposit) && !w.mem.contract[evKey(1)]?.paidAt; return pay(args); };
  await run(w);
  assert.equal(w.calls.length, 1);
  assert.deepEqual(
    { to: w.calls[0].to, amount: w.calls[0].amount, corridor: w.calls[0].corridor, recipientAddress: w.calls[0].recipientAddress, payer: w.calls[0].payer, ntag: w.calls[0].ntag, execute: w.calls[0].execute, yes: w.calls[0].yes },
    { to: "@ada", amount: "5", corridor: "usdt-cngn", recipientAddress: ADA, payer: PAYER, ntag: "ada", execute: true, yes: true },
  );
  assert.ok(recordedBeforePay, "the payment is on disk before pay() runs");
  const rec = w.mem.contract[evKey(1)];
  assert.ok(rec.paidAt);
  assert.equal(rec.receiptNo, "NP-1");
  assert.equal(rec.dir, "usdt-cngn");
  assert.equal(rec.from, ADA);
  // a rescan from before it (or a second poll) never pays it again
  w.mem.state = { cursor: String(B0 - 1) };
  await run(w, { polls: 2 });
  assert.equal(w.calls.length, 1);
});

test("the transfer into the agent inside a TagPaid transaction is NOT a deposit: never matched to a registration or logged as unmatched", async () => {
  const reg = { hash: h(2), from: EVE, block: B0 - 5, position: 0, time: T0 - 5, req: { a: "5", d: "usdt-cngn", e: T0 + 86400 * 3, n: "Eve" } };
  // same token and the exact amount a live "Get paid" registration asks for
  const w = world({ payments: [{ n: 1, block: B0 + 10, kind: "tag", amount: 5_000_000n }], regs: [reg] });
  await run(w);
  assert.equal(w.calls.length, 1, "paid once, as the tag payment");
  assert.equal(w.calls[0].ntag, "ada");
  assert.equal(w.calls[0].registrationId, undefined);
  assert.deepEqual(w.mem.reg, {}, "the registration was not touched");
  assert.deepEqual(w.mem.ntag, {}, "not treated as a memo deposit either");
  assert.equal(w.mem.log.filter((e) => e.type === "unmatched_deposit").length, 0);
  assert.ok(!w.out.some((l) => /Unmatched deposit/.test(l)));

  // control: the same amount sent as a plain transfer (no contract) still pays the registration
  const plain = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [AGENT_ADDRESS, 5_000_000n] });
  const w2 = world({ deposits: [{ n: 9, block: B0 + 10, units: 5_000_000n, input: plain }], regs: [reg] });
  await run(w2);
  assert.equal(w2.calls.length, 1);
  assert.equal(w2.calls[0].registrationId, reg.hash);
});

test("the receive token decides the currency: rupiah via usdt-idrx; a pot with no preference is passed through in USD₮", async () => {
  const w = world({
    payments: [
      { n: 1, block: B0 + 10, kind: "tag", amount: 7_500_000n },
      { n: 2, block: B0 + 11, kind: "pot", potId: 3n, amount: 2_000_000n },
    ],
    receive: { [ADA]: IDRX },
  });
  await run(w);
  assert.equal(w.calls.length, 1);
  assert.equal(w.calls[0].corridor, "usdt-idrx");
  assert.equal(w.calls[0].amount, "7.5");
  assert.equal(w.forwards.length, 1);
  assert.deepEqual(
    { to: w.forwards[0].to, token: w.forwards[0].token, units: w.forwards[0].units, usdUnits: w.forwards[0].usdUnits, recipientAddress: w.forwards[0].recipientAddress, ntag: w.forwards[0].ntag },
    { to: "pot #3 (@host)", token: USDT, units: 2_000_000n, usdUnits: 2_000_000n, recipientAddress: HOST, ntag: "host" },
  );
  assert.equal(w.mem.contract[evKey(2)].dir, "forward-usdt");
  assert.ok(w.mem.contract[evKey(2)].paidAt);
});

test("the payer's choice in the ref beats the owner's default; an impossible choice is refused, never paid in another currency", async () => {
  const w = world({
    payments: [
      { n: 1, block: B0 + 10, kind: "tag", amount: 6_000_000n, ref: currencyRef("wars") },
      { n: 2, block: B0 + 11, kind: "tag", token: CNGN, amount: 14_410_000_000n, ref: currencyRef("usdt") },
      { n: 3, block: B0 + 12, kind: "tag", token: CNGN, amount: 14_410_000_000n, ref: currencyRef("idrx") },
    ],
    receive: { [ADA]: IDRX },
  });
  await run(w);
  assert.deepEqual(w.calls.map((c) => c.corridor), ["usdt-wars", "cngn-usdt"]);
  assert.equal(w.mem.contract[evKey(1)].chosen, "wars");
  assert.equal(w.mem.contract[evKey(3)].status, "refused");
  assert.match(w.mem.contract[evKey(3)].reason, /token not accepted/);
});

test("the agent's own caps still apply: a refusal is recorded like any other and a rescan never pays it", async () => {
  const w = world({
    payments: [{ n: 1, block: B0 + 10, kind: "tag", amount: 20_000_000n }],
    over: { preflight: async () => { throw refusal("This payout (20 USD) would take this wallet's last 24 h total to 30 USD, over the per-wallet cap of 25 USD (MAX_WALLET_DAILY_USD). Nothing was sent. Not paid automatically; review it manually."); } },
  });
  await run(w);
  assert.equal(w.calls.length, 0);
  const rec = w.mem.contract[evKey(1)];
  assert.equal(rec.status, "refused");
  assert.match(rec.reason, /per-wallet cap/);
  assert.equal(rec.from, ADA);
  assert.equal(w.mem.log.filter((e) => e.type === "refused_deposit").length, 1);
  w.mem.state = { cursor: String(B0 - 1) };
  w.io.preflight = async () => ({});
  await run(w);
  assert.equal(w.calls.length, 0, "still refused after a rescan");
});

test("no route, money that went elsewhere, or a swap under the minimum: refused and recorded, never paid", async () => {
  const w = world({
    payments: [
      { n: 1, block: B0 + 10, kind: "tag", token: CNGN, amount: 14_410_000_000n }, // cNGN to someone who receives rupiah
      { n: 2, block: B0 + 11, kind: "tag", inner: false }, // the payout wallet was not this agent
      { n: 3, block: B0 + 12, kind: "tag", recipient: EVE, tag: "eve", amount: 500_000n }, // $0.50 (only if the contract's limits were lowered)
    ],
    receive: { [ADA]: IDRX },
  });
  await run(w);
  assert.equal(w.calls.length + w.forwards.length, 0);
  assert.match(w.mem.contract[evKey(1)].reason, /token not accepted/);
  assert.match(w.mem.contract[evKey(2)].reason, /did not reach this agent/);
  assert.match(w.mem.contract[evKey(3)].reason, new RegExp(`minimum of ${CONTRACT_MIN.USDT}`));
  for (const n of [1, 2, 3]) assert.equal(w.mem.contract[evKey(n)].status, "refused");
});

test("a pre-flight that can pass later (no price) stops autopilot before the payment: nothing recorded, cursor pinned", async () => {
  const w = world({
    payments: [{ n: 1, block: B0 + 10, kind: "tag" }],
    over: { preflight: async () => { throw new Error("No indicative price right now (no_quote)."); } },
  });
  await assert.rejects(run(w), /Pre-flight failed for the contract payment to @ada.*rescans from block/s);
  assert.equal(w.calls.length, 0);
  assert.deepEqual(w.mem.contract, {});
  assert.equal(w.mem.state.cursor, String(B0 - 1), "cursor pinned before the payment");
});

test("a payout error after recording stops autopilot and keeps the record (never paid twice)", async () => {
  const w = world({
    payments: [{ n: 1, block: B0 + 10, kind: "tag" }],
    over: { pay: async () => { throw Object.assign(new Error("Swap reverted"), { hashes: { swap: h(1) } }); } },
  });
  await assert.rejects(run(w), /Payout for the contract payment to @ada through LokalTags failed/);
  const rec = w.mem.contract[evKey(1)];
  assert.ok(rec.deposit && rec.error && !rec.paidAt);
  w.io.pay = async () => { throw new Error("must not be called"); };
  await run(w); // already recorded: skipped
});

test("dry run: nothing is recorded, the would-be payout is previewed once per run", async () => {
  const w = world({ payments: [{ n: 1, block: B0 + 10, kind: "tag" }] });
  // a dry run starts at the latest block unless an open request reaches back: one created ~4,500 s ago does
  w.mem.requests = [{ v: 1, id: "r_dddddddd", name: "ada", amount: "9.99", dir: "usdt-cngn", created: Date.now() - 4_500_000, exp: Date.now() + 86_400_000 }];
  await watch({ execute: false, polls: 2, io: w.io });
  assert.equal(w.calls.length, 1);
  assert.equal(w.calls[0].execute, false);
  assert.deepEqual(w.mem.contract, {});
});

test("contract payments and plain deposits are handled in chain order in one pass", async () => {
  const reqA = { v: 1, id: "r_aaaaaaaa", name: "ada", amount: "3.01", dir: "usdt-cngn", created: (T0 - 100) * 1000, exp: (T0 + 99_999) * 1000 };
  const plain = (u) => encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [AGENT_ADDRESS, u] });
  const w = world({
    payments: [{ n: 1, block: B0 + 20, kind: "tag" }],
    deposits: [{ n: 1, block: B0 + 10, units: 3_010_000n, input: plain(3_010_000n) }, { n: 2, block: B0 + 30, units: 3_010_000n, input: plain(3_010_000n) }],
  });
  w.mem.requests = [reqA];
  await run(w);
  assert.deepEqual(w.calls.map((c) => c.requestId ?? c.ntag), ["r_aaaaaaaa", "ada"], "request, then the tag payment; the second deposit finds the request used");
});

test("a refused contract payment is refundable to the PAYER from its inner transfer; a paid one never is; a refund record stops the payout", async () => {
  const w = world({
    payments: [{ n: 1, block: B0 + 10, kind: "tag", amount: 20_000_000n }, { n: 2, block: B0 + 11, kind: "tag", amount: 5_000_000n }],
    over: { preflight: async (a) => { if (a.amount === "20") throw refusal("Amount 20 exceeds the per-payout cap of 10 USD (MAX_USD). Not paid automatically; review it manually."); return {}; } },
  });
  await run(w);
  const refused = w.mem.contract[evKey(1)];
  const paid = w.mem.contract[evKey(2)];
  assert.equal(refused.status, "refused");
  assert.equal(refused.depositKey, `${h(5001)}:3`, "the inner Transfer's tx:logIndex");
  assert.equal(refused.deposit.logIndex, 3);
  assert.equal(refused.deposit.eventLogIndex, 4);
  assert.ok(w.mem.alerts.some((a) => a.kind === "deposit_refused" && a.text.includes(`refund --deposit ${h(5001)}:3`)));
  const deposits = contractDepositRecords(w.mem.contract);
  const one = findDepositRecord({ key: `${h(5001)}:3`, tx: h(5001), logIndex: 3 }, { ntagPayments: deposits });
  assert.equal(one.payout, null);
  assert.equal(one.refundable.category, "refused");
  assert.equal(one.refundable.payer, PAYER);
  const two = findDepositRecord({ key: `${h(5002)}:3`, tx: h(5002), logIndex: 3 }, { ntagPayments: deposits });
  assert.ok(two.payout?.paid, "a paid contract payment is never refunded");
  // the plan reads the deposit back from the chain: back to the payer, never to the contract
  const plan = await planRefund(`${h(5001)}:3`, {
    pub: w.io.makePub(), agent: AGENT_ADDRESS, own: [], contracts: [LOKAL_TAGS, LOKAL_POTS], preview: async () => null, now: () => Date.now(),
    loadRecords: () => ({ requests: [], registrations: {}, ntagPayments: deposits, receipts: [], refunds: {} }),
  });
  assert.equal(plan.payer, PAYER);
  assert.equal(plan.value, 20_000_000n);
  assert.equal(plan.token.symbol, "USDT");
  await assert.rejects(planRefund(`${h(5001)}:4`, {
    pub: w.io.makePub(), agent: AGENT_ADDRESS, own: [], contracts: [], preview: async () => null,
    loadRecords: () => ({ requests: [], registrations: {}, ntagPayments: deposits, receipts: [], refunds: {} }),
  }), /no refusal/, "the event's own key is not a deposit");

  // a payment whose deposit already has a refund record is never paid
  const w2 = world({ payments: [{ n: 3, block: B0 + 12, kind: "tag" }] });
  w2.mem.refunds = { [`${h(5003)}:3`]: { id: `${h(5003)}:3`, status: "refunded" } };
  await run(w2);
  assert.equal(w2.calls.length, 0);
  assert.deepEqual(w2.mem.contract, {});
});
