// nTags: tag rules, claim/release/memo codecs, resolution, discovery, the onchain re-check and local state.
// The Node port (src/ntags.mjs) must agree with site/assets/core.js exactly. No network (Blockscout and RPC are faked).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { toDataSuffix } from "@celo/attribution-tags";
import { decodeFunctionData, erc20Abi, encodeFunctionData } from "viem";
import { ATTRIBUTION_CODE } from "../src/config.mjs";
import * as node from "../src/ntags.mjs";
import * as site from "../site/assets/core.js";

const AGENT = "0x8a695cf54CB44753c8b784EB36d266f748617a1e";
const ADA = "0x2222222222222222222222222222222222222222";
const BOB = "0x4444444444444444444444444444444444444444";
const CHI = "0x5555555555555555555555555555555555555555";
const T = 1_800_000_000;
const DAY = 86400;
const hex = (s) => Buffer.from(s, "utf8").toString("hex");
const rawOp = (body) => "0x" + hex("NT1:" + (typeof body === "string" ? body : JSON.stringify(body)));
let seq = 0;
const op = (from, body, over = {}) => {
  seq++;
  return { hash: "0x" + seq.toString(16).padStart(64, "0"), from, block: 100 + seq, position: 0, time: T + seq * 60, value: "0", op: body, ...over };
};

test("port: the shared block is byte-identical in core.js and src/ntags.mjs", () => {
  const block = (f) => {
    const s = fs.readFileSync(new URL(f, import.meta.url), "utf8").replace(/\r\n/g, "\n");
    const a = s.indexOf("\n", s.indexOf("// ---------- port: start")) + 1;
    const b = s.indexOf("// ---------- port: end");
    assert.ok(a > 0 && b > a, f);
    return s.slice(a, b);
  };
  assert.equal(block("../src/ntags.mjs"), block("../site/assets/core.js"));
  assert.equal(node.tagSuffix(), site.tagSuffix());
  assert.equal(node.tagSuffix(), toDataSuffix(ATTRIBUTION_CODE).replace(/^0x/, ""));
});

test("rules: valid, invalid, reserved, normalisation", () => {
  for (const t of ["ada", "ada_ng", "a12", "abc_def_1", "x".repeat(20), "adaobi"]) assert.equal(site.ntagError(t), null, t);
  const bad = ["", "ab", "x".repeat(21), "1ada", "_ada", "Ada", "ADA", "ada-ng", "ada ng", "ada__ng", "ada_", "@ada", "adá", "ada.ng", null, 5, undefined];
  for (const t of bad) assert.ok(site.ntagError(t), String(t));
  assert.match(site.ntagError("Ada"), /lowercase/);
  assert.match(site.ntagError("1ada"), /start with a letter/);
  assert.match(site.ntagError("ab"), /at least 3/);
  assert.match(site.ntagError("x".repeat(21)), /20/);
  assert.match(site.ntagError("ada__ng"), /__/);
  assert.match(site.ntagError("ada_"), /end with _/);
  for (const t of ["agent", "admin", "celo", "naira", "ntags", "lokal", "lokalpay", "pay", "receive", "www", "undefined"]) assert.match(site.ntagError(t), /reserved/, t);
  assert.equal(site.NTAG_RESERVED.size, 49); // the spec list, all lower-case
  assert.equal(site.normalizeNtag("  @Ada_NG "), "ada_ng");
  assert.equal(site.normalizeNtag("@@ada"), "@ada"); // only one @ is stripped
  assert.equal(site.normalizeNtag(null), "");
  assert.equal(site.ntagError(site.normalizeNtag(" @ADA ")), null);
  assert.equal(site.NTAG_PREFIX, "NT1:");
  assert.equal(site.NTAG_MEMO_PREFIX, "NTP:");
  assert.equal(site.RELEASE_LOCK_DAYS, 30);
});

