// "Who am I paying?" (site/assets/trust.js): the keccak tag hash, age buckets, edit-distance lookalikes, owner-change
// detection, first-time payee with and without consent, log decoding and the full assessment. No network.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { keccak256 as viemKeccak, toBytes, encodeAbiParameters, toEventSelector } from "viem";
import * as T from "../site/assets/trust.js";
import { LOKAL_TAGS, LOKAL_TAGS_BLOCK, TOPIC } from "../site/assets/lokal-contracts.js";
import { USDT_ADDRESS, resolveNtags } from "../site/assets/core.js";

const tagsAbi = JSON.parse(fs.readFileSync(new URL("../contracts/deployments/LokalTags.json", import.meta.url), "utf8")).abi;
const ADA = "0x2222222222222222222222222222222222222222";
const BOB = "0x4444444444444444444444444444444444444444";
const PAYER = "0x6666666666666666666666666666666666666666";
const NOW = 1_800_000_000;
const H = 3600, D = 86_400;
const word = (a) => "0x" + a.slice(2).toLowerCase().padStart(64, "0");

/** A storage double (localStorage-like). */
function store(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
}
// ---------- raw logs, encoded exactly as LokalTags emits them ----------
let li = 0;
const log = (topic0, tag, who, data, block, time) => ({
  address: LOKAL_TAGS, topics: [topic0, T.tagHashOf(tag), word(who), ...(topic0 === TOPIC.TagPaid ? [word(PAYER)] : [])], data,
  blockNumber: "0x" + block.toString(16), logIndex: "0x" + (li++).toString(16), transactionHash: "0x" + block.toString(16).padStart(64, "0"),
  ...(time != null ? { blockTimestamp: "0x" + time.toString(16) } : {}),
});
const claimed = (tag, who, name, block, time) => log(TOPIC.TagClaimed, tag, who, encodeAbiParameters([{ type: "string" }, { type: "string" }], [tag, name]), block, time);
const renamed = (tag, who, name, block, time) => log(TOPIC.NameChanged, tag, who, encodeAbiParameters([{ type: "string" }, { type: "string" }], [tag, name]), block, time);
const released = (tag, who, until, block, time) => log(TOPIC.TagReleased, tag, who, encodeAbiParameters([{ type: "string" }, { type: "uint256" }], [tag, BigInt(until)]), block, time);
const paid = (tag, who, amount, block, time) => log(TOPIC.TagPaid, tag, who, encodeAbiParameters(
  [{ type: "string" }, { type: "address" }, { type: "uint256" }, { type: "bytes32" }, { type: "uint256" }], [tag, USDT_ADDRESS, BigInt(amount), "0x" + "0".repeat(64), 20000n]), block, time);

test("keccak256 and the tag hash match viem (the topic LokalTags indexes)", () => {
  for (const s of ["", "a", "ada", "deekamix", "x".repeat(135), "x".repeat(136), "y".repeat(137), "é ünïcode"]) {
    assert.equal(T.keccak256(new TextEncoder().encode(s)), viemKeccak(toBytes(s)), JSON.stringify(s));
  }
  assert.equal(T.tagHashOf("ada"), viemKeccak(toBytes("ada")));
});

test("the new event topics are the keccak of the verified ABI", () => {
  for (const name of ["TagReleased", "NameChanged", "TagClaimed", "TagPaid"]) {
    assert.equal(TOPIC[name], toEventSelector(tagsAbi.find((x) => x.type === "event" && x.name === name)), name);
  }
});

test("age text and buckets", () => {
  assert.equal(T.agoText(NOW - 10, NOW), "just now");
  assert.equal(T.agoText(NOW - 60, NOW), "1 minute ago");
  assert.equal(T.agoText(NOW - 5 * H, NOW), "5 hours ago");
  assert.equal(T.agoText(NOW - 3 * D, NOW), "3 days ago");
  assert.equal(T.agoText(NOW - 1 * D, NOW), "1 day ago");
  assert.equal(T.agoText(NOW - 90 * D, NOW), "3 months ago");
  assert.equal(T.agoText(NOW - 800 * D, NOW), "2 years ago");
  assert.equal(T.ageBucket(NOW - 23 * H, NOW), "new");
  assert.equal(T.ageBucket(NOW - 24 * H, NOW), "recent");
  assert.equal(T.ageBucket(NOW - 29 * D, NOW), "recent");
  assert.equal(T.ageBucket(NOW - 30 * D, NOW), "settled");
  assert.equal(T.ageBucket(0, NOW), "unknown");
  assert.equal(T.ageBucket(undefined, NOW), "unknown");
});

