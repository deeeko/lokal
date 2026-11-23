// "Yours": one signed-in wallet's own payments with LokalPay, read from Blockscout in the browser. Used by the dashboard
// (app.html) and Activity (transactions.html), which show it only to the signed-in wallet itself. Nothing is stored.
//
// A row is one thing the wallet did with LokalPay, or one payout it received:
//   - its token transfers to the agent: a LokalPay tag payment (through the LokalTags contract, or an older memo
//     transfer), or a payment-link / direct payment;
//   - the agent's payouts to it (money received);
//   - its LokalPay tag transactions on LokalTags (claim, name, default currency, release) and older memo claims;
//   - its "Get paid" payment-link registrations.
// The top level stays free of window/document access so this file is unit-tested in Node.
import {
  AGENT, TOKENS, CURRENCIES, CORRIDORS, EXPLORER_API, getJson, abiDecode, isTagged, txStatus, formatCurrency, num2,
  currencyOf, decodeNtagOp, decodeNtagPayment, decodeRegistration,
} from "./core.js";
import { LOKAL_TAGS, FN, currencyOfRef, tokenCode } from "./lokal-contracts.js";

const HASH_RE = /^0x[0-9a-f]{64}$/i;
const lc = (s) => String(s ?? "").toLowerCase();
const sameAddr = (a, b) => lc(a) === lc(b);

/** "USD₮" | "cNGN" | "IDRX" | "wARS" | "wCOP" for a token LokalPay uses, else null. */
export const tokenName = (t) => Object.values(TOKENS).find((x) => sameAddr(t?.address_hash ?? t?.address, x.address))?.symbol ?? null;
/** "₦14,400.00 cNGN", "Rp 91,967 IDRX", "ARS 8,848.74 wARS", "10.00 USD₮" (local money rounded down). */
export function fmtToken(sym, v) {
  const c = CURRENCIES.find((x) => x.token === sym);
  return c ? `${formatCurrency(v, c.code, c.code === "cngn" ? 2 : c.places)} ${sym}` : num2.format(v) + " " + sym;
}
const pluralOf = (code) => (code === "usdt" ? "dollars" : currencyOf(code)?.plural ?? null);

/** A LokalTags call from the wallet -> { fn, tag?, name?, token?, ref?, receive? } (suffix ignored), or null. */
export function decodeTagsCall(input) {
  const h = lc(input);
  const args = "0x" + h.slice(10);
  try {
    if (h.startsWith(FN.payTag) || h.startsWith(FN.payTagWithPermit)) {
      const [tag, token, , ref] = abiDecode(["string", "address", "uint256", "bytes32"], args);
      return { fn: "pay", tag, token, ref, receive: currencyOfRef(ref) };
    }
    if (h.startsWith(FN.claim)) { const [tag, name] = abiDecode(["string", "string"], args); return { fn: "claim", tag, name }; }
    if (h.startsWith(FN.setName)) { const [name] = abiDecode(["string"], args); return { fn: "setName", name }; }
    if (h.startsWith(FN.setReceiveToken)) { const [token] = abiDecode(["address"], args); return { fn: "setReceiveToken", token, receive: tokenCode(token) }; }
    if (h.startsWith(FN.release)) return { fn: "release" };
  } catch { return null; }
  return null;
}

/** Up to `max` pages of a Blockscout list: { items, more }. */
async function pages(url, max, fetchJson) {
  const items = [];
  let next = null;
  for (let p = 0; p < max; p++) {
    const qs = new URLSearchParams(next ?? {}).toString();
    const d = await fetchJson(url + (qs ? (url.includes("?") ? "&" : "?") + qs : ""));
    if (!Array.isArray(d?.items)) throw new Error("unexpected explorer response");
    items.push(...d.items);
    next = d.next_page_params ?? null;
    if (!next) return { items, more: false };
  }
  return { items, more: true };
}

/**
 * Builds the rows from two Blockscout lists of `address`: its ERC-20 transfers and the transactions it sent.
 * Pure (tested). Returns rows newest first: { hash, time, kind ("sent" | "payout" | "tag" | "link"), status
 * ([text, badge kind]), tagged (true | false | null when unknown), label, sub, link, token (symbol), amount (number) }.
 */
