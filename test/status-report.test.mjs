// Autopilot -> status server reporting (src/status-report.mjs): the outbox (JSON lines + lock), background sending with
// a fake fetch, failure handling (never throws, logs once per streak), partial acceptance, splitting for older servers,
// backfill and startup sync from saved records, the retry event, and the watch hooks.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getAddress } from "viem";
import { AGENT_ADDRESS, TOKENS } from "../src/config.mjs";
import { refusal } from "../src/guards.mjs";
import { encodeNtagTransfer } from "../src/ntags.mjs";
import { watch } from "../src/watch.mjs";
import {
  createStatusReporter, depositEvent, eventsFromRecords, makeStatusReporter, readStatusSecret, reasonCode, isDirectReceipt,
  retryPaidEvent, outboxFiles, LOCK_STALE_MS,
} from "../src/status-report.mjs";
import { checkSignature, validateEvent, validateReport } from "../lib/status.mjs";
import { receiptNo } from "../site/assets/core.js";

const SECRET = "k".repeat(64);
const URL_ = "https://example.test/api/status";
const h = (n) => "0x" + n.toString(16).padStart(64, "0");
const ADA = "0x2222222222222222222222222222222222222222";
const PAYER = "0x4444444444444444444444444444444444444444";
const BOB = "0x5555555555555555555555555555555555555555";
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "np-status-")), "status-outbox.jsonl");
const queued = (file) => outboxFiles(file).readQueue().events;
const ev = (n, o = {}) => depositEvent({
  kind: "ntag", key: `${h(n)}:3`, tag: "ada", recipient: ADA, token: "USDT", amount: "10.00", corridor: "usdt-cngn", payer: PAYER,
  status: "received", at: new Date().toISOString(), ...o,
});
const json = (status, body) => ({ status, json: async () => body });

/**
 * A fake status server that checks every signature like the real one and answers like it (partial acceptance with
 * rejected ids). opts.reply(n, body) can override; opts.old = true answers 400 to a whole batch with any bad event.
 */
function fakeServer({ reply, old = false } = {}) {
  const posts = [];
  const fetchImpl = async (url, init) => {
    const ts = init.headers["x-np-ts"];
    const sigOk = checkSignature(SECRET, ts, init.body, init.headers["x-np-signature"]);
    const body = JSON.parse(init.body);
    posts.push({ url, body, sigOk, init });
    if (!sigOk) return json(401, { ok: false, error: "unauthorized" });
    const custom = reply?.(posts.length, body);
    if (custom) return custom;
    const v = validateReport(body, ts);
    if (old && v.rejected?.length) return json(400, { ok: false, error: "invalid event" });
    return json(200, { ok: true, stored: v.events.length, rejected: v.rejected });
  };
  return { posts, fetchImpl };
}
const reporter = (o = {}) => createStatusReporter({ secret: SECRET, url: URL_, outboxFile: tmp(), say: () => {}, debounceMs: 60_000, ...o });

test("reason codes: refusal messages map to the codes the site explains", () => {
  assert.equal(reasonCode("The payer and the recipient are the same wallet (self-payment). Not paid."), "self_payment");
  assert.equal(reasonCode("This payout (5 USD) would take this wallet's last 24 h total to 30 USD, over the per-wallet cap of 25 USD"), "over_wallet_cap");
  assert.equal(reasonCode("Amount 26 exceeds the per-payout cap of 25 USD (MAX_USD). Not paid automatically"), "over_payment_cap");
  assert.equal(reasonCode("unknown nTag"), "unknown_tag");
  assert.equal(reasonCode(`nTag claim ${h(1)} does not check out onchain (not the agent). Not paid.`), "claim_invalid");
  assert.equal(reasonCode(`Registration ${h(1)} does not check out onchain (x). Not paid.`), "registration_invalid");
  assert.equal(reasonCode("the nTag memo does not match this transfer"), "bad_memo");
  assert.equal(reasonCode("below the nTag minimum of 1"), "below_minimum");
  assert.equal(reasonCode("900 cNGN is worth about 0.6 USD, below the 1 USD minimum for nTag payments. Not paid."), "below_minimum");
  assert.equal(reasonCode("Recipient is blocked (agent, own wallet or contract). Not paid."), "recipient_blocked");
  assert.equal(reasonCode("token not accepted for nTag payments"), "token_not_accepted");
  // the same reasons as written since the rename to Lokal tags (records from before it keep the nTag wording)
  assert.equal(reasonCode("unknown Lokal tag"), "unknown_tag");
  assert.equal(reasonCode("Lokal tag claim not found"), "unknown_tag");
  assert.equal(reasonCode(`Lokal tag claim ${h(1)} does not check out onchain (not the agent). Not paid.`), "claim_invalid");
  assert.equal(reasonCode("the Lokal tag memo does not match this transfer"), "bad_memo");
  assert.equal(reasonCode("the transfer looks like a Lokal tag payment, but its memo is not a valid one"), "bad_memo");
  assert.equal(reasonCode("below the Lokal tag minimum of 1"), "below_minimum");
  assert.equal(reasonCode("token not accepted for Lokal tag payments"), "token_not_accepted");
  assert.equal(reasonCode("something new"), "other");
  const failed = ev(1, { status: "failed" });
  assert.equal(failed.reason, "payout_error");
  assert.equal(validateEvent(failed).error, undefined);
});