test("edit distance counts insertions, deletions, substitutions and swaps as one", () => {
  assert.equal(T.editDistance("ada", "ada"), 0);
  assert.equal(T.editDistance("ada", "adaa"), 1);
  assert.equal(T.editDistance("adaa", "ada"), 1);
  assert.equal(T.editDistance("ada", "ida"), 1);
  assert.equal(T.editDistance("tunde", "tnude"), 1);
  assert.equal(T.editDistance("ada", "bob"), 3);
  assert.equal(T.editDistance("kitten", "sitting"), 3);
});

test("lookalikes: one edit from a tag paid before, or close to a reserved name", () => {
  assert.deepEqual(T.lookalikeOf("adaa", ["ada"]), { kind: "paid", of: "ada" });
  assert.deepEqual(T.lookalikeOf("tnude", ["tunde"]), { kind: "paid", of: "tunde" });
  assert.deepEqual(T.lookalikeOf("ad4", ["ada"]), { kind: "paid", of: "ada" });
  assert.deepEqual(T.lookalikeOf("tund3", ["tunde"]), { kind: "paid", of: "tunde" }, "confusable digit");
  assert.equal(T.lookalikeOf("ada", ["ada", "adaa"]), null, "a tag you've paid is never its own lookalike");
  assert.equal(T.lookalikeOf("tunde", ["ada"]), null);
  assert.deepEqual(T.lookalikeOf("suport", []), { kind: "reserved", of: "support" });
  assert.deepEqual(T.lookalikeOf("supp0rt", []), { kind: "reserved", of: "support" });
  assert.deepEqual(T.lookalikeOf("adm1n", []), { kind: "reserved", of: "admin" });
  assert.deepEqual(T.lookalikeOf("lokal_ng", []), { kind: "reserved", of: "lokal" });
  assert.deepEqual(T.lookalikeOf("celo_help", []), { kind: "reserved", of: "celo" });
  assert.equal(T.lookalikeOf("ray", []), null, "short reserved names (pay) only count as confusables");
  assert.equal(T.lookalikeOf("deekamix", []), null);
});

test("paid tags are kept only with consent, and first-time state follows", () => {
  const s = store();
  assert.deepEqual(T.recordPaidTag(s, "declined", "ada"), []);
  assert.equal(s.m.size, 0, "nothing stored when declined");
  T.recordPaidTag(s, null, "ada");
  assert.equal(s.m.size, 0, "nothing stored before a choice");
  assert.deepEqual(T.readPaidTags(s, "declined"), { consent: false, tags: [] });
  assert.equal(T.firstTimeState("ada", T.readPaidTags(s, null)), "unknown");

  assert.deepEqual(T.recordPaidTag(s, "accepted", "ada"), ["ada"]);
  T.recordPaidTag(s, "accepted", "tunde");
  T.recordPaidTag(s, "accepted", "ada");
  assert.deepEqual(JSON.parse(s.getItem(T.PAID_KEY)), ["ada", "tunde"], "newest first, no repeats");
  T.recordPaidTag(s, "accepted", "Not A Tag!");
  assert.deepEqual(T.readPaidTags(s, "accepted").tags, ["ada", "tunde"]);
  assert.equal(T.firstTimeState("ada", T.readPaidTags(s, "accepted")), "known");
  assert.equal(T.firstTimeState("bola", T.readPaidTags(s, "accepted")), "first");
  // a list in storage is ignored once consent is withdrawn
  assert.equal(T.firstTimeState("ada", T.readPaidTags(s, "declined")), "unknown");
  // junk in storage never throws
  assert.deepEqual(T.readPaidTags(store({ [T.PAID_KEY]: "{oops" }), "accepted"), { consent: true, tags: [] });
  assert.deepEqual(T.readPaidTags(store({ [T.PAID_KEY]: '["ok_tag", 5, "<b>"]' }), "accepted").tags, ["ok_tag"]);
});

