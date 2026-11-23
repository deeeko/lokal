// The status server's "refunded" status and the agent heartbeat (lib/status.mjs, api/status.js, src/status-report.mjs):
// strict checks, every merge pair, the RF- refund number next to the frozen NP- formula, the signed heartbeat end to end
// (store, throttle, replay, GET ?agent=1) and the reporter's signing and health. In-memory stores and a fake fetch only.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeHandler, StaleWriteError, AGENT_WRITE_MS } from "../api/status.js";
import {
  RANK, STATUSES, agentView, checkSignature, isConflict, mergeEvents, parseStatusQuery, refundNo, signReport, validateEvent, validateHeartbeat,
} from "../lib/status.mjs";
import { receiptNo } from "../site/assets/core.js";
import { createStatusReporter, eventsFromRecords, refundEvent } from "../src/status-report.mjs";

const SECRET = "s".repeat(64);
const NOW = Date.parse("2026-11-21T12:00:00Z");
const NOW_S = Math.floor(NOW / 1000);
const h = (n) => "0x" + n.toString(16).padStart(64, "0");
const A = (n) => "0x" + String(n).repeat(40).slice(0, 40);
const iso = (ms) => new Date(ms).toISOString();
const ADA = A(2), PAYER = A(4);

const base = (o = {}) => ({ id: `${h(1)}:3`, kind: "ntag", tag: "ada", recipient: ADA, token: "USDT", amount: "10.00", usd: 10, depositTx: h(1), payer: PAYER, at: iso(NOW - 60_000), ...o });
const of = (status, o = {}) => {
  if (status === "paid") return base({ status, payoutTx: h(9001), receiptNo: receiptNo(h(9001)), paidAmount: "15000", paidToken: "cNGN", ...o });
  if (status === "refunded") return base({ status, refundTx: h(7001), refundNo: refundNo(h(7001)), ...o });
  if (status === "refused") return base({ status, reason: "unknown_tag", ...o });
  if (status === "failed") return base({ status, reason: "payout_error", ...o });
  return base({ status, ...o });
};
const hb = (o = {}) => ({
  at: iso(NOW), cursorBlock: "1000", chainHead: "1002", lagBlocks: 2, celoBalance: "10.5", lowGas: false, version: "0.1.0+abc1234", autoRefund: false, ...o,
});

test("refund numbers: RF- + the first 8 hex characters of the refund tx; the NP- receipt formula is unchanged", () => {
  assert.equal(refundNo("0x7f3a91c2" + "0".repeat(56)), "RF-7F3A-91C2");
  assert.equal(receiptNo("0x7f3a91c2" + "0".repeat(56)), "NP-7F3A-91C2");
});

test("refunded events: refundTx required and checked, refundNo must match, no payout fields; 'deposit' kind only for refunds", () => {
  assert.equal(validateEvent(of("refunded"), NOW).error, undefined);
  assert.equal(validateEvent(of("refunded", { refundNo: undefined }), NOW).error, undefined, "refundNo is optional");
  assert.equal(validateEvent(of("refunded", { recipient: undefined }), NOW).error, undefined, "an unknown tag has no owner");
  assert.equal(validateEvent(of("refunded", { kind: "deposit", tag: undefined, recipient: undefined }), NOW).error, undefined);
  const bad = [
    [of("refunded", { refundTx: undefined }), "bad refundTx"], [of("refunded", { refundTx: "0x12" }), "bad refundTx"],
    [of("refunded", { refundNo: "RF-1111-1111" }), "bad refundNo"], [of("refunded", { refundNo: receiptNo(h(7001)) }), "bad refundNo"],
    [of("refunded", { payoutTx: h(9) }), "not paid"], [of("refunded", { reason: "unknown_tag" }), "bad reason"],
    [of("paid", { refundTx: h(7001) }), "not refunded"], [of("refused", { refundTx: h(7001) }), "not refunded"],
    [of("refused", { kind: "deposit", tag: undefined }), "bad kind"], [of("received", { kind: "deposit", tag: undefined }), "bad kind"],
  ];
  for (const [e, err] of bad) assert.equal(validateEvent(e, NOW).error, err, JSON.stringify(e));
  // a refund goes back in the deposit's own token: any token LokalPay knows, but only for refunds
  assert.equal(validateEvent(of("refunded", { token: "IDRX", kind: "deposit", tag: undefined, recipient: undefined }), NOW).error, undefined);
  assert.equal(validateEvent(of("received", { token: "DOGE" }), NOW).error, "bad token");
  assert.equal(validateEvent(of("received", { token: "IDRX" }), NOW).error, undefined); // contract payments can arrive in a local token
});

