// nTag UI pieces shared by the landing, account and tag pages: the tag card (tilt + holographic sheen), the live
// "find an nTag" search, availability wording, tag suggestions, the QR code and transaction confirmation polling.
// The top level stays free of window/document access so the pure helpers can be tested in Node.
import {
  el, icon, short, ntagUrl, normalizeNtag, ntagError, ntagAvailability, resolveNtags, ownerOf, loadNtagOps, loadReceipt,
  lagos, AGENT, TOKENS, CAP, EXPLORER_API, getJson, rpc, ntagOpFromItem, decodeNtagPayment, celoscanTx, HAS_API, timeoutSignal,
  CURRENCIES, currencyOf, formatCurrency, unitsToDecimal, legacyNtagOps,
} from "./core.js";
import { LOKAL_TAGS, ZERO_ADDRESS, decodePayTagCall, readAvailability, readTagInfo } from "./lokal-contracts.js";
import { avatar } from "./session.js";
import { flagIcon } from "./currency-ui.js";
import { drawQr, shareRow } from "./disclose.js";

const SVG_NS = "http://www.w3.org/2000/svg";
export const sameAddr = (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
/** An Error whose message is already plain language (shown as is, not passed through explainWalletError). */
export const plainError = (message, extra = {}) => Object.assign(new Error(message), { plain: true }, extra);

export function alertBox(kind, iconName, ...children) {
  return el("div", { class: `alert${kind ? " " + kind : ""}`, role: kind === "err" ? "alert" : null }, icon(iconName), el("div", {}, ...children));
}
/** A display name chosen by a tag's owner, isolated so right-to-left or control characters can't reorder the text around it. */
export const nameText = (name) => el("bdi", { class: "nt-dispname" }, String(name ?? ""));

// ---------- the agent's limits (same numbers as src/config.mjs and src/ntag.mjs) ----------
export const LIMITS = { perPayment: CAP, perPersonDay: 25, perDay: 100 };
export const LIMITS_TEXT = `$${LIMITS.perPayment} per payment · $${LIMITS.perPersonDay} per person per day · $${LIMITS.perDay} per day overall`;
/** cNGN payments stop 3% under the per-payment cap: the agent values cNGN with a fresh quote when it pays (its slippage margin). */
export const CNGN_MARGIN_BPS = 300;
export const CNGN_CAP_USD = (CAP * (10000 - CNGN_MARGIN_BPS)) / 10000; // 24.25
/** How far a payout may be from what a deposit should bring and still count as its payout (the agent's slippage limit). */
export const PAYOUT_MARGIN_BPS = 300;
export const REFUSED_NOTE = "Payments over a limit are refused, and the agent doesn't pay out a refused payment automatically.";
export const DAY_MS = 86_400_000;
export const BLOCKSCOUT_API = "https://celo.blockscout.com/api/v2";

// ---------- pure helpers (tested in test/ntag-ui.test.mjs) ----------
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
/** "Nov 2026" from unix seconds, in Lagos time. */
export const monthYear = (sec) => lagos(sec * 1000, { month: "short", year: "numeric" });
/** "21 Dec 2026" from unix seconds, in Lagos time. */
export const dayMonthYear = (sec) => lagos(sec * 1000, { day: "numeric", month: "short", year: "numeric" });

/**
 * The sentence shown for a tag's availability. kind = ntagAvailability(...) result. Returns { text, tone } where tone
 * is "ok" | "warn" | "err" | "muted". `lock` = state.locks.get(tag), `owner` = ownerOf(state, tag).
 */
export function availabilityMessage(tag, kind, { owner = null, lock = null } = {}) {
  switch (kind) {
    case "free": return { text: `@${tag} is available.`, tone: "ok" };
    case "yours": return { text: `@${tag} is already yours.`, tone: "ok" };
    case "taken": return { text: `@${tag} is taken${owner?.owner ? ` by ${short(owner.owner)}` : ""}.`, tone: "err" };
    case "reserved": return { text: `@${tag} is reserved, so nobody can claim it.`, tone: "warn" };
    case "locked": return { text: `@${tag} was released recently. Until ${lock ? dayMonthYear(lock.until) : "the 30-day hold ends"}, only its previous owner can claim it.`, tone: "warn" };
    case "invalid": return { text: `${cap(ntagError(tag) ?? "not a valid tag")}.`, tone: "err" };
    default: return { text: "", tone: "muted" };
  }
}

/** Live rule checklist for the tag input: [{ id, label, ok (true/false/null when empty) }]. */
export function ntagRules(t) {
  const v = String(t ?? "");
  const has = v.length > 0;
  return [
    { id: "len", label: "3 to 20 characters", ok: has ? v.length >= 3 && v.length <= 20 : null },
    { id: "chars", label: "a–z, 0–9 and _", ok: has ? /^[a-z0-9_]+$/.test(v) : null },
    { id: "start", label: "Starts with a letter", ok: has ? /^[a-z]/.test(v) : null },
    { id: "under", label: "No __ and no _ at the end", ok: has ? !v.includes("__") && !v.endsWith("_") : null },
  ];
}

/** Turns what someone typed into tag form as they type: lower-case, no leading @, no spaces, at most 20 characters. */
export const cleanTagInput = (s) => normalizeNtag(s).replace(/\s+/g, "").slice(0, 20);

/**
 * Up to n free tags close to `base` (and the display name, if any), for when the one asked for is taken.
 * Every suggestion passes the tag rules and is "free" in `state` for `address`.
 */
export function suggestNtags(base, name, state, address, n = 3) {
  let b = String(base ?? "").toLowerCase().replace(/[^a-z0-9_]/g, "").replace(/_+/g, "_").replace(/_+$/, "");
  if (!/^[a-z]/.test(b)) b = "n" + b;
  b = b.slice(0, 15).replace(/_+$/, "");
  if (b.length < 2) b = (b + "pay").slice(0, 5);
  const words = String(name ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/).filter((w) => /^[a-z]/.test(w));
  const first = words[0], last = words.length > 1 ? words[words.length - 1] : null;
  const cands = [];
  if (last && last !== b) cands.push(b + last, b + "_" + last, b + "_" + last[0]);
  if (first && first !== b) cands.push(first + "_" + b, first + b);
  cands.push(b + "_ng", b + "ng", "the" + b, b + "01", b + "_pay", b + "hq", b + "x", b + "_07", b + "_9ja", "real" + b);
  for (let i = 2; i <= 99; i++) cands.push(b + String(i).padStart(2, "0"));
  const out = [];
  for (const c of cands) {
    const t = c.slice(0, 20).replace(/_+$/, "");
    if (out.includes(t) || ntagError(t)) continue;
    if (ntagAvailability(state, t, address) !== "free") continue;
    out.push(t);
    if (out.length >= n) break;
  }
  return out;
}

/** "Good morning" / "Good afternoon" / "Good evening", by the hour in Lagos. */
export function greeting(date = new Date()) {
  const h = Number(lagos(date, { hour: "numeric", hourCycle: "h23" }));
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

/** The WhatsApp share link for a tag. */
export function whatsappUrl(tag, url = ntagUrl(tag)) {
  return "https://wa.me/?text=" + encodeURIComponent(`Pay me in dollars on Celo and I receive my own local money. My LokalPay tag is @${tag}: ${url}`);
}

// ---------- payments to a tag: values, eligibility, matching deposits to payouts (pure, tested) ----------
const lc = (s) => String(s ?? "").toLowerCase();
/** "USDT" | "CNGN" | "IDRX" | "WARS" | "WCOP" | null for a token address. */
export const tokenKey = (addr) => {
  if (lc(addr) === lc(TOKENS.USDT.address)) return "USDT";
  const c = CURRENCIES.find((x) => lc(x.address) === lc(addr));
  return c ? c.token.toUpperCase() : null;
};
/** The currency of a local token key ("IDRX" -> the rupiah entry), or null. */
const curOfKey = (key) => CURRENCIES.find((c) => c.token.toUpperCase() === key) ?? null;
/** The payout token for a deposit: USD₮ pays the currency the memo asked for (naira by default), cNGN pays USD₮. */
const buyOf = (token, currency = "cngn") => (token === "USDT" ? (currencyOf(currency ?? "cngn") ?? currencyOf("cngn")).token.toUpperCase() : "USDT");
/** Local money per 1 USD₮ for a currency code from loadRate() (naira also from the older `rate` field). */
const perUsdOf = (rate, code) => Number(rate?.rates?.[code]) || (code === "cngn" ? Number(rate?.rate) : 0);
const byChain = (a, b) => a.block - b.block || a.logIndex - b.logIndex;
/** Strictly later in the chain than d (block, then log index). */
const isAfter = (p, d) => p.block > d.block || (p.block === d.block && p.logIndex > d.logIndex);

/** USD value of a deposit as the agent counts it (cNGN at the cNGN → USD₮ rate), or null without a rate. rate = loadRate(). */
export function depositUsd(token, units, rate) {
  if (token === "USDT") return Number(units) / 1e6;
  const rr = Number(rate?.reverseRate);
  return rr > 0 ? (Number(units) / 1e6) * rr : null;
}
/** USD value of an agent payout (any local currency at its rate, by its own decimals), or null without a rate. */
export function payoutUsd(token, units, rate) {
  if (token === "USDT") return Number(units) / 1e6;
  const c = curOfKey(token);
  const r = c ? perUsdOf(rate, c.code) : 0;
  return r > 0 ? Number(units) / 10 ** c.decimals / r : null;
}
/** Units of the payout token a deposit should bring at today's rate (an estimate), or null without a rate. */
export function expectedPayoutUnits(token, units, rate, currency = "cngn") {
  if (token !== "USDT") {
    const rr = Number(rate?.reverseRate);
    return rr > 0 ? BigInt(Math.floor(Number(units) * rr)) : null;
  }
  const c = currencyOf(currency ?? "cngn") ?? currencyOf("cngn");
  const r = perUsdOf(rate, c.code);
  if (!(r > 0)) return null;
  const micro = BigInt(Math.floor(Number(units) * r)); // 6-decimal units of the local money
  return c.decimals >= 6 ? micro * 10n ** BigInt(c.decimals - 6) : micro / 10n ** BigInt(6 - c.decimals);
}
/**
 * Why the agent would not pay a deposit to a tag automatically, or null: { kind: "self" | "min" | "over", text }.
 * Same rules as depositIneligible in src/ntag.mjs (USD₮ $1-$25; cNGN at least ₦1,000 and worth $1-$25).
 */
export function depositIneligible({ token, units, payer, owner }, rate) {
  if (sameAddr(payer, owner)) return { kind: "self", text: "Sent from the tag's own wallet" };
  const u = BigInt(units);
  if (token === "USDT") {
    if (u < 1_000_000n) return { kind: "min", text: "Below the $1 minimum" };
    if (u > BigInt(LIMITS.perPayment) * 1_000_000n) return { kind: "over", text: `Over $${LIMITS.perPayment} in one payment` };
    return null;
  }
  if (u < 1_000_000_000n) return { kind: "min", text: "Below the ₦1,000 minimum" };
  const v = depositUsd(token, units, rate);
  if (v == null) return null;
  if (v < 1) return { kind: "min", text: "Worth less than $1" };
  if (v > LIMITS.perPayment) return { kind: "over", text: `Worth over $${LIMITS.perPayment} in one payment` };
  return null;
}
const within = (units, expected, bps) => {
  const u = BigInt(units), e = BigInt(expected);
  return e > 0n && (u > e ? u - e : e - u) * 10000n <= e * BigInt(bps);
};
/**
 * Which agent payout belongs to which deposit to a tag.
 *   deposits: [{ hash, logIndex, block, ts (ms), token "USDT"|"CNGN", units (bigint), payer }]
 *   payouts: the agent's transfers to the owner, any token, including the day before the claim:
 *            [{ hash, logIndex, block, ts, token, units }]
 * In chain order, deposits the agent refuses are skipped (self-payment, under the minimum, over $25, or over the owner's
 * $25 a day), and each other deposit takes the earliest unused payout after it, in the other token, whose value is within
 * `marginBps` of what it should bring. Returns the deposits in chain order with
 *   status "paid" (payout), "maybe" (payout, a later payout that can't be pinned to it), "none" or "ineligible" (reason).
 */
export function matchTagLedger({ deposits = [], payouts = [], owner, rate, marginBps = PAYOUT_MARGIN_BPS, dayLimitUsd = LIMITS.perPersonDay }) {
  const ds = [...deposits].sort(byChain);
  const ps = [...payouts].sort(byChain);
  const fits = (p, d) => d.expected != null && p.token === buyOf(d.token, d.currency) && within(p.units, d.expected, marginBps);
  const used = new Set();
  const out = [];
  for (const d0 of ds) {
    const d = { ...d0, usd: depositUsd(d0.token, d0.units, rate), expected: expectedPayoutUnits(d0.token, d0.units, rate, d0.currency), payout: null };
    const why = depositIneligible({ token: d.token, units: d.units, payer: d.payer, owner }, rate);
    if (why) { out.push({ ...d, status: "ineligible", reason: why }); continue; }
    if (d.usd != null) {
      // what the agent already paid this wallet in the 24 hours before the deposit (cNGN payouts valued at today's rate)
      let prior = 0;
      for (const p of ps) if (p.ts <= d.ts && p.ts > d.ts - DAY_MS && !isAfter(p, d)) prior += payoutUsd(p.token, p.units, rate) ?? 0;
      if (prior + d.usd > dayLimitUsd + 0.005) {
        out.push({ ...d, status: "ineligible", reason: { kind: "day", text: `Over $${dayLimitUsd} to this wallet in 24 hours` } });
        continue;
      }
    }
    const p = ps.find((x) => !used.has(x) && isAfter(x, d) && fits(x, d));
    if (p) used.add(p);
    out.push({ ...d, status: p ? "paid" : "none", payout: p ?? null });
  }
  for (const d of out) {
    if (d.status === "paid") {
      // ambiguous when another deposit the agent should pay is still unmatched and this payout would fit it too
      if (out.some((o) => o !== d && o.status === "none" && isAfter(d.payout, o) && fits(d.payout, o))) d.status = "maybe";
    } else if (d.status === "none") {
      const later = ps.find((x) => !used.has(x) && isAfter(x, d) && x.token === buyOf(d.token, d.currency));
      if (later) { d.status = "maybe"; d.payout = later; d.unmatched = true; }
    }
  }
  return out;
}
/** What `owner` can still receive from the agent today: { usedUsd, leftUsd, payouts } from Blockscout transfer items. */
export function allowanceFrom(transfers, { owner, rate, now = Date.now(), cap = LIMITS.perPersonDay }) {
  const payouts = [];
  let used = 0;
  for (const t of transfers) {
    if (!sameAddr(t.from, AGENT) || (owner && !sameAddr(t.to, owner)) || !t.token || t.ts <= now - DAY_MS) continue;
    const v = payoutUsd(t.token, t.units, rate);
    if (v == null) throw new Error("no rate to value the local-money payouts");
    used += v;
    payouts.push({ ts: t.ts, usd: v });
  }
  payouts.sort((a, b) => a.ts - b.ts);
  return { usedUsd: used, leftUsd: Math.max(0, cap - used), capUsd: cap, payouts };
}
/** When (ms) enough of today's payouts drop out of the 24-hour window for `needUsd` to fit, or null if it fits now. */
export function allowanceResetAt(alw, needUsd) {
  if (!alw || needUsd <= alw.leftUsd + 0.005) return null;
  let left = alw.leftUsd;
  for (const p of alw.payouts) {
    left += p.usd;
    if (needUsd <= Math.min(alw.capUsd, left) + 0.005) return p.ts + DAY_MS;
  }
  return alw.payouts.length ? alw.payouts[alw.payouts.length - 1].ts + DAY_MS : null;
}

// ---------- the agent's status server (/api/status, on Vercel only) ----------
// Autopilot reports what it did with each deposit (paid with a receipt, refused with a reason, failed and waiting for
// the owner, or received and paying now) and the day's totals. Pages use it carefully:
//   - a deposit's "paid" / "refused" is final and exact; for "received", "failed" or no record they still read the
//     chain, and a payout found there wins;
//   - "room today" is never taken from the server alone: the page also reads the chain and uses the SMALLER room. The
//     server's numbers count only when they are fresh (updated in the last 5 minutes);
//   - anything odd (not on Vercel, 503, a network error, a malformed answer) means null: the page reads the chain as before.
export const STATUS_SOURCE = { agent: "Live status from the agent", chain: "Estimated from Celo" };
export const REFUND_NOTE = "Your money is safe with the agent and can be sent back to the wallet you paid from. You'll see 'Refunded' here.";
/** The sentence for a refused deposit: "Not paid: <reason>. Your money is safe with the agent ..." */
export const refusedNote = (reason) => `Not paid: ${reasonText(reason).replace(/^./, (c) => c.toLowerCase())}. ${REFUND_NOTE}`;
/** "Refunded · RF-XXXX-XXXX" for a refunded event (the number from the refund transaction when the event has none). */
export function refundedText(ev) {
  const no = ev?.refundNo || (/^0x[0-9a-fA-F]{64}$/.test(String(ev?.refundTx ?? "")) ? "RF-" + ev.refundTx.slice(2, 6).toUpperCase() + "-" + ev.refundTx.slice(6, 10).toUpperCase() : null);
  return no ? `Refunded · ${no}` : "Refunded";
}
/** A refunded event as a line: "Refunded · RF-XXXX-XXXX" with a link to the refund transaction on Celoscan. */
export function refundedLine(ev, cls = "") {
  const tx = /^0x[0-9a-fA-F]{64}$/.test(String(ev?.refundTx ?? "")) ? ev.refundTx : null;
  return el("span", { class: cls }, el("b", {}, refundedText(ev)), tx ? [" · ", el("a", { class: "link", href: celoscanTx(tx) }, "Refund on Celoscan ", icon("ext"))] : null,
    ". The payment went back to the wallet it came from.");
}
export const DELAYED_NOTE = "Payout delayed — the agent's owner has been alerted.";
export const SLOW_NOTE = "Taking longer than usual.";
export const STATUS_FRESH_MS = 5 * 60_000; // server totals older than this are ignored
export const RECEIVED_STALE_MS = 15 * 60_000; // a "received" older than this is treated as unknown
const STATUS_RANK = { received: 0, failed: 1, refused: 2, refunded: 3, paid: 4 }; // same order as lib/status.mjs RANK
const has = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k); // not Object.hasOwn: older phones
const finite = (v) => typeof v === "number" && Number.isFinite(v);
const REASON_TEXT = {
  unknown_tag: "Nobody held this LokalPay tag when the payment arrived",
  bad_memo: "The @tag note on the payment couldn't be read",
  token_not_accepted: "This token isn't accepted for LokalPay tag payments",
  below_minimum: "The payment was below the minimum",
  over_payment_cap: `The payment was over the $${CAP} limit for one payment`,
  over_wallet_cap: `It would have taken this person over $${LIMITS.perPersonDay} in 24 hours`,
  currency_unavailable: "The currency it asked for wasn't available on Textile FX when it arrived (it is never paid in another one)",
  self_payment: "It was sent from the same wallet it pays",
  recipient_blocked: "The agent can't pay this wallet",
  claim_invalid: "The LokalPay tag's claim didn't check out on Celo",
  registration_invalid: "The payment link didn't check out on Celo",
  other: "The agent couldn't pay it automatically",
};
/** A refusal reason code from the status server, in plain words. */
export const reasonText = (code) => (has(REASON_TEXT, code) ? REASON_TEXT[code] : REASON_TEXT.other);

const totalsOk = (t) => t && typeof t === "object" && finite(t.usedUsd) && finite(t.roomUsd) && finite(t.capUsd) && t.capUsd > 0;
const eventOk = (e) => e && typeof e === "object" && typeof e.depositTx === "string" && typeof e.status === "string"
  && has(STATUS_RANK, e.status) && typeof e.at === "string" && (e.id === undefined || typeof e.id === "string");
/** True when a 200 answer has the shape the pages rely on. */
export function statusShapeOk(d) {
  if (!d || typeof d !== "object" || d.ok !== true || d.source !== "agent" || !totalsOk(d.global)) return false;
  if (d.updatedAt != null && typeof d.updatedAt !== "string") return false;
  if (d.events !== undefined && !(Array.isArray(d.events) && d.events.every((e) => e && typeof e === "object"))) return false;
  if (d.wallet != null) {
    if (!totalsOk(d.wallet) || (d.wallet.payouts !== undefined && !Array.isArray(d.wallet.payouts))) return false;
    if ((d.wallet.payouts ?? []).some((p) => !p || typeof p.at !== "string" || !finite(p.usd))) return false;
  }
  return true;
}

/**
 * Asks the agent's status server. params: { tx } | { recipient } | { tag } | {} (today's overall total). Resolves the
 * answer, or null whenever it can't help: callers then read the chain exactly as before. opts.force/fetchImpl: tests.
 */
export async function agentStatus(params = {}, { fetchImpl = globalThis.fetch, force = false, base = "/api/status", ms = 6000 } = {}) {
  if ((!HAS_API && !force) || typeof fetchImpl !== "function") return null;
  try {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== "")).toString();
    const r = await fetchImpl(qs ? `${base}?${qs}` : base, { headers: { accept: "application/json" }, signal: timeoutSignal(ms) });
    if (!r || r.status !== 200) return null;
    const d = await r.json();
    if (!statusShapeOk(d)) return null;
    // keep only well-formed events, so callers never trip over a bad one
    return Array.isArray(d.events) ? { ...d, events: d.events.filter(eventOk) } : d;
  } catch {
    return null;
  }
}
/** True when the server's totals were updated within STATUS_FRESH_MS of `nowMs`. */
export function statusFresh(answer, nowMs = Date.now(), maxAgeMs = STATUS_FRESH_MS) {
  const t = Date.parse(answer?.updatedAt ?? "");
  return Number.isFinite(t) && nowMs - t <= maxAgeMs && t - nowMs <= 60_000;
}

