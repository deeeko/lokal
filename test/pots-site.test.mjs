// Pots on the site (site/assets/pots.js, the LokalPots parts of site/assets/lokal-contracts.js and the gating in
// site/assets/front-door.js): calldata against the verified ABI, refusals in plain English, the title rules the
// contract enforces, caps and closing times, pot ids in links, the Spray Wall's rows (never a payer address), reading
// the logs (explorer first, then the chain) and who may open, see and close a pot. No network.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { decodeFunctionData, encodeAbiParameters, encodeErrorResult, encodeEventTopics, toFunctionSelector } from "viem";
import * as C from "../site/assets/lokal-contracts.js";
import * as P from "../site/assets/pots.js";
import { PUBLIC_PAGES, SIGNED_IN_PAGES, potsView, canClosePot } from "../site/assets/front-door.js";
import { tagSuffix, TOKENS, AGENT } from "../site/assets/core.js";

const potsAbi = JSON.parse(fs.readFileSync(new URL("../contracts/deployments/LokalPots.json", import.meta.url), "utf8")).abi;
const SUFFIX = tagSuffix();
const HOST = "0x2222222222222222222222222222222222222222";
const GUEST = "0x4444444444444444444444444444444444444444";
const USDT = TOKENS.USDT.address;
const CNGN = TOKENS.cNGN.address;
const NOW = 1_795_000_000;
const decodePots = (data) => {
  assert.ok(data.endsWith(SUFFIX), "the attribution suffix is appended");
  return decodeFunctionData({ abi: potsAbi, data: data.slice(0, -SUFFIX.length) });
};
const err = (name, args = []) => encodeErrorResult({ abi: potsAbi, errorName: name, args });

test("pot calldata: createPot, payPot and closePot decode with the verified ABI, each with the attribution suffix", () => {
  for (const name of ["createPot", "closePot", "payPot", "potInfo", "remaining", "validatePotPayment", "unitsPerUsd", "potCount", "maxPotCapUsd6", "maxPerPayerCapUsd6"]) {
    assert.equal(C.FN[name], toFunctionSelector(potsAbi.find((x) => x.type === "function" && x.name === name)), name);
  }
  let d = decodePots(C.createPotData({ title: "Ada & Tunde's wedding 💍", closesAt: NOW + 86_400, potCapUsd6: 100_000_000n, perPayerCapUsd6: 5_000_000n }));
  assert.equal(d.functionName, "createPot");
  assert.deepEqual(d.args, ["Ada & Tunde's wedding 💍", BigInt(NOW + 86_400), 100_000_000n, 5_000_000n]);
  d = decodePots(C.payPotData({ potId: 7n, token: CNGN, amount: 2_882_000_000n, ref: C.currencyRef("cngn") }));
  assert.equal(d.functionName, "payPot");
  assert.deepEqual([d.args[0], d.args[1].toLowerCase(), d.args[2], d.args[3], d.args[4].toLowerCase()],
    [7n, CNGN.toLowerCase(), 2_882_000_000n, C.currencyRef("cngn"), AGENT.toLowerCase()], "pins the agent as payout wallet");
  assert.equal(C.currencyOfRef(d.args[3]), "cngn");
  d = decodePots(C.closePotData(7n));
  assert.deepEqual([d.functionName, d.args[0]], ["closePot", 7n]);
  // what the wallet approves first: exactly the amount, for LokalPots (not LokalTags)
  const ap = C.approveData(C.LOKAL_POTS, 2_000_000n);
  assert.ok(ap.startsWith(C.FN.approve + "000000000000000000000000" + C.LOKAL_POTS.slice(2).toLowerCase()));
  assert.throws(() => C.createPotData({ title: "", closesAt: NOW, potCapUsd6: 1n, perPayerCapUsd6: 1n }), /invalid title/);
  assert.throws(() => C.createPotData({ title: "x", closesAt: 0, potCapUsd6: 1n, perPayerCapUsd6: 1n }), /closing time/);
  assert.throws(() => C.createPotData({ title: "x", closesAt: NOW, potCapUsd6: 0n, perPayerCapUsd6: 1n }), /invalid amount/);
  assert.throws(() => C.closePotData(0n), /invalid pot id/);
  assert.throws(() => C.payPotData({ potId: 0n, token: USDT, amount: 1n }), /invalid pot id/);
  assert.equal(C.POT_MAX_OPEN_SECONDS, 14 * 86_400);
  assert.equal(C.POT_TITLE_MAX_BYTES, 60);
});

