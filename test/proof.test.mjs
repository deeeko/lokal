// The Proof page (site/assets/proof.js): payouts from the agent's transactions, attribution detection, matching each
// payout to its deposit (the agent's records first, then the contracts' events), totals, named users (a mismatched one
// is reported, never hidden) and that no address ever reaches a row. Fixture logs and transactions, no network.
import test from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, keccak256, toBytes } from "viem";
import * as P from "../site/assets/proof.js";
import { AGENT, TAG, TOKENS, USDT_ADDRESS, CURRENCIES, tagSuffix, receiptNo, abiEncode } from "../site/assets/core.js";
import { LOKAL_TAGS, LOKAL_POTS, LOKAL_TAGS_BLOCK, TOPIC } from "../site/assets/lokal-contracts.js";

const ADA = "0x2222222222222222222222222222222222222222";
const BOB = "0x4444444444444444444444444444444444444444";
const PAYER = "0x6666666666666666666666666666666666666666";
const CNGN = CURRENCIES[0].address, IDRX = CURRENCIES[1].address;
const h = (n) => "0x" + n.toString(16).padStart(64, "0");
const word = (a) => "0x" + a.slice(2).toLowerCase().padStart(64, "0");
const transfer = (to, units, tagged = true) => "0xa9059cbb" + abiEncode(["address", "uint256"], [to, BigInt(units)]) + (tagged ? tagSuffix() : "");
/** A Blockscout transaction item from the agent. */
const tx = (n, token, to, units, { tagged = true, block = LOKAL_TAGS_BLOCK + 100 + n, status = "ok", ts = "2026-11-22T10:00:00Z" } = {}) => ({
  hash: h(n), from: { hash: AGENT }, to: { hash: token }, method: "transfer", status, timestamp: ts, block_number: block, raw_input: transfer(to, units, tagged),
});
const tagPaid = (n, tag, recipient, token, amount, block) => ({
  address: LOKAL_TAGS, topics: [TOPIC.TagPaid, keccak256(toBytes(tag)), word(recipient), word(PAYER)],
  data: encodeAbiParameters([{ type: "string" }, { type: "address" }, { type: "uint256" }, { type: "bytes32" }, { type: "uint256" }], [tag, token, BigInt(amount), "0x" + "0".repeat(64), 20000n]),
  blockNumber: "0x" + block.toString(16), logIndex: "0x1", transactionHash: h(n),
});
const potPaid = (n, potId, host, token, amount, block) => ({
  address: LOKAL_POTS, topics: [TOPIC.PotPaid, "0x" + BigInt(potId).toString(16).padStart(64, "0"), word(host), word(PAYER)],
  data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint256" }], [token, BigInt(amount), "0x" + "0".repeat(64), BigInt(amount), BigInt(amount)]),
  blockNumber: "0x" + block.toString(16), logIndex: "0x2", transactionHash: h(n),
});