test("secret: env first, then the file; missing or short turns reporting off", () => {
  assert.equal(readStatusSecret({ env: { NP_STATUS_SECRET: ` ${SECRET}\n` }, readFile: () => { throw new Error("no"); } }).secret, SECRET);
  assert.equal(readStatusSecret({ env: {}, readFile: () => `${SECRET}\r\n` }).secret, SECRET);
  assert.match(readStatusSecret({ env: {}, readFile: () => { throw new Error("ENOENT"); } }).reason, /no NP_STATUS_SECRET/);
  assert.match(readStatusSecret({ env: { NP_STATUS_SECRET: "short" } }).reason, /shorter/);
  const lines = [];
  const off = makeStatusReporter({ env: {}, say: (m) => lines.push(m), secretFile: path.join(os.tmpdir(), "np-no-such-secret"), outboxFile: tmp() });
  assert.equal(off.enabled, false);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /reporting is off/);
  assert.ok(!lines[0].includes(SECRET));
  assert.equal(makeStatusReporter({ env: { NODE_TEST_CONTEXT: "child", NP_STATUS_SECRET: SECRET } }).enabled, false);
});

test("reporter: queues JSON lines, sends signed batches in the background, then empties the outbox", async () => {
  const file = tmp();
  const srv = fakeServer();
  const r = createStatusReporter({ secret: SECRET, url: URL_, outboxFile: file, fetchImpl: srv.fetchImpl, debounceMs: 5 });
  assert.equal(r.report([ev(1), ev(2, { status: "refused", reason: "unknown nTag", recipient: undefined, tag: "zed" })]), 2);
  assert.equal(fs.readFileSync(file, "utf8").trim().split("\n").length, 2, "one event per line");
  await new Promise((res) => setTimeout(res, 80)); // the debounced background flush
  assert.equal(srv.posts.length, 1);
  assert.ok(srv.posts[0].sigOk);
  assert.equal(srv.posts[0].init.redirect, "error", "never follows a redirect with a signed report");
  assert.equal(srv.posts[0].body.events[1].reason, "unknown_tag");
  assert.equal(queued(file).length, 0);
  assert.equal(outboxFiles(file).readSent()[`${h(1)}:3`], "received");
  assert.ok(!fs.readdirSync(path.dirname(file)).some((f) => f.endsWith(".tmp") || f.endsWith(".lock")));
  await r.close();
});

test("reporter: big queues go in batches of at most 100 events", async () => {
  const srv = fakeServer();
  const r = reporter({ fetchImpl: srv.fetchImpl });
  r.report(Array.from({ length: 250 }, (_, i) => ev(i + 1)));
  assert.deepEqual(await r.flush(), { sent: 250, left: 0 });
  assert.deepEqual(srv.posts.map((p) => p.body.events.length), [100, 100, 50]);
  for (const p of srv.posts) assert.ok(Buffer.byteLength(JSON.stringify(p.body)) < 64 * 1024);
  await r.close();
});