test("merge: every pair of statuses; refunded beats received/failed/refused, nothing beats paid, paid + refunded never merge", () => {
  assert.deepEqual(STATUSES, ["received", "failed", "refused", "refunded", "paid"]);
  for (const cur of STATUSES) {
    for (const inc of STATUSES) {
      const conflicts = [];
      const summary = { deposits: { [`${h(1)}:3`]: of(cur, { at: iso(NOW - 120_000) }) } };
      const n = mergeEvents(summary, [of(inc, { at: iso(NOW - 60_000) })], (a, b) => conflicts.push([a.status, b.status]));
      const now = summary.deposits[`${h(1)}:3`].status;
      if (isConflict(cur, inc)) {
        assert.deepEqual([n, now, conflicts.length], [0, cur, 1], `${cur} + ${inc}: a conflict, logged, not merged`);
      } else if (RANK[inc] >= RANK[cur]) {
        assert.deepEqual([n, now], [1, inc], `${cur} + ${inc}`);
      } else {
        assert.deepEqual([n, now, conflicts.length], [0, cur, 0], `${cur} + ${inc}: a status never goes back`);
      }
    }
  }
  assert.ok(RANK.refunded > RANK.refused && RANK.refunded > RANK.failed && RANK.refunded > RANK.received && RANK.paid > RANK.refunded);
});

test("the agent's refunded event from a refunds.json record, and backfill includes it", () => {
  const rec = {
    id: `${h(1)}:3`, status: "refunded", payer: PAYER, token: "USDT", amount: "7", usd: "7", refundTx: h(7001), refundedAt: iso(Date.now() - 1000),
    source: { kind: "ntag", tag: "zed" },
  };
  const ev = refundEvent(rec);
  assert.equal(validateEvent(ev).error, undefined);
  assert.deepEqual([ev.kind, ev.tag, ev.status, ev.refundNo, ev.usd], ["ntag", "zed", "refunded", refundNo(h(7001)), 7]);
  const reg = refundEvent({ ...rec, source: { kind: "registration", registration: h(50), recipient: ADA } });
  assert.equal(validateEvent(reg).error, undefined);
  assert.equal(reg.registration, h(50));
  const dep = refundEvent({ ...rec, token: "cNGN", amount: "15000", usd: "10", source: { kind: "deposit" } });
  assert.deepEqual([dep.kind, dep.usd, validateEvent(dep).error], ["deposit", 10, undefined]);
  assert.equal(refundEvent({ ...rec, refundTx: undefined }), null);
  const events = eventsFromRecords({ refunds: { a: rec, b: { ...rec, id: `${h(2)}:1`, status: "failed" } } });
  assert.deepEqual(events.map((e) => [e.id, e.status]), [[`${h(1)}:3`, "refunded"]]);
});

