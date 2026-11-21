// The status server's shared rules: what autopilot may report, how reports are signed, how they are kept and how the
// daily totals are worked out. Used by api/status.js (Vercel) and src/status-report.mjs (autopilot, on the owner's PC),
// so both sides always agree. Pure apart from node:crypto: no network, no files.
//
// An event is one deposit's status as autopilot knows it (or one direct owner payout), with only fields that are already
// public on Celo, plus the status, a refusal reason CODE (never free text) and the receipt number:
//   { id: "<deposit tx>:<logIndex>" | "<payout tx>:direct", kind: "ntag"|"registration"|"request"|"direct", tag?,
//     registration?, recipient?, token: "USDT"|"cNGN"|"CELO", amount, usd?, status: "received"|"failed"|"refused"|"paid",
//     (paidToken: "USDT" or any local token in the currency registry: "cNGN"|"IDRX"|"wARS"|"wCOP")
//     reason?, receiptNo?, payoutTx?, paidAmount?, paidToken?, depositTx?, payer?, at (ISO, when this status happened) }
import crypto from "node:crypto";
import { ntagError, receiptNo as receiptNoOf, WALLET_DAILY_CAP, DAILY_CAP, CURRENCIES } from "../site/assets/core.js";

export const STATUS_VERSION = 1;
export const MAX_BODY = 64 * 1024; // bytes, per POST
export const MAX_SKEW_SEC = 300; // a signed report is accepted for 5 minutes either side of its timestamp
export const MAX_EVENTS = 100; // per POST
export const KEEP_DAYS = 30;
export const KEEP_MAX = 2000;
export const RECENT_MAX = 50;
export const SUMMARY_PATH = "status/summary.json";
export const DAY_MS = 86_400_000;
export const CAPS = { walletUsd: WALLET_DAILY_CAP, dailyUsd: DAILY_CAP };

export const KINDS = ["ntag", "registration", "request", "direct"];
export const STATUSES = ["received", "failed", "refused", "paid"];
/**
 * A status never goes back: a late or replayed "received" can't hide a "paid". "failed" (the payout hit an error and the
 * owner must retry it) beats "received"; a later "paid" (the retry worked) beats everything. A refused deposit can still
 * be paid by hand.
 */
export const RANK = { received: 0, failed: 1, refused: 2, paid: 3 };
/** Why a payout failed (status "failed"). The owner sees the details on the PC; the site only learns that it failed. */
export const FAILED_REASONS = ["payout_error"];
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
export const TOKENS = ["USDT", "cNGN", "CELO"];
/** What a payout can pay: dollars or any local currency in the registry (paidToken + paidAmount on "paid" events). */
export const PAID_TOKENS = ["USDT", ...CURRENCIES.map((c) => c.token)];
/** Why a deposit was refused. Codes only, so no internal message ever reaches the site. */
export const REASONS = [
  "unknown_tag", "bad_memo", "token_not_accepted", "below_minimum", "over_payment_cap", "over_wallet_cap", "self_payment",
  "recipient_blocked", "claim_invalid", "registration_invalid", "currency_unavailable", "other",
];

const HASH = /^0x[0-9a-f]{64}$/;
const ADDR = /^0x[0-9a-f]{40}$/;
const AMOUNT = /^\d{1,15}(\.\d{1,18})?$/;
const RECEIPT = /^NP-[0-9A-F]{4}-[0-9A-F]{4}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const DEPOSIT_ID = /^(0x[0-9a-f]{64}):(\d{1,6})$/;
const DIRECT_ID = /^(0x[0-9a-f]{64}):direct$/;
const FIELDS = [
  "id", "kind", "tag", "registration", "recipient", "token", "amount", "usd", "status", "reason", "receiptNo", "payoutTx",
  "paidAmount", "paidToken", "depositTx", "payer", "at",
];
const EARLIEST_MS = Date.parse("2024-01-01T00:00:00Z");
const lc = (v) => (typeof v === "string" ? v.toLowerCase() : v);
const round6 = (x) => Math.round(x * 1e6) / 1e6;

