// nTag UI helpers (site/assets/ntag-ui.js): availability wording, live rule checks, input clean-up and tag suggestions.
import test from "node:test";
import assert from "node:assert/strict";
import { resolveNtags, ntagError, ntagAvailability, AGENT, TOKENS } from "../site/assets/core.js";
import {
  availabilityMessage, ntagRules, cleanTagInput, suggestNtags, greeting, whatsappUrl, depositIneligible, expectedPayoutUnits,
  matchTagLedger, allowanceFrom, allowanceResetAt, transferItem, tokenKey, LIMITS_TEXT, CNGN_CAP_USD, DAY_MS,
} from "../site/assets/ntag-ui.js";

const ADA = "0x2222222222222222222222222222222222222222";
const BOB = "0x4444444444444444444444444444444444444444";
const T = 1_800_000_000;
const op = (n, from, body) => ({ hash: "0x" + n.toString(16).padStart(64, "0"), from, block: 100 + n, position: 0, time: T + n * 60, value: "0", op: body });

test("cleanTagInput lower-cases, strips @ and spaces, caps at 20", () => {
  assert.equal(cleanTagInput("  @Ada Obi "), "adaobi");
  assert.equal(cleanTagInput("@@x"), "@x");
  assert.equal(cleanTagInput("a".repeat(30)).length, 20);
});

test("ntagRules reports each rule live", () => {
  assert.deepEqual(ntagRules("").map((r) => r.ok), [null, null, null, null]);
  assert.deepEqual(ntagRules("ada").map((r) => r.ok), [true, true, true, true]);
  assert.deepEqual(ntagRules("1a_").map((r) => r.ok), [true, true, false, false]);
  assert.deepEqual(ntagRules("ab").map((r) => r.ok), [false, true, true, true]);
  assert.equal(ntagRules("a-b").find((r) => r.id === "chars").ok, false);
});

test("availabilityMessage covers every state", () => {
  const st = resolveNtags([op(1, ADA, { t: "ada" }), op(2, BOB, { t: "bob" }), op(3, BOB, { t: "" })]);
  assert.match(availabilityMessage("ada", "taken", { owner: st.tags.get("ada") }).text, /taken by 0x2222/);
  assert.equal(availabilityMessage("zed", "free").tone, "ok");
  assert.match(availabilityMessage("admin", "reserved").text, /reserved/);
  assert.match(availabilityMessage("bob", "locked", { lock: st.locks.get("bob") }).text, /only its previous owner/);
  assert.equal(availabilityMessage("1ab", "invalid").text, "Must start with a letter.");
  assert.equal(availabilityMessage("ada", "yours").tone, "ok");
});

test("suggestNtags returns valid, free tags near the base and the name", () => {
  const st = resolveNtags([op(1, ADA, { t: "ada" }), op(2, BOB, { t: "adaobi" }), op(3, BOB, { t: "ada_ng" })]);
  const s = suggestNtags("ada", "Ada Obi", st, "0x9999999999999999999999999999999999999999");
  assert.equal(s.length, 3);
  for (const t of s) {
    assert.equal(ntagError(t), null);
    assert.equal(ntagAvailability(st, t, "0x9"), "free");
    assert.ok(t.includes("ada"), t);
  }
  assert.ok(!s.includes("adaobi") && !s.includes("ada_ng"));
  // a long or odd base still yields valid suggestions
  for (const base of ["a".repeat(20), "9lives", "x_", "admin"]) {
    const out = suggestNtags(base, "", st, ADA);
    assert.equal(out.length, 3, base);
    for (const t of out) assert.equal(ntagError(t), null, `${base} -> ${t}`);
  }
});

test("greeting and the WhatsApp link", () => {
  assert.equal(greeting(new Date("2026-11-21T07:00:00Z")), "Good morning"); // 08:00 in Lagos
  assert.equal(greeting(new Date("2026-11-21T13:00:00Z")), "Good afternoon");
  assert.equal(greeting(new Date("2026-11-21T19:00:00Z")), "Good evening");
  const u = whatsappUrl("ada", "https://lokalpay.vercel.app/@ada");
  assert.ok(u.startsWith("https://wa.me/?text="));
  assert.match(decodeURIComponent(u.slice(20)), /@ada: https:\/\/lokalpay\.vercel\.app\/@ada$/);
});