test("op validation: claim, release, names, shapes", () => {
  assert.equal(site.ntagOpError({ t: "ada" }), null);
  assert.equal(site.ntagOpError({ t: "ada", n: "Ada Obi" }), null);
  assert.equal(site.ntagOpError({ t: "ada", n: " " + "x".repeat(40) + " " }), null); // 40 after trim
  assert.equal(site.ntagOpError({ t: "" }), null); // release
  for (const o of [null, "ada", [], {}, { t: 1 }, { t: "ada", n: 1 }, { t: "ada", n: "" }, { t: "ada", n: "   " }, { t: "ada", n: "x".repeat(41) },
    { t: "ada", n: "a\u0000b" }, { t: "ada", n: "a\nb" }, { t: "ada", x: 1 }, { t: "", n: "Ada" }, { t: "Ada" }, { t: "ab" }, { n: "Ada" }]) {
    assert.ok(site.ntagOpError(o), JSON.stringify(o));
  }
  assert.match(site.ntagOpError({ t: "admin" }), /reserved/);
});

test("codec: claim and release round-trip with and without the ERC-8021 suffix", () => {
  const claim = site.encodeNtagClaim({ t: "ada", n: "  Ada Obi  " });
  assert.deepEqual(site.decodeTag(claim).codes, [ATTRIBUTION_CODE]);
  assert.ok(claim.endsWith(site.tagSuffix()));
  assert.deepEqual(site.decodeNtagOp(claim), { t: "ada", n: "Ada Obi" });
  assert.deepEqual(site.decodeNtagOp(claim.slice(0, -site.tagSuffix().length)), { t: "ada", n: "Ada Obi" });
  assert.deepEqual(site.decodeNtagOp(claim.toUpperCase().replace("0X", "0x")), { t: "ada", n: "Ada Obi" });
  assert.deepEqual(site.decodeNtagOp(site.encodeNtagClaim({ t: "ada" })), { t: "ada" });
  assert.deepEqual(site.decodeNtagOp(site.encodeNtagClaim({ t: "ada", n: "" })), { t: "ada" }); // empty name omitted
  assert.deepEqual(site.decodeNtagOp(site.encodeNtagRelease()), { t: "" });
  assert.ok(site.encodeNtagRelease().endsWith(site.tagSuffix()));
  // foreign suffix is stripped too
  assert.deepEqual(site.decodeNtagOp(rawOp({ t: "ada" }) + hex("other_code") + "0a00" + "80218021802180218021802180218021"), { t: "ada" });
  assert.throws(() => site.encodeNtagClaim({ t: "Ada" }), /lowercase/);
  assert.throws(() => site.encodeNtagClaim({ t: "admin" }), /reserved/);
  assert.throws(() => site.encodeNtagClaim({ t: "" }));
  assert.throws(() => site.encodeNtagClaim({ t: "ada", n: "x".repeat(41) }));
  assert.throws(() => site.encodeNtagClaim());
  // never confused with registrations or transfers
  assert.equal(site.decodeNtagOp(site.encodeRegistration({ a: "5.03", d: "usdt-cngn", e: T, n: "Ada" })), null);
  assert.equal(site.decodeRegistration(claim), null);
  for (const i of ["0x", "", null, undefined, "0xa9059cbb" + "00".repeat(64), rawOp("{not json"), "0x" + hex("NT2:{}")]) assert.equal(site.decodeNtagOp(i), null, String(i));
  assert.equal(site.decodeNtagOp(rawOp('"str"')), "str"); // parsed but invalid; ntagOpError rejects it
  assert.ok(site.ntagOpError(site.decodeNtagOp(rawOp('"str"'))));
});

