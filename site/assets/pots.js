// Pots (LokalPots) for the site: one link and QR code that many guests pay into. A wedding where guests "spray" the
// couple, a birthday, a group gift. The host opens a pot from the dashboard; anyone with the link sprays from their own
// wallet without an account (pot.html?id=N). The contract checks every cap before money moves and sends it straight
// to the agent's payout wallet; the agent then pays the host in the currency the guest chose (src/contract-watch.mjs).
//
// Everything here is pure or takes its I/O as arguments, with no DOM access, so it is unit-tested in Node
// (test/pots-site.test.mjs): title rules (the contract's LokalText rules), dollar amounts, closing times, caps, pot ids
// in URLs, the pot's state, the Spray Wall's rows (from PotPaid logs, without payer addresses) and reading those logs.
import { RPC, getJson, USDT_ADDRESS, CURRENCIES, parseMoneyInput, unitsToDecimal, lagos } from "./core.js";
import {
  LOKAL_POTS, LOKAL_POTS_BLOCK, TOPIC, POT_MAX_OPEN_SECONDS, POT_TITLE_MAX_BYTES, decodePotPaid, decodePotCreated,
  currencyOfRef, tokenCode, topicOf, readPotCount, readPotInfo,
} from "./lokal-contracts.js";

const lc = (s) => String(s ?? "").toLowerCase();
/** A pot closes at least this far in the future (so it can't expire while the transaction is on its way). */
export const POT_MIN_LEAD_SECONDS = 10 * 60;
/** Forno answers eth_getLogs for at most this many blocks at a time. */
export const LOG_RANGE = 5000;
/** Blockscout's Etherscan-style API (logs with topic filters over any block range). */
export const BLOCKSCOUT_RPC_API = "https://celo.blockscout.com/api";
/**
 * The tokens a guest can spray with: dollars (USD₮) for any currency, or a local token (cNGN, IDRX, wARS, wCOP) for
 * dollars or for that same currency (lokal-contracts.js payWithTokens says which, per choice).
 */
export const SPRAY_TOKENS = Object.freeze(["usdt", ...CURRENCIES.map((c) => c.code)]);
/** Quick amounts a guest can tap, in whole units of the token they spray with (shown when they fit the room). */
export const QUICK_AMOUNTS = Object.freeze({ usdt: [1, 2, 5], cngn: [1500, 3000, 5000], idrx: [20000, 50000, 100000], wars: [2000, 5000, 10000], wcop: [4000, 10000, 20000] });

// ---------- the title (LokalText.isValidText with 60 bytes / 60 UTF-16 units) ----------
const INVISIBLE = /[​-‏‪-‮⁠-⁩﻿]/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/** False when the text has a lone UTF-16 surrogate (it would not survive UTF-8 as typed). */
const wellFormed = (s) => (typeof s.isWellFormed === "function" ? s.isWellFormed() : new TextDecoder().decode(new TextEncoder().encode(s)) === s);
export const utf8Length = (s) => new TextEncoder().encode(String(s ?? "")).length;
/** The title as it will be sent: trimmed (the contract refuses spaces at either end). */
export const cleanTitle = (raw) => String(raw ?? "").trim();
/** Why a title would be refused (plain English, for under the field), or null. Same rules as the contract. */
export function potTitleError(raw) {
  if (typeof raw !== "string") return "Give the pot a title.";
  const t = cleanTitle(raw);
  if (!t) return "Give the pot a title, like “Ada & Tunde's wedding”.";
  if (!wellFormed(t)) return "The title has a broken character. Retype it.";
  if (CONTROL.test(t)) return "The title can't contain control characters (like a line break).";
  if (INVISIBLE.test(t)) return "The title can't contain invisible or text-direction characters.";
  if (utf8Length(t) > POT_TITLE_MAX_BYTES || t.length > POT_TITLE_MAX_BYTES) return `That's too long: up to ${POT_TITLE_MAX_BYTES} characters (accented letters and emoji take more room).`;
  return null;
}
/** Room left in the title, in the stricter of the contract's two counts (bytes and UTF-16 units). */
export const titleRoom = (raw) => POT_TITLE_MAX_BYTES - Math.max(utf8Length(cleanTitle(raw)), cleanTitle(raw).length);

