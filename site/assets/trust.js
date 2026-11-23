// "Who am I paying?": what a payer can learn about a LokalPay tag before paying it, read from Celo, plus calm warnings.
// Used by the tag page (js/tag.js). The top level stays free of window/document access, so every rule is tested in
// Node (test/trust.test.mjs).
//
// Signals:
//   - the tag's age (when the current holder claimed it: LokalTags tagInfo().since, which is the TagClaimed block time,
//     or the older memo claim for a legacy tag);
//   - how many payments the holder has received through LokalTags (TagPaid), and since when. Never who paid;
//   - five warnings, none of which blocks payment: first-time payee (this browser), new tag (claimed in the last 24 h),
//     changed hands (claimed by a new owner in the last 30 days), lookalike (one edit from a tag this browser paid, or
//     from a reserved name), and name changed (NameChanged in the last 7 days).
// Anything that couldn't be read says so ("couldn't check"); a failed read is never shown as "fine".
//
// Event history comes from eth_getLogs filtered by the tag hash (topic 1 of every tag event on LokalTags): first from
// Blockscout's JSON-RPC (no block-range limit; one call per event type), else from Forno in 5,000-block chunks over at
// most FALLBACK_BLOCKS recent blocks (then the history is marked incomplete when it doesn't reach the deployment).
import { RPC, NTAG_RESERVED, getJson, abiDecode } from "./core.js";
import { LOKAL_TAGS, LOKAL_TAGS_BLOCK, TOPIC, decodeTagPaid } from "./lokal-contracts.js";

const lc = (s) => String(s ?? "").toLowerCase();
const sameAddr = (a, b) => lc(a) === lc(b);
export const HOUR = 3600, DAY = 86_400;
/** How recent counts as recent for each warning (seconds). */
export const WINDOWS = Object.freeze({ newTag: DAY, ownerChange: 30 * DAY, nameChange: 7 * DAY });

// ---------- keccak-256 (for the tag hash topic; no library on the site) ----------
const MASK = (1n << 64n) - 1n;
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n, 0x000000000000808bn, 0x0000000080000001n,
  0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n,
  0x000000000000800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14]; // [x + 5y]
const rotl = (v, n) => (n === 0 ? v : ((v << BigInt(n)) | (v >> BigInt(64 - n))) & MASK);
function keccakF(A) {
  const C = new Array(5), B = new Array(25);
  for (let r = 0; r < 24; r++) {
    for (let x = 0; x < 5; x++) C[x] = A[x] ^ A[x + 5] ^ A[x + 10] ^ A[x + 15] ^ A[x + 20];
    for (let x = 0; x < 5; x++) {
      const d = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) A[x + y] ^= d;
    }
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(A[x + 5 * y], ROT[x + 5 * y]);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 25; y += 5) A[x + y] = B[x + y] ^ (~B[((x + 1) % 5) + y] & MASK & B[((x + 2) % 5) + y]);
    A[0] ^= RC[r];
  }
}
/** keccak-256 of bytes (Uint8Array) as "0x" + 64 hex characters (Ethereum's keccak, not SHA3-256). */
export function keccak256(bytes) {
  const rate = 136;
  const padded = new Uint8Array(Math.ceil((bytes.length + 1) / rate) * rate);
  padded.set(bytes);
  padded[bytes.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const A = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + b]);
      A[i] ^= lane;
    }
    keccakF(A);
  }
  let hex = "";
  for (let i = 0; i < 4; i++) for (let b = 0; b < 8; b++) hex += Number((A[i] >> BigInt(8 * b)) & 0xffn).toString(16).padStart(2, "0");
  return "0x" + hex;
}
/** The LokalTags topic for a tag: keccak256(bytes(tag)). */
export const tagHashOf = (tag) => keccak256(new TextEncoder().encode(String(tag)));

// ---------- time ----------
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
/** "just now" · "5 minutes ago" · "3 hours ago" · "3 days ago" · "2 months ago" · "1 year ago". */
export function agoText(sec, nowSec) {
  const d = Math.max(0, Math.floor(Number(nowSec) - Number(sec)));
  if (d < 60) return "just now";
  if (d < HOUR) return plural(Math.floor(d / 60), "minute") + " ago";
  if (d < DAY) return plural(Math.floor(d / HOUR), "hour") + " ago";
  if (d < 60 * DAY) return plural(Math.floor(d / DAY), "day") + " ago";
  if (d < 365 * DAY) return plural(Math.floor(d / (30 * DAY)), "month") + " ago";
  return plural(Math.floor(d / (365 * DAY)), "year") + " ago";
}
/** How old a tag is: "new" (under 24 hours), "recent" (under 30 days), "settled", or "unknown". */
export function ageBucket(sinceSec, nowSec) {
  if (!(Number(sinceSec) > 0)) return "unknown";
  const d = Number(nowSec) - Number(sinceSec);
  if (d < WINDOWS.newTag) return "new";
  if (d < WINDOWS.ownerChange) return "recent";
  return "settled";
}