test("codec: tag memo on an ERC-20 transfer keeps the standard 68-byte prefix", () => {
  const units = 5_030_000n;
  const data = site.encodeNtagTransfer(AGENT, units, "ada");
  const plain = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [AGENT, units] });
  assert.equal(data.slice(0, 2 + 136), plain.toLowerCase()); // selector + 2 words, exactly as tokens expect
  assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data }).args, [AGENT, units]); // trailing bytes ignored
  assert.ok(data.endsWith(site.tagSuffix()));
  assert.equal(site.decodeTag(data).codes[0], site.TAG);
  assert.equal(site.decodeNtagMemo(data), "ada");
  assert.equal(site.decodeNtagMemo(data.slice(0, -site.tagSuffix().length)), "ada"); // no suffix
  assert.equal(site.decodeNtagMemo(data.toUpperCase().replace("0X", "0x")), "ada");
  assert.equal(site.decodeNtagMemo(plain), null); // no memo
  assert.equal(site.decodeNtagMemo(plain + site.tagSuffix()), null); // only the agent's own suffix
  assert.equal(site.decodeNtagMemo("0x095ea7b3" + data.slice(10)), null); // wrong selector (approve)
  assert.equal(site.decodeNtagMemo(plain + hex("NTP:Ada")), null); // not normalised
  assert.equal(site.decodeNtagMemo(plain + hex("NTP:ab")), null); // invalid tag
  assert.equal(site.decodeNtagMemo(plain + hex("NTP:admin")), null); // reserved
  assert.equal(site.decodeNtagMemo(plain + hex("NTP:ada ")), null); // extra bytes
  assert.equal(site.decodeNtagMemo(plain + hex("XTP:ada")), null);
  assert.equal(site.decodeNtagMemo(plain + "ff" + hex("NTP:ada")), null);
  assert.equal(site.decodeNtagMemo(plain + "zz"), null);
  for (const i of ["0x", "", null, undefined, "0xa9059cbb", rawOp({ t: "ada" })]) assert.equal(site.decodeNtagMemo(i), null, String(i));
  assert.throws(() => site.encodeNtagTransfer(AGENT, 0n, "ada"), /amount/);
  assert.throws(() => site.encodeNtagTransfer("0x12", 1n, "ada"), /address/);
  assert.throws(() => site.encodeNtagTransfer(AGENT, 1n, "Ada"));
  assert.throws(() => site.encodeNtagTransfer(AGENT, 1n, "admin"), /reserved/);
});

test("resolution: claim, taken, rename, noop, reserved, invalid, agent sender, value", () => {
  const a = op(ADA, { t: "ada", n: "Ada Obi" });
  const b = op(BOB, { t: "ada" });
  const r = op(ADA, { t: "ada", n: "Ada O." });
  const n = op(ADA, { t: "ada" });
  const res = op(BOB, { t: "admin" });
  const inv = op(BOB, { t: "Bob" });
  const extra = op(BOB, { t: "bob", x: 1 });
  const ag = op(AGENT, { t: "agentx" });
  const val = op(BOB, { t: "bobby" }, { value: "1" });
  const s = site.resolveNtags([a, b, r, n, res, inv, extra, ag, val]);
  assert.deepEqual(Object.fromEntries(s.statuses), {
    [a.hash]: "claimed", [b.hash]: "taken", [r.hash]: "renamed", [n.hash]: "noop", [res.hash]: "reserved",
    [inv.hash]: "invalid", [extra.hash]: "invalid", [ag.hash]: "invalid", [val.hash]: "invalid",
  });
  assert.deepEqual(site.ownerOf(s, "ada"), { owner: ADA.toLowerCase(), name: "Ada O.", since: a.time, hash: a.hash, block: a.block, position: 0 });
  assert.equal(site.ntagOf(s, ADA.toUpperCase().replace("0X", "0x")), "ada");
  assert.equal(site.ntagOf(s, BOB), null);
  assert.equal(site.ownerOf(s, "bobby"), null);
  assert.equal(site.ownerOf(s, "agentx"), null);
  assert.equal(s.tags.size, 1);
});