test("heartbeat validation: every field required and typed, nothing extra, its clock near the signed one", () => {
  const ok = { v: 1, ts: NOW_S, heartbeat: hb() };
  assert.deepEqual(validateHeartbeat(ok, NOW_S).heartbeat, hb());
  assert.equal(validateHeartbeat({ ...ok, heartbeat: hb({ cursorBlock: null, chainHead: null, lagBlocks: null, celoBalance: null }) }, NOW_S).error, undefined);
  const bad = [
    [{ ...ok, events: [] }, "invalid body"], [{ ...ok, ts: NOW_S + 1 }, "invalid body"], [{ ...ok, heartbeat: [] }, "invalid heartbeat"],
    [{ ...ok, heartbeat: { ...hb(), extra: 1 } }, "unknown field"], [{ ...ok, heartbeat: { ...hb(), version: undefined } }, "missing version"],
    [{ ...ok, heartbeat: hb({ at: iso(NOW + 61_000) }) }, "bad at"], [{ ...ok, heartbeat: hb({ cursorBlock: 1000 }) }, "bad cursorBlock"],
    [{ ...ok, heartbeat: hb({ lagBlocks: -1 }) }, "bad lagBlocks"], [{ ...ok, heartbeat: hb({ celoBalance: "1e3" }) }, "bad celoBalance"],
    [{ ...ok, heartbeat: hb({ lowGas: "no" }) }, "bad lowGas"], [{ ...ok, heartbeat: hb({ version: "<script>" }) }, "bad version"],
    [{ ...ok, heartbeat: hb({ autoRefund: 1 }) }, "bad autoRefund"],
  ];
  for (const [body, err] of bad) {
    const b = JSON.parse(JSON.stringify(body));
    assert.equal(validateHeartbeat(b, String(NOW_S)).error, err, err);
  }
  assert.deepEqual(parseStatusQuery({ agent: "1" }), { by: "agent", value: null });
  for (const q of [{ agent: "0" }, { agent: "1", tx: h(1) }, { agent: ["1", "1"] }]) assert.equal(parseStatusQuery(q), null);
  assert.deepEqual(agentView(null), { ok: true, source: "agent", agent: null });
});

/** In-memory stand-ins for the two blobs: the deposit summary (ETags) and the agent heartbeat (overwrite). */
function stores() {
  const summary = { data: null, etag: 0, reads: 0, writes: 0 };
  summary.read = async () => { summary.reads++; return summary.data == null ? null : { data: structuredClone(summary.data), etag: String(summary.etag) }; };
  summary.write = async (d, etag) => {
    if (summary.data != null && etag !== String(summary.etag)) throw new StaleWriteError("changed");
    summary.writes++; summary.data = structuredClone(d); summary.etag++;
  };
  const agent = { data: null, reads: 0, writes: 0 };
  agent.read = async () => { agent.reads++; return agent.data == null ? null : { data: structuredClone(agent.data), etag: "x" }; };
  agent.replace = async (d) => { agent.writes++; agent.data = structuredClone(d); };
  return { summary, agent };
}
const signedHb = (heartbeat, { ts, secret = SECRET } = {}) => {
  const t = ts ?? Math.floor(Date.parse(heartbeat.at) / 1000);
  const raw = JSON.stringify({ v: 1, ts: t, heartbeat });
  return { method: "POST", rawBody: raw, headers: { "content-type": "application/json", "x-np-ts": String(t), "x-np-signature": signReport(secret, t, raw) } };
};
const mkRes = () => {
  const r = { code: 0, headers: {}, body: null };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  return r;
};