/**
 * This deposit's event in a ?tx= answer (the furthest along), or null. A transaction can hold several transfers, so it
 * matches on the full id "<tx>:<logIndex>" when the log index is known; otherwise on what is known of the deposit:
 * match = { logIndex, kind, tag, registration, amount (decimal string or 6-dp units) }.
 */
export function depositStatus(answer, hash, match = {}) {
  const h = String(hash ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(h) || !Array.isArray(answer?.events)) return null;
  const units = match.amount == null ? null : typeof match.amount === "bigint" ? match.amount : units6Of(match.amount);
  const list = answer.events.filter((e) => {
    if (!eventOk(e) || e.depositTx !== h) return false;
    if (match.logIndex != null) return e.id === `${h}:${Number(match.logIndex)}`;
    if (match.kind && e.kind !== match.kind) return false;
    if (match.tag && e.tag !== match.tag) return false;
    if (match.registration && String(e.registration ?? "") !== String(match.registration).toLowerCase()) return false;
    if (units != null && units6Of(e.amount) !== units) return false;
    return true;
  });
  list.sort((a, b) => STATUS_RANK[b.status] - STATUS_RANK[a.status]);
  return list[0] ?? null;
}
/** A "received" so old that the payout should have happened: show it as unknown ("taking longer than usual"). */
export const receivedStale = (ev, nowMs = Date.now()) => ev?.status === "received" && !(nowMs - Date.parse(ev.at) < RECEIVED_STALE_MS);
/** A status that is final: no chain check can change it ("paid" with a receipt, "refused", or "refunded"). */
export const statusFinal = (ev) => ev?.status === "paid" || ev?.status === "refused" || ev?.status === "refunded";

