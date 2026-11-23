// Changing or deleting a test in this file needs the owner's written OK. Adding tests is fine.
//
// The money-safety invariants of LokalPay, one test each, against the real functions (pay(), the guards, autopilot, the
// refund flow, the wallet client, the site's resolver). Fakes only (test/fakes.mjs and a fake chain below): nothing
// reaches Celo, Textile or the real state files. contacts.json and receipts.jsonl are temp files set up before the
// modules load, because src/config.mjs reads their paths once.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "np-invariants-"));
const ADA_ADDR = "0x2222222222222222222222222222222222222222";
const OWN_ADDR = "0x7777777777777777777777777777777777777777";
process.env.CONTACTS_FILE = path.join(DIR, "contacts.json");
process.env.RECEIPTS_FILE = path.join(DIR, "receipts.jsonl");
process.env.REFUNDS_FILE = path.join(DIR, "refunds.json");
fs.writeFileSync(process.env.CONTACTS_FILE, JSON.stringify({ contacts: { ada: ADA_ADDR }, own_wallets: [OWN_ADDR] }));

const viem = await import("viem");
const { custom, encodeAbiParameters, encodeEventTopics, erc20Abi, getAddress, parseTransaction, parseUnits } = viem;
const { privateKeyToAccount } = await import("viem/accounts");
const { fromDataSuffix } = await import("@celo/attribution-tags");
const config = await import("../src/config.mjs");
const { AGENT_ADDRESS, ATTRIBUTION_CODE, CELO_TOKEN, IDENTITY_REGISTRY, MAX_DAILY_USD, MAX_SLIPPAGE_BPS, MAX_USD, MAX_WALLET_DAILY_USD, REPUTATION_REGISTRY, TOKENS } = config;
const guards = await import("../src/guards.mjs");
const { pay, payDeps, registrationRecipient, BLOCKED_RECIPIENTS } = await import("../src/pay.mjs");
const { makeClients } = await import("../src/chain.mjs");
const { watch } = await import("../src/watch.mjs");
const { refundDeposit } = await import("../src/refund.mjs");
const { encodeNtagTransfer } = await import("../src/ntags.mjs");
const node = await import("../src/ntags.mjs");
const site = await import("../site/assets/core.js");
const { REG, REG_UNITS, PAYER, h, key, refundDeps, world } = await import("./fakes.mjs");

const USDT = TOKENS.USDT, CNGN = TOKENS.CNGN;
const REACTOR = "0x9999999999999999999999999999999999999999";
const run = (w, opts = {}) => watch({ execute: true, polls: 1, io: w.io, ...opts });

/**
 * A fake chain + Textile for pay() (usdt-cngn to the contact "ada"): records every transaction the wallet sends.
 * opts: { allowance, previewBuy, quoteBuy, takerPays, delta (cNGN balance change), swapTransfer (cNGN the swap's
 * Transfer logs say), tags (codes verifyTx returns) }.
 */