// ---------- dollars (usd6: 6 decimals) ----------
/** A typed dollar amount ("5", "2.50", "$100") -> { usd6 } or { error }. */
export function parseUsd6(raw) {
  const p = parseMoneyInput(raw);
  if (p.error) return { error: p.error };
  return { usd6: BigInt(p.cents) * 10_000n };
}
/** usd6 -> "$5", "$2.50", "$1,250" (cents shown only when there are any; rounded down to the cent). */
export function usd6Text(u, { cents = "auto" } = {}) {
  const s = unitsToDecimal(BigInt(u), 6, 2);
  const [w, f] = s.split(".");
  const whole = w.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return "$" + whole + (cents === "always" || (cents === "auto" && f !== "00") ? "." + f : "");
}
/** Why a host's caps would be refused, or null. limits = readPotLimits(); per-guest at least $1 (the smallest payment). */
export function capsError({ potCapUsd6, perPayerCapUsd6 }, limits) {
  const pot = BigInt(potCapUsd6 ?? 0), each = BigInt(perPayerCapUsd6 ?? 0);
  if (pot <= 0n) return { field: "cap", message: "Set how much the pot can take in total." };
  if (pot > limits.maxPotCapUsd6) return { field: "cap", message: `A pot can take up to ${usd6Text(limits.maxPotCapUsd6)} (the contract's maximum).` };
  if (each < 1_000_000n) return { field: "each", message: "Let each guest spray at least $1, the smallest payment the contract takes." };
  if (each > limits.maxPerPayerCapUsd6) return { field: "each", message: `Each guest can spray up to ${usd6Text(limits.maxPerPayerCapUsd6)} (the contract's maximum).` };
  if (each > pot) return { field: "each", message: "The per-guest cap can't be more than the pot's total." };
  return null;
}

// ---------- closing time ----------
export const CLOSE_PRESETS = Object.freeze([
  { id: "1d", label: "1 day", seconds: 86_400 },
  { id: "3d", label: "3 days", seconds: 3 * 86_400 },
  { id: "7d", label: "7 days", seconds: 7 * 86_400 },
  { id: "14d", label: "14 days", seconds: POT_MAX_OPEN_SECONDS },
]);
/**
 * The closesAt to send, from the chain's clock (`chainNow`, the latest block's timestamp), never later than the
 * contract allows: a 14-day pot closes two minutes short of 14 days, so a slow confirmation can't push it over.
 */
export function closesAtFor(choice, chainNow) {
  const now = Math.floor(Number(chainNow));
  const latest = now + POT_MAX_OPEN_SECONDS - 120;
  const want = choice?.at != null ? Math.floor(Number(choice.at)) : now + Number(CLOSE_PRESETS.find((p) => p.id === choice?.preset)?.seconds ?? POT_MAX_OPEN_SECONDS);
  return Math.min(want, latest);
}
/** Why a picked closing time (unix seconds) can't be used, or null. */
export function closeTimeError(at, nowSec) {
  if (!Number.isFinite(at)) return "Pick a date and time.";
  if (at < nowSec + POT_MIN_LEAD_SECONDS) return "Pick a time at least 10 minutes from now.";
  if (at > nowSec + POT_MAX_OPEN_SECONDS) return "A pot can stay open for up to 14 days. Pick an earlier time.";
  return null;
}
/** "Sat 6 Dec, 18:00 WAT" (Lagos time, like the rest of the site). */
export const closeText = (sec) => `${lagos(Number(sec) * 1000, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} WAT`;

// ---------- pot ids and links ----------
const ID_RE = /^[1-9]\d{0,17}$/;
/**
 * The pot id in a page address: pot.html?id=12 (the shared link), pot.html#12 or pot.html#id=12. Anything else
 * (0, a leading zero, letters, a negative or absurd number) is null, so the page can say "not a pot link".
 */
