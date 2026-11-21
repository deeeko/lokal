/**
 * The site's and the `lokal` CLI's calldata builders (site/assets/lokal-contracts.js) against the real contracts:
 * every call they build, attribution suffix included, is accepted by LokalTags exactly as a wallet would send it
 * (a raw transaction with that data), the payer's currency choice comes back in TagPaid's ref, and a refusal decodes
 * to the plain-English sentence the site shows before anything is signed.
 */
import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { deployFixture, usd } from "./helpers/fixture";

// The site module is plain ESM (repo root "type": "module"); Node 22.12+ loads it with require().
// eslint-disable-next-line @typescript-eslint/no-var-requires
const site = require("../../site/assets/lokal-contracts.js");

// Mock tokens have their own addresses; amounts in messages are formatted by the mainnet token of the same kind.
const MAINNET_USDT = site.tokenOfCode("usdt");
const send = (signer: any, to: string, data: string) => signer.sendTransaction({ to, data, value: 0 });

describe("Site calldata on the real contracts", () => {
  async function fixture() {
    const f = await deployFixture();
    return { ...f, payer: f.signers[16] };
  }

  it("claim, setName, setReceiveToken and release built by the site, each with the attribution suffix", async () => {
    const { tags, router, ada, idrx } = await loadFixture(fixture);
    const suffix = "63656c6f5f373336303935336431623533110080218021802180218021802180218021"; // "celo_7360953d1b53" + len + schema 0 + marker
    const claim = site.claimData("ada", "Ada Obi");
    expect(claim.endsWith(suffix)).to.equal(true);
    await expect(send(ada, router, claim)).to.emit(tags, "TagClaimed");
    expect(await tags.tagOf(ada.address)).to.equal("ada");
    expect(await tags.nameOf(ada.address)).to.equal("Ada Obi");
    await send(ada, router, site.setNameData("Àdá Ọbí"));
    expect(await tags.nameOf(ada.address)).to.equal("Àdá Ọbí");
    await send(ada, router, site.setNameData(""));
    expect(await tags.nameOf(ada.address)).to.equal("");
    await expect(send(ada, router, site.setReceiveTokenData(await idrx.getAddress()))).to.emit(tags, "ReceiveTokenSet");
    expect(await tags.receiveTokenOf(ada.address)).to.equal(await idrx.getAddress());
    await send(ada, router, site.setReceiveTokenData(null));
    expect(await tags.receiveTokenOf(ada.address)).to.equal(ethers.ZeroAddress);
    await expect(send(ada, router, site.releaseData())).to.emit(tags, "TagReleased");
    expect(await tags.tagOf(ada.address)).to.equal("");
  });

  it("payTag (after an exact approve) and payTagWithPermit carry the payer's currency in the ref", async () => {
    const { tags, router, ada, payer, payout, usdt, cngn } = await loadFixture(fixture);
    await tags.connect(ada).claim("ada", "");
    const U = await usdt.getAddress();
    const N = await cngn.getAddress();
    await usdt.mint(payer.address, usd(100));
    await cngn.mint(payer.address, 10n ** 6n * 100_000n);

    // cNGN: approve exactly the amount, then payTag; "cur:usdt" = dollars
    const units = 14_410_000_000n;
    await send(payer, N, site.approveData(router, units));
    expect(await cngn.allowance(payer.address, router)).to.equal(units);
    const tx1 = await send(payer, router, site.payTagData({ tag: "ada", token: N, amount: units, ref: site.currencyRef("usdt"), expectedPayout: payout.address }));
    const ev1 = (await tx1.wait()).logs.map((l: any) => site.decodeTagPaid(l)).find(Boolean);
    expect(ev1.tag).to.equal("ada");
    expect(ev1.amount).to.equal(units);
    expect(site.currencyOfRef(ev1.ref)).to.equal("usdt");
    expect(await cngn.allowance(payer.address, router)).to.equal(0n, "nothing left approved");

    // USD₮: one permit signature (the site's typed data) and one payTagWithPermit; "cur:idrx" = rupiah
    const { chainId } = await ethers.provider.getNetwork();
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 10 * 365 * 86400);
    const nonce = await usdt.nonces(payer.address);
    const td = site.permitTypedData({ owner: payer.address, spender: router, value: usd(7), nonce, deadline, domain: { ...site.USDT_PERMIT_DOMAIN, chainId: Number(chainId), verifyingContract: U } });
    const sig = await payer.signTypedData(td.domain, { Permit: td.types.Permit }, { owner: payer.address, spender: router, value: usd(7), nonce, deadline });
    const { v, r, s } = site.splitSignature(sig);
    const before = await usdt.balanceOf(payout.address);
    const tx2 = await send(payer, router, site.payTagWithPermitData({ tag: "ada", token: U, amount: usd(7), ref: site.currencyRef("idrx"), expectedPayout: payout.address, deadline, v, r, s }));
    const ev2 = (await tx2.wait()).logs.map((l: any) => site.decodeTagPaid(l)).find(Boolean);
    expect(site.currencyOfRef(ev2.ref)).to.equal("idrx");
    expect(ev2.recipient.toLowerCase()).to.equal(ada.address.toLowerCase());
    expect((await usdt.balanceOf(payout.address)) - before).to.equal(usd(7));
    // what the agent then pays: the payer's choice wins over the (unset) default
    expect(site.payoutRoute(site.tokenOfCode("usdt"), null, "tag", site.currencyOfRef(ev2.ref))).to.deep.equal({ mode: "swap", corridor: "usdt-idrx", receive: "idrx" });
  });

  it("a refusal decodes to the site's plain-English message, before anything is sent", async () => {
    const { tags, router, ada, payer, payout, usdt } = await loadFixture(fixture);
    await tags.connect(ada).claim("ada", "");
    const U = await usdt.getAddress();
    const explain = async (from: any, data: string, ctx: object) => {
      try {
        await ethers.provider.call({ from: from.address, to: router, data });
        return null;
      } catch (e: any) {
        return site.explainRevert(site.revertDataOf(e) ?? e?.data, ctx);
      }
    };
    const over = await explain(payer, site.payTagData({ tag: "ada", token: U, amount: usd(26), expectedPayout: payout.address }), { tag: "ada", token: MAINNET_USDT });
    expect(over.name).to.equal("OverPaymentLimit");
    expect(over.message).to.match(/\$25\.00 limit for one payment/);
    const self = await explain(ada, site.payTagData({ tag: "ada", token: U, amount: usd(5), expectedPayout: payout.address }), { tag: "ada", token: MAINNET_USDT });
    expect(self.name).to.equal("SelfPayment");
    const none = await explain(payer, site.payTagData({ tag: "nobody", token: U, amount: usd(5), expectedPayout: payout.address }), { tag: "nobody", token: MAINNET_USDT });
    expect(none.message).to.match(/@nobody isn't claimed/);
    const pinned = await explain(payer, site.payTagData({ tag: "ada", token: U, amount: usd(5) }), { tag: "ada", token: MAINNET_USDT }); // pins the mainnet agent
    expect(pinned.name).to.equal("PayoutWalletChanged");
    const taken = await explain(payer, site.claimData("ada", ""), { tag: "ada" });
    expect(taken.message).to.match(/@ada is taken/);
    // the room the site shows is what the contract will accept
    await usdt.mint(payer.address, usd(100));
    await usdt.connect(payer).approve(router, usd(20));
    await tags.connect(payer).payTag("ada", U, usd(20), ethers.ZeroHash, ethers.ZeroAddress);
    const [forRecipient] = await tags.remainingToday(U, ada.address, payer.address);
    expect(forRecipient).to.equal(usd(5));
    const daily = await explain(payer, site.payTagData({ tag: "ada", token: U, amount: usd(6), expectedPayout: payout.address }), { tag: "ada", token: MAINNET_USDT });
    expect(daily.name).to.equal("OverRecipientDailyLimit");
    expect(daily.message).to.match(/can receive only \$5\.00 more in USD₮ today/);
  });
});