function payWorld(o = {}) {
  const sent = [];
  let cngn = parseUnits("100", 6);
  const amount = parseUnits("10", 6);
  const opts = { allowance: 0n, previewBuy: parseUnits("15000", 6), quoteBuy: parseUnits("15000", 6), takerPays: amount, delta: parseUnits("15000", 6), ...o };
  opts.swapTransfer ??= opts.quoteBuy;
  const receipt = (hash, logs = []) => ({ status: "success", transactionHash: hash, logs });
  const swapLog = {
    address: CNGN.address, topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from: REACTOR, to: AGENT_ADDRESS } }),
    data: encodeAbiParameters([{ type: "uint256" }], [opts.swapTransfer]), logIndex: 1, blockNumber: 5n, transactionHash: h(600),
  };
  const pub = {
    readContract: async ({ address, functionName }) => {
      if (functionName === "decimals") return Object.values(TOKENS).find((t) => t.address === address).decimals;
      if (functionName === "balanceOf") return address === USDT.address ? parseUnits("100", 6) : cngn;
      if (functionName === "allowance") return opts.allowance;
      throw new Error(functionName);
    },
    getBalance: async () => parseUnits("5", 18),
    waitForTransactionReceipt: async ({ hash }) => receipt(hash, hash === h(600) ? [swapLog] : []),
  };
  const wallet = {
    writeContract: async (tx) => { sent.push({ kind: tx.functionName, ...tx }); return h(500 + sent.length); },
    sendTransaction: async (tx) => { sent.push({ kind: "swap", ...tx }); cngn += opts.delta; return h(600); },
  };
  const deps = {
    loadAccount: () => ({ address: AGENT_ADDRESS }),
    makeClients: () => ({ pub, wallet }),
    preview: async () => ({ status: "preview", buyAmount: String(opts.previewBuy), feeAmount: "0" }),
    firmQuote: async () => ({
      rfqId: "q", claimToken: "c", quote: { buyAmount: String(opts.quoteBuy), takerPays: String(opts.takerPays), reactor: REACTOR, expiresAt: new Date(Date.now() + 60_000).toISOString() },
      transactions: { swap: { to: REACTOR, data: "0x1234", value: "0" } },
    }),
    submit: async () => {},
    verifyTx: async () => ({ codes: opts.tags ?? [ATTRIBUTION_CODE] }),
    confirm: async () => { throw new Error("pay() asked for a confirmation in a test"); },
    log: (e) => logged.push(e),
  };
  const logged = [];
  return { sent, deps, logged, opts };
}
/** Runs pay() with the fake world's dependencies, then puts the real ones back. */
async function withPay(w, args) {
  const saved = { ...payDeps };
  Object.assign(payDeps, w.deps);
  const log = console.log;
  console.log = () => {};
  try { return await pay(args); } finally { Object.assign(payDeps, saved); console.log = log; }
}

test("INVARIANT 1: dry run by default: pay(), autopilot and refunds move nothing and write nothing without --execute", async () => {
  const p = payWorld();
  const res = await withPay(p, { to: "ada", amount: "10" });
  assert.equal(res.dryRun, true);
  assert.deepEqual(p.sent, []);
  assert.deepEqual(p.logged, []);
  const w = world({ deposits: [{ n: 1, block: 901, units: REG_UNITS }, { n: 2, block: 902, units: 7_000_000n }], regs: [REG] });
  await watch({ polls: 1, io: w.io });
  assert.equal(w.calls.every((c) => c.execute === false), true, "autopilot's dry run only previews");
  assert.deepEqual([w.mem.reg, w.mem.log, w.mem.saved], [{}, [], []]);
  const r = world({ deposits: [{ n: 1, block: 901, units: 7_000_000n }] });
  await run(r);
  const dry = await refundDeposit(key(1), refundDeps(r).deps);
  assert.equal(dry.dryRun, true);
  assert.deepEqual([r.sent, r.mem.refunds], [[], {}]);
});

test("INVARIANT 2: record before pay: autopilot saves the deposit before pay(), a refund saves 'sending' before the transfer", async () => {
  const w = world({ deposits: [{ n: 1, block: 901, units: REG_UNITS }], regs: [REG] });
  let recorded = null;
  const real = w.io.pay;
  w.io.pay = async (args) => { recorded = w.mem.reg[REG.hash.toLowerCase()]?.deposit; return real(args); };
  await run(w);
  assert.equal(recorded?.tx, h(1001), "the deposit was on disk when the payout started");
  const r = world({ deposits: [{ n: 1, block: 901, units: 7_000_000n }] });
  await run(r);
  let status = null;
  r.wallet.onSend = () => { status = r.mem.refunds[key(1)]?.status; };
  await refundDeposit(key(1), refundDeps(r).deps, { execute: true, yes: true });
  assert.equal(status, "sending");
});

