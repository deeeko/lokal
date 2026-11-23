// The site's contract module (site/assets/lokal-contracts.js): selectors, calldata builders with the attribution
// suffix, the USD₮ permit, revert decoding in plain English and RPC reads with a mocked RPC. No network.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { decodeFunctionData, hashDomain, hashTypedData, recoverTypedDataAddress, toEventSelector, toFunctionSelector, encodeErrorResult, encodeAbiParameters } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import * as C from "../site/assets/lokal-contracts.js";
import { tagSuffix as siteSuffix, AGENT, TOKENS } from "../site/assets/core.js";
import { tagSuffix as agentSuffix } from "../src/ntags.mjs";
import { LEGACY_CUTOVER_BLOCK, LOKAL_POTS, LOKAL_TAGS, LOKAL_TAGS_BLOCK, LOKAL_POTS_BLOCK } from "../src/config.mjs";

const tagsAbi = JSON.parse(fs.readFileSync(new URL("../contracts/deployments/LokalTags.json", import.meta.url), "utf8")).abi;
const potsAbi = JSON.parse(fs.readFileSync(new URL("../contracts/deployments/LokalPots.json", import.meta.url), "utf8")).abi;
const erc20Extra = [
  { type: "function", name: "approve", inputs: [{ name: "s", type: "address" }, { name: "a", type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" },
  { type: "function", name: "allowance", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "balanceOf", inputs: [{ name: "o", type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "nonces", inputs: [{ name: "o", type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "DOMAIN_SEPARATOR", inputs: [], outputs: [{ type: "bytes32" }], stateMutability: "view" },
];
const ADA = "0x2222222222222222222222222222222222222222";
const PAYER = "0x4444444444444444444444444444444444444444";
const USDT = TOKENS.USDT.address;
const SUFFIX = siteSuffix();
/** Strips this app's attribution suffix (it must be there) and decodes the call with the verified ABI. */
function decodeCall(data, abi = tagsAbi) {
  assert.ok(data.endsWith(SUFFIX), "the attribution suffix is appended");
  return decodeFunctionData({ abi, data: data.slice(0, -SUFFIX.length) });
}

test("addresses, deployment blocks and the cutover agree with src/config.mjs", () => {
  assert.equal(C.LOKAL_TAGS, LOKAL_TAGS);
  assert.equal(C.LOKAL_POTS, LOKAL_POTS);
  assert.equal(BigInt(C.LOKAL_TAGS_BLOCK), LOKAL_TAGS_BLOCK);
  assert.equal(BigInt(C.LOKAL_POTS_BLOCK), LOKAL_POTS_BLOCK);
  assert.equal(BigInt(C.LEGACY_CUTOVER_BLOCK), LEGACY_CUTOVER_BLOCK);
  assert.ok(C.LEGACY_CUTOVER_BLOCK > C.LOKAL_TAGS_BLOCK);
  assert.equal(C.PAYOUT_WALLET, AGENT);
});

test("every selector, topic and error id is the keccak of the verified ABI", () => {
  const abi = [...tagsAbi, ...potsAbi, ...erc20Extra];
  for (const [name, sel] of Object.entries(C.FN)) {
    const item = abi.find((x) => x.type === "function" && x.name === name);
    assert.ok(item, name);
    assert.equal(sel, toFunctionSelector(item), name);
  }
  for (const [name, topic] of Object.entries(C.TOPIC)) {
    assert.equal(topic, toEventSelector(abi.find((x) => x.type === "event" && x.name === name)), name);
  }
  const errs = [...tagsAbi, ...potsAbi].filter((x) => x.type === "error");
  for (const [sel, [name, types]] of Object.entries(C.ERRORS)) {
    if (["ERC20InsufficientBalance", "ERC20InsufficientAllowance", "Error", "Panic"].includes(name)) {
      assert.equal(sel, toFunctionSelector(`${name}(${types.join(",")})`), name);
      continue;
    }
    const item = errs.find((x) => x.name === name);
    assert.ok(item, `${name} is a contract error`);
    assert.equal(sel, toFunctionSelector(`${name}(${item.inputs.map((i) => i.type).join(",")})`), name);
    assert.deepEqual(types, item.inputs.map((i) => i.type), name);
  }
  // every user-facing error of both contracts can be explained
  const userFacing = ["TagNotFound", "OverPaymentLimit", "OverRecipientDailyLimit", "OverPayerDailyLimit", "OverDailyLimit", "SelfPayment", "Paused",
    "BelowMinimum", "TokenNotAllowed", "RecipientIsContract", "RecipientIsPayoutWallet", "PayoutWalletChanged", "InvalidTag", "InvalidName",
    "TagReserved", "TagTaken", "AlreadyYours", "TagLocked", "NoTag", "PotNotFound", "PotIsClosed", "PotExpired", "PotFull", "OverPayerCap",
    "OverHostDailyLimit", "HostNotEligible", "TransferAmountMismatch", "SafeERC20FailedOperation"];
  const known = new Set(Object.values(C.ERRORS).map(([n]) => n));
  for (const n of userFacing) assert.ok(known.has(n), n);
});

test("calldata builders: what the contract expects, plus the same attribution suffix as the agent's own transactions", () => {
  assert.equal(SUFFIX, agentSuffix(), "site and agent build the same ERC-8021 suffix");
  let d = decodeCall(C.claimData("ada", "Ada Obi"));
  assert.equal(d.functionName, "claim");
  assert.deepEqual(d.args, ["ada", "Ada Obi"]);
  assert.deepEqual(decodeCall(C.claimData("ada")).args, ["ada", ""]);
  d = decodeCall(C.setNameData("Àdá Ọbí 🌍"));
  assert.deepEqual([d.functionName, ...d.args], ["setName", "Àdá Ọbí 🌍"]);
  d = decodeCall(C.setReceiveTokenData(TOKENS.IDRX.address));
  assert.deepEqual([d.functionName, d.args[0].toLowerCase()], ["setReceiveToken", TOKENS.IDRX.address.toLowerCase()]);
  assert.equal(decodeCall(C.setReceiveTokenData(null)).args[0], C.ZERO_ADDRESS);
  assert.equal(decodeCall(C.releaseData()).functionName, "release");
  d = decodeCall(C.payTagData({ tag: "ada", token: USDT, amount: 5_000_000n }));
  assert.equal(d.functionName, "payTag");
  assert.deepEqual(d.args.map(String).map((s) => s.toLowerCase()), ["ada", USDT.toLowerCase(), "5000000", C.ZERO_REF, AGENT.toLowerCase()], "pins the agent as payout wallet");
  const r = "0x" + "ab".repeat(32), s = "0x" + "cd".repeat(32);
  d = decodeCall(C.payTagWithPermitData({ tag: "ada", token: USDT, amount: 10_000_000n, deadline: 1_800_000_000n, v: 28, r, s }));
  assert.equal(d.functionName, "payTagWithPermit");
  assert.deepEqual([d.args[2], d.args[5], d.args[6], d.args[7], d.args[8]], [10_000_000n, 1_800_000_000n, 28, r, s]);
  d = decodeCall(C.payPotData({ potId: 3n, token: USDT, amount: 2_000_000n }), potsAbi);
  assert.deepEqual([d.functionName, d.args[0], d.args[2]], ["payPot", 3n, 2_000_000n]);
  d = decodeCall(C.approveData(C.LOKAL_TAGS, 1_441_000_000n), erc20Extra);
  assert.deepEqual([d.functionName, d.args[0].toLowerCase(), d.args[1]], ["approve", C.LOKAL_TAGS.toLowerCase(), 1_441_000_000n]);
  assert.throws(() => C.payTagData({ tag: "ada", token: USDT, amount: 0n }), /invalid amount/);
  assert.throws(() => C.payTagData({ tag: "ada", token: "0x12", amount: 1n }), /invalid token/);
  assert.throws(() => C.approveData("nope", 1n), /invalid spender/);
});

test("the USD₮ permit: the live domain separator, a signature the token would accept, split into v, r, s", async () => {
  assert.equal(hashDomain({ domain: C.USDT_PERMIT_DOMAIN, types: { EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }] } }), C.USDT_DOMAIN_SEPARATOR);
  const acct = privateKeyToAccount("0x" + "11".repeat(32));
  const td = C.permitTypedData({ owner: acct.address, value: 5_000_000n, nonce: 2n, deadline: 1_800_000_000n });
  assert.equal(td.message.spender, C.LOKAL_TAGS);
  // what a wallet does with eth_signTypedData_v4
  const sig = await acct.signTypedData({ domain: td.domain, types: { Permit: td.types.Permit }, primaryType: "Permit", message: { ...td.message, value: 5_000_000n, nonce: 2n, deadline: 1_800_000_000n } });
  assert.equal(await recoverTypedDataAddress({ domain: td.domain, types: { Permit: td.types.Permit }, primaryType: "Permit", message: { ...td.message, value: 5_000_000n, nonce: 2n, deadline: 1_800_000_000n }, signature: sig }), acct.address);
  assert.ok(hashTypedData({ domain: td.domain, types: { Permit: td.types.Permit }, primaryType: "Permit", message: { ...td.message, value: 5_000_000n, nonce: 2n, deadline: 1_800_000_000n } }));
  const { v, r, s } = C.splitSignature(sig);
  assert.ok(v === 27 || v === 28);
  assert.equal(r, sig.slice(0, 66));
  assert.equal(s, "0x" + sig.slice(66, 130));
  assert.equal(C.splitSignature(sig.slice(0, 130) + "00").v, 27, "v 0/1 normalised");
  assert.throws(() => C.splitSignature("0x1234"), /length/);
});

test("reverts in plain English, for every refusal a payer or owner can hit", () => {
  const err = (name, args = []) => encodeErrorResult({ abi: [...tagsAbi, ...potsAbi], errorName: name, args });
  const say = (name, args, ctx = { tag: "ada", token: USDT }) => C.explainRevert(err(name, args), ctx).message;
  assert.match(say("TagNotFound"), /@ada isn't claimed on the LokalPay contract/);
  assert.match(say("OverPaymentLimit", [30_000_000n, 25_000_000n]), /\$25\.00 limit for one payment in USD₮/);
  assert.match(say("BelowMinimum", [500_000n, 1_000_000n]), /smallest payment in USD₮ is \$1\.00/);
  assert.match(say("OverRecipientDailyLimit", [10_000_000n, 4_500_000n]), /@ada can receive only \$4\.50 more in USD₮ today/);
  assert.match(say("OverRecipientDailyLimit", [10_000_000n, 0n]), /@ada has reached today's limit/);
  assert.match(say("OverPayerDailyLimit", [10_000_000n, 2_000_000n]), /You can pay only \$2\.00 more in USD₮ today/);
  assert.match(say("OverDailyLimit", [10_000_000n, 0n]), /reached today's total for USD₮/);
  assert.match(say("SelfPayment"), /can't pay your own tag/);
  assert.match(say("Paused"), /paused/);
  assert.match(say("TokenNotAllowed", [ADA]), /isn't accepted/);
  assert.match(say("RecipientIsContract", [ADA]), /smart contract/);
  assert.match(say("PayoutWalletChanged", [ADA]), /payout wallet changed/);
  assert.match(say("TagTaken", [ADA]), /@ada is taken by 0x2222…2222/);
  assert.match(say("TagLocked", [1_800_000_000n]), /on hold until/);
  assert.match(say("PotFull", [3_000_000n, 1_250_000n], { potId: 3n }), /can take \$1\.25 more/);
  assert.match(say("OverPayerCap", [3_000_000n, 500_000n], { potId: 3n }), /\$0\.50 more into this pot/);
  // local-currency amounts use the token's own decimals and symbol
  assert.match(C.explainRevert(err("OverRecipientDailyLimit", [1n, 1_441_000_000n]), { tag: "ada", token: TOKENS.cNGN.address }).message, /₦1,441\.00 more in cNGN/);
  assert.match(C.explainRevert(err("BelowMinimum", [1n, 1_840_700n]), { tag: "ada", token: TOKENS.IDRX.address }).message, /Rp 18,407/);
  // token errors and strings
  const bal = encodeErrorResult({ abi: [{ type: "error", name: "ERC20InsufficientBalance", inputs: [{ type: "address" }, { type: "uint256" }, { type: "uint256" }] }], errorName: "ERC20InsufficientBalance", args: [ADA, 1n, 2n] });
  assert.match(C.explainRevert(bal, { token: USDT }).message, /holds enough USD₮/);
  const str = "0x08c379a0" + encodeAbiParameters([{ type: "string" }], ["ERC20: transfer amount exceeds balance"]).slice(2);
  assert.match(C.explainRevert(str, { token: USDT }).message, /doesn't hold enough USD₮/);
  assert.equal(C.decodeRevert(err("Paused")).name, "Paused");
  assert.equal(C.decodeRevert("0xdeadbeef"), null);
  assert.match(C.explainRevert("0xdeadbeef").message, /refused this transaction/);
  assert.match(C.explainRevert(null).message, /Nothing was sent/);
});

test("revert data is found wherever a wallet or RPC puts it", () => {
  const data = "0x9e87fac8";
  assert.equal(C.revertDataOf({ code: 3, message: "execution reverted", data }), data);
  assert.equal(C.revertDataOf({ error: { data } }), data);
  assert.equal(C.revertDataOf({ data: { data } }), data);
  assert.equal(C.revertDataOf({ cause: { cause: { data } } }), data);
  assert.equal(C.revertDataOf({ message: `execution reverted: custom error ${data}` }), data);
  assert.equal(C.revertDataOf({ message: "user rejected" }), null);
});

test("reads with a mocked RPC: tag info, availability, the payment room and the contract's own dry run", async () => {
  const calls = [];
  const answers = new Map();
  const fetchJson = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body.params[0]);
    const key = body.params[0].data.slice(0, 10);
    const a = answers.get(key);
    return typeof a === "function" ? a(body.params[0]) : a;
  };
  const opts = { fetchJson };
  const ret = (types, vals) => ({ jsonrpc: "2.0", id: 1, result: encodeAbiParameters(types.map((t) => ({ type: t })), vals) });
  answers.set(C.FN.tagInfo, ret(["address", "string", "uint256", "address", "uint256", "address"], [ADA, "Ada Obi", 1_790_000_000n, C.ZERO_ADDRESS, 0n, TOKENS.IDRX.address]));
  const info = await C.readTagInfo("ada", opts);
  assert.deepEqual({ ...info, owner: info.owner.toLowerCase(), receiveToken: info.receiveToken.toLowerCase() },
    { owner: ADA, name: "Ada Obi", since: 1_790_000_000, lockedFor: null, lockedUntil: 0, receiveToken: TOKENS.IDRX.address.toLowerCase(), receive: "idrx" });
  assert.equal(calls[0].to, C.LOKAL_TAGS);
  answers.set(C.FN.availability, ret(["uint8"], [4]));
  assert.equal(await C.readAvailability("ada", PAYER, opts), "locked");
  answers.set(C.FN.tokenLimits, ret(["uint128", "uint128", "uint128", "uint128", "uint128"], [1_000_000n, 25_000_000n, 25_000_000n, 25_000_000n, 250_000_000n]));
  answers.set(C.FN.remainingToday, ret(["uint256", "uint256", "uint256"], [7_000_000n, 25_000_000n, 200_000_000n]));
  const room = await C.readPaymentRoom(USDT, ADA, PAYER, opts);
  assert.equal(room.room, 7_000_000n, "the smallest of max per payment and the three rooms");
  assert.equal(room.min, 1_000_000n);
  // validatePayment reverting: explained before anything is sent
  answers.set(C.FN.validatePayment, { jsonrpc: "2.0", id: 1, error: { code: 3, message: "execution reverted", data: encodeErrorResult({ abi: tagsAbi, errorName: "OverRecipientDailyLimit", args: [10_000_000n, 7_000_000n] }) } });
  const chk = await C.checkPayment({ tag: "ada", token: USDT, amount: 10_000_000n, payer: PAYER }, opts);
  assert.equal(chk.ok, false);
  assert.equal(chk.name, "OverRecipientDailyLimit");
  assert.match(chk.message, /\$7\.00 more/);
  answers.set(C.FN.validatePayment, ret(["address", "uint256"], [ADA, 20_700n]));
  const ok = await C.checkPayment({ tag: "ada", token: USDT, amount: 5_000_000n, payer: PAYER }, opts);
  assert.equal(ok.ok, true);
  assert.equal(ok.recipient.toLowerCase(), ADA);
  // simulate: the exact transaction, from the payer
  answers.set(C.FN.payTagWithPermit, { jsonrpc: "2.0", id: 1, error: { code: 3, message: "execution reverted", data: encodeErrorResult({ abi: tagsAbi, errorName: "SelfPayment" }) } });
  const sim = await C.simulate({ from: ADA, to: C.LOKAL_TAGS, data: C.payTagWithPermitData({ tag: "ada", token: USDT, amount: 1n, deadline: 1n, v: 27, r: C.ZERO_REF, s: C.ZERO_REF }) }, { tag: "ada", token: USDT }, opts);
  assert.equal(sim.ok, false);
  assert.match(sim.message, /own tag/);
  assert.equal(calls.at(-1).from, ADA);
  // the permit domain is checked live; a token without that domain falls back to approve + payTag
  answers.set(C.FN.DOMAIN_SEPARATOR, { jsonrpc: "2.0", id: 1, result: C.USDT_DOMAIN_SEPARATOR });
  assert.equal(await C.permitDomainOk(USDT, opts), true);
  answers.set(C.FN.DOMAIN_SEPARATOR, { jsonrpc: "2.0", id: 1, result: "0x" + "00".repeat(32) });
  assert.equal(await C.permitDomainOk(USDT, opts), false);
  assert.equal(await C.permitDomainOk(TOKENS.cNGN.address, opts), false);
});

test("payable tokens follow the payout route: no page offers a payment the agent would refuse", () => {
  const codes = (rt, kind) => C.payableTokens(rt, kind).map((t) => t.code);
  assert.deepEqual(codes(null, "tag"), ["usdt", "cngn", "idrx", "wars", "wcop"]);
  assert.deepEqual(codes(TOKENS.IDRX.address, "tag"), ["usdt", "idrx"]);
  assert.deepEqual(codes(TOKENS.USDT.address, "tag"), ["usdt", "cngn", "idrx", "wars", "wcop"]);
  assert.deepEqual(codes(null, "pot"), ["usdt", "cngn", "idrx", "wars", "wcop"]);
  // the payer's own choice: dollars can be paid in any of the five; a local currency in USD₮ or that same token
  const withs = (chosen, kind) => C.payWithTokens(chosen, kind).map((t) => `${t.code}:${t.symbol}:${t.decimals}`);
  for (const kind of ["tag", "pot"]) {
    assert.deepEqual(withs("usdt", kind), ["usdt:USD₮:6", "cngn:cNGN:6", "idrx:IDRX:2", "wars:wARS:18", "wcop:wCOP:18"]);
    assert.deepEqual(withs("cngn", kind), ["usdt:USD₮:6", "cngn:cNGN:6"]);
    assert.deepEqual(withs("idrx", kind), ["usdt:USD₮:6", "idrx:IDRX:2"]);
    assert.deepEqual(withs("wcop", kind), ["usdt:USD₮:6", "wcop:wCOP:18"]);
  }
  // the estimate and the limits use the paid token's own decimals and its <code>-usdt rate
  assert.deepEqual(["usdt", "cngn", "idrx", "wars", "wcop"].map((c) => C.unitsFromCents(1_000, c)),
    [10_000_000n, 10_000_000n, 1_000n, 10n * 10n ** 18n, 10n * 10n ** 18n]);
  assert.deepEqual(["usdt", "cngn", "idrx", "wars", "wcop"].map(C.payDecimals), [6, 6, 2, 18, 18]);
  const rate = {
    rates: { cngn: 1441, idrx: 18393, wars: 1760, wcop: 3460 }, available: { cngn: true, idrx: true, wars: true, wcop: false },
    reverseRate: 0.00068, reverseRates: { cngn: 0.00068, idrx: 0.0000541, wars: null, wcop: null },
  };
  assert.deepEqual(C.usdPerUnit("usdt", rate), { usdPer: 1, approx: false });
  assert.deepEqual(C.usdPerUnit("idrx", rate), { usdPer: 0.0000541, approx: false }, "the reverse preview");
  assert.deepEqual(C.usdPerUnit("wars", rate), { usdPer: 1 / 1760, approx: true }, "no reverse rate yet: 1 / the forward rate");
  assert.equal(C.usdPerUnit("wcop", rate), null, "not quoting and no reverse rate: no estimate");
  assert.equal(C.usdPerUnit("cngn", { reverseRate: 0.0007 }).usdPer, 0.0007, "the older naira field");
  const v = C.payUsdValue("idrx", 18_407_000, rate); // Rp 184,070
  assert.ok(Math.abs(v.usd - 9.958) < 0.001);
  const fmt = (u) => `Rp ${Math.floor(u / 0.0000541)}`;
  assert.equal(C.localPayError(v, 24.25, fmt), null);
  assert.match(C.localPayError(C.payUsdValue("idrx", 50_000_000, rate), 24.25, fmt), /worth about \$27\.05\. Send up to about Rp 448243/);
  assert.match(C.localPayError(C.payUsdValue("idrx", 1_500_000, rate), 24.25, fmt), /less than \$1/);
  assert.match(C.localPayError({ usd: 1.02, approx: true }, 24.25, fmt), /less than \$1/, "an approximate value keeps a 5% margin");
  assert.equal(C.localPayError({ usd: 1.02, approx: false }, 24.25, fmt), null);
  assert.equal(C.localPayError(null, 24.25, fmt), null);
  for (const t of C.payWithTokens("usdt", "tag")) {
    assert.deepEqual(C.payoutRoute(t.address, null, "tag", "usdt"), t.code === "usdt" ? { mode: "forward", receive: "usdt" } : { mode: "swap", corridor: `${t.code}-usdt`, receive: "usdt" });
  }
  assert.deepEqual(C.payoutRoute(USDT, null, "tag"), { mode: "swap", corridor: "usdt-cngn", receive: "cngn" });
});