test("decodeTagEvent reads each LokalTags event and drops the payer", () => {
  const c = T.decodeTagEvent(claimed("ada", ADA, "Ada Obi", 100, NOW));
  assert.equal(c.type, "claimed"); assert.equal(c.owner, ADA); assert.equal(c.name, "Ada Obi"); assert.equal(c.time, NOW); assert.equal(c.block, 100);
  assert.equal(c.tagHash, T.tagHashOf("ada"));
  const r = T.decodeTagEvent(released("ada", ADA, NOW + 30 * D, 101));
  assert.equal(r.type, "released"); assert.equal(r.lockedUntil, NOW + 30 * D); assert.equal(r.time, null);
  assert.equal(T.decodeTagEvent(renamed("ada", ADA, "Ada O.", 102)).name, "Ada O.");
  const p = T.decodeTagEvent(paid("ada", ADA, 5_000_000, 103));
  assert.equal(p.type, "paid"); assert.equal(p.owner, ADA); assert.equal(p.amount, 5_000_000n);
  assert.ok(!JSON.stringify(p, (k, v) => (typeof v === "bigint" ? String(v) : v)).includes(PAYER.slice(2)), "no payer anywhere");
  assert.equal(T.decodeTagEvent({ topics: ["0x" + "ab".repeat(32)], data: "0x" }), null);
  assert.equal(T.decodeTagEvent({ topics: [TOPIC.TagClaimed, T.tagHashOf("ada"), word(ADA)], data: "0x1234" }), null, "bad data");
});

test("owner change: a recent claim after someone else held the tag", () => {
  const claims = [{ owner: BOB }, { owner: ADA }];
  assert.equal(T.ownerChange({ owner: ADA, sinceSec: NOW - 3 * D, claims, nowSec: NOW }).state, "changed");
  assert.equal(T.ownerChange({ owner: ADA, sinceSec: NOW - 3 * D, claims: [{ owner: ADA }, { owner: ADA }], nowSec: NOW }).state, "same", "re-claimed by the same wallet");
  assert.equal(T.ownerChange({ owner: ADA, sinceSec: NOW - 31 * D, claims, nowSec: NOW }).state, "same", "older than 30 days");
  assert.equal(T.ownerChange({ owner: ADA, sinceSec: NOW - 3 * D, claims: [{ owner: ADA }], complete: false, nowSec: NOW }).state, "unknown", "recent claim, history not fully read");
  assert.equal(T.ownerChange({ owner: ADA, sinceSec: NOW - 31 * D, claims: [], complete: false, nowSec: NOW }).state, "same", "an old claim needs no history");
  assert.equal(T.ownerChange({ owner: ADA, sinceSec: 0, claims, nowSec: NOW }).state, "unknown");
  assert.equal(T.ownerChange({ owner: ADA.toUpperCase().replace("0X", "0x"), sinceSec: NOW - D, claims: [{ owner: ADA }], nowSec: NOW }).state, "same", "addresses compare case-insensitively");
});

test("legacy history keeps only the claims and renames the replay accepted", () => {
  const op = (n, from, body, time) => ({ hash: "0x" + n.toString(16).padStart(64, "0"), from, block: 100 + n, position: 0, time, value: "0", op: body });
  const ops = [op(1, BOB, { t: "ada" }, NOW - 90 * D), op(2, BOB, { t: "" }, NOW - 60 * D), op(3, ADA, { t: "ada", n: "Ada" }, NOW - 2 * D),
    op(4, ADA, { t: "ada", n: "Ada Obi" }, NOW - D), op(5, BOB, { t: "ada" }, NOW - H)];
  const { statuses } = resolveNtags(ops);
  const h = T.legacyHistory(ops, statuses, "ada");
  assert.deepEqual(h.claims.map((c) => c.owner), [BOB, ADA]);
  assert.deepEqual(h.renames, [{ owner: ADA, time: NOW - D }]);
});

const contractEntry = (since, name = "Ada Obi") => ({ owner: ADA, since, name, source: "contract" });
const ids = (a) => a.warnings.map((w) => w.id).sort();

test("assessment: a settled tag paid before has no warnings", () => {
  const events = [claimed("ada", ADA, "Ada Obi", 100, NOW - 90 * D), paid("ada", ADA, 5e6, 110, NOW - 80 * D), paid("ada", ADA, 7e6, 120, NOW - 10 * D)].map(T.decodeTagEvent);
  const a = T.assessTag({ tag: "ada", entry: contractEntry(NOW - 90 * D), history: { events, complete: true, capped: false }, legacyClaims: [], paid: { consent: true, tags: ["ada"] }, nowSec: NOW });
  assert.deepEqual(a.warnings, []);
  assert.deepEqual(a.unknown, []);
  assert.equal(a.age.text, "Claimed 3 months ago");
  assert.equal(a.age.bucket, "settled");
  assert.deepEqual({ state: a.payments.state, count: a.payments.count, since: a.payments.since }, { state: "ok", count: 2, since: NOW - 80 * D });
});