test("INVARIANT 3: exactly once: a rescan never pays twice, a refunded deposit is never paid, a paid one never refunded", async () => {
  const w = world({ deposits: [{ n: 1, block: 901, units: 5_000_000n, input: encodeNtagTransfer(AGENT_ADDRESS, 5_000_000n, "ada") }] });
  await run(w);
  w.mem.state = { cursor: "900" };
  await run(w);
  assert.equal(w.calls.length, 1);
  await assert.rejects(refundDeposit(key(1), refundDeps(w).deps, { execute: true, yes: true }), /PAID/);
  const r = world({ deposits: [{ n: 1, block: 901, units: 3_000_000n, input: encodeNtagTransfer(AGENT_ADDRESS, 3_000_000n, "nobody") }] });
  await run(r);
  await refundDeposit(key(1), refundDeps(r).deps, { execute: true, yes: true });
  r.mem.state = { cursor: "900" };
  r.mem.ntag = {};
  await run(r);
  assert.equal(r.calls.length, 0);
  await assert.rejects(refundDeposit(key(1), refundDeps(r).deps, { execute: true, yes: true }), /already refunded/);
  assert.equal(r.sent.length, 1);
});

test("INVARIANT 4: exact approvals: only takerPays, on the sell token, to the quote's reactor, an old allowance reset to 0 first", async () => {
  const p = payWorld({ allowance: 5n, takerPays: parseUnits("9.95", 6) });
  await withPay(p, { to: "ada", amount: "10", execute: true, yes: true });
  const approvals = p.sent.filter((t) => t.kind === "approve");
  assert.deepEqual(approvals.map((a) => [a.address, a.args[0], a.args[1]]), [
    [USDT.address, REACTOR, 0n], [USDT.address, REACTOR, parseUnits("9.95", 6)],
  ]);
  // enough allowance already: no approval at all
  const q = payWorld({ allowance: parseUnits("50", 6) });
  await withPay(q, { to: "ada", amount: "10", execute: true, yes: true });
  assert.equal(q.sent.filter((t) => t.kind === "approve").length, 0);
});

test("INVARIANT 5: slippage 3%: a firm quote more than 3% under the preview aborts before anything is sent", async () => {
  assert.equal(MAX_SLIPPAGE_BPS, 300);
  assert.doesNotThrow(() => guards.assertSlippage(10_000n, 9_700n, MAX_SLIPPAGE_BPS));
  assert.throws(() => guards.assertSlippage(10_000n, 9_699n, MAX_SLIPPAGE_BPS), /worse than the preview/);
  const p = payWorld({ previewBuy: parseUnits("15000", 6), quoteBuy: parseUnits("14500", 6) });
  await assert.rejects(withPay(p, { to: "ada", amount: "10", execute: true, yes: true }), /worse than the preview/);
  assert.deepEqual(p.sent, []);
});

test("INVARIANT 6: caps: $25 per payment, $25 per wallet per 24 h, $100 per 24 h overall; refunds never count", () => {
  assert.deepEqual([MAX_USD, MAX_WALLET_DAILY_USD, MAX_DAILY_USD], ["25", "25", "100"]);
  assert.doesNotThrow(() => guards.assertWithinCap("25", MAX_USD));
  assert.throws(() => guards.assertWithinCap("25.000001", MAX_USD), /per-payout cap/);
  const now = Date.now();
  const at = new Date(now - 1000).toISOString();
  const entries = [
    { at, usd: "20", hashes: { payout: h(1) }, recipient: ADA_ADDR },
    { at, usd: "75", hashes: { payout: h(2) }, recipient: "0x3333333333333333333333333333333333333333" },
    { at, kind: "refund", usd: "50", hashes: { refund: h(3) }, recipient: ADA_ADDR },
    { at: new Date(now - 25 * 3600_000).toISOString(), usd: "25", hashes: { payout: h(4) }, recipient: ADA_ADDR },
  ];
  const wallet = guards.walletUsedUnits(entries, ADA_ADDR, now);
  assert.equal(wallet, parseUnits("20", 6));
  assert.doesNotThrow(() => guards.assertWalletCap(wallet, parseUnits("5", 6), MAX_WALLET_DAILY_USD));
  assert.throws(() => guards.assertWalletCap(wallet, parseUnits("5.000001", 6), MAX_WALLET_DAILY_USD), /per-wallet cap/);
  const daily = guards.dailyUsedUnits(entries, now);
  assert.equal(daily, parseUnits("95", 6));
  assert.doesNotThrow(() => guards.assertDailyCap(daily, parseUnits("5", 6), MAX_DAILY_USD));
  assert.throws(() => guards.assertDailyCap(daily, parseUnits("5.000001", 6), MAX_DAILY_USD), /daily cap/);
});