export function potIdFrom({ search = "", hash = "" } = {}) {
  const q = new URLSearchParams(String(search)).get("id");
  const h = String(hash).replace(/^#/, "").replace(/^id=/, "");
  const raw = (q ?? h ?? "").trim();
  return ID_RE.test(raw) ? BigInt(raw) : null;
}
/** The public link to a pot, next to the current page (every page sits at the site root). */
export function potUrl(id, base = typeof location !== "undefined" ? location.href : null) {
  const rel = `pot.html?id=${BigInt(id)}`;
  return base ? new URL(rel, base).href : rel;
}
/** The WhatsApp share link for a pot. */
export function potWhatsappUrl(title, url) {
  return "https://wa.me/?text=" + encodeURIComponent(`${title}: spray in dollars or naira on Celo, from any wallet. ${url}`);
}

// ---------- a pot's state ----------
/** "open" | "full" | "closed" (the host closed it) | "ended" (past its closing time), from potInfo. */
export function potState(info, nowSec) {
  if (!info) return null;
  const past = nowSec >= info.closesAt;
  if (!info.open) return past ? "ended" : "closed";
  if (past) return "ended";
  if (BigInt(info.totalUsd6) >= BigInt(info.capUsd6)) return "full";
  return "open";
}
export const POT_STATE_LABEL = Object.freeze({ open: ["Open", "ok"], full: ["Full", "warn"], closed: ["Closed by the host", "neutral"], ended: ["Ended", "neutral"] });
/** 0..1, how full the pot is. */
export function potProgress(info) {
  const cap = BigInt(info?.capUsd6 ?? 0);
  if (cap <= 0n) return 0;
  const t = BigInt(info.totalUsd6 ?? 0);
  return t >= cap ? 1 : Number((t * 10_000n) / cap) / 10_000;
}
/** "2 days 4 h left" · "3 h 12 min left" · "12 min left" · "Under a minute left" · null once closed. */
export function timeLeftText(closesAt, nowSec) {
  const s = Number(closesAt) - Math.floor(nowSec);
  if (s <= 0) return null;
  const d = Math.floor(s / 86_400), h = Math.floor((s % 86_400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d} day${d === 1 ? "" : "s"}${h ? ` ${h} h` : ""} left`;
  if (h > 0) return `${h} h${m ? ` ${m} min` : ""} left`;
  if (m > 0) return `${m} min left`;
  return "Under a minute left";
}

// ---------- a guest's spray ----------
/** The largest amount of a token (base units) whose dollar value fits `usd6` (the contract rounds the value UP). */
export const maxUnitsForUsd6 = (usd6, unitsPerUsd) => (BigInt(usd6) * BigInt(unitsPerUsd)) / 1_000_000n;
/** The smallest of the contract's four rooms (usd6), and which one binds. */
export function sprayRoom(remaining) {
  const parts = [["payer", remaining.forPayer], ["pot", remaining.forPot], ["host", remaining.forHost], ["today", remaining.forToday]];
  let [why, room] = parts[0];
  for (const [k, v] of parts.slice(1)) if (BigInt(v) < BigInt(room)) { why = k; room = v; }
  return { room: BigInt(room), why };
}
/**
 * Why a spray would be refused, before the wallet opens (or null). units: base units of the token; usd6: its value
 * (potUsdValue); limits: LokalTags' { min, max } for the token; room: sprayRoom(); fmt: units -> text ("$2", "₦1,500").
 */
export function sprayError({ units, usd6, limits, room, fmt }) {
  if (units == null || units <= 0n) return "Enter an amount.";
  if (limits && units < limits.min) return `The smallest spray is ${fmt(limits.min)}.`;
  if (limits && units > limits.max) return `One spray can be at most ${fmt(limits.max)}.`;
  if (room && usd6 > room.room) {
    if (room.room <= 0n) {
      return room.why === "payer" ? "You've sprayed as much as one guest can into this pot."
        : room.why === "pot" ? "This pot is full."
          : room.why === "host" ? "The host's pots have reached today's total. Try again tomorrow (UTC)."
            : "All pots together have reached today's total. Try again tomorrow (UTC).";
    }
    const left = usd6Text(room.room);
    return room.why === "payer" ? `You can spray ${left} more into this pot.`
      : room.why === "pot" ? `This pot can take ${left} more.`
        : room.why === "host" ? `The host's pots can take ${left} more today.`
          : `All pots together can take ${left} more today.`;
  }
  return null;
}
/** What the host can receive when a guest sprays with `payCode`: USD₮ -> any currency or dollars; a local token -> that currency or dollars. */
export function receiveChoices(payCode) {
  return payCode === "usdt" ? [...CURRENCIES.map((c) => c.code), "usd"] : [payCode, "usd"];
}

// ---------- the Spray Wall: PotPaid logs, without payer addresses ----------
/**
 * One spray for the wall from a PotPaid log: { key, potId, amountUsd6, totalSoFar, pay ("usdt" | "cngn" | ...),
 * amount, receive (the guest's choice or null), block, logIndex, hash, time (sec or null) }. The payer's address is
 * deliberately dropped: the wall shows amounts and times, never who paid.
 */
export function sprayOf(log, time = null) {
  const p = decodePotPaid(log);
  if (!p) return null;
  const t = time ?? log.blockTimestamp ?? log.timeStamp ?? null;
  return {
    key: `${lc(p.hash)}:${p.logIndex}`, potId: p.potId, amountUsd6: p.amountUsd6, totalSoFar: p.totalSoFar,
    pay: tokenCode(p.token), amount: p.amount, receive: currencyOfRef(p.ref), block: p.block, logIndex: p.logIndex, hash: p.hash,
    time: t == null ? null : Number(t),
  };
}
/** Merges two lists of sprays: one row per log, newest first. */
export function mergeSprays(a = [], b = []) {
  const m = new Map();
  for (const s of [...a, ...b]) if (s) m.set(s.key, { ...m.get(s.key), ...s, time: s.time ?? m.get(s.key)?.time ?? null });
  return [...m.values()].sort((x, y) => y.block - x.block || y.logIndex - x.logIndex);
}
/** A deterministic tilt (-3..3 degrees) for a note on the wall, from its log key. */
export function noteTilt(key) {
  let h = 0;
  for (const c of String(key)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return ((h % 61) - 30) / 10;
}
/** "just now" · "4 min ago" · "2 h ago" · "3 days ago". */
export function agoText(sec, nowSec) {
  if (sec == null) return "";
  const s = Math.max(0, Math.floor(nowSec) - Number(sec));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86_400);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

// ---------- reading the logs ----------
const hexNum = (v) => (v == null || v === "" ? 0 : typeof v === "number" ? v : String(v).startsWith("0x") ? parseInt(v, 16) : Number(v));
/** Blockscout's Etherscan-style log rows -> logs shaped like eth_getLogs (with timeStamp in seconds). */
export function parseBlockscoutLogs(json) {
  if (!json || !Array.isArray(json.result)) {
    if (json?.status === "0" && /no (records|logs)/i.test(String(json.message))) return [];
    throw new Error(String(json?.message ?? json?.result ?? "unexpected explorer answer"));
  }
  return json.result.map((r) => ({
    address: r.address, topics: (r.topics ?? []).filter((t) => t != null), data: r.data,
    blockNumber: hexNum(r.blockNumber), logIndex: hexNum(r.logIndex), transactionHash: r.transactionHash, timeStamp: hexNum(r.timeStamp),
  }));
}
/** The Blockscout URL for a contract's logs with these topics (topic0 first; null = any): LokalPots unless `address` says otherwise. */
export function blockscoutLogsUrl(topics, fromBlock = LOKAL_POTS_BLOCK, address = LOKAL_POTS) {
  const q = new URLSearchParams({ module: "logs", action: "getLogs", address, fromBlock: String(fromBlock), toBlock: "latest" });
  const set = topics.map((t, i) => [i, t]).filter(([, t]) => t != null);
  for (const [i, t] of set) q.set(`topic${i}`, t);
  for (let k = 1; k < set.length; k++) q.set(`topic${set[k - 1][0]}_${set[k][0]}_opr`, "and");
  return `${BLOCKSCOUT_RPC_API}?${q}`;
}
async function rpcCall(method, params, { rpcUrl = RPC, fetchJson = getJson } = {}) {
  const j = await fetchJson(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), cache: "no-store" });
  if (j?.error) throw new Error(String(j.error.message ?? "RPC error"));
  return j?.result;
}
/** The latest block: { number, timestamp } (the chain's clock). */
export async function latestBlock(opts) {
  const b = await rpcCall("eth_getBlockByNumber", ["latest", false], opts);
  return { number: hexNum(b.number), timestamp: hexNum(b.timestamp) };
}
/** eth_getLogs on LokalPots over [from, to] (at most LOG_RANGE blocks). */
export async function potLogs(topics, from, to, opts) {
  const logs = await rpcCall("eth_getLogs", [{ address: LOKAL_POTS, topics, fromBlock: "0x" + Math.max(0, from).toString(16), toBlock: "0x" + to.toString(16) }], opts);
  return (logs ?? []).map((l) => ({ ...l, blockNumber: hexNum(l.blockNumber), logIndex: hexNum(l.logIndex), blockTimestamp: l.blockTimestamp != null ? hexNum(l.blockTimestamp) : undefined }));
}
/** Fills in `time` for sprays read over RPC: the log's blockTimestamp if the node gave one, else the block's (a few lookups at most). */
async function withTimes(sprays, opts, max = 12) {
  const need = [...new Set(sprays.filter((s) => s.time == null).map((s) => s.block))].slice(0, max);
  const times = new Map();
  await Promise.all(need.map(async (n) => {
    try { const b = await rpcCall("eth_getBlockByNumber", ["0x" + n.toString(16), false], opts); times.set(n, hexNum(b.timestamp)); } catch { /* left without a time */ }
  }));
  return sprays.map((s) => (s.time == null && times.has(s.block) ? { ...s, time: times.get(s.block) } : s));
}
/**
 * Every spray into pot `potId`, newest first, and the block they were read up to: { sprays, toBlock, source }.
 * Blockscout's log API first (the whole history in one request), else eth_getLogs on Forno walking back from the
 * latest block in LOG_RANGE steps (at most `maxChunks`, never before the pot could have opened).
 */