test("reporter: a failing server keeps events queued, logs once per streak, and recovers", async () => {
  let down = true;
  const srv = fakeServer({ reply: () => { if (down) throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } }); } });
  const lines = [];
  const r = reporter({ fetchImpl: srv.fetchImpl, say: (m) => lines.push(m) });
  r.report(ev(1));
  for (let i = 0; i < 3; i++) {
    const out = await r.flush();
    assert.deepEqual([out.left, out.error], [1, "ECONNREFUSED"]);
  }
  assert.equal(lines.filter((l) => /couldn't send/.test(l)).length, 1, "one line per failure streak");
  assert.match(lines[0], /Payouts are not affected/);
  down = false;
  assert.deepEqual(await r.flush(), { sent: 1, left: 0 });
  assert.ok(lines.some((l) => /reporting again/.test(l)));
  await r.close();
});

test("reporter: only a well-formed JSON yes counts (a redirect, a proxy page or an odd 200 keeps the events)", async () => {
  for (const answer of [
    { status: 200, json: async () => { throw new SyntaxError("<html>"); } },
    json(200, { ok: true }), // no stored count
    json(200, { ok: "yes", stored: 1 }),
    json(302, null),
  ]) {
    const r = reporter({ fetchImpl: fakeServer({ reply: () => answer }).fetchImpl });
    r.report(ev(1));
    const out = await r.flush();
    assert.equal(out.left, 1, JSON.stringify(answer));
    assert.equal((await r.ping()).ok, false);
    await r.close({ waitMs: 0 });
  }
  // a fetch that refuses to follow a redirect (redirect: "error") rejects: kept too
  const r = reporter({ fetchImpl: async () => { throw new TypeError("fetch failed: redirect mode is set to error"); } });
  r.report(ev(1));
  assert.equal((await r.flush()).left, 1);
  await r.close({ waitMs: 0 });
});

test("reporter: the server's rejected ids are dropped, the rest of the batch counts as sent", async () => {
  const srv = fakeServer();
  const file = tmp();
  const r = reporter({ fetchImpl: srv.fetchImpl, outboxFile: file });
  const bad = { ...ev(2), at: "yesterday" }; // passes nothing on the server; bypass the client check to simulate drift
  r.report([ev(1), ev(3)]);
  outboxFiles(file).append([bad]);
  assert.deepEqual(await r.flush(), { sent: 2, left: 0 });
  assert.equal(srv.posts.length, 1);
  assert.equal(queued(file).length, 0);
  const sent = outboxFiles(file).readSent();
  assert.deepEqual(Object.keys(sent).sort(), [`${h(1)}:3`, `${h(3)}:3`]);
  await r.close();
});

test("reporter: an older server that 400s a whole batch is split in halves until only the bad event is dropped", async () => {
  const srv = fakeServer({ old: true });
  const file = tmp();
  const lines = [];
  const r = reporter({ fetchImpl: srv.fetchImpl, outboxFile: file, say: (m) => lines.push(m) });
  const events = Array.from({ length: 8 }, (_, i) => ev(i + 1));
  r.report(events);
  outboxFiles(file).append([{ ...ev(99), at: "bad" }]);
  const out = await r.flush();
  assert.deepEqual(out, { sent: 8, left: 0 });
  const stored = srv.posts.filter((p) => p.body.events.every((e) => e.at !== "bad")).flatMap((p) => p.body.events.map((e) => e.id));
  assert.equal(new Set(stored).size, 8, "every good event was stored");
  assert.ok(lines.some((l) => /rejected a report/.test(l)));
  await r.close();
});

test("reporter: never throws (invalid events, unwritable outbox, broken fetch, corrupt lines)", async () => {
  const lines = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "np-status-"));
  // the outbox path is a directory (like a full or read-only disk): queuing is skipped, quietly
  const r = createStatusReporter({ secret: SECRET, url: URL_, outboxFile: dir, fetchImpl: () => { throw new Error("boom"); }, say: (m) => lines.push(m), debounceMs: 60_000 });
  assert.doesNotThrow(() => r.report(ev(1)));
  assert.equal(r.report({ id: "junk" }), 0);
  assert.equal(r.report(null), 0);
  await r.flush();
  await r.close({ waitMs: 0 });
  assert.ok(lines.some((l) => /could not queue/.test(l)));
  // corrupt or unterminated lines are skipped, and a new line is never glued onto them
  const file = tmp();
  fs.writeFileSync(file, '{"half":');
  const srv = fakeServer();
  const c = reporter({ fetchImpl: srv.fetchImpl, outboxFile: file });
  assert.equal(c.report(ev(2)), 1);
  const q = outboxFiles(file).readQueue();
  assert.deepEqual([q.events.length, q.bad], [1, 1]);
  assert.deepEqual(await c.flush(), { sent: 1, left: 0 });
  await c.close();
  // a fetch that throws synchronously
  const d = reporter({ fetchImpl: () => { throw new TypeError("sync"); } });
  d.report(ev(3));
  assert.equal((await d.flush()).left, 1);
  await d.close({ waitMs: 0 });
});