const clampRoom = (v, cap) => Math.min(cap, Math.max(0, v));
/**
 * The server's allowance in the shape allowanceFrom returns, from a ?recipient= or ?tag= answer, or null when there is
 * none or it is stale (older than STATUS_FRESH_MS). Rooms are clamped to [0, cap]. globalLeftUsd: what the agent can
 * still pay out today across everyone.
 */
export function allowanceFromStatus(answer, { nowMs = Date.now() } = {}) {
  const w = answer?.wallet, g = answer?.global;
  if (!totalsOk(w) || !totalsOk(g) || !statusFresh(answer, nowMs)) return null;
  const payouts = (Array.isArray(w.payouts) ? w.payouts : []).map((p) => ({ ts: Date.parse(p?.at), usd: Number(p?.usd) || 0 }))
    .filter((p) => Number.isFinite(p.ts));
  payouts.sort((a, b) => a.ts - b.ts);
  const used = Math.max(0, w.usedUsd);
  return {
    usedUsd: used, leftUsd: clampRoom(Math.min(w.roomUsd, w.capUsd - used), w.capUsd), capUsd: w.capUsd, payouts,
    globalLeftUsd: clampRoom(g.roomUsd, g.capUsd), source: "agent",
  };
}
/** Overall room from a global answer when fresh: { usedUsd, leftUsd, capUsd } or null. */
export function globalFromStatus(answer, { nowMs = Date.now() } = {}) {
  const g = answer?.global;
  if (!totalsOk(g) || !statusFresh(answer, nowMs)) return null;
  const used = Math.max(0, g.usedUsd);
  return { usedUsd: used, leftUsd: clampRoom(Math.min(g.roomUsd, g.capUsd - used), g.capUsd), capUsd: g.capUsd };
}
/**
 * Room today from the server (allowanceFromStatus / globalFromStatus, or null) and from the chain (allowanceFrom, or
 * null when it couldn't be read). Uses the LARGER amount used, so the SMALLER room. exact (drop "about") only when both
 * were read and they agree, or the server is the stricter of the two. Returns null when neither is known.
 */
