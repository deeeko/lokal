// Autopilot's nTag branch: how a deposit with an "NTP:<tag>" transfer memo is classified (pure, no RPC, no files).
import test from "node:test";
import assert from "node:assert/strict";
import { AGENT_ADDRESS, TOKENS } from "../src/config.mjs";
import { decodeNtagMemo, encodeNtagTransfer, looksLikeNtagAttempt, stripValidErc8021, tagSuffix } from "../src/ntags.mjs";
import { classifyNtagDeposit, NTAG_BAD_MEMO, NTAG_MIN, ntagCorridor, ntagPayAmount, ntagUsdFloor } from "../src/watch.mjs";

const ADA = "0x2222222222222222222222222222222222222222";
const BOB = "0x3333333333333333333333333333333333333333";
const PAYER = "0x4444444444444444444444444444444444444444";
const USDT = TOKENS.USDT.address;
const CNGN = TOKENS.CNGN.address;
const h = (n) => "0x" + n.toString(16).padStart(64, "0");
const op = (n, from, block, position, body, time = 1_700_000_000 + block) => ({ hash: h(n), from, block, position, time, value: "0", op: body });

/** A deposit of `units` of `token` by PAYER at (block, position) carrying a memo for `tag`. */
function dep({ tag = "ada", token = USDT, units = 5_000_000n, block = 100, position = 3, key = `${h(999)}:7`, tx } = {}) {
  return {
    key, tag, token, value: units, payer: PAYER, block, position,
    tx: tx ?? { from: PAYER, to: token, input: encodeNtagTransfer(AGENT_ADDRESS, units, tag) },
  };
}

test("corridor by deposited token: USDT pays naira, cNGN pays dollars, anything else none", () => {
  assert.equal(ntagCorridor(USDT), "usdt-cngn");
  assert.equal(ntagCorridor(USDT.toLowerCase()), "usdt-cngn");
  assert.equal(ntagCorridor(CNGN), "cngn-usdt");
  assert.equal(ntagCorridor(ADA), null);
  assert.equal(ntagCorridor(undefined), null);
});

test("pay amount: whole deposit at 6 decimals; rounding down to fewer places keeps the dust, never pays more", () => {
  assert.deepEqual(ntagPayAmount(1_234_567n), { amount: "1.234567", units: 1_234_567n, dust: 0n });
  assert.deepEqual(ntagPayAmount(5_000_000n), { amount: "5", units: 5_000_000n, dust: 0n });
  assert.deepEqual(ntagPayAmount(1_234_567n, 2), { amount: "1.23", units: 1_230_000n, dust: 4_567n });
  assert.deepEqual(ntagPayAmount(999n, 2), { amount: "0", units: 0n, dust: 999n });
  for (const u of [1n, 9_999n, 10_001n, 25_000_000n, 1_999_999n]) {
    for (const p of [0, 2, 6]) {
      const r = ntagPayAmount(u, p);
      assert.ok(r.units <= u && r.units + r.dust === u);
    }
  }
});

test("owner known before the deposit: paid to the owner, with the winning claim op", () => {
  const ops = [op(1, ADA, 50, 0, { t: "ada", n: "Ada Obi" }), op(2, BOB, 60, 1, { t: "bob" })];
  const d = classifyNtagDeposit(dep(), ops, {}, AGENT_ADDRESS);
  assert.equal(d.action, "pay");
  assert.equal(d.entry.owner, ADA.toLowerCase());
  assert.equal(d.entry.name, "Ada Obi");
  assert.equal(d.op, ops[0]);
  assert.equal(d.corridor, "usdt-cngn");
  assert.equal(d.amount, "5");
  assert.equal(d.dust, 0n);
  const c = classifyNtagDeposit(dep({ token: CNGN, units: 15_000_000_000n }), ops, {}, AGENT_ADDRESS);
  assert.equal(c.action, "pay");
  assert.equal(c.corridor, "cngn-usdt");
  assert.equal(c.amount, "15000");
});