test("resolution: switching tags releases the old one with a 30-day lock; release; owner re-claim", () => {
  const a1 = op(ADA, { t: "ada" }, { time: T });
  const a2 = op(ADA, { t: "adaobi" }, { time: T + DAY }); // switch: "ada" released + locked for ADA
  const b1 = op(BOB, { t: "ada" }, { time: T + 2 * DAY }); // locked
  let s = site.resolveNtags([a1, a2, b1]);
  assert.equal(s.statuses.get(a2.hash), "claimed");
  assert.equal(s.statuses.get(b1.hash), "locked");
  assert.equal(site.ntagOf(s, ADA), "adaobi");
  assert.equal(site.ownerOf(s, "ada"), null);
  assert.deepEqual(s.locks.get("ada"), { owner: ADA.toLowerCase(), until: T + DAY + 30 * DAY });
  // availability at various times
  assert.equal(site.ntagAvailability(s, "ada", BOB, T + 2 * DAY), "locked");
  assert.equal(site.ntagAvailability(s, "ada", ADA, T + 2 * DAY), "free"); // previous owner may take it back
  assert.equal(site.ntagAvailability(s, "ada", BOB, T + 31 * DAY), "free"); // lock over (until is exclusive)
  assert.equal(site.ntagAvailability(s, "adaobi", ADA, T + 2 * DAY), "yours");
  assert.equal(site.ntagAvailability(s, "adaobi", BOB, T + 2 * DAY), "taken");
  assert.equal(site.ntagAvailability(s, "adaobi", null, T + 2 * DAY), "taken");
  assert.equal(site.ntagAvailability(s, "admin", BOB, T), "reserved");
  assert.equal(site.ntagAvailability(s, "Ada", BOB, T), "invalid");
  assert.equal(site.ntagAvailability(s, "zed", BOB, T), "free");
  // BOB claims exactly when the lock ends -> ok
  const b2 = op(BOB, { t: "ada" }, { time: T + 31 * DAY });
  s = site.resolveNtags([a1, a2, b1, b2]);
  assert.equal(s.statuses.get(b2.hash), "claimed");
  assert.equal(site.ownerOf(s, "ada").owner, BOB.toLowerCase());
  // owner re-claims within the lock; their other tag is released and locked in turn
  const a3 = op(ADA, { t: "ada" }, { time: T + 3 * DAY });
  s = site.resolveNtags([a1, a2, b1, a3]);
  assert.equal(s.statuses.get(a3.hash), "claimed");
  assert.equal(site.ntagOf(s, ADA), "ada");
  assert.equal(s.locks.has("ada"), false);
  assert.deepEqual(s.locks.get("adaobi"), { owner: ADA.toLowerCase(), until: T + 33 * DAY });
  // explicit release, then a release with nothing held is a noop
  const rel = op(ADA, { t: "" }, { time: T + 4 * DAY });
  const rel2 = op(ADA, { t: "" }, { time: T + 5 * DAY });
  const c1 = op(CHI, { t: "ada" }, { time: T + 6 * DAY });
  s = site.resolveNtags([a1, a2, b1, a3, rel, rel2, c1]);
  assert.equal(s.statuses.get(rel.hash), "released");
  assert.equal(s.statuses.get(rel2.hash), "noop");
  assert.equal(s.statuses.get(c1.hash), "locked");
  assert.equal(site.ntagOf(s, ADA), null);
  assert.equal(s.tags.size, 0);
});

test("resolution: ordering by (block, position), atSec and resolveNtagsBefore", () => {
  const x = op(BOB, { t: "zed" }, { block: 50, position: 3, time: T });
  const y = op(ADA, { t: "zed" }, { block: 50, position: 1, time: T });
  const z = op(CHI, { t: "zed" }, { block: 49, position: 9, time: T - 5 });
  const input = [x, y, z];
  const s = site.resolveNtags(input);
  assert.equal(site.ownerOf(s, "zed").owner, CHI.toLowerCase());
  assert.deepEqual(input, [x, y, z]); // input not reordered
  const s2 = site.resolveNtags([x, y, z], T - 1); // z only... z.time = T-5
  assert.equal(site.ownerOf(s2, "zed").owner, CHI.toLowerCase());
  const s3 = site.resolveNtags([x, y, z], T - 6);
  assert.equal(s3.tags.size, 0);
  assert.equal(site.ownerOf(site.resolveNtags([x, y]), "zed").owner, ADA.toLowerCase()); // position 1 before 3
  // before a deposit at (50, 2): z and y count, x does not
  const b = site.resolveNtagsBefore(input, 50, 2);
  assert.equal(b.statuses.has(x.hash), false);
  assert.equal(b.statuses.get(y.hash), "taken");
  assert.equal(site.resolveNtagsBefore(input, 49, 9).tags.size, 0); // strictly before
  assert.equal(site.resolveNtagsBefore(input, 49, 10).tags.size, 1);
  assert.equal(site.resolveNtags([]).tags.size, 0);
  assert.equal(site.resolveNtags(null).tags.size, 0);
});

