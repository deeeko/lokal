import { expect } from "chai";
import { ethers, network } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { POT_DEFAULTS } from "../config/celo";
import { DAY, LIMITS, RATES, deployFixture, nextDayStart, usd } from "./helpers/fixture";

const ref = (s: string) => ethers.id(s);
const USD6 = (n: number | string) => ethers.parseUnits(String(n), 6);
const HOURS = 3600;

/** `dollars` of the token with `rate` base units per dollar (exact when the rate allows it). */
const inToken = (rate: bigint, dollars: number | string) => (rate * USD6(dollars)) / 1_000_000n;

async function withPot() {
  const f = await deployFixture();
  const { tags, pots, ada } = f;
  await tags.connect(ada).claim("ada", "Ada");
  const closesAt = (await time.latest()) + 6 * HOURS;
  await pots.connect(ada).createPot("Ada & Tunde's wedding", closesAt, USD6(100), USD6(5));
  return { ...f, potId: 1n, closesAt };
}

describe("LokalPots", () => {
  describe("deployment and admin", () => {
    it("starts with the default maxima and a dollar rate for every token", async () => {
      const { pots, router, bySymbol } = await loadFixture(deployFixture);
      expect(await pots.tags()).to.equal(router);
      expect(await pots.maxPotCapUsd6()).to.equal(POT_DEFAULTS.maxPotCapUsd6);
      expect(await pots.maxPerPayerCapUsd6()).to.equal(POT_DEFAULTS.maxPerPayerCapUsd6);
      expect(await pots.maxPerHostDailyUsd6()).to.equal(POT_DEFAULTS.maxPerHostDailyUsd6);
      expect(await pots.maxDailyUsd6()).to.equal(POT_DEFAULTS.maxDailyUsd6);
      for (const [sym, t] of Object.entries(bySymbol)) expect(await pots.unitsPerUsd(await t.getAddress()), sym).to.equal(RATES[sym]);
      expect(await pots.potCount()).to.equal(0n);
    });

    it("refuses bad constructor input", async () => {
      const { pots, router, stranger } = await loadFixture(deployFixture);
      const F = await ethers.getContractFactory("LokalPots");
      await expect(F.deploy(stranger.address, 1, 1, 1, 1, [])).to.be.revertedWithCustomError(pots, "InvalidToken");
      await expect(F.deploy(router, 5, 6, 10, 10, [])).to.be.revertedWithCustomError(pots, "InvalidLimits"); // per payer > pot cap
      await expect(F.deploy(router, 10, 5, 9, 10, [])).to.be.revertedWithCustomError(pots, "InvalidLimits"); // pot cap > per host
      await expect(F.deploy(router, 10, 5, 10, 9, [])).to.be.revertedWithCustomError(pots, "InvalidLimits"); // per host > daily
      await expect(F.deploy(router, 10, 0, 10, 10, [])).to.be.revertedWithCustomError(pots, "InvalidLimits");
      await expect(F.deploy(router, 10, 5, 10, 10, [{ token: stranger.address, unitsPerUsd: 1 }])).to.be.revertedWithCustomError(pots, "InvalidToken");
    });

    it("the admin is LokalTags' owner, and follows a two-step ownership transfer", async () => {
      const { pots, tags, admin, stranger, usdt, ada } = await loadFixture(deployFixture);
      const u = await usdt.getAddress();
      await expect(pots.connect(stranger).setUsdRate(u, 1_000_000)).to.be.revertedWithCustomError(pots, "NotAdmin").withArgs(stranger.address);
      await expect(pots.connect(stranger).setLimits(1, 1, 1, 1)).to.be.revertedWithCustomError(pots, "NotAdmin");
      await expect(pots.connect(stranger).rescue(u, stranger.address, 1)).to.be.revertedWithCustomError(pots, "NotAdmin");
      await expect(pots.connect(admin).setUsdRate(u, 2_000_000)).to.emit(pots, "UsdRateSet").withArgs(u, 2_000_000);
      await expect(pots.connect(admin).setLimits(USD6(50), USD6(2), USD6(50), USD6(60))).to.emit(pots, "PotLimitsSet").withArgs(USD6(50), USD6(2), USD6(50), USD6(60));
      await expect(pots.connect(admin).setLimits(USD6(50), USD6(60), USD6(60), USD6(60))).to.be.revertedWithCustomError(pots, "InvalidLimits");
      await expect(pots.connect(admin).setUsdRate(stranger.address, 1)).to.be.revertedWithCustomError(pots, "InvalidToken");
      await tags.connect(admin).transferOwnership(ada.address);
      await tags.connect(ada).acceptOwnership();
      await expect(pots.connect(admin).setUsdRate(u, 1_000_000)).to.be.revertedWithCustomError(pots, "NotAdmin");
      await pots.connect(ada).setUsdRate(u, 1_000_000);
    });

    it("rate sanity: within [10^decimals / 2, 10^decimals x 100,000], and at most 10x per update", async () => {
      const { pots, admin, usdt, cngn, idrx, wcop } = await loadFixture(deployFixture);
      const a = pots.connect(admin);
      const u = await usdt.getAddress();
      // USD₮ (6 decimals): $1 = 1e6 units. 10x either way is the most one update can move it.
      await expect(a.setUsdRate(u, 10_000_001)).to.be.revertedWithCustomError(pots, "RateOutOfBounds").withArgs(10_000_001, 500_000, 10_000_000);
      await expect(a.setUsdRate(u, 499_999)).to.be.revertedWithCustomError(pots, "RateOutOfBounds");
      await expect(a.setUsdRate(u, 500_000)).to.emit(pots, "UsdRateSet");
      // The auditor's typo: an 18-decimal rate for 6-decimal cNGN is refused outright.
      const c = await cngn.getAddress();
      await expect(a.setUsdRate(c, 1441n * 10n ** 18n)).to.be.revertedWithCustomError(pots, "RateOutOfBounds");
      // A fresh rate (after switching the token off) only has to be inside the absolute bounds.
      await a.setUsdRate(c, 0);
      await expect(a.setUsdRate(c, 10n ** 6n * 100_000n + 1n)).to.be.revertedWithCustomError(pots, "RateOutOfBounds");
      await expect(a.setUsdRate(c, 10n ** 6n * 100_000n)).to.emit(pots, "UsdRateSet");
      // 2- and 18-decimal tokens are bounded by their own decimals.
      await expect(a.setUsdRate(await idrx.getAddress(), RATES.IDRX * 5n)).to.emit(pots, "UsdRateSet"); // 92,035 IDRX per $: under the 100,000 ceiling
      await expect(a.setUsdRate(await idrx.getAddress(), RATES.IDRX * 6n)).to.be.revertedWithCustomError(pots, "RateOutOfBounds");
      await expect(a.setUsdRate(await wcop.getAddress(), RATES.wCOP * 11n)).to.be.revertedWithCustomError(pots, "RateOutOfBounds");
      // A token without decimals() can't get a rate.
      const NoMeta = await ethers.getContractFactory("BlockTime");
      const nm = await NoMeta.deploy();
      await expect(a.setUsdRate(await nm.getAddress(), 1_000_000)).to.be.revertedWithCustomError(pots, "InvalidToken");
    });

    it("rescue returns tokens sent here by mistake", async () => {
      const { pots, potsAddress, admin, usdt, carol } = await loadFixture(deployFixture);
      const u = await usdt.getAddress();
      await usdt.connect(carol).transfer(potsAddress, usd(2));
      await expect(pots.connect(admin).rescue(u, ethers.ZeroAddress, usd(2))).to.be.revertedWithCustomError(pots, "InvalidRecipient");
      await expect(pots.connect(admin).rescue(u, potsAddress, usd(2))).to.be.revertedWithCustomError(pots, "InvalidRecipient");
      const tx = pots.connect(admin).rescue(u, carol.address, usd(2));
      await expect(tx).to.emit(pots, "Rescued").withArgs(u, carol.address, usd(2));
      await expect(tx).to.changeTokenBalances(usdt, [potsAddress, carol], [-usd(2), usd(2)]);
    });
  });

  describe("createPot", () => {
    it("opens a pot for a tag holder and shows it", async () => {
      const { pots, tags, ada } = await loadFixture(deployFixture);
      await tags.connect(ada).claim("ada", "");
      const closesAt = (await time.latest()) + 2 * DAY;
      await expect(pots.connect(ada).createPot("Birthday kitty", closesAt, USD6(50), USD6(5)))
        .to.emit(pots, "PotCreated").withArgs(1, ada.address, "Birthday kitty", closesAt, USD6(50), USD6(5));
      expect(await pots.potInfo(1)).to.deep.equal([ada.address, "Birthday kitty", BigInt(closesAt), true, USD6(50), USD6(5), 0n, 0n]);
      expect(await pots.potCount()).to.equal(1n);
    });

    it("needs a tag holder who can be paid", async () => {
      const { pots, tags, admin, bob, ada } = await loadFixture(deployFixture);
      const closesAt = (await time.latest()) + DAY;
      await expect(pots.connect(bob).createPot("x", closesAt, USD6(10), USD6(1))).to.be.revertedWithCustomError(pots, "HostNotEligible").withArgs(bob.address);
      await tags.connect(ada).claim("ada", "");
      await tags.connect(admin).proposePayoutWallet(ada.address);
      await time.increase(DAY);
      await tags.connect(admin).executePayoutWallet();
      await expect(pots.connect(ada).createPot("x", closesAt + DAY, USD6(10), USD6(1))).to.be.revertedWithCustomError(pots, "HostNotEligible");

    });

    it("refuses bad titles: empty, over 60 bytes, control characters, edge whitespace", async () => {
      const { pots, tags, ada } = await loadFixture(deployFixture);
      await tags.connect(ada).claim("ada", "");
      const closesAt = (await time.latest()) + DAY;
      for (const t of ["", "x".repeat(61), "é".repeat(31), "Wedding\n", "Wed\u0007ding", " Wedding", "Wedding ", "Lokal\u200bSupport", "Ada\u202etroppus"]) {
        await expect(pots.connect(ada).createPot(t, closesAt, USD6(10), USD6(1)), JSON.stringify(t)).to.be.revertedWithCustomError(pots, "InvalidTitle");
      }
      await expect(pots.connect(ada).createPot("x".repeat(60), closesAt, USD6(10), USD6(1))).to.emit(pots, "PotCreated");
      await expect(pots.connect(ada).createPot("Ọlá's naming 🎉", closesAt, USD6(10), USD6(1))).to.emit(pots, "PotCreated");
    });

    it("closesAt must be in the future and at most 14 days away", async () => {
      const { pots, tags, ada } = await loadFixture(deployFixture);
      await tags.connect(ada).claim("ada", "");
      const now = await time.latest();
      await expect(pots.connect(ada).createPot("x", now, USD6(10), USD6(1))).to.be.revertedWithCustomError(pots, "InvalidCloseTime");
      await expect(pots.connect(ada).createPot("x", now + 14 * DAY + 10, USD6(10), USD6(1))).to.be.revertedWithCustomError(pots, "InvalidCloseTime");
      await time.setNextBlockTimestamp(now + 5);
      await expect(pots.connect(ada).createPot("x", now + 5 + 14 * DAY, USD6(10), USD6(1))).to.emit(pots, "PotCreated");
    });

    it("caps must be 0 < per payer <= pot <= the admin's maxima", async () => {
      const { pots, tags, ada } = await loadFixture(deployFixture);
      await tags.connect(ada).claim("ada", "");
      const c = (await time.latest()) + DAY;
      for (const [cap, per] of [[USD6(10), 0n], [USD6(4), USD6(5)], [USD6(101), USD6(5)], [USD6(100), USD6(6)]]) {
        await expect(pots.connect(ada).createPot("x", c, cap, per)).to.be.revertedWithCustomError(pots, "InvalidPotCaps");
      }
      await expect(pots.connect(ada).createPot("x", c, USD6(100), USD6(5))).to.emit(pots, "PotCreated");
    });

    it("is refused while LokalTags is paused", async () => {
      const { pots, tags, admin, ada } = await loadFixture(deployFixture);
      await tags.connect(ada).claim("ada", "");
      await tags.connect(admin).pause();
      await expect(pots.connect(ada).createPot("x", (await time.latest()) + DAY, USD6(10), USD6(1))).to.be.revertedWithCustomError(pots, "Paused");
    });
  });

  describe("payPot", () => {
    it("a guest pays $2: straight to the payout wallet, nothing retained, totals and payer count update", async () => {
      const { pots, potsAddress, router, usdt, carol, ada, payout, potId } = await loadFixture(withPot);
      const u = await usdt.getAddress();
      const tx = pots.connect(carol).payPot(potId, u, usd(2), ref("spray-1"), ethers.ZeroAddress);
      await expect(tx).to.changeTokenBalances(usdt, [carol, payout, potsAddress, router], [-usd(2), usd(2), 0n, 0n]);
      await expect(tx).to.emit(pots, "PotPaid").withArgs(potId, ada.address, carol.address, u, usd(2), ref("spray-1"), USD6(2), USD6(2));
      expect(await pots.paidBy(potId, carol.address)).to.equal(USD6(2));
      expect(await pots.tokenTotal(potId, u)).to.equal(usd(2));
      const info = await pots.potInfo(potId);
      expect([info.totalUsd6, info.payerCount]).to.deep.equal([USD6(2), 1n]);
      expect(await pots.remaining(potId, carol.address)).to.deep.equal([USD6(3), USD6(98), USD6(98), USD6(248)]);
    });

    it("counts distinct payers once, however many times they pay", async () => {
      const { pots, usdt, carol, dave, potId } = await loadFixture(withPot);
      const u = await usdt.getAddress();
      await pots.connect(carol).payPot(potId, u, usd(1), ref("a"), ethers.ZeroAddress);
      await pots.connect(carol).payPot(potId, u, usd(2), ref("b"), ethers.ZeroAddress);
      await pots.connect(dave).payPot(potId, u, usd(1), ref("c"), ethers.ZeroAddress);
      expect((await pots.potInfo(potId)).payerCount).to.equal(2n);
      expect((await pots.potInfo(potId)).totalUsd6).to.equal(USD6(4));
    });

    it("OverPayerCap: one payer's total across tokens can't pass the per-payer cap", async () => {
      const { pots, usdt, cngn, carol, potId } = await loadFixture(withPot);
      await pots.connect(carol).payPot(potId, await usdt.getAddress(), usd(3), ref("a"), ethers.ZeroAddress);
      const twoDollarsNgn = inToken(RATES.cNGN, 2);
      await pots.connect(carol).payPot(potId, await cngn.getAddress(), twoDollarsNgn, ref("b"), ethers.ZeroAddress);
      expect(await pots.paidBy(potId, carol.address)).to.equal(USD6(5));
      await expect(pots.connect(carol).payPot(potId, await usdt.getAddress(), usd(1), ref("c"), ethers.ZeroAddress))
        .to.be.revertedWithCustomError(pots, "OverPayerCap").withArgs(USD6(1), 0);
    });

    it("PotFull: many payers in 2-, 6- and 18-decimal tokens fill the pot cap exactly", async () => {
      const { pots, tags, bySymbol, signers, ada, potsAddress, payout } = await loadFixture(deployFixture);
      await tags.connect(ada).claim("ada", "");
      await pots.connect(ada).createPot("Kitty", (await time.latest()) + DAY, USD6(20), USD6(5));
      const order = ["IDRX", "USDT", "wCOP", "cNGN"] as const; // 2, 6, 18, 6 decimals
      const before: Record<string, bigint> = {};
      for (const s of order) before[s] = await bySymbol[s].balanceOf(payout.address);
      for (let i = 0; i < 4; i++) {
        const guest = signers[11 + i];
        const t = bySymbol[order[i]];
        const amount = inToken(RATES[order[i]], 5);
        await t.mint(guest.address, amount * 2n);
        await t.connect(guest).approve(potsAddress, ethers.MaxUint256);
        await expect(pots.connect(guest).payPot(1, await t.getAddress(), amount, ref(order[i]), ethers.ZeroAddress), order[i]).to.emit(pots, "PotPaid");
        expect(await pots.paidBy(1, guest.address), order[i]).to.equal(USD6(5));
      }
      expect((await pots.potInfo(1)).totalUsd6).to.equal(USD6(20));
      expect((await pots.potInfo(1)).payerCount).to.equal(4n);
      const late = signers[16];
      await bySymbol.USDT.mint(late.address, usd(10));
      await bySymbol.USDT.connect(late).approve(potsAddress, ethers.MaxUint256);
      await expect(pots.connect(late).payPot(1, await bySymbol.USDT.getAddress(), usd(1), ref("late"), ethers.ZeroAddress))
        .to.be.revertedWithCustomError(pots, "PotFull").withArgs(USD6(1), 0);
      for (let i = 0; i < 4; i++) {
        const t = bySymbol[order[i]];
        expect(await t.balanceOf(potsAddress)).to.equal(0n);
        expect((await t.balanceOf(payout.address)) - before[order[i]], order[i]).to.equal(inToken(RATES[order[i]], 5));
        expect(await pots.tokenTotal(1, await t.getAddress())).to.equal(inToken(RATES[order[i]], 5));
      }
    });

    it("values payments with the token's rate, rounding up (so caps bind sooner, never later)", async () => {
      const { pots, idrx, wars, usdt } = await loadFixture(withPot);
      expect(await pots.usdValue(await usdt.getAddress(), usd(2))).to.equal(USD6(2));
      expect(await pots.usdValue(await idrx.getAddress(), 1n)).to.equal(1n); // 0.01 IDRX is worth a fraction of a micro-dollar
      expect(await pots.usdValue(await wars.getAddress(), RATES.wARS)).to.equal(USD6(1));
      expect(await pots.usdValue(await wars.getAddress(), RATES.wARS + 1n)).to.equal(USD6(1) + 1n);
      expect(await pots.usdValue(ethers.ZeroAddress, 5n)).to.equal(0n);
    });

    it("BelowMinimum uses the token's minimum from LokalTags", async () => {
      const { pots, usdt, idrx, carol, potId } = await loadFixture(withPot);
      await expect(pots.connect(carol).payPot(potId, await usdt.getAddress(), usd(0.99), ref("x"), ethers.ZeroAddress)).to.be.revertedWithCustomError(pots, "BelowMinimum").withArgs(usd(0.99), usd(1));
      await expect(pots.connect(carol).payPot(potId, await idrx.getAddress(), RATES.IDRX - 1n, ref("x"), ethers.ZeroAddress)).to.be.revertedWithCustomError(pots, "BelowMinimum");
    });

    it("TokenNotAllowed: not allowed in LokalTags, or no dollar rate here", async () => {
      const { pots, tags, admin, other, usdt, carol, potId } = await loadFixture(withPot);
      const o = await other.getAddress();
      await expect(pots.connect(carol).payPot(potId, o, usd(1), ref("x"), ethers.ZeroAddress)).to.be.revertedWithCustomError(pots, "TokenNotAllowed").withArgs(o);
      const u = await usdt.getAddress();
      await pots.connect(admin).setUsdRate(u, 0);
      await expect(pots.connect(carol).payPot(potId, u, usd(1), ref("x"), ethers.ZeroAddress)).to.be.revertedWithCustomError(pots, "TokenNotAllowed");
      await pots.connect(admin).setUsdRate(u, 1_000_000);
      await tags.connect(admin).setTokenLimits(u, 0, 0, 0, 0, 0);
      await expect(pots.connect(carol).payPot(potId, u, usd(1), ref("x"), ethers.ZeroAddress)).to.be.revertedWithCustomError(pots, "TokenNotAllowed");
    });

    it("OverPaymentLimit: a pot payment can't exceed the token's maximum per payment", async () => {
      const { pots, admin, cngn, carol, potId } = await loadFixture(withPot);
      const c = await cngn.getAddress();
      // Even with a deliberately cheap rate (inside the bounds), a huge amount is refused by the token's own maximum.
      await pots.connect(admin).setUsdRate(c, RATES.cNGN * 10n);
      const huge = LIMITS.cNGN.maxPerDay * 100n;
      await expect(pots.connect(carol).payPot(potId, c, huge, ref("x"), ethers.ZeroAddress))
        .to.be.revertedWithCustomError(pots, "OverPaymentLimit").withArgs(huge, LIMITS.cNGN.maxPerPayment);
    });

    it("a payer can pin the payout wallet: PayoutWalletChanged if it moved", async () => {
      const { pots, tags, admin, usdt, carol, ada, payout, potId, signers } = await loadFixture(withPot);
      const u = await usdt.getAddress();
      await expect(pots.connect(carol).payPot(potId, u, usd(1), ref("a"), payout.address)).to.emit(pots, "PotPaid");
      await tags.connect(admin).proposePayoutWallet(signers[18].address);
      await time.increase(DAY);
      await tags.connect(admin).executePayoutWallet();
      await pots.connect(ada).createPot("Second", (await time.latest()) + DAY, USD6(10), USD6(5));
      await expect(pots.connect(carol).payPot(2, u, usd(1), ref("b"), payout.address))
        .to.be.revertedWithCustomError(pots, "PayoutWalletChanged").withArgs(signers[18].address);
    });

    it("SelfPayment: the host can't pay into their own pot", async () => {
      const { pots, usdt, ada, potId } = await loadFixture(withPot);
      await expect(pots.connect(ada).payPot(potId, await usdt.getAddress(), usd(1), ref("x"), ethers.ZeroAddress)).to.be.revertedWithCustomError(pots, "SelfPayment");
    });

    it("PotNotFound for an id that was never created", async () => {
      const { pots, usdt, carol } = await loadFixture(withPot);
      await expect(pots.connect(carol).payPot(9, await usdt.getAddress(), usd(1), ref("x"), ethers.ZeroAddress)).to.be.revertedWithCustomError(pots, "PotNotFound").withArgs(9);
      await expect(pots.potInfo(9)).to.be.revertedWithCustomError(pots, "PotNotFound");
      await expect(pots.connect(carol).closePot(9)).to.be.revertedWithCustomError(pots, "PotNotFound");
    });

    it("PotExpired from the closing second on (time travel)", async () => {
      const { pots, usdt, carol, potId, closesAt } = await loadFixture(withPot);
      const u = await usdt.getAddress();
      await time.setNextBlockTimestamp(closesAt - 1);
      await expect(pots.connect(carol).payPot(potId, u, usd(1), ref("a"), ethers.ZeroAddress)).to.emit(pots, "PotPaid");
      await time.setNextBlockTimestamp(closesAt);
      await expect(pots.connect(carol).payPot(potId, u, usd(1), ref("b"), ethers.ZeroAddress)).to.be.revertedWithCustomError(pots, "PotExpired").withArgs(potId, closesAt);
      expect((await pots.potInfo(potId)).open).to.equal(false);
    });

    it("closePot: host only, once; then PotIsClosed", async () => {
      const { pots, usdt, ada, carol, potId } = await loadFixture(withPot);
      await pots.connect(carol).payPot(potId, await usdt.getAddress(), usd(2), ref("a"), ethers.ZeroAddress);
      await expect(pots.connect(carol).closePot(potId)).to.be.revertedWithCustomError(pots, "NotHost");
      await expect(pots.connect(ada).closePot(potId)).to.emit(pots, "PotClosed").withArgs(potId, ada.address, USD6(2), 1);
      await expect(pots.connect(ada).closePot(potId)).to.be.revertedWithCustomError(pots, "PotIsClosed");
      await expect(pots.connect(carol).payPot(potId, await usdt.getAddress(), usd(1), ref("b"), ethers.ZeroAddress)).to.be.revertedWithCustomError(pots, "PotIsClosed");
      expect((await pots.potInfo(potId)).open).to.equal(false);
    });

    it("Paused follows LokalTags' switch; closing still works", async () => {
      const { pots, tags, admin, usdt, ada, carol, potId } = await loadFixture(withPot);
      await tags.connect(admin).pause();
      await expect(pots.connect(carol).payPot(potId, await usdt.getAddress(), usd(1), ref("a"), ethers.ZeroAddress)).to.be.revertedWithCustomError(pots, "Paused");
      await expect(pots.connect(ada).closePot(potId)).to.emit(pots, "PotClosed");
    });

    it("HostNotEligible once the host gives up their tag, or turns out to be a contract", async () => {
      const { pots, tags, usdt, ada, carol, potId } = await loadFixture(withPot);
      const u = await usdt.getAddress();
      await network.provider.send("hardhat_setCode", [ada.address, "0x6000"]);
      await expect(pots.connect(carol).payPot(potId, u, usd(1), ref("a"), ethers.ZeroAddress)).to.be.revertedWithCustomError(pots, "HostNotEligible").withArgs(ada.address);
      await network.provider.send("hardhat_setCode", [ada.address, "0x"]);
      await tags.connect(ada).release();
      await expect(pots.connect(carol).payPot(potId, u, usd(1), ref("a"), ethers.ZeroAddress)).to.be.revertedWithCustomError(pots, "HostNotEligible");
    });

    it("OverDailyLimit for all pots together; the next UTC day opens again", async () => {
      const { pots, tags, admin, usdt, signers, potsAddress } = await loadFixture(deployFixture);
      await pots.connect(admin).setLimits(USD6(10), USD6(5), USD6(10), USD6(12));
      const hosts = signers.slice(11, 13);
      for (const [i, h] of hosts.entries()) {
        await tags.connect(h).claim(`host${i}`, "");
        await pots.connect(h).createPot(`Pot ${i}`, (await time.latest()) + 3 * DAY, USD6(10), USD6(5));
      }
      const guests = signers.slice(13, 17);
      for (const g of guests) {
        await usdt.mint(g.address, usd(100));
        await usdt.connect(g).approve(potsAddress, ethers.MaxUint256);
      }
      const u = await usdt.getAddress();
      await pots.connect(guests[0]).payPot(1, u, usd(5), ref("1"), ethers.ZeroAddress);
      await pots.connect(guests[1]).payPot(2, u, usd(5), ref("2"), ethers.ZeroAddress);
      await expect(pots.connect(guests[2]).payPot(1, u, usd(3), ref("3"), ethers.ZeroAddress)).to.be.revertedWithCustomError(pots, "OverDailyLimit").withArgs(USD6(3), USD6(2));
      await pots.connect(guests[2]).payPot(1, u, usd(2), ref("4"), ethers.ZeroAddress);
      expect((await pots.remaining(1, guests[3].address))[3]).to.equal(0n);
      await time.increaseTo(nextDayStart(await time.latest()) + 10);
      await expect(pots.connect(guests[3]).payPot(2, u, usd(5), ref("5"), ethers.ZeroAddress)).to.emit(pots, "PotPaid");
    });

    it("does not count toward LokalTags' per-recipient daily limit (separate caps)", async () => {
      const { pots, tags, usdt, carol, dave, ada, potId } = await loadFixture(withPot);
      const u = await usdt.getAddress();
      await pots.connect(carol).payPot(potId, u, usd(5), ref("pot"), ethers.ZeroAddress);
      expect(await tags.remainingToday(u, ada.address, dave.address)).to.deep.equal([usd(25), usd(25), usd(250)]);
      await expect(tags.connect(dave).payTag("ada", u, usd(25), ref("tag"), ethers.ZeroAddress)).to.emit(tags, "TagPaid");
    });

    it("validatePotPayment is a dry run naming the same error", async () => {
      const { pots, usdt, carol, ada, potId } = await loadFixture(withPot);
      const u = await usdt.getAddress();
      expect(await pots.validatePotPayment(potId, u, usd(2), carol.address)).to.equal(USD6(2));
      await expect(pots.validatePotPayment(potId, u, usd(6), carol.address)).to.be.revertedWithCustomError(pots, "OverPayerCap");
      await expect(pots.validatePotPayment(potId, u, usd(2), ada.address)).to.be.revertedWithCustomError(pots, "SelfPayment");
    });

    it("TransferAmountMismatch for a token that delivers less", async () => {
      const { pots, tags, admin, carol, potsAddress, potId } = await loadFixture(withPot);
      const fee = await (await ethers.getContractFactory("MockFeeERC20")).deploy();
      const f = await fee.getAddress();
      await tags.connect(admin).setTokenLimits(f, usd(1), usd(25), usd(25), usd(25), usd(100));
      await pots.connect(admin).setUsdRate(f, 1_000_000);
      await fee.mint(carol.address, usd(10));
      await fee.connect(carol).approve(potsAddress, ethers.MaxUint256);
      await expect(pots.connect(carol).payPot(potId, f, usd(2), ref("x"), ethers.ZeroAddress)).to.be.revertedWithCustomError(pots, "TransferAmountMismatch");
    });

    it("OverHostDailyLimit: one host's pots together take at most the per-host daily cap", async () => {
      const { pots, tags, admin, usdt, signers, potsAddress, ada } = await loadFixture(deployFixture);
      await pots.connect(admin).setLimits(USD6(10), USD6(5), USD6(12), USD6(100));
      await tags.connect(ada).claim("ada", "");
      const closes = (await time.latest()) + DAY;
      await pots.connect(ada).createPot("one", closes, USD6(10), USD6(5));
      await pots.connect(ada).createPot("two", closes, USD6(10), USD6(5));
      const u = await usdt.getAddress();
      const guests = signers.slice(11, 15);
      for (const g of guests) {
        await usdt.mint(g.address, usd(100));
        await usdt.connect(g).approve(potsAddress, ethers.MaxUint256);
      }
      await pots.connect(guests[0]).payPot(1, u, usd(5), ref("1"), ethers.ZeroAddress);
      await pots.connect(guests[1]).payPot(2, u, usd(5), ref("2"), ethers.ZeroAddress);
      expect((await pots.remaining(2, guests[2].address))[2]).to.equal(USD6(2));
      await expect(pots.connect(guests[2]).payPot(2, u, usd(3), ref("3"), ethers.ZeroAddress))
        .to.be.revertedWithCustomError(pots, "OverHostDailyLimit").withArgs(USD6(3), USD6(2));
      await time.increaseTo(nextDayStart(await time.latest()) + 10);
      await expect(pots.connect(guests[2]).payPot(2, u, usd(3), ref("4"), ethers.ZeroAddress)).to.emit(pots, "PotPaid");
    });

    it("sybil: one host with 20 payers can no longer drain the pots' whole day", async () => {
      const { pots, tags, usdt, signers, potsAddress, ada, bob, carol } = await loadFixture(deployFixture);
      const u = await usdt.getAddress();
      await tags.connect(ada).claim("ada", "");
      await tags.connect(bob).claim("bob", "");
      const closes = (await time.latest()) + 3600;
      await pots.connect(ada).createPot("griefer", closes, USD6(100), USD6(5));
      await pots.connect(bob).createPot("honest wedding", closes, USD6(100), USD6(5));
      for (let i = 0; i < 21; i++) {
        const g = ethers.Wallet.createRandom().connect(ethers.provider);
        await signers[0].sendTransaction({ to: g.address, value: ethers.parseEther("1") });
        await usdt.mint(g.address, usd(5));
        await usdt.connect(g).approve(potsAddress, usd(5));
        const call = pots.connect(g).payPot(1, u, usd(5), ref(`g${i}`), ethers.ZeroAddress);
        if (i < 20) await call;
        else await expect(call).to.be.revertedWithCustomError(pots, "PotFull");
      }
      // The griefer's $100 is the per-host cap; the day ($250) still has room for everyone else.
      expect((await pots.remaining(2, carol.address))[3]).to.equal(USD6(150));
      await expect(pots.connect(carol).payPot(2, u, usd(1), ref("h"), ethers.ZeroAddress)).to.emit(pots, "PotPaid");
    });

    it("never holds funds across a random run of pot payments", async () => {
      const { pots, potsAddress, router, bySymbol, signers, tags, payout } = await loadFixture(deployFixture);
      const hosts = signers.slice(11, 14);
      for (const [i, h] of hosts.entries()) {
        await tags.connect(h).claim(`host${i}`, "");
        await pots.connect(h).createPot(`Pot ${i}`, (await time.latest()) + 5 * DAY, USD6(100), USD6(5));
      }
      const guests = signers.slice(2, 10);
      let seed = 99;
      const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
      const syms = Object.keys(bySymbol) as (keyof typeof bySymbol)[];
      const start: Record<string, bigint> = {};
      for (const s of syms) start[s] = await bySymbol[s].balanceOf(payout.address);
      const paid: Record<string, bigint> = {};
      for (let i = 0; i < 60; i++) {
        const s = syms[rnd(syms.length)];
        const amount = inToken(RATES[s], 1 + rnd(4));
        try {
          await pots.connect(guests[rnd(guests.length)]).payPot(1 + rnd(3), await bySymbol[s].getAddress(), amount, ref(String(i)), ethers.ZeroAddress);
          paid[s] = (paid[s] ?? 0n) + amount;
        } catch {
          /* a cap refused it; nothing moved */
        }
        if (i % 20 === 19) await time.increase(DAY);
      }
      for (const s of syms) {
        expect(await bySymbol[s].balanceOf(potsAddress), s).to.equal(0n);
        expect(await bySymbol[s].balanceOf(router), s).to.equal(0n);
        expect(await bySymbol[s].balanceOf(payout.address), s).to.equal(start[s] + (paid[s] ?? 0n));
      }
    });

    it("has no function that could move anyone's tokens except the payer's own payPot (and rescue of stray tokens)", async () => {
      const { pots } = await loadFixture(deployFixture);
      const writes = pots.interface.fragments
        .filter((f: any) => f.type === "function" && !["view", "pure"].includes(f.stateMutability))
        .map((f: any) => f.name)
        .sort();
      expect(writes).to.deep.equal(["closePot", "createPot", "payPot", "rescue", "setLimits", "setUsdRate"]);
    });
  });
});