test("outbox: a failed write leaves no temp file and no half line", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "np-status-"));
  const box = outboxFiles(path.join(dir, "status-outbox.jsonl"));
  fs.mkdirSync(box.sentFile); // renaming onto a directory fails, like a full disk would
  assert.throws(() => box.writeSent({ a: "paid" }));
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
});

test("outbox lock: another holder makes queuing wait in memory (never blocking); a stale lock is taken over", async () => {
  const file = tmp();
  const box = outboxFiles(file);
  assert.equal(box.tryLock(), true, "the other process holds the lock");
  const srv = fakeServer();
  const r = reporter({ fetchImpl: srv.fetchImpl, outboxFile: file });
  const t0 = Date.now();
  assert.equal(r.report(ev(1)), 1);
  assert.ok(Date.now() - t0 < 100, "report() returns at once");
  assert.equal(queued(file).length, 0);
  assert.equal(r.pending(), 1, "waiting in memory");
  box.unlock();
  await new Promise((res) => setTimeout(res, 350));
  assert.equal(queued(file).length, 1, "appended once the lock was free");
  // a lock left by a crashed process is taken over once stale
  assert.equal(box.tryLock(), true);
  const old = new Date(Date.now() - LOCK_STALE_MS - 1000);
  fs.utimesSync(box.lockFile, old, old);
  assert.equal(box.tryLock(), true, "stale lock replaced");
  box.unlock();
  assert.deepEqual(await r.flush(), { sent: 1, left: 0 });
  await r.close();
});

test("reporter: sendNow posts at once (CLI); what isn't accepted is queued", async () => {
  const srv = fakeServer();
  const file = tmp();
  const r = reporter({ fetchImpl: srv.fetchImpl, outboxFile: file });
  assert.deepEqual(await r.sendNow([ev(1)]), { sent: 1, queued: 0 });
  assert.equal(queued(file).length, 0);
  assert.equal(outboxFiles(file).readSent()[`${h(1)}:3`], "received");
  const down = reporter({ fetchImpl: async () => json(503, { ok: false, reason: "unavailable" }), outboxFile: file });
  assert.deepEqual(await down.sendNow([ev(2)]), { sent: 0, queued: 1 });
  assert.equal(queued(file).length, 1);
  await r.close({ waitMs: 0 });
  await down.close({ waitMs: 0 });
});