export async function loadPotSprays(potId, { closesAt = null, maxChunks = 12, fetchJson = getJson, rpcUrl = RPC } = {}) {
  const topics = [TOPIC.PotPaid, topicOf(potId)];
  const opts = { fetchJson, rpcUrl };
  const head = await latestBlock(opts);
  try {
    const logs = parseBlockscoutLogs(await fetchJson(blockscoutLogsUrl(topics), { cache: "no-store" }));
    return { sprays: mergeSprays(logs.map((l) => sprayOf(l))), toBlock: head.number, source: "explorer" };
  } catch { /* the explorer is down or slow: read the chain directly */ }
  // a pot opens at most 14 days before it closes; blocks are about a second apart on Celo
  const opened = closesAt != null ? Math.max(LOKAL_POTS_BLOCK, head.number - Math.max(0, head.timestamp - (closesAt - POT_MAX_OPEN_SECONDS)) - LOG_RANGE) : LOKAL_POTS_BLOCK;
  let sprays = [];
  for (let i = 0, to = head.number; i < maxChunks && to >= opened; i++, to -= LOG_RANGE) {
    const from = Math.max(opened, to - LOG_RANGE + 1);
    sprays = mergeSprays(sprays, (await potLogs(topics, from, to, opts)).map((l) => sprayOf(l)));
  }
  return { sprays: await withTimes(sprays, opts), toBlock: head.number, source: "chain" };
}
/** New sprays since block `after` (exclusive), straight from Forno: { sprays, toBlock }. */
export async function pollPotSprays(potId, after, { fetchJson = getJson, rpcUrl = RPC } = {}) {
  const opts = { fetchJson, rpcUrl };
  const head = await latestBlock(opts);
  if (head.number <= after) return { sprays: [], toBlock: after };
  const from = Math.max(after + 1, head.number - LOG_RANGE + 1);
  const logs = await potLogs([TOPIC.PotPaid, topicOf(potId)], from, head.number, opts);
  return { sprays: await withTimes(logs.map((l) => sprayOf(l, l.blockTimestamp)).filter(Boolean), opts), toBlock: head.number };
}
/**
 * The pots `host` opened, newest first: [{ potId, title, ... }] from PotCreated logs on Blockscout; if the explorer
 * can't answer, the contract itself is asked about its latest `scan` pots (potInfo for each, keeping the host's).
 */
export async function loadHostPots(host, { scan = 40, fetchJson = getJson, rpcUrl = RPC } = {}) {
  try {
    const logs = parseBlockscoutLogs(await fetchJson(blockscoutLogsUrl([TOPIC.PotCreated, null, topicOf(host)]), { cache: "no-store" }));
    return logs.map(decodePotCreated).filter((p) => p && lc(p.host) === lc(host)).sort((a, b) => (b.potId > a.potId ? 1 : -1));
  } catch { /* fall back to the contract */ }
  const opts = { fetchJson, rpcUrl };
  const count = Number(await readPotCount(opts));
  const ids = [];
  for (let id = count; id >= 1 && ids.length < scan; id--) ids.push(id);
  const infos = await Promise.all(ids.map((id) => readPotInfo(id, opts).then((i) => ({ potId: BigInt(id), ...i })).catch(() => null)));
  return infos.filter((p) => p && lc(p.host) === lc(host));
}
/** The token address for a spray code ("usdt" | "cngn" | "idrx" | "wars" | "wcop"). */
export const sprayToken = (code) => (code === "usdt" ? USDT_ADDRESS : CURRENCIES.find((c) => c.code === code)?.address ?? USDT_ADDRESS);