test("cross-check: core.js and src/ntags.mjs agree on a shared fixture set", () => {
  const sfx = site.tagSuffix();
  const inputs = [
    site.encodeNtagClaim({ t: "ada", n: "Ada Obi" }), site.encodeNtagClaim({ t: "b_o_b" }), site.encodeNtagRelease(),
    rawOp({ t: "Ada" }), rawOp({ t: "ada", n: 3 }), rawOp('{"t":"ada"'), rawOp("[1]"), rawOp("null"), "0x" + hex("NP1:{}"),
    site.encodeNtagTransfer(AGENT, 1_000_000n, "ada"), site.encodeNtagTransfer(AGENT, 25_000_000n, "chidi_ng"),
    site.encodeNtagTransfer(AGENT, 1n, "ada").slice(0, -sfx.length), "0xa9059cbb" + "00".repeat(64) + hex("NTP:ada"),
    "0xa9059cbb" + "00".repeat(64) + hex("NTP:admin") + sfx, "0x", "", null, undefined, "0xzz",
  ];
  for (const i of inputs) {
    assert.deepEqual(node.decodeNtagOp(i), site.decodeNtagOp(i), String(i).slice(0, 40));
    assert.equal(node.decodeNtagMemo(i), site.decodeNtagMemo(i), String(i).slice(0, 40));
  }
  for (const t of ["ada", "Ada", "ab", "admin", "ada__x", "ada_", "x".repeat(20), "x".repeat(21), "", null, 1]) {
    assert.equal(node.ntagError(t), site.ntagError(t));
    assert.equal(node.normalizeNtag(t), site.normalizeNtag(t));
  }
  assert.equal(node.encodeNtagClaim({ t: "ada", n: "Ada" }), site.encodeNtagClaim({ t: "ada", n: "Ada" }));
  assert.equal(node.encodeNtagRelease(), site.encodeNtagRelease());
  assert.equal(node.encodeNtagTransfer(AGENT, 7n, "ada"), site.encodeNtagTransfer(AGENT, 7n, "ada"));
  assert.deepEqual([...node.NTAG_RESERVED].sort(), [...site.NTAG_RESERVED].sort());

  // random op sets: resolution, availability and resolveNtagsBefore must match exactly
  let seed = 11;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
  const froms = [ADA, BOB, CHI, AGENT, "0xnot-an-address"];
  const bodies = [{ t: "ada" }, { t: "ada", n: "Ada" }, { t: "bob" }, { t: "" }, { t: "chi", n: "Chi" }, { t: "admin" }, { t: "Ada" }, { t: "ada", x: 1 }, "junk", { t: "ada", n: "" }];
  for (let round = 0; round < 300; round++) {
    const ops = Array.from({ length: 1 + rnd(14) }, (_, i) => ({
      hash: "0x" + i.toString(16).padStart(4, "0"), from: froms[rnd(froms.length)], block: 10 + rnd(6), position: rnd(4),
      time: T + rnd(40) * 5 * DAY, value: ["0", "0", "0", "5", "0x0"][rnd(5)], op: bodies[rnd(bodies.length)],
    }));
    const at = rnd(3) ? Infinity : T + rnd(40) * 5 * DAY;
    const a = node.resolveNtags(ops, at), b = site.resolveNtags(ops, at);
    for (const k of ["tags", "byOwner", "locks", "statuses"]) assert.deepEqual([...a[k]].sort(), [...b[k]].sort(), `round ${round} ${k}`);
    const now = T + rnd(80) * 5 * DAY;
    for (const t of ["ada", "bob", "chi", "admin", "Ada", "zzz"]) {
      for (const f of [ADA, BOB, null]) assert.equal(node.ntagAvailability(a, t, f, now), site.ntagAvailability(b, t, f, now));
    }
    const blk = 10 + rnd(6), pos = rnd(4);
    assert.deepEqual([...node.resolveNtagsBefore(ops, blk, pos).tags].sort(), [...site.resolveNtagsBefore(ops, blk, pos).tags].sort());
    for (const f of [ADA, BOB, CHI]) assert.equal(node.ntagOf(a, f), site.ntagOf(b, f));
  }
});

