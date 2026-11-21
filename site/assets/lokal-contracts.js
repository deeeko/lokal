// LokalTags and LokalPots, for the site (and the `lokal` CLI, which imports the same plain-English refusals):
// addresses, calldata builders, reads over RPC, the USD₮ permit, revert decoding and what a payment pays out in.
// No DOM access at the top level, so everything here is unit-tested in Node (test/contracts-site.test.mjs) and
// checked against the real contracts on Hardhat (contracts/tests/SiteCalldata.spec.ts).
//
// Every transaction a page builds here gets this app's ERC-8021 attribution suffix appended to its calldata, exactly
// like the older memo transactions: Solidity ignores bytes after the ABI-encoded arguments (the contract tests prove it).
// Selectors are written out (computed with viem from contracts/deployments/*.json; the test recomputes every one).
import {
  AGENT, RPC, TOKENS, CURRENCIES, USDT_ADDRESS, DEFAULT_CURRENCY, abiEncode, abiDecode, getJson, tagSuffix, currencyOf,
  unitsToDecimal, formatCurrencyUnits,
} from "./core.js";

export const LOKAL_TAGS = "0xFF2f8ADC0c97B6E40b201848d378C11325bC7187";
export const LOKAL_POTS = "0x60F76b5d1dc6a9B1e208fB93f6C0B05De51a7DAF";
export const LOKAL_TAGS_BLOCK = 83385019;
export const LOKAL_POTS_BLOCK = 83385026;
/** Where every contract payment goes. Pinned in each payment (`expectedPayout`), so a changed payout wallet reverts. */
export const PAYOUT_WALLET = AGENT;
/**
 * The cutover from the memo protocol (NT1: claims, NTP: payments) to the contracts. Legacy claims, renames and releases
 * in this block or later are ignored; legacy payments keep being paid, and from this block on a tag that is also held
 * on LokalTags pays its contract owner. Same number as LEGACY_CUTOVER_BLOCK in src/config.mjs.
 */
export { LEGACY_CUTOVER_BLOCK } from "./core.js";

/** Function selectors (keccak of the signature, first 4 bytes). */
export const FN = {
  claim: "0xcb6ab5d8", // claim(string,string)
  setName: "0xc47f0027", // setName(string)
  setReceiveToken: "0xfb88c6eb", // setReceiveToken(address)
  release: "0x86d1a69f", // release()
  payTag: "0x9d5ef760", // payTag(string,address,uint256,bytes32,address)
  payTagWithPermit: "0xe0a8e240", // payTagWithPermit(string,address,uint256,bytes32,address,uint256,uint8,bytes32,bytes32)
  tagInfo: "0x0defcd53", // tagInfo(string) -> (address,string,uint256,address,uint256,address)
  tagOf: "0x15f26c91", // tagOf(address) -> string
  availability: "0x09a01725", // availability(string,address) -> uint8
  remainingToday: "0x1e52a7e8", // remainingToday(address,address,address) -> (uint256,uint256,uint256)
  tokenLimits: "0x417a0698", // tokenLimits(address) -> (uint128 x5)
  validatePayment: "0x14724bf0", // validatePayment(string,address,uint256,address) -> (address,uint256)
  payoutWallet: "0x8488bb4e", // payoutWallet() -> address
  paused: "0x5c975abb", // paused() -> bool
  receiveTokenOf: "0x19cd729b", // receiveTokenOf(address) -> address
  // LokalPots
  payPot: "0xe64b323d", // payPot(uint256,address,uint256,bytes32,address)
  potInfo: "0x3f6833be", // potInfo(uint256) -> (address,string,uint256,bool,uint256,uint256,uint256,uint256)
  usdValue: "0xef610d8d", // usdValue(address,uint256) -> uint256
  createPot: "0xd7d3b938", // createPot(string,uint64,uint256,uint256) -> uint256
  closePot: "0x69254a0b", // closePot(uint256)
  potCount: "0xcf72f230", // potCount() -> uint256
  remaining: "0xbc8dbd9f", // remaining(uint256,address) -> (uint256,uint256,uint256,uint256)
  paidBy: "0xa75561bb", // paidBy(uint256,address) -> uint256
  validatePotPayment: "0x765b5cb3", // validatePotPayment(uint256,address,uint256,address) -> uint256
  unitsPerUsd: "0x350fed97", // unitsPerUsd(address) -> uint256
  maxPotCapUsd6: "0x3f754c35", // maxPotCapUsd6() -> uint64
  maxPerPayerCapUsd6: "0xc50b0257", // maxPerPayerCapUsd6() -> uint64
  maxPerHostDailyUsd6: "0x837a2632", // maxPerHostDailyUsd6() -> uint64
  maxDailyUsd6: "0x09b185f5", // maxDailyUsd6() -> uint64
  // ERC-20 / EIP-2612
  approve: "0x095ea7b3", // approve(address,uint256)
  allowance: "0xdd62ed3e", // allowance(address,address) -> uint256
  balanceOf: "0x70a08231", // balanceOf(address) -> uint256
  nonces: "0x7ecebe00", // nonces(address) -> uint256
  DOMAIN_SEPARATOR: "0x3644e515", // DOMAIN_SEPARATOR() -> bytes32
};
/** Event topics. */
export const TOPIC = {
  TagPaid: "0x57b50e2be06fdec5b22f282242d835deab044aa55598a4de94be1529eb2282c3",
  PotPaid: "0xe6b3aacdc629ba3f805853881b3370c2c489f7ab58b24a69060156672797d169",
  TagClaimed: "0xa18f42c7ad94b182292b8f65d73bb99d36d9cac8bedaa606d1c8a680ae5a891e",
  PotCreated: "0x76b849f6a4d8c6927d1edf825a1fd7c70cb411a0a741979e2ebf9dcf57918f7e",
  PotClosed: "0x37546cf716a0cade9e7d470fd119123e1b55b07faebab008b0ad40a2840d1ca0",
};
/** LokalPots constants MAX_OPEN_TIME and MAX_TITLE_BYTES (contracts/tests/SiteCalldata.spec.ts checks they match). */
export const POT_MAX_OPEN_SECONDS = 14 * 86_400;
export const POT_TITLE_MAX_BYTES = 60;

