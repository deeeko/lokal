// Payment requests ("payment links"). The owner creates one with `request`; the payer opens the link
// (site/pay.html#r=...) and sends the EXACT amount; `watch` matches the deposit and pays the contact.
// Each open request gets a unique amount (a 0.01–0.99 cents suffix) so a deposit is matched by token + exact value.
// The link encoding is byte-identical to site/assets/core.js encodeRequest: base64url(UTF-8 JSON), no padding.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { formatUnits, parseUnits } from "viem";
import { REQUESTS_FILE, SITE_URL } from "./config.mjs";
import { getCorridor, parseAmount } from "./guards.mjs";

const CENT = 10_000n; // 0.01 in 6-dp base units
export const MAX_HOURS = 168;

/** Same as core.js encodeRequest / parseRequest. */
export const encodeRequest = (req) => Buffer.from(JSON.stringify(req), "utf8").toString("base64url");

/** Only the public fields go into the link, in a fixed order. */
export function publicRequest(r) {
  const out = { v: 1, id: r.id, name: r.name, amount: r.amount, dir: r.dir, created: r.created, exp: r.exp };
  if (r.note) out.note = r.note;
  return out;
}

export const requestLink = (r) => `${SITE_URL}/pay.html#r=${encodeRequest(publicRequest(r))}`;

export function receiptLink({ payout, swap, requestId }) {
  let u = `${SITE_URL}/receipt.html#p=${payout}`;
  if (swap) u += `&s=${swap}`;
  if (requestId) u += `&r=${requestId}`;
  return u;
}

/** Receipt number (same as core.js receiptNo): "NP-" + first 8 hex chars of the PAYOUT tx hash, upper-case. */
export const receiptNo = (hash) => "NP-" + hash.slice(2, 6).toUpperCase() + "-" + hash.slice(6, 10).toUpperCase();
/** Same as core.js parseReceiptNo: "NP-7F3A-91C2" -> "0x7f3a91c2" (hash prefix), or null. */
export function parseReceiptNo(s) {
  const m = String(s ?? "").trim().toUpperCase().match(/^NP-([0-9A-F]{4})-?([0-9A-F]{4})$/);
  return m ? ("0x" + m[1] + m[2]).toLowerCase() : null;
}
/** Short receipt link: <SITE_URL>/receipt.html#NP-XXXX-XXXX (the page finds the payout by its hash prefix). */
export const receiptNoLink = (no) => `${SITE_URL}/receipt.html#${no}`;

/** "r_" + 8 base36 characters, each uniform (crypto.randomInt, no modulo bias). */
export function newRequestId(randomInt = crypto.randomInt) {
  let s = "";
  for (let i = 0; i < 8; i++) s += randomInt(36).toString(36);
  return `r_${s}`;
}

const TX_HASH = /0x[0-9a-fA-F]{64}/;

/**
 * Why `retry` must NOT re-run this request's payout, or null when it may. Eligible only when: a deposit is recorded,
 * it is not paid, the last attempt saved an error, no retry is marked in progress, and nothing that moves the
 * deposit (swap or payout) was sent. A tx hash in the error text counts as sent (older records saved no hashes).
 */
export function retryBlocker(r) {
  if (!r) return "No request with that id.";
  if (r.paidAt) return `${r.id} is already paid.`;
  if (!r.deposit) return `${r.id} has no recorded deposit; autopilot pays it when the deposit arrives.`;
  if (r.retrying) return `${r.id} has a retry marked in progress since ${r.retrying}. Check its transactions on Celoscan before touching it.`;
  if (!r.error) return `${r.id} has no saved error, so its payout may still be running or may have crashed mid-flow. Check the agent's transactions on Celoscan.`;
  if (r.hashes?.payout || r.hashes?.swap || TX_HASH.test(String(r.error))) {
    return `${r.id} already sent a swap or payout transaction. Retrying could pay twice; check it on Celoscan and settle it by hand.`;
  }
  return null;
}

/** Base units -> "5.03" (always at least 2 decimals). */
export function formatAmount(units) {
  const s = formatUnits(units, 6);
  const [i, f = ""] = s.split(".");
  return `${i}.${f.padEnd(2, "0")}`;
}