export function combineAllowance(server, chain) {
  const chainOk = chain && !chain.error && finite(chain.usedUsd);
  if (!server && !chainOk) return null;
  if (!server) return { ...chain, leftUsd: clampRoom(chain.leftUsd, chain.capUsd), exact: false, source: "chain" };
  if (!chainOk) return { ...server, exact: false, source: "agent" };
  const cap = Math.min(server.capUsd, chain.capUsd);
  const serverStricter = server.usedUsd >= chain.usedUsd - 0.005;
  const agree = Math.abs(server.usedUsd - chain.usedUsd) < 0.01;
  const used = Math.max(server.usedUsd, chain.usedUsd);
  const out = {
    usedUsd: used, leftUsd: clampRoom(cap - used, cap), capUsd: cap,
    payouts: serverStricter ? server.payouts ?? chain.payouts : chain.payouts ?? server.payouts,
    exact: agree || serverStricter, source: serverStricter ? "agent" : "chain",
  };
  if (finite(server.globalLeftUsd)) out.globalLeftUsd = server.globalLeftUsd;
  return out;
}
/** What a paid event says the recipient got, e.g. "₦14,400.00 in cNGN", "Rp 91,967 in IDRX" or "10.00 USD₮", or null. */
export function paidText(ev) {
  const n = Number(ev?.paidAmount);
  if (!ev?.paidAmount || !Number.isFinite(n)) return null;
  const c = CURRENCIES.find((x) => x.token === ev.paidToken);
  if (c) return `${formatCurrency(n, c.code)} in ${c.token}`;
  return `${n.toFixed(2)} USD₮`;
}
/** A payout's base units of a token key ("IDRX") as "Rp 91,967 in IDRX" (rounded down), or "10.00 USD₮". */
export function payoutText(token, units) {
  const c = curOfKey(token);
  if (!c) return `${(Number(units) / 1e6).toFixed(2)} USD₮`;
  return `${formatCurrency(Number(unitsToDecimal(units, c.decimals, c.places)), c.code)} in ${c.token}`;
}
/** Deposit amount (decimal string) -> 6-decimal base units, or 0n. */
export function units6Of(amount) {
  const m = /^(\d+)(?:\.(\d{1,18}))?$/.exec(String(amount ?? ""));
  return m ? BigInt(m[1]) * 1_000_000n + BigInt(((m[2] ?? "") + "000000").slice(0, 6)) : 0n;
}
/** The small "where this status comes from" line. */
export const sourceNote = (fromAgent, cls = "micro muted nt-source") => el("span", { class: cls }, fromAgent ? STATUS_SOURCE.agent : STATUS_SOURCE.chain);