/** USD₮ on Celo implements EIP-2612 with this domain (DOMAIN_SEPARATOR checked live before signing). */
export const USDT_PERMIT_DOMAIN = { name: "Tether USD", version: "1", chainId: 42220, verifyingContract: USDT_ADDRESS };
export const USDT_DOMAIN_SEPARATOR = "0xbcb4d62e4834b598d0eacecd84c0b397a0254e077c41cf2143e394d5701d1088";
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
export const ZERO_REF = "0x" + "0".repeat(64);

const lc = (s) => String(s ?? "").toLowerCase();
const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a ?? ""));
const withSuffix = (selector, types, values) => selector + abiEncode(types, values) + tagSuffix();

// ---------- calldata (each with the attribution suffix) ----------
/** claim(tag, name): claims `tag` for the sender ("" for no display name). */
export const claimData = (tag, name = "") => withSuffix(FN.claim, ["string", "string"], [String(tag), String(name ?? "")]);
/** setName(name): changes (or with "" clears) the display name on the sender's tag. */
export const setNameData = (name) => withSuffix(FN.setName, ["string"], [String(name ?? "")]);
/** setReceiveToken(token): the token the sender wants to be paid out in, or the zero address for no preference. */
export function setReceiveTokenData(token) {
  if (token != null && token !== ZERO_ADDRESS && !isAddr(token)) throw new Error("invalid token address");
  return withSuffix(FN.setReceiveToken, ["address"], [token ?? ZERO_ADDRESS]);
}
/** release(): gives up the sender's tag (locked for others for 30 days). */
export const releaseData = () => FN.release + tagSuffix();
const amountOk = (v) => { const b = BigInt(v); if (b <= 0n || b >= 1n << 256n) throw new Error("invalid amount"); return b; };
/** payTag(tag, token, amount, ref, expectedPayout). The payer must have approved LokalTags for `amount` first. */
export function payTagData({ tag, token, amount, ref = ZERO_REF, expectedPayout = PAYOUT_WALLET }) {
  // ref: currencyRef(code) to choose what the recipient gets on this payment (see currencyRef)
  if (!isAddr(token)) throw new Error("invalid token address");
  return withSuffix(FN.payTag, ["string", "address", "uint256", "bytes32", "address"], [String(tag), token, amountOk(amount), ref, expectedPayout]);
}
/** payTagWithPermit(...): payTag with an EIP-2612 permit for exactly `amount` (one signature, one transaction). */
export function payTagWithPermitData({ tag, token, amount, ref = ZERO_REF, expectedPayout = PAYOUT_WALLET, deadline, v, r, s }) {
  if (!isAddr(token)) throw new Error("invalid token address");
  return withSuffix(FN.payTagWithPermit,
    ["string", "address", "uint256", "bytes32", "address", "uint256", "uint8", "bytes32", "bytes32"],
    [String(tag), token, amountOk(amount), ref, expectedPayout, BigInt(deadline), Number(v), r, s]);
}
/** payPot(potId, token, amount, ref, expectedPayout). */
export function payPotData({ potId, token, amount, ref = ZERO_REF, expectedPayout = PAYOUT_WALLET }) {
  // the payer approves LokalPots (not LokalTags) for exactly `amount` first: LokalPots has no permit variant
  if (!isAddr(token)) throw new Error("invalid token address");
  return withSuffix(FN.payPot, ["uint256", "address", "uint256", "bytes32", "address"], [potIdOk(potId), token, amountOk(amount), ref, expectedPayout]);
}
function potIdOk(v) { const b = BigInt(v); if (b <= 0n || b >= 1n << 256n) throw new Error("invalid pot id"); return b; }
/**
 * createPot(title, closesAt, potCapUsd6, perPayerCapUsd6): opens a pot hosted by the sender, who must hold a tag.
 * Dollar amounts are usd6 (6 decimals); closesAt is unix seconds, at most 14 days away.
 */