test("a recorded deposit is never handled twice", () => {
  const ops = [op(1, ADA, 50, 0, { t: "ada" })];
  const d = dep();
  assert.deepEqual(classifyNtagDeposit(d, ops, { [d.key]: { tag: "ada" } }, AGENT_ADDRESS), { action: "handled", record: { tag: "ada" } });
  const refused = { status: "refused", reason: "unknown Lokal tag" };
  assert.deepEqual(classifyNtagDeposit(d, ops, { [d.key]: refused }, AGENT_ADDRESS), { action: "handled", record: refused });
});

test("owner is resolved strictly before the deposit's (block, position)", () => {
  // Claimed in the same block AFTER the deposit: unknown at deposit time.
  assert.deepEqual(classifyNtagDeposit(dep(), [op(1, ADA, 100, 4, { t: "ada" })], {}, AGENT_ADDRESS), { action: "refuse", reason: "unknown Lokal tag" });
  // Same tx position is not "before".
  assert.equal(classifyNtagDeposit(dep(), [op(1, ADA, 100, 3, { t: "ada" })], {}, AGENT_ADDRESS).action, "refuse");
  // Earlier in the same block: known.
  assert.equal(classifyNtagDeposit(dep(), [op(1, ADA, 100, 2, { t: "ada" })], {}, AGENT_ADDRESS).action, "pay");
  // Released before the deposit: unknown. Released after: still Ada's at deposit time.
  const claim = op(1, ADA, 50, 0, { t: "ada" });
  assert.equal(classifyNtagDeposit(dep(), [claim, op(2, ADA, 99, 0, { t: "" })], {}, AGENT_ADDRESS).reason, "unknown Lokal tag");
  assert.equal(classifyNtagDeposit(dep(), [claim, op(2, ADA, 101, 0, { t: "" })], {}, AGENT_ADDRESS).entry.owner, ADA.toLowerCase());
  // Ada moved to another tag before the deposit: "ada" has no owner.
  assert.equal(classifyNtagDeposit(dep(), [claim, op(2, ADA, 70, 0, { t: "ada_ng" })], {}, AGENT_ADDRESS).reason, "unknown Lokal tag");
  // A later claim by someone else (taken) never changes the owner.
  const d = classifyNtagDeposit(dep(), [claim, op(2, BOB, 60, 0, { t: "ada" })], {}, AGENT_ADDRESS);
  assert.equal(d.entry.owner, ADA.toLowerCase());
  assert.equal(d.op.hash, claim.hash);
});

test("a rename keeps paying the original claim's owner and points at the original claim", () => {
  const claim = op(1, ADA, 50, 0, { t: "ada" });
  const d = classifyNtagDeposit(dep(), [claim, op(2, ADA, 60, 0, { t: "ada", n: "Ada" })], {}, AGENT_ADDRESS);
  assert.equal(d.op.hash, claim.hash);
  assert.equal(d.entry.name, "Ada");
});

test("no ops at all, or only invalid ones: unknown nTag, never paid", () => {
  assert.equal(classifyNtagDeposit(dep(), [], {}, AGENT_ADDRESS).reason, "unknown Lokal tag");
  const bad = [op(1, ADA, 50, 0, { t: "Ada" }), { ...op(2, ADA, 51, 0, { t: "ada" }), value: "1" }, op(3, AGENT_ADDRESS, 52, 0, { t: "ada" })];
  assert.equal(classifyNtagDeposit(dep(), bad, {}, AGENT_ADDRESS).reason, "unknown Lokal tag");
});