// ---------- the ring mark ----------
export function ringMark(cls = "ntag-ring") {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", cls);
  svg.setAttribute("viewBox", "0 0 32 32");
  svg.setAttribute("aria-hidden", "true");
  const ring = (cx, cy, color) => {
    const c = document.createElementNS(SVG_NS, "circle");
    c.setAttribute("cx", cx); c.setAttribute("cy", cy); c.setAttribute("r", "9.2");
    c.setAttribute("fill", "none"); c.setAttribute("stroke", color); c.setAttribute("stroke-width", "2.6");
    return c;
  };
  svg.append(ring(12.6, 19.4, "#6ff0b0"), ring(19.4, 12.6, "#fcff52"));
  return svg;
}

// ---------- the nTag card ----------
/**
 * Builds the card. props: { tag, name, address, since (sec), currency (the owner's preferred currency code, optional),
 * kind: "live" | "preview" | "ghost", stamp (text), as: "div" | "button" | "a", href, label (accessible name) }.
 * Returns the element; call card.update(props) to change it.
 */
export function ntagCard(props = {}) {
  const as = props.as ?? "div";
  const handle = el("span", { class: "ntag-handle" });
  const name = el("span", { class: "ntag-name" });
  const addr = el("span", { class: "ntag-addr" });
  const since = el("span", { class: "ntag-since" });
  const net = el("span", { class: "ntag-net" }, "Celo");
  const stampText = el("span", {});
  const stampCheck = icon("check");
  const stamp = el("span", { class: "ntag-stamp", "aria-hidden": "true" }, stampCheck, stampText);
  const front = el("div", { class: "ntag-face ntag-front" },
    el("span", { class: "ntag-guilloche" }),
    el("div", { class: "ntag-top" }, el("span", { class: "ntag-brand" }, ringMark(), "LokalPay tag"), net),
    el("div", { class: "ntag-main" }, handle, name),
    el("div", { class: "ntag-bottom" }, addr, since),
    el("span", { class: "ntag-sheen" }), el("span", { class: "ntag-glare" }));
  const back = el("div", { class: "ntag-face ntag-back", "aria-hidden": "true" },
    el("span", { class: "ntag-guilloche" }), ringMark("ntag-ring lg"), el("span", { class: "ntag-back-line" }, "Pay by name on Celo"),
    el("span", { class: "ntag-sheen" }));
  const attrs = { class: "ntag-card" };
  if (as === "button") attrs.type = "button";
  if (as === "a") attrs.href = props.href;
  const card = el(as, attrs, el("div", { class: "ntag-tilt" }, el("div", { class: "ntag-flip" }, front, back), stamp));
  if (as === "div") card.setAttribute("aria-hidden", "true"); // decorative: the same facts are on the page as text

  card.update = (p = {}) => {
    Object.assign(props, p);
    const kind = props.kind ?? "live";
    const tag = props.tag || "";
    const shown = tag || "yourtag";
    card.classList.toggle("is-preview", kind === "preview");
    card.classList.toggle("is-ghost", kind === "ghost");
    card.style.setProperty("--len", String(shown.length + 1));
    handle.classList.toggle("is-placeholder", !tag);
    handle.replaceChildren(el("span", { class: "ntag-at" }, "@"), shown);
    const nm = (props.name ?? "").trim();
    name.classList.toggle("is-placeholder", !nm);
    name.textContent = nm || (kind === "preview" ? "Display name (optional)" : kind === "ghost" ? "Not claimed yet" : "");
    addr.textContent = props.address ? short(props.address) : "0x····…····";
    since.textContent = props.since ? `Since ${monthYear(props.since)}` : kind === "preview" ? "Preview" : "";
    const pc = props.currency ? currencyOf(props.currency) : null; // what the owner receives, on the card
    net.replaceChildren(...(pc ? [flagIcon(pc.code), " ", pc.label] : ["Celo"]));
    net.classList.toggle("has-cur", Boolean(pc));
    stampText.textContent = props.stamp ?? "";
    stampCheck.style.display = kind === "ghost" ? "none" : ""; // "Unclaimed", "Reserved", "On hold": no tick
    card.classList.toggle("is-stamped", Boolean(props.stamp));
    if (as !== "div") card.setAttribute("aria-label", props.label ?? `LokalPay tag @${shown}${nm ? ", " + nm : ""}${pc ? `, receives ${pc.plural}` : ""}`);
    return card;
  };
  card.update();
  if (props.tilt !== false) enableTilt(card);
  return card;
}

