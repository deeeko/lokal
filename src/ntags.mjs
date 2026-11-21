// nTags: human handles (@ada) tied to a Celo wallet, claimed onchain from the owner's own wallet (site/account.html).
// A claim is a zero-value tx FROM the wallet TO the agent whose input is hex(utf8("NT1:" + JSON)) + attribution suffix,
// JSON {"t":"ada"} or {"t":"ada","n":"Ada Obi"}; {"t":""} releases the sender's tag. Paying a tag is an ordinary
// ERC-20 transfer to the agent with hex(utf8("NTP:" + tag)) appended after the standard 68 bytes. See site/_spec/NTAGS.md.
//
// Everything between the "ported" markers is a byte-identical copy of the nTags section of site/assets/core.js
// (test/ntags.test.mjs cross-checks them), so the site and the agent always agree on who owns a tag.
import fs from "node:fs";
import path from "node:path";
import { getAddress } from "viem";
import { AGENT_ADDRESS, ATTRIBUTION_CODE, EXPLORER_API, LEGACY_CUTOVER_BLOCK, NTAG_PAYMENTS_FILE } from "./config.mjs";
import { refusal } from "./guards.mjs";

const AGENT = AGENT_ADDRESS;
const MARKER = "80218021802180218021802180218021"; // ERC-8021 suffix marker
const utf8Hex = (s) => [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, "0")).join("");
const hexBytes = (h) => new Uint8Array((h.match(/../g) ?? []).map((b) => parseInt(b, 16)));
/** The ERC-8021 schema-0 suffix for this app's attribution code (same bytes as core.js tagSuffix()). */
export const tagSuffix = () => utf8Hex(ATTRIBUTION_CODE) + ATTRIBUTION_CODE.length.toString(16).padStart(2, "0") + "00" + MARKER;

// ---------- port: start ---------- (from site/assets/core.js; keep byte-for-byte identical)
export const NTAG_PREFIX = "NT1:";
export const NTAG_MEMO_PREFIX = "NTP:";
export const RELEASE_LOCK_DAYS = 30;
/** What a tag payment can ask to pay out in ("NTP:ada:idrx") and a tag owner can prefer ({"t":"ada","c":"idrx"}). None = naira.
 *  Written out (not CURRENCY_CODES) so this block stays self-contained; a test checks it equals the registry. */
