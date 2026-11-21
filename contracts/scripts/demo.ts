/**
 * Lokal canonical demo: "The agent decides; the contract has the final say."
 *
 * Runs the real LokalTags and LokalPots contracts on Hardhat's in-process chain with mock tokens at the real decimals
 * (USD₮ 6, cNGN 6, IDRX 2) and walks one fixed story: tags are claimed under the site's rules, payments inside the
 * limits go straight to the agent's payout wallet, a wedding pot takes small payments from many guests, and everything
 * outside the rules is refused BEFORE any money moves.
 *
 *   cd contracts && npm ci && npm run demo
 *
 * Every step asserts its outcome and that neither contract holds anything. If the contracts ever behave differently
 * from the table, this script exits non-zero (CI runs it), so the table in docs/CONTRACTS.md can't drift from the code.
 * Only mock tokens on a local chain move. Nothing here touches Celo.
 */
import assert from "node:assert/strict";
import { ethers, network } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { POT_DEFAULTS, RESERVED_TAGS, TOKENS, defaultLimits, unitsPerUsd } from "../config/celo";

const DAY = 86_400;
const usd = (n: number | string) => ethers.parseUnits(String(n), 6);
const usd6 = usd;
const fmtUsd = (u: bigint) => `$${Number(ethers.formatUnits(u, 6)).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const ref = (s: string) => ethers.id(s);

type Row = { who: string; action: string; result: "ALLOW" | "REFUSE" | "OK"; why: string };

async function main() {
  const signers = await ethers.getSigners();
  const [admin, payout, ada, bob, carol, dave, erin, frank, gina, hank] = signers;
  const guests = signers.slice(10, 15);
  const extraTags = signers.slice(15, 20);
  const Mock = await ethers.getContractFactory("MockERC20");
  const usdt = await (await ethers.getContractFactory("MockPermitERC20")).deploy();
  const cngn = await Mock.deploy("cNGN", "cNGN", 6);
  const idrx = await Mock.deploy("IDRX", "IDRX", 2);
  const stray = await Mock.deploy("Stray", "STRAY", 6);
  const cfg = (sym: string) => TOKENS.find((t) => t.symbol === sym)!;
  const L = { USDT: defaultLimits(cfg("USDT")), cNGN: defaultLimits(cfg("cNGN")), IDRX: defaultLimits(cfg("IDRX")) };
  const inToken = (sym: string, dollars: number) => (unitsPerUsd(cfg(sym)) * usd6(dollars)) / 1_000_000n;

  const tags = await (await ethers.getContractFactory("LokalTags")).deploy(payout.address, [...RESERVED_TAGS], [
    { token: await usdt.getAddress(), limits: L.USDT },
    { token: await cngn.getAddress(), limits: L.cNGN },
    { token: await idrx.getAddress(), limits: L.IDRX },
  ]);
  const router = await tags.getAddress();
  const pots = await (await ethers.getContractFactory("LokalPots")).deploy(
    router, POT_DEFAULTS.maxPotCapUsd6, POT_DEFAULTS.maxPerPayerCapUsd6, POT_DEFAULTS.maxPerHostDailyUsd6, POT_DEFAULTS.maxDailyUsd6, [
      { token: await usdt.getAddress(), unitsPerUsd: unitsPerUsd(cfg("USDT")) },
      { token: await cngn.getAddress(), unitsPerUsd: unitsPerUsd(cfg("cNGN")) },
      { token: await idrx.getAddress(), unitsPerUsd: unitsPerUsd(cfg("IDRX")) },
    ],
  );
  const potsAddress = await pots.getAddress();
  const P = payout.address; // every payment pins the payout wallet it expects

  for (const p of [ada, carol, dave]) {
    for (const t of [usdt, stray]) {
      await t.mint(p.address, usd(10_000));
      await t.connect(p).approve(router, ethers.MaxUint256);
    }
    await idrx.mint(p.address, L.IDRX.maxPerDay);
    await idrx.connect(p).approve(router, ethers.MaxUint256);
  }
  for (const g of guests) {
    for (const t of [usdt, cngn, idrx]) {
      await t.mint(g.address, 10n ** 30n);
      await t.connect(g).approve(potsAddress, ethers.MaxUint256);
    }
  }
  // Ten more paying wallets, to show what it takes to fill a token's whole day.
  const crowd = Array.from({ length: 10 }, () => ethers.Wallet.createRandom().connect(ethers.provider));
  for (const w of crowd) {
    await network.provider.send("hardhat_setBalance", [w.address, "0x56bc75e2d63100000"]);
    await usdt.mint(w.address, usd(100));
    await usdt.connect(w).approve(router, ethers.MaxUint256);
  }
  // Start the story at 09:00 UTC, so the "today" steps can't straddle midnight.
  await time.increaseTo((Math.floor((await time.latest()) / DAY) + 1) * DAY + 9 * 3600);

  const rows: Row[] = [];
  const step = (who: string, action: string, result: Row["result"], why: string) => rows.push({ who, action, result, why });
  const holdsNothing = async () => {
    for (const t of [usdt, cngn, idrx, stray]) {
      assert.equal(await t.balanceOf(router), 0n, "LokalTags must never hold funds");
      assert.equal(await t.balanceOf(potsAddress), 0n, "LokalPots must never hold funds");
    }
  };

  /** The custom error a call hits, by name, or null if it goes through. Anything else is a real failure. */
  const refusal = async (call: () => Promise<unknown>): Promise<string | null> => {
    try {
      await call();
      return null;
    } catch (e: any) {
      const data = e?.data ?? e?.info?.error?.data ?? e?.error?.data;
      const parsed = typeof data === "string" && data.length >= 10
        ? (tags.interface.parseError(data) ?? pots.interface.parseError(data))
        : null;
      if (parsed) return parsed.name;
      throw e;
    }
  };
  /** Sends the call, expecting `expected` (an error name, or null for success). Asserts no money moved on a refusal. */
  const expectOutcome = async (expected: string | null, call: () => Promise<any>) => {
    const balances = () => Promise.all([usdt, cngn, idrx].map((t) => t.balanceOf(payout.address)));
    const before = await balances();
    const got = await refusal(async () => (await call()).wait());
    assert.equal(got, expected, `expected ${expected ?? "success"}, got ${got ?? "success"}`);
    if (expected) assert.deepEqual(await balances(), before, "a refused payment must move nothing");
    await holdsNothing();
  };

  const U = await usdt.getAddress();

  // Claims, under the same rules as the site.
  await expectOutcome(null, () => tags.connect(ada).claim("ada", "Ada Obi"));
  assert.equal(await tags.ownerOf("ada"), ada.address);
  step("ada", "Claim @ada", "ALLOW", "`TagClaimed`: @ada is hers");

  await expectOutcome(null, () => tags.connect(ada).setReceiveToken(cngn.getAddress()));
  assert.equal(await tags.receiveTokenOf(ada.address), await cngn.getAddress());
  step("ada", "Ask to be paid out in cNGN", "OK", "`ReceiveTokenSet`: the agent now knows her local currency");

  await expectOutcome("TagTaken", () => tags.connect(bob).claim("ada", ""));
  step("bob", "Claim @ada", "REFUSE", "`TagTaken`");

  await expectOutcome("TagReserved", () => tags.connect(bob).claim("lokal_support", "Lokal Support"));
  step("bob", "Claim @lokal_support", "REFUSE", "`TagReserved` (brand names and lookalikes)");
  for (const [s, t] of [[bob, "bob"], [erin, "erin"], [frank, "frank"], [gina, "gina"], [hank, "hank"]] as const) await tags.connect(s).claim(t, "");
  for (const [i, s] of extraTags.entries()) await tags.connect(s).claim(`friend${i}`, "");

  // Payments: inside the limits they go straight through; outside them nothing moves.
  const p0 = await usdt.balanceOf(payout.address);
  await expectOutcome(null, () => tags.connect(carol).payTag("ada", U, usd(10), ref("1"), P));
  assert.equal((await usdt.balanceOf(payout.address)) - p0, usd(10));
  step("carol", "Pay @ada $10 USD₮", "ALLOW", "$10 goes straight to the agent's payout wallet; the contract holds $0");

  await expectOutcome("OverPaymentLimit", () => tags.connect(carol).payTag("ada", U, usd(30), ref("2"), P));
  step("carol", "Pay @ada $30 USD₮", "REFUSE", `\`OverPaymentLimit\` (${fmtUsd(L.USDT.maxPerPayment)}): nothing moved`);

  await expectOutcome("BelowMinimum", () => tags.connect(carol).payTag("ada", U, usd(0.5), ref("3"), P));
  step("carol", "Pay @ada $0.50 USD₮", "REFUSE", `\`BelowMinimum\` (${fmtUsd(L.USDT.minPerPayment)})`);

  const [left] = await tags.remainingToday(U, ada.address, dave.address);
  await expectOutcome("OverRecipientDailyLimit", () => tags.connect(dave).payTag("ada", U, usd(20), ref("4"), P));
  step("dave", `Pay @ada $20 USD₮ ($10 already today, ${fmtUsd(L.USDT.maxPerRecipientPerDay)} per person per day)`, "REFUSE", `\`OverRecipientDailyLimit\` (${fmtUsd(left)} left)`);

  const [, payerLeft] = await tags.remainingToday(U, bob.address, carol.address);
  await expectOutcome("OverPayerDailyLimit", () => tags.connect(carol).payTag("bob", U, usd(20), ref("4b"), P));
  step("carol", `Pay @bob $20 USD₮ (she paid $10 today, ${fmtUsd(L.USDT.maxPerPayerPerDay)} per payer per day)`, "REFUSE", `\`OverPayerDailyLimit\` (${fmtUsd(payerLeft)} left)`);

  await expectOutcome("SelfPayment", () => tags.connect(ada).payTag("ada", U, usd(5), ref("5"), P));
  step("ada", "Pay @ada $5 USD₮", "REFUSE", "`SelfPayment`");

  await expectOutcome("TagNotFound", () => tags.connect(carol).payTag("nobody", U, usd(5), ref("6"), P));
  step("carol", "Pay @nobody $5 USD₮", "REFUSE", "`TagNotFound`");

  await expectOutcome("TokenNotAllowed", () => tags.connect(carol).payTag("ada", stray.getAddress(), usd(5), ref("7"), P));
  step("carol", "Pay @ada in a token the admin never allowed", "REFUSE", "`TokenNotAllowed`");

  const idrxMax = L.IDRX.maxPerPayment;
  const i0 = await idrx.balanceOf(payout.address);
  await expectOutcome(null, () => tags.connect(carol).payTag("ada", idrx.getAddress(), idrxMax, ref("8"), P));
  assert.equal((await idrx.balanceOf(payout.address)) - i0, idrxMax);
  const idrxText = Number(ethers.formatUnits(idrxMax, 2)).toLocaleString("en-US");
  step("carol", `Pay @ada ${idrxText} IDRX (2 decimals, about $24)`, "ALLOW", "Limits are per token, in its own units");

  // The overall daily cap per token: with $25 per payer it takes at least 10 different wallets to fill.
  const recipients = ["ada", "bob", "erin", "frank", "gina", ...extraTags.map((_, i) => `friend${i}`)];
  for (const [i, w] of crowd.entries()) {
    const amount = recipients[i] === "ada" ? usd(15) : usd(25);
    await expectOutcome(null, () => tags.connect(w).payTag(recipients[i], U, amount, ref(`9-${i}`), P));
  }
  const [, , overall] = await tags.remainingToday(U, hank.address, dave.address);
  assert.equal(overall, 0n);
  step("10 other payers", "Pay @ada $15 and nine other tags $25 each in USD₮", "ALLOW", `${fmtUsd(L.USDT.maxPerDay)} in USD₮ today: the daily total, and it took 10 different payers`);

  await expectOutcome("OverDailyLimit", () => tags.connect(dave).payTag("hank", U, usd(1), ref("10"), P));
  step("dave", "Pay @hank $1 USD₮", "REFUSE", "`OverDailyLimit`");

  await time.increaseTo((Math.floor((await time.latest()) / DAY) + 1) * DAY + 9 * 3600);
  await expectOutcome(null, () => tags.connect(carol).payTag("ada", U, usd(25), ref("11"), P));
  step("carol", "Next UTC day: pay @ada $25 USD₮", "ALLOW", "A new day bucket: limits start again");

  // One tag per wallet, and the 30-day release lock.
  await expectOutcome(null, () => tags.connect(ada).claim("ada_obi", "Ada Obi"));
  assert.equal(await tags.ownerOf("ada"), ethers.ZeroAddress);
  step("ada", "Claim @ada_obi", "ALLOW", "One tag per wallet: @ada is released and locked for 30 days");

  await expectOutcome("TagLocked", () => tags.connect(bob).claim("ada", ""));
  step("bob", "Claim @ada", "REFUSE", "`TagLocked`");

  await time.increase(30 * DAY);
  await expectOutcome(null, () => tags.connect(bob).claim("ada", "Bob"));
  assert.equal(await tags.ownerOf("ada"), bob.address);
  step("bob", "Claim @ada 30 days later", "ALLOW", "The lock has ended");

  // Pots: one link, many payers (guests "spraying" at a wedding), with their own caps.
  const closesAt = (await time.latest()) + 6 * 3600;
  await expectOutcome(null, () => pots.connect(ada).createPot("Ada & Tunde's wedding", closesAt, usd6(20), usd6(5)));
  step("ada", "Open a pot, \"Ada & Tunde's wedding\" ($20 cap, $5 per guest, closes in 6 hours)", "OK", "`PotCreated` #1: one link and QR code for every guest");

  const g0 = await usdt.balanceOf(payout.address);
  await expectOutcome(null, () => pots.connect(guests[0]).payPot(1, U, usd(2), ref("spray-1"), P));
  assert.equal((await usdt.balanceOf(payout.address)) - g0, usd(2));
  step("guest 1", "Spray $2 USD₮ into the pot", "ALLOW", "`PotPaid`: straight to the payout wallet, pot total $2");

  const [guestLeft] = await pots.remaining(1, guests[0].address);
  await expectOutcome("OverPayerCap", () => pots.connect(guests[0]).payPot(1, U, usd(4), ref("spray-2"), P));
  step("guest 1", "Spray $4 more", "REFUSE", `\`OverPayerCap\` (${fmtUsd(guestLeft)} left for this guest)`);

  await expectOutcome(null, () => pots.connect(guests[1]).payPot(1, U, usd(5), ref("spray-3"), P));
  await expectOutcome(null, () => pots.connect(guests[2]).payPot(1, cngn.getAddress(), inToken("cNGN", 5), ref("spray-4"), P));
  await expectOutcome(null, () => pots.connect(guests[3]).payPot(1, idrx.getAddress(), inToken("IDRX", 5), ref("spray-5"), P));
  const info = await pots.potInfo(1);
  assert.equal(info.totalUsd6, usd6(17));
  assert.equal(info.payerCount, 4n);
  step("guests 2-4", "Spray $5 each, in USD₮, cNGN and IDRX", "ALLOW", "One pot takes any allowed token: $17 from 4 guests");

  const [, potLeft] = await pots.remaining(1, guests[4].address);
  await expectOutcome("PotFull", () => pots.connect(guests[4]).payPot(1, U, usd(5), ref("spray-6"), P));
  step("guest 5", "Spray $5", "REFUSE", `\`PotFull\` (${fmtUsd(potLeft)} left of the $20 cap)`);

  // The admin: a new payout wallet waits 24 hours, and one switch pauses everything.
  await expectOutcome(null, () => tags.connect(admin).proposePayoutWallet(hank.address));
  await expectOutcome("PayoutWalletNotReady", () => tags.connect(admin).executePayoutWallet());
  step("admin", "Switch the payout wallet right away", "REFUSE", "`PayoutWalletNotReady`: a new payout wallet waits 24 hours, in public");
  await expectOutcome(null, () => tags.connect(admin).cancelPayoutWallet());

  await expectOutcome(null, () => tags.connect(admin).pause());
  step("admin", "Pause", "OK", "");
  await expectOutcome("Paused", () => tags.connect(carol).payTag("ada_obi", U, usd(5), ref("12"), P));
  step("carol", "Pay @ada_obi $5 USD₮", "REFUSE", "`Paused`");
  await expectOutcome("Paused", () => pots.connect(guests[4]).payPot(1, U, usd(1), ref("13"), P));
  step("guest 5", "Spray $1", "REFUSE", "`Paused`: one switch stops tags and pots");

  await holdsNothing();

  // The table, exactly as docs/CONTRACTS.md shows it.
  const out = ["| # | Who | Action | Result | Why |", "| --- | --- | --- | --- | --- |"];
  rows.forEach((r, i) => out.push(`| ${i + 1} | ${r.who} | ${r.action} | **${r.result}** | ${r.why} |`));
  console.log(out.join("\n"));
  console.log(`\nAll ${rows.length} outcomes asserted. LokalTags and LokalPots held ${fmtUsd(0n)} at every step.`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