/** Pointer-following tilt (at most 8 degrees) and sheen, via CSS custom properties. Off with reduced motion and on touch. */
export function enableTilt(card) {
  if (reducedMotion()) return;
  let raf = 0, last = null;
  const apply = () => {
    raf = 0;
    if (!last) return;
    const r = card.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const x = Math.min(1, Math.max(0, (last.x - r.left) / r.width));
    const y = Math.min(1, Math.max(0, (last.y - r.top) / r.height));
    card.style.setProperty("--rx", ((0.5 - y) * 16).toFixed(2) + "deg");
    card.style.setProperty("--ry", ((x - 0.5) * 16).toFixed(2) + "deg");
    card.style.setProperty("--mx", (x * 100).toFixed(1) + "%");
    card.style.setProperty("--my", (y * 100).toFixed(1) + "%");
    card.style.setProperty("--hyp", Math.min(1, Math.hypot(x - 0.5, y - 0.5) * 2).toFixed(3));
  };
  card.addEventListener("pointermove", (e) => {
    if (e.pointerType === "touch") return;
    last = { x: e.clientX, y: e.clientY };
    card.classList.add("is-active");
    if (!raf) raf = requestAnimationFrame(apply);
  });
  card.addEventListener("pointerleave", () => {
    last = null;
    card.classList.remove("is-active");
    for (const [k, v] of [["--rx", "0deg"], ["--ry", "0deg"], ["--mx", "32%"], ["--my", "18%"], ["--hyp", "0"]]) card.style.setProperty(k, v);
  });
}

/** The claim moment: the card flips in, the stamp lands, a ring of light. Resolves when it has played. */
export function revealCard(card, stamp = "Yours") {
  card.update({ stamp });
  card.classList.remove("is-revealing");
  void card.offsetWidth; // restart the animation
  card.classList.add("is-revealing");
  const ms = reducedMotion() ? 300 : 2400;
  return sleep(ms).then(() => card.classList.remove("is-revealing"));
}

/** A card on its "stage" (floor shadow + glow), with an optional caption. */
export const stage = (card, caption) => el("div", { class: "ntag-stage" }, card, caption ? el("p", { class: "ntag-caption" }, caption) : null);

// ---------- QR code and sharing ----------
/** QR as DOM SVG (no innerHTML, no data: URLs, works under the CSP). The one drawing lives in disclose.js. */
export const renderQr = drawQr;

/** A tag's link: Share · Copy link (WhatsApp where the browser can't share), and "Show QR code" on demand. */
export function shareBlock(tag) {
  const url = ntagUrl(tag);
  return shareRow({
    url, title: `@${tag} on LokalPay`, text: `Pay me in dollars on Celo and I receive my own local money. My LokalPay tag is @${tag}.`,
    whatsappText: decodeURIComponent(whatsappUrl(tag, url).split("?text=")[1]), qrLabel: `QR code for the @${tag} pay page`,
    qrCaption: "Scan to open the pay page.",
  });
}

// ---------- transactions ----------
/**
 * Polls for a receipt. Resolves the receipt when it succeeded, null if it is still pending after `tries`.
 * Throws a plain error if it failed onchain.
 */
export async function waitForReceipt(hash, { tries = 72, ms = 2500, failMessage = "The transaction failed on Celo. Only the network fee was spent." } = {}) {
  for (let i = 0; i < tries; i++) {
    await sleep(ms);
    let rc = null;
    try { rc = await loadReceipt(hash); } catch { continue; }
    if (!rc) continue;
    if (rc.status === "0x1") return rc;
    throw plainError(failMessage, { hash });
  }
  return null;
}

/**
 * While a transaction waits for Celo: after `after` ms, shows "Taking longer than usual (0:34). Check Celoscan" in
 * `node` and keeps the timer running. Returns stop(). The link is built once so keyboard focus on it survives.
 */
export function slowNotice(node, hash, { after = 20_000, start = Date.now() } = {}) {
  const clock = el("span", { class: "num" });
  let shown = false;
  const tick = () => {
    const ms = Date.now() - start;
    if (ms < after) return;
    const s = Math.floor(ms / 1000);
    clock.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    if (!shown) {
      shown = true;
      node.replaceChildren("Taking longer than usual (", clock, "). ",
        el("a", { class: "link", href: celoscanTx(hash), target: "_blank", rel: "noopener" }, "Check Celoscan ", icon("ext")));
    }
  };
  const id = setInterval(tick, 1000);
  tick();
  return () => clearInterval(id);
}

// ---------- reading Celo state right before a transaction (bypasses the site's edge cache) ----------
const fresh = { cache: "no-store" };
/** Every nTag op, read straight from Blockscout (not through /api/explorer's cache). Resolves { ops, state }. */
export async function loadNtagStateFresh(maxPages = 200) {
  const ops = [];
  let next = null;
  for (let p = 0; p < maxPages; p++) {
    const qs = new URLSearchParams({ filter: "to", ...(next ?? {}) });
    const d = await getJson(`${BLOCKSCOUT_API}/addresses/${AGENT}/transactions?${qs}`, fresh);
    if (!Array.isArray(d?.items)) throw new Error("unexpected explorer response");
    for (const t of d.items) { const o = ntagOpFromItem(t, AGENT); if (o) ops.push(o); }
    next = d.next_page_params ?? null;
    if (!next) {
      ops.sort((x, y) => x.block - y.block || x.position - y.position);
      return { ops, state: resolveNtags(ops) };
    }
  }
  throw new Error("partial LokalPay tag list");
}

/** Blockscout token-transfer item -> { hash, logIndex, block, ts (ms), from, to, token (tokenKey) | null, units }, or null. */
export function transferItem(it) {
  const hash = it?.transaction_hash ?? it?.tx_hash;
  if (!hash || !it?.from?.hash || !it?.to?.hash) return null;
  let units;
  try { units = BigInt(it.total?.value ?? "0"); } catch { return null; }
  return {
    hash, logIndex: Number(it.log_index ?? 0), block: Number(it.block_number ?? 0), ts: Date.parse(it.timestamp),
    from: it.from.hash, to: it.to.hash, token: tokenKey(it.token?.address_hash ?? it.token?.address), units,
  };
}
/** Stablecoin transfers to `address` (newest first) back to `sinceMs`: { items, complete }. live = straight from Blockscout. */
async function transfersTo(address, { sinceMs = 0, pages = 4, live = false } = {}) {
  const items = [];
  let next = null;
  for (let p = 0; p < pages; p++) {
    const qs = new URLSearchParams({ type: "ERC-20", filter: "to", ...(next ?? {}) });
    const d = await getJson(`${live ? BLOCKSCOUT_API : EXPLORER_API}/addresses/${address}/token-transfers?${qs}`, live ? fresh : {});
    if (!Array.isArray(d?.items)) throw new Error("unexpected explorer response");
    for (const it of d.items) {
      const t = transferItem(it);
      if (!t) continue;
      if (t.ts < sinceMs) return { items, complete: true };
      if (t.token && sameAddr(t.to, address)) items.push(t);
    }
    next = d.next_page_params ?? null;
    if (!next) return { items, complete: true };
  }
  return { items, complete: false };
}
/** How much more `owner` can receive from the agent today (see allowanceFrom). live = bypass the edge cache. Throws if unsure. */
export async function receivableToday(owner, rate, { live = false, now = Date.now() } = {}) {
  const r = await transfersTo(owner, { sinceMs: now - DAY_MS, pages: 6, live });
  if (!r.complete) throw new Error("too many transfers to check");
  return allowanceFrom(r.items, { owner, rate, now });
}