// ---------- lookalikes ----------
/** Edit distance with adjacent transpositions (optimal string alignment): "ada" -> "adaa" is 1, "ada" -> "aad" is 1. */
export function editDistance(a, b) {
  a = String(a); b = String(b);
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[m][n];
}
/** Digits and underscores that are used to mimic letters: "supp0rt", "l0kal", "adm1n" read as the real word. */
export const unconfuse = (t) => String(t).replace(/0/g, "o").replace(/1/g, "l").replace(/3/g, "e").replace(/5/g, "s").replace(/_/g, "");
/** Names a tag can borrow to look official (as a prefix or suffix: "lokal_help", "celo_support", "mypay_admin"). */
export const BRAND_WORDS = Object.freeze(["lokal", "celo", "minipay", "valora", "textile", "tether", "support", "admin", "official"]);
/** Reserved names short enough that one edit reaches ordinary names (@pay -> @ray), so only confusables count for them. */
const MIN_RESERVED_EDIT = 5;
/**
 * Is `tag` a lookalike? Returns { kind: "paid", of } (one edit, or the same after unconfuse, from a tag in `paidTags`
 * other than itself) | { kind: "reserved", of } (close to a name nobody can claim, or borrows a brand word) | null.
 * A tag this browser has paid before is never its own lookalike.
 */
export function lookalikeOf(tag, paidTags = [], reserved = NTAG_RESERVED) {
  const t = lc(tag);
  const paid = [...new Set((paidTags ?? []).map(lc))];
  if (!paid.includes(t)) {
    const hit = paid.find((p) => p !== t && (editDistance(p, t) <= 1 || unconfuse(p) === unconfuse(t)));
    if (hit) return { kind: "paid", of: hit };
  }
  const plain = unconfuse(t);
  for (const r of reserved) {
    if (r === t) continue;
    if (unconfuse(r) === plain || (r.length >= MIN_RESERVED_EDIT && editDistance(r, t) <= 1)) return { kind: "reserved", of: r };
  }
  const brand = BRAND_WORDS.find((w) => plain !== w && (plain.startsWith(w) || plain.endsWith(w)));
  return brand ? { kind: "reserved", of: brand } : null;
}

// ---------- this browser's paid tags (only with the site's privacy consent) ----------
export const PAID_KEY = "np-paid-tags";
const PAID_MAX = 200;
/** The tags this browser has paid: { consent: true, tags } when the visitor accepted, else { consent: false, tags: [] }. */
export function readPaidTags(storage, consent) {
  if (consent !== "accepted") return { consent: false, tags: [] };
  try {
    const v = JSON.parse(storage?.getItem(PAID_KEY) ?? "[]");
    return { consent: true, tags: Array.isArray(v) ? v.filter((x) => typeof x === "string" && /^[a-z][a-z0-9_]{2,19}$/.test(x)) : [] };
  } catch { return { consent: true, tags: [] }; }
}
/** Remembers that this browser paid `tag` (newest first, at most PAID_MAX). Does nothing without consent. Returns the list. */
export function recordPaidTag(storage, consent, tag) {
  const cur = readPaidTags(storage, consent);
  if (!cur.consent || !/^[a-z][a-z0-9_]{2,19}$/.test(String(tag))) return cur.tags;
  const tags = [tag, ...cur.tags.filter((t) => t !== tag)].slice(0, PAID_MAX);
  try { storage.setItem(PAID_KEY, JSON.stringify(tags)); } catch { /* storage blocked: nothing remembered */ }
  return tags;
}
/** "first" (no record of paying it here), "known" (paid from this browser before) or "unknown" (nothing is kept). */
export function firstTimeState(tag, paid) {
  if (!paid?.consent) return "unknown";
  return paid.tags.includes(lc(tag)) ? "known" : "first";
}

// ---------- LokalTags events ----------
const addrOf = (topic) => "0x" + lc(topic).slice(26);
const num = (v) => (v == null ? null : Number(BigInt(v)));
/**
 * One LokalTags log -> { type ("claimed" | "released" | "renamed" | "paid"), block, logIndex, time (sec or null), hash,
 * owner (the holder; for "paid" the recipient), name?, lockedUntil?, token?, amount? }, or null for any other log.
 * Payer addresses are dropped here: nothing downstream ever sees who paid.
 */