test("discovery: pages to the end, filters like core.js, keeps value, refuses a partial list", async () => {
  const item = (i, over = {}) => ({
    hash: "0x" + String(i).padStart(64, "0"), status: "ok", to: { hash: AGENT.toLowerCase() }, from: { hash: ADA }, value: "0",
    block_number: 100 + i, position: 2, timestamp: new Date((T + i) * 1000).toISOString(), raw_input: site.encodeNtagClaim({ t: "ada" }), ...over,
  });
  const pages = [
    { items: [item(6), item(5, { status: "error" }), item(4, { raw_input: "0xa9059cbb" }), item(3, { raw_input: site.encodeRegistration({ a: "5.03", d: "usdt-cngn", e: T, n: "A" }) })], next_page_params: { block_number: 3, index: 0 } },
    { items: [item(2, { to: { hash: BOB } }), item(1, { value: "7", raw_input: site.encodeNtagRelease() })], next_page_params: null },
  ];
  const urls = [];
  const fetchImpl = async (url) => { urls.push(url); return { ok: true, status: 200, json: async () => pages[urls.length - 1] }; };
  const ops = await node.discoverNtagOps({ agent: AGENT, api: "https://x/api/v2", fetchImpl });
  assert.deepEqual(ops.map((o) => o.block), [101, 106]);
  assert.deepEqual(ops[0], { hash: item(1).hash, from: ADA, block: 101, position: 2, time: T + 1, value: "7", op: { t: "" } });
  assert.deepEqual(ops[1].op, { t: "ada" });
  assert.match(urls[0], /\/addresses\/0x8a69.*\/transactions\?filter=to$/);
  assert.match(urls[1], /filter=to&block_number=3&index=0/);
  for (const t of [...pages[0].items, ...pages[1].items]) assert.deepEqual(node.ntagOpFromItem(t, AGENT), site.ntagOpFromItem(t, AGENT));
  const endless = async () => ({ ok: true, status: 200, json: async () => ({ items: [], next_page_params: { p: 1 } }) });
  await assert.rejects(node.discoverNtagOps({ agent: AGENT, api: "https://x", fetchImpl: endless, maxPages: 3 }), /partial/);
  const broken = async () => ({ ok: true, status: 200, json: async () => ({}) });
  await assert.rejects(node.discoverNtagOps({ agent: AGENT, api: "https://x", fetchImpl: broken }), /no items/);
});

test("onchain re-check: the winning claim must match over RPC", async () => {
  const o = { hash: "0x" + "ab".repeat(32), from: ADA, block: 100, position: 2, time: T, value: "0", op: { t: "ada", n: "Ada" } };
  const pub = (over = {}) => ({
    getTransaction: async () => ({ from: ADA.toLowerCase(), to: AGENT.toLowerCase(), input: site.encodeNtagClaim(o.op), blockNumber: 100n, transactionIndex: 2, value: 0n, ...over.tx }),
    getTransactionReceipt: async () => ({ status: "success", ...over.rc }),
    getBlock: async ({ blockNumber }) => { assert.equal(blockNumber, 100n); return { timestamp: BigInt(T), ...over.block }; },
  });
  assert.deepEqual(await node.verifyNtagOpOnchain(pub(), o, AGENT), { from: ADA, time: T });
  const refused = (p) => assert.rejects(node.verifyNtagOpOnchain(p, o, AGENT), (e) => e.permanent === true);
  await refused(pub({ rc: { status: "reverted" } }));
  await refused(pub({ tx: { from: BOB } }));
  await refused(pub({ tx: { to: BOB } }));
  await refused(pub({ tx: { blockNumber: 101n } }));
  await refused(pub({ tx: { transactionIndex: 3 } }));
  await refused(pub({ tx: { value: 1n } }));
  await refused(pub({ tx: { input: site.encodeNtagClaim({ t: "ada", n: "Ada Obi" }) } }));
  await refused(pub({ tx: { input: site.encodeNtagClaim({ t: "adaobi" }) } }));
  // The block time the resolver used (locks, "before the deposit") must be the chain's.
  await assert.rejects(node.verifyNtagOpOnchain(pub({ block: { timestamp: BigInt(T + 1) } }), o, AGENT), (e) => e.permanent === true && /block time/.test(e.message));
  await assert.rejects(node.verifyNtagOpOnchain(pub(), { ...o, time: T - 3600 }, AGENT), (e) => e.permanent === true && /block time/.test(e.message));
  // an invalid op can never pass even if it matches
  const badOp = { ...o, op: { t: "Ada" } };
  await assert.rejects(node.verifyNtagOpOnchain(pub({ tx: { input: rawOp({ t: "Ada" }) } }), badOp, AGENT), (e) => e.permanent === true);
});