test("INVARIANT 7: measured payout: the recipient gets the bought token's balance change, capped at what the swap delivered", async () => {
  // the balance rose more than the swap delivered (a deposit landed at the same moment): pay only the swap's output
  const p = payWorld({ delta: parseUnits("16000", 6), swapTransfer: parseUnits("14990", 6) });
  await withPay(p, { to: "ada", amount: "10", execute: true, yes: true });
  const payout = p.sent.find((t) => t.kind === "transfer");
  assert.deepEqual([payout.address, payout.args[0], payout.args[1]], [CNGN.address, getAddress(ADA_ADDR), parseUnits("14990", 6)]);
  // the balance rose less (a fee): pay only the balance change
  const q = payWorld({ delta: parseUnits("14000", 6) });
  await withPay(q, { to: "ada", amount: "10", execute: true, yes: true });
  assert.equal(q.sent.find((t) => t.kind === "transfer").args[1], parseUnits("14000", 6));
  assert.equal(guards.measuredReceived(-5n, 10n), 0n);
});

test("INVARIANT 8: blocked recipients: the agent, own wallets, token and registry contracts, the zero address, the payer", () => {
  const blocked = [AGENT_ADDRESS, OWN_ADDR, USDT.address, CNGN.address, CELO_TOKEN.address, IDENTITY_REGISTRY, REPUTATION_REGISTRY, "0x0000000000000000000000000000000000000000"];
  for (const t of Object.values(TOKENS)) assert.ok(BLOCKED_RECIPIENTS.includes(t.address), `${t.symbol} is blocked`);
  for (const a of blocked) {
    assert.throws(() => guards.assertRecipient(a, { agent: AGENT_ADDRESS, own: [OWN_ADDR], blocked: BLOCKED_RECIPIENTS }), /blocked/, a);
    assert.throws(() => registrationRecipient(a, { agent: AGENT_ADDRESS, payer: PAYER, own: [OWN_ADDR] }), (e) => e.permanent, a);
  }
  assert.throws(() => registrationRecipient(PAYER, { agent: AGENT_ADDRESS, payer: PAYER }), /self-payment/);
  assert.equal(guards.assertRecipient(ADA_ADDR, { agent: AGENT_ADDRESS, own: [OWN_ADDR], blocked: BLOCKED_RECIPIENTS }), getAddress(ADA_ADDR));
});

test("INVARIANT 9: attribution tag: every transaction the wallet client sends ends with the tag; an untagged one is flagged", async () => {
  const raws = [];
  const transport = custom({
    request: async ({ method, params }) => {
      switch (method) {
        case "eth_chainId": return "0xa4ec";
        case "eth_getTransactionCount": return "0x1";
        case "eth_estimateGas": return "0x5208";
        case "eth_gasPrice": return "0x3b9aca00";
        case "eth_maxPriorityFeePerGas": return "0x1";
        case "eth_feeHistory": return { baseFeePerGas: ["0x1", "0x1"], gasUsedRatio: [0.5], oldestBlock: "0x1", reward: [["0x1"]] };
        case "eth_getBlockByNumber": return { baseFeePerGas: "0x1", number: "0x1", hash: h(1), timestamp: "0x1", transactions: [], gasLimit: "0x1c9c380", gasUsed: "0x0" };
        case "eth_sendRawTransaction": raws.push(params[0]); return h(9000 + raws.length);
        default: throw new Error(`fake RPC: ${method}`);
      }
    },
  });
  const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
  const { wallet } = makeClients(account, transport);
  await wallet.writeContract({ address: USDT.address, abi: erc20Abi, functionName: "transfer", args: [ADA_ADDR, 1n] });
  await wallet.sendTransaction({ to: REACTOR, data: "0x1234", value: 0n });
  assert.equal(raws.length, 2);
  for (const raw of raws) assert.deepEqual(fromDataSuffix(parseTransaction(raw).data).codes, [ATTRIBUTION_CODE]);
  // pay() reads every transaction back and flags one without the tag (exit code 1)
  const p = payWorld({ tags: [] });
  const res = await withPay(p, { to: "ada", amount: "10", execute: true, yes: true });
  assert.deepEqual(res.untagged.sort(), ["approval", "payout", "swap"]);
  assert.equal(process.exitCode, 1);
  process.exitCode = 0;
});