test("the memo must describe this very transfer", () => {
  const ops = [op(1, ADA, 50, 0, { t: "ada" })];
  const good = dep();
  const mismatch = { action: "refuse", reason: "the Lokal tag memo does not match this transfer" };
  // tx sent to some other contract, not the token that emitted the Transfer
  assert.deepEqual(classifyNtagDeposit({ ...good, tx: { ...good.tx, to: ADA } }, ops, {}, AGENT_ADDRESS), mismatch);
  // memo transfer amount differs from the deposit
  assert.deepEqual(classifyNtagDeposit({ ...good, tx: { ...good.tx, input: encodeNtagTransfer(AGENT_ADDRESS, 4_000_000n, "ada") } }, ops, {}, AGENT_ADDRESS), mismatch);
  // memo transfer goes to someone other than the agent
  assert.deepEqual(classifyNtagDeposit({ ...good, tx: { ...good.tx, input: encodeNtagTransfer(BOB, 5_000_000n, "ada") } }, ops, {}, AGENT_ADDRESS), mismatch);
  // tx sender is not the Transfer's sender (e.g. a transferFrom)
  assert.deepEqual(classifyNtagDeposit({ ...good, tx: { ...good.tx, from: BOB } }, ops, {}, AGENT_ADDRESS), mismatch);
  // junk input
  assert.deepEqual(classifyNtagDeposit({ ...good, tx: { ...good.tx, input: "0x" } }, ops, {}, AGENT_ADDRESS), mismatch);
  // unknown token
  assert.equal(classifyNtagDeposit({ ...good, token: ADA, tx: { ...good.tx, to: ADA } }, ops, {}, AGENT_ADDRESS).reason, "token not accepted for Lokal tag payments");
});

test("deposits below the minimum are refused, not paid", () => {
  const ops = [op(1, ADA, 50, 0, { t: "ada" })];
  assert.equal(classifyNtagDeposit(dep({ units: 999_999n }), ops, {}, AGENT_ADDRESS).action, "refuse");
  assert.equal(classifyNtagDeposit(dep({ units: 1_000_000n }), ops, {}, AGENT_ADDRESS).action, "pay");
  const minCngn = BigInt(NTAG_MIN["cngn-usdt"]) * 1_000_000n;
  assert.equal(classifyNtagDeposit(dep({ token: CNGN, units: minCngn - 1n }), ops, {}, AGENT_ADDRESS).action, "refuse");
  assert.equal(classifyNtagDeposit(dep({ token: CNGN, units: minCngn }), ops, {}, AGENT_ADDRESS).action, "pay");
});

test("cNGN floor: a live preview under $1 is a permanent refusal; no price is left to preflight; USDT is not checked", async () => {
  const calls = [];
  const pv = (buyAmount, status = "preview") => async (...a) => { calls.push(a); return { status, buyAmount }; };
  await assert.rejects(ntagUsdFloor("cngn-usdt", 1_200_000_000n, pv("999999")), (e) => e.permanent === true && /below/.test(e.message));
  await ntagUsdFloor("cngn-usdt", 1_600_000_000n, pv("1000000"));
  await ntagUsdFloor("cngn-usdt", 1_600_000_000n, pv(undefined, "unavailable"));
  assert.deepEqual(calls[0], [CNGN, USDT, "1200000000"]);
  const n = calls.length;
  await ntagUsdFloor("usdt-cngn", 1_000_000n, pv("1"));
  assert.equal(calls.length, n);
});

test("the site's transfer data decodes to the tag autopilot pays", () => {
  const data = encodeNtagTransfer(AGENT_ADDRESS, 12_340_000n, "ada_ng");
  assert.equal(decodeNtagMemo(data), "ada_ng");
  const d = classifyNtagDeposit(dep({ tag: decodeNtagMemo(data), units: 12_340_000n, tx: { from: PAYER, to: USDT, input: data } }),
    [op(1, BOB, 10, 0, { t: "ada_ng" })], {}, AGENT_ADDRESS);
  assert.equal(d.action, "pay");
  assert.equal(d.amount, "12.34");
  assert.equal(d.entry.owner, BOB.toLowerCase());
});

