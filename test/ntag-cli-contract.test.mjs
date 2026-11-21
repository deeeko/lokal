// The `lokal` CLI on the LokalTags contract: reading a tag and explaining a refusal before anything is signed (fake RPC).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { encodeErrorResult } from "viem";
import { CliError, contractTag, simulateCall } from "../src/ntag.mjs";
import { TOKENS } from "../src/config.mjs";
import { claimData } from "../site/assets/lokal-contracts.js";

const tagsAbi = JSON.parse(fs.readFileSync(new URL("../contracts/deployments/LokalTags.json", import.meta.url), "utf8")).abi;
const ADA = "0x2222222222222222222222222222222222222222";
const ZERO = "0x0000000000000000000000000000000000000000";

test("contractTag: holder, name, since and the optional default currency", async () => {
  const pub = { readContract: async ({ functionName, args }) => {
    assert.equal(functionName, "tagInfo");
    return args[0] === "ada" ? [ADA, "Ada Obi", 1_790_000_000n, ZERO, 0n, TOKENS.WARS.address] : [ZERO, "", 0n, ADA, 1_800_000_000n, ZERO];
  } };
  const t = await contractTag(pub, "ada");
  assert.equal(t.owner.toLowerCase(), ADA);
  assert.equal(t.name, "Ada Obi");
  assert.equal(t.receive, "wars");
  const free = await contractTag(pub, "gone");
  assert.equal(free.owner, null);
  assert.equal(free.lock.until, 1_800_000_000);
});

test("simulateCall: a revert becomes a plain-English CliError, nothing is signed", async () => {
  const data = encodeErrorResult({ abi: tagsAbi, errorName: "TagTaken", args: [ADA] });
  const pub = { call: async () => { throw Object.assign(new Error("execution reverted"), { cause: { data } }); } };
  await assert.rejects(simulateCall(pub, ADA, { to: "0x" + "ff".repeat(20), data: claimData("ada") }, { tag: "ada" }),
    (e) => e instanceof CliError && /@ada is taken by 0x2222…2222/.test(e.message));
  const ok = { call: async () => ({ data: "0x" }) };
  await simulateCall(ok, ADA, { to: "0x" + "ff".repeat(20), data: claimData("ada") });
});
