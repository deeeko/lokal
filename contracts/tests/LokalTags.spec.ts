import { expect } from "chai";
import { ethers, network } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { RESERVED_TAGS, TOKENS, attributionSuffix } from "../config/celo";
import { DAY, LIMITS, LOCK, deployFixture, fillDay, limitsTuple, nextDayStart, usd } from "./helpers/fixture";

const A = { Free: 0n, Yours: 1n, Taken: 2n, Reserved: 3n, Locked: 4n, Invalid: 5n };
const id = (s: string) => ethers.keccak256(ethers.toUtf8Bytes(s));
const ref = (s: string) => ethers.id(s);
const latest = async () => (await ethers.provider.getBlock("latest"))!.timestamp;

describe("LokalTags", () => {
  // -----------------------------------------------------------------------------------------------------------------
  describe("deployment", () => {
    it("sets the admin, payout wallet, reserved list and every token's limits in one transaction", async () => {
      const { tags, admin, payout, bySymbol } = await loadFixture(deployFixture);
      expect(await tags.owner()).to.equal(admin.address);
      expect(await tags.payoutWallet()).to.equal(payout.address);
      expect(await tags.paused()).to.equal(false);
      for (const t of RESERVED_TAGS) expect(await tags.isReserved(t), t).to.equal(true);
      for (const [sym, token] of Object.entries(bySymbol)) {
        expect(await tags.tokenLimits(await token.getAddress()), sym).to.deep.equal([...limitsTuple(LIMITS[sym])]);
      }
      expect(await tags.RELEASE_LOCK()).to.equal(BigInt(LOCK));
    });

    it("emits an event for every setting it seeds", async () => {
      const { payout, usdt } = await loadFixture(deployFixture);
      const f = await ethers.getContractFactory("LokalTags");
      const c = await f.deploy(payout.address, ["admin", "root"], [{ token: await usdt.getAddress(), limits: LIMITS.USDT }]);
      const tx = c.deploymentTransaction()!;
      await expect(tx).to.emit(c, "PayoutWalletSet").withArgs(ethers.ZeroAddress, payout.address);
      await expect(tx).to.emit(c, "ReservedSet").withArgs(id("admin"), "admin", true);
      await expect(tx).to.emit(c, "ReservedSet").withArgs(id("root"), "root", true);
      await expect(tx).to.emit(c, "TokenLimitsSet").withArgs(await usdt.getAddress(), ...limitsTuple(LIMITS.USDT));
    });

    it("refuses a bad payout wallet, too many reserved tags, bad limits or a token without code", async () => {
      const { tags, payout, usdt, stranger } = await loadFixture(deployFixture);
      const f = await ethers.getContractFactory("LokalTags");
      const u = await usdt.getAddress();
      await expect(f.deploy(ethers.ZeroAddress, [], [])).to.be.revertedWithCustomError(tags, "InvalidPayoutWallet");
      const many = Array.from({ length: 129 }, (_, i) => `tag${i}`);
      await expect(f.deploy(payout.address, many, [])).to.be.revertedWithCustomError(tags, "BatchTooLarge").withArgs(129);
      const bad = { ...LIMITS.USDT, minPerPayment: LIMITS.USDT.maxPerPayment + 1n };
      await expect(f.deploy(payout.address, [], [{ token: u, limits: bad }])).to.be.revertedWithCustomError(tags, "InvalidLimits");
      await expect(f.deploy(payout.address, [], [{ token: stranger.address, limits: LIMITS.USDT }]))
        .to.be.revertedWithCustomError(tags, "InvalidToken").withArgs(stranger.address);
    });

    it("deploys with the ERC-8021 attribution suffix appended to the creation data", async () => {
      const { admin, payout, usdt } = await loadFixture(deployFixture);
      const f = await ethers.getContractFactory("LokalTags");
      const reservedList = [...RESERVED_TAGS];
      const setup = [{ token: await usdt.getAddress(), limits: LIMITS.USDT }];
      const plain = await f.getDeployTransaction(payout.address, reservedList, setup);
      const data = plain.data + attributionSuffix();
      const tx = await admin.sendTransaction({ data });
      const rc = (await tx.wait())!;
      expect((await ethers.provider.getTransaction(tx.hash))!.data.endsWith(attributionSuffix())).to.equal(true);
      // The trailing bytes are ignored by the constructor's ABI decoder: every setting is intact.
      const deployed = await ethers.getContractAt("LokalTags", rc.contractAddress!);
      expect(await deployed.payoutWallet()).to.equal(payout.address);
      expect(await deployed.isReserved("receive")).to.equal(true);
      expect(await deployed.tokenLimits(await usdt.getAddress())).to.deep.equal([...limitsTuple(LIMITS.USDT)]);
    });

    it("has no payable entry point: sending CELO to it reverts", async () => {
      const { tags, carol, router } = await loadFixture(deployFixture);
      await expect(carol.sendTransaction({ to: router, value: 1n })).to.be.reverted;
      expect(await ethers.provider.getBalance(await tags.getAddress())).to.equal(0n);
    });
  });

  // -----------------------------------------------------------------------------------------------------------------
  describe("tag rules", () => {
    it("accepts every shape the site accepts", async () => {
      const { tags, signers } = await loadFixture(deployFixture);
      const ok = ["ada", "ada_obi", "a1b", "z99", "a_b_c", "abcdefghijklmnopqrst", "x0_0"];
      for (let i = 0; i < ok.length; i++) {
        expect(await tags.isValidTag(ok[i]), ok[i]).to.equal(true);
        const s = signers[10 + i];
        await expect(tags.connect(s).claim(ok[i], "")).to.emit(tags, "TagClaimed").withArgs(id(ok[i]), ok[i], s.address, "");
      }
    });

    it("refuses every shape the site refuses (InvalidTag)", async () => {
      const { tags, ada } = await loadFixture(deployFixture);
      const bad = ["", "ab", "abcdefghijklmnopqrstu", "Ada", "aDa", "1ada", "_ada", "ada_", "a__b", "ad-a", "ad a", "adé", "@ada", " ada", "ada\n", "ada.ng"];
      for (const t of bad) {
        expect(await tags.isValidTag(t), JSON.stringify(t)).to.equal(false);
        expect(await tags.availability(t, ada.address), JSON.stringify(t)).to.equal(A.Invalid);
        await expect(tags.connect(ada).claim(t, ""), JSON.stringify(t)).to.be.revertedWithCustomError(tags, "InvalidTag");
      }
    });

    it("refuses reserved tags (TagReserved), and a too-short reserved word is simply invalid, as on the site", async () => {
      const { tags, ada } = await loadFixture(deployFixture);
      for (const t of ["admin", "celo", "naira", "support", "receive"]) {
        expect(await tags.availability(t, ada.address)).to.equal(A.Reserved);
        await expect(tags.connect(ada).claim(t, "")).to.be.revertedWithCustomError(tags, "TagReserved");
      }
      expect(await tags.availability("me", ada.address)).to.equal(A.Invalid);
    });
  });

  // -----------------------------------------------------------------------------------------------------------------
  describe("display names", () => {
    it("accepts empty, plain, accented and emoji names up to 40 characters as JavaScript counts them", async () => {
      const { tags } = await loadFixture(deployFixture);
      const ok = ["", "Ada Obi", "A", "x".repeat(40), "Adébáyọ̀ Ọlá", "Ṣadé 🇳🇬", "😀".repeat(20), "é".repeat(40), "李小龍", "Ada  Obi"];
      for (const n of ok) expect(await tags.isValidName(n), n).to.equal(true);
    });

    it("refuses too long, control characters, and whitespace at either end (InvalidName)", async () => {
      const { tags, ada } = await loadFixture(deployFixture);
      const bad = ["x".repeat(41), "😀".repeat(21), "é".repeat(41), "Ada\nObi", "Ada\tObi", "Ada\u0000", "Ada\u007f", "Ada\u0085", "Ada\u009f", " Ada", "Ada ", " ", "\u00a0Ada", "Ada\u3000", "\ufeffAda", "Ada\u2028"];
      for (const n of bad) {
        expect(await tags.isValidName(n), JSON.stringify(n)).to.equal(false);
        await expect(tags.connect(ada).claim("ada", n)).to.be.revertedWithCustomError(tags, "InvalidName");
      }
    });

    it("refuses malformed UTF-8 sent as raw bytes", async () => {
      const { tags, ada, router } = await loadFixture(deployFixture);
      const coder = ethers.AbiCoder.defaultAbiCoder();
      const claimSel = tags.interface.getFunction("claim")!.selector;
      const nameSel = tags.interface.getFunction("isValidName")!.selector;
      const cases = ["0x80", "0x41c0af", "0xc380c3", "0xe08080", "0xeda080", "0xf4908080", "0xf5808080", "0xe282", "0xf09f98", "0xc2", "0xff"];
      for (const b of cases) {
        // ABI-encoded `string` and `bytes` are identical, so this is how a wallet could send arbitrary bytes as a name.
        const isValid = await ethers.provider.call({ to: router, data: nameSel + coder.encode(["bytes"], [b]).slice(2) });
        expect(coder.decode(["bool"], isValid)[0], b).to.equal(false);
        const data = claimSel + coder.encode(["string", "bytes"], ["ada", b]).slice(2);
        await expect(ada.sendTransaction({ to: router, data }), b).to.be.revertedWithCustomError(tags, "InvalidName");
      }
      // And a well-formed 4-byte sequence counts as two characters, like JavaScript.
      const ok = await ethers.provider.call({ to: router, data: nameSel + coder.encode(["bytes"], ["0xf09f9880"]).slice(2) });
      expect(coder.decode(["bool"], ok)[0]).to.equal(true);
    });

    it("setName changes or clears the name and emits NameChanged", async () => {
      const { tags, ada, bob } = await loadFixture(deployFixture);
      await tags.connect(ada).claim("ada", "Ada");
      await expect(tags.connect(ada).setName("Ada Obi")).to.emit(tags, "NameChanged").withArgs(id("ada"), "ada", ada.address, "Ada Obi");
      expect(await tags.nameOf(ada.address)).to.equal("Ada Obi");
      await expect(tags.connect(ada).setName("")).to.emit(tags, "NameChanged").withArgs(id("ada"), "ada", ada.address, "");
      expect(await tags.nameOf(ada.address)).to.equal("");
      await expect(tags.connect(ada).setName(" bad")).to.be.revertedWithCustomError(tags, "InvalidName");
      await expect(tags.connect(bob).setName("Bob")).to.be.revertedWithCustomError(tags, "NoTag");
    });
  });

  // -----------------------------------------------------------------------------------------------------------------
  describe("claiming, one tag per wallet, release and the 30-day lock", () => {
    it("claim records owner, name and time; views agree", async () => {
      const { tags, ada, bob } = await loadFixture(deployFixture);
      await expect(tags.connect(ada).claim("ada", "Ada Obi")).to.emit(tags, "TagClaimed").withArgs(id("ada"), "ada", ada.address, "Ada Obi");
      const ts = await latest();
      expect(await tags.ownerOf("ada")).to.equal(ada.address);
      expect(await tags.tagOf(ada.address)).to.equal("ada");
      expect(await tags.nameOf(ada.address)).to.equal("Ada Obi");
      expect(await tags.tagInfo("ada")).to.deep.equal([ada.address, "Ada Obi", BigInt(ts), ethers.ZeroAddress, 0n, ethers.ZeroAddress]);
      expect(await tags.availability("ada", ada.address)).to.equal(A.Yours);
      expect(await tags.availability("ada", bob.address)).to.equal(A.Taken);
      expect(await tags.availability("bob", bob.address)).to.equal(A.Free);
      expect(await tags.tagOf(bob.address)).to.equal("");
      expect(await tags.ownerOf("bob")).to.equal(ethers.ZeroAddress);
      expect(await tags.tagInfo("bob")).to.deep.equal([ethers.ZeroAddress, "", 0n, ethers.ZeroAddress, 0n, ethers.ZeroAddress]);
    });

    it("first claim wins: TagTaken for anyone else, AlreadyYours for the owner", async () => {
      const { tags, ada, bob } = await loadFixture(deployFixture);
      await tags.connect(ada).claim("ada", "");
      await expect(tags.connect(bob).claim("ada", "Bob")).to.be.revertedWithCustomError(tags, "TagTaken").withArgs(ada.address);
      await expect(tags.connect(ada).claim("ada", "Ada")).to.be.revertedWithCustomError(tags, "AlreadyYours");
    });

    it("claiming a second tag releases the first and locks it for 30 days for everyone else", async () => {
      const { tags, ada, bob } = await loadFixture(deployFixture);
      await tags.connect(ada).claim("ada", "Ada");
      const tx = tags.connect(ada).claim("ada_obi", "Ada Obi");
      await expect(tx).to.emit(tags, "TagReleased").withArgs(id("ada"), "ada", ada.address, anyValue);
      await expect(tx).to.emit(tags, "TagClaimed").withArgs(id("ada_obi"), "ada_obi", ada.address, "Ada Obi");
      const until = BigInt((await latest()) + LOCK);
      expect(await tags.ownerOf("ada")).to.equal(ethers.ZeroAddress);
      expect(await tags.tagOf(ada.address)).to.equal("ada_obi");
      expect(await tags.nameOf(ada.address)).to.equal("Ada Obi");
      expect(await tags.tagInfo("ada")).to.deep.equal([ethers.ZeroAddress, "", 0n, ada.address, until, ethers.ZeroAddress]);
      expect(await tags.availability("ada", bob.address)).to.equal(A.Locked);
      expect(await tags.availability("ada", ada.address)).to.equal(A.Free);
      await expect(tags.connect(bob).claim("ada", "")).to.be.revertedWithCustomError(tags, "TagLocked").withArgs(until);
    });

    it("the previous owner can take a locked tag back inside the lock", async () => {
      const { tags, ada } = await loadFixture(deployFixture);
      await tags.connect(ada).claim("ada", "");
      await tags.connect(ada).claim("ada_obi", "");
      await time.increase(DAY);
      await expect(tags.connect(ada).claim("ada", "Back")).to.emit(tags, "TagClaimed").withArgs(id("ada"), "ada", ada.address, "Back");
      expect(await tags.tagOf(ada.address)).to.equal("ada");
      // ...which in turn released and locked ada_obi.
      expect(await tags.ownerOf("ada_obi")).to.equal(ethers.ZeroAddress);
    });

    it("the lock ends exactly 30 days after the release (time travel)", async () => {
      const { tags, ada, bob, carol } = await loadFixture(deployFixture);
      await tags.connect(ada).claim("ada", "");
      await tags.connect(ada).release();
      const until = (await latest()) + LOCK;
      await time.setNextBlockTimestamp(until - 1);
      await expect(tags.connect(bob).claim("ada", "")).to.be.revertedWithCustomError(tags, "TagLocked").withArgs(until);
      await time.setNextBlockTimestamp(until);
      await expect(tags.connect(bob).claim("ada", "Bob")).to.emit(tags, "TagClaimed").withArgs(id("ada"), "ada", bob.address, "Bob");
      // The new holder's claim wiped the old lock: ada is now simply taken, also for its first owner.
      await expect(tags.connect(ada).claim("ada", "")).to.be.revertedWithCustomError(tags, "TagTaken").withArgs(bob.address);
      expect(await tags.availability("ada", carol.address)).to.equal(A.Taken);
    });

    it("after the lock, tagInfo shows nothing and anyone sees Free", async () => {
      const { tags, ada, bob } = await loadFixture(deployFixture);
      await tags.connect(ada).claim("ada", "");
      await tags.connect(ada).release();
      await time.increase(LOCK);
      expect(await tags.availability("ada", bob.address)).to.equal(A.Free);
      expect(await tags.tagInfo("ada")).to.deep.equal([ethers.ZeroAddress, "", 0n, ethers.ZeroAddress, 0n, ethers.ZeroAddress]);
    });

    it("release clears the tag, name and receive token; NoTag when there is nothing to release", async () => {
      const { tags, ada, cngn } = await loadFixture(deployFixture);
      await expect(tags.connect(ada).release()).to.be.revertedWithCustomError(tags, "NoTag");
      await tags.connect(ada).claim("ada", "Ada");
      await tags.connect(ada).setReceiveToken(await cngn.getAddress());
      await expect(tags.connect(ada).release()).to.emit(tags, "TagReleased").withArgs(id("ada"), "ada", ada.address, anyValue);
      expect(await tags.tagOf(ada.address)).to.equal("");
      expect(await tags.nameOf(ada.address)).to.equal("");
      expect(await tags.receiveTokenOf(ada.address)).to.equal(ethers.ZeroAddress);
      await expect(tags.connect(ada).release()).to.be.revertedWithCustomError(tags, "NoTag");
    });

    it("a smart contract can't claim (RecipientIsContract); one that claimed from its constructor can't be paid", async () => {
      const { tags, router, carol, usdt } = await loadFixture(deployFixture);
      const C = await ethers.getContractFactory("TagClaimer");
      const later = await C.deploy(router, "");
      await expect(later.claim(router, "robot")).to.be.revertedWithCustomError(tags, "RecipientIsContract").withArgs(await later.getAddress());
      const sneaky = await C.deploy(router, "sneaky");
      expect(await tags.ownerOf("sneaky")).to.equal(await sneaky.getAddress());
      await expect(tags.connect(carol).payTag("sneaky", await usdt.getAddress(), usd(5), ref("x"), ethers.ZeroAddress))
        .to.be.revertedWithCustomError(tags, "RecipientIsContract").withArgs(await sneaky.getAddress());
    });

    it("an EIP-7702 delegated wallet is still a wallet; other code is a contract", async () => {
      const { tags, ada, carol, usdt } = await loadFixture(deployFixture);
      await tags.connect(ada).claim("ada", "");
      const u = await usdt.getAddress();
      const delegation = "0xef0100" + "11".repeat(20);
      await network.provider.send("hardhat_setCode", [ada.address, delegation]);
      await expect(tags.connect(carol).payTag("ada", u, usd(5), ref("7702"), ethers.ZeroAddress)).to.emit(tags, "TagPaid");
      await network.provider.send("hardhat_setCode", [ada.address, "0xef0200" + "11".repeat(20)]);
      await expect(tags.connect(carol).payTag("ada", u, usd(5), ref("x"), ethers.ZeroAddress)).to.be.revertedWithCustomError(tags, "RecipientIsContract");
      await network.provider.send("hardhat_setCode", [ada.address, "0x6000"]);
      await expect(tags.connect(carol).payTag("ada", u, usd(5), ref("x"), ethers.ZeroAddress)).to.be.revertedWithCustomError(tags, "RecipientIsContract");
      await network.provider.send("hardhat_setCode", [ada.address, "0x"]);
    });

    it("a real EIP-7702 wallet (type-4 transaction, Prague) can claim a tag and be paid", async () => {
      const { tags, carol, usdt, clock, signers } = await loadFixture(deployFixture);
      const w = ethers.Wallet.createRandom().connect(ethers.provider);
      await signers[0].sendTransaction({ to: w.address, value: ethers.parseEther("1") });
      // Self-sponsored delegation: the authorization nonce is the account's nonce after this transaction's own bump.
      const auth = await w.authorize({ address: await clock.getAddress(), nonce: (await w.getNonce()) + 1 });
      await (await w.sendTransaction({ type: 4, to: signers[1].address, authorizationList: [auth] })).wait();
      const code = await ethers.provider.getCode(w.address);
      expect(code.toLowerCase()).to.equal("0xef0100" + (await clock.getAddress()).slice(2).toLowerCase());
      await expect(tags.connect(w).claim("delegated", "")).to.emit(tags, "TagClaimed");
      await expect(tags.connect(carol).payTag("delegated", await usdt.getAddress(), usd(5), ref("7702"), ethers.ZeroAddress))
        .to.emit(tags, "TagPaid");
    });

    it("the payout wallet can't hold a tag or be paid through one", async () => {
      const { tags, admin, payout, ada, carol, usdt } = await loadFixture(deployFixture);
      await expect(tags.connect(payout).claim("agent_x", "")).to.be.revertedWithCustomError(tags, "RecipientIsPayoutWallet");
      await tags.connect(ada).claim("ada", "");
      await tags.connect(admin).proposePayoutWallet(ada.address);
      await time.increase(DAY);
      await tags.connect(admin).executePayoutWallet();
      await expect(tags.connect(carol).payTag("ada", await usdt.getAddress(), usd(5), ref("x"), ethers.ZeroAddress))
        .to.be.revertedWithCustomError(tags, "RecipientIsPayoutWallet");
    });
  });

  // -----------------------------------------------------------------------------------------------------------------
  describe("preferred receive token", () => {
    it("an owner can pick an allowed token, change it and clear it", async () => {
      const { tags, ada, cngn, idrx } = await loadFixture(deployFixture);
      await tags.connect(ada).claim("ada", "");
      const c = await cngn.getAddress();
      await expect(tags.connect(ada).setReceiveToken(c)).to.emit(tags, "ReceiveTokenSet").withArgs(id("ada"), "ada", ada.address, c);
      expect(await tags.receiveTokenOf(ada.address)).to.equal(c);
      expect((await tags.tagInfo("ada"))[5]).to.equal(c);
      const i = await idrx.getAddress();
      await tags.connect(ada).setReceiveToken(i);
      expect(await tags.receiveTokenOf(ada.address)).to.equal(i);
      await expect(tags.connect(ada).setReceiveToken(ethers.ZeroAddress)).to.emit(tags, "ReceiveTokenSet").withArgs(id("ada"), "ada", ada.address, ethers.ZeroAddress);
      expect(await tags.receiveTokenOf(ada.address)).to.equal(ethers.ZeroAddress);
    });

    it("refuses a token that is not allowed, and needs a tag", async () => {
      const { tags, ada, bob, other, cngn } = await loadFixture(deployFixture);
      await expect(tags.connect(bob).setReceiveToken(await cngn.getAddress())).to.be.revertedWithCustomError(tags, "NoTag");
      await tags.connect(ada).claim("ada", "");
      await expect(tags.connect(ada).setReceiveToken(await other.getAddress()))
        .to.be.revertedWithCustomError(tags, "TokenNotAllowed").withArgs(await other.getAddress());
    });

    it("reads as none once the admin disallows that token", async () => {
      const { tags, admin, ada, wcop } = await loadFixture(deployFixture);
      await tags.connect(ada).claim("ada", "");
      const w = await wcop.getAddress();
      await tags.connect(ada).setReceiveToken(w);
      await tags.connect(admin).setTokenLimits(w, 0, 0, 0, 0, 0);
      expect(await tags.receiveTokenOf(ada.address)).to.equal(ethers.ZeroAddress);
    });
  });

  // -----------------------------------------------------------------------------------------------------------------
  describe("payTag: money moves only inside the limits", () => {
    async function withTags() {
      const f = await deployFixture();
      const { tags, ada, bob, erin, frank, gina } = f;
      await tags.connect(ada).claim("ada", "Ada");
      await tags.connect(bob).claim("bob", "");
      await tags.connect(erin).claim("erin", "");
      await tags.connect(frank).claim("frank", "");
      await tags.connect(gina).claim("gina", "");
      return f;
    }

    it("forwards the exact amount to the payout wallet in one step; the router keeps nothing", async () => {
      const { tags, router, usdt, carol, ada, payout } = await loadFixture(withTags);
      const u = await usdt.getAddress();
      const before = { payer: await usdt.balanceOf(carol.address), payout: await usdt.balanceOf(payout.address) };
      const tx = tags.connect(carol).payTag("ada", u, usd(10), ref("inv-1"), ethers.ZeroAddress);
      await expect(tx).to.changeTokenBalances(usdt, [carol, payout, router], [-usd(10), usd(10), 0n]);
      const day = BigInt(Math.floor((await latest()) / DAY));
      await expect(tx).to.emit(tags, "TagPaid").withArgs(id("ada"), "ada", ada.address, carol.address, u, usd(10), ref("inv-1"), day);
      expect(await usdt.balanceOf(router)).to.equal(0n);
      expect(await usdt.balanceOf(carol.address)).to.equal(before.payer - usd(10));
      expect(await usdt.balanceOf(payout.address)).to.equal(before.payout + usd(10));
      expect(await tags.usedOn(u, ada.address, day)).to.deep.equal([usd(10), 0n, usd(10)]);
      expect(await tags.usedOn(u, carol.address, day)).to.deep.equal([0n, usd(10), usd(10)]);
      expect(await tags.remainingToday(u, ada.address, carol.address)).to.deep.equal([usd(15), usd(15), usd(240)]);
    });

    it("TagNotFound for a tag nobody holds, including a released one", async () => {
      const { tags, usdt, carol, ada } = await loadFixture(withTags);
      const u = await usdt.getAddress();
      await expect(tags.connect(carol).payTag("nobody", u, usd(5), ref("x"), ethers.ZeroAddress)).to.be.revertedWithCustomError(tags, "TagNotFound");
      await tags.connect(ada).release();
      await expect(tags.connect(carol).payTag("ada", u, usd(5), ref("x"), ethers.ZeroAddress)).to.be.revertedWithCustomError(tags, "TagNotFound");
    });

    it("TokenNotAllowed for an unlisted token or one the admin switched off", async () => {
      const { tags, other, cngn, carol, admin } = await loadFixture(withTags);
      const o = await other.getAddress();
      await expect(tags.connect(carol).payTag("ada", o, usd(5), ref("x"), ethers.ZeroAddress)).to.be.revertedWithCustomError(tags, "TokenNotAllowed").withArgs(o);
      const c = await cngn.getAddress();
      await expect(tags.connect(admin).setTokenLimits(c, 0, 0, 0, 0, 0)).to.emit(tags, "TokenLimitsSet").withArgs(c, 0, 0, 0, 0, 0);
      await expect(tags.connect(carol).payTag("ada", c, LIMITS.cNGN.minPerPayment, ref("x"), ethers.ZeroAddress)).to.be.revertedWithCustomError(tags, "TokenNotAllowed");
    });

    it("SelfPayment when the payer holds the tag", async () => {
      const { tags, usdt, ada } = await loadFixture(withTags);
      await expect(tags.connect(ada).payTag("ada", await usdt.getAddress(), usd(5), ref("x"), ethers.ZeroAddress)).to.be.revertedWithCustomError(tags, "SelfPayment");
    });

    it("BelowMinimum and OverPaymentLimit, with both edges allowed", async () => {
      const { tags, usdt, carol, dave } = await loadFixture(withTags);
      const u = await usdt.getAddress();
      await expect(tags.connect(carol).payTag("ada", u, 0, ref("x"), ethers.ZeroAddress)).to.be.revertedWithCustomError(tags, "BelowMinimum").withArgs(0, usd(1));
      await expect(tags.connect(carol).payTag("ada", u, usd(1) - 1n, ref("x"), ethers.ZeroAddress)).to.be.revertedWithCustomError(tags, "BelowMinimum");
      await expect(tags.connect(carol).payTag("ada", u, usd(25) + 1n, ref("x"), ethers.ZeroAddress)).to.be.revertedWithCustomError(tags, "OverPaymentLimit").withArgs(usd(25) + 1n, usd(25));
      await expect(tags.connect(carol).payTag("ada", u, usd(1), ref("x"), ethers.ZeroAddress)).to.emit(tags, "TagPaid");
      await expect(tags.connect(dave).payTag("bob", u, usd(25), ref("x"), ethers.ZeroAddress)).to.emit(tags, "TagPaid");
    });

    it("OverRecipientDailyLimit counts every payer and follows the wallet, not the tag", async () => {
      const { tags, usdt, carol, dave, ada } = await loadFixture(withTags);
      const u = await usdt.getAddress();
      await tags.connect(carol).payTag("ada", u, usd(10), ref("a"), ethers.ZeroAddress);
      await expect(tags.connect(dave).payTag("ada", u, usd(16), ref("b"), ethers.ZeroAddress)).to.be.revertedWithCustomError(tags, "OverRecipientDailyLimit").withArgs(usd(16), usd(15));
      await tags.connect(dave).payTag("ada", u, usd(15), ref("c"), ethers.ZeroAddress);
      await expect(tags.connect(carol).payTag("ada", u, usd(1), ref("d"), ethers.ZeroAddress)).to.be.revertedWithCustomError(tags, "OverRecipientDailyLimit").withArgs(usd(1), 0);
      // Switching tags does not reset the wallet's daily total.
      await tags.connect(ada).claim("ada_new", "");
      await expect(tags.connect(carol).payTag("ada_new", u, usd(1), ref("e"), ethers.ZeroAddress)).to.be.revertedWithCustomError(tags, "OverRecipientDailyLimit");
    });

    it("OverPayerDailyLimit: one payer can't spread more than the per-payer cap over many tags", async () => {
      const { tags, usdt, carol } = await loadFixture(withTags);
      const u = await usdt.getAddress();
      await tags.connect(carol).payTag("ada", u, usd(10), ref("a"), ethers.ZeroAddress);
      await tags.connect(carol).payTag("bob", u, usd(10), ref("b"), ethers.ZeroAddress);
      await expect(tags.connect(carol).payTag("erin", u, usd(6), ref("c"), ethers.ZeroAddress))
        .to.be.revertedWithCustomError(tags, "OverPayerDailyLimit").withArgs(usd(6), usd(5));
      await tags.connect(carol).payTag("erin", u, usd(5), ref("d"), ethers.ZeroAddress);
      expect((await tags.remainingToday(u, await tags.ownerOf("frank"), carol.address))[1]).to.equal(0n);
      await time.increaseTo(nextDayStart(await latest()) + 10);
      await expect(tags.connect(carol).payTag("frank", u, usd(25), ref("e"), ethers.ZeroAddress)).to.emit(tags, "TagPaid");
    });

    it("limits are per token: a full USD₮ day leaves cNGN, IDRX, wARS and wCOP untouched", async () => {
      const { tags, bySymbol, carol } = await loadFixture(withTags);
      await tags.connect(carol).payTag("ada", await bySymbol.USDT.getAddress(), usd(25), ref("a"), ethers.ZeroAddress);
      for (const sym of ["cNGN", "IDRX", "wARS", "wCOP"] as const) {
        const t = bySymbol[sym];
        await expect(tags.connect(carol).payTag("ada", await t.getAddress(), LIMITS[sym].maxPerPayment, ref(sym), ethers.ZeroAddress), sym).to.emit(tags, "TagPaid");
      }
    });

    it("OverDailyLimit once all payments in a token reach the daily cap ($250, which takes 10 payers)", async () => {
      const f = await loadFixture(withTags);
      const { tags, usdt, carol, gina } = f;
      const u = await usdt.getAddress();
      await fillDay(f, usdt, usd(25));
      expect(await tags.remainingToday(u, gina.address, carol.address)).to.deep.equal([usd(25), usd(25), 0n]);
      await expect(tags.connect(carol).payTag("gina", u, usd(1), ref("g"), ethers.ZeroAddress)).to.be.revertedWithCustomError(tags, "OverDailyLimit").withArgs(usd(1), 0);
    });

    it("day buckets roll over at 00:00 UTC: 23:59:59 and 00:00:00 are different days", async () => {
      const { tags, usdt, carol } = await loadFixture(withTags);
      const u = await usdt.getAddress();
      const midnight = nextDayStart(await latest());
      await time.setNextBlockTimestamp(midnight - 1);
      await expect(tags.connect(carol).payTag("ada", u, usd(25), ref("late"), ethers.ZeroAddress)).to.emit(tags, "TagPaid").withArgs(anyValue, "ada", anyValue, anyValue, u, usd(25), anyValue, BigInt(midnight / DAY - 1));
      await time.setNextBlockTimestamp(midnight);
      await expect(tags.connect(carol).payTag("ada", u, usd(25), ref("early"), ethers.ZeroAddress)).to.emit(tags, "TagPaid").withArgs(anyValue, "ada", anyValue, anyValue, u, usd(25), anyValue, BigInt(midnight / DAY));
      const ada = await tags.ownerOf("ada");
      expect(await tags.usedOn(u, ada, midnight / DAY - 1)).to.deep.equal([0n, 0n, 0n]); // the slot now holds the new day
      expect(await tags.usedOn(u, ada, midnight / DAY)).to.deep.equal([usd(25), 0n, usd(25)]);
    });

    it("a full day is refused, and the next UTC day is open again", async () => {
      const f = await loadFixture(withTags);
      const { tags, usdt, carol, ada } = f;
      const u = await usdt.getAddress();
      await fillDay(f, usdt, usd(25));
      await expect(tags.connect(carol).payTag("gina", u, usd(1), ref("g"), ethers.ZeroAddress)).to.be.revertedWithCustomError(tags, "OverDailyLimit");
      await time.increaseTo(nextDayStart(await latest()));
      expect(await tags.remainingToday(u, ada.address, carol.address)).to.deep.equal([usd(25), usd(25), usd(250)]);
      await fillDay(f, usdt, usd(25));
    });

    it("sybil: 4 fake tags and 1 payer can no longer use up the day; it takes 10 distinct payers", async () => {
      const f = await loadFixture(withTags);
      const { tags, usdt, signers, stranger, carol } = f;
      const u = await usdt.getAddress();
      const sy = signers.slice(10, 14);
      for (let i = 0; i < 4; i++) await tags.connect(sy[i]).claim(`sybil${i}`, "");
      await tags.connect(stranger).payTag("sybil0", u, usd(25), ref("g0"), ethers.ZeroAddress);
      for (let i = 1; i < 4; i++) {
        await expect(tags.connect(stranger).payTag(`sybil${i}`, u, usd(25), ref("g"), ethers.ZeroAddress))
          .to.be.revertedWithCustomError(tags, "OverPayerDailyLimit");
      }
      await expect(tags.connect(carol).payTag("ada", u, usd(1), ref("honest"), ethers.ZeroAddress)).to.emit(tags, "TagPaid");
      // Nine payers at $25 each still leave room; only the tenth fills the day.
      expect((await tags.remainingToday(u, f.ada.address, f.dave.address))[2]).to.equal(usd(224));
    });

    it("works the same for 2-decimal (IDRX) and 18-decimal (wCOP) tokens", async () => {
      const { tags, idrx, wcop, carol, dave, payout, router } = await loadFixture(withTags);
      for (const [sym, token] of [["IDRX", idrx], ["wCOP", wcop]] as const) {
        const t = await token.getAddress();
        const L = LIMITS[sym];
        await expect(tags.connect(carol).payTag("ada", t, L.minPerPayment - 1n, ref("x"), ethers.ZeroAddress)).to.be.revertedWithCustomError(tags, "BelowMinimum");
        await expect(tags.connect(carol).payTag("ada", t, L.maxPerPayment + 1n, ref("x"), ethers.ZeroAddress)).to.be.revertedWithCustomError(tags, "OverPaymentLimit");
        await expect(tags.connect(carol).payTag("ada", t, L.maxPerPayment, ref(sym), ethers.ZeroAddress)).to.changeTokenBalances(token, [carol, payout, router], [-L.maxPerPayment, L.maxPerPayment, 0n]);
        await expect(tags.connect(dave).payTag("ada", t, L.minPerPayment, ref("y"), ethers.ZeroAddress)).to.be.revertedWithCustomError(tags, "OverRecipientDailyLimit");
        await expect(tags.connect(carol).payTag("bob", t, L.minPerPayment, ref("z"), ethers.ZeroAddress)).to.be.revertedWithCustomError(tags, "OverPayerDailyLimit");
        expect(await token.balanceOf(router)).to.equal(0n);
      }
    });

    it("the overall day fills after exactly 10 maximum payments in 2- and 18-decimal tokens too", async () => {
      const f = await loadFixture(withTags);
      for (const sym of ["IDRX", "wCOP"] as const) {
        const token = f.bySymbol[sym];
        await fillDay(f, token, LIMITS[sym].maxPerPayment);
        await expect(f.tags.connect(f.carol).payTag("ada", await token.getAddress(), LIMITS[sym].minPerPayment, ref(sym), ethers.ZeroAddress))
          .to.be.revertedWithCustomError(f.tags, "OverDailyLimit").withArgs(LIMITS[sym].minPerPayment, 0);
        expect(await token.balanceOf(f.router)).to.equal(0n);
      }
    });

    it("a payer without allowance or balance moves nothing and counts nothing", async () => {
      const { tags, usdt, signers, ada } = await loadFixture(withTags);
      const poor = signers[15];
      const u = await usdt.getAddress();
      await expect(tags.connect(poor).payTag("ada", u, usd(5), ref("x"), ethers.ZeroAddress)).to.be.revertedWithCustomError(usdt, "ERC20InsufficientAllowance");
      expect(await tags.remainingToday(u, ada.address, poor.address)).to.deep.equal([usd(25), usd(25), usd(250)]);
    });

    it("TransferAmountMismatch: a token that delivers less than the amount is refused", async () => {
      const { tags, admin, carol, router } = await loadFixture(withTags);
      const fee = await (await ethers.getContractFactory("MockFeeERC20")).deploy();
      const f = await fee.getAddress();
      await tags.connect(admin).setTokenLimits(f, ...limitsTuple(LIMITS.USDT));
      await fee.mint(carol.address, usd(100));
      await fee.connect(carol).approve(router, ethers.MaxUint256);
      await expect(tags.connect(carol).payTag("ada", f, usd(10), ref("x"), ethers.ZeroAddress)).to.be.revertedWithCustomError(tags, "TransferAmountMismatch").withArgs(usd(10), usd(9.9));
    });

    it("validatePayment is a dry run that names the same error", async () => {
      const { tags, usdt, carol, ada, other } = await loadFixture(withTags);
      const u = await usdt.getAddress();
      const day = BigInt(Math.floor((await latest()) / DAY));
      const [recipient, d] = await tags.validatePayment("ada", u, usd(5), carol.address);
      expect(recipient).to.equal(ada.address);
      expect(d).to.be.oneOf([day, day + 1n]);
      await expect(tags.validatePayment("ada", u, usd(30), carol.address)).to.be.revertedWithCustomError(tags, "OverPaymentLimit");
      await expect(tags.validatePayment("ada", u, usd(5), ada.address)).to.be.revertedWithCustomError(tags, "SelfPayment");
      await expect(tags.validatePayment("zzz", u, usd(5), carol.address)).to.be.revertedWithCustomError(tags, "TagNotFound");
      await expect(tags.validatePayment("ada", await other.getAddress(), usd(5), carol.address)).to.be.revertedWithCustomError(tags, "TokenNotAllowed");
    });

    it("lowering a cap mid-day applies at once and never underflows", async () => {
      const { tags, usdt, carol, dave, admin, ada } = await loadFixture(withTags);
      const u = await usdt.getAddress();
      await tags.connect(carol).payTag("ada", u, usd(20), ref("a"), ethers.ZeroAddress);
      await tags.connect(admin).setTokenLimits(u, usd(1), usd(10), usd(10), usd(10), usd(15));
      expect(await tags.remainingToday(u, ada.address, carol.address)).to.deep.equal([0n, 0n, 0n]);
      await expect(tags.connect(dave).payTag("ada", u, usd(1), ref("b"), ethers.ZeroAddress)).to.be.revertedWithCustomError(tags, "OverRecipientDailyLimit").withArgs(usd(1), 0);
      await expect(tags.connect(carol).payTag("bob", u, usd(1), ref("c"), ethers.ZeroAddress)).to.be.revertedWithCustomError(tags, "OverPayerDailyLimit").withArgs(usd(1), 0);
      await expect(tags.connect(dave).payTag("bob", u, usd(1), ref("d"), ethers.ZeroAddress)).to.be.revertedWithCustomError(tags, "OverDailyLimit").withArgs(usd(1), 0);
    });

    it("never holds funds across a long random run of payments", async () => {
      const { tags, router, bySymbol, carol, dave, payout } = await loadFixture(withTags);
      const recipients = ["ada", "bob", "erin", "frank", "gina"];
      let seed = 7;
      const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
      const paid: Record<string, bigint> = {};
      const start: Record<string, bigint> = {};
      for (const [s, t] of Object.entries(bySymbol)) start[s] = await t.balanceOf(payout.address);
      for (let i = 0; i < 60; i++) {
        const [sym, token] = Object.entries(bySymbol)[rnd(5)];
        const L = LIMITS[sym];
        const amount = L.minPerPayment + ((L.maxPerPayment - L.minPerPayment) * BigInt(rnd(1000))) / 1000n;
        const payer = rnd(2) ? carol : dave;
        try {
          await tags.connect(payer).payTag(recipients[rnd(5)], await token.getAddress(), amount, ref(String(i)), ethers.ZeroAddress);
          paid[sym] = (paid[sym] ?? 0n) + amount;
        } catch {
          /* a limit refused it: nothing moved */
        }
        if (i % 13 === 0) await time.increase(DAY / 3);
      }
      for (const [s, t] of Object.entries(bySymbol)) {
        expect(await t.balanceOf(router), s).to.equal(0n);
        expect(await t.balanceOf(payout.address), s).to.equal(start[s] + (paid[s] ?? 0n));
      }
    });
  });

  // -----------------------------------------------------------------------------------------------------------------
  describe("payTagWithPermit (USD₮ supports EIP-2612 on Celo)", () => {
    async function permitSig(owner: any, token: any, spender: string, value: bigint, deadline: bigint) {
      const { chainId } = await ethers.provider.getNetwork();
      const domain = { name: "Tether USD", version: "1", chainId, verifyingContract: await token.getAddress() };
      const types = { Permit: [
        { name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
      ] };
      const nonce = await token.nonces(owner.address);
      return ethers.Signature.from(await owner.signTypedData(domain, types, { owner: owner.address, spender, value, nonce, deadline }));
    }

    async function fresh() {
      const f = await deployFixture();
      await f.tags.connect(f.ada).claim("ada", "");
      const payer = f.signers[16];
      await f.usdt.mint(payer.address, usd(1000));
      return { ...f, payer };
    }

    it("pays in one transaction with no prior approve, and uses up exactly the permit", async () => {
      const { tags, usdt, router, payer, payout, ada } = await loadFixture(fresh);
      const deadline = BigInt((await latest()) + 3600);
      const sig = await permitSig(payer, usdt, router, usd(7), deadline);
      const tx = tags.connect(payer).payTagWithPermit("ada", await usdt.getAddress(), usd(7), ref("p"), ethers.ZeroAddress, deadline, sig.v, sig.r, sig.s);
      await expect(tx).to.changeTokenBalances(usdt, [payer, payout, router], [-usd(7), usd(7), 0n]);
      await expect(tx).to.emit(tags, "TagPaid").withArgs(id("ada"), "ada", ada.address, payer.address, await usdt.getAddress(), usd(7), ref("p"), anyValue);
      expect(await usdt.allowance(payer.address, router)).to.equal(0n);
    });

    it("still goes through if someone front-runs the permit", async () => {
      const { tags, usdt, router, payer, stranger } = await loadFixture(fresh);
      const deadline = BigInt((await latest()) + 3600);
      const sig = await permitSig(payer, usdt, router, usd(5), deadline);
      await usdt.connect(stranger).permit(payer.address, router, usd(5), deadline, sig.v, sig.r, sig.s);
      await expect(tags.connect(payer).payTagWithPermit("ada", await usdt.getAddress(), usd(5), ref("p"), ethers.ZeroAddress, deadline, sig.v, sig.r, sig.s)).to.emit(tags, "TagPaid");
    });

    it("a bad signature without allowance moves nothing", async () => {
      const { tags, usdt, router, payer, stranger } = await loadFixture(fresh);
      const deadline = BigInt((await latest()) + 3600);
      const sig = await permitSig(stranger, usdt, router, usd(5), deadline);
      await expect(tags.connect(payer).payTagWithPermit("ada", await usdt.getAddress(), usd(5), ref("p"), ethers.ZeroAddress, deadline, sig.v, sig.r, sig.s))
        .to.be.revertedWithCustomError(usdt, "ERC20InsufficientAllowance");
    });

    it("checks the limits before touching the token: the permit is not consumed", async () => {
      const { tags, usdt, router, payer } = await loadFixture(fresh);
      const deadline = BigInt((await latest()) + 3600);
      const sig = await permitSig(payer, usdt, router, usd(30), deadline);
      await expect(tags.connect(payer).payTagWithPermit("ada", await usdt.getAddress(), usd(30), ref("p"), ethers.ZeroAddress, deadline, sig.v, sig.r, sig.s))
        .to.be.revertedWithCustomError(tags, "OverPaymentLimit");
      expect(await usdt.nonces(payer.address)).to.equal(0n);
    });

    it("works with a token without permit when the payer approved beforehand (cNGN)", async () => {
      const { tags, cngn, carol } = await loadFixture(fresh);
      await expect(tags.connect(carol).payTagWithPermit("ada", await cngn.getAddress(), LIMITS.cNGN.minPerPayment, ref("p"), ethers.ZeroAddress, 0, 27, ethers.ZeroHash, ethers.ZeroHash))
        .to.emit(tags, "TagPaid");
    });
  });

  // -----------------------------------------------------------------------------------------------------------------
  describe("pause", () => {
    it("stops claims, renames, receive-token changes and payments, but never releases", async () => {
      const { tags, admin, ada, bob, carol, usdt, cngn } = await loadFixture(deployFixture);
      await tags.connect(ada).claim("ada", "");
      await expect(tags.connect(admin).pause()).to.emit(tags, "PausedSet").withArgs(true, admin.address);
      expect(await tags.paused()).to.equal(true);
      await expect(tags.connect(bob).claim("bob", "")).to.be.revertedWithCustomError(tags, "Paused");
      await expect(tags.connect(ada).setName("x")).to.be.revertedWithCustomError(tags, "Paused");
      await expect(tags.connect(ada).setReceiveToken(await cngn.getAddress())).to.be.revertedWithCustomError(tags, "Paused");
      await expect(tags.connect(carol).payTag("ada", await usdt.getAddress(), usd(5), ref("x"), ethers.ZeroAddress)).to.be.revertedWithCustomError(tags, "Paused");
      await expect(tags.validatePayment("ada", await usdt.getAddress(), usd(5), carol.address)).to.be.revertedWithCustomError(tags, "Paused");
      await expect(tags.connect(ada).release()).to.emit(tags, "TagReleased");
      await expect(tags.connect(admin).pause()).to.be.revertedWithCustomError(tags, "PauseUnchanged");
      await expect(tags.connect(admin).unpause()).to.emit(tags, "PausedSet").withArgs(false, admin.address);
      await expect(tags.connect(admin).unpause()).to.be.revertedWithCustomError(tags, "PauseUnchanged");
      await expect(tags.connect(bob).claim("bob", "")).to.emit(tags, "TagClaimed");
    });
  });

  // -----------------------------------------------------------------------------------------------------------------
  describe("admin", () => {
    it("only the owner can change anything", async () => {
      const { tags, stranger, usdt } = await loadFixture(deployFixture);
      const s = tags.connect(stranger);
      const u = await usdt.getAddress();
      for (const call of [
        () => s.setTokenLimits(u, 1, 1, 1, 1, 1),
        () => s.proposePayoutWallet(stranger.address),
        () => s.executePayoutWallet(),
        () => s.cancelPayoutWallet(),
        () => s.rescue(u, stranger.address, 1),
        () => s.setReserved(["x_y"], true),
        () => s.pause(),
        () => s.unpause(),
        () => s.renounceOwnership(),
        () => s.transferOwnership(stranger.address),
      ]) {
        await expect(call()).to.be.revertedWithCustomError(tags, "OwnableUnauthorizedAccount").withArgs(stranger.address);
      }
    });

    it("setTokenLimits checks 0 < min <= max <= per-recipient-day <= per-day and max <= per-payer-day <= per-day", async () => {
      const { tags, admin, usdt, stranger } = await loadFixture(deployFixture);
      const a = tags.connect(admin);
      const u = await usdt.getAddress();
      const bad = [[0, 5, 5, 5, 5], [6, 5, 5, 5, 5], [1, 6, 5, 5, 5], [1, 5, 6, 5, 5], [1, 5, 5, 4, 5], [1, 5, 5, 6, 5], [0, 0, 0, 0, 1]] as const;
      for (const l of bad) {
        await expect(a.setTokenLimits(u, ...l), String(l)).to.be.revertedWithCustomError(tags, "InvalidLimits");
      }
      await expect(a.setTokenLimits(stranger.address, 1, 1, 1, 1, 1)).to.be.revertedWithCustomError(tags, "InvalidToken").withArgs(stranger.address);
      await expect(a.setTokenLimits(u, 1, 2, 3, 4, 5)).to.emit(tags, "TokenLimitsSet").withArgs(u, 1, 2, 3, 4, 5);
      expect(await tags.tokenLimits(u)).to.deep.equal([1n, 2n, 3n, 4n, 5n]);
    });

    it("the admin can add any number of tokens with any decimals", async () => {
      const { tags, admin, ada, carol, router, payout } = await loadFixture(deployFixture);
      await tags.connect(ada).claim("ada", "");
      const Mock = await ethers.getContractFactory("MockERC20");
      for (const dec of [0, 2, 8, 18, 24]) {
        const t = await Mock.deploy(`T${dec}`, `T${dec}`, dec);
        const one = 10n ** BigInt(dec);
        await tags.connect(admin).setTokenLimits(await t.getAddress(), one, 25n * one, 25n * one, 25n * one, 250n * one);
        await t.mint(carol.address, 1000n * one);
        await t.connect(carol).approve(router, ethers.MaxUint256);
        await expect(tags.connect(carol).payTag("ada", await t.getAddress(), 25n * one, ref(String(dec)), ethers.ZeroAddress)).to.changeTokenBalances(t, [payout, router], [25n * one, 0n]);
      }
    });

    it("payout wallet changes wait 24 hours: propose, then execute; zero or itself refused", async () => {
      const { tags, admin, payout, ada, carol, usdt, signers, router } = await loadFixture(deployFixture);
      const next = signers[17];
      const u = await usdt.getAddress();
      await tags.connect(ada).claim("ada", "");
      const a = tags.connect(admin);
      await expect(a.proposePayoutWallet(ethers.ZeroAddress)).to.be.revertedWithCustomError(tags, "InvalidPayoutWallet");
      await expect(a.proposePayoutWallet(router)).to.be.revertedWithCustomError(tags, "InvalidPayoutWallet");
      await expect(a.executePayoutWallet()).to.be.revertedWithCustomError(tags, "PayoutWalletNotReady").withArgs(0);
      const tx = a.proposePayoutWallet(next.address);
      await expect(tx).to.emit(tags, "PayoutWalletProposed").withArgs(payout.address, next.address, anyValue);
      const eta = (await latest()) + DAY;
      expect(await tags.pendingPayoutWallet()).to.equal(next.address);
      expect(await tags.pendingPayoutWalletEta()).to.equal(BigInt(eta));
      // Nothing changes for 24 hours: payments still go to the old wallet.
      await expect(tags.connect(carol).payTag("ada", u, usd(5), ref("a"), payout.address)).to.changeTokenBalances(usdt, [payout, next], [usd(5), 0n]);
      await time.setNextBlockTimestamp(eta - 1);
      await expect(a.executePayoutWallet()).to.be.revertedWithCustomError(tags, "PayoutWalletNotReady").withArgs(eta);
      await time.setNextBlockTimestamp(eta);
      await expect(a.executePayoutWallet()).to.emit(tags, "PayoutWalletSet").withArgs(payout.address, next.address);
      expect(await tags.payoutWallet()).to.equal(next.address);
      expect(await tags.pendingPayoutWallet()).to.equal(ethers.ZeroAddress);
      await expect(tags.connect(carol).payTag("ada", u, usd(5), ref("b"), ethers.ZeroAddress)).to.changeTokenBalances(usdt, [next, payout], [usd(5), 0n]);
    });

    it("a pending payout wallet change can be cancelled", async () => {
      const { tags, admin, payout, signers } = await loadFixture(deployFixture);
      const a = tags.connect(admin);
      await expect(a.cancelPayoutWallet()).to.be.revertedWithCustomError(tags, "PayoutWalletNotReady");
      await a.proposePayoutWallet(signers[17].address);
      await expect(a.cancelPayoutWallet()).to.emit(tags, "PayoutWalletCancelled").withArgs(signers[17].address);
      await time.increase(2 * DAY);
      await expect(a.executePayoutWallet()).to.be.revertedWithCustomError(tags, "PayoutWalletNotReady");
      expect(await tags.payoutWallet()).to.equal(payout.address);
    });

    it("a payer can pin the payout wallet: PayoutWalletChanged if it moved", async () => {
      const { tags, admin, payout, ada, carol, usdt, signers } = await loadFixture(deployFixture);
      const u = await usdt.getAddress();
      await tags.connect(ada).claim("ada", "");
      await expect(tags.connect(carol).payTag("ada", u, usd(5), ref("a"), payout.address)).to.emit(tags, "TagPaid");
      await tags.connect(admin).proposePayoutWallet(signers[17].address);
      await time.increase(DAY);
      await tags.connect(admin).executePayoutWallet();
      await expect(tags.connect(carol).payTag("ada", u, usd(5), ref("b"), payout.address))
        .to.be.revertedWithCustomError(tags, "PayoutWalletChanged").withArgs(signers[17].address);
      await expect(tags.connect(carol).payTagWithPermit("ada", u, usd(5), ref("c"), payout.address, 0, 27, ethers.ZeroHash, ethers.ZeroHash))
        .to.be.revertedWithCustomError(tags, "PayoutWalletChanged");
    });

    it("rescue returns tokens sent here by mistake; owner only; never touches payments", async () => {
      const { tags, admin, carol, usdt, router, stranger } = await loadFixture(deployFixture);
      const u = await usdt.getAddress();
      await usdt.connect(carol).transfer(router, usd(3));
      await expect(tags.connect(stranger).rescue(u, stranger.address, usd(3))).to.be.revertedWithCustomError(tags, "OwnableUnauthorizedAccount");
      await expect(tags.connect(admin).rescue(u, ethers.ZeroAddress, usd(3))).to.be.revertedWithCustomError(tags, "InvalidPayoutWallet");
      await expect(tags.connect(admin).rescue(u, router, usd(3))).to.be.revertedWithCustomError(tags, "InvalidPayoutWallet");
      await expect(tags.connect(admin).rescue(u, carol.address, usd(4))).to.be.revertedWithCustomError(usdt, "ERC20InsufficientBalance");
      const tx = tags.connect(admin).rescue(u, carol.address, usd(3));
      await expect(tx).to.emit(tags, "Rescued").withArgs(u, carol.address, usd(3));
      await expect(tx).to.changeTokenBalances(usdt, [router, carol], [-usd(3), usd(3)]);
      // A payer's allowance to the router is not something rescue can reach: it only sends the router's own balance.
      expect(await usdt.allowance(carol.address, router)).to.equal(ethers.MaxUint256);
    });

    it("setReserved adds and removes, and can never touch a held or locked tag", async () => {
      const { tags, admin, ada, bob } = await loadFixture(deployFixture);
      const a = tags.connect(admin);
      await expect(a.setReserved(["brand", "naira"], true)).to.emit(tags, "ReservedSet").withArgs(id("brand"), "brand", true);
      await expect(tags.connect(bob).claim("brand", "")).to.be.revertedWithCustomError(tags, "TagReserved");
      await expect(a.setReserved(["brand"], false)).to.emit(tags, "ReservedSet").withArgs(id("brand"), "brand", false);
      await expect(tags.connect(bob).claim("brand", "")).to.emit(tags, "TagClaimed");
      await expect(a.setReserved(["brand"], true)).to.be.revertedWithCustomError(tags, "TagInUse");
      await tags.connect(ada).claim("ada", "");
      await tags.connect(ada).release();
      await expect(a.setReserved(["ada"], true)).to.be.revertedWithCustomError(tags, "TagInUse");
      await time.increase(LOCK);
      await expect(a.setReserved(["ada"], true)).to.emit(tags, "ReservedSet");
      await expect(a.setReserved(Array.from({ length: 129 }, (_, i) => `t${i}xx`), true)).to.be.revertedWithCustomError(tags, "BatchTooLarge").withArgs(129);
    });

    it("Ownable2Step: the new owner must accept; the old owner keeps control until then", async () => {
      const { tags, admin, ada, stranger } = await loadFixture(deployFixture);
      await expect(tags.connect(admin).transferOwnership(ada.address)).to.emit(tags, "OwnershipTransferStarted").withArgs(admin.address, ada.address);
      expect(await tags.owner()).to.equal(admin.address);
      expect(await tags.pendingOwner()).to.equal(ada.address);
      await expect(tags.connect(stranger).acceptOwnership()).to.be.revertedWithCustomError(tags, "OwnableUnauthorizedAccount");
      await tags.connect(admin).pause();
      await expect(tags.connect(ada).acceptOwnership()).to.emit(tags, "OwnershipTransferred").withArgs(admin.address, ada.address);
      expect(await tags.owner()).to.equal(ada.address);
      await expect(tags.connect(admin).unpause()).to.be.revertedWithCustomError(tags, "OwnableUnauthorizedAccount");
      await tags.connect(ada).unpause();
    });

    it("ownership can't be renounced", async () => {
      const { tags, admin } = await loadFixture(deployFixture);
      await expect(tags.connect(admin).renounceOwnership()).to.be.revertedWithCustomError(tags, "RenounceDisabled");
    });

    it("has no function that could take a tag or move anyone's tokens", async () => {
      const { tags } = await loadFixture(deployFixture);
      const writes = tags.interface.fragments
        .filter((f): f is any => f.type === "function" && !["view", "pure"].includes((f as any).stateMutability))
        .map((f: any) => f.name)
        .sort();
      expect(writes).to.deep.equal([
        "acceptOwnership", "cancelPayoutWallet", "claim", "executePayoutWallet", "pause", "payTag", "payTagWithPermit",
        "proposePayoutWallet", "release", "rescue", "setName", "setReceiveToken", "setReserved", "setTokenLimits",
        "transferOwnership", "unpause",
      ]);
    });
  });

  it("config: the deploy table covers the five Celo mainnet tokens at their real decimals", () => {
    expect(TOKENS.map((t) => [t.symbol, t.decimals])).to.deep.equal([["USDT", 6], ["cNGN", 6], ["IDRX", 2], ["wARS", 18], ["wCOP", 18]]);
    expect(LIMITS.USDT).to.deep.equal({ minPerPayment: usd(1), maxPerPayment: usd(25), maxPerRecipientPerDay: usd(25), maxPerPayerPerDay: usd(25), maxPerDay: usd(250) });
  });
});