export const NTAG_CURRENCIES = ["cngn", "idrx", "wars", "wcop"];
/** Tags nobody can claim. */
export const NTAG_RESERVED = new Set([
  "agent", "admin", "administrator", "root", "system", "support", "help", "official", "team", "staff", "mod", "moderator",
  "security", "celo", "minipay", "valora", "opera", "textile", "naira", "nairapayout", "payout", "payouts", "ntag", "ntags",
  "lokal", "lokalpay", "cngn", "usdt", "usdc", "tether", "cusd", "ceur", "wallet", "bank", "cbn", "null", "undefined",
  "anonymous", "everyone", "me", "you", "test", "demo", "api", "www", "app", "pay", "send", "receive",
  "lokal_support", "lokalsupport", "lokal_help", "lokal_team", "lokal_official", "lokalofficial", "support_team",
  "help_desk", "helpdesk", "admin1", "celo_team", "celoteam", "minipay_support", "textile_fx",
]);
const NTAG_RESERVED_ERR = "this tag is reserved";
const NTAG_LOCK_SEC = RELEASE_LOCK_DAYS * 86400;
/** UI/CLI input only: trim, strip one leading "@", lowercase. The onchain JSON must already be in this form. */
export const normalizeNtag = (s) => String(s ?? "").trim().replace(/^@/, "").toLowerCase();
/** Tag rules (3-20 chars, a-z 0-9 _, starts with a letter, no "__", no trailing "_", not reserved). Error string or null. */
export function ntagError(t) {
  if (typeof t !== "string" || !t) return "enter a tag";
  if (/[A-Z]/.test(t)) return "use lowercase letters only";
  if (!/^[a-z0-9_]+$/.test(t)) return "use only letters, numbers and _";
  if (!/^[a-z]/.test(t)) return "must start with a letter";
  if (t.length < 3) return "must be at least 3 characters";
  if (t.length > 20) return "must be 20 characters or fewer";
  if (t.includes("__")) return "can't contain __";
  if (t.endsWith("_")) return "can't end with _";
  if (NTAG_RESERVED.has(t)) return NTAG_RESERVED_ERR;
  return null;
}
/** Display name rules (optional; 1-40 characters after trimming, no control characters). Error string or null. */
export function ntagNameError(n) {
  if (typeof n !== "string") return "invalid name";
  const v = n.trim();
  if (!v) return "name can't be blank";
  if (v.length > 40) return "name must be 40 characters or fewer";
  if (/[\u0000-\u001f\u007f-\u009f]/.test(v)) return "name can't contain control characters";
  if (/[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/.test(v)) return "name can't contain invisible or text-direction characters";
  return null;
}
/** Validates a decoded nTag op body: claim/update {t[,n][,c]} (c = preferred currency) or release {t:""}. Error string or null. */
export function ntagOpError(op) {
  if (!op || typeof op !== "object" || Array.isArray(op)) return "not a Lokal tag op";
  const keys = Object.keys(op);
  if (keys.some((k) => k !== "t" && k !== "n" && k !== "c")) return "unexpected field";
  if (typeof op.t !== "string") return "invalid tag";
  if (op.t === "") return "n" in op ? "a release has no name" : "c" in op ? "a release has no currency" : null;
  const err = ntagError(op.t);
  if (err) return err;
  if ("c" in op && !NTAG_CURRENCIES.includes(op.c)) return "unknown currency";
  if ("n" in op) return ntagNameError(op.n);
  return null;
}
const stripErc8021 = (input) => {
  let h = String(input ?? "").toLowerCase().replace(/^0x/, "");
  if (h.endsWith(MARKER)) {
    const len = parseInt(h.slice(-MARKER.length - 4, -MARKER.length - 2), 16);
    h = h.slice(0, -(MARKER.length + 4 + len * 2));
  }
  return h;
};
/** Calldata for a claim (or update) tx: hex("NT1:" + JSON) + this app's attribution suffix. Throws on a bad tag, name or currency. */
export function encodeNtagClaim({ t, n, c } = {}) {
  const name = typeof n === "string" ? n.trim() : n;
  const body = name ? { t, n: name } : { t };
  if (c != null) body.c = c;
  const err = body.t === "" ? "enter a tag" : ntagOpError(body);
  if (err) throw new Error(err);
  return "0x" + utf8Hex(NTAG_PREFIX + JSON.stringify(body)) + tagSuffix();
}
/** Calldata for a release tx (gives up the sender's current tag). */
export const encodeNtagRelease = () => "0x" + utf8Hex(NTAG_PREFIX + JSON.stringify({ t: "" })) + tagSuffix();
/** Parse a tx input as an nTag op (any trailing ERC-8021 suffix stripped). Returns the parsed JSON (unvalidated) or null. */
export function decodeNtagOp(input) {
  const h = stripErc8021(input);
  if (!h.startsWith(utf8Hex(NTAG_PREFIX))) return null;
  try { return JSON.parse(new TextDecoder().decode(hexBytes(h.slice(utf8Hex(NTAG_PREFIX).length)))); } catch { return null; }
}
/** Blockscout transaction item -> op item { hash, from, block, position, time, value, op }, or null (same filter as registrations). */
export function ntagOpFromItem(t, agent) {
  if (t?.status !== "ok" || t.to?.hash?.toLowerCase() !== String(agent).toLowerCase()) return null;
  const op = decodeNtagOp(t.raw_input);
  if (op == null) return null;
  return { hash: t.hash, from: t.from?.hash, block: Number(t.block_number ?? t.block), position: Number(t.position ?? 0), time: Math.floor(Date.parse(t.timestamp) / 1000), value: t.value == null ? "0" : String(t.value), op };
}
const ntagZeroValue = (v) => {
  if (v == null) return true;
  try { return BigInt(String(v)) === 0n; } catch { return false; }
};
/**
 * Replays VALID ops with time <= atSec in (block, position) order. Returns { tags: Map<tag, {owner (lower-case), name,
 * since (sec), hash, block, position, currency? (the owner's preferred currency code, once set)}>, byOwner: Map<lower-case
 * address, tag>, locks: Map<tag, {owner, until (sec)}>,
 * statuses: Map<hash, "claimed"|"renamed"|"updated"|"released"|"taken"|"locked"|"reserved"|"invalid"|"noop"> }.
 */
export function resolveNtags(ops, atSec = Infinity) {
  const tags = new Map(), byOwner = new Map(), locks = new Map(), statuses = new Map();
  const list = (ops ?? []).filter((o) => o && Number(o.time) <= atSec)
    .sort((x, y) => Number(x.block) - Number(y.block) || Number(x.position) - Number(y.position));
  const release = (owner, time) => {
    const t = byOwner.get(owner);
    if (!t) return false;
    tags.delete(t);
    byOwner.delete(owner);
    locks.set(t, { owner, until: time + NTAG_LOCK_SEC });
    return true;
  };
  for (const o of list) {
    const from = String(o.from ?? "").toLowerCase();
    let err = ntagOpError(o.op);
    if (!err && !/^0x[0-9a-f]{40}$/.test(from)) err = "invalid sender";
    if (!err && from === AGENT.toLowerCase()) err = "agent";
    if (!err && !ntagZeroValue(o.value)) err = "non-zero value";
    if (err) { statuses.set(o.hash, err === NTAG_RESERVED_ERR ? "reserved" : "invalid"); continue; }
    const time = Number(o.time);
    const t = o.op.t;
    if (t === "") { statuses.set(o.hash, release(from, time) ? "released" : "noop"); continue; }
    const name = "n" in o.op ? o.op.n.trim() : null;
    const currency = "c" in o.op ? o.op.c : null;
    const cur = tags.get(t);
    if (cur && cur.owner === from) {
      const renamed = name != null && name !== cur.name;
      const recurrency = currency != null && currency !== (cur.currency ?? null);
      if (renamed) cur.name = name;
      if (recurrency) cur.currency = currency;
      statuses.set(o.hash, renamed ? "renamed" : recurrency ? "updated" : "noop");
      continue;
    }
    if (cur) { statuses.set(o.hash, "taken"); continue; }
    const lock = locks.get(t);
    if (lock && lock.until > time && lock.owner !== from) { statuses.set(o.hash, "locked"); continue; }
    release(from, time);
    locks.delete(t);
    tags.set(t, { owner: from, name, since: time, hash: o.hash, block: Number(o.block), position: Number(o.position), ...(currency ? { currency } : {}) });
    byOwner.set(from, t);
    statuses.set(o.hash, "claimed");
  }
  return { tags, byOwner, locks, statuses };
}
/** State from only the ops strictly before (block, position): what a deposit at that spot pays. */
export const resolveNtagsBefore = (ops, block, position) => resolveNtags((ops ?? []).filter((o) =>
  o && (Number(o.block) < Number(block) || (Number(o.block) === Number(block) && Number(o.position) < Number(position)))));
/** The tag an address currently holds, or null. */
export const ntagOf = (state, address) => state.byOwner.get(String(address ?? "").toLowerCase()) ?? null;
/** The current entry { owner, name, since, hash, block, position, currency? } for a tag, or null. */
export const ownerOf = (state, tag) => state.tags.get(tag) ?? null;
/** "invalid" | "reserved" | "yours" | "taken" | "locked" | "free" for `forAddress` claiming `tag` at nowSec. */
export function ntagAvailability(state, tag, forAddress, nowSec = Math.floor(Date.now() / 1000)) {
  const err = ntagError(tag);
  if (err) return err === NTAG_RESERVED_ERR ? "reserved" : "invalid";
  const me = String(forAddress ?? "").toLowerCase();
  const cur = state.tags.get(tag);
  if (cur) return me && cur.owner === me ? "yours" : "taken";
  const lock = state.locks.get(tag);
  if (lock && lock.until > nowSec && lock.owner !== me) return "locked";
  return "free";
}
/**
 * ERC-20 transfer(agent, units) calldata + hex("NTP:" + tag [+ ":" + currency]) memo + attribution suffix. Tokens ignore
 * the extra bytes. No currency (or "cngn") writes the original memo "NTP:<tag>", which pays out in naira.
 */
export function encodeNtagTransfer(agent, units, tag, currency) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(agent))) throw new Error("invalid agent address");
  const v = BigInt(units);
  if (v <= 0n || v >= 1n << 256n) throw new Error("invalid amount");
  const err = ntagError(tag);
  if (err) throw new Error(err);
  if (currency != null && !NTAG_CURRENCIES.includes(currency)) throw new Error("unknown currency");
  const code = currency != null && currency !== NTAG_CURRENCIES[0] ? ":" + currency : "";
  return "0xa9059cbb" + String(agent).toLowerCase().replace(/^0x/, "").padStart(64, "0") + v.toString(16).padStart(64, "0")
    + utf8Hex(NTAG_MEMO_PREFIX + tag + code) + tagSuffix();
}
/**
 * A transfer's Lokal tag memo (suffix stripped, selector a9059cbb, then exactly "NTP:" + a valid tag, optionally followed
 * by ":" + a currency code): { tag, currency } with currency null when the memo names none (= naira), or null.
 */
