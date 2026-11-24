// Proof: every real LokalPay payout, read from Celo when the page opens (proof.html; the landing's Proof section shows the
// newest few). Nothing here is typed in by hand:
//   - payouts: the agent's own outgoing token transfers (Blockscout), each checked for the attribution tag in its input;
//   - deposits: the TagPaid / PotPaid events on the contracts (eth_getLogs), matched to the payout that paid them, and
//     the status server's records (by recipient) when it has them;
//   - named users: optional consented entries in site/proof-users.json, shown only when their receipt number is a real
//     payout read here. An entry that doesn't match is shown as not matching, never hidden.
// No payer or recipient address ever leaves this module: rows carry amounts, tokens, receipt numbers and transaction ids.
// The top level stays free of window/document access, so the aggregation is tested in Node (test/proof.test.mjs).
import { AGENT, TAG, TOKENS, CURRENCIES, decodeTag, receiptNo, unitsToDecimal, getJson, loadTxPage } from "./core.js";
import { LOKAL_TAGS, LOKAL_POTS, LOKAL_TAGS_BLOCK, LOKAL_POTS_BLOCK, TOPIC, decodeTagPaid, decodePotPaid } from "./lokal-contracts.js";
import { fmtToken } from "./my-activity.js";
import { EXPLORER_RPC, EXPLORER_PAGE } from "./trust.js";

const lc = (s) => String(s ?? "").toLowerCase();
const HASH_RE = /^0x[0-9a-f]{64}$/;
const RECEIPT_RE = /^NP-[0-9A-F]{4}-[0-9A-F]{4}$/;
const TRANSFER = "0xa9059cbb";
const tokenByAddr = (a) => Object.values(TOKENS).find((t) => lc(t.address) === lc(a)) ?? null;
const tokenBySymbol = (s) => Object.values(TOKENS).find((t) => t.symbol === s || (s === "USDT" && t.symbol === "USD₮")) ?? null;
/** What a token pays someone in a sentence: "naira", "rupiah", "Argentine pesos", "dollars". */
const receiveWord = (t) => (t?.currency ? CURRENCIES.find((c) => c.code === t.currency)?.plural ?? t.symbol : "dollars");

/** True when the transaction input ends in an ERC-8021 suffix that carries LokalPay's attribution tag (celo_7360953d1b53). */
export const hasAttribution = (input) => Boolean(decodeTag(input)?.codes?.includes(TAG));

/**
 * A Blockscout transaction item from the agent -> the payout it is, or null: a successful transfer(to, amount) of a
 * token LokalPay pays out in. { hash, time (ms), block, token (address), symbol, units (bigint), to, tagged }.
 * `to` stays inside this module (unique-recipient count, deposit matching); it is never rendered.
 */
export function payoutFromTx(tx) {
  const hash = lc(tx?.hash);
  const input = lc(tx?.raw_input ?? tx?.input);
  const t = tokenByAddr(tx?.to?.hash ?? tx?.to);
  if (!HASH_RE.test(hash) || !t || !input.startsWith(TRANSFER) || input.length < 138) return null;
  if (tx.status !== "ok" || (tx.from?.hash && lc(tx.from.hash) !== lc(AGENT))) return null;
  let units;
  try { units = BigInt("0x" + input.slice(74, 138)); } catch { return null; }
  if (units <= 0n) return null;
  return {
    hash, time: Date.parse(tx.timestamp) || null, block: Number(tx.block_number ?? tx.block ?? 0), token: t.address, symbol: t.symbol,
    units, to: "0x" + input.slice(34, 74), tagged: hasAttribution(input),
  };
}
/** Base units of a token as "₦14,400.00 cNGN" / "Rp 91,967 IDRX" / "10.00 USD₮" (rounded down). */
export function unitsText(units, t) {
  const c = t?.currency ? CURRENCIES.find((x) => x.code === t.currency) : null;
  const places = c ? (c.code === "cngn" ? 2 : c.places) : 2;
  return fmtToken(t.symbol, Number(unitsToDecimal(units, t.decimals, places)));
}
/** A deposit log (TagPaid or PotPaid) -> { kind, hash, block, token, amount, recipient }, or null. Payer dropped. */
export function depositFromLog(log) {
  const d = decodeTagPaid(log) ?? decodePotPaid(log);
  if (!d) return null;
  return { kind: d.kind, hash: lc(d.hash), block: d.block, logIndex: d.logIndex, token: d.token, amount: BigInt(d.amount), recipient: lc(d.recipient) };
}