export function activityRows(address, transfers = [], sent = []) {
  const own = new Map(sent.map((t) => [lc(t.hash), t]));
  const rows = [];
  for (const t of transfers) {
    const sym = tokenName(t.token);
    const hash = String(t.transaction_hash ?? "");
    if (!sym || !HASH_RE.test(hash)) continue;
    const amount = Number(t.total?.value ?? 0) / 10 ** Number(t.total?.decimals ?? 6);
    if (sameAddr(t.from?.hash, address) && sameAddr(t.to?.hash, AGENT)) {
      const tx = own.get(lc(hash));
      const call = tx && sameAddr(tx.to?.hash, LOKAL_TAGS) ? decodeTagsCall(tx.raw_input) : null;
      const memo = !call && tx ? decodeNtagPayment(tx.raw_input) : null;
      const tag = call?.fn === "pay" ? call.tag : memo?.tag ?? null;
      const gets = call?.fn === "pay" ? pluralOf(call.receive) : memo && sym === "USD₮" ? pluralOf(memo.currency ?? "cngn") : null;
      rows.push({ hash, time: t.timestamp, kind: "sent", status: ["Sent", "ok"], tagged: tx ? isTagged(tx) : null,
        label: tag ? `You paid @${tag} ${fmtToken(sym, amount)}${gets ? ` (they get ${gets})` : ""}` : `You sent ${fmtToken(sym, amount)} to the agent`,
        sub: tag ? "LokalPay tag payment" : "Payment link or direct payment", link: null, token: sym, amount });
    } else if (sameAddr(t.from?.hash, AGENT) && sameAddr(t.to?.hash, address)) {
      rows.push({ hash, time: t.timestamp, kind: "payout", status: ["Received", "ok"], tagged: null,
        label: `You received ${fmtToken(sym, amount)}`, sub: "Payout from the agent", link: null, token: sym, amount });
    }
  }
  for (const t of sent) {
    const hash = String(t.hash ?? "");
    if (!HASH_RE.test(hash)) continue;
    if (sameAddr(t.to?.hash, LOKAL_TAGS)) {
      const call = decodeTagsCall(t.raw_input);
      if (!call || call.fn === "pay") continue; // payments are listed from their token transfer above
      const label = call.fn === "claim" ? `You claimed @${call.tag}${call.name ? ` (${call.name})` : ""}`
        : call.fn === "setName" ? (call.name ? `You set your name to ${call.name}` : "You removed your display name")
        : call.fn === "setReceiveToken" ? (call.receive ? `You set your default currency to ${pluralOf(call.receive)}` : "You cleared your default currency")
        : "You released your LokalPay tag";
      rows.push({ hash, time: t.timestamp, kind: "tag", status: txStatus(t), tagged: isTagged(t), label, sub: "LokalPay tag", link: null, token: null, amount: null });
      continue;
    }
    if (!sameAddr(t.to?.hash, AGENT)) continue;
    const op = decodeNtagOp(t.raw_input);
    const reg = op ? null : decodeRegistration(t.raw_input);
    if (!op && !reg) continue;
    const label = op
      ? (op.t === "" ? "You released your LokalPay tag" : `You claimed @${op.t}${op.n ? ` (${op.n})` : ""}`)
      : `You made a payment link for ${reg.a} ${CORRIDORS[reg.d]?.sell === "cNGN" ? "cNGN" : "USD₮"}`;
    rows.push({ hash, time: t.timestamp, kind: op ? "tag" : "link", status: txStatus(t), tagged: isTagged(t),
      label, sub: op ? "LokalPay tag (older memo)" : "Get paid", link: reg && t.status === "ok" ? `pay.html#tx=${hash}` : null, token: null, amount: null });
  }
  rows.sort((a, b) => Date.parse(b.time ?? 0) - Date.parse(a.time ?? 0));
  return rows;
}

/** The wallet's rows (see activityRows), from up to `maxPages` pages of each list: { rows, more }. */
export async function loadMyActivity(address, { maxPages = 3, fetchJson = getJson, api = EXPLORER_API } = {}) {
  const [tt, txs] = await Promise.all([
    pages(`${api}/addresses/${address}/token-transfers?type=ERC-20`, maxPages, fetchJson),
    pages(`${api}/addresses/${address}/transactions?filter=from`, maxPages, fetchJson),
  ]);
  return { rows: activityRows(address, tt.items, txs.items), more: tt.more || txs.more };
}

/** Money received, per token, from the payout rows: [{ token, code ("usdt" | a currency), amount, count }] (biggest count first). */
export function receivedTotals(rows) {
  const by = new Map();
  for (const r of rows ?? []) {
    if (r.kind !== "payout" || !r.token) continue;
    const cur = by.get(r.token) ?? { token: r.token, code: CURRENCIES.find((c) => c.token === r.token)?.code ?? "usdt", amount: 0, count: 0 };
    cur.amount += r.amount;
    cur.count += 1;
    by.set(r.token, cur);
  }
  return [...by.values()].sort((a, b) => b.count - a.count);
}

// ---------- one read per minute, shared by everything on the page ----------
// The dashboard, Activity and the notification bell can all ask for the same wallet's rows on one page. They share one
// read (or one read in flight) for SHARED_MS, kept in memory only: nothing is stored, and a new page reads afresh.
export const SHARED_MS = 60_000;
const shared = new Map(); // lowercased address -> { at, maxPages, promise }
/**
 * loadMyActivity through the shared cache: a read of at least `maxPages` pages made in the last `ttl` ms (or still in
 * flight) answers instead of a new one. `force` reads again. A failed read is forgotten at once, so a retry reads again.
 */
export function sharedActivity(address, { maxPages = 3, force = false, ttl = SHARED_MS, now = Date.now, load = loadMyActivity } = {}) {
  const key = lc(address);
  const hit = shared.get(key);
  if (!force && hit && hit.maxPages >= maxPages && now() - hit.at < ttl) return hit.promise;
  const entry = { at: now(), maxPages, promise: null };
  entry.promise = Promise.resolve().then(() => load(address, { maxPages })).catch((e) => {
    if (shared.get(key) === entry) shared.delete(key);
    throw e;
  });
  shared.set(key, entry);
  return entry.promise;
}
/** Forgets every shared read (tests, sign-out). */
export const clearSharedActivity = () => shared.clear();
