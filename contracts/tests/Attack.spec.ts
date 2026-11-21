// The independent audit's attack scenarios, ported and re-asserted against the fixed contracts. Each test states the
// attack, then what the contracts do now. Attack contracts live in contracts/mocks/AttackTokens.sol (test-only).
import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, setBalance, time } from "@nomicfoundation/hardhat-network-helpers";
import { DAY, LIMITS, deployFixture, fillDay, limitsTuple, usd } from "./helpers/fixture";

const ref = (s: string) => ethers.id(s);
const USD6 = (n: number | string) => ethers.parseUnits(String(n), 6);
const NO_PIN = ethers.ZeroAddress;

async function wallets(n: number) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const w = ethers.Wallet.createRandom().connect(ethers.provider);
    await setBalance(w.address, 10n ** 20n);
    out.push(w);
  }
  return out;
}

async function base() {
  const f = await deployFixture();
  await f.tags.connect(f.ada).claim("ada", "");
  return f;
}

/** Allows `token` in LokalTags with the USD₮ limits. */
async function allowToken(f: Awaited<ReturnType<typeof base>>, token: { getAddress(): Promise<string> }) {
  const a = await token.getAddress();
  await f.tags.connect(f.admin).setTokenLimits(a, ...limitsTuple(LIMITS.USDT));
  return a;
}