export function createPotData({ title, closesAt, potCapUsd6, perPayerCapUsd6 }) {
  const t = String(title ?? "");
  if (!t) throw new Error("invalid title");
  const close = BigInt(closesAt);
  if (close <= 0n || close >= 1n << 64n) throw new Error("invalid closing time");
  return withSuffix(FN.createPot, ["string", "uint64", "uint256", "uint256"], [t, close, amountOk(potCapUsd6), amountOk(perPayerCapUsd6)]);
}
/** closePot(potId): stops a pot taking payments (host only). */
export const closePotData = (potId) => withSuffix(FN.closePot, ["uint256"], [potIdOk(potId)]);
/** approve(spender, amount) on a token: exactly the payment, never "unlimited". */
export function approveData(spender, amount) {
  if (!isAddr(spender)) throw new Error("invalid spender");
  return withSuffix(FN.approve, ["address", "uint256"], [spender, BigInt(amount)]);
}

// ---------- the USD₮ permit (EIP-2612) ----------
/** The eth_signTypedData_v4 payload for a permit of exactly `value` to `spender` (LokalTags). */
export function permitTypedData({ owner, spender = LOKAL_TAGS, value, nonce, deadline, domain = USDT_PERMIT_DOMAIN }) {
  return {
    types: {
      EIP712Domain: [
        { name: "name", type: "string" }, { name: "version", type: "string" },
        { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" },
      ],
      Permit: [
        { name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Permit",
    domain,
    message: { owner, spender, value: BigInt(value).toString(), nonce: BigInt(nonce).toString(), deadline: BigInt(deadline).toString() },
  };
}
/** A 65-byte signature (0x r s v) -> { v, r, s }. v 0/1 is normalised to 27/28. */
export function splitSignature(sig) {
  const h = String(sig ?? "").replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{130}$/.test(h)) throw new Error("unexpected signature length");
  let v = parseInt(h.slice(128, 130), 16);
  if (v < 27) v += 27;
  if (v !== 27 && v !== 28) throw new Error("unexpected signature v");
  return { r: "0x" + h.slice(0, 64), s: "0x" + h.slice(64, 128), v };
}

// ---------- what a payment pays out in ----------
/** "usdt" | a currency code ("cngn", "idrx", "wars", "wcop") | null for a token address. */
export function tokenCode(addr) {
  if (lc(addr) === lc(USDT_ADDRESS)) return "usdt";
  return CURRENCIES.find((c) => lc(c.address) === lc(addr))?.code ?? null;
}
/** The token address for "usdt" or a currency code, or null. */
export const tokenOfCode = (code) => (code === "usdt" ? USDT_ADDRESS : currencyOf(code)?.address ?? null);
/**
 * The payer's currency choice, carried in payTag's / payPot's `bytes32 ref`: the ASCII text "cur:" + a code ("cngn",
 * "idrx", "wars", "wcop", or "usdt" for dollars), left-aligned and zero-padded to 32 bytes. For example rupiah is
 * 0x6375723a69647278 followed by 24 zero bytes. Any other ref is the payer's own opaque reference and names no currency.
 */
export const REF_CURRENCY_PREFIX = "cur:";
export const REF_CODES = ["usdt", ...CURRENCIES.map((c) => c.code)];
export function currencyRef(code) {
  if (!REF_CODES.includes(code)) throw new Error("unknown currency");
  const hex = [...new TextEncoder().encode(REF_CURRENCY_PREFIX + code)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return "0x" + hex.padEnd(64, "0");
}
/** A ref -> the currency code it names ("idrx", "usdt", ...), or null (an opaque reference, or malformed). */
export function currencyOfRef(ref) {
  const h = lc(ref).replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(h)) return null;
  const bytes = h.match(/../g).map((b) => parseInt(b, 16));
  const end = bytes.indexOf(0) === -1 ? 32 : bytes.indexOf(0);
  if (bytes.slice(end).some((b) => b !== 0)) return null;
  const text = String.fromCharCode(...bytes.slice(0, end));
  if (!text.startsWith(REF_CURRENCY_PREFIX)) return null;
  const code = text.slice(REF_CURRENCY_PREFIX.length);
  return REF_CODES.includes(code) ? code : null;
}
/**
 * What the agent pays out for a contract payment (same rule as routeFor in src/contract-watch.mjs; a test checks they
 * agree for every case). The PAYER's choice for this payment (`chosen`, from the ref) wins; then the recipient's
 * optional default (their receive token on LokalTags); then: a tag pays USD₮ payments in naira (the default since the
 * memo days) and cNGN payments in dollars; a pot pays dollars. A payment already in the token they get is passed
 * straight through. Returns { mode: "swap", corridor, receive } | { mode: "forward", receive } | null (the agent would
 * refuse it, so pages never offer it). `receive` = "usdt" or a currency code.
 */
export function payoutRoute(paidToken, receiveToken, kind = "tag", chosen = null) {
  const paid = tokenCode(paidToken);
  if (!paid) return null;
  if (chosen != null && !REF_CODES.includes(chosen)) return null;
  const set = receiveToken && lc(receiveToken) !== lc(ZERO_ADDRESS) ? tokenCode(receiveToken) : null;
  if (chosen == null && receiveToken && lc(receiveToken) !== lc(ZERO_ADDRESS) && !set) return null;
  const want = chosen ?? set ?? (kind === "pot" ? "usdt" : paid === "usdt" ? DEFAULT_CURRENCY : paid === "cngn" ? "usdt" : paid);
  if (paid === want) return { mode: "forward", receive: want };
  if (paid === "usdt") return { mode: "swap", corridor: "usdt-" + want, receive: want };
  if (paid === "cngn" && want === "usdt") return { mode: "swap", corridor: "cngn-usdt", receive: "usdt" };
  return null;
}
/** The tokens a payer can pay a recipient with, given their receive token: [{ code, address }] (USD₮ first). */
export function payableTokens(receiveToken, kind = "tag") {
  const all = ["usdt", ...CURRENCIES.map((c) => c.code)];
  return all.map((code) => ({ code, address: tokenOfCode(code) })).filter((t) => payoutRoute(t.address, receiveToken, kind));
}

// ---------- decoding ----------
const TAG_INFO_OUT = ["address", "string", "uint256", "address", "uint256", "address"];
/** tagInfo() return data -> { owner (null if none), name, since (sec), lockedFor, lockedUntil (sec), receiveToken (null if none), receive }. */
export function decodeTagInfo(hex) {
  const [owner, name, since, lockedFor, lockedUntil, receiveToken] = abiDecode(TAG_INFO_OUT, hex);
  const none = (a) => (lc(a) === lc(ZERO_ADDRESS) ? null : a);
  const rt = none(receiveToken);
  return {
    owner: none(owner), name, since: Number(since), lockedFor: none(lockedFor), lockedUntil: Number(lockedUntil),
    receiveToken: rt, receive: rt ? tokenCode(rt) : null,
  };
}
const AVAIL = ["free", "yours", "taken", "reserved", "locked", "invalid"];
/** availability() enum -> the site's words ("free", "yours", "taken", "reserved", "locked", "invalid"). */
export const availabilityName = (n) => AVAIL[Number(n)] ?? "invalid";
/** A TagPaid log ({ topics, data, transactionHash, logIndex, blockNumber }) -> the payment, or null. */
export function decodeTagPaid(log) {
  if (lc(log?.topics?.[0]) !== TOPIC.TagPaid || (log.topics?.length ?? 0) < 4) return null;
  const [tag, token, amount, ref, dayIndex] = abiDecode(["string", "address", "uint256", "bytes32", "uint256"], log.data);
  return {
    kind: "tag", tag, tagHash: log.topics[1], recipient: "0x" + log.topics[2].slice(26), payer: "0x" + log.topics[3].slice(26),
    token, amount, ref, dayIndex: Number(dayIndex), hash: log.transactionHash ?? log.transaction_hash,
    logIndex: Number(log.logIndex ?? log.index ?? 0), block: Number(log.blockNumber ?? log.block_number ?? 0),
  };
}
/** A PotPaid log -> the payment, or null. */
export function decodePotPaid(log) {
  if (lc(log?.topics?.[0]) !== TOPIC.PotPaid || (log.topics?.length ?? 0) < 4) return null;
  const [token, amount, ref, totalSoFar, amountUsd6] = abiDecode(["address", "uint256", "bytes32", "uint256", "uint256"], log.data);
  return {
    kind: "pot", potId: BigInt(log.topics[1]), recipient: "0x" + log.topics[2].slice(26), payer: "0x" + log.topics[3].slice(26),
    token, amount, ref, totalSoFar, amountUsd6, hash: log.transactionHash ?? log.transaction_hash,
    logIndex: Number(log.logIndex ?? log.index ?? 0), block: Number(log.blockNumber ?? log.block_number ?? 0),
  };
}

const POT_INFO_OUT = ["address", "string", "uint256", "bool", "uint256", "uint256", "uint256", "uint256"];
/** potInfo() return data -> { host, title, closesAt (sec), open, capUsd6, perPayerCapUsd6, totalUsd6, payerCount }. */
export function decodePotInfo(hex) {
  const [host, title, closesAt, open, capUsd6, perPayerCapUsd6, totalUsd6, payerCount] = abiDecode(POT_INFO_OUT, hex);
  return { host, title, closesAt: Number(closesAt), open, capUsd6, perPayerCapUsd6, totalUsd6, payerCount: Number(payerCount) };
}
/** A PotCreated log -> { potId, host, title, closesAt, capUsd6, perPayerCapUsd6, hash, block }, or null. */
export function decodePotCreated(log) {
  if (lc(log?.topics?.[0]) !== TOPIC.PotCreated || (log.topics?.length ?? 0) < 3) return null;
  const [title, closesAt, capUsd6, perPayerCapUsd6] = abiDecode(["string", "uint256", "uint256", "uint256"], log.data);
  return {
    potId: BigInt(log.topics[1]), host: "0x" + log.topics[2].slice(26), title, closesAt: Number(closesAt), capUsd6, perPayerCapUsd6,
    hash: log.transactionHash ?? log.transaction_hash, block: Number(log.blockNumber ?? log.block_number ?? 0),
  };
}

/** A transaction's input -> { fn, tag, token, amount } when it is payTag / payTagWithPermit (suffix ignored), else null. */
export function decodePayTagCall(input) {
  const h = lc(input);
  const fn = h.startsWith(FN.payTag) ? "payTag" : h.startsWith(FN.payTagWithPermit) ? "payTagWithPermit" : null;
  if (!fn) return null;
  try {
    const [tag, token, amount] = abiDecode(["string", "address", "uint256"], "0x" + h.slice(10));
    return { fn, tag, token, amount };
  } catch { return null; }
}

// ---------- reverts in plain English ----------
/** selector -> [name, argument types]. LokalTags, LokalPots, OpenZeppelin ERC-20 / SafeERC20, Error(string), Panic. */
export const ERRORS = {
  "0x3e817dc8": ["AlreadyYours", []], "0xbd49034f": ["BelowMinimum", ["uint256", "uint256"]], "0x430f13b3": ["InvalidName", []],
  "0x3a165267": ["InvalidTag", []], "0x2e27dd35": ["NoTag", []], "0x53c4a74c": ["OverDailyLimit", ["uint256", "uint256"]],
  "0xa2adf4c1": ["OverPayerDailyLimit", ["uint256", "uint256"]], "0x7efda813": ["OverPaymentLimit", ["uint256", "uint256"]],
  "0x98b9664a": ["OverRecipientDailyLimit", ["uint256", "uint256"]], "0x9e87fac8": ["Paused", []],
  "0x30d28bd9": ["PayoutWalletChanged", ["address"]], "0xc6cfe835": ["RecipientIsContract", ["address"]],
  "0xc623f9c5": ["RecipientIsPayoutWallet", []], "0x82987a24": ["SelfPayment", []], "0x718b7250": ["TagLocked", ["uint256"]],
  "0x62d24d7c": ["TagNotFound", []], "0x154bacee": ["TagReserved", []], "0x7c1b5a4c": ["TagTaken", ["address"]],
  "0x94403b70": ["TokenNotAllowed", ["address"]], "0xb6a9b654": ["TransferAmountMismatch", ["uint256", "uint256"]],
  "0x5274afe7": ["SafeERC20FailedOperation", ["address"]],
  // LokalPots
  "0xa11f2e88": ["HostNotEligible", ["address"]], "0x8c5f16db": ["PotExpired", ["uint256", "uint256"]],
  "0x8cf3a8eb": ["PotFull", ["uint256", "uint256"]], "0x6885efe1": ["PotIsClosed", ["uint256"]], "0x30e4a782": ["PotNotFound", ["uint256"]],
  "0xd28809c3": ["OverPayerCap", ["uint256", "uint256"]], "0xd99ccc4b": ["OverHostDailyLimit", ["uint256", "uint256"]],
  "0x8ff4f0c9": ["NotHost", []], "0x31196de8": ["InvalidTitle", []], "0x56a026a3": ["InvalidCloseTime", ["uint256", "uint256"]],
  "0x8baee5ba": ["InvalidPotCaps", []],
  // OpenZeppelin v5 ERC-20 (a token without enough balance or allowance)
  "0xe450d38c": ["ERC20InsufficientBalance", ["address", "uint256", "uint256"]],
  "0xfb8f41b2": ["ERC20InsufficientAllowance", ["address", "uint256", "uint256"]],
  "0x08c379a0": ["Error", ["string"]], "0x4e487b71": ["Panic", ["uint256"]],
};
/** Revert data ("0x" + selector + arguments) -> { name, args } or null when it isn't a known error. */
export function decodeRevert(data) {
  const h = lc(data);
  if (!/^0x[0-9a-f]{8}/.test(h)) return null;
  const e = ERRORS[h.slice(0, 10)];
  if (!e) return null;
  try { return { name: e[0], args: e[1].length ? abiDecode(e[1], "0x" + h.slice(10)) : [] }; } catch { return { name: e[0], args: [] }; }
}
const symOf = (token) => (lc(token) === lc(USDT_ADDRESS) ? "USD₮" : CURRENCIES.find((c) => lc(c.address) === lc(token))?.token ?? "tokens");
/** Base units of `token` as "$12.50" (USD₮), "₦14,400.00" / "Rp 92,035" (local), or a plain number. */
export function tokenAmountText(units, token) {
  const code = tokenCode(token);
  if (code === "usdt") return "$" + Number(unitsToDecimal(units, 6, 2)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (code) return formatCurrencyUnits(units, code);
  return String(units);
}
const usd6Text = (u) => "$" + Number(unitsToDecimal(u, 6, 2)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dateText = (sec) => new Date(Number(sec) * 1000).toUTCString().replace(/:\d\d GMT$/, " UTC");
/**
 * A revert in plain English, for the payer or the tag owner, BEFORE anything is sent. ctx = { tag, token, potId }.
 * Returns { name, args, message } (message is always set; unknown reverts get a generic sentence).
 */
export function explainRevert(data, ctx = {}) {
  const d = decodeRevert(data);
  const tag = ctx.tag ? "@" + ctx.tag : "this tag";
  const amt = (u) => tokenAmountText(u, ctx.token);
  const sym = symOf(ctx.token);
  const say = (message) => ({ name: d?.name ?? null, args: d?.args ?? [], message });
  if (!d) return say("The contract refused this transaction. Nothing was sent.");
  const [a, b] = d.args;
  switch (d.name) {
    case "TagNotFound": return say(`${tag} isn't claimed on the Lokal contract, so there's nobody to pay. Nothing was sent.`);
    case "OverPaymentLimit": return say(`That's more than the ${amt(b)} limit for one payment in ${sym}. Send less. Nothing was sent.`);
    case "BelowMinimum": return say(`The smallest payment in ${sym} is ${amt(b)}. Send a little more. Nothing was sent.`);
    case "OverRecipientDailyLimit": return say(b > 0n
      ? `${tag} can receive only ${amt(b)} more in ${sym} today (the contract's daily limit per person). Send less, or try again tomorrow (UTC). Nothing was sent.`
      : `${tag} has reached today's limit in ${sym} (the contract's daily limit per person). Try again tomorrow (UTC). Nothing was sent.`);
    case "OverPayerDailyLimit": return say(b > 0n
      ? `You can pay only ${amt(b)} more in ${sym} today (the contract's daily limit per payer). Send less, or try again tomorrow (UTC). Nothing was sent.`
      : `You've reached today's limit for paying in ${sym} (the contract's daily limit per payer). Try again tomorrow (UTC). Nothing was sent.`);
    case "OverDailyLimit":
      if (ctx.potId != null) return say(`All pots together have reached today's total (${usd6Text(b)} left). Try again tomorrow (UTC). Nothing was sent.`);
      return say(b > 0n
        ? `Lokal can take only ${amt(b)} more in ${sym} today across everyone. Send less, or try again tomorrow (UTC). Nothing was sent.`
        : `Lokal has reached today's total for ${sym} across everyone. Try again tomorrow (UTC). Nothing was sent.`);
    case "SelfPayment": return say(ctx.potId != null ? "You host this pot, so you can't pay into it. Nothing was sent." : `This wallet holds ${tag}. You can't pay your own tag. Nothing was sent.`);
    case "Paused": return say("Lokal has paused payments and tag changes for now. Nothing was sent; try again later.");
    case "TokenNotAllowed": return say(`${symOf(a)} isn't accepted for this payment. Nothing was sent.`);
    case "RecipientIsContract": return say(`${tag} belongs to a smart contract, which Lokal can't pay. Nothing was sent.`);
    case "RecipientIsPayoutWallet": return say("That's the agent's own payout wallet, which can't hold a tag or be paid. Nothing was sent.");
    case "PayoutWalletChanged": return say("The agent's payout wallet changed since this page loaded. Reload the page before paying. Nothing was sent.");
    case "TransferAmountMismatch": return say(`${sym} didn't arrive in full, so the payment was stopped. Nothing was sent.`);
    case "SafeERC20FailedOperation":
    case "ERC20InsufficientBalance":
    case "ERC20InsufficientAllowance": return say(`The ${sym} transfer would fail: check that this wallet holds enough ${sym}${d.name === "ERC20InsufficientBalance" ? "" : " and approved this exact amount"}. Nothing was sent.`);
    case "InvalidTag": return say("That isn't a valid tag: 3-20 characters, a-z, 0-9 and _, starting with a letter, no \"__\" and not ending with \"_\".");
    case "InvalidName": return say("That display name isn't allowed: up to 40 characters, no control or invisible characters, and no spaces at either end.");
    case "TagReserved": return say(`${tag} is reserved, so nobody can claim it.`);
    case "TagTaken": return say(`${tag} is taken by ${a.slice(0, 6)}…${a.slice(-4)}. Pick another.`);
    case "AlreadyYours": return say(`${tag} is already yours. Change the display name instead.`);
    case "TagLocked": return say(`${tag} was released recently and is on hold until ${dateText(a)}.`);
    case "NoTag": return say("This wallet doesn't hold a tag on the contract yet. Claim one first.");
    case "PotNotFound": return say("There's no pot with that number. Nothing was sent.");
    case "PotIsClosed": return say("The host closed this pot. Nothing was sent.");
    case "PotExpired": return say(`This pot closed at ${dateText(b)}. Nothing was sent.`);
    case "PotFull": return say(`This pot is nearly full: it can take ${usd6Text(b)} more. Send less. Nothing was sent.`);
    case "OverPayerCap": return say(`You can put ${usd6Text(b)} more into this pot. Send less. Nothing was sent.`);
    case "OverHostDailyLimit": return say(`The host's pots can take ${usd6Text(b)} more today. Send less, or try again tomorrow (UTC). Nothing was sent.`);
    case "HostNotEligible": return say(ctx.creating
      ? "Only a wallet that holds a Lokal tag can open a pot. Claim your tag first. Nothing was sent."
      : "The pot's host can't be paid right now (they no longer hold a tag). Nothing was sent.");
    case "NotHost": return say("Only the pot's host can do that.");
    case "InvalidTitle": return say("That title isn't allowed: 1-60 characters (an emoji counts as two), no control or invisible characters, and no spaces at either end. Nothing was sent.");
    case "InvalidCloseTime": return say(`The closing time must be in the future and no later than ${dateText(b)}. Pick it again. Nothing was sent.`);
    case "InvalidPotCaps": return say("The caps don't fit: the per-guest cap must be more than $0 and no more than the pot's cap, and both within the contract's maximums. Nothing was sent.");
    case "Error": return say(/exceeds balance|insufficient balance/i.test(a) ? `This wallet doesn't hold enough ${sym}. Nothing was sent.`
      : /allowance/i.test(a) ? `The ${sym} approval doesn't cover this amount. Nothing was sent.` : `The transaction would fail (${a}). Nothing was sent.`);
    default: return say(`The contract refused this transaction (${d.name}). Nothing was sent.`);
  }
}
/** Revert data from an RPC / wallet error object, wherever the provider put it, or null. */
export function revertDataOf(err) {
  const seen = new Set();
  const walk = (e, depth = 0) => {
    if (!e || typeof e !== "object" || seen.has(e) || depth > 6) return null;
    seen.add(e);
    for (const v of [e.data, e.error?.data, e.data?.data, e.originalError?.data, e.info?.error?.data]) {
      if (typeof v === "string" && /^0x[0-9a-fA-F]{8}/.test(v)) return v;
    }
    if (typeof e.message === "string") {
      const m = e.message.match(/0x[0-9a-fA-F]{8,}/);
      if (m && ERRORS[lc(m[0]).slice(0, 10)]) return m[0];
    }
    return walk(e.cause, depth + 1) ?? walk(e.error, depth + 1) ?? walk(e.data, depth + 1);
  };
  return walk(err);
}

// ---------- RPC ----------
/**
 * eth_call that keeps the revert data: resolves { ok: true, result } or { ok: false, revert (hex or null), message }.
 * Network failures throw. `call` = { to, data, from? }; `block` defaults to "latest".
 */
export async function ethCall(call, block = "latest", { rpcUrl = RPC, fetchJson = getJson } = {}) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [call, block] });
  const j = await fetchJson(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body, cache: "no-store" });
  if (j?.error) return { ok: false, revert: revertDataOf(j.error), message: String(j.error.message ?? "reverted") };
  return { ok: true, result: j?.result ?? "0x" };
}
/** eth_call that must succeed: returns the result hex, or throws an Error carrying `.revert` (hex or null). */
async function mustCall(call, opts) {
  const r = await ethCall(call, "latest", opts);
  if (!r.ok) throw Object.assign(new Error(r.message), { revert: r.revert });
  return r.result;
}
const enc = (sel, types, vals) => sel + abiEncode(types, vals);
/** Everything a tag page needs, straight from LokalTags (see decodeTagInfo). */
export async function readTagInfo(tag, opts) {
  return decodeTagInfo(await mustCall({ to: LOKAL_TAGS, data: enc(FN.tagInfo, ["string"], [tag]) }, opts));
}
/** The tag `address` holds on LokalTags, or null. */
export async function readTagOf(address, opts) {
  const [t] = abiDecode(["string"], await mustCall({ to: LOKAL_TAGS, data: enc(FN.tagOf, ["address"], [address]) }, opts));
  return t || null;
}
/** What `claimer` gets by claiming `tag` now: "free" | "yours" | "taken" | "reserved" | "locked" | "invalid". */
export async function readAvailability(tag, claimer, opts) {
  const [n] = abiDecode(["uint8"], await mustCall({ to: LOKAL_TAGS, data: enc(FN.availability, ["string", "address"], [tag, claimer ?? ZERO_ADDRESS]) }, opts));
  return availabilityName(n);
}
/** The contract's limits for `token` (base units): { min, max, perRecipientDay, perPayerDay, perDay } (all 0n = not allowed). */
export async function readTokenLimits(token, opts) {
  const [min, max, perRecipientDay, perPayerDay, perDay] = abiDecode(["uint128", "uint128", "uint128", "uint128", "uint128"],
    await mustCall({ to: LOKAL_TAGS, data: enc(FN.tokenLimits, ["address"], [token]) }, opts));
  return { min, max, perRecipientDay, perPayerDay, perDay };
}
/** Room today in `token`: { forRecipient, forPayer, overall } (base units). */
export async function readRemainingToday(token, recipient, payer, opts) {
  const [forRecipient, forPayer, overall] = abiDecode(["uint256", "uint256", "uint256"],
    await mustCall({ to: LOKAL_TAGS, data: enc(FN.remainingToday, ["address", "address", "address"], [token, recipient, payer ?? ZERO_ADDRESS]) }, opts));
  return { forRecipient, forPayer, overall };
}
/**
 * The most one payment can be right now: min(max per payment, the three rooms), plus the minimum.
 * { min, max, room, limits, remaining } in base units of `token`.
 */
export async function readPaymentRoom(token, recipient, payer, opts) {
  const [limits, remaining] = await Promise.all([readTokenLimits(token, opts), readRemainingToday(token, recipient, payer, opts)]);
  const lo = (...xs) => xs.reduce((m, x) => (x < m ? x : m));
  return { min: limits.min, max: limits.max, room: lo(limits.max, remaining.forRecipient, remaining.forPayer, remaining.overall), limits, remaining };
}
/**
 * The contract's dry run of a payment (every rule except balance and allowance). Resolves { ok: true, recipient } or
 * { ok: false, name, message } with the refusal in plain English.
 */
export async function checkPayment({ tag, token, amount, payer }, opts) {
  const r = await ethCall({ to: LOKAL_TAGS, data: enc(FN.validatePayment, ["string", "address", "uint256", "address"], [tag, token, BigInt(amount), payer]) }, "latest", opts);
  if (r.ok) return { ok: true, recipient: abiDecode(["address", "uint256"], r.result)[0] };
  return { ok: false, ...explainRevert(r.revert, { tag, token }) };
}
/** Simulates a transaction from `from` exactly as it would be sent: { ok: true } or { ok: false, name, message }. */
export async function simulate({ from, to, data, value = "0x0" }, ctx = {}, opts) {
  const r = await ethCall({ from, to, data, value }, "latest", opts);
  return r.ok ? { ok: true, result: r.result } : { ok: false, ...explainRevert(r.revert, ctx) };
}
/** The payout wallet the contract pays into now. */
export async function readPayoutWallet(opts) {
  return abiDecode(["address"], await mustCall({ to: LOKAL_TAGS, data: FN.payoutWallet }, opts))[0];
}
export async function readPaused(opts) {
  return abiDecode(["bool"], await mustCall({ to: LOKAL_TAGS, data: FN.paused }, opts))[0];
}
/** ERC-20 helpers. */
export async function readAllowance(token, owner, spender, opts) {
  return abiDecode(["uint256"], await mustCall({ to: token, data: enc(FN.allowance, ["address", "address"], [owner, spender]) }, opts))[0];
}
export async function readNonce(token, owner, opts) {
  return abiDecode(["uint256"], await mustCall({ to: token, data: enc(FN.nonces, ["address"], [owner]) }, opts))[0];
}
/** True when the token's live DOMAIN_SEPARATOR is the one this file signs for (USD₮ only). */
export async function permitDomainOk(token = USDT_ADDRESS, opts) {
  if (lc(token) !== lc(USDT_ADDRESS)) return false;
  try { return lc(abiDecode(["bytes32"], await mustCall({ to: token, data: FN.DOMAIN_SEPARATOR }, opts))[0]) === USDT_DOMAIN_SEPARATOR; } catch { return false; }
}
/** TOKENS entry for a token address (symbol + decimals), or null. */
export const tokenInfo = (addr) => Object.values(TOKENS).find((t) => lc(t.address) === lc(addr)) ?? null;

// ---------- LokalPots reads ----------
/** Everything a pot page needs (see decodePotInfo). An unknown id throws with `.revert` (PotNotFound). */
export async function readPotInfo(potId, opts) {
  return decodePotInfo(await mustCall({ to: LOKAL_POTS, data: enc(FN.potInfo, ["uint256"], [BigInt(potId)]) }, opts));
}
/** Number of pots created (ids run from 1 to potCount). */
export async function readPotCount(opts) {
  return abiDecode(["uint256"], await mustCall({ to: LOKAL_POTS, data: FN.potCount }, opts))[0];
}
/** The maxima a host may choose and the daily totals, read from the contract (usd6). */
export async function readPotLimits(opts) {
  const one = async (sel) => abiDecode(["uint64"], await mustCall({ to: LOKAL_POTS, data: sel }, opts))[0];
  const [maxPotCapUsd6, maxPerPayerCapUsd6, maxPerHostDailyUsd6, maxDailyUsd6] = await Promise.all(
    [FN.maxPotCapUsd6, FN.maxPerPayerCapUsd6, FN.maxPerHostDailyUsd6, FN.maxDailyUsd6].map(one));
  return { maxPotCapUsd6, maxPerPayerCapUsd6, maxPerHostDailyUsd6, maxDailyUsd6 };
}
/** Room left (usd6) for `payer` in pot `potId`: { forPayer, forPot, forHost, forToday }. */
export async function readPotRemaining(potId, payer, opts) {
  const [forPayer, forPot, forHost, forToday] = abiDecode(["uint256", "uint256", "uint256", "uint256"],
    await mustCall({ to: LOKAL_POTS, data: enc(FN.remaining, ["uint256", "address"], [BigInt(potId), payer ?? ZERO_ADDRESS]) }, opts));
  return { forPayer, forPot, forHost, forToday };
}
/** Base units of `token` per US dollar on LokalPots (0n: pots don't take it). */
export async function readUnitsPerUsd(token, opts) {
  return abiDecode(["uint256"], await mustCall({ to: LOKAL_POTS, data: enc(FN.unitsPerUsd, ["address"], [token]) }, opts))[0];
}
/**
 * The contract's dry run of a pot payment (every rule except balance and allowance): { ok: true, amountUsd6 } or
 * { ok: false, name, message } in plain English.
 */
export async function checkPotPayment({ potId, token, amount, payer }, opts) {
  const data = enc(FN.validatePotPayment, ["uint256", "address", "uint256", "address"], [BigInt(potId), token, BigInt(amount), payer]);
  const r = await ethCall({ to: LOKAL_POTS, data }, "latest", opts);
  if (r.ok) return { ok: true, amountUsd6: abiDecode(["uint256"], r.result)[0] };
  return { ok: false, ...explainRevert(r.revert, { potId, token }) };
}
/** The usd6 value LokalPots gives `amount` of a token at `unitsPerUsd`, rounded UP, exactly like the contract's usdValue. */
export function potUsdValue(amount, unitsPerUsd) {
  const a = BigInt(amount), r = BigInt(unitsPerUsd);
  return r === 0n ? 0n : (a * 1_000_000n + r - 1n) / r;
}
/** A uint256 or an address as a 32-byte log topic (for eth_getLogs filters). */
export const topicOf = (v) => "0x" + (isAddr(v) ? lc(v).slice(2) : BigInt(v).toString(16)).padStart(64, "0");