export function decodeNtagPayment(input) {
  const h = stripErc8021(input);
  if (!/^[0-9a-f]*$/.test(h) || h.length % 2 || !h.startsWith("a9059cbb") || h.length <= 136) return null;
  const memo = new TextDecoder().decode(hexBytes(h.slice(136)));
  if (!memo.startsWith(NTAG_MEMO_PREFIX)) return null;
  const [tag, currency, ...more] = memo.slice(NTAG_MEMO_PREFIX.length).split(":");
  if (more.length || ntagError(tag)) return null;
  if (currency !== undefined && !NTAG_CURRENCIES.includes(currency)) return null;
  return { tag, currency: currency ?? null };
}
/** The tag in a transfer's memo, or null (see decodeNtagPayment). */
export const decodeNtagMemo = (input) => decodeNtagPayment(input)?.tag ?? null;
// ---------- port: end ----------

// ---------- the cutover to LokalTags (not ported: the formats above are frozen) ----------

/**
 * The legacy ops that still count: those mined before LEGACY_CUTOVER_BLOCK. From that block on, tags are claimed,
 * renamed and released only on the LokalTags contract, so a later NT1: op changes nothing (the formats stay frozen).
 */
export const legacyNtagOps = (ops, cutover = LEGACY_CUTOVER_BLOCK) => (ops ?? []).filter((o) => o && BigInt(Number(o.block)) < BigInt(cutover));