test("attribution detection: LokalPay's ERC-8021 tag at the end of the input", () => {
  const base = transfer(ADA, 1);
  assert.equal(P.hasAttribution(base), true);
  assert.equal(P.hasAttribution(transfer(ADA, 1, false)), false, "no suffix");
  assert.equal(P.hasAttribution(base.toUpperCase().replace("0X", "0x")), true, "hex case doesn't matter");
  // another app's code in the same suffix still counts when ours is listed
  const two = "other_app," + TAG;
  const hex = [...new TextEncoder().encode(two)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const marker = tagSuffix().slice(-32);
  assert.equal(P.hasAttribution(transfer(ADA, 1, false) + hex + two.length.toString(16).padStart(2, "0") + "00" + marker), true);
  // a different code, a broken marker, a non-zero schema, the tag text mid-input: not attributed
  const other = "celo_000000000000";
  const ohex = [...new TextEncoder().encode(other)].map((b) => b.toString(16).padStart(2, "0")).join("");
  assert.equal(P.hasAttribution(transfer(ADA, 1, false) + ohex + other.length.toString(16).padStart(2, "0") + "00" + marker), false);
  assert.equal(P.hasAttribution(base.slice(0, -2) + "00"), false);
  assert.equal(P.hasAttribution(base.slice(0, -34) + "01" + marker), false);
  assert.equal(P.hasAttribution(tagSuffix().slice(0, -32) + "00"), false);
  assert.equal(P.hasAttribution(""), false);
  assert.equal(P.hasAttribution(null), false);
});

test("payoutFromTx keeps only the agent's successful transfers of LokalPay tokens", () => {
  const p = P.payoutFromTx(tx(1, CNGN, ADA, 14_400_000_000n));
  assert.equal(p.hash, h(1));
  assert.equal(p.units, 14_400_000_000n);
  assert.equal(p.to, ADA);
  assert.equal(p.tagged, true);
  assert.equal(P.payoutFromTx(tx(2, CNGN, ADA, 1, { status: "error" })), null);
  assert.equal(P.payoutFromTx({ ...tx(3, CNGN, ADA, 1), raw_input: "0x095ea7b3" + "00".repeat(64) }), null, "an approve is not a payout");
  assert.equal(P.payoutFromTx(tx(4, "0x471EcE3750Da237f93B8E339c536989b8978a438", ADA, 1)), null, "CELO is not a payout token");
  assert.equal(P.payoutFromTx({ ...tx(5, CNGN, ADA, 1), from: { hash: BOB } }), null);
  assert.equal(P.payoutFromTx(tx(6, CNGN, ADA, 0)), null);
});

test("proof aggregation from fixture logs: matching, corridors, totals, no addresses", () => {
  const payouts = [
    tx(1, CNGN, ADA, 14_400_000_000n, { block: LOKAL_TAGS_BLOCK + 110, ts: "2026-11-22T10:00:00Z" }), // USD₮ -> naira, matched by chain
    tx(2, IDRX, BOB, 9_196_700n, { block: LOKAL_TAGS_BLOCK + 210, ts: "2026-11-23T10:00:00Z", tagged: false }), // USD₮ -> rupiah, agent record
    tx(3, USDT_ADDRESS, ADA, 9_500_000n, { block: LOKAL_TAGS_BLOCK + 310, ts: "2026-11-24T10:00:00Z" }), // cNGN -> dollars (pot)
    tx(4, CNGN, BOB, 7_000_000_000n, { block: LOKAL_TAGS_BLOCK + 410, ts: "2026-11-25T10:00:00Z" }), // no deposit found
  ].map(P.payoutFromTx);
  const deposits = [
    tagPaid(101, "ada", ADA, USDT_ADDRESS, 10_000_000n, LOKAL_TAGS_BLOCK + 105),
    tagPaid(102, "bob", BOB, USDT_ADDRESS, 5_000_000n, LOKAL_TAGS_BLOCK + 205),
    potPaid(103, 7, ADA, CNGN, 14_000_000_000n, LOKAL_TAGS_BLOCK + 305),
  ].map(P.depositFromLog);
  const events = [{ status: "paid", payoutTx: h(2), depositTx: h(102), token: "USDT", amount: "5", usd: 5 }];
  const m = P.proofModel({ payouts, deposits, events, users: [] });

  assert.deepEqual(m.rows.map((r) => r.receiptNo), [h(4), h(3), h(2), h(1)].map(receiptNo), "newest first");
  const [r4, r3, r2, r1] = m.rows;
  assert.deepEqual([r1.from, r1.to, r1.inText, r1.outText, r1.depositHash, r1.matchedBy, r1.kind, r1.usd, r1.tagged],
    ["USD₮", "naira", "10.00 USD₮", "₦14,400.00 cNGN", h(101), "chain", "tag", 10, true]);
  assert.deepEqual([r2.from, r2.to, r2.depositHash, r2.matchedBy, r2.usd, r2.tagged], ["USD₮", "rupiah", h(102), "agent", 5, false]);
  assert.match(r2.outText, /^Rp 91,967 IDRX$/);
  assert.deepEqual([r3.from, r3.to, r3.kind, r3.usd, r3.outText], ["cNGN", "dollars", "pot", 9.5, "9.50 USD₮"]);
  assert.deepEqual([r4.depositHash, r4.inText, r4.matchedBy, r4.usd], [null, null, null, null], "no deposit: said, not guessed");

  assert.deepEqual(m.totals, { payouts: 4, usd: 24.5, usdMissing: 1, currencies: ["USD₮", "cNGN", "IDRX"], recipients: 2, tagged: 3, team: 0 });

  // the builder's own test payouts: listed and labelled, but kept out of the headline totals
  // (the fixture hashes all share one receipt prefix, so give the payouts distinct ones here)
  const distinct = payouts.map((p, i) => ({ ...p, hash: "0x" + String(i + 1).repeat(8) + p.hash.slice(10) }));
  const teamNo = receiptNo(distinct[1].hash); // the rupiah payout
  const t = P.proofModel({ payouts: distinct, deposits, events: [], users: [], team: [teamNo, "not-a-receipt"] });
  assert.equal(t.rows.find((r) => r.receiptNo === teamNo).team, true);
  assert.equal(t.rows.filter((r) => r.team).length, 1, "only the listed receipt is a team test");
  assert.equal(t.totals.team, 1);
  assert.equal(t.totals.payouts, 3, "the team test isn't counted in the payouts");
  assert.ok(!t.totals.currencies.includes("IDRX"), "nor its currency");
  const dump = JSON.stringify(m, (k, v) => (typeof v === "bigint" ? String(v) : v)).toLowerCase();
  for (const a of [ADA, BOB, PAYER]) assert.ok(!dump.includes(a.slice(2).toLowerCase()), "no address in the model");
});

test("a deposit pays one payout only, and unreadable deposits leave rows unmatched", () => {
  const payouts = [tx(1, CNGN, ADA, 1e9, { block: LOKAL_TAGS_BLOCK + 110 }), tx(2, CNGN, ADA, 1e9, { block: LOKAL_TAGS_BLOCK + 120 })].map(P.payoutFromTx);
  const deposits = [tagPaid(101, "ada", ADA, USDT_ADDRESS, 1e6, LOKAL_TAGS_BLOCK + 105)].map(P.depositFromLog);
  const m = P.proofModel({ payouts, deposits });
  assert.deepEqual(m.rows.map((r) => r.depositHash), [null, h(101)]);
  const none = P.proofModel({ payouts, deposits: null });
  assert.deepEqual(none.rows.map((r) => r.depositHash), [null, null]);
  // a deposit after the payout can't be what it paid
  const late = P.proofModel({ payouts: payouts.slice(0, 1), deposits: [tagPaid(9, "ada", ADA, USDT_ADDRESS, 1e6, LOKAL_TAGS_BLOCK + 500)].map(P.depositFromLog) });
  assert.equal(late.rows[0].depositHash, null);
});

test("named users: shown only on a matching payout; a mismatched one is reported", () => {
  const payouts = [tx(1, CNGN, ADA, 14_400_000_000n)].map(P.payoutFromTx);
  const real = receiptNo(h(1));
  const users = [
    { receiptNo: real, label: "Ada", city: "Lagos", usedFor: "school fees" },
    { receiptNo: "NP-DEAD-BEEF", label: "Made up", city: "Nowhere", usedFor: "nothing" },
    { receiptNo: real, label: "Second claim" },
    { label: "No receipt" },
    "junk",
  ];
  const m = P.proofModel({ payouts, deposits: [], users });
  assert.deepEqual(m.rows[0].user, { receiptNo: real, label: "Ada", city: "Lagos", usedFor: "school fees" });
  assert.equal(m.users.matched.length, 1);
  assert.equal(m.users.mismatched.length, 4);
  assert.match(m.users.mismatched[0].reason, /No payout read from Celo has the receipt number NP-DEAD-BEEF/);
  assert.match(m.users.mismatched[1].reason, /already named/);
  assert.match(m.users.mismatched[2].reason, /right shape/);
  // with no payouts at all, every entry is a mismatch (the empty page still shows it)
  const empty = P.proofModel({ payouts: [], users: [users[0]] });
  assert.equal(empty.rows.length, 0);
  assert.equal(empty.users.mismatched.length, 1);
  assert.deepEqual(empty.totals, { payouts: 0, usd: 0, usdMissing: 0, currencies: [], recipients: 0, tagged: 0, team: 0 });
  assert.equal(P.userEntryOk({ receiptNo: real, label: "x".repeat(61) }), false);
  assert.equal(P.userEntryOk({ receiptNo: real, label: "Ada", city: 5 }), false);
});

test("loadProof reads pages, deposits and status records, and survives a missing users file", async () => {
  const pages = [
    { items: [tx(1, CNGN, ADA, 1e9), { hash: h(9), from: { hash: AGENT }, to: { hash: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" }, status: "ok", raw_input: "0x1234" }], next: { page: 2 } },
    { items: [tx(2, USDT_ADDRESS, BOB, 5e6)], next: null },
  ];
  let i = 0;
  const seen = [];
  const fetchJson = async (url, init) => {
    seen.push(url);
    if (url === "proof-users.json") throw new Error("404");
    const { params } = JSON.parse(init.body);
    assert.ok([TOPIC.TagPaid, TOPIC.PotPaid].includes(params[0].topics[0]));
    return { result: params[0].topics[0] === TOPIC.TagPaid ? [tagPaid(101, "ada", ADA, USDT_ADDRESS, 1e6, LOKAL_TAGS_BLOCK + 1)] : [] };
  };
  const asked = [];
  const r = await P.loadProof({ txPage: async () => pages[i++], fetchJson, statusFor: async (who) => { asked.push(who); return { events: [] }; } });
  assert.equal(r.payouts.length, 2);
  assert.equal(r.complete, true);
  assert.equal(r.checked, 3);
  assert.equal(r.users, null);
  assert.equal(r.deposits.length, 1);
  assert.deepEqual(asked.sort(), [ADA, BOB].map((a) => a.toLowerCase()).sort());

  // no payouts yet: nothing else is read, and the empty state is honest
  const none = await P.loadProof({ txPage: async () => ({ items: [], next: null }), fetchJson: async (url) => (url === "proof-users.json" ? [] : assert.fail("no log reads")) });
  assert.deepEqual([none.payouts.length, none.users, none.complete], [0, [], true]);
  // a page limit reached is reported as incomplete
  const many = await P.loadProof({ maxPages: 1, txPage: async () => ({ items: [], next: { page: 2 } }), fetchJson: async () => [] });
  assert.equal(many.complete, false);
  // the agent's transactions can't be read at all: it throws (the page says so, never "no payouts")
  await assert.rejects(P.loadProof({ txPage: async () => { throw new Error("down"); }, fetchJson: async () => [] }));
});

test("site/proof-users.json is a valid list of consented named users", async () => {
  const fs = await import("node:fs");
  const users = JSON.parse(fs.readFileSync(new URL("../site/proof-users.json", import.meta.url), "utf8"));
  assert.ok(Array.isArray(users));
  for (const u of users) assert.ok(P.userEntryOk(u), JSON.stringify(u));
  assert.equal(new Set(users.map((u) => u.receiptNo)).size, users.length, "one entry per receipt");
});

test("the TOKENS registry covers every payout token the proof page reads", () => {
  for (const c of CURRENCIES) assert.ok(Object.values(TOKENS).some((t) => t.address === c.address), c.code);
});