test("nTag attempts: the NTP: bytes anywhere, or a transfer with extra bytes; plain transfers are not attempts", () => {
  const hex = (s) => Buffer.from(s, "utf8").toString("hex");
  const w = (v) => BigInt(v).toString(16).padStart(64, "0");
  const plain = "0xa9059cbb" + w(AGENT_ADDRESS) + w(5_000_000n);
  assert.equal(looksLikeNtagAttempt(plain), false);
  assert.equal(looksLikeNtagAttempt(plain + tagSuffix()), false, "a valid ERC-8021 suffix is not a memo");
  assert.equal(looksLikeNtagAttempt(plain.toUpperCase().replace("0XA9059CBB", "0xa9059cbb")), false);
  assert.equal(looksLikeNtagAttempt("0x"), false);
  assert.equal(looksLikeNtagAttempt(undefined), false);
  assert.equal(looksLikeNtagAttempt("0x23b872dd" + w(PAYER) + w(AGENT_ADDRESS) + w(1n)), false, "transferFrom without a memo");
  for (const bad of ["NTP:Ada", "NTP:@ada", "NTP:pay", "NTP:ada\n", "NTP:"]) assert.equal(looksLikeNtagAttempt(plain + hex(bad)), true, bad);
  assert.equal(looksLikeNtagAttempt(plain + "deadbeef"), true, "non-ERC-8021 bytes after the transfer");
  assert.equal(looksLikeNtagAttempt(plain + "00".repeat(5) + "80218021802180218021802180218021"), true, "broken suffix");
  assert.equal(looksLikeNtagAttempt("0x6a761202" + "00".repeat(64) + encodeNtagTransfer(AGENT_ADDRESS, 1n, "ada").slice(2)), true, "inside a smart-wallet call");
  assert.equal(looksLikeNtagAttempt("0x1234" + hex("ntp:").toUpperCase() + "4E54503A"), true, "case-insensitive hex");
  assert.equal(looksLikeNtagAttempt(encodeNtagTransfer(AGENT_ADDRESS, 1n, "ada")), true, "a valid memo is an attempt too");
  // Suffix parsing: valid one stripped, junk refused.
  assert.equal(stripValidErc8021(plain + tagSuffix()), plain.slice(2));
  assert.equal(stripValidErc8021(plain), plain.slice(2));
  assert.equal(stripValidErc8021(plain + "ff" + "01" + "00" + "80218021802180218021802180218021"), null, "non-printable code");
  assert.equal(stripValidErc8021(plain + hex("ab") + "02" + "01" + "80218021802180218021802180218021"), null, "schema 1");
  assert.equal(stripValidErc8021("ff" + "80218021802180218021802180218021"), null, "too short");
});

test("a memo that does not decode is refused before anything else; a missing nTag list holds instead of refusing", () => {
  const ops = [op(1, ADA, 50, 0, { t: "ada" })];
  assert.deepEqual(classifyNtagDeposit(({ ...dep(), tag: null }), ops, {}, AGENT_ADDRESS), { action: "refuse", reason: NTAG_BAD_MEMO });
  assert.deepEqual(classifyNtagDeposit(({ ...dep(), tag: null }), null, {}, AGENT_ADDRESS), { action: "refuse", reason: NTAG_BAD_MEMO });
  // Valid memo, list not loaded: hold (never "unknown Lokal tag", which would be recorded as refused).
  assert.deepEqual(classifyNtagDeposit(dep(), null, {}, AGENT_ADDRESS), { action: "hold" });
  // Refusals that need no list still happen without it.
  assert.equal(classifyNtagDeposit(dep({ units: 1n }), null, {}, AGENT_ADDRESS).action, "refuse");
  assert.equal(classifyNtagDeposit({ ...dep(), tx: { ...dep().tx, from: BOB } }, null, {}, AGENT_ADDRESS).action, "refuse");
  // Already recorded wins over everything.
  assert.equal(classifyNtagDeposit(({ ...dep(), tag: null }), null, { [dep().key]: { status: "refused" } }, AGENT_ADDRESS).action, "handled");
});