/** open | received (deposit matched, payout not done) | paid | expired */
export function requestStatus(r, now = Date.now()) {
  if (r.paidAt) return "paid";
  if (r.deposit) return "received";
  if (now >= r.exp) return "expired";
  return "open";
}

/**
 * Adds a random 0.01–0.99 suffix to `base` so the result differs from every amount in `taken`
 * (amount strings of the other open requests). Candidates above `maxUnits` (a cap, in base units) are skipped.
 */
export function uniqueAmount(base, taken = [], { maxUnits, random = Math.random } = {}) {
  const baseUnits = parseUnits(parseAmount(base), 6);
  const used = new Set(taken.map((a) => parseUnits(String(a), 6)));
  const free = [];
  for (let k = 1n; k <= 99n; k++) {
    const u = baseUnits + k * CENT;
    if (used.has(u)) continue;
    if (maxUnits != null && u > maxUnits) continue;
    free.push(u);
  }
  if (!free.length) {
    throw new Error(
      maxUnits != null && baseUnits + CENT > maxUnits
        ? `Amount ${base} plus the cents suffix would exceed the per-payout cap. Use a smaller amount.`
        : `No unique amount left near ${base}. Close or let some open requests expire, or pick another amount.`,
    );
  }
  return formatAmount(free[Math.floor(random() * free.length) % free.length]);
}

/**
 * Builds a new request record (pure). `existing` is the current list, used for amount uniqueness. `reserved` = extra
 * amount strings to avoid in the same corridor (e.g. active "Get paid" registrations), so no deposit can match both.
 */
export function createRequest({ name, amount, corridor = "usdt-cngn", note, hours = 48, now = Date.now(), existing = [], maxUnits, random, randomInt, reserved = [] } = {}) {
  const c = getCorridor(corridor);
  const display = String(name ?? "").trim();
  if (!display || display.length > 40) throw new Error("Name must be 1–40 characters.");
  const h = Number(hours);
  if (!Number.isFinite(h) || h <= 0 || h > MAX_HOURS) throw new Error(`--hours must be between 0 and ${MAX_HOURS}.`);
  const n = note == null ? undefined : String(note).trim();
  if (n && n.length > 80) throw new Error("Note must be 80 characters or fewer.");
  const open = existing.filter((r) => requestStatus(r, now) === "open");
  const ids = new Set(existing.map((r) => r.id));
  let id;
  do id = newRequestId(randomInt); while (ids.has(id));
  return {
    v: 1, id, name: display,
    amount: uniqueAmount(amount, [...open.map((r) => r.amount), ...reserved], { maxUnits, random }),
    dir: c.id, created: now, exp: now + Math.round(h * 3_600_000),
    ...(n ? { note: n } : {}),
  };
}

/**
 * Finds the open request a deposit pays. dep = { token, value (bigint, base units), timeMs }.
 * Matches only when: token == the request's SELL token, value == the exact request amount, the deposit's block time
 * is at/after `created` (second precision) and before `exp`, and the request has no deposit and no payout yet.
 */
export function matchDeposit(dep, requests) {
  const hits = requests.filter((r) => {
    if (r.paidAt || r.deposit) return false;
    let c;
    try { c = getCorridor(r.dir); } catch { return false; }
    if (c.sellToken.address.toLowerCase() !== String(dep.token).toLowerCase()) return false;
    if (parseUnits(String(r.amount), 6) !== BigInt(dep.value)) return false;
    if (dep.timeMs < Math.floor(r.created / 1000) * 1000) return false;
    if (dep.timeMs >= r.exp) return false;
    return true;
  });
  hits.sort((a, b) => a.created - b.created);
  return hits[0] ?? null;
}

export function loadRequests(file = REQUESTS_FILE) {
  if (!fs.existsSync(file)) return [];
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  return Array.isArray(j?.requests) ? j.requests : [];
}

/** Atomic write (tmp + rename) so a crash never leaves a half-written requests file. */
export function saveRequests(list, file = REQUESTS_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ requests: list }, null, 2) + "\n");
  fs.renameSync(tmp, file);
}