export function decodeTagEvent(log) {
  const t0 = lc(log?.topics?.[0]);
  const base = {
    block: num(log.blockNumber) ?? 0, logIndex: num(log.logIndex) ?? 0, time: num(log.blockTimestamp),
    hash: lc(log.transactionHash), tagHash: lc(log.topics?.[1]),
  };
  try {
    if (t0 === TOPIC.TagClaimed) { const [, name] = abiDecode(["string", "string"], log.data); return { ...base, type: "claimed", owner: addrOf(log.topics[2]), name }; }
    if (t0 === TOPIC.NameChanged) { const [, name] = abiDecode(["string", "string"], log.data); return { ...base, type: "renamed", owner: addrOf(log.topics[2]), name }; }
    if (t0 === TOPIC.TagReleased) { const [, until] = abiDecode(["string", "uint256"], log.data); return { ...base, type: "released", owner: addrOf(log.topics[2]), lockedUntil: Number(until) }; }
    if (t0 === TOPIC.TagPaid) {
      const p = decodeTagPaid(log);
      return p ? { ...base, type: "paid", owner: lc(p.recipient), token: p.token, amount: p.amount } : null;
    }
  } catch { return null; }
  return null;
}
const byChain = (a, b) => a.block - b.block || a.logIndex - b.logIndex;

/** Up to how many recent blocks the Forno fallback reads (Forno answers at most 5,000 blocks per eth_getLogs). */
export const FALLBACK_BLOCKS = 200_000;
export const RANGE = 5000;
export const EXPLORER_RPC = "https://celo.blockscout.com/api/eth-rpc";
/** Blockscout returns at most this many logs per call; a full page means there may be more. */
export const EXPLORER_PAGE = 1000;
const HISTORY_TOPICS = ["TagClaimed", "TagReleased", "NameChanged", "TagPaid"];
const hex = (n) => "0x" + Number(n).toString(16);
async function jsonRpc(url, method, params, fetchJson) {
  const j = await fetchJson(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), cache: "no-store" });
  if (j?.error) throw new Error(String(j.error.message ?? "rpc error"));
  return j?.result;
}
/**
 * Every LokalTags event for `tag`, oldest first: { events (decodeTagEvent), complete (the whole history since the
 * deployment was read), capped (some event type hit the explorer's page size), source ("explorer" | "rpc") }.
 * Throws when neither source answers.
 */
export async function loadTagEvents(tag, { fetchJson = getJson, rpcUrl = RPC, explorerRpc = EXPLORER_RPC, fallbackBlocks = FALLBACK_BLOCKS, concurrency = 4 } = {}) {
  const topic = tagHashOf(tag);
  try {
    const lists = await Promise.all(HISTORY_TOPICS.map(async (name) => {
      const r = await jsonRpc(explorerRpc, "eth_getLogs", [{ address: LOKAL_TAGS, fromBlock: hex(LOKAL_TAGS_BLOCK), toBlock: "latest", topics: [TOPIC[name], topic] }], fetchJson);
      if (!Array.isArray(r)) throw new Error("unexpected explorer answer");
      return r;
    }));
    const events = lists.flat().map(decodeTagEvent).filter((e) => e && e.tagHash === topic).sort(byChain);
    return { events, complete: true, capped: lists.some((l) => l.length >= EXPLORER_PAGE), source: "explorer" };
  } catch { /* the explorer is down or refused: read recent blocks from Forno instead */ }
  const head = Number(BigInt(await jsonRpc(rpcUrl, "eth_blockNumber", [], fetchJson)));
  const from = Math.max(LOKAL_TAGS_BLOCK, head - fallbackBlocks + 1);
  const ranges = [];
  for (let a = from; a <= head; a += RANGE) ranges.push([a, Math.min(head, a + RANGE - 1)]);
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, ranges.length) }, async () => {
    while (i < ranges.length) {
      const [a, b] = ranges[i++];
      const r = await jsonRpc(rpcUrl, "eth_getLogs", [{ address: LOKAL_TAGS, fromBlock: hex(a), toBlock: hex(b), topics: [null, topic] }], fetchJson);
      if (!Array.isArray(r)) throw new Error("unexpected rpc answer");
      out.push(...r);
    }
  }));
  const events = out.map(decodeTagEvent).filter((e) => e && e.tagHash === topic).sort(byChain);
  return { events, complete: from === LOKAL_TAGS_BLOCK, capped: false, source: "rpc" };
}
/** Fills in `time` (block timestamp, seconds) for the given events that lack it. Leaves it null when a block can't be read. */
export async function addBlockTimes(events, { fetchJson = getJson, rpcUrl = RPC } = {}) {
  const need = [...new Set(events.filter((e) => e && e.time == null).map((e) => e.block))].slice(0, 8);
  const times = new Map();
  await Promise.all(need.map(async (b) => {
    try { const blk = await jsonRpc(rpcUrl, "eth_getBlockByNumber", [hex(b), false], fetchJson); if (blk?.timestamp) times.set(b, Number(BigInt(blk.timestamp))); } catch { /* stays unknown */ }
  }));
  for (const e of events) if (e && e.time == null && times.has(e.block)) e.time = times.get(e.block);
  return events;
}
/** The events whose block time the warnings need: the newest rename by the holder, and the holder's first payment. */
export function eventsNeedingTime(events, owner) {
  const mine = (events ?? []).filter((e) => sameAddr(e.owner, owner));
  const rename = mine.filter((e) => e.type === "renamed").at(-1);
  const firstPaid = mine.find((e) => e.type === "paid");
  return [rename, firstPaid].filter(Boolean);
}

