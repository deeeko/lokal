// The notification bell's data: the signed-in wallet's own INCOMING payments, newest first, as one-line items.
// The bell itself (the button, the small dropdown) is assets/bell.js; this file is pure or takes its I/O as arguments,
// with no window/document access at the top level, so it is unit-tested in Node (test/notifications.test.mjs).
//
// Four kinds, each from a read the site already makes:
//   - "payout": the agent paid this wallet (my-activity.js rows, kind "payout") -> its receipt (receipt.html#NP-…);
//   - "tag": a payment to this wallet's LokalPay tag arrived (TagPaid logs whose recipient is this wallet) -> Activity;
//   - "pot": a guest sprayed into a pot this wallet hosts (PotPaid logs whose host is this wallet) -> pot.html?id=N;
//   - "refund": the agent sent a payment back to this wallet (an agent transfer that returns exactly the token and
//     amount this wallet sent it earlier) -> the refund transaction on Celoscan, with its RF- number.
// Never a payer's address: items say "a payment", or the user's own @tag when the event is about that tag.
//
// Unread: only a "last seen" marker (a time in seconds) per signed-in wallet is kept, in localStorage under
// SEEN_KEY. It is functional, like the sign-in, so it doesn't wait for the layout consent. No amounts, no history,
// nobody else's address. Without storage it lives in memory for the page, so everything is new on each visit.
import { CURRENCIES, TOKENS, formatCurrencyUnits, formatCurrency, num2, receiptNo, celoscanTx, getJson } from "./core.js";
import { LOKAL_TAGS, LOKAL_POTS, LOKAL_TAGS_BLOCK, LOKAL_POTS_BLOCK, TOPIC, topicOf, decodeTagPaid, decodePotPaid } from "./lokal-contracts.js";
import { blockscoutLogsUrl, parseBlockscoutLogs, usd6Text, loadHostPots } from "./pots.js";
import { sharedActivity } from "./my-activity.js";

export const SEEN_KEY = "np-notif-seen";
/** How many items the dropdown lists. */
export const SHOWN = 5;
/** How often the bell checks while the tab is visible. */
export const POLL_MS = 60_000;
/** A returned transfer counts as a refund only within this long of the payment it returns. */
export const REFUND_WINDOW_SEC = 30 * 86_400;

const lc = (s) => String(s ?? "").toLowerCase();
const HASH_RE = /^0x[0-9a-f]{64}$/i;
const secOf = (t) => {
  if (t == null || t === "") return null;
  const n = typeof t === "number" ? t : /^\d+$/.test(String(t)) ? Number(t) : Date.parse(t) / 1000;
  return Number.isFinite(n) ? Math.floor(n) : null;
};
/** "RF-XXXX-XXXX" for a refund transaction (the agent's own numbering, lib/status.mjs refundNo). */
export const refundNo = (hash) => "RF-" + String(hash).slice(2, 6).toUpperCase() + "-" + String(hash).slice(6, 10).toUpperCase();

// ---------- amounts, the way people say them ----------
/** A token amount (a number in whole tokens) -> "$10", "$9.70", "₦14,407.67", "Rp 91,967" (rounded down). */
export function moneyText(symbol, amount) {
  const c = CURRENCIES.find((x) => x.token === symbol);
  if (c) return formatCurrency(amount, c.code);
  const cents = Math.floor(Number(amount) * 100 + 1e-7);
  return "$" + (cents % 100 ? num2.format(cents / 100) : Math.floor(cents / 100).toLocaleString("en-US"));
}
/** A token amount in its smallest units (bigint) for a token address -> the same words, or null for an unknown token. */
export function unitsText(tokenAddress, units) {
  const t = Object.values(TOKENS).find((x) => lc(x.address) === lc(tokenAddress));
  if (!t) return null;
  if (t.currency) return formatCurrencyUnits(BigInt(units), t.currency);
  return usd6Text(BigInt(units) * 10n ** 6n / 10n ** BigInt(t.decimals));
}

// ---------- events -> items ----------
/**
 * The hashes of the agent's transfers to this wallet that are refunds: each returns exactly the token and amount this
 * wallet sent the agent earlier (within REFUND_WINDOW_SEC), one refund per payment. Payouts never match: they are
 * converted, and the agent keeps its margin. rows: my-activity.js activityRows().
 */
export function refundHashes(rows = []) {
  const byTime = [...rows].filter((r) => r && (r.kind === "sent" || r.kind === "payout") && r.token && Number.isFinite(r.amount))
    .sort((a, b) => (secOf(a.time) ?? 0) - (secOf(b.time) ?? 0));
  const open = new Map(); // "token|amount" -> [times of payments not yet matched]
  const out = new Set();
  for (const r of byTime) {
    const key = `${r.token}|${r.amount.toFixed(6)}`;
    const t = secOf(r.time) ?? 0;
    if (r.kind === "sent") { open.set(key, [...(open.get(key) ?? []), t]); continue; }
    const list = (open.get(key) ?? []).filter((s) => t >= s && t - s <= REFUND_WINDOW_SEC);
    if (!list.length) continue;
    out.add(lc(r.hash));
    const used = list[0];
    const all = open.get(key);
    all.splice(all.indexOf(used), 1);
  }
  return out;
}