test("local state: ntag-payments.json loads empty, saves atomically, round-trips", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ntags-"));
  const file = path.join(dir, "sub", "ntag-payments.json");
  assert.deepEqual(node.loadNtagPayments(file), {});
  const state = { ["0x" + "cd".repeat(32) + ":3"]: { tag: "ada", owner: ADA, amount: "5.03", corridor: "usdt-cngn" } };
  node.saveNtagPayments(state, file);
  assert.deepEqual(node.loadNtagPayments(file), state);
  assert.equal(fs.existsSync(file + ".tmp"), false);
  fs.writeFileSync(file, JSON.stringify({ payments: [] }));
  assert.deepEqual(node.loadNtagPayments(file), {});
  fs.rmSync(dir, { recursive: true, force: true });
});

test("site helpers: ntagUrl off Vercel, avatarSeed is deterministic", () => {
  assert.equal(site.ntagUrl("ada"), "tag.html#ada"); // Node: no location, no API
  const a = site.avatarSeed(ADA);
  assert.equal(a.length, 3);
  for (const h of a) assert.ok(Number.isInteger(h) && h >= 0 && h < 360);
  assert.deepEqual(site.avatarSeed(ADA.toUpperCase().replace("0X", "0x")), a);
  assert.notDeepEqual(site.avatarSeed(BOB), a);
  assert.equal(new Set(a).size, 3);
});

