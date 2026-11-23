// The site's status-server client (site/assets/ntag-ui.js): it uses the agent's answer only when it is well formed
// (and, for room today, fresh), never lets it raise the room above the chain's, and returns null on 503, network
// errors, malformed answers and off Vercel, so every page keeps its chain estimate.
import test from "node:test";
import assert from "node:assert/strict";
import {
  agentStatus, depositStatus, allowanceFromStatus, globalFromStatus, combineAllowance, allowanceResetAt, statusFresh, statusShapeOk,
  receivedStale, statusFinal, reasonText, paidText, units6Of, STATUS_SOURCE, DAY_MS,
} from "../site/assets/ntag-ui.js";

const h = (n) => "0x" + n.toString(16).padStart(64, "0");
const NOW = Date.parse("2026-11-21T12:00:00Z");
const iso = (ms) => new Date(ms).toISOString();
const ok = (body) => async () => ({ status: 200, json: async () => body });
const answer = (o = {}) => ({ ok: true, source: "agent", updatedAt: iso(NOW - 60_000), global: { usedUsd: 12, roomUsd: 88, capUsd: 100 }, ...o });
const wallet = (used, payouts = []) => ({ usedUsd: used, roomUsd: 25 - used, capUsd: 25, payouts });
const chain = (used, payouts = []) => ({ usedUsd: used, leftUsd: Math.max(0, 25 - used), capUsd: 25, payouts });

test("agentStatus: off Vercel it never calls the server", async () => {
  let called = false;
  assert.equal(await agentStatus({ tx: h(1) }, { fetchImpl: async () => { called = true; } }), null);
  assert.equal(called, false);
});

test("agentStatus: the agent's answer, or null so the page falls back to the chain", async () => {
  const urls = [];
  const spy = async (u) => { urls.push(u); return { status: 200, json: async () => answer() }; };
  assert.equal((await agentStatus({ tx: h(1) }, { force: true, fetchImpl: spy })).global.roomUsd, 88);
  await agentStatus({}, { force: true, fetchImpl: spy });
  await agentStatus({ tag: "ada", recipient: undefined }, { force: true, fetchImpl: spy });
  assert.deepEqual(urls, [`/api/status?tx=${h(1)}`, "/api/status", "/api/status?tag=ada"]);
  const nulls = [
    async () => ({ status: 503, json: async () => ({ ok: false, reason: "unavailable" }) }),
    async () => { throw new TypeError("Failed to fetch"); },
    async () => ({ status: 200, json: async () => { throw new SyntaxError("not json"); } }),
    ok({ ok: true }), ok({ ok: false, reason: "unavailable" }), ok(null), ok("text"),
  ];
  for (const f of nulls) assert.equal(await agentStatus({ tx: h(1) }, { force: true, fetchImpl: f }), null);
});

test("agentStatus: a malformed 200 is null, and malformed events are dropped", async () => {
  const bad = [
    answer({ global: { usedUsd: "12", roomUsd: 88, capUsd: 100 } }),
    answer({ global: { usedUsd: 12, roomUsd: NaN, capUsd: 100 } }),
    answer({ global: null }),
    answer({ events: "nope" }),
    answer({ events: [null] }),
    answer({ wallet: { usedUsd: 1, roomUsd: 24, capUsd: 25, payouts: "x" } }),
    answer({ wallet: { usedUsd: 1, roomUsd: 24, capUsd: 25, payouts: [{ at: 5, usd: 1 }] } }),
    answer({ wallet: { usedUsd: 1, roomUsd: 24 } }),
    answer({ updatedAt: 123 }),
  ];
  for (const b of bad) {
    assert.equal(statusShapeOk(b), false, JSON.stringify(b));
    assert.equal(await agentStatus({}, { force: true, fetchImpl: ok(b) }), null);
  }
  const mixed = await agentStatus({ tx: h(1) }, { force: true, fetchImpl: ok(answer({ events: [
    { depositTx: h(1), status: "paid", at: iso(NOW), id: `${h(1)}:0` }, { depositTx: h(1), status: "toString", at: iso(NOW) }, { depositTx: 5, status: "paid", at: iso(NOW) },
  ] })) });
  assert.equal(mixed.events.length, 1);
});

test("depositStatus: matches the full tx:logIndex id, or kind + tag/registration + amount; never 'toString'", () => {
  const a = answer({ events: [
    { id: `${h(1)}:2`, depositTx: h(1), kind: "ntag", tag: "ada", amount: "10.00", status: "received", at: iso(NOW) },
    { id: `${h(1)}:2`, depositTx: h(1), kind: "ntag", tag: "ada", amount: "10.00", status: "paid", receiptNo: "NP-AAAA-BBBB", at: iso(NOW) },
    { id: `${h(1)}:5`, depositTx: h(1), kind: "ntag", tag: "bob", amount: "3.00", status: "refused", reason: "other", at: iso(NOW) },
    { id: `${h(2)}:0`, depositTx: h(2), kind: "registration", registration: h(30), amount: "7.11", status: "failed", at: iso(NOW) },
    { id: `${h(3)}:0`, depositTx: h(3), status: "toString", at: iso(NOW) },
  ] });
  assert.equal(depositStatus(a, h(1).toUpperCase().replace("0X", "0x"), { logIndex: 2 }).status, "paid");
  assert.equal(depositStatus(a, h(1), { logIndex: 5 }).status, "refused");
  assert.equal(depositStatus(a, h(1), { logIndex: 9 }), null);
  assert.equal(depositStatus(a, h(1), { kind: "ntag", tag: "ada", amount: 10_000_000n }).status, "paid");
  assert.equal(depositStatus(a, h(1), { kind: "ntag", tag: "bob", amount: "3" }).status, "refused");
  assert.equal(depositStatus(a, h(1), { kind: "ntag", tag: "ada", amount: "3" }), null, "another transfer in the same tx");
  assert.equal(depositStatus(a, h(2), { kind: "registration", registration: h(30).toUpperCase().replace("0X", "0x"), amount: "7.11" }).status, "failed");
  assert.equal(depositStatus(a, h(3)), null);
  assert.equal(depositStatus(null, h(1)), null);
  assert.equal(depositStatus(a, "nope"), null);
  assert.equal(statusFinal({ status: "paid" }) && statusFinal({ status: "refused" }), true);
  assert.equal(statusFinal({ status: "received" }) || statusFinal({ status: "failed" }) || statusFinal(null), false);
});