const AT = new Date(Date.now() - 3600_000).toISOString();
const records = () => ({
  requests: [
    { id: "r_a", amount: "5.03", dir: "usdt-cngn", recipient: getAddress(ADA), deposit: { payer: PAYER, tx: h(1), logIndex: 2, at: AT }, paidAt: AT, hashes: { payout: h(11) }, receiptNo: receiptNo(h(11)), paid: "7243.2" },
    { id: "r_b", amount: "14400.07", dir: "cngn-usdt", recipient: ADA, deposit: { payer: PAYER, tx: h(2), logIndex: 0, at: AT } },
    { id: "r_c", amount: "1.00", dir: "usdt-cngn" }, // open: nothing to report
    { id: "r_d", amount: "2.00", dir: "usdt-cngn", recipient: ADA, deposit: { payer: PAYER, tx: h(9), logIndex: 0, at: AT }, error: "Swap reverted" },
  ],
  registrations: {
    [h(30)]: {
      hash: h(30), from: BOB, amount: "7.11", dir: "usdt-cngn", deposit: { payer: PAYER, tx: h(3), logIndex: 1, at: AT }, paidAt: AT,
      hashes: { payout: h(13) }, receiptNo: receiptNo(h(13)), paid: "10000",
      refused: { [`${h(4)}:0`]: { payer: PAYER, tx: h(4), logIndex: 0, at: AT, reason: "The payer and the recipient are the same wallet (self-payment). Not paid.", refusedAt: AT } },
    },
  },
  ntagPayments: {
    [`${h(5)}:3`]: { id: `${h(5)}:3`, tag: "ada", from: ADA, token: "USDT", amount: "3.5", dust: "0.000001", dir: "usdt-cngn", deposit: { payer: PAYER, tx: h(5), logIndex: 3, at: AT }, paidAt: AT, hashes: { payout: h(15) }, receiptNo: receiptNo(h(15)), paid: "5040" },
    [`${h(6)}:1`]: { id: `${h(6)}:1`, tag: "zed", token: "USDT", amount: "2.00", deposit: { payer: PAYER, tx: h(6), logIndex: 1, at: AT }, status: "refused", reason: "unknown nTag", refusedAt: AT },
    [`${h(7)}:1`]: { id: `${h(7)}:1`, tag: null, token: "USDT", amount: "2.00", deposit: { payer: PAYER, tx: h(7), logIndex: 1, at: AT }, status: "refused", reason: "the transfer looks like an nTag payment, but its memo is not a valid one", refusedAt: AT },
  },
  receipts: [
    { at: AT, recipient: ADA, requestId: "r_a", usd: "5.03", hashes: { payout: h(11) } },
    { at: AT, recipient: BOB, registrationId: h(30), usd: "7.11", hashes: { payout: h(13) } },
    { at: AT, recipient: ADA, ntag: "ada", payer: PAYER, usd: "3.5", hashes: { payout: h(15) } },
    { at: AT, recipient: BOB, sold: { token: "USDT", amount: "2" }, paid: { token: "cNGN", amount: "2880" }, usd: "2", hashes: { payout: h(16) } },
    { at: AT, corridor: "celo-cngn", recipient: BOB, sold: { token: "CELO", amount: "20" }, paid: { token: "cNGN", amount: "1500" }, usd: "1.05", hashes: { payout: h(17) } },
  ],
});

test("backfill: every saved record becomes a valid event (failed payouts included)", () => {
  const now = Date.now();
  const events = eventsFromRecords({ ...records(), sinceMs: now - 30 * 86_400_000 });
  for (const e of events) assert.equal(validateEvent(e, now).error, undefined, e.id);
  const by = Object.fromEntries(events.map((e) => [e.id, e]));
  assert.deepEqual([by[`${h(1)}:2`].status, by[`${h(1)}:2`].usd, by[`${h(1)}:2`].recipient], ["paid", 5.03, ADA]);
  assert.deepEqual([by[`${h(2)}:0`].status, by[`${h(2)}:0`].token], ["received", "cNGN"]);
  assert.deepEqual([by[`${h(9)}:0`].status, by[`${h(9)}:0`].reason], ["failed", "payout_error"]);
  assert.equal(by[`${h(3)}:1`].registration, h(30));
  assert.equal(by[`${h(4)}:0`].reason, "self_payment");
  assert.equal(by[`${h(5)}:3`].amount, "3.500001", "nTag deposit amount includes the dust kept back");
  assert.equal(by[`${h(6)}:1`].reason, "unknown_tag");
  assert.deepEqual([by[`${h(7)}:1`].reason, by[`${h(7)}:1`].tag], ["bad_memo", undefined]);
  assert.deepEqual([by[`${h(16)}:direct`].kind, by[`${h(17)}:direct`].token], ["direct", "CELO"]);
  assert.equal(events.length, 10);
  assert.deepEqual(records().receipts.map((e) => isDirectReceipt(e)), [false, false, false, true, true]);
});

test("syncRecords: queues what the server hasn't confirmed, once; a later status is queued again", async () => {
  const srv = fakeServer();
  const file = tmp();
  const r = reporter({ fetchImpl: srv.fetchImpl, outboxFile: file });
  assert.equal(r.syncRecords(records()), 10);
  assert.equal(r.syncRecords(records()), 0, "already queued");
  assert.deepEqual(await r.flush(), { sent: 10, left: 0 });
  assert.equal(r.syncRecords(records()), 0, "already confirmed by the server");
  const later = records();
  Object.assign(later.requests[1], { paidAt: new Date().toISOString(), hashes: { payout: h(12) }, receiptNo: receiptNo(h(12)), paid: "10", usd: "10" });
  assert.equal(r.syncRecords(later), 1, "received -> paid is sent again");
  // records older than the window (48 h by default) are left to status-sync --backfill
  const old = records();
  for (const x of old.requests) if (x.deposit) x.deposit.at = new Date(Date.now() - 72 * 3600_000).toISOString();
  const r2 = reporter({ fetchImpl: srv.fetchImpl });
  assert.equal(r2.syncRecords({ requests: old.requests.filter((x) => !x.paidAt) }), 0);
  await r.close();
  await r2.close({ waitMs: 0 });
});