test("nTag list cache: one full load, then each refresh reads only new pages (keyset by block) and re-checks a window", async () => {
  const claim = (n, block, t, over = {}) => ({
    hash: "0x" + n.toString(16).padStart(64, "0"), status: "ok", to: { hash: AGENT.toLowerCase() }, from: { hash: ADA }, value: "0",
    block_number: block, position: 0, timestamp: new Date((T + block) * 1000).toISOString(), raw_input: site.encodeNtagClaim({ t }), ...over,
  });
  const junk = (n, block) => ({ ...claim(n, block, "xyz"), raw_input: "0x" }); // a non-op tx (e.g. spam)
  // History: 2 pages, newest first.
  let pages = [
    { items: [junk(9, 5000), claim(8, 4000, "bob_ng"), junk(7, 3000)], next_page_params: { block_number: 3000, index: 0 } },
    { items: [claim(6, 2000, "ada"), junk(5, 1000)], next_page_params: null },
  ];
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    const q = new URL(url).searchParams;
    const page = q.get("block_number") ? pages[1] : pages[0];
    return { ok: true, status: 200, json: async () => page };
  };
  const full = await node.loadNtagOpsCache({ agent: AGENT, api: "https://x", fetchImpl });
  assert.deepEqual(full.ops.map((o) => o.op.t), ["ada", "bob_ng"]);
  assert.deepEqual(full.head, { block: 5000, position: 0 });
  assert.equal(urls.length, 2);
  // Thousands of spam txs since: the refresh stops at the first page that reaches below head - recheck window.
  urls.length = 0;
  pages = [
    { items: [claim(12, 7000, "chi"), junk(11, 6000), junk(9, 5000), junk(10, 4850)], next_page_params: { block_number: 4850, index: 0 } },
    { items: [claim(8, 4000, "bob_ng")], next_page_params: { block_number: 4000, index: 0 } },
  ];
  const next = await node.refreshNtagOpsCache(full, { agent: AGENT, api: "https://x", fetchImpl, recheckBlocks: 100 });
  assert.equal(urls.length, 1, "only the newest page was read");
  assert.deepEqual(next.ops.map((o) => o.op.t), ["ada", "bob_ng", "chi"]);
  assert.deepEqual(next.head, { block: 7000, position: 0 });
  assert.deepEqual(full.ops.map((o) => o.op.t), ["ada", "bob_ng"], "the old cache is not mutated");
  // An op inside the re-checked window that Blockscout no longer shows (reorged out) is dropped.
  const withLate = { ops: [...next.ops, { ...next.ops[2], hash: "0x" + "77".repeat(32), block: 6950, op: { t: "ghost" } }], head: next.head };
  pages = [{ items: [claim(12, 7000, "chi"), junk(13, 6000)], next_page_params: null }];
  const again = await node.refreshNtagOpsCache(withLate, { agent: AGENT, api: "https://x", fetchImpl, recheckBlocks: 100 });
  assert.deepEqual(again.ops.map((o) => o.op.t), ["ada", "bob_ng", "chi"]);
  // Too many NEW pages in one refresh: throws (the caller keeps its old cache), never a partial list.
  const endless = async () => ({ ok: true, status: 200, json: async () => ({ items: [junk(1, 99_999)], next_page_params: { p: 1 } }) });
  await assert.rejects(node.refreshNtagOpsCache(next, { agent: AGENT, api: "https://x", fetchImpl: endless, maxPages: 3 }), /partial/);
  // The first load still reads to the end and refuses a partial list, with a much higher default page cap.
  await assert.rejects(node.loadNtagOpsCache({ agent: AGENT, api: "https://x", fetchImpl: endless, maxPages: 5 }), /partial/);
  assert.ok(node.NTAG_FULL_LOAD_MAX_PAGES >= 2000);
  // Nothing ever sent to the agent: head null, a refresh just loads again.
  const empty = async () => ({ ok: true, status: 200, json: async () => ({ items: [], next_page_params: null }) });
  assert.deepEqual(await node.loadNtagOpsCache({ agent: AGENT, api: "https://x", fetchImpl: empty }), { ops: [], head: null });
  assert.deepEqual(await node.refreshNtagOpsCache({ ops: [], head: null }, { agent: AGENT, api: "https://x", fetchImpl: empty }), { ops: [], head: null });
});

test("force-paying a refused nTag deposit: only with a known owner, claim and amount, and never twice", () => {
  const good = {
    id: "0xab:1", status: "refused", reason: "over the per-wallet cap", tag: "ada", from: ADA, owner: ADA, claim: "0x" + "cd".repeat(32),
    amount: "7", dir: "usdt-cngn", deposit: { payer: BOB, tx: "0xab", logIndex: 1 },
  };
  assert.equal(node.refusedRetryBlocker(good), null);
  assert.match(node.refusedRetryBlocker({ ...good, status: undefined }), /not refused/);
  assert.match(node.refusedRetryBlocker({ ...good, paidAt: "x" }), /already paid/);
  assert.match(node.refusedRetryBlocker({ ...good, retrying: "x" }), /in progress/);
  assert.match(node.refusedRetryBlocker({ ...good, hashes: { swap: "0x1" } }), /pay twice/);
  assert.match(node.refusedRetryBlocker({ ...good, error: "Swap reverted (0x" + "ef".repeat(32) + ")" }), /pay twice/);
  for (const missing of ["tag", "from", "claim", "amount", "dir", "deposit"]) {
    assert.match(node.refusedRetryBlocker({ ...good, [missing]: undefined }), /nobody to pay/, missing);
  }
  assert.match(node.refusedRetryBlocker({ ...good, tag: null, reason: "unknown nTag" }), /unknown nTag/);
  assert.match(node.refusedRetryBlocker(undefined), /No Lokal tag payment/);
});