/**
 * Checks one reported event strictly. Returns { event } (normalised: lower-case hashes and addresses, fixed key order)
 * or { error } (a short fixed string). Unknown fields, wrong types and inconsistent combinations are all errors.
 */
export function validateEvent(e, nowMs = Date.now()) {
  if (!e || typeof e !== "object" || Array.isArray(e)) return { error: "not an object" };
  for (const k of Object.keys(e)) if (!FIELDS.includes(k)) return { error: "unknown field" };
  const has = (k) => e[k] !== undefined && e[k] !== null;
  const str = (k) => typeof e[k] === "string";
  for (const k of FIELDS) if (has(k) && k !== "usd" && !str(k)) return { error: `bad ${k}` };
  const out = {};
  if (!KINDS.includes(e.kind)) return { error: "bad kind" };
  if (!STATUSES.includes(e.status)) return { error: "bad status" };
  const id = lc(e.id);
  const direct = e.kind === "direct";
  const m = (direct ? DIRECT_ID : DEPOSIT_ID).exec(String(id ?? ""));
  if (!m) return { error: "bad id" };

  if (has("tag")) {
    if (e.kind !== "ntag" && !direct) return { error: "tag not allowed" };
    if (ntagError(e.tag) !== null) return { error: "bad tag" };
  }
  if (has("registration")) {
    if (e.kind !== "registration" || !HASH.test(lc(e.registration))) return { error: "bad registration" };
  } else if (e.kind === "registration") return { error: "bad registration" };
  if (has("recipient")) {
    if (!ADDR.test(lc(e.recipient))) return { error: "bad recipient" };
  } else if (e.status !== "refused") return { error: "bad recipient" };
  if (!TOKENS.includes(e.token)) return { error: "bad token" };
  if (e.token === "CELO" && !direct) return { error: "bad token" };
  if (!str("amount") || !AMOUNT.test(e.amount)) return { error: "bad amount" };
  if (has("usd")) {
    if (typeof e.usd !== "number" || !Number.isFinite(e.usd) || e.usd < 0 || e.usd > 10_000) return { error: "bad usd" };
  } else if (e.status === "paid") return { error: "bad usd" };

  if (e.status === "refused" || e.status === "failed") {
    if (!(e.status === "refused" ? REASONS : FAILED_REASONS).includes(e.reason)) return { error: "bad reason" };
  } else if (has("reason")) return { error: "bad reason" };
  if (e.status === "paid") {
    if (!HASH.test(lc(e.payoutTx))) return { error: "bad payoutTx" };
    if (!RECEIPT.test(String(e.receiptNo)) || e.receiptNo !== receiptNoOf(lc(e.payoutTx))) return { error: "bad receiptNo" };
    if (has("paidAmount") && !AMOUNT.test(e.paidAmount)) return { error: "bad paidAmount" };
    if (has("paidToken") && !PAID_TOKENS.includes(e.paidToken)) return { error: "bad paidToken" };
  } else if (has("payoutTx") || has("receiptNo") || has("paidAmount") || has("paidToken")) return { error: "not paid" };

  if (direct) {
    if (e.status !== "paid" || lc(e.payoutTx) !== m[1]) return { error: "bad direct" };
    if (has("depositTx") || has("payer")) return { error: "bad direct" };
  } else {
    if (lc(e.depositTx) !== m[1]) return { error: "bad depositTx" };
    if (!ADDR.test(lc(e.payer))) return { error: "bad payer" };
  }
  const at = Date.parse(e.at);
  if (!str("at") || !ISO.test(e.at) || !Number.isFinite(at) || at < EARLIEST_MS || at > nowMs + DAY_MS) return { error: "bad at" };

  for (const k of FIELDS) {
    if (!has(k)) continue;
    out[k] = ["id", "registration", "recipient", "payoutTx", "depositTx", "payer"].includes(k) ? lc(e[k]) : k === "usd" ? round6(e[k]) : e[k];
  }
  return { event: out };
}