/**
 * Everything incoming for `address`, newest first: [{ id, kind ("payout" | "tag" | "pot" | "refund"), text, href,
 * external (true for a Celoscan link), time (seconds or null) }]. Pure. Inputs:
 *   rows: my-activity.js rows for this wallet; tagLogs / potLogs: TagPaid / PotPaid logs (Blockscout or eth_getLogs
 *   shape); potTitles: Map(potId string -> title). Logs not addressed to this wallet are ignored. No item carries an
 *   address: payers are never named, and a TagPaid names only this wallet's own tag.
 */
export function toNotifications({ address, rows = [], tagLogs = [], potLogs = [], potTitles = new Map() } = {}) {
  const me = lc(address);
  const items = [];
  const refunds = refundHashes(rows);
  for (const r of rows) {
    if (r?.kind !== "payout" || !HASH_RE.test(String(r.hash)) || !r.token) continue;
    const time = secOf(r.time);
    if (refunds.has(lc(r.hash))) {
      items.push({ id: `refund:${lc(r.hash)}`, kind: "refund", text: `Refunded ${moneyText(r.token, r.amount)} · ${refundNo(r.hash)}`, href: celoscanTx(r.hash), external: true, time });
    } else {
      items.push({ id: `payout:${lc(r.hash)}`, kind: "payout", text: `You received ${moneyText(r.token, r.amount)}`, href: `receipt.html#${receiptNo(r.hash)}`, external: false, time });
    }
  }
  for (const log of tagLogs) {
    let p = null;
    try { p = decodeTagPaid(log); } catch { p = null; }
    if (!p || lc(p.recipient) !== me) continue;
    const amount = unitsText(p.token, p.amount);
    const tag = String(p.tag ?? "").replace(/[^a-z0-9_-]/gi, "").slice(0, 40);
    items.push({ id: `tag:${lc(p.hash)}:${p.logIndex}`, kind: "tag",
      text: `${tag ? "@" + tag : "Your tag"} was paid ${amount ?? "a payment"}, payout on its way`, href: "transactions.html", external: false,
      time: secOf(log.timeStamp ?? log.blockTimestamp) });
  }
  for (const log of potLogs) {
    let p = null;
    try { p = decodePotPaid(log); } catch { p = null; }
    if (!p || lc(p.recipient) !== me) continue;
    const id = p.potId.toString();
    const title = String(potTitles.get(id) ?? "").trim();
    items.push({ id: `pot:${lc(p.hash)}:${p.logIndex}`, kind: "pot",
      text: `${usd6Text(p.amountUsd6)} sprayed into ${title || `your pot #${id}`}`, href: `pot.html?id=${id}`, external: false,
      time: secOf(log.timeStamp ?? log.blockTimestamp) });
  }
  return items.sort((a, b) => (b.time ?? 0) - (a.time ?? 0));
}