/** A named user entry is { receiptNo, label, city?, usedFor? } with short plain strings. */
export function userEntryOk(u) {
  if (!u || typeof u !== "object" || Array.isArray(u)) return false;
  const s = (v, max, req) => (v == null ? !req : typeof v === "string" && v.trim().length > 0 && v.length <= max);
  return RECEIPT_RE.test(String(u.receiptNo ?? "")) && s(u.label, 60, true) && s(u.city, 60, false) && s(u.usedFor, 120, false);
}

/**
 * The page's data from what was read. Pure.
 *   payouts: payoutFromTx(...) items; deposits: depositFromLog(...) items, or null when the logs couldn't be read;
 *   events: status-server events (any recipient; only "paid" ones with a payoutTx are used); users: proof-users.json.
 * Returns { rows (newest first), totals, users: { matched: [{ entry, row }], mismatched: [{ entry, reason }] } }.
 * Each row: { receiptNo, payoutHash, depositHash, time, from (symbol or null), to ("naira", ...), inText, outText, usd,
 * tagged, matchedBy ("agent" | "chain" | null), kind ("tag" | "pot" | null), user }.
 */
export function proofModel({ payouts = [], deposits = [], events = [], users = [], team = [] } = {}) {
  // team: receipt numbers of the builder's own test payouts (site/proof-team.json). Listed, labelled, and kept out of
  // the headline totals, so the totals only count payouts to people outside the team.
  const teamSet = new Set((Array.isArray(team) ? team : []).filter((n) => RECEIPT_RE.test(String(n))));
  const paid = new Map();
  for (const e of events ?? []) if (e?.status === "paid" && HASH_RE.test(lc(e.payoutTx))) paid.set(lc(e.payoutTx), e);
  const byHash = new Map((deposits ?? []).map((d) => [d.hash, d]));
  const used = new Set();
  const list = [...(payouts ?? [])].filter(Boolean).sort((a, b) => a.block - b.block || (a.time ?? 0) - (b.time ?? 0));
  const rows = [];
  for (const p of list) {
    const out = tokenByAddr(p.token);
    const ev = paid.get(p.hash) ?? null;
    let dep = null, matchedBy = null;
    if (ev?.depositTx && HASH_RE.test(lc(ev.depositTx))) {
      dep = byHash.get(lc(ev.depositTx)) ?? null;
      matchedBy = "agent";
    } else if (deposits) {
      // the chain alone: the newest earlier deposit to the same recipient that no other payout has claimed
      dep = [...deposits].filter((d) => d.recipient === lc(p.to) && d.block <= p.block && !used.has(d.hash + ":" + d.logIndex))
        .sort((a, b) => b.block - a.block || b.logIndex - a.logIndex)[0] ?? null;
      if (dep) matchedBy = "chain";
    }
    if (dep) used.add(dep.hash + ":" + dep.logIndex);
    const depHash = dep?.hash ?? (matchedBy === "agent" ? lc(ev.depositTx) : null);
    const inTok = dep ? tokenByAddr(dep.token) : ev ? tokenBySymbol(ev.token) : null;
    let inText = null, inUsd = null;
    if (dep && inTok) {
      inText = unitsText(dep.amount, inTok);
      if (!inTok.currency) inUsd = Number(dep.amount) / 10 ** inTok.decimals;
    } else if (ev && inTok && /^\d+(\.\d+)?$/.test(String(ev.amount))) {
      inText = fmtToken(inTok.symbol, Number(ev.amount));
      if (!inTok.currency) inUsd = Number(ev.amount);
    }
    const outUsd = out && !out.currency ? Number(p.units) / 10 ** out.decimals : null;
    const usd = inUsd ?? outUsd ?? (Number.isFinite(ev?.usd) ? ev.usd : null);
    rows.push({
      receiptNo: receiptNo(p.hash), payoutHash: p.hash, depositHash: depHash, time: p.time, from: inTok?.symbol ?? null,
      to: receiveWord(out), outSymbol: out?.symbol ?? null, inText, outText: unitsText(p.units, out), usd: usd == null ? null : Math.round(usd * 100) / 100,
      tagged: Boolean(p.tagged), matchedBy, kind: dep?.kind ?? null, user: null, team: teamSet.has(receiptNo(p.hash)),
    });
  }
  rows.reverse();

  const byReceipt = new Map(rows.map((r) => [r.receiptNo, r]));
  const matched = [], mismatched = [];
  for (const u of Array.isArray(users) ? users : []) {
    if (!userEntryOk(u)) { mismatched.push({ entry: u, reason: "This entry isn't in the right shape (receiptNo, label, city, usedFor)." }); continue; }
    const row = byReceipt.get(u.receiptNo);
    if (!row) { mismatched.push({ entry: u, reason: `No payout read from Celo has the receipt number ${u.receiptNo}.` }); continue; }
    if (row.user) { mismatched.push({ entry: u, reason: `${u.receiptNo} is already named by another entry.` }); continue; }
    const entry = { receiptNo: u.receiptNo, label: u.label.trim(), city: u.city?.trim() ?? null, usedFor: u.usedFor?.trim() ?? null };
    row.user = entry;
    matched.push({ entry, row });
  }

  const real = rows.filter((r) => !r.team);
  const usdRows = real.filter((r) => r.usd != null);
  // in the registry's order: USD₮, then the local currencies as the site lists them
  const order = Object.values(TOKENS).map((t) => t.symbol);
  const currencies = [...new Set(real.flatMap((r) => [r.from, r.outSymbol]).filter(Boolean))].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const totals = {
    payouts: real.length,
    usd: Math.round(usdRows.reduce((s, r) => s + r.usd, 0) * 100) / 100,
    usdMissing: real.length - usdRows.length,
    currencies,
    recipients: new Set((payouts ?? []).filter((p) => p && !teamSet.has(receiptNo(p.hash))).map((p) => lc(p.to))).size,
    tagged: rows.filter((r) => r.tagged).length,
    team: rows.length - real.length,
  };
  return { rows, totals, users: { matched, mismatched } };
}