test("INVARIANT 10: the site and the agent resolve LokalPay tags identically (owner, memos, availability, before a deposit)", () => {
  const AGENT = AGENT_ADDRESS;
  const froms = ["0x2222222222222222222222222222222222222222", "0x4444444444444444444444444444444444444444", AGENT];
  const bodies = [{ t: "ada" }, { t: "ada", n: "Ada" }, { t: "bob" }, { t: "" }, { t: "admin" }, { t: "Ada" }, "junk"];
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
  for (let round = 0; round < 200; round++) {
    const ops = Array.from({ length: 1 + rnd(10) }, (_, i) => ({
      hash: "0x" + i.toString(16).padStart(4, "0"), from: froms[rnd(froms.length)], block: 10 + rnd(5), position: rnd(3),
      time: 1_800_000_000 + rnd(40) * 5 * 86400, value: "0", op: bodies[rnd(bodies.length)],
    }));
    const a = node.resolveNtags(ops), b = site.resolveNtags(ops);
    for (const k of ["tags", "byOwner", "locks"]) assert.deepEqual([...a[k]].sort(), [...b[k]].sort(), `round ${round} ${k}`);
    const blk = 10 + rnd(5), pos = rnd(3);
    assert.deepEqual([...node.resolveNtagsBefore(ops, blk, pos).tags].sort(), [...site.resolveNtagsBefore(ops, blk, pos).tags].sort());
  }
  for (const input of [encodeNtagTransfer(AGENT, 1_000_000n, "ada"), site.encodeNtagTransfer(AGENT, 7n, "chidi_ng"), "0x", null]) {
    assert.deepEqual(node.decodeNtagPayment(input), site.decodeNtagPayment(input));
  }
});

test("INVARIANT 11: memo payments are never matched by amount: a tag memo with a registration's exact amount pays the tag", async () => {
  const w = world({ deposits: [{ n: 1, block: 901, units: REG_UNITS, input: encodeNtagTransfer(AGENT_ADDRESS, REG_UNITS, "ada") }], regs: [REG] });
  await run(w);
  assert.deepEqual(w.calls.map((c) => [c.ntag, c.registrationId]), [["ada", undefined]]);
  assert.deepEqual(w.mem.reg, {});
  // an unknown tag with the same amount is refused, never paid to the registration either
  const u = world({ deposits: [{ n: 1, block: 901, units: REG_UNITS, input: encodeNtagTransfer(AGENT_ADDRESS, REG_UNITS, "nobody") }], regs: [REG] });
  await run(u);
  assert.equal(u.calls.length, 0);
  assert.equal(u.mem.ntag[key(1)].status, "refused");
});

test("INVARIANT 12: ambiguous or unmatched deposits are never paid automatically (nor refunded automatically)", async () => {
  const req = { v: 1, id: "r_aaaaaaaa", name: "ada", amount: "5.03", dir: "usdt-cngn", created: (1_700_000_000 - 100) * 1000, exp: (1_700_000_000 + 99_999) * 1000 };
  const w = world({ deposits: [{ n: 1, block: 901, units: REG_UNITS }, { n: 2, block: 902, units: 6_660_000n }], regs: [REG], requests: [req] });
  await run(w, { autoRefund: true });
  assert.equal(w.calls.length, 0);
  assert.deepEqual(w.mem.log.map((e) => e.type), ["ambiguous_deposit", "unmatched_deposit"]);
  assert.deepEqual(w.mem.refunds, {});
  assert.equal(w.sent.length, 0);
});