/**
 * Checks a whole report body { v: 1, ts, events: [...] } (already JSON-parsed). Returns { error } when the body itself is
 * wrong, else { events (the valid ones), rejected (ids of the invalid ones; "#<index>" when an event has no usable id) },
 * so one bad event never blocks the good ones in the same batch.
 */
export function validateReport(body, tsHeader, nowMs = Date.now()) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "invalid body" };
  const keys = Object.keys(body);
  if (keys.length !== 3 || !keys.every((k) => ["v", "ts", "events"].includes(k))) return { error: "invalid body" };
  if (body.v !== STATUS_VERSION || !Number.isInteger(body.ts) || String(body.ts) !== String(tsHeader)) return { error: "invalid body" };
  if (!Array.isArray(body.events) || body.events.length > MAX_EVENTS) return { error: "invalid body" };
  const events = [];
  const rejected = [];
  body.events.forEach((e, i) => {
    const r = validateEvent(e, nowMs);
    if (r.event) events.push(r.event);
    else rejected.push(typeof e?.id === "string" && e.id.length <= 100 ? e.id.toLowerCase() : `#${i}`);
  });
  return { events, rejected };
}

// ---------- signing ----------
/** hex(HMAC-SHA256(secret, ts + "." + rawBody)). */
export const signReport = (secret, ts, rawBody) => crypto.createHmac("sha256", String(secret)).update(`${ts}.${rawBody}`).digest("hex");

/** True when `sig` is the right signature (timing-safe) and `ts` is within MAX_SKEW_SEC of now. */
export function checkSignature(secret, tsHeader, rawBody, sig, nowSec = Math.floor(Date.now() / 1000)) {
  if (!secret || !/^\d{9,11}$/.test(String(tsHeader ?? "")) || !/^[0-9a-fA-F]{64}$/.test(String(sig ?? ""))) return false;
  if (Math.abs(nowSec - Number(tsHeader)) > MAX_SKEW_SEC) return false;
  const want = Buffer.from(signReport(secret, tsHeader, rawBody), "hex");
  const got = Buffer.from(String(sig), "hex");
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// ---------- the summary blob ----------
export const emptySummary = () => ({ v: STATUS_VERSION, updatedAt: null, deposits: {} });

/** Reads a stored summary defensively: anything malformed is dropped, so one bad write can't break every read. */
export function normalizeSummary(raw, nowMs = Date.now()) {
  const s = emptySummary();
  if (!raw || typeof raw !== "object" || typeof raw.deposits !== "object" || !raw.deposits) return s;
  s.updatedAt = typeof raw.updatedAt === "string" ? raw.updatedAt : null;
  for (const e of Object.values(raw.deposits)) {
    const r = validateEvent(e, nowMs + DAY_MS);
    if (r.event) s.deposits[r.event.id] = r.event;
  }
  return s;
}

/**
 * Applies events to the summary (in place). A later status replaces an earlier one; the same status replaces it only
 * when it is not older. Returns how many entries changed.
 */
export function mergeEvents(summary, events) {
  let n = 0;
  for (const e of events) {
    const cur = summary.deposits[e.id];
    if (cur) {
      if (JSON.stringify(cur) === JSON.stringify(e)) continue; // a repeat: nothing to write
      const r0 = hasOwn(RANK, cur.status) ? RANK[cur.status] : -1, r1 = RANK[e.status];
      if (r1 < r0) continue;
      if (r1 === r0 && Date.parse(e.at) < Date.parse(cur.at)) continue;
    }
    summary.deposits[e.id] = e;
    n++;
  }
  return n;
}

/** Keeps the last KEEP_DAYS days, at most KEEP_MAX entries (newest first). */
export function pruneSummary(summary, nowMs = Date.now()) {
  const keep = Object.values(summary.deposits)
    .filter((e) => Date.parse(e.at) > nowMs - KEEP_DAYS * DAY_MS)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || (a.id < b.id ? -1 : 1))
    .slice(0, KEEP_MAX);
  summary.deposits = Object.fromEntries(keep.map((e) => [e.id, e]));
  return summary;
}