// ---------- payments to a tag ----------
const OWNER = ADA, PAYER = BOB;
const RATE = { rate: 1500, reverseRate: 1 / 1550 }; // $1 ≈ ₦1,500 (USD₮ → cNGN); ₦1,550 ≈ $1 (cNGN → USD₮)
const H0 = Date.UTC(2026, 10, 21, 9); // 09:00 UTC
const dep = (n, token, amount, extra = {}) => ({ hash: "0xd" + n, logIndex: 0, block: 1000 + n * 10, ts: H0 + n * 60_000, token, units: BigInt(Math.round(amount * 1e6)), payer: PAYER, ...extra });
const pay = (n, token, amount, extra = {}) => ({ hash: "0xp" + n, logIndex: 1, block: 1000 + n * 10 + 5, ts: H0 + n * 60_000 + 30_000, token, units: BigInt(Math.round(amount * 1e6)), ...extra });

test("limits: the text and the cNGN margin", () => {
  assert.equal(LIMITS_TEXT, "$25 per payment · $25 per person per day · $100 per day overall");
  assert.equal(CNGN_CAP_USD, 24.25);
});

test("depositIneligible mirrors the agent: self, minimums, the $25 cap", () => {
  const base = { payer: PAYER, owner: OWNER };
  assert.equal(depositIneligible({ ...base, token: "USDT", units: 10_000_000n }, RATE), null);
  assert.equal(depositIneligible({ ...base, payer: OWNER.toUpperCase().replace("0X", "0x"), token: "USDT", units: 10_000_000n }, RATE).kind, "self");
  assert.equal(depositIneligible({ ...base, token: "USDT", units: 999_999n }, RATE).kind, "min");
  assert.equal(depositIneligible({ ...base, token: "USDT", units: 25_000_000n }, RATE), null);
  assert.equal(depositIneligible({ ...base, token: "USDT", units: 25_000_001n }, RATE).kind, "over");
  assert.equal(depositIneligible({ ...base, token: "CNGN", units: 999n * 1_000_000n }, RATE).kind, "min");
  assert.equal(depositIneligible({ ...base, token: "CNGN", units: 15_000n * 1_000_000n }, RATE), null);
  assert.equal(depositIneligible({ ...base, token: "CNGN", units: 40_000n * 1_000_000n }, RATE).kind, "over"); // ≈ $25.81
  assert.equal(depositIneligible({ ...base, token: "CNGN", units: 40_000n * 1_000_000n }, null), null); // no rate: can't tell
});

test("expectedPayoutUnits values deposits at the rate", () => {
  assert.equal(expectedPayoutUnits("USDT", 10_000_000n, RATE), 15_000_000_000n);
  assert.equal(expectedPayoutUnits("CNGN", 15_500_000_000n, RATE), 10_000_000n);
  assert.equal(expectedPayoutUnits("USDT", 10_000_000n, null), null);
});

test("matchTagLedger: in order, within the margin, skipping refused deposits", () => {
  const deposits = [dep(1, "USDT", 10), dep(2, "USDT", 12)];
  const payouts = [pay(1, "CNGN", 15_100), pay(2, "CNGN", 17_700)];
  const r = matchTagLedger({ deposits, payouts, owner: OWNER, rate: RATE });
  assert.deepEqual(r.map((d) => [d.hash, d.status, d.payout?.hash]), [["0xd1", "paid", "0xp1"], ["0xd2", "paid", "0xp2"]]);

  // a payout far from the expected value isn't this deposit's: "maybe" (a later payout exists), never "paid"
  const off = matchTagLedger({ deposits: [dep(1, "USDT", 10)], payouts: [pay(1, "CNGN", 9_000)], owner: OWNER, rate: RATE });
  assert.equal(off[0].status, "maybe");
  assert.equal(off[0].payout.hash, "0xp1");

  // self-payment and over-cap deposits are skipped, so they can't take the payout meant for the next one
  const mixed = matchTagLedger({
    deposits: [dep(1, "USDT", 10, { payer: OWNER }), dep(2, "USDT", 30), dep(3, "USDT", 10)],
    payouts: [pay(3, "CNGN", 15_000)], owner: OWNER, rate: RATE,
  });
  assert.deepEqual(mixed.map((d) => [d.status, d.reason?.kind ?? null, d.payout?.hash ?? null]),
    [["ineligible", "self", null], ["ineligible", "over", null], ["paid", null, "0xp3"]]);

  // a payout before the deposit never counts for it; nothing after it → "none"
  const early = matchTagLedger({ deposits: [dep(5, "USDT", 10)], payouts: [pay(1, "CNGN", 15_000)], owner: OWNER, rate: RATE });
  assert.equal(early[0].status, "none");

  // wrong token (a USD₮ payout for a USD₮ deposit) doesn't match
  assert.equal(matchTagLedger({ deposits: [dep(1, "USDT", 10)], payouts: [pay(1, "USDT", 10)], owner: OWNER, rate: RATE })[0].status, "none");
});