// ---------- history from the older memo protocol (legacy NT1 tags) ----------
/**
 * Legacy history for `tag` from the memo ops and their resolved statuses (core.js resolveNtags): { claims: [{ owner,
 * time }], renames: [{ owner, time }] }, oldest first. Only ops the replay accepted count.
 */
export function legacyHistory(ops, statuses, tag) {
  const claims = [], renames = [];
  for (const o of ops ?? []) {
    if (o?.op?.t !== tag) continue;
    const s = statuses?.get?.(o.hash);
    if (s === "claimed") claims.push({ owner: lc(o.from), time: Number(o.time) });
    else if (s === "renamed") renames.push({ owner: lc(o.from), time: Number(o.time) });
  }
  return { claims, renames };
}

// ---------- owner changes ----------
/**
 * Did `tag` change hands recently? `claims` = [{ owner, time? }] oldest first (contract TagClaimed events, then the
 * legacy claims). Returns { state: "changed" | "same" | "unknown", at (the current holder's claim, sec), previous }.
 * "changed": the current holder claimed it within WINDOWS.ownerChange and someone else held it before. A claim older
 * than the window needs no history ("same"); a recent claim with an incomplete history is "unknown".
 */
export function ownerChange({ owner, sinceSec, claims = [], complete = true, nowSec }) {
  if (!(Number(sinceSec) > 0)) return { state: "unknown", at: null, previous: null };
  if (Number(nowSec) - Number(sinceSec) >= WINDOWS.ownerChange) return { state: "same", at: Number(sinceSec), previous: null };
  const previous = [...(claims ?? [])].reverse().find((c) => c && !sameAddr(c.owner, owner)) ?? null;
  if (previous) return { state: "changed", at: Number(sinceSec), previous };
  return { state: complete ? "same" : "unknown", at: Number(sinceSec), previous: null };
}

// ---------- the assessment ----------
/**
 * Everything the "Who am I paying?" card shows, from what could be read. Pure.
 *   tag, entry: { owner, since, name, source ("contract" | "legacy") }
 *   history: { events, complete, capped } (contract) | { legacy: legacyHistory(...) } | null (couldn't be read)
 *   legacyClaims: [{ owner, time }] earlier memo claims of this tag (a contract tag may have had a memo holder), or null
 *   paid: readPaidTags(...), nowSec.
 * Returns { age: { since, text, bucket }, payments: { state: "ok" | "unknown", count, since, capped, reason },
 * checks: [{ id, state: "warn" | "ok" | "unknown", title, reason }], warnings (the "warn" checks), unknown (the others) }.
 */