// ---------- totals (worked out on every read, so they can't drift) ----------
/**
 * USD paid out in the 24 hours before `nowMs`, each payout counted once (by payout tx), optionally for one recipient.
 * Returns { usedUsd, payouts: [{ at, usd }] (oldest first) }.
 */
export function paidLast24h(events, nowMs = Date.now(), recipient = null) {
  const who = recipient ? lc(recipient) : null;
  const seen = new Set();
  const payouts = [];
  let used = 0;
  for (const e of events) {
    if (e.status !== "paid" || !e.payoutTx || seen.has(e.payoutTx)) continue;
    const t = Date.parse(e.at);
    if (!(t > nowMs - DAY_MS && t <= nowMs + 60_000)) continue;
    seen.add(e.payoutTx);
    if (who && e.recipient !== who) continue;
    used += e.usd ?? 0;
    payouts.push({ at: e.at, usd: e.usd ?? 0 });
  }
  payouts.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return { usedUsd: round6(used), payouts };
}

const room = (cap, used) => round6(Math.max(0, cap - used));
const newest = (list) => list.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || (a.id < b.id ? -1 : 1)).slice(0, RECENT_MAX);

export function globalTotals(events, nowMs = Date.now()) {
  const { usedUsd } = paidLast24h(events, nowMs);
  return { usedUsd, roomUsd: room(CAPS.dailyUsd, usedUsd), capUsd: CAPS.dailyUsd };
}
export function walletTotals(events, recipient, nowMs = Date.now()) {
  const { usedUsd, payouts } = paidLast24h(events, nowMs, recipient);
  return { usedUsd, roomUsd: room(CAPS.walletUsd, usedUsd), capUsd: CAPS.walletUsd, payouts };
}

/**
 * Parses a GET query: exactly one of tx / recipient / tag, or none (the global totals only).
 * Returns { by: "tx"|"recipient"|"tag"|"global", value } or null when it is not a valid query.
 */
export function parseStatusQuery(q = {}) {
  const pick = (k) => { const v = q[k]; return Array.isArray(v) ? (v.length === 1 ? v[0] : undefined) : v; };
  const keys = Object.keys(q).filter((k) => q[k] !== undefined);
  if (keys.some((k) => !["tx", "recipient", "tag"].includes(k)) || keys.length > 1) return null;
  if (!keys.length) return { by: "global", value: null };
  const by = keys[0];
  const v = pick(by);
  if (typeof v !== "string") return null;
  if (by === "tx") return HASH.test(lc(v)) ? { by, value: lc(v) } : null;
  if (by === "recipient") return ADDR.test(lc(v)) ? { by, value: lc(v) } : null;
  const t = v.replace(/^@/, "");
  return ntagError(t) === null ? { by, value: t } : null;
}

/** The GET answer for a parsed query, from the stored summary. Only public fields leave the server. */
export function statusView(summary, query, nowMs = Date.now()) {
  const all = Object.values(summary.deposits);
  const base = { ok: true, source: "agent", updatedAt: summary.updatedAt, global: globalTotals(all, nowMs) };
  if (query.by === "global") return base;
  if (query.by === "tx") {
    return { ...base, tx: query.value, events: all.filter((e) => e.depositTx === query.value).sort((a, b) => (a.id < b.id ? -1 : 1)) };
  }
  if (query.by === "recipient") {
    return { ...base, recipient: query.value, wallet: walletTotals(all, query.value, nowMs), events: newest(all.filter((e) => e.recipient === query.value)) };
  }
  const mine = all.filter((e) => e.tag === query.value);
  const owner = newest(mine.filter((e) => e.recipient))[0]?.recipient ?? null;
  return { ...base, tag: query.value, recipient: owner, wallet: owner ? walletTotals(all, owner, nowMs) : null, events: newest(mine) };
}