describe("audit attacks (fixed contracts)", () => {
  describe("reentrancy through token hooks", () => {
    it("payer hook re-enters payTag with the same token: the whole transaction reverts, nothing counted", async () => {
      const f = await loadFixture(base);
      const hook = await (await ethers.getContractFactory("HookERC20")).deploy();
      const h = await allowToken(f, hook);
      const payer = await (await ethers.getContractFactory("ReentrantPayer")).deploy(f.router);
      await hook.mint(await payer.getAddress(), usd(1000));
      await payer.approve(h, f.router);
      await payer.setInner("ada", h, usd(5));
      await expect(payer.pay("ada", h, usd(10))).to.be.revertedWithCustomError(f.tags, "TransferAmountMismatch").withArgs(usd(10), usd(15));
      const day = BigInt(Math.floor((await time.latest()) / DAY));
      expect(await f.tags.usedOn(h, f.ada.address, day)).to.deep.equal([0n, 0n, 0n]);
    });

    it("re-entry can't bust the per-recipient cap: the inner call sees the outer call's usage (checks-effects-interactions)", async () => {
      const f = await loadFixture(base);
      const hook = await (await ethers.getContractFactory("HookERC20")).deploy();
      const h = await allowToken(f, hook);
      const payer = await (await ethers.getContractFactory("ReentrantPayer")).deploy(f.router);
      await hook.mint(await payer.getAddress(), usd(1000));
      await payer.approve(h, f.router);
      await payer.setInner("ada", h, usd(1));
      await expect(payer.pay("ada", h, usd(25))).to.be.revertedWithCustomError(f.tags, "OverRecipientDailyLimit");
    });

    it("re-entry with a different token: both legitimate payments go through, both counted, nothing held", async () => {
      const f = await loadFixture(base);
      const hook = await (await ethers.getContractFactory("HookERC20")).deploy();
      const h = await allowToken(f, hook);
      const payer = await (await ethers.getContractFactory("ReentrantPayer")).deploy(f.router);
      const pa = await payer.getAddress();
      const u = await f.usdt.getAddress();
      await hook.mint(pa, usd(1000));
      await f.usdt.mint(pa, usd(1000));
      await payer.approve(h, f.router);
      await payer.approve(u, f.router);
      await payer.setInner("ada", u, usd(25));
      const before = await f.usdt.balanceOf(f.payout.address);
      await expect(payer.pay("ada", h, usd(25))).to.emit(f.tags, "TagPaid");
      expect((await f.usdt.balanceOf(f.payout.address)) - before).to.equal(usd(25));
      expect(await hook.balanceOf(f.payout.address)).to.equal(usd(25));
      expect(await f.usdt.balanceOf(f.router)).to.equal(0n);
      expect((await f.tags.remainingToday(u, f.ada.address, pa))[0]).to.equal(0n);
    });

    it("a token that re-enters payTag as itself can only spend its own funds, and the outer payment reverts", async () => {
      const f = await loadFixture(base);
      const re = await (await ethers.getContractFactory("SelfReentrantERC20")).deploy();
      const a = await allowToken(f, re);
      await re.mint(a, usd(100));
      await re.selfApprove(f.router, usd(100));
      await re.mint(f.carol.address, usd(100));
      await re.connect(f.carol).approve(f.router, usd(100));
      await re.arm(f.router, f.tags.interface.encodeFunctionData("payTag", ["ada", a, usd(5), ref("x"), NO_PIN]));
      await expect(f.tags.connect(f.carol).payTag("ada", a, usd(5), ref("o"), NO_PIN)).to.be.revertedWithCustomError(f.tags, "TransferAmountMismatch");
    });

    it("pots: a payer hook re-entering payPot sees the outer payment's usage (per-payer cap) or reverts the whole thing", async () => {
      const f = await loadFixture(base);
      const hook = await (await ethers.getContractFactory("HookERC20")).deploy();
      const h = await allowToken(f, hook);
      await f.pots.connect(f.admin).setUsdRate(h, 1_000_000);
      await f.pots.connect(f.ada).createPot("w", (await time.latest()) + DAY, USD6(100), USD6(5));
      const payer = await (await ethers.getContractFactory("ReentrantPotPayer")).deploy(f.potsAddress);
      const pa = await payer.getAddress();
      const u = await f.usdt.getAddress();
      await hook.mint(pa, usd(100));
      await f.usdt.mint(pa, usd(100));
      await payer.approve(h, f.potsAddress);
      await payer.approve(u, f.potsAddress);
      // Same token: the inner payment lands inside the outer transfer, so the outer balance check fails.
      await payer.setInner(1, h, usd(1));
      await expect(payer.pay(1, h, usd(2))).to.be.revertedWithCustomError(f.pots, "TransferAmountMismatch").withArgs(usd(2), usd(3));
      // Different token: the inner call already sees the outer $3 against the $5 per-payer cap.
      await payer.setInner(1, u, usd(3));
      await expect(payer.pay(1, h, usd(3))).to.be.revertedWithCustomError(f.pots, "OverPayerCap").withArgs(USD6(3), USD6(2));
      await payer.setInner(1, u, usd(2));
      await expect(payer.pay(1, h, usd(3))).to.emit(f.pots, "PotPaid");
      expect(await f.pots.paidBy(1, pa)).to.equal(USD6(5));
      expect(await hook.balanceOf(f.potsAddress)).to.equal(0n);
      expect(await f.usdt.balanceOf(f.potsAddress)).to.equal(0n);
    });
  });

  describe("non-standard tokens", () => {
    it("transferFrom returns false: SafeERC20 reverts, no usage counted", async () => {
      const f = await loadFixture(base);
      const t = await (await ethers.getContractFactory("FalseERC20")).deploy();
      const a = await allowToken(f, t);
      await expect(f.tags.connect(f.carol).payTag("ada", a, usd(5), ref("x"), NO_PIN)).to.be.revertedWithCustomError(f.tags, "SafeERC20FailedOperation");
      expect((await f.tags.remainingToday(a, f.ada.address, f.carol.address))[0]).to.equal(usd(25));
    });

    it("transferFrom returns true but moves nothing: TransferAmountMismatch(amount, 0)", async () => {
      const f = await loadFixture(base);
      const t = await (await ethers.getContractFactory("LyingERC20")).deploy();
      const a = await allowToken(f, t);
      await expect(f.tags.connect(f.carol).payTag("ada", a, usd(5), ref("x"), NO_PIN)).to.be.revertedWithCustomError(f.tags, "TransferAmountMismatch").withArgs(usd(5), 0);
    });

    it("a legacy token whose transferFrom returns nothing works", async () => {
      const f = await loadFixture(base);
      const t = await (await ethers.getContractFactory("NoReturnERC20")).deploy();
      const a = await allowToken(f, t);
      await t.mint(f.carol.address, usd(100));
      await t.connect(f.carol).approve(f.router, usd(100));
      await expect(f.tags.connect(f.carol).payTag("ada", a, usd(5), ref("x"), NO_PIN)).to.emit(f.tags, "TagPaid");
      expect(await t.balanceOf(f.payout.address)).to.equal(usd(5));
    });

    it("the payout wallet paying a tag: reverts (its balance doesn't change), never silently counted", async () => {
      const f = await loadFixture(base);
      const u = await f.usdt.getAddress();
      await f.usdt.mint(f.payout.address, usd(100));
      await f.usdt.connect(f.payout).approve(f.router, usd(100));
      await expect(f.tags.connect(f.payout).payTag("ada", u, usd(5), ref("x"), NO_PIN)).to.be.revertedWithCustomError(f.tags, "TransferAmountMismatch");
    });
  });

  describe("permit", () => {
    async function sig(owner: any, token: any, spender: string, value: bigint, deadline: bigint) {
      const { chainId } = await ethers.provider.getNetwork();
      const domain = { name: "Tether USD", version: "1", chainId, verifyingContract: await token.getAddress() };
      const types = { Permit: [
        { name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
      ] };
      const nonce = await token.nonces(owner.address);
      return ethers.Signature.from(await owner.signTypedData(domain, types, { owner: owner.address, spender, value, nonce, deadline }));
    }

    it("someone replays a payer's permit: they still can't spend it (payTag always pulls from msg.sender)", async () => {
      const f = await loadFixture(base);
      const payer = f.signers[16];
      await f.usdt.mint(payer.address, usd(100));
      const u = await f.usdt.getAddress();
      const dl = BigInt((await time.latest()) + 3600);
      const s = await sig(payer, f.usdt, f.router, usd(5), dl);
      await f.usdt.connect(f.stranger).permit(payer.address, f.router, usd(5), dl, s.v, s.r, s.s);
      const before = await f.usdt.balanceOf(f.stranger.address);
      await f.tags.connect(f.stranger).payTag("ada", u, usd(5), ref("steal"), NO_PIN);
      expect(await f.usdt.balanceOf(f.stranger.address)).to.equal(before - usd(5));
      expect(await f.usdt.allowance(payer.address, f.router)).to.equal(usd(5));
      await expect(f.tags.connect(payer).payTagWithPermit("ada", u, usd(5), ref("p"), NO_PIN, dl, s.v, s.r, s.s)).to.emit(f.tags, "TagPaid");
    });

    it("a permit replaces an existing unlimited allowance with exactly the amount (benign; documented)", async () => {
      const f = await loadFixture(base);
      const u = await f.usdt.getAddress();
      expect(await f.usdt.allowance(f.carol.address, f.router)).to.equal(ethers.MaxUint256);
      const dl = BigInt((await time.latest()) + 3600);
      const s = await sig(f.carol, f.usdt, f.router, usd(5), dl);
      await f.tags.connect(f.carol).payTagWithPermit("ada", u, usd(5), ref("p"), NO_PIN, dl, s.v, s.r, s.s);
      expect(await f.usdt.allowance(f.carol.address, f.router)).to.equal(0n);
    });
  });

  describe("limit splitting and griefing (M-1)", () => {
    it("4 sybil tags + 1 payer can no longer use up the USD₮ day: the payer stops at $25", async () => {
      const f = await loadFixture(base);
      const u = await f.usdt.getAddress();
      const sy = f.signers.slice(10, 14);
      for (let i = 0; i < 4; i++) await f.tags.connect(sy[i]).claim(`sybil${i}`, "");
      await f.tags.connect(f.stranger).payTag("sybil0", u, usd(25), ref("g"), NO_PIN);
      await expect(f.tags.connect(f.stranger).payTag("sybil1", u, usd(25), ref("g"), NO_PIN)).to.be.revertedWithCustomError(f.tags, "OverPayerDailyLimit");
      await expect(f.tags.connect(f.carol).payTag("ada", u, usd(1), ref("honest"), NO_PIN)).to.emit(f.tags, "TagPaid");
    });

    it("exhausting a token's day now needs at least 10 distinct paying wallets (and 10 recipients)", async () => {
      const f = await loadFixture(base);
      const u = await f.usdt.getAddress();
      const L = LIMITS.USDT;
      expect(L.maxPerDay / L.maxPerPayerPerDay).to.equal(10n);
      expect(L.maxPerDay / L.maxPerRecipientPerDay).to.equal(10n);
      await fillDay(f, f.usdt, usd(25));
      await expect(f.tags.connect(f.carol).payTag("ada", u, usd(1), ref("honest"), NO_PIN)).to.be.revertedWithCustomError(f.tags, "OverDailyLimit");
    });

    it("inherent and documented: one recipient can take ~$25 in each allowed token per day, plus pots", async () => {
      const f = await loadFixture(base);
      const payers = [f.carol, f.dave, f.erin, f.frank, f.gina];
      let i = 0;
      for (const [sym, t] of Object.entries(f.bySymbol)) {
        await expect(f.tags.connect(payers[i++]).payTag("ada", await (t as any).getAddress(), LIMITS[sym].maxPerPayment, ref(sym), NO_PIN)).to.emit(f.tags, "TagPaid");
      }
    });

    it("one host + 20 sybil payers can't drain the pots' day any more: the per-host cap stops at $100", async () => {
      const f = await loadFixture(base);
      const u = await f.usdt.getAddress();
      await f.tags.connect(f.bob).claim("bob", "");
      const closes = (await time.latest()) + 3600;
      await f.pots.connect(f.ada).createPot("griefer", closes, USD6(100), USD6(5));
      await f.pots.connect(f.ada).createPot("griefer 2", closes, USD6(100), USD6(5));
      await f.pots.connect(f.bob).createPot("honest wedding", closes, USD6(100), USD6(5));
      const guests = await wallets(21);
      for (const g of guests) {
        await f.usdt.mint(g.address, usd(5));
        await f.usdt.connect(g).approve(f.potsAddress, usd(5));
      }
      for (const g of guests.slice(0, 20)) await f.pots.connect(g).payPot(1, u, usd(5), ref("g"), NO_PIN);
      await expect(f.pots.connect(guests[20]).payPot(2, u, usd(5), ref("g"), NO_PIN)).to.be.revertedWithCustomError(f.pots, "OverHostDailyLimit");
      await expect(f.pots.connect(f.carol).payPot(3, u, usd(1), ref("h"), NO_PIN)).to.emit(f.pots, "PotPaid");
    });

    it("inherent and documented: a person with N wallets (N tags) can be paid N x the per-recipient cap", async () => {
      const f = await loadFixture(base);
      const u = await f.usdt.getAddress();
      await f.tags.connect(f.bob).claim("ada2", "Ada");
      await f.tags.connect(f.carol).payTag("ada", u, usd(25), ref("1"), NO_PIN);
      await expect(f.tags.connect(f.dave).payTag("ada2", u, usd(25), ref("2"), NO_PIN)).to.emit(f.tags, "TagPaid");
    });
  });

  describe("pots: host changes and rates (L-1)", () => {
    it("a host who switches tags keeps receiving; releasing stops payments; reclaiming any tag resumes them", async () => {
      const f = await loadFixture(base);
      const u = await f.usdt.getAddress();
      await f.pots.connect(f.ada).createPot("w", (await time.latest()) + 3 * DAY, USD6(100), USD6(5));
      await f.tags.connect(f.ada).claim("ada_new", "");
      await expect(f.pots.connect(f.carol).payPot(1, u, usd(2), ref("a"), NO_PIN)).to.emit(f.pots, "PotPaid").withArgs(1, f.ada.address, f.carol.address, u, usd(2), ref("a"), USD6(2), USD6(2));
      await f.tags.connect(f.ada).release();
      await expect(f.pots.connect(f.carol).payPot(1, u, usd(1), ref("b"), NO_PIN)).to.be.revertedWithCustomError(f.pots, "HostNotEligible");
      await expect(f.tags.connect(f.bob).claim("ada_new", "")).to.be.revertedWithCustomError(f.tags, "TagLocked");
      await f.tags.connect(f.ada).claim("totally_other", "");
      await expect(f.pots.connect(f.carol).payPot(1, u, usd(1), ref("c"), NO_PIN)).to.emit(f.pots, "PotPaid");
    });

    it("a mistyped rate (18 decimals for a 6-decimal token) is refused, and a huge amount hits the token's maximum", async () => {
      const f = await loadFixture(base);
      const c = await f.cngn.getAddress();
      await f.pots.connect(f.ada).createPot("w", (await time.latest()) + 3600, USD6(100), USD6(5));
      await expect(f.pots.connect(f.admin).setUsdRate(c, 1441n * 10n ** 18n)).to.be.revertedWithCustomError(f.pots, "RateOutOfBounds");
      const huge = LIMITS.cNGN.maxPerDay * 100n;
      await expect(f.pots.connect(f.carol).payPot(1, c, huge, ref("x"), NO_PIN)).to.be.revertedWithCustomError(f.pots, "OverPaymentLimit");
    });
  });

  describe("registry (H-1, L-5, L-2)", () => {
    it("brand tags 'lokal' and 'lokalpay' are reserved", async () => {
      const f = await loadFixture(deployFixture);
      await expect(f.tags.connect(f.stranger).claim("lokal", "Lokal Support")).to.be.revertedWithCustomError(f.tags, "TagReserved");
      await expect(f.tags.connect(f.bob).claim("lokalpay", "Lokal Pay")).to.be.revertedWithCustomError(f.tags, "TagReserved");
    });

    it("the listed lookalikes are reserved; others still pass (the list is exact-match by design)", async () => {
      const f = await loadFixture(deployFixture);
      for (const t of ["lokal_support", "lokalsupport", "lokal_help", "lokal_team", "lokal_official", "lokalofficial", "support_team",
        "help_desk", "helpdesk", "admin1", "celo_team", "celoteam", "minipay_support", "textile_fx"]) {
        await expect(f.tags.connect(f.stranger).claim(t, ""), t).to.be.revertedWithCustomError(f.tags, "TagReserved");
      }
      await expect(f.tags.connect(f.stranger).claim("supp0rt", "")).to.emit(f.tags, "TagClaimed");
    });

    it("bidi overrides and zero-width characters are refused in display names", async () => {
      const f = await loadFixture(deployFixture);
      expect(await f.tags.isValidName("Ada‮troppus lokaL")).to.equal(false);
      expect(await f.tags.isValidName("Lokal​Support")).to.equal(false);
      expect(await f.tags.isValidName("Ada⁦x⁩")).to.equal(false);
      expect(await f.tags.isValidName("A﻿da")).to.equal(false);
      expect(await f.tags.isValidName("Adé Ọlá 🇳🇬")).to.equal(true);
    });

    it("known limit (documented, low impact): claim-in-constructor then self-destruct leaves a code-less tag holder", async () => {
      const f = await loadFixture(deployFixture);
      const fac = await (await ethers.getContractFactory("Create2Factory")).deploy();
      const init = (await (await ethers.getContractFactory("ClaimAndVanish")).getDeployTransaction(f.router, "ghost")).data;
      const predicted = await fac.predict(ethers.ZeroHash, ethers.keccak256(init));
      await fac.deploy(ethers.ZeroHash, init);
      expect(await f.tags.ownerOf("ghost")).to.equal(predicted);
      expect(await ethers.provider.getCode(predicted)).to.equal("0x");
      // The address can be paid (the money goes to the agent's payout wallet, and the agent pays the code-less address,
      // which only the same CREATE2 deployer can ever control again). Nobody else's funds are at risk.
      await expect(f.tags.connect(f.carol).payTag("ghost", await f.usdt.getAddress(), usd(5), ref("x"), NO_PIN)).to.emit(f.tags, "TagPaid");
    });
  });

  describe("admin (L-3, I-1)", () => {
    it("a payout wallet change can't redirect an already-signed payment: it waits 24 h, and a pinned payment reverts", async () => {
      const f = await loadFixture(base);
      const u = await f.usdt.getAddress();
      const evil = f.signers[19];
      await f.tags.connect(f.admin).proposePayoutWallet(evil.address);
      // During the 24 hours, payments still go to the old wallet.
      await f.tags.connect(f.carol).payTag("ada", u, usd(10), ref("x"), f.payout.address);
      expect(await f.usdt.balanceOf(evil.address)).to.equal(0n);
      await time.increase(DAY);
      await f.tags.connect(f.admin).executePayoutWallet();
      await expect(f.tags.connect(f.dave).payTag("ada", u, usd(10), ref("y"), f.payout.address)).to.be.revertedWithCustomError(f.tags, "PayoutWalletChanged");
    });

    it("tokens sent to either contract by mistake can be rescued by the admin", async () => {
      const f = await loadFixture(base);
      const u = await f.usdt.getAddress();
      await f.usdt.connect(f.carol).transfer(f.router, usd(3));
      await f.usdt.connect(f.carol).transfer(f.potsAddress, usd(2));
      await f.tags.connect(f.admin).rescue(u, f.carol.address, usd(3));
      await f.pots.connect(f.admin).rescue(u, f.carol.address, usd(2));
      expect(await f.usdt.balanceOf(f.router)).to.equal(0n);
      expect(await f.usdt.balanceOf(f.potsAddress)).to.equal(0n);
    });

    it("re-enabling a token mid-day keeps its usage", async () => {
      const f = await loadFixture(base);
      const u = await f.usdt.getAddress();
      await f.tags.connect(f.carol).payTag("ada", u, usd(25), ref("1"), NO_PIN);
      await f.tags.connect(f.admin).setTokenLimits(u, 0, 0, 0, 0, 0);
      await f.tags.connect(f.admin).setTokenLimits(u, ...limitsTuple(LIMITS.USDT));
      await expect(f.tags.connect(f.dave).payTag("ada", u, usd(1), ref("2"), NO_PIN)).to.be.revertedWithCustomError(f.tags, "OverRecipientDailyLimit");
    });
  });
});