export function assessTag({ tag, entry, history = null, legacyClaims = null, paid = { consent: false, tags: [] }, nowSec }) {
  const at = "@" + tag;
  const owner = lc(entry?.owner);
  const since = Number(entry?.since) || 0;
  const contract = entry?.source === "contract";
  const checks = [];
  // a few words per check, for the one-line notes ("Before you pay: first-time payee, new tag"; "Couldn't check: name changes")
  const SHORT = {
    first: () => "first-time payee", new: (st) => (st === "warn" ? "new tag" : "tag age"),
    owner: (st) => (st === "warn" ? "changed hands recently" : "owner changes"),
    lookalike: (st) => (st === "warn" ? `looks like @${lookalikeOf(tag, paid.tags)?.of}` : "tags you've paid"),
    name: (st) => (st === "warn" ? "name changed recently" : "name changes"),
  };
  const add = (id, state, title, reason) => checks.push({ id, state, title, reason, short: SHORT[id](state) });

  // first-time payee
  const first = firstTimeState(tag, paid);
  if (first === "known") add("first", "ok", `You've paid ${at} from this browser before.`, "");
  else add("first", "warn", `First time paying ${at}? Check with them it's their tag.`,
    first === "first" ? `This browser has no record of paying ${at}.`
      : "This browser doesn't keep a list of tags you've paid unless you allow it in Privacy choices, so it can't tell.");

  // new tag
  const bucket = ageBucket(since, nowSec);
  if (bucket === "unknown") add("new", "unknown", "Couldn't check how old this tag is.", "");
  else if (bucket === "new") add("new", "warn", `New tag: claimed ${agoText(since, nowSec)}.`, `${at} has no history yet. A tag claimed today could belong to anyone.`);
  else add("new", "ok", `Claimed ${agoText(since, nowSec)}.`, "");

  // changed hands
  const events = contract && history?.events ? history.events : [];
  const legacy = !contract && history?.legacy ? history.legacy : null;
  let claims = null;
  if (contract && history) claims = [...(legacyClaims ?? []), ...events.filter((e) => e.type === "claimed")];
  else if (legacy) claims = legacy.claims;
  const complete = contract ? Boolean(history?.complete) && legacyClaims != null : Boolean(legacy);
  const oc = ownerChange({ owner, sinceSec: since, claims: claims ?? [], complete: claims != null && complete, nowSec });
  if (oc.state === "changed") add("owner", "warn", `Changed hands ${agoText(oc.at, nowSec)}.`, `Someone else held ${at} before, and this wallet claimed it ${agoText(oc.at, nowSec)}. If you paid ${at} in the past, it may not be the same person now.`);
  else if (oc.state === "unknown") add("owner", "unknown", `Couldn't check whether ${at} changed hands recently.`, "");
  else add("owner", "ok", Number(nowSec) - since < WINDOWS.ownerChange ? `Nobody else has held ${at}.` : "Same owner for the last 30 days.", "");

  // lookalike
  const look = lookalikeOf(tag, paid.tags);
  if (look?.kind === "paid") add("lookalike", "warn", `Looks like @${look.of}, a tag you've paid before.`, `${at} is one letter away from @${look.of}. Check you have the right tag.`);
  else if (look?.kind === "reserved") add("lookalike", "warn", `Looks like “${look.of}”, a name nobody can claim.`, `Names like @${look.of} are kept back so nobody can pose as LokalPay, a wallet or a bank. ${at} is not one of them.`);
  else if (!paid.consent) add("lookalike", "unknown", "Couldn't compare it with tags you've paid.", "This browser doesn't keep that list unless you allow it in Privacy choices. It isn't close to any reserved name.");
  else add("lookalike", "ok", "Not a lookalike of a tag you've paid or a reserved name.", "");

  // name changed
  const renames = contract ? events.filter((e) => e.type === "renamed" && sameAddr(e.owner, owner)) : legacy ? legacy.renames.filter((r) => sameAddr(r.owner, owner)) : null;
  const lastRename = renames?.at(-1) ?? null;
  if (renames == null || (contract && !history?.complete)) add("name", "unknown", "Couldn't check whether the name changed recently.", "");
  else if (lastRename && lastRename.time == null) add("name", "unknown", "Couldn't check when the name last changed.", "");
  else if (lastRename && Number(nowSec) - lastRename.time < WINDOWS.nameChange) add("name", "warn", `Name changed ${agoText(lastRename.time, nowSec)}.`, "The display name is set by the owner and not checked by anyone. A new name doesn't mean a new person, but ask if it surprises you.");
  else add("name", "ok", "Name unchanged in the last 7 days.", "");

  // payments received through LokalPay (the current holder only; never who paid)
  let payments;
  if (!contract) payments = { state: "unknown", count: null, since: null, capped: false, reason: "Payments to older memo tags aren't counted here." };
  else if (!history) payments = { state: "unknown", count: null, since: null, capped: false, reason: "Couldn't read this tag's payments from Celo." };
  else {
    const mine = events.filter((e) => e.type === "paid" && sameAddr(e.owner, owner));
    payments = { state: history.complete ? "ok" : "unknown", count: mine.length, since: mine[0]?.time ?? null, capped: Boolean(history.capped),
      reason: history.complete ? "" : "Only recent blocks could be read, so older payments may be missing." };
  }

  return {
    age: { since, text: since ? `Claimed ${agoText(since, nowSec)}` : "Claim date unknown", bucket },
    payments, checks,
    warnings: checks.filter((c) => c.state === "warn"),
    unknown: checks.filter((c) => c.state === "unknown"),
  };
}