test("received: older than 15 minutes counts as unknown (taking longer than usual)", () => {
  assert.equal(receivedStale({ status: "received", at: iso(NOW - 5 * 60_000) }, NOW), false);
  assert.equal(receivedStale({ status: "received", at: iso(NOW - 16 * 60_000) }, NOW), true);
  assert.equal(receivedStale({ status: "received", at: "garbage" }, NOW), true);
  assert.equal(receivedStale({ status: "paid", at: iso(NOW - 99 * 60_000) }, NOW), false);
});

test("allowanceFromStatus: fresh only, clamped, in the allowanceFrom shape", () => {
  const a = answer({ wallet: wallet(20, [{ at: iso(NOW - 3600_000), usd: 12 }, { at: iso(NOW - 7200_000), usd: 8 }]) });
  const alw = allowanceFromStatus(a, { nowMs: NOW });
  assert.equal(alw.leftUsd, 5);
  assert.equal(alw.globalLeftUsd, 88);
  assert.deepEqual(alw.payouts.map((p) => p.usd), [8, 12], "oldest first");
  assert.equal(allowanceResetAt(alw, 10), NOW - 7200_000 + DAY_MS);
  assert.equal(allowanceFromStatus({ ...a, updatedAt: iso(NOW - 6 * 60_000) }, { nowMs: NOW }), null, "older than 5 minutes: ignored");
  assert.equal(allowanceFromStatus({ ...a, updatedAt: null }, { nowMs: NOW }), null);
  assert.equal(statusFresh(a, NOW), true);
  assert.equal(allowanceFromStatus(answer(), { nowMs: NOW }), null, "no wallet in the answer");
  // a nonsense room from the server is clamped to [0, cap]
  assert.equal(allowanceFromStatus(answer({ wallet: { usedUsd: 0, roomUsd: 1e9, capUsd: 25 } }), { nowMs: NOW }).leftUsd, 25);
  assert.equal(allowanceFromStatus(answer({ wallet: { usedUsd: 40, roomUsd: -15, capUsd: 25 } }), { nowMs: NOW }).leftUsd, 0);
  assert.deepEqual(globalFromStatus(answer({ global: { usedUsd: 0, roomUsd: 500, capUsd: 100 } }), { nowMs: NOW }), { usedUsd: 0, leftUsd: 100, capUsd: 100 });
  assert.equal(globalFromStatus(answer({ updatedAt: iso(NOW - 10 * 60_000) }), { nowMs: NOW }), null);
});

test("combineAllowance: the smaller room wins; 'exact' only when they agree or the agent's is the stricter", () => {
  const server = (used) => allowanceFromStatus(answer({ wallet: wallet(used) }), { nowMs: NOW });
  // a stale-looking server that undercounts (says $25 left) loses to the chain ($5 left), and is not called exact
  const lower = combineAllowance(server(0), chain(20));
  assert.deepEqual([lower.leftUsd, lower.exact, lower.source], [5, false, "chain"]);
  // the server knows of a payout the chain doesn't show yet: stricter, so exact
  const stricter = combineAllowance(server(20), chain(12));
  assert.deepEqual([stricter.leftUsd, stricter.exact, stricter.source], [5, true, "agent"]);
  const agree = combineAllowance(server(10), chain(10.004));
  assert.deepEqual([agree.leftUsd > 14.99, agree.exact], [true, true]);
  // only one side known: never "exact"
  assert.deepEqual([combineAllowance(null, chain(3)).exact, combineAllowance(null, chain(3)).leftUsd], [false, 22]);
  assert.deepEqual([combineAllowance(server(3), null).exact, combineAllowance(server(3), { error: true }).leftUsd], [false, 22]);
  assert.equal(combineAllowance(null, null), null);
  assert.equal(combineAllowance(server(30), chain(0)).leftUsd, 0, "never below 0");
});

test("wording: reasons in plain words, paid amounts, source notes", () => {
  assert.match(reasonText("over_wallet_cap"), /over \$25 in 24 hours/);
  assert.match(reasonText("unknown_tag"), /Nobody held this LokalPay tag/);
  assert.equal(reasonText("made_up"), reasonText("other"));
  assert.equal(reasonText("toString"), reasonText("other"));
  assert.equal(paidText({ paidAmount: "14400", paidToken: "cNGN" }), "₦14,400.00 in cNGN");
  assert.equal(paidText({ paidAmount: "9.5", paidToken: "USDT" }), "9.50 USD₮");
  assert.equal(paidText({}), null);
  assert.equal(units6Of("10.5"), 10_500_000n);
  assert.equal(units6Of("bad"), 0n);
  assert.deepEqual(STATUS_SOURCE, { agent: "Live status from the agent", chain: "Estimated from Celo" });
});