const memoCache = new Map(); // deposit tx hash -> tag in its memo (or null); transactions never change
async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch { out[k] = undefined; } }
  }));
  return out;
}
/**
 * Payments to `tag` since the claim (`sinceSec`), each matched to the agent's payout to `owner` (matchTagLedger).
 * Resolves { deposits (newest first), partial }. partial = some deposits couldn't be checked.
 */
export async function loadTagLedger({ tag, owner, sinceSec, rate, live = false, maxLookups = 60, currency = null }) {
  const sinceMs = sinceSec * 1000;
  const [incoming, toOwner] = await Promise.all([
    transfersTo(AGENT, { sinceMs, pages: 4, live }),
    transfersTo(owner, { sinceMs: sinceMs - DAY_MS, pages: 4, live }),
  ]);
  const cands = incoming.items.filter((t) => !sameAddr(t.from, AGENT)).slice(0, maxLookups);
  const memos = await mapLimit(cands, 4, async (t) => {
    if (memoCache.has(t.hash)) return memoCache.get(t.hash);
    const tx = await rpc("eth_getTransactionByHash", [t.hash]);
    if (!tx) return undefined; // not visible yet: look again next time
    const tok = t.token === "USDT" ? TOKENS.USDT.address : t.token === "CNGN" ? TOKENS.cNGN.address : null;
    // a payment through LokalTags (payTag / payTagWithPermit) names the tag in its calldata; the older ones in a memo
    const viaContract = sameAddr(tx.to, LOKAL_TAGS) ? decodePayTagCall(tx.input) : null;
    const m = viaContract && tok && sameAddr(viaContract.token, tok) && BigInt(viaContract.amount) === BigInt(t.units)
      ? { tag: viaContract.tag, currency: null, contract: true }
      : tok && sameAddr(tx.to, tok) ? decodeNtagPayment(tx.input) : null;
    memoCache.set(t.hash, m);
    return m;
  });
  // contract payments pay out in the owner's receive currency (`currency`), memo payments in the memo's
  const deposits = cands.filter((t, i) => memos[i]?.tag === tag).map((t) => {
    const m = memos[cands.indexOf(t)];
    return { ...t, payer: t.from, currency: m?.contract ? currency ?? null : m?.currency ?? null, contract: Boolean(m?.contract) };
  });
  const payouts = toOwner.items.filter((t) => sameAddr(t.from, AGENT));
  const matched = matchTagLedger({ deposits, payouts, owner, rate });
  const partial = !incoming.complete || incoming.items.length > cands.length || memos.some((m) => m === undefined);
  return { deposits: matched.reverse(), partial };
}

// ---------- page helpers ----------
/** Scrolls `node` into view below the sticky / fixed top bar; instant under reduced motion. */
export function scrollToNode(node) {
  if (!node?.getBoundingClientRect) return;
  let top = 0;
  const bar = document.querySelector(".nav-wrap");
  if (bar) {
    const cs = getComputedStyle(bar), r = bar.getBoundingClientRect();
    if (cs.display !== "none" && cs.visibility !== "hidden" && (cs.position === "fixed" || cs.position === "sticky") && r.height > 0 && r.bottom > 0) top = r.bottom;
  }
  const y = node.getBoundingClientRect().top + scrollY - top - 16;
  scrollTo({ top: Math.max(0, y), behavior: reducedMotion() ? "auto" : "smooth" });
}
/** Moves keyboard focus to a heading after a rebuild (no outline for pointer users; :focus-visible styling in ntags.css). */
export function focusHeading(h) {
  if (!h) return;
  h.tabIndex = -1;
  h.classList.add("nt-focus-target");
  h.focus({ preventScroll: true });
}
/** True on a computer (no touch-first browser), where wallets are browser extensions rather than apps. */
export function isDesktop() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  if (navigator.userAgentData?.mobile) return false;
  if (/Android|iPhone|iPad|iPod|Mobile|MiniPay|Opera Mini|Opera Mobi/i.test(ua)) return false;
  if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return false; // iPadOS reports itself as a Mac
  return true;
}
/**
 * "No wallet found" help. On a phone: open this page in a wallet app's browser. On a computer: install the MetaMask
 * extension, or scan a QR code of this page to open it on the phone. Links keep the #hash (e.g. #claim=ada).
 */