// ---------- nTag attempts (not ported: the agent's own safety net) ----------

/** hex(utf8("NTP:")): the memo prefix as it appears in calldata. */
const MEMO_HEX = utf8Hex(NTAG_MEMO_PREFIX);

/**
 * Removes a WELL-FORMED ERC-8021 schema-0 suffix (codes, 1-byte length, schema 0x00, marker; codes printable ASCII) and
 * returns the rest (lower-case hex, no 0x), or null when the input ends in the marker but the suffix does not parse.
 */
export function stripValidErc8021(input) {
  const h = String(input ?? "").toLowerCase().replace(/^0x/, "");
  if (!h.endsWith(MARKER)) return h;
  const body = h.slice(0, -MARKER.length);
  if (body.length < 4 || body.slice(-2) !== "00") return null; // schema id 0 only
  const len = parseInt(body.slice(-4, -2), 16);
  const codesEnd = body.length - 4;
  if (!(len > 0) || codesEnd < len * 2) return null;
  const codes = body.slice(codesEnd - len * 2, codesEnd).match(/../g) ?? [];
  if (!codes.every((b) => /^[0-9a-f]{2}$/.test(b) && parseInt(b, 16) >= 0x20 && parseInt(b, 16) <= 0x7e)) return null;
  return body.slice(0, codesEnd - len * 2);
}

/**
 * True when a deposit's tx input looks like someone TRIED to pay an nTag, whether or not the memo decodes: the bytes of
 * "NTP:" appear anywhere in the input (also inside a smart-wallet call such as execTransaction / handleOps / execute), or
 * it is an ERC-20 transfer (a9059cbb) carrying anything beyond its 68 bytes once a valid ERC-8021 suffix is removed.
 * Autopilot never matches such a deposit against payment requests or "Get paid" registrations: it pays the tag when the
 * memo decodes cleanly on a direct transfer, and refuses it (logged and recorded) otherwise.
 */
export function looksLikeNtagAttempt(input) {
  const raw = String(input ?? "").toLowerCase().replace(/^0x/, "");
  if (raw.includes(MEMO_HEX)) return true;
  if (!raw.startsWith("a9059cbb")) return false;
  const h = stripValidErc8021(raw);
  return h == null || h.length > 136;
}

// ---------- discovery (Blockscout) ----------