// ---------- reading it all ----------
async function contractLogs(address, topic0, fromBlock, fetchJson, explorerRpc) {
  const j = await fetchJson(explorerRpc, {
    method: "POST", headers: { "content-type": "application/json" }, cache: "no-store",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [{ address, fromBlock: "0x" + fromBlock.toString(16), toBlock: "latest", topics: [topic0] }] }),
  });
  if (!Array.isArray(j?.result)) throw new Error("unexpected explorer answer");
  return { logs: j.result, capped: j.result.length >= EXPLORER_PAGE };
}
/**
 * Reads everything proofModel needs. { payouts, deposits (null if unreadable), depositsCapped, events, users (null if
 * proof-users.json couldn't be read), complete (every agent transaction page was read), checked (transactions read) }.
 * Throws only when the agent's transactions can't be read at all.
 */
export async function loadProof({ maxPages = 20, fetchJson = getJson, explorerRpc = EXPLORER_RPC, statusFor = null, usersUrl = "proof-users.json", teamUrl = "proof-team.json", txPage = loadTxPage } = {}) {
  const items = [];
  let next = null, complete = false;
  for (let p = 0; p < maxPages; p++) {
    const page = await txPage(next);
    items.push(...page.items);
    next = page.next;
    if (!next) { complete = true; break; }
  }
  const payouts = items.map(payoutFromTx).filter(Boolean);
  let users = null;
  try { const u = await fetchJson(usersUrl, { cache: "no-store" }); users = Array.isArray(u) ? u : null; } catch { users = null; }
  let team = [];
  try { const t = await fetchJson(teamUrl, { cache: "no-store" }); team = Array.isArray(t) ? t : []; } catch { team = []; }
  let deposits = [], depositsCapped = false, events = [];
  if (payouts.length) {
    try {
      const [tags, pots] = await Promise.all([
        contractLogs(LOKAL_TAGS, TOPIC.TagPaid, LOKAL_TAGS_BLOCK, fetchJson, explorerRpc),
        contractLogs(LOKAL_POTS, TOPIC.PotPaid, LOKAL_POTS_BLOCK, fetchJson, explorerRpc),
      ]);
      deposits = [...tags.logs, ...pots.logs].map(depositFromLog).filter(Boolean);
      depositsCapped = tags.capped || pots.capped;
    } catch { deposits = null; }
    if (statusFor) {
      const recipients = [...new Set(payouts.map((p) => p.to))].slice(0, 40);
      const answers = await Promise.all(recipients.map((r) => Promise.resolve(statusFor(r)).catch(() => null)));
      events = answers.flatMap((a) => (Array.isArray(a?.events) ? a.events : []));
    }
  }
  return { payouts, deposits, depositsCapped, events, users, team, complete, checked: items.length };
}