test("handler: a signed heartbeat is stored apart from the deposits, throttled, replays refused, and GET ?agent=1 shows it", async () => {
  const { summary, agent } = stores();
  const clock = { t: NOW };
  const handler = makeHandler({ store: summary, agentStore: agent, env: () => ({ secret: SECRET, hasBlob: true }), now: () => clock.t });
  const call = async (req) => { const res = mkRes(); await handler(req, res); return res; };

  const r1 = await call(signedHb(hb()));
  assert.deepEqual([r1.code, r1.body], [200, { ok: true, stored: 1 }]);
  assert.equal(agent.writes, 1);
  assert.deepEqual([summary.reads, summary.writes], [0, 0], "never touches the deposit records");

  const g = await call({ method: "GET", query: { agent: "1" } });
  assert.equal(g.code, 200);
  assert.deepEqual(Object.keys(g.body.agent).sort(), ["ageSec", "at", "autoRefund", "celoBalance", "chainHead", "cursorBlock", "lagBlocks", "lastSeen", "lowGas", "version"]);
  assert.equal(g.body.agent.lastSeen, iso(NOW));
  assert.equal(g.body.agent.ageSec, 0);
  assert.equal(g.headers["Cache-Control"], "public, s-maxage=10, stale-while-revalidate=30");

  // a minute later, nothing changed: answered, not written (saves blob writes)
  clock.t += 60_000;
  const r2 = await call(signedHb(hb({ at: iso(clock.t) })));
  assert.deepEqual([r2.code, r2.body], [200, { ok: true, stored: 0 }]);
  assert.equal(agent.writes, 1);
  // lowGas flips: written at once
  clock.t += 60_000;
  assert.equal((await call(signedHb(hb({ at: iso(clock.t), lowGas: true })))).body.stored, 1);
  // the stored one gets old: written again
  clock.t += AGENT_WRITE_MS;
  assert.equal((await call(signedHb(hb({ at: iso(clock.t), lowGas: true })))).body.stored, 1);
  assert.equal(agent.writes, 3);

  // a replay of an older heartbeat is refused, even after a restart of the server (it reads what is stored)
  const old = signedHb(hb({ at: iso(NOW + 60_000) }), { ts: Math.floor(clock.t / 1000) });
  old.rawBody = JSON.stringify({ v: 1, ts: Math.floor(clock.t / 1000), heartbeat: hb({ at: iso(clock.t - 30_000) }) });
  old.headers["x-np-signature"] = signReport(SECRET, Math.floor(clock.t / 1000), old.rawBody);
  assert.equal((await call(old)).code, 409);
  const fresh = makeHandler({ store: summary, agentStore: agent, env: () => ({ secret: SECRET, hasBlob: true }), now: () => clock.t });
  const res = mkRes(); await fresh(old, res);
  assert.deepEqual([res.code, res.body], [409, { ok: false, error: "old heartbeat" }]);

  // unsigned, badly signed or invalid heartbeats store nothing
  const bad = signedHb(hb({ at: iso(clock.t + 1000) }), { secret: "x".repeat(64) });
  assert.equal((await call(bad)).code, 401);
  assert.equal((await call(signedHb({ ...hb({ at: iso(clock.t + 1000) }), extra: 1 }))).code, 400);
  assert.equal(agent.writes, 3);

  // without storage: 503 like the rest of the status server
  const none = makeHandler({ env: () => ({ secret: SECRET, hasBlob: false }), now: () => NOW });
  const r503 = mkRes(); await none({ method: "GET", query: { agent: "1" } }, r503);
  assert.equal(r503.code, 503);
  // nothing stored yet: agent null
  const empty = makeHandler({ store: stores().summary, agentStore: stores().agent, env: () => ({ secret: SECRET, hasBlob: true }), now: () => NOW });
  const re = mkRes(); await empty({ method: "GET", query: { agent: "1" } }, re);
  assert.deepEqual([re.code, re.body.agent], [200, null]);
});

test("reporter: heartbeats are signed like reports, never queued; health tracks how long the server has been failing", async () => {
  const posts = [];
  let up = true;
  let clock = NOW;
  const fetchImpl = async (url, init) => {
    posts.push({ ts: init.headers["x-np-ts"], body: init.body, sigOk: checkSignature(SECRET, init.headers["x-np-ts"], init.body, init.headers["x-np-signature"], Math.floor(clock / 1000)) });
    return up ? { status: 200, json: async () => ({ ok: true, stored: 1 }) } : { status: 503, json: async () => ({ ok: false }) };
  };
  const outboxFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "np-hb-")), "status-outbox.jsonl");
  const rep = createStatusReporter({ secret: SECRET, url: "https://example.test/api/status", outboxFile, fetchImpl, now: () => clock, debounceMs: 60_000 });
  assert.deepEqual(await rep.heartbeat(hb()), { ok: true });
  assert.equal(posts[0].sigOk, true);
  const body = JSON.parse(posts[0].body);
  assert.deepEqual(Object.keys(body), ["v", "ts", "heartbeat"]);
  assert.equal(validateHeartbeat(body, posts[0].ts).error, undefined);
  assert.equal(rep.pending(), 0, "heartbeats are never queued");
  assert.equal(rep.health().failingSince, null);
  up = false;
  clock += 60_000;
  assert.equal((await rep.heartbeat(hb({ at: iso(clock) }))).ok, false);
  assert.equal(rep.health().failingSince, clock);
  clock += 60_000;
  await rep.heartbeat(hb({ at: iso(clock) }));
  assert.equal(rep.health().failingSince, clock - 60_000, "the start of the streak is kept");
  up = true;
  await rep.heartbeat(hb({ at: iso(clock + 1000) }));
  assert.equal(rep.health().failingSince, null);
  // an invalid heartbeat is not sent at all
  const n = posts.length;
  assert.equal((await rep.heartbeat({ ...hb(), extra: 1 })).ok, false);
  assert.equal(posts.length, n);
  await rep.close({ waitMs: 0 });
});