test("matchTagLedger: ambiguous payouts and the $25-a-day limit", () => {
  // two deposits of the same size, one payout: it went to the first, and the second stays unpaid → the first is ambiguous
  const twin = matchTagLedger({ deposits: [dep(1, "USDT", 10), dep(2, "USDT", 10)], payouts: [pay(2, "CNGN", 15_000)], owner: OWNER, rate: RATE });
  assert.deepEqual(twin.map((d) => d.status), ["maybe", "none"]);

  // $20 already paid to the wallet in the last 24 h: a new $10 deposit is over the per-person day limit
  const before = { ...pay(0, "USDT", 20), ts: H0 - 3600_000, block: 900 };
  const day = matchTagLedger({ deposits: [dep(1, "USDT", 10)], payouts: [before, pay(1, "CNGN", 15_000)], owner: OWNER, rate: RATE });
  assert.equal(day[0].status, "ineligible");
  assert.equal(day[0].reason.kind, "day");
  // the same payout more than 24 h earlier doesn't count
  const old = { ...before, ts: H0 - DAY_MS - 1 };
  assert.equal(matchTagLedger({ deposits: [dep(1, "USDT", 10)], payouts: [old, pay(1, "CNGN", 15_000)], owner: OWNER, rate: RATE })[0].status, "paid");
  // cNGN payouts count at the naira rate: ₦30,000 ≈ $20
  const ngn = { ...pay(0, "CNGN", 30_000), ts: H0 - 3600_000, block: 900 };
  assert.equal(matchTagLedger({ deposits: [dep(1, "USDT", 10)], payouts: [ngn], owner: OWNER, rate: RATE })[0].reason.kind, "day");
});

test("allowanceFrom and allowanceResetAt: what's left today and when more frees up", () => {
  const now = H0;
  const t = (hoursAgo, token, amount, from = AGENT) => ({ from, to: OWNER, token, units: BigInt(amount * 1e6), ts: now - hoursAgo * 3600_000 });
  const a = allowanceFrom([t(2, "USDT", 10), t(5, "CNGN", 7_500), t(30, "USDT", 25), t(1, "USDT", 3, PAYER)], { owner: OWNER, rate: RATE, now });
  assert.equal(a.usedUsd, 15); // $10 + ₦7,500 (= $5); the 30-hours-ago payout and the non-agent transfer don't count
  assert.equal(a.leftUsd, 10);
  assert.equal(allowanceResetAt(a, 8), null); // fits now
  assert.equal(allowanceResetAt(a, 14), now - 5 * 3600_000 + DAY_MS); // the ₦7,500 payout drops out first
  assert.equal(allowanceResetAt(a, 20), now - 2 * 3600_000 + DAY_MS);
  const full = allowanceFrom([t(3, "USDT", 25)], { owner: OWNER, rate: RATE, now });
  assert.equal(full.leftUsd, 0);
  assert.equal(allowanceResetAt(full, 1), now - 3 * 3600_000 + DAY_MS);
  // naira payouts and no rate: unknown, not zero
  assert.throws(() => allowanceFrom([t(2, "CNGN", 1000)], { owner: OWNER, rate: null, now }));
});

test("transferItem reads Blockscout token transfers", () => {
  const it = transferItem({
    transaction_hash: "0xabc", log_index: 7, block_number: 123, timestamp: "2026-11-21T09:00:00.000000Z",
    from: { hash: PAYER }, to: { hash: AGENT }, token: { address_hash: TOKENS.cNGN.address }, total: { value: "1500000000", decimals: "6" },
  });
  assert.deepEqual(it, { hash: "0xabc", logIndex: 7, block: 123, ts: Date.parse("2026-11-21T09:00:00Z"), from: PAYER, to: AGENT, token: "CNGN", units: 1_500_000_000n });
  assert.equal(transferItem({ transaction_hash: "0x1" }), null);
  assert.equal(tokenKey(TOKENS.USDT.address.toLowerCase()), "USDT");
  assert.equal(tokenKey("0x0000000000000000000000000000000000000001"), null);
});