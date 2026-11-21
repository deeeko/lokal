/**
 * The site's pot calldata (site/assets/lokal-contracts.js and site/assets/pots.js) against the real LokalPots:
 * createPot, the exact approve, payPot and closePot as a wallet would send them (raw transactions with the attribution
 * suffix), the Spray Wall's row decoded from the real PotPaid (with the payer's currency choice, without the payer),
 * the dollar rounding and the room the page shows, and refusals decoded to the sentences the page shows before
 * anything is signed.
 */
import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { deployFixture, usd, DAY } from "./helpers/fixture";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const site = require("../../site/assets/lokal-contracts.js");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pots = require("../../site/assets/pots.js");

const send = (signer: any, to: string, data: string) => signer.sendTransaction({ to, data, value: 0 });

describe("Site pot calldata on the real LokalPots", () => {
  async function fixture() {
    const f = await deployFixture();
    await f.tags.connect(f.ada).claim("ada", "Ada Obi");
    return { ...f, guest: f.signers[16], guest2: f.signers[17] };
  }
  /** The plain-English refusal the site shows for a call from `from`, or null when it would go through. */
  async function refusal(from: any, to: string, data: string, ctx: object) {
    try {
      await ethers.provider.call({ from: from.address, to, data });
      return null;
    } catch (e: any) {
      return site.explainRevert(site.revertDataOf(e) ?? e?.data, ctx);
    }
  }

  it("the site's constants match the contract's", async () => {
    const { pots: p } = await loadFixture(fixture);
    expect(await p.MAX_OPEN_TIME()).to.equal(BigInt(site.POT_MAX_OPEN_SECONDS));
    expect(await p.MAX_TITLE_BYTES()).to.equal(BigInt(site.POT_TITLE_MAX_BYTES));
    expect(await p.potCount()).to.equal(0n);
  });

  it("createPot from the site opens a pot exactly as the form asked, on the chain's clock", async () => {
    const { pots: p, potsAddress, ada } = await loadFixture(fixture);
    const chainNow = await time.latest();
    const closesAt = pots.closesAtFor({ preset: "14d" }, chainNow);
    const title = pots.cleanTitle("  Ada & Tunde's wedding 💍  ");
    expect(pots.potTitleError(title)).to.equal(null);
    const data = site.createPotData({ title, closesAt, potCapUsd6: usd(100), perPayerCapUsd6: usd(5) });
    const rc = await (await send(ada, potsAddress, data)).wait();
    const created = rc.logs.map((l: any) => site.decodePotCreated(l)).find(Boolean);
    expect(created.potId).to.equal(1n);
    expect(created.title).to.equal("Ada & Tunde's wedding 💍");
    expect(created.host.toLowerCase()).to.equal(ada.address.toLowerCase());
    const info = site.decodePotInfo(await ethers.provider.call({ to: potsAddress, data: site.FN.potInfo + ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [1n]).slice(2) }));
    expect([info.title, info.closesAt, info.capUsd6, info.perPayerCapUsd6, info.open]).to.deep.equal([title, closesAt, usd(100), usd(5), true]);
    expect(await p.potCount()).to.equal(1n);
    // every title the site's rules accept, the contract accepts too (and the ones it refuses, the contract refuses)
    for (const t of ["x".repeat(60), "💍".repeat(15), "Àdùkẹ́ at 30", "Bisi & Femi"]) {
      expect(pots.potTitleError(t)).to.equal(null);
      expect(await refusal(ada, potsAddress, site.createPotData({ title: t, closesAt, potCapUsd6: usd(10), perPayerCapUsd6: usd(1) }), { creating: true })).to.equal(null, t);
    }
    for (const t of ["x".repeat(61), "💍".repeat(16), "a\nb", "a​b", " lead"]) {
      // the site refuses it, or (edge spaces) trims it before sending
      if (t.startsWith(" ")) expect(pots.cleanTitle(t)).to.equal(t.trim());
      else expect(pots.potTitleError(t)).to.not.equal(null);
      const r = await refusal(ada, potsAddress, site.createPotData({ title: t, closesAt, potCapUsd6: usd(10), perPayerCapUsd6: usd(1) }), { creating: true });
      expect(r?.name).to.equal("InvalidTitle", JSON.stringify(t));
    }
  });

  it("create refusals decode to the form's plain English: no tag, a late closing time, caps over the maxima", async () => {
    const { potsAddress, bob, ada } = await loadFixture(fixture);
    const now = await time.latest();
    const ok = { title: "Party", closesAt: now + DAY, potCapUsd6: usd(10), perPayerCapUsd6: usd(2) };
    const noTag = await refusal(bob, potsAddress, site.createPotData(ok), { creating: true });
    expect(noTag.name).to.equal("HostNotEligible");
    expect(noTag.message).to.match(/holds a Lokal tag can open a pot/);
    const late = await refusal(ada, potsAddress, site.createPotData({ ...ok, closesAt: now + 15 * DAY }), { creating: true });
    expect(late.name).to.equal("InvalidCloseTime");
    const caps = await refusal(ada, potsAddress, site.createPotData({ ...ok, potCapUsd6: usd(101) }), { creating: true });
    expect(caps.name).to.equal("InvalidPotCaps");
    // the form's own check refuses the same caps before anything is simulated
    expect(pots.capsError({ potCapUsd6: usd(101), perPayerCapUsd6: usd(2) }, { maxPotCapUsd6: usd(100), maxPerPayerCapUsd6: usd(5) })).to.not.equal(null);
  });

  it("a guest sprays: exact approve for LokalPots, payPot with the currency choice, a Spray Wall row without the payer", async () => {
    const { pots: p, potsAddress, ada, guest, payout, usdt, cngn } = await loadFixture(fixture);
    const now = await time.latest();
    await send(ada, potsAddress, site.createPotData({ title: "Wedding", closesAt: now + DAY, potCapUsd6: usd(20), perPayerCapUsd6: usd(5) }));
    const U = await usdt.getAddress(), N = await cngn.getAddress();
    await usdt.mint(guest.address, usd(100));
    await cngn.mint(guest.address, 10n ** 6n * 100_000n);

    // USD₮ $2 for naira: the dry run says $2, approve exactly $2, then payPot
    expect(await p.validatePotPayment(1n, U, usd(2), guest.address)).to.equal(usd(2));
    await send(guest, U, site.approveData(potsAddress, usd(2)));
    expect(await usdt.allowance(guest.address, potsAddress)).to.equal(usd(2));
    const before = await usdt.balanceOf(payout.address);
    const rc1 = await (await send(guest, potsAddress, site.payPotData({ potId: 1n, token: U, amount: usd(2), ref: site.currencyRef("cngn"), expectedPayout: payout.address }))).wait();
    expect((await usdt.balanceOf(payout.address)) - before).to.equal(usd(2));
    expect(await usdt.allowance(guest.address, potsAddress)).to.equal(0n, "nothing left approved");
    const row = rc1.logs.map((l: any) => pots.sprayOf(l)).find(Boolean);
    expect([row.potId, row.amountUsd6, row.totalSoFar, row.receive]).to.deep.equal([1n, usd(2), usd(2), "cngn"]);
    expect(Object.keys(row)).to.not.include("payer");
    expect(JSON.stringify(row, (_k, v) => (typeof v === "bigint" ? String(v) : v)).toLowerCase()).to.not.include(guest.address.slice(2).toLowerCase());

    // cNGN: the largest amount the page offers for the guest's remaining $3 fits exactly, with the contract's rounding
    const [forPayer] = await p.remaining(1n, guest.address);
    expect(forPayer).to.equal(usd(3));
    const rate = await p.unitsPerUsd(N);
    const most = pots.maxUnitsForUsd6(forPayer, rate);
    expect(await p.usdValue(N, most)).to.equal(site.potUsdValue(most, rate));
    expect(await p.usdValue(N, most + 1n)).to.be.greaterThan(forPayer);
    await send(guest, N, site.approveData(potsAddress, most));
    const rc2 = await (await send(guest, potsAddress, site.payPotData({ potId: 1n, token: N, amount: most, ref: site.currencyRef("usdt"), expectedPayout: payout.address }))).wait();
    const row2 = rc2.logs.map((l: any) => pots.sprayOf(l)).find(Boolean);
    expect([row2.amount, row2.receive, row2.amountUsd6 <= usd(3)]).to.deep.equal([most, "usdt", true]);
    // what the agent pays the host: the guest's choice
    expect(site.payoutRoute(site.tokenOfCode("cngn"), null, "pot", row2.receive)).to.deep.equal({ mode: "swap", corridor: "cngn-usdt", receive: "usdt" });

    // over the per-guest cap now: refused before anything is sent, in the page's words
    await send(guest, U, site.approveData(potsAddress, usd(1)));
    const over = await refusal(guest, potsAddress, site.payPotData({ potId: 1n, token: U, amount: usd(1), expectedPayout: payout.address }), { potId: 1n, token: site.tokenOfCode("usdt") });
    expect(over.name).to.equal("OverPayerCap");
    expect(over.message).to.match(/more into this pot/);
    const self = await refusal(ada, potsAddress, site.payPotData({ potId: 1n, token: U, amount: usd(1), expectedPayout: payout.address }), { potId: 1n, token: U });
    expect(self.message).to.match(/You host this pot/);
  });

  it("closePot from the site: only the host, and then the pot refuses sprays in the page's words", async () => {
    const { potsAddress, ada, bob, guest, payout, usdt } = await loadFixture(fixture);
    const now = await time.latest();
    await send(ada, potsAddress, site.createPotData({ title: "Gift for Tola", closesAt: now + DAY, potCapUsd6: usd(10), perPayerCapUsd6: usd(2) }));
    const notHost = await refusal(bob, potsAddress, site.closePotData(1n), { potId: 1n });
    expect(notHost.name).to.equal("NotHost");
    await send(ada, potsAddress, site.closePotData(1n));
    const info = site.decodePotInfo(await ethers.provider.call({ to: potsAddress, data: site.FN.potInfo + ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [1n]).slice(2) }));
    expect(pots.potState(info, now + 10)).to.equal("closed");
    const U = await usdt.getAddress();
    await usdt.mint(guest.address, usd(5));
    await send(guest, U, site.approveData(potsAddress, usd(1)));
    const closed = await refusal(guest, potsAddress, site.payPotData({ potId: 1n, token: U, amount: usd(1), expectedPayout: payout.address }), { potId: 1n, token: U });
    expect(closed.name).to.equal("PotIsClosed");
    expect(closed.message).to.match(/host closed this pot/);
  });
});