test("pot refusals in plain English: creating, spraying and closing", () => {
  const say = (name, args = [], ctx = { potId: 3n, token: USDT }) => C.explainRevert(err(name, args), ctx).message;
  assert.match(say("InvalidTitle", [], { creating: true }), /title isn't allowed: 1-60 characters/);
  assert.match(say("InvalidCloseTime", [1n, 1_800_000_000n], { creating: true }), /no later than .*2027/);
  assert.match(say("InvalidPotCaps", [], { creating: true }), /per-guest cap must be more than \$0/);
  assert.match(say("HostNotEligible", [HOST], { creating: true }), /holds a LokalPay tag can open a pot/);
  assert.match(say("HostNotEligible", [HOST]), /host can't be paid right now/);
  assert.match(say("PotFull", [3_000_000n, 1_250_000n]), /can take \$1\.25 more/);
  assert.match(say("OverPayerCap", [3_000_000n, 500_000n]), /\$0\.50 more into this pot/);
  assert.match(say("OverHostDailyLimit", [3_000_000n, 2_000_000n]), /host's pots can take \$2\.00 more today/);
  assert.match(say("OverDailyLimit", [3_000_000n, 0n]), /All pots together have reached today's total/);
  assert.match(say("PotIsClosed", [3n]), /host closed this pot/);
  assert.match(say("PotExpired", [3n, 1_795_000_000n]), /This pot closed at/);
  assert.match(say("PotNotFound", [3n]), /no pot with that number/);
  assert.match(say("SelfPayment"), /You host this pot/);
  assert.match(say("NotHost"), /Only the pot's host/);
  assert.match(say("Paused"), /paused/);
  assert.match(say("BelowMinimum", [500_000n, 1_000_000n]), /smallest payment in USD₮ is \$1\.00/);
  for (const name of ["InvalidTitle", "InvalidCloseTime", "InvalidPotCaps"]) assert.equal(C.decodeRevert(err(name, name === "InvalidCloseTime" ? [1n, 2n] : [])).name, name);
});

test("potInfo and PotCreated decode into what the pages show", () => {
  const info = C.decodePotInfo(encodeAbiParameters(
    ["address", "string", "uint256", "bool", "uint256", "uint256", "uint256", "uint256"].map((type) => ({ type })),
    [HOST, "Ada & Tunde's wedding", BigInt(NOW + 3600), true, 100_000_000n, 5_000_000n, 42_000_000n, 12n]));
  assert.deepEqual({ ...info, host: info.host.toLowerCase() },
    { host: HOST, title: "Ada & Tunde's wedding", closesAt: NOW + 3600, open: true, capUsd6: 100_000_000n, perPayerCapUsd6: 5_000_000n, totalUsd6: 42_000_000n, payerCount: 12 });
  const ev = potsAbi.find((x) => x.type === "event" && x.name === "PotCreated");
  const topics = encodeEventTopics({ abi: [ev], eventName: "PotCreated", args: { potId: 9n, host: HOST } });
  const data = encodeAbiParameters(ev.inputs.filter((i) => !i.indexed), ["Bisi at 30", BigInt(NOW + 86_400), 50_000_000n, 2_000_000n]);
  const created = C.decodePotCreated({ topics, data, transactionHash: "0x" + "ab".repeat(32), blockNumber: "0x10" });
  assert.deepEqual([created.potId, created.host.toLowerCase(), created.title, created.closesAt, created.capUsd6, created.perPayerCapUsd6, created.block],
    [9n, HOST, "Bisi at 30", NOW + 86_400, 50_000_000n, 2_000_000n, 16]);
  assert.equal(C.decodePotCreated({ topics: [C.TOPIC.PotPaid], data: "0x" }), null);
  assert.equal(C.topicOf(9n), "0x" + "9".padStart(64, "0"));
  assert.equal(C.topicOf(HOST), "0x" + HOST.slice(2).padStart(64, "0"));
});

test("the title follows the contract's rules (60 bytes and 60 UTF-16 units, no control or invisible characters, trimmed)", () => {
  assert.equal(P.potTitleError("Ada & Tunde's wedding"), null);
  assert.equal(P.potTitleError("  Ada & Tunde  "), null, "edge spaces are trimmed before sending");
  assert.equal(P.cleanTitle("  Ada & Tunde  "), "Ada & Tunde");
  assert.equal(P.potTitleError("x".repeat(60)), null);
  assert.match(P.potTitleError("x".repeat(61)), /too long/);
  assert.equal(P.potTitleError("💍".repeat(15)), null, "15 emoji = 60 bytes");
  assert.match(P.potTitleError("💍".repeat(16)), /too long/, "64 bytes");
  assert.match(P.potTitleError("Àdùkẹ́ ".repeat(6)), /too long/, "accented letters take two or three bytes");
  assert.match(P.potTitleError(""), /Give the pot a title/);
  assert.match(P.potTitleError("   "), /Give the pot a title/);
  assert.match(P.potTitleError("Ada\nTunde"), /control characters/);
  assert.match(P.potTitleError("Ada​Tunde"), /invisible/);
  assert.match(P.potTitleError("Ada‮Tunde"), /invisible/);
  assert.match(P.potTitleError("Ada \ud83d"), /broken character/);
  assert.equal(P.titleRoom("Ada"), 57);
  assert.equal(P.titleRoom("💍"), 56, "the stricter count (4 bytes)");
});

test("dollars, caps and closing times: within the contract's maxima, on the chain's clock", () => {
  assert.deepEqual(P.parseUsd6("5"), { usd6: 5_000_000n });
  assert.deepEqual(P.parseUsd6("$2.50"), { usd6: 2_500_000n });
  assert.ok(P.parseUsd6("2.555").error);
  assert.equal(P.usd6Text(100_000_000n), "$100");
  assert.equal(P.usd6Text(2_500_000n), "$2.50");
  assert.equal(P.usd6Text(1_250_000_000n), "$1,250");
  assert.equal(P.usd6Text(5_000_000n, { cents: "always" }), "$5.00");
  assert.equal(P.usd6Text(1_999_999n), "$1.99", "rounded down");
  const L = { maxPotCapUsd6: 100_000_000n, maxPerPayerCapUsd6: 5_000_000n };
  assert.equal(P.capsError({ potCapUsd6: 100_000_000n, perPayerCapUsd6: 5_000_000n }, L), null);
  assert.equal(P.capsError({ potCapUsd6: 3_000_000n, perPayerCapUsd6: 3_000_000n }, L), null);
  assert.equal(P.capsError({ potCapUsd6: 101_000_000n, perPayerCapUsd6: 5_000_000n }, L).field, "cap");
  assert.match(P.capsError({ potCapUsd6: 0n, perPayerCapUsd6: 5_000_000n }, L).message, /in total/);
  assert.match(P.capsError({ potCapUsd6: 50_000_000n, perPayerCapUsd6: 6_000_000n }, L).message, /up to \$5/);
  assert.match(P.capsError({ potCapUsd6: 50_000_000n, perPayerCapUsd6: 500_000n }, L).message, /at least \$1/);
  assert.match(P.capsError({ potCapUsd6: 2_000_000n, perPayerCapUsd6: 3_000_000n }, L).message, /can't be more than the pot's total/);
  // closing: presets from the chain's clock, never past the contract's 14 days
  assert.equal(P.closesAtFor({ preset: "1d" }, NOW), NOW + 86_400);
  assert.equal(P.closesAtFor({ preset: "14d" }, NOW), NOW + 14 * 86_400 - 120);
  assert.equal(P.closesAtFor(null, NOW), NOW + 14 * 86_400 - 120, "no choice: the longest");
  assert.equal(P.closesAtFor({ at: NOW + 7200 }, NOW), NOW + 7200);
  assert.equal(P.closesAtFor({ at: NOW + 20 * 86_400 }, NOW), NOW + 14 * 86_400 - 120);
  assert.equal(P.closeTimeError(NOW + 3600, NOW), null);
  assert.match(P.closeTimeError(NOW + 60, NOW), /10 minutes/);
  assert.match(P.closeTimeError(NOW + 15 * 86_400, NOW), /14 days/);
  assert.match(P.closeTimeError(NaN, NOW), /Pick a date/);
  assert.match(P.closeText(NOW), /WAT$/);
});

test("pot ids in links: pot.html?id=N, #N or #id=N, and nothing else", () => {
  assert.equal(P.potIdFrom({ search: "?id=12" }), 12n);
  assert.equal(P.potIdFrom({ hash: "#12" }), 12n);
  assert.equal(P.potIdFrom({ hash: "#id=3" }), 3n);
  assert.equal(P.potIdFrom({ search: "?id=12", hash: "#9" }), 12n, "the query wins");
  for (const bad of ["?id=0", "?id=012", "?id=-1", "?id=1e3", "?id=abc", "?id=", "", "?id=12345678901234567890", "?id= 5x"]) {
    assert.equal(P.potIdFrom({ search: bad }), null, bad);
  }
  assert.equal(P.potUrl(12n, "https://lokalpay.vercel.app/app.html#pots"), "https://lokalpay.vercel.app/pot.html?id=12");
  assert.equal(P.potUrl(12n, "https://deeeko.github.io/lokal/app.html"), "https://deeeko.github.io/lokal/pot.html?id=12");
  assert.equal(P.potUrl(5, null), "pot.html?id=5");
  assert.match(P.potWhatsappUrl("Ada & Tunde", "https://x/pot.html?id=1"), /^https:\/\/wa\.me\/\?text=Ada%20%26%20Tunde/);
});

test("a pot's state, progress and time left", () => {
  const info = { open: true, closesAt: NOW + 3 * 86_400 + 4 * 3600, capUsd6: 100_000_000n, totalUsd6: 42_000_000n };
  assert.equal(P.potState(info, NOW), "open");
  assert.equal(P.potState({ ...info, totalUsd6: 100_000_000n }, NOW), "full");
  assert.equal(P.potState({ ...info, open: false }, NOW), "closed");
  assert.equal(P.potState({ ...info, open: false }, info.closesAt), "ended");
  assert.equal(P.potState(info, info.closesAt + 1), "ended", "past its time even if the last read said open");
  assert.equal(P.potProgress(info), 0.42);
  assert.equal(P.potProgress({ ...info, totalUsd6: 150_000_000n }), 1);
  assert.equal(P.potProgress({ capUsd6: 0n, totalUsd6: 0n }), 0);
  assert.equal(P.timeLeftText(info.closesAt, NOW), "3 days 4 h left");
  assert.equal(P.timeLeftText(NOW + 3 * 3600 + 12 * 60, NOW), "3 h 12 min left");
  assert.equal(P.timeLeftText(NOW + 86_400, NOW), "1 day left");
  assert.equal(P.timeLeftText(NOW + 125, NOW), "2 min left");
  assert.equal(P.timeLeftText(NOW + 30, NOW), "Under a minute left");
  assert.equal(P.timeLeftText(NOW, NOW), null);
});

test("a guest's spray: the smallest room binds, the contract's rounding is matched, refusals before the wallet opens", () => {
  const rem = { forPayer: 5_000_000n, forPot: 3_000_000n, forHost: 80_000_000n, forToday: 200_000_000n };
  assert.deepEqual(P.sprayRoom(rem), { room: 3_000_000n, why: "pot" });
  const fmt = (u) => C.tokenAmountText(u, USDT);
  const limits = { min: 1_000_000n, max: 25_000_000n };
  const e = (units, room = P.sprayRoom(rem)) => P.sprayError({ units, usd6: units, limits, room, fmt });
  assert.equal(e(2_000_000n), null);
  assert.match(e(500_000n), /smallest spray is \$1\.00/);
  assert.match(e(4_000_000n), /This pot can take \$3 more/);
  assert.match(e(4_000_000n, { room: 2_000_000n, why: "payer" }), /You can spray \$2 more/);
  assert.match(e(1_000_000n, { room: 0n, why: "payer" }), /as much as one guest can/);
  assert.match(e(1_000_000n, { room: 0n, why: "pot" }), /This pot is full/);
  assert.match(e(1_000_000n, { room: 0n, why: "host" }), /host's pots have reached today's total/);
  assert.match(e(0n), /Enter an amount/);
  // cNGN: the dollar value is rounded UP (as the contract does), and the largest amount that fits never rounds over
  const rate = 1_441_000_000n;
  assert.equal(C.potUsdValue(1_441_000_000n, rate), 1_000_000n);
  assert.equal(C.potUsdValue(1_441_000_001n, rate), 1_000_001n);
  assert.equal(C.potUsdValue(5n, 0n), 0n);
  for (const u of [1_000_000n, 2_500_000n, 4_999_999n, 5_000_000n]) {
    const most = P.maxUnitsForUsd6(u, rate);
    assert.ok(C.potUsdValue(most, rate) <= u, "fits");
    assert.ok(C.potUsdValue(most + 1n, rate) > u, "and is the largest that fits");
  }
  // what the host can receive: the agent pays every offered pairing
  for (const pay of P.SPRAY_TOKENS) {
    for (const want of P.receiveChoices(pay)) {
      assert.ok(C.payoutRoute(P.sprayToken(pay), null, "pot", want === "usd" ? "usdt" : want), `${pay} -> ${want}`);
    }
  }
  assert.deepEqual(P.receiveChoices("cngn"), ["cngn", "usd"]);
  assert.equal(C.payoutRoute(CNGN, null, "pot", "idrx"), null, "naira can't become rupiah, so it isn't offered");
  assert.equal(P.sprayToken("usdt"), USDT);
  assert.equal(P.sprayToken("cngn"), CNGN);
  // a guest who picks dollars pays with any of the five tokens; each token's quick amounts are in its own decimals
  assert.deepEqual(P.SPRAY_TOKENS, ["usdt", "cngn", "idrx", "wars", "wcop"]);
  assert.deepEqual(P.receiveChoices("idrx"), ["idrx", "usd"]);
  assert.deepEqual(C.payWithTokens("usdt", "pot").map((t) => t.code), P.SPRAY_TOKENS);
  for (const code of P.SPRAY_TOKENS) {
    assert.equal(P.sprayToken(code), C.tokenOfCode(code));
    assert.ok(P.QUICK_AMOUNTS[code]?.length, code);
  }
});

// ---------- the Spray Wall ----------
const potPaidEvent = potsAbi.find((x) => x.type === "event" && x.name === "PotPaid");
function potPaidLog({ potId = 7n, payer = GUEST, token = USDT, amount = 2_000_000n, ref = C.currencyRef("cngn"), total = 2_000_000n, usd6 = amount, block = 100, logIndex = 1, hash = "0x" + "cd".repeat(32) } = {}) {
  const topics = encodeEventTopics({ abi: [potPaidEvent], eventName: "PotPaid", args: { potId, host: HOST, payer } });
  const data = encodeAbiParameters(potPaidEvent.inputs.filter((i) => !i.indexed), [token, amount, ref, total, usd6]);
  return { address: C.LOKAL_POTS, topics, data, blockNumber: block, logIndex, transactionHash: hash };
}

test("Spray Wall rows from PotPaid: amounts, what the host gets and when, never the payer's address", () => {
  const s = P.sprayOf(potPaidLog({ token: CNGN, amount: 2_882_000_000n, usd6: 2_000_000n, ref: C.currencyRef("cngn") }), NOW);
  assert.deepEqual({ potId: s.potId, amountUsd6: s.amountUsd6, pay: s.pay, amount: s.amount, receive: s.receive, time: s.time },
    { potId: 7n, amountUsd6: 2_000_000n, pay: "cngn", amount: 2_882_000_000n, receive: "cngn", time: NOW });
  assert.ok(!("payer" in s), "no payer field");
  assert.ok(!JSON.stringify(s, (_k, v) => (typeof v === "bigint" ? String(v) : v)).toLowerCase().includes(GUEST.slice(2)), "the payer's address appears nowhere");
  assert.equal(P.sprayOf(potPaidLog({ ref: C.ZERO_REF })).receive, null, "no choice in the ref");
  assert.equal(P.sprayOf({ topics: [C.TOPIC.TagPaid], data: "0x" }), null);
  // newest first, one row per log
  const a = P.sprayOf(potPaidLog({ block: 100, logIndex: 1 }));
  const b = P.sprayOf(potPaidLog({ block: 105, logIndex: 0, hash: "0x" + "ee".repeat(32) }));
  const c = P.sprayOf(potPaidLog({ block: 105, logIndex: 3, hash: "0x" + "ee".repeat(32) }), NOW);
  const merged = P.mergeSprays([a, b], [c, { ...b, time: NOW - 60 }, a]);
  assert.deepEqual(merged.map((x) => [x.block, x.logIndex]), [[105, 3], [105, 0], [100, 1]]);
  assert.equal(merged[1].time, NOW - 60, "a later read fills in the time");
  // a tilt for each note: fixed per log, within ±3 degrees
  for (const x of merged) { const t = P.noteTilt(x.key); assert.ok(t >= -3 && t <= 3); assert.equal(P.noteTilt(x.key), t); }
  assert.equal(P.agoText(NOW - 20, NOW), "just now");
  assert.equal(P.agoText(NOW - 240, NOW), "4 min ago");
  assert.equal(P.agoText(NOW - 7200, NOW), "2 h ago");
  assert.equal(P.agoText(NOW - 3 * 86_400, NOW), "3 days ago");
});

/** A fake fetch: Blockscout's log API and Forno (eth_getBlockByNumber, eth_getLogs, eth_call). */
function fakeNet({ explorer = null, logs = [], head = 84_000_000, ts = NOW, calls = {} } = {}) {
  const seen = { explorer: [], getLogs: [] };
  const fetchJson = async (url, init) => {
    if (String(url).startsWith(P.BLOCKSCOUT_RPC_API)) {
      seen.explorer.push(String(url));
      if (explorer instanceof Error) throw explorer;
      return explorer;
    }
    const body = JSON.parse(init.body);
    const out = (result) => ({ jsonrpc: "2.0", id: body.id, result });
    if (body.method === "eth_getBlockByNumber") {
      const n = body.params[0] === "latest" ? head : parseInt(body.params[0], 16);
      return out({ number: "0x" + n.toString(16), timestamp: "0x" + (ts - (head - n)).toString(16) });
    }
    if (body.method === "eth_getLogs") {
      const f = body.params[0];
      const from = parseInt(f.fromBlock, 16), to = parseInt(f.toBlock, 16);
      seen.getLogs.push([from, to, f.topics]);
      assert.ok(to - from + 1 <= P.LOG_RANGE, "never more than Forno's range");
      assert.equal(f.address, C.LOKAL_POTS);
      return out(logs.filter((l) => l.blockNumber >= from && l.blockNumber <= to)
        .map((l) => ({ ...l, blockNumber: "0x" + l.blockNumber.toString(16), logIndex: "0x" + l.logIndex.toString(16) })));
    }
    if (body.method === "eth_call") return calls[body.params[0].data.slice(0, 10)]?.(body.params[0]) ?? out("0x");
    throw new Error("unexpected " + body.method);
  };
  return { fetchJson, seen };
}

test("the Spray Wall reads the explorer's log API in one request, filtered to this pot", async () => {
  const log = potPaidLog({ block: 83_999_000 });
  const explorer = { status: "1", message: "OK", result: [{ ...log, topics: [...log.topics, null], blockNumber: "0x" + (83_999_000).toString(16), logIndex: "0x1", timeStamp: "0x" + (NOW - 600).toString(16) }] };
  const net = fakeNet({ explorer });
  const r = await P.loadPotSprays(7n, { fetchJson: net.fetchJson });
  assert.equal(r.source, "explorer");
  assert.equal(r.toBlock, 84_000_000);
  assert.equal(r.sprays.length, 1);
  assert.equal(r.sprays[0].time, NOW - 600);
  const u = new URL(net.seen.explorer[0]);
  assert.deepEqual([u.searchParams.get("module"), u.searchParams.get("action"), u.searchParams.get("address"), u.searchParams.get("topic0"), u.searchParams.get("topic1"), u.searchParams.get("topic0_1_opr"), u.searchParams.get("fromBlock")],
    ["logs", "getLogs", C.LOKAL_POTS, C.TOPIC.PotPaid, C.topicOf(7n), "and", String(C.LOKAL_POTS_BLOCK)]);
  // "no logs" is an empty wall, not an error
  const none = await P.loadPotSprays(7n, { fetchJson: fakeNet({ explorer: { status: "0", message: "No logs found", result: [] } }).fetchJson });
  assert.deepEqual([none.source, none.sprays.length], ["explorer", 0]);
});

test("when the explorer is down, the wall reads the chain with eth_getLogs in Forno-sized steps, and polls new blocks", async () => {
  const logs = [potPaidLog({ block: 83_999_990, logIndex: 0, hash: "0x" + "01".repeat(32) }), potPaidLog({ block: 83_993_000, logIndex: 2, hash: "0x" + "02".repeat(32) })];
  const net = fakeNet({ explorer: new Error("502"), logs });
  const r = await P.loadPotSprays(7n, { closesAt: NOW + 86_400, maxChunks: 3, fetchJson: net.fetchJson });
  assert.equal(r.source, "chain");
  assert.deepEqual(r.sprays.map((s) => s.block), [83_999_990, 83_993_000]);
  assert.equal(r.sprays[0].time, NOW - 10, "block time looked up");
  assert.equal(net.seen.getLogs.length, 3);
  assert.deepEqual(net.seen.getLogs[0][2], [C.TOPIC.PotPaid, C.topicOf(7n)]);
  // polling: only blocks after the last one read
  const later = fakeNet({ logs: [...logs, potPaidLog({ block: 84_000_004, logIndex: 0, hash: "0x" + "03".repeat(32) })], head: 84_000_005 });
  const p = await P.pollPotSprays(7n, 84_000_000, { fetchJson: later.fetchJson });
  assert.deepEqual([p.toBlock, p.sprays.map((s) => s.block)], [84_000_005, [84_000_004]]);
  assert.deepEqual(later.seen.getLogs[0].slice(0, 2), [84_000_001, 84_000_005]);
  const idle = await P.pollPotSprays(7n, 84_000_005, { fetchJson: later.fetchJson });
  assert.deepEqual([idle.toBlock, idle.sprays.length], [84_000_005, 0]);
});

test("a host's pots: PotCreated logs filtered by host, or the contract's latest pots when the explorer is down", async () => {
  const ev = potsAbi.find((x) => x.type === "event" && x.name === "PotCreated");
  const created = (potId, host) => ({
    topics: encodeEventTopics({ abi: [ev], eventName: "PotCreated", args: { potId, host } }),
    data: encodeAbiParameters(ev.inputs.filter((i) => !i.indexed), [`Pot ${potId}`, BigInt(NOW + 86_400), 50_000_000n, 2_000_000n]),
    blockNumber: "0x10", logIndex: "0x0", transactionHash: "0x" + "aa".repeat(32),
  });
  const net = fakeNet({ explorer: { status: "1", message: "OK", result: [created(2n, HOST), created(5n, HOST)] } });
  const pots = await P.loadHostPots(HOST, { fetchJson: net.fetchJson });
  assert.deepEqual(pots.map((p) => [p.potId, p.title]), [[5n, "Pot 5"], [2n, "Pot 2"]]);
  const u = new URL(net.seen.explorer[0]);
  assert.deepEqual([u.searchParams.get("topic0"), u.searchParams.get("topic1"), u.searchParams.get("topic2"), u.searchParams.get("topic0_2_opr")],
    [C.TOPIC.PotCreated, null, C.topicOf(HOST), "and"]);
  // fallback: potCount, then potInfo for the latest pots, keeping the host's
  const info = (host, title) => encodeAbiParameters(["address", "string", "uint256", "bool", "uint256", "uint256", "uint256", "uint256"].map((type) => ({ type })),
    [host, title, BigInt(NOW + 3600), true, 100_000_000n, 5_000_000n, 0n, 0n]);
  const ret = (result) => ({ jsonrpc: "2.0", id: 1, result });
  const down = fakeNet({ explorer: new Error("timeout"), calls: {
    [C.FN.potCount]: () => ret(encodeAbiParameters([{ type: "uint256" }], [3n])),
    [C.FN.potInfo]: (call) => { const id = Number(BigInt("0x" + call.data.slice(10, 74))); return ret(info(id === 2 ? GUEST : HOST, `Pot ${id}`)); },
  } });
  const fallback = await P.loadHostPots(HOST, { fetchJson: down.fetchJson });
  assert.deepEqual(fallback.map((p) => [p.potId, p.title]), [[3n, "Pot 3"], [1n, "Pot 1"]]);
});

test("reads with a mocked RPC: the contract's maxima, the room left, the dry run of a spray", async () => {
  const ret = (types, vals) => ({ jsonrpc: "2.0", id: 1, result: encodeAbiParameters(types.map((type) => ({ type })), vals) });
  const answers = {
    [C.FN.maxPotCapUsd6]: ret(["uint64"], [100_000_000n]), [C.FN.maxPerPayerCapUsd6]: ret(["uint64"], [5_000_000n]),
    [C.FN.maxPerHostDailyUsd6]: ret(["uint64"], [100_000_000n]), [C.FN.maxDailyUsd6]: ret(["uint64"], [250_000_000n]),
    [C.FN.remaining]: ret(["uint256", "uint256", "uint256", "uint256"], [3_000_000n, 58_000_000n, 90_000_000n, 200_000_000n]),
    [C.FN.unitsPerUsd]: ret(["uint256"], [1_441_000_000n]),
    [C.FN.validatePotPayment]: { jsonrpc: "2.0", id: 1, error: { code: 3, message: "execution reverted", data: err("OverPayerCap", [4_000_000n, 3_000_000n]) } },
  };
  const seen = [];
  const fetchJson = async (_u, init) => { const b = JSON.parse(init.body); seen.push(b.params[0]); return answers[b.params[0].data.slice(0, 10)]; };
  assert.deepEqual(await C.readPotLimits({ fetchJson }), { maxPotCapUsd6: 100_000_000n, maxPerPayerCapUsd6: 5_000_000n, maxPerHostDailyUsd6: 100_000_000n, maxDailyUsd6: 250_000_000n });
  assert.ok(seen.every((c) => c.to === C.LOKAL_POTS));
  assert.deepEqual(await C.readPotRemaining(7n, GUEST, { fetchJson }), { forPayer: 3_000_000n, forPot: 58_000_000n, forHost: 90_000_000n, forToday: 200_000_000n });
  assert.equal(await C.readUnitsPerUsd(CNGN, { fetchJson }), 1_441_000_000n);
  const chk = await C.checkPotPayment({ potId: 7n, token: USDT, amount: 4_000_000n, payer: GUEST }, { fetchJson });
  assert.deepEqual([chk.ok, chk.name], [false, "OverPayerCap"]);
  assert.match(chk.message, /\$3\.00 more into this pot/);
  answers[C.FN.validatePotPayment] = ret(["uint256"], [2_000_000n]);
  assert.deepEqual(await C.checkPotPayment({ potId: 7n, token: USDT, amount: 2_000_000n, payer: GUEST }, { fetchJson }), { ok: true, amountUsd6: 2_000_000n });
});

test("gating: a pot's page is public; opening a pot needs a signed-in tag holder; only the host can close it", () => {
  assert.ok(PUBLIC_PAGES.includes("pot.html"));
  assert.ok(!SIGNED_IN_PAGES.includes("pot.html"));
  const session = { address: HOST };
  assert.equal(potsView(null, undefined), "signed-out");
  assert.equal(potsView({ address: "nope" }, "ada"), "signed-out");
  assert.equal(potsView(session, undefined), "loading");
  assert.equal(potsView(session, null), "no-tag");
  assert.equal(potsView(session, "ada"), "host");
  assert.equal(canClosePot(session, { host: HOST.toUpperCase().replace("0X", "0x") }), true);
  assert.equal(canClosePot({ address: GUEST }, { host: HOST }), false);
  assert.equal(canClosePot(null, { host: HOST }), false);
  // the pot page never loads the landing's redirect, and the dashboard is where pots are opened
  const potHtml = fs.readFileSync(new URL("../site/pot.html", import.meta.url), "utf8");
  assert.ok(!potHtml.includes("assets/gate.js"));
  assert.ok(potHtml.includes('src="js/pot.js"'));
  const app = fs.readFileSync(new URL("../site/js/app.js", import.meta.url), "utf8");
  assert.match(app, /potsView\(s, D\.tag\)/);
  assert.match(app, /createPotData/);
});
