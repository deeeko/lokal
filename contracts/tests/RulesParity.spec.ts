// Fuzz-ish parity: thousands of random tags and names, and random claim/release histories, checked against the
// site's own rules (a copy, and the live port block from site/assets/core.js when the repo is present).
import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { RESERVED_TAGS } from "../config/celo";
import { DAY, deployFixture } from "./helpers/fixture";
import { liveReservedLists } from "../config/repo-rules";
import { NTAG_RESERVED, contractNameValid, contractTagValid, loadRepoRules, ntagError, ntagNameError } from "./helpers/rules";

const AVAIL = ["free", "yours", "taken", "reserved", "locked", "invalid"];

/** Small deterministic PRNG, so a failure is reproducible. */
function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 2 ** 32;
  };
}

const repo = loadRepoRules();

describe("parity with the site's rules", () => {
  it(`the live repo rules are present (${repo ? repo.file : "not found: contracts/ used on its own"}) and match the copy`, function () {
    if (!repo) this.skip();
    expect([...repo!.NTAG_RESERVED].sort()).to.deep.equal([...NTAG_RESERVED].sort());
    expect(repo!.RELEASE_LOCK_DAYS).to.equal(30);
    for (const t of ["ada", "Ada", "a__b", "ada_", "admin", "1ab", "ab", "a".repeat(21), "ok_1"]) {
      expect(repo!.ntagError(t), t).to.equal(ntagError(t));
    }
  });

  it("the deployed reserved list is exactly the site's and the agent's (both live files)", function () {
    expect([...RESERVED_TAGS].sort()).to.deep.equal([...NTAG_RESERVED].sort());
    if (!repo) this.skip();
    for (const live of liveReservedLists()) {
      expect([...live.tags].sort(), live.file).to.deep.equal([...RESERVED_TAGS].sort());
    }
    // The live name rule agrees with the copy on the characters the audit flagged.
    for (const n of ["Ada", "Ada​Obi", "Ada‮Obi", "Ada⁦x", "A﻿da", "﻿Ada"]) {
      expect(repo!.ntagNameError(n), JSON.stringify(n)).to.equal(ntagNameError(n));
    }
  });

  it("3,000 random tags: the contract accepts a claim exactly when the site's ntagError says null", async () => {
    const { tags, ada } = await loadFixture(deployFixture);
    const rnd = prng(20261121);
    const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789____ABCZ-. é@";
    const samples = new Set<string>([...NTAG_RESERVED, "ada", "a_b", "a__b", "ab_", "abc", "abcdefghijklmnopqrst", "abcdefghijklmnopqrstu"]);
    while (samples.size < 3000) {
      const len = Math.floor(rnd() * 24);
      let t = "";
      for (let i = 0; i < len; i++) t += alphabet[Math.floor(rnd() * alphabet.length)];
      samples.add(t);
    }
    const live = repo?.ntagError ?? ntagError;
    const list = [...samples];
    for (let i = 0; i < list.length; i += 200) {
      const batch = list.slice(i, i + 200);
      const [valid, avail] = await Promise.all([
        Promise.all(batch.map((t) => tags.isValidTag(t))),
        Promise.all(batch.map((t) => tags.availability(t, ada.address))),
      ]);
      batch.forEach((t, k) => {
        const site = live(t);
        expect(valid[k], `format ${JSON.stringify(t)}`).to.equal(contractTagValid(t));
        expect(AVAIL[Number(avail[k])] === "free", `claimable ${JSON.stringify(t)}`).to.equal(site === null);
        const expected = site === null ? "free" : site === "this tag is reserved" ? "reserved" : "invalid";
        expect(AVAIL[Number(avail[k])], `availability ${JSON.stringify(t)}`).to.equal(expected);
      });
    }
  });

  it("1,500 random names: the contract accepts exactly what the site accepts once trimmed", async () => {
    const { tags } = await loadFixture(deployFixture);
    const rnd = prng(42);
    const pieces = ["a", "Z", " ", "\u00e9", "\u1ecd\u0300", "\u1e62", "\u674e", "\u{1f600}", "\u{1f1f3}\u{1f1ec}", "\u000a", "\u0009", "\u0000", "\u007f", "\u0085", "\u009f", "\u00a0", "\u2003", "\u3000", "\ufeff", "\u2028", "\u200b", "\u200d", "\u202e", "\u2066", "-", "'", "0"];
    const live = repo?.ntagNameError ?? ntagNameError;
    const names: string[] = ["", " ", "x".repeat(40), "x".repeat(41), "😀".repeat(20), "😀".repeat(21)];
    while (names.length < 1500) {
      const len = Math.floor(rnd() * 45);
      let n = "";
      for (let i = 0; i < len; i++) n += pieces[Math.floor(rnd() * pieces.length)];
      names.push(n);
    }
    for (let i = 0; i < names.length; i += 250) {
      const batch = names.slice(i, i + 250);
      const got = await Promise.all(batch.map((n) => tags.isValidName(n)));
      batch.forEach((n, k) => {
        expect(got[k], `port ${JSON.stringify(n)}`).to.equal(contractNameValid(n));
        // The site trims; the contract wants the trimmed form. Over the site's own alphabet the two then agree.
        const siteOk = n === "" || (live(n) === null && n === n.trim());
        expect(got[k], `site ${JSON.stringify(n)}`).to.equal(siteOk);
      });
    }
  });

  it("random claim/release histories end in the same owners, names, locks and availability as the site's resolver", async function () {
    if (!repo) this.skip();
    const { tags, signers, clock } = await loadFixture(deployFixture);
    const wallets = signers.slice(10, 16);
    const pool = ["ada", "bob", "chi", "dayo", "emeka", "admin", "Bad", "a__b"];
    const rnd = prng(7);
    const ops: unknown[] = [];

    for (let step = 0; step < 180; step++) {
      const w = wallets[Math.floor(rnd() * wallets.length)];
      const jump = [0, 60, 3600, DAY, 10 * DAY, 29 * DAY, 31 * DAY][Math.floor(rnd() * 7)];
      if (jump) await time.increase(jump);
      const current = await tags.tagOf(w.address);
      let tx;
      let op: { t: string; n?: string };
      if (rnd() < 0.25) {
        op = { t: "" };
        tx = tags.connect(w).release();
      } else {
        let t = pool[Math.floor(rnd() * pool.length)];
        if (t === current) t = pool[(pool.indexOf(t) + 1) % pool.length]; // claiming your own tag is a rename: setName's job
        const name = rnd() < 0.5 ? `N${step}` : "";
        op = name ? { t, n: name } : { t };
        tx = tags.connect(w).claim(t, name);
      }
      let rc;
      try {
        rc = await (await tx).wait();
      } catch {
        rc = null; // refused onchain; under the old protocol the same op would simply have been "taken"/"locked"/"noop"
      }
      const block = rc ? rc.blockNumber : await ethers.provider.getBlockNumber() + 1;
      const ts = rc ? (await ethers.provider.getBlock(rc.blockNumber))!.timestamp : await time.latest();
      ops.push({ hash: `0x${step.toString(16).padStart(64, "0")}`, from: w.address.toLowerCase(), block, position: rc ? rc.index : 0, time: ts, value: "0", op });
      if (!rc) await ethers.provider.send("evm_mine", []);
    }

    const state = repo!.resolveNtags(ops);
    const now = Number(await clock.timestamp());
    for (const w of wallets) {
      const expectedTag = state.byOwner.get(w.address.toLowerCase()) ?? "";
      expect(await tags.tagOf(w.address), `tagOf ${w.address}`).to.equal(expectedTag);
      const entry = expectedTag ? state.tags.get(expectedTag) : null;
      expect(await tags.nameOf(w.address), `nameOf ${w.address}`).to.equal(entry?.name ?? "");
      for (const t of pool) {
        const site = repo!.ntagAvailability(state, t, w.address, now);
        expect(AVAIL[Number(await tags.availability(t, w.address))], `${t} for ${w.address}`).to.equal(site);
      }
    }
    for (const t of pool) {
      expect((await tags.ownerOf(t)).toLowerCase(), `ownerOf ${t}`).to.equal(state.tags.get(t)?.owner ?? ethers.ZeroAddress);
    }
  });
});