async function getJson(url, fetchImpl = fetch, attempt = 0) {
  try {
    const r = await fetchImpl(url, { signal: AbortSignal.timeout(15_000), headers: { accept: "application/json" } });
    if (r.status === 429 || r.status >= 500) throw Object.assign(new Error(`Blockscout HTTP ${r.status}`), { retry: true });
    if (!r.ok) throw new Error(`Blockscout HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    if (attempt === 0 && (e.retry || e.name === "TypeError" || e.name === "TimeoutError" || e.name === "AbortError")) {
      await new Promise((res) => setTimeout(res, 1000));
      return getJson(url, fetchImpl, 1);
    }
    throw e;
  }
}

/** Pages a full load may read (50 transactions each) before it gives up rather than use a partial list. */
export const NTAG_FULL_LOAD_MAX_PAGES = 2000;
/** Pages one incremental refresh may read (only transactions newer than the cache, plus the re-checked window). */
export const NTAG_REFRESH_MAX_PAGES = 200;
/** Blocks below the cached head that every refresh reads again, so a reorg or a late-indexed block is picked up. */
export const NTAG_RECHECK_BLOCKS = 600;

const byBlockPosition = (x, y) => x.block - y.block || x.position - y.position;
const later = (a, b) => (!b || a.block > b.block || (a.block === b.block && a.position > b.position));

/**
 * Pages /addresses/<agent>/transactions?filter=to newest first. With `floor` null it reads to the END; otherwise it stops
 * after the first page that reaches below block `floor` (items below it are skipped). Returns { ops, head } where head
 * is the newest { block, position } of ANY transaction seen. More than `maxPages` pages -> throws (never a partial list).
 */
async function scanAgentTxs({ agent, api, fetchImpl, maxPages, floor = null }) {
  const ops = [];
  let head = null;
  let next = null;
  for (let p = 0; p < maxPages; p++) {
    const qs = new URLSearchParams({ filter: "to", ...(next ?? {}) });
    const d = await getJson(`${api}/addresses/${agent}/transactions?${qs}`, fetchImpl);
    if (!Array.isArray(d?.items)) throw new Error("Unexpected Blockscout response (no items)");
    let older = false;
    for (const t of d.items) {
      const block = Number(t?.block_number ?? t?.block);
      if (!Number.isFinite(block) || block <= 0) continue; // not mined yet: never an op, never the head
      if (floor != null && block < floor) { older = true; continue; }
      const at = { block, position: Number(t.position ?? 0) };
      if (later(at, head)) head = at;
      const o = ntagOpFromItem(t, agent);
      if (o) ops.push(o);
    }
    next = d.next_page_params ?? null;
    if (!next || older) return { ops, head };
  }
  throw new Error(floor == null
    ? `More than ${maxPages} pages of transactions to the agent; refusing to work from a partial Lokal tag list.`
    : `More than ${maxPages} pages of new transactions to the agent since the last refresh; refusing to work from a partial Lokal tag list.`);
}

/**
 * Full load: every nTag op ever sent to `agent` (tags are permanent, so there is no time window), as a cache
 * { ops (oldest first), head } for refreshNtagOpsCache. Throws rather than return a partial list.
 */
export async function loadNtagOpsCache({ agent = AGENT, api = EXPLORER_API, fetchImpl = fetch, maxPages = NTAG_FULL_LOAD_MAX_PAGES } = {}) {
  const { ops, head } = await scanAgentTxs({ agent, api, fetchImpl, maxPages });
  return { ops: ops.sort(byBlockPosition), head };
}

/**
 * Incremental refresh: reads only the newest pages, back to `recheckBlocks` below the cached head (keyset by block),
 * and replaces the cached ops from that block on with what Blockscout shows now (so a reorged-out op disappears).
 * Cheap however long the history is. Throws (the cache passed in is untouched) on an error or more than `maxPages` pages.
 */
export async function refreshNtagOpsCache(cache, { agent = AGENT, api = EXPLORER_API, fetchImpl = fetch, maxPages = NTAG_REFRESH_MAX_PAGES, recheckBlocks = NTAG_RECHECK_BLOCKS } = {}) {
  if (!cache?.head) return loadNtagOpsCache({ agent, api, fetchImpl }); // nothing was ever sent to the agent: tiny
  const floor = cache.head.block - recheckBlocks;
  const { ops, head } = await scanAgentTxs({ agent, api, fetchImpl, maxPages, floor });
  const keep = cache.ops.filter((o) => o.block < floor);
  return { ops: [...keep, ...ops].sort(byBlockPosition), head: head && later(head, cache.head) ? head : cache.head };
}

/**
 * Every nTag op ever sent to `agent`, oldest first. Paginates Blockscout /addresses/<agent>/transactions?filter=to
 * (newest first) to the END (tags are permanent, so there is no time window). More than `maxPages` pages -> throws, so a
 * partial list is never mistaken for the whole one. Failed transactions are ignored.
 */
export async function discoverNtagOps({ agent = AGENT, api = EXPLORER_API, fetchImpl = fetch, maxPages = NTAG_FULL_LOAD_MAX_PAGES } = {}) {
  return (await loadNtagOpsCache({ agent, api, fetchImpl, maxPages })).ops;
}

/**
 * Re-reads the winning claim over RPC (not Blockscout) before paying its owner: it must be a successful zero-value tx
 * to the agent from the same sender, at the same block, position and block time, with the same decoded op. Any mismatch
 * is a permanent refusal. Returns { from (checksummed), time (sec) }.
 */
export async function verifyNtagOpOnchain(pub, op, agent = AGENT) {
  const [tx, rc] = await Promise.all([pub.getTransaction({ hash: op.hash }), pub.getTransactionReceipt({ hash: op.hash })]);
  const bad = (why) => refusal(`Lokal tag claim ${op.hash} does not check out onchain (${why}). Not paid.`);
  if (rc.status !== "success") throw bad("failed transaction");
  if (String(tx.to ?? "").toLowerCase() !== String(agent).toLowerCase()) throw bad("not sent to the agent");
  if (String(tx.from).toLowerCase() !== String(op.from ?? "").toLowerCase()) throw bad("different sender");
  if (Number(tx.blockNumber) !== Number(op.block) || Number(tx.transactionIndex) !== Number(op.position)) throw bad("different block or position");
  if (BigInt(tx.value ?? 0n) !== 0n) throw bad("non-zero value");
  const decoded = decodeNtagOp(tx.input);
  if (JSON.stringify(decoded) !== JSON.stringify(op.op)) throw bad("different content");
  const err = ntagOpError(decoded);
  if (err) throw bad(err);
  // The block time decides locks and "resolved before the deposit"; it must be what the resolver used.
  const time = Number((await pub.getBlock({ blockNumber: tx.blockNumber })).timestamp);
  if (time !== Number(op.time)) throw bad("different block time");
  return { from: getAddress(tx.from), time };
}

// ---------- local state (git-ignored) ----------

/**
 * { [`${tx}:${logIndex}` lower-case]: { tag, owner, payer, token, amount, corridor, paidAt?, hashes?, receiptNo?, error?, ... } }
 * Refused deposits are kept too, as { status: "refused", reason, refusedAt, ... }: they count as handled, so a rescan
 * never pays them; only `retry --ntag <key> --force-refused` can.
 */
export function loadNtagPayments(file = NTAG_PAYMENTS_FILE) {
  if (!fs.existsSync(file)) return {};
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  return j && typeof j.payments === "object" && j.payments && !Array.isArray(j.payments) ? j.payments : {};
}

/** Atomic write (tmp + rename). */
export function saveNtagPayments(state, file = NTAG_PAYMENTS_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ payments: state }, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

const TX_HASH_RE = /0x[0-9a-fA-F]{64}/;
/**
 * Why a REFUSED nTag deposit can't be force-paid with `retry --ntag <key> --force-refused`, or null. It needs a known
 * owner, claim, amount and corridor (refusals before the owner was resolved, such as an unknown tag or a bad memo, have
 * none), and nothing may have been sent for it yet.
 */
export function refusedRetryBlocker(r) {
  if (!r) return "No Lokal tag payment with that id.";
  if (r.status !== "refused") return `${r.id} was not refused by autopilot; retry it without --force-refused.`;
  if (r.paidAt) return `${r.id} is already paid.`;
  if (r.retrying) return `${r.id} has a retry marked in progress since ${r.retrying}. Check its transactions on Celoscan before touching it.`;
  if (r.hashes?.payout || r.hashes?.swap || TX_HASH_RE.test(String(r.error ?? ""))) {
    return `${r.id} already sent a swap or payout transaction. Retrying could pay twice; check it on Celoscan and settle it by hand.`;
  }
  if (ntagError(r.tag) || !/^0x[0-9a-fA-F]{40}$/.test(String(r.from ?? "")) || !r.claim || !r.amount || !r.dir || !r.deposit?.payer) {
    return `${r.id} was refused before a tag owner was known (${r.reason ?? "no reason saved"}), so there is nobody to pay automatically. Settle it by hand.`;
  }
  return null;
}