export function noWalletHelp({ action = "continue" } = {}) {
  const page = location.href;
  const copy = el("button", { class: "btn btn-secondary btn-sm", type: "button", dataset: { copy: page, copyLabel: "Page link copied" } }, icon("copy"), "Copy page link");
  if (isDesktop()) {
    const qr = el("div", { class: "nt-qr sm" });
    renderQr(qr, page, "QR code of this page, to open it on your phone");
    return alertBox("", "info",
      el("p", {}, el("b", {}, "No wallet found in this browser."), ` To ${action} on this computer, install the MetaMask browser extension and reload this page. Or scan the code with your phone and open the page in MiniPay, MetaMask or another Celo wallet.`),
      el("div", { class: "nt-nowallet mt-16" }, qr,
        el("div", { class: "stack", style: "gap:10px" },
          el("a", { class: "btn btn-secondary btn-sm", href: "https://metamask.io/download/", target: "_blank", rel: "noopener" }, icon("ext"), "Install the MetaMask browser extension"),
          copy,
          el("p", { class: "micro muted" }, "Scan with your phone's camera to open this page there."))));
  }
  return alertBox("", "info",
    el("p", {}, el("b", {}, "No wallet found in this browser."), ` To ${action}, open this page in MiniPay, MetaMask or another Celo wallet's browser.`),
    el("ol", { class: "small soft mt-8", style: "margin:8px 0 0;padding-left:18px;display:grid;gap:4px" },
      el("li", {}, "Copy this page's link."),
      el("li", {}, "Open your wallet app and go to its built-in browser."),
      el("li", {}, "Paste the link there.")),
    el("div", { class: "row mt-16" }, copy,
      el("a", { class: "btn btn-secondary btn-sm", href: "https://metamask.app.link/dapp/" + page.replace(/^https?:\/\//, "") }, icon("ext"), "Open in MetaMask")));
}
/** The "no CELO for the network fee" warning, with a Get CELO link and an optional "… anyway" button. */
export function noCeloAlert(onAnyway, anywayLabel = "Send anyway") {
  const parts = [el("p", {}, el("b", {}, "This wallet has no CELO for the network fee. "),
    "Most wallets need a few cents of CELO to send anything, even a free transaction. ",
    el("a", { class: "link", href: "https://celo.org", target: "_blank", rel: "noopener" }, "Get CELO ", icon("ext")))];
  if (onAnyway) {
    const b = el("button", { class: "btn btn-secondary btn-sm", type: "button" }, anywayLabel);
    b.addEventListener("click", onAnyway);
    parts.push(el("p", { class: "small soft mt-8" }, "Some wallets, like MiniPay, pay the fee in dollars instead."), el("div", { class: "row mt-8" }, b));
  }
  return alertBox("warn", "alert", ...parts);
}
/** The wallet's CELO balance in wei, or null if it couldn't be read. */
export async function celoBalance(address) {
  try { return BigInt(await rpc("eth_getBalance", [address, "latest"])); } catch { return null; }
}

// ---------- who holds a tag: the LokalTags contract first, then the legacy memo claims ----------
/** A LokalTags tagInfo() answer as the entry pages use: { owner, name, since, currency (local code or null), receive, receiveToken, source }. */
export function contractEntry(info) {
  const local = info?.receive && info.receive !== "usdt" ? info.receive : null;
  return { owner: info.owner, name: info.name || null, since: info.since, currency: local, receive: info.receive ?? null, receiveToken: info.receiveToken ?? null, hash: null, source: "contract" };
}
/**
 * Who holds `tag` and what `me` would get by claiming it. The contract wins: { entry (source "contract" | "legacy"),
 * kind (the contract's availability for `me`), lock }. A legacy holder (claimed with the memo protocol before the
 * cutover, and not on the contract) is still shown and paid with the old memo transfer. Throws if Celo can't be read.
 */
export async function lookupTag(tag, me = null) {
  const [info, kind] = await Promise.all([readTagInfo(tag), readAvailability(tag, me || ZERO_ADDRESS)]);
  if (info.owner) return { entry: contractEntry(info), kind, lock: null };
  let legacy = null;
  try { legacy = ownerOf(resolveNtags(legacyNtagOps(await loadNtagOps())), tag); } catch { legacy = null; /* explorer down: the contract's answer stands */ }
  if (legacy && kind === "free") return { entry: { ...legacy, source: "legacy" }, kind: me && sameAddr(legacy.owner, me) ? "yours" : "taken", lock: null };
  return { entry: null, kind, lock: info.lockedUntil ? { owner: info.lockedFor, until: info.lockedUntil } : null };
}

// ---------- find an nTag (landing, tag page) ----------
/**
 * Live search: type @ada, see who owns it (or that it's free), then "Pay @ada". Returns the element.
 * opts: { id, label, value, address (the signed-in wallet, or a function returning it, for "that's you") }
 */
export function ntagFinder(opts = {}) {
  const id = opts.id ?? "find-tag";
  const input = el("input", {
    id, type: "text", placeholder: "ada", autocomplete: "off", autocapitalize: "none", spellcheck: "false",
    maxlength: "21", enterkeyhint: "go", "aria-describedby": `${id}-out`,
  });
  const out = el("div", { class: "nt-find-result", id: `${id}-out`, "aria-live": "polite" });
  let timer = null, seq = 0, best = null;
  const me = () => (typeof opts.address === "function" ? opts.address() : opts.address);
  const hit = (cls, av, title, sub, action) => el("div", { class: `nt-hit ${cls}` }, av, el("div", { class: "nt-hit-text" }, el("b", {}, title), el("span", {}, sub)), action);
  const run = async () => {
    const my = ++seq;
    const t = cleanTagInput(input.value);
    best = null;
    if (!t) { out.replaceChildren(); return; }
    const err = ntagError(t);
    if (err && !/reserved/.test(err)) { out.replaceChildren(el("p", { class: "small muted" }, `${cap(err)}.`)); return; }
    out.replaceChildren(el("p", { class: "small muted", role: "status" }, `Looking up @${t}…`));
    let found;
    try { found = await lookupTag(t, me()); } catch {
      if (my !== seq) return;
      const retry = el("button", { class: "btn btn-ghost btn-sm", type: "button" }, icon("refresh"), "Try again");
      retry.addEventListener("click", run);
      out.replaceChildren(el("div", { class: "row" }, el("p", { class: "small muted" }, "Couldn't reach Celo to look it up."), retry));
      return;
    }
    if (my !== seq) return;
    const { entry, kind } = found;
    if (entry) {
      const url = ntagUrl(t);
      best = url;
      const mine = Boolean(me()) && sameAddr(entry.owner, me());
      out.replaceChildren(hit("owned", avatar(entry.owner), "@" + t, [entry.name ? nameText(entry.name) : null, entry.name ? " · " : null, short(entry.owner)],
        el("a", { class: "btn btn-primary btn-sm", href: mine ? "account.html" : url }, mine ? "That's you" : `Pay @${t}`, icon("right"))));
      return;
    }
    if (kind === "reserved") {
      out.replaceChildren(hit("none", el("span", { class: "np-avatar" }, icon("lock")), "@" + t, "Reserved. Nobody can claim it.", null));
      return;
    }
    const m = availabilityMessage(t, kind, { lock: found.lock });
    out.replaceChildren(hit(kind === "free" ? "free" : "none", el("span", { class: "np-avatar" }, icon(kind === "free" ? "check" : "lock")), "@" + t,
      kind === "free" ? "Nobody has this tag yet." : m.text,
      kind === "free" ? el("a", { class: "btn btn-secondary btn-sm", href: `account.html#claim=${t}` }, "Claim it") : null));
  };
  input.addEventListener("input", () => {
    const clean = cleanTagInput(input.value);
    if (clean !== input.value) {
      const atEnd = input.selectionStart === input.value.length;
      input.value = clean;
      if (atEnd) input.setSelectionRange(clean.length, clean.length);
    }
    clearTimeout(timer);
    timer = setTimeout(run, 250);
  });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && best) location.href = best; });
  if (opts.value) { input.value = cleanTagInput(opts.value); setTimeout(run, 0); }
  return el("div", { class: "nt-find", role: "search" },
    el("label", { class: "nt-find-label", for: id }, icon("search"), opts.label ?? "Find a LokalPay tag"),
    el("div", { class: "nt-taginput sm" }, el("span", { class: "nt-at", "aria-hidden": "true" }, "@"), input),
    out);
}