test("retry: a request paid by `retry` is reported with its recipient from receipts.jsonl", () => {
  const rec = { id: "r_x", name: "ada", amount: "5.03", dir: "usdt-cngn", deposit: { payer: PAYER, tx: h(40), logIndex: 1, at: AT } }; // no recipient saved
  const res = { hashes: { swap: h(41), payout: h(42) }, receiptNo: receiptNo(h(42)), paid: "7243.2", usd: "5.03" };
  const receipts = [{ at: AT, recipient: getAddress(ADA), requestId: "r_x", usd: "5.03", hashes: res.hashes }];
  const e = retryPaidEvent("request", rec, res, receipts);
  assert.equal(validateEvent(e).error, undefined, JSON.stringify(e));
  assert.deepEqual([e.status, e.recipient, e.receiptNo, e.id], ["paid", ADA, receiptNo(h(42)), `${h(40)}:1`]);
  assert.ok(validateEvent(retryPaidEvent("request", rec, res, [])).error, "without any recipient it can't be valid");
  const n = retryPaidEvent("ntag", { tag: "ada", from: ADA, amount: "3.5", dust: "0.000001", dir: "usdt-cngn", deposit: rec.deposit }, res);
  assert.deepEqual([n.amount, n.recipient, validateEvent(n).error], ["3.500001", ADA, undefined]);
  const g = retryPaidEvent("registration", { hash: h(30), from: BOB, amount: "7.11", dir: "cngn-usdt", deposit: rec.deposit }, res);
  assert.deepEqual([g.registration, g.token, validateEvent(g).error], [h(30), "cNGN", undefined]);
});