// ---------- unread: one "last seen" time per wallet ----------
const memorySeen = new Map(); // used when localStorage is blocked: new on every visit, cleared on the page after opening
/** The stored map { address: seconds } from `storage` (localStorage), or {} when blocked or malformed. */
function readMap(storage) {
  try {
    const v = JSON.parse(storage?.getItem(SEEN_KEY) ?? "null");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}
/** The wallet's "last seen" time in seconds, or null when it has none (everything is new). */
export function readSeen(storage, address) {
  const v = readMap(storage)[lc(address)];
  const mem = memorySeen.get(lc(address));
  const stored = Number.isFinite(v) && v >= 0 ? v : null;
  if (stored == null) return mem ?? null;
  return mem != null && mem > stored ? mem : stored;
}
/** Marks everything up to `sec` as seen for the wallet. Keeps at most `keep` wallets. Never stores anything else. */
export function markSeen(storage, address, sec, { keep = 5 } = {}) {
  if (!Number.isFinite(sec)) return;
  const key = lc(address);
  const prev = readSeen(storage, address);
  const next = Math.max(prev ?? 0, Math.floor(sec));
  memorySeen.set(key, next);
  try {
    const map = readMap(storage);
    map[key] = next;
    const kept = Object.entries(map).filter(([k, v]) => /^0x[0-9a-f]{40}$/.test(k) && Number.isFinite(v))
      .sort((a, b) => (a[0] === key ? -1 : b[0] === key ? 1 : b[1] - a[1])).slice(0, keep);
    storage.setItem(SEEN_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch { /* storage blocked: the in-memory marker covers this page */ }
}
/** Forgets the in-memory markers (tests). */
export const clearMemorySeen = () => memorySeen.clear();
/** How many items are newer than `seen` (null: all of them). */
export const unreadCount = (items = [], seen = null) => items.filter((i) => seen == null || (i.time ?? 0) > seen).length;
/** The badge: "" at 0, "1"–"9", then "9+". */
export const badgeText = (n) => (!(n > 0) ? "" : n > 9 ? "9+" : String(Math.floor(n)));
/** The bell's accessible name. */
export const bellLabel = (n) => (n > 0 ? `Notifications, ${Math.floor(n)} new` : "Notifications");
/** The newest time among the items (what opening the dropdown marks as seen), or null. */
export const newestTime = (items = []) => items.reduce((m, i) => (i.time != null && (m == null || i.time > m) ? i.time : m), null);

// ---------- polling: on load, then every POLL_MS while the tab is visible ----------
/**
 * A poller with injected timers and visibility (so it is tested without a browser). run() is awaited; a run never
 * overlaps another. While hidden no timer is pending; on becoming visible it runs at once if the last run is older
 * than `interval`, else when the rest of the interval has passed.
 *   timers: { set(fn, ms) -> id, clear(id) }; isVisible(): boolean; onVisibility(cb) -> unsubscribe; now(): ms.
 */
export function createPoller({ run, interval = POLL_MS, firstDelay = 0, timers, isVisible = () => true, onVisibility = () => () => {}, now = Date.now }) {
  let timer = null, last = null, running = false, stopped = true, unsub = null;
  const clear = () => { if (timer != null) { timers.clear(timer); timer = null; } };
  const schedule = (ms) => { clear(); if (!stopped && isVisible()) timer = timers.set(tick, Math.max(0, ms)); };
  async function tick() {
    timer = null;
    if (stopped || running || !isVisible()) return;
    running = true;
    last = now();
    try { await run(); } catch { /* the caller shows its own quiet error */ }
    running = false;
    schedule(interval);
  }
  const onVis = () => {
    if (stopped) return;
    if (!isVisible()) { clear(); return; }
    if (running || timer != null) return;
    schedule(last == null ? 0 : interval - (now() - last));
  };
  return {
    start() { if (!stopped) return; stopped = false; unsub = onVisibility(onVis); schedule(firstDelay); },
    stop() { stopped = true; clear(); unsub?.(); unsub = null; },
    /** Runs now (when visible and not already running), then keeps the usual rhythm. */
    refresh() { if (!stopped && !running && isVisible()) { clear(); tick(); } },
    get pending() { return timer != null; },
    get running() { return running; },
  };
}

// ---------- the reads ----------
const titles = new Map(); // host (lowercase) -> { at, map }: pot titles change rarely, kept for 10 minutes in memory
const logsCache = new Map(); // url -> { at, promise }: one read per minute even when several things ask
const LOGS_MS = 55_000;
function cachedLogs(url, fetchJson, now) {
  const hit = logsCache.get(url);
  if (hit && now() - hit.at < LOGS_MS) return hit.promise;
  const entry = { at: now(), promise: null };
  entry.promise = Promise.resolve().then(() => fetchJson(url, { cache: "no-store" })).then(parseBlockscoutLogs).catch((e) => {
    if (logsCache.get(url) === entry) logsCache.delete(url);
    throw e;
  });
  logsCache.set(url, entry);
  return entry.promise;
}
/** Forgets the cached log reads and titles (tests). */
export const clearNotificationCache = () => { logsCache.clear(); titles.clear(); };

/** The Blockscout URLs for the wallet's TagPaid (as recipient) and PotPaid (as host) logs: topic2 is that address. */
export const tagPaidUrl = (address) => blockscoutLogsUrl([TOPIC.TagPaid, null, topicOf(address)], LOKAL_TAGS_BLOCK, LOKAL_TAGS);
export const potPaidUrl = (address) => blockscoutLogsUrl([TOPIC.PotPaid, null, topicOf(address)], LOKAL_POTS_BLOCK, LOKAL_POTS);

/**
 * Reads everything for the bell: the shared my-activity rows (one page, or a bigger read already made on this page),
 * the wallet's TagPaid and PotPaid logs (one explorer request each), and pot titles only when there is a spray.
 * Resolves { items, partial }. Throws only when every read failed.
 */
export async function loadNotifications(address, { fetchJson = getJson, now = Date.now, activity = sharedActivity, hostPots = loadHostPots } = {}) {
  const [act, tag, pot] = await Promise.allSettled([
    activity(address, { maxPages: 1 }),
    cachedLogs(tagPaidUrl(address), fetchJson, now),
    cachedLogs(potPaidUrl(address), fetchJson, now),
  ]);
  if (act.status === "rejected" && tag.status === "rejected" && pot.status === "rejected") throw act.reason;
  const potLogs = pot.status === "fulfilled" ? pot.value : [];
  let potTitles = new Map();
  if (potLogs.length) {
    const key = lc(address);
    const hit = titles.get(key);
    if (hit && now() - hit.at < 10 * 60_000) potTitles = hit.map;
    else {
      try {
        potTitles = new Map((await hostPots(address, { fetchJson })).map((p) => [String(p.potId), p.title]));
        titles.set(key, { at: now(), map: potTitles });
      } catch { /* "your pot #N" instead of the title */ }
    }
  }
  const items = toNotifications({
    address, rows: act.status === "fulfilled" ? act.value.rows : [], tagLogs: tag.status === "fulfilled" ? tag.value : [], potLogs, potTitles,
  });
  return { items, partial: [act, tag, pot].some((r) => r.status === "rejected") };
}