test("assessment: first-time payee and a new tag, with and without consent", () => {
  const events = [claimed("bola", ADA, "Bola", 100, NOW - 5 * H)].map(T.decodeTagEvent);
  const base = { tag: "bola", entry: contractEntry(NOW - 5 * H, "Bola"), history: { events, complete: true }, legacyClaims: [], nowSec: NOW };
  const withConsent = T.assessTag({ ...base, paid: { consent: true, tags: ["tunde"] } });
  assert.deepEqual(ids(withConsent), ["first", "new"]);
  assert.match(withConsent.warnings.find((w) => w.id === "first").title, /^First time paying @bola\? Check with them it's their tag\.$/);
  assert.match(withConsent.warnings.find((w) => w.id === "first").reason, /no record of paying @bola/);
  assert.match(withConsent.warnings.find((w) => w.id === "new").title, /claimed 5 hours ago/);
  assert.equal(withConsent.payments.count, 0);

  const without = T.assessTag({ ...base, paid: { consent: false, tags: [] } });
  assert.deepEqual(ids(without), ["first", "new"], "no consent: still warned, never 'safe'");
  assert.match(without.warnings.find((w) => w.id === "first").reason, /Privacy choices/);
  assert.deepEqual(without.unknown.map((u) => u.id), ["lookalike"], "the paid-tag comparison couldn't run");
});

test("assessment: changed hands, renamed and a lookalike", () => {
  const events = [
    claimed("adaa", BOB, "", 100, NOW - 200 * D), released("adaa", BOB, NOW - 170 * D, 110),
    claimed("adaa", ADA, "Ada", 200, NOW - 4 * D), renamed("adaa", ADA, "Ada Obi", 210),
  ].map(T.decodeTagEvent);
  events.find((e) => e.type === "renamed").time = NOW - 2 * D;
  const a = T.assessTag({ tag: "adaa", entry: contractEntry(NOW - 4 * D), history: { events, complete: true }, legacyClaims: [], paid: { consent: true, tags: ["ada"] }, nowSec: NOW });
  assert.deepEqual(ids(a), ["first", "lookalike", "name", "owner"]);
  assert.match(a.warnings.find((w) => w.id === "lookalike").title, /Looks like @ada, a tag you've paid before/);
  assert.match(a.warnings.find((w) => w.id === "owner").title, /Changed hands 4 days ago/);
  assert.match(a.warnings.find((w) => w.id === "name").title, /Name changed 2 days ago/);
  for (const w of a.warnings) assert.ok(w.title && w.reason, `${w.id} has a one-line reason`);
});

test("assessment: a legacy memo holder before the contract claim counts as an owner change", () => {
  const events = [claimed("ada", ADA, "", 100, NOW - 3 * D)].map(T.decodeTagEvent);
  const a = T.assessTag({ tag: "ada", entry: contractEntry(NOW - 3 * D), history: { events, complete: true }, legacyClaims: [{ owner: BOB, time: NOW - 300 * D }], paid: { consent: true, tags: ["ada"] }, nowSec: NOW });
  assert.deepEqual(ids(a), ["owner"]);
});

test("assessment: failed reads say 'couldn't check', never fine", () => {
  const recent = T.assessTag({ tag: "ada", entry: contractEntry(NOW - 3 * D), history: null, legacyClaims: null, paid: { consent: true, tags: ["ada"] }, nowSec: NOW });
  assert.deepEqual(recent.unknown.map((u) => u.id).sort(), ["name", "owner"]);
  assert.equal(recent.payments.state, "unknown");
  assert.equal(recent.payments.count, null);
  assert.ok(!recent.checks.some((c) => c.id === "owner" && c.state === "ok"));
  // partial history (the Forno fallback didn't reach the deployment)
  const partial = T.assessTag({ tag: "ada", entry: contractEntry(NOW - 3 * D), history: { events: [], complete: false }, legacyClaims: [], paid: { consent: true, tags: ["ada"] }, nowSec: NOW });
  assert.equal(partial.checks.find((c) => c.id === "owner").state, "unknown");
  assert.equal(partial.checks.find((c) => c.id === "name").state, "unknown");
  assert.equal(partial.payments.state, "unknown");
  // a rename whose block time couldn't be read
  const events = [claimed("ada", ADA, "", 100, NOW - 90 * D), renamed("ada", ADA, "Ada", 110)].map(T.decodeTagEvent);
  const noTime = T.assessTag({ tag: "ada", entry: contractEntry(NOW - 90 * D), history: { events, complete: true }, legacyClaims: [], paid: { consent: true, tags: ["ada"] }, nowSec: NOW });
  assert.equal(noTime.checks.find((c) => c.id === "name").state, "unknown");
});

test("assessment of a legacy memo tag uses the legacy claims", () => {
  const entry = { owner: ADA, since: NOW - 2 * D, name: "Ada", source: "legacy" };
  const a = T.assessTag({ tag: "ada", entry, history: { legacy: { claims: [{ owner: BOB, time: NOW - 90 * D }, { owner: ADA, time: NOW - 2 * D }], renames: [] } }, paid: { consent: true, tags: ["ada"] }, nowSec: NOW });
  assert.deepEqual(ids(a), ["owner"]);
  assert.equal(a.payments.state, "unknown");
});

test("loadTagEvents: Blockscout first (one call per event type, tag hash in topic 1), Forno chunks as a fallback", async () => {
  const calls = [];
  const logs = [claimed("ada", ADA, "Ada", LOKAL_TAGS_BLOCK + 10, null), paid("ada", ADA, 5e6, LOKAL_TAGS_BLOCK + 20, null), claimed("other", BOB, "", LOKAL_TAGS_BLOCK + 5, null)];
  const explorer = async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    calls.push({ url, method, params });
    if (url.includes("blockscout")) return { result: logs.filter((l) => l.topics[0] === params[0].topics[0] && l.topics[1] === params[0].topics[1]) };
    throw new Error("unexpected");
  };
  const r = await T.loadTagEvents("ada", { fetchJson: explorer });
  assert.equal(r.source, "explorer");
  assert.equal(r.complete, true);
  assert.deepEqual(r.events.map((e) => e.type), ["claimed", "paid"]);
  assert.equal(calls.length, 4);
  for (const c of calls) {
    assert.equal(c.method, "eth_getLogs");
    assert.equal(c.params[0].topics[1], T.tagHashOf("ada"));
    assert.equal(c.params[0].fromBlock, "0x" + LOKAL_TAGS_BLOCK.toString(16));
  }

  // the explorer is down: Forno, in 5,000-block chunks, capped
  const head = LOKAL_TAGS_BLOCK + 12_345;
  const ranges = [];
  const forno = async (url, init) => {
    if (url.includes("blockscout")) throw new Error("down");
    const { method, params } = JSON.parse(init.body);
    if (method === "eth_blockNumber") return { result: "0x" + head.toString(16) };
    const from = parseInt(params[0].fromBlock, 16), to = parseInt(params[0].toBlock, 16);
    ranges.push([from, to]);
    assert.equal(params[0].topics[0], null);
    return { result: logs.filter((l) => { const b = parseInt(l.blockNumber, 16); return b >= from && b <= to; }) };
  };
  const f = await T.loadTagEvents("ada", { fetchJson: forno });
  assert.equal(f.source, "rpc");
  assert.equal(f.complete, true);
  assert.equal(ranges.length, 3);
  assert.ok(ranges.every(([a, b]) => b - a + 1 <= T.RANGE));
  assert.deepEqual(f.events.map((e) => e.type), ["claimed", "paid"], "other tags' logs are dropped");
  const capped = await T.loadTagEvents("ada", { fetchJson: forno, fallbackBlocks: 6000 });
  assert.equal(capped.complete, false, "a window short of the deployment is incomplete");

  await assert.rejects(T.loadTagEvents("ada", { fetchJson: async () => { throw new Error("offline"); } }));
});

test("addBlockTimes fills in only what's missing, and leaves unreadable blocks unknown", async () => {
  const evs = [{ block: 5, time: null }, { block: 6, time: 123 }, { block: 7, time: null }];
  await T.addBlockTimes(evs, { fetchJson: async (url, init) => {
    const { params } = JSON.parse(init.body);
    if (params[0] === "0x7") throw new Error("nope");
    return { result: { timestamp: "0x" + (1000 + parseInt(params[0], 16)).toString(16) } };
  } });
  assert.deepEqual(evs.map((e) => e.time), [1005, 123, null]);
});