// ---------- watch hooks ----------
const USDT = TOKENS.USDT.address;
const T0 = 1_790_000_000;
const CLAIM = { hash: h(1), from: ADA, block: 10, position: 0, time: T0 + 10, value: "0", op: { t: "ada" } };
function world({ deposits = [], over = {}, status } = {}) {
  const mem = { requests: [], reg: {}, ntag: {}, state: { cursor: "900" }, log: [] };
  const calls = [];
  const txs = new Map();
  const logs = deposits.map((d) => {
    const hash = h(1000 + d.n);
    txs.set(hash, { from: PAYER, to: USDT, input: d.input, transactionIndex: 1 });
    return { address: USDT, transactionHash: hash, logIndex: 3, blockNumber: BigInt(d.block), transactionIndex: 1, args: { from: PAYER, to: AGENT_ADDRESS, value: d.units } };
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
    loadState: () => clone(mem.state), saveState: (s) => { mem.state = clone(s); },
    loadRequests: () => clone(mem.requests), saveRequests: (l) => { mem.requests = clone(l); },
    loadRegState: () => clone(mem.reg), saveRegState: (s) => { mem.reg = clone(s); },
    loadNtagPayments: () => clone(mem.ntag), saveNtagPayments: (s) => { mem.ntag = clone(s); },
    log: (e) => mem.log.push(e),
    pay: async (args) => {
      calls.push(args);
      const payout = h(8000 + calls.length);
      return { hashes: { swap: h(7000 + calls.length), payout }, receiptNo: receiptNo(payout), receiptUrl: "u", paid: "14400", usd: "10" };
    },
    preflight: async () => ({}),
    discoverRegistrations: async () => [],
    indexedHeight: async () => 1000n,
    loadNtagOpsCache: async () => ({ ops: [CLAIM], head: { block: 999, position: 0 } }),
    refreshNtagOpsCache: async (c) => c,
    verifyRegistrationOnchain: async (_pub, reg) => ({ from: getAddress(reg.from) }),
    verifyNtagOpOnchain: async (_pub, op) => ({ from: getAddress(op.from) }),
    ntagUsdFloor: async () => {},
    readReceipts: () => [],
    makeStatus: () => status,
    print: () => {},
    sleep: async () => {},
    ...over,
  };
  return { io, mem, calls };
}
const fakeStatus = () => {
  const s = { enabled: true, events: [], synced: 0, closed: 0, records: null };
  s.report = (e) => { s.events.push(e); };
  s.syncRecords = (records) => { s.synced++; s.records = records; return 0; };
  s.flush = async () => ({ sent: 0, left: 0 });
  s.close = async () => { s.closed++; };
  return s;
};

test("watch: a paid nTag deposit is reported as received, then paid with its receipt", async () => {
  const status = fakeStatus();
  const w = world({ deposits: [{ n: 1, block: 901, units: 10_000_000n, input: encodeNtagTransfer(AGENT_ADDRESS, 10_000_000n, "ada") }], status });
  await watch({ execute: true, polls: 1, io: w.io });
  assert.equal(w.calls.length, 1);
  assert.deepEqual(status.events.map((e) => e.status), ["received", "paid"]);
  const [rec, paid] = status.events;
  assert.equal(rec.id, `${h(1001)}:3`);
  assert.equal(rec.tag, "ada");
  assert.equal(rec.recipient, ADA);
  assert.equal(rec.payer, PAYER);
  assert.equal(rec.usd, 10);
  assert.equal(paid.receiptNo, receiptNo(h(8001)));
  assert.equal(paid.payoutTx, h(8001));
  assert.equal(paid.paidToken, "cNGN");
  for (const e of status.events) assert.equal(validateEvent(e).error, undefined);
  assert.equal(status.synced, 1);
  assert.deepEqual(Object.keys(status.records).sort(), ["ntagPayments", "receipts", "registrations", "requests"], "all kinds re-checked on start");
  assert.equal(status.closed, 1);
});

test("watch: refusals are reported with a reason code", async () => {
  const status = fakeStatus();
  const deposits = [
    { n: 1, block: 901, units: 3_000_000n, input: encodeNtagTransfer(AGENT_ADDRESS, 3_000_000n, "nobody") },
    { n: 2, block: 902, units: 7_000_000n, input: encodeNtagTransfer(AGENT_ADDRESS, 7_000_000n, "ada") },
  ];
  const w = world({ deposits, status, over: { preflight: async () => { throw refusal("over the per-wallet cap. Not paid automatically; review it manually."); } } });
  await watch({ execute: true, polls: 1, io: w.io });
  assert.deepEqual(status.events.map((e) => [e.status, e.reason, e.tag]), [["refused", "unknown_tag", "nobody"], ["refused", "over_wallet_cap", "ada"]]);
  assert.equal(status.events[0].recipient, undefined);
  assert.equal(status.events[1].recipient, ADA);
  for (const e of status.events) assert.equal(validateEvent(e).error, undefined);
});

test("watch: a reporter that throws never stops or changes a payout; dry runs report nothing", async () => {
  const broken = { enabled: true, report() { throw new Error("disk full"); }, syncRecords() { throw new Error("x"); }, flush: async () => { throw new Error("y"); }, close: async () => { throw new Error("z"); } };
  const deposits = [{ n: 1, block: 901, units: 10_000_000n, input: encodeNtagTransfer(AGENT_ADDRESS, 10_000_000n, "ada") }];
  const w = world({ deposits, status: broken });
  await watch({ execute: true, polls: 1, io: w.io });
  assert.equal(w.calls.length, 1);
  assert.ok(w.mem.ntag[`${h(1001)}:3`].paidAt);
  const status = fakeStatus();
  const dry = world({ deposits, status });
  await watch({ execute: false, polls: 1, io: dry.io });
  assert.equal(status.events.length, 0);
  assert.equal(status.synced, 0);
});

test("watch: a payout error is reported as failed (after received); autopilot still stops as before", async () => {
  const status = fakeStatus();
  const deposits = [{ n: 1, block: 901, units: 10_000_000n, input: encodeNtagTransfer(AGENT_ADDRESS, 10_000_000n, "ada") }];
  const w = world({ deposits, status, over: { pay: async () => { throw new Error("Textile is down"); } } });
  await assert.rejects(watch({ execute: true, polls: 1, io: w.io }), /Payout to @ada failed/);
  assert.deepEqual(status.events.map((e) => [e.status, e.reason]), [["received", undefined], ["failed", "payout_error"]]);
  for (const e of status.events) assert.equal(validateEvent(e).error, undefined);
  assert.equal(w.mem.ntag[`${h(1001)}:3`].error, "Textile is down");
});
