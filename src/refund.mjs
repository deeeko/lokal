// Refunds: send a deposit autopilot will never pay back to the wallet it came from. Same token, same amount, to the
// `from` of the deposit's Transfer log; the agent pays the gas. Full rules: docs/REFUNDS.md.
//   - Only deposits autopilot recorded as refused, unmatched (incl. expired or used links) or ambiguous. Never a paid
//     deposit or one with a payout recorded, never a top-up from own_wallets, never the agent's own swap output, never a
//     transfer from a contract the agent knows (tokens, registries, the Textile reactor), never one it has no record of.
//   - Dry run by default. --execute: type yes -> lock -> re-read the deposit over RPC -> re-check everything -> record
//     "sending" in refunds.json BEFORE sending -> transfer (attribution-tagged wallet client) -> check the receipt's
//     Transfer log -> "refunded" (refundTx, RF- number) -> receipts.jsonl (kind "refund") -> status report.
//   - A failure after recording is "failed" and never retried automatically. --retry first searches the chain for the
//     refund (it may have gone through after all) and only sends again when there is none.
//   - Own caps: MAX_DAILY_REFUND_USD per rolling 24 h; deposits under MIN_REFUND_USD are recorded as too_small_to_refund.
import fs from "node:fs";
import path from "node:path";
import { erc20Abi, formatUnits, getAddress, isAddress, parseEventLogs, parseUnits, zeroAddress } from "viem";
import { MAX_DAILY_REFUND_USD, MIN_REFUND_USD, REFUNDS_FILE, TOKENS } from "./config.mjs";
import { assertRefundCap, getCorridor, refundUsedUnits } from "./guards.mjs";
import { refundNo } from "../lib/status.mjs";

/** The tokens a deposit can be refunded in: USD₮ and every local token in the currency registry, each in its own decimals. */
export const REFUND_TOKENS = Object.values(TOKENS);
/** A "sending" record this old is treated like a failed one by --retry (the process probably crashed). */
export const SENDING_STALE_MS = 10 * 60_000;
/** Auto-refund (watch --auto-refund): at most this many refunds per payer in 24 hours. */
export const AUTO_REFUND_PER_PAYER = 3;
const DAY_MS = 86_400_000;
const MAX_BLOCK_RANGE = 5000n;
const lc = (s) => String(s ?? "").toLowerCase();
/** The symbol of the token a corridor's payer deposits ("usdt-idrx" -> "USDT", "cngn-usdt" -> "cNGN"), or undefined. */
const sellSymbol = (dir) => { try { return getCorridor(dir).sellToken.symbol; } catch { return undefined; } };

// ---------- refunds.json ----------

/** { [`${tx}:${logIndex}` lower-case]: { id, status: "sending"|"refunded"|"failed"|"too_small_to_refund", ... } } */
export function loadRefunds(file = REFUNDS_FILE) {
  if (!fs.existsSync(file)) return {};
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  return j && typeof j.refunds === "object" && j.refunds && !Array.isArray(j.refunds) ? j.refunds : {};
}

/** Atomic write (tmp + rename). */
export function saveRefunds(state, file = REFUNDS_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ refunds: state }, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

// ---------- pure rules ----------

/** "0x<tx>:<logIndex>" -> { key (lower-case), tx, logIndex }; throws with the expected form. */
export function parseDepositKey(input) {
  const m = /^(0x[0-9a-fA-F]{64}):(\d{1,6})$/.exec(String(input ?? "").trim());
  if (!m) throw new Error(`Give the deposit as <tx hash>:<logIndex>, e.g. 0xabc…123:4 (see "node src/agent.mjs refunds"). Got "${input ?? ""}".`);
  const tx = m[1].toLowerCase();
  const logIndex = Number(m[2]);
  return { key: `${tx}:${logIndex}`, tx, logIndex };
}

/** Adds two 6-dp decimal strings ("5.03" + "0.000001"). */
const add6 = (a, b) => formatUnits(parseUnits(String(a), 6) + parseUnits(String(b), 6), 6);

/**
 * What autopilot's records say about one deposit. records: { requests, registrations, ntagPayments, receipts }.
 * Returns { payout: { what, paid } | null, refundable: { category, reason, payer, token, amount, at, source } | null }.
 *   payout: a payout is recorded for it (paid, being paid, or failed): it is NEVER refunded.
 *   refundable: autopilot refused it (category "refused"), matched nothing ("unmatched": incl. expired or used links)
 *   or matched two things ("ambiguous"). source: { kind: "ntag"|"registration"|"deposit", tag?, registration?, recipient? }.
 */
export function findDepositRecord({ key, tx, logIndex }, { requests = [], registrations = {}, ntagPayments = {}, receipts = [] } = {}) {
  const same = (d) => lc(d?.tx) === tx && Number(d?.logIndex) === logIndex;
  let payout = null;
  let refundable = null;
  for (const r of requests ?? []) if (same(r?.deposit)) payout ??= { what: `payment request ${r.id}`, paid: Boolean(r.paidAt) };
  for (const g of Object.values(registrations ?? {})) {
    if (same(g?.deposit)) payout ??= { what: `"Get paid" registration ${g.hash}`, paid: Boolean(g.paidAt) };
    const x = g?.refused?.[key];
    if (x && !refundable) {
      refundable = {
        category: "refused", reason: x.reason ?? "refused", payer: x.payer, token: sellSymbol(g.dir), amount: g.amount, at: x.refusedAt ?? x.at,
        source: { kind: "registration", registration: g.hash, recipient: g.from },
      };
    }
  }
  const p = ntagPayments?.[key];
  if (p) {
    const untouched = p.status === "refused" && !p.paidAt && !p.retrying && !p.hashes?.payout && !p.hashes?.swap;
    if (!untouched) payout ??= { what: `Lokal tag payment ${key}`, paid: Boolean(p.paidAt) };
    else if (!refundable) {
      let amount = p.amount;
      try { if (p.dust && amount != null) amount = add6(amount, p.dust); } catch { /* keep it */ }
      refundable = {
        category: "refused", reason: p.reason ?? "refused", payer: p.deposit?.payer, token: p.token ?? sellSymbol(p.dir), amount, at: p.refusedAt,
        source: { kind: "ntag", ...(p.tag ? { tag: p.tag } : {}), ...(p.from ?? p.owner ? { recipient: p.from ?? p.owner } : {}) },
      };
    }
  }
  if (!refundable) {
    for (const e of receipts ?? []) {
      if (e?.type !== "unmatched_deposit" && e?.type !== "ambiguous_deposit") continue;
      if (lc(e.tx) !== tx || (e.logIndex != null && Number(e.logIndex) !== logIndex)) continue;
      const ambiguous = e.type === "ambiguous_deposit";
      refundable = {
        category: ambiguous ? "ambiguous" : "unmatched",
        reason: ambiguous ? "matches a payment request and a Get paid link" : e.reason ?? "no open link with this token and exact amount (unmatched or expired)",
        payer: e.from, token: e.token, amount: e.amount, at: e.at, source: { kind: "deposit" },
      };
      break;
    }
  }
  return { payout, refundable };
}

/**
 * Why the refund record `r` (refunds.json) stops a new refund, or null. With `retry`, a failed record and a "sending"
 * record older than SENDING_STALE_MS may go on (the chain is searched first).
 */
export function refundRecordBlocker(r, { retry = false, now = Date.now() } = {}) {
  if (!r) return retry ? "There is no failed refund for this deposit to retry; run it without --retry." : null;
  const id = r.id;
  if (r.status === "refunded") return `${id} was already refunded (${r.refundNo ?? ""} https://celoscan.io/tx/${r.refundTx}). Nothing was sent.`;
  if (r.status === "too_small_to_refund") return `${id} is worth less than ${MIN_REFUND_USD} USD and is recorded as too_small_to_refund; it is left alone. Nothing was sent.`;
  if (r.status === "sending") {
    const age = now - Date.parse(r.startedAt);
    if (!retry || !(age >= SENDING_STALE_MS)) {
      return `A refund of ${id} is in progress since ${r.startedAt}${r.refundTx ? ` (tx ${r.refundTx})` : ""}. Nothing was sent. ` +
        `If that process crashed, check the agent's transactions on Celoscan; after 10 minutes "refund --deposit ${id} --retry" searches the chain first and only then sends.`;
    }
    return null;
  }
  if (r.status === "failed") {
    return retry ? null
      : `The refund of ${id} failed (${r.error ?? "no error saved"}) and is not retried automatically. ` +
        `Run "refund --deposit ${id} --retry": it first searches the chain for the refund and only sends when there is none.`;
  }
  return `${id} has a refund record in an unknown state (${r.status}). Nothing was sent.`;
}

/**
 * Who must never get a refund: the agent, the operator's own wallets (a top-up), a known contract (tokens, registries,
 * the Textile reactor the agent swapped with), the zero address. Returns the reason, or null.
 */
export function depositorBlocker(from, { agent, own = [], contracts = [] } = {}) {
  if (!isAddress(String(from ?? ""))) return "The depositor is not a valid address.";
  const f = lc(from);
  if (f === lc(zeroAddress)) return "The deposit came from the zero address (a mint), not from a wallet.";
  if (f === lc(agent)) return "The deposit came from the agent itself.";
  if (own.some((a) => lc(a) === f)) return "The deposit came from one of your own_wallets (contacts.json): it is a top-up, never refunded.";
  if (contracts.some((a) => lc(a) === f)) return "The deposit came from a contract the agent uses (a token, a registry or the Textile reactor), not from a payer.";
  return null;
}

/** The Textile reactors the agent has swapped with, from its payout receipts (pay() logs each one). */
export const knownReactors = (receipts = []) => [...new Set((receipts ?? []).map((e) => e?.reactor).filter((a) => isAddress(String(a ?? ""))).map(lc))];

/** Refunds to `payer` started in the 24 h before `now` (auto-refund allows AUTO_REFUND_PER_PAYER). */
export function refundsToPayer(refunds, payer, now = Date.now()) {
  return Object.values(refunds ?? {}).filter((r) => lc(r?.payer) === lc(payer) && r.status !== "too_small_to_refund"
    && Date.parse(r.startedAt) > now - DAY_MS).length;
}

/**
 * Every deposit the operator may refund, and every refund so far, newest first: { key, payer, token, amount, reason,
 * category, at, status: "refundable"|"sending"|"refunded"|"failed"|"too_small_to_refund", refundTx?, refundNo?, error? }.
 * A USDT deposit under MIN_REFUND_USD shows as too_small_to_refund (cNGN needs a price: refund checks it).
 */
export function refundRows(records = {}, refunds = {}) {
  const keys = new Map();
  const note = (key, tx, logIndex) => { if (!keys.has(key)) keys.set(key, { tx, logIndex }); };
  for (const k of Object.keys(records.ntagPayments ?? {})) { const [tx, i] = k.split(":"); note(lc(k), lc(tx), Number(i)); }
  for (const g of Object.values(records.registrations ?? {})) for (const k of Object.keys(g?.refused ?? {})) { const [tx, i] = k.split(":"); note(lc(k), lc(tx), Number(i)); }
  for (const e of records.receipts ?? []) {
    if (e?.type !== "unmatched_deposit" && e?.type !== "ambiguous_deposit") continue;
    note(e.logIndex != null ? `${lc(e.tx)}:${e.logIndex}` : `${lc(e.tx)}:?`, lc(e.tx), e.logIndex != null ? Number(e.logIndex) : null);
  }
  for (const k of Object.keys(refunds ?? {})) { const [tx, i] = k.split(":"); note(lc(k), lc(tx), Number(i)); }
  const rows = [];
  for (const [key, { tx, logIndex }] of keys) {
    const r = refunds?.[key];
    const found = logIndex == null
      ? findDepositRecord({ key, tx, logIndex: -1 }, { receipts: (records.receipts ?? []).filter((e) => e?.logIndex == null) })
      : findDepositRecord({ key, tx, logIndex }, records);
    if (!r && (found.payout || !found.refundable)) continue;
    const d = found.refundable ?? {};
    let status = r?.status ?? "refundable";
    if (!r && d.token === "USDT") { try { if (parseUnits(String(d.amount), 6) < parseUnits(MIN_REFUND_USD, 6)) status = "too_small_to_refund"; } catch { /* leave it */ } }
    rows.push({
      key, payer: r?.payer ?? d.payer, token: r?.token ?? d.token, amount: r?.amount ?? d.amount, reason: r?.reason ?? d.reason,
      category: r?.category ?? d.category, at: d.at ?? r?.startedAt, status,
      ...(r?.refundTx ? { refundTx: r.refundTx } : {}), ...(r?.refundNo ? { refundNo: r.refundNo } : {}), ...(r?.error ? { error: r.error } : {}),
    });
  }
  return rows.sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
}

/** "3 h", "2 d": how long ago `at` was. */
export function age(at, now = Date.now()) {
  const ms = now - Date.parse(at);
  if (!Number.isFinite(ms)) return "?";
  const m = Math.max(0, Math.round(ms / 60_000));
  return m < 60 ? `${m} min` : m < 48 * 60 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;
}

// ---------- chain ----------

/**
 * Re-reads the deposit over RPC: the transaction succeeded, log `logIndex` is an ERC-20 Transfer of USDT or cNGN to the
 * agent with a non-zero amount, and the transaction was not sent by the agent (its own swap output). Throws otherwise.
 * Returns { token, from (checksummed), value, block, txFrom }.
 */
export async function readDepositOnchain(pub, { tx, logIndex }, agent) {
  const rc = await pub.getTransactionReceipt({ hash: tx });
  if (!rc) throw new Error(`Transaction ${tx} was not found on Celo. Nothing was sent.`);
  if (rc.status !== "success") throw new Error(`Transaction ${tx} reverted; nothing arrived. Nothing was sent.`);
  if (lc(rc.from) === lc(agent)) throw new Error(`Transaction ${tx} was sent by the agent itself (its own swap or payout), not by a payer. Never refunded.`);
  const log = (rc.logs ?? []).find((l) => Number(l.logIndex) === logIndex);
  if (!log) throw new Error(`Transaction ${tx} has no log ${logIndex}. Check the deposit key with "node src/agent.mjs refunds". Nothing was sent.`);
  const token = REFUND_TOKENS.find((t) => lc(t.address) === lc(log.address));
  if (!token) throw new Error(`Log ${logIndex} of ${tx} is not a transfer of a token Lokal knows (${REFUND_TOKENS.map((t) => t.symbol).join(", ")}). Nothing was sent.`);
  const [ev] = parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: [log], strict: true });
  if (!ev) throw new Error(`Log ${logIndex} of ${tx} is not an ERC-20 Transfer. Nothing was sent.`);
  if (lc(ev.args.to) !== lc(agent)) throw new Error(`Log ${logIndex} of ${tx} is a transfer to ${ev.args.to}, not to the agent. Nothing was sent.`);
  if (ev.args.value <= 0n) throw new Error(`Log ${logIndex} of ${tx} moved nothing. Nothing was sent.`);
  return { token, from: getAddress(ev.args.from), value: ev.args.value, block: rc.blockNumber, txFrom: rc.from };
}

/**
 * The USD value (6-dp USD₮ units) of `value` base units of `token` (in the token's own decimals): USD₮ 1:1, a local
 * token from a live Textile preview selling it for USD₮, or, when that pair isn't quoted, from the price of 1 USD₮ in
 * that token (value x 1 USD₮ / what 1 USD₮ buys). Throws when there is no price at all.
 */
export async function refundUsdUnits(token, value, preview) {
  if (lc(token.address) === lc(TOKENS.USDT.address)) return BigInt(value);
  const usdt = TOKENS.USDT;
  let pv = null;
  try { pv = await preview(token.address, usdt.address, BigInt(value).toString()); } catch { pv = null; }
  if (pv?.status === "preview" && BigInt(pv.buyAmount) > 0n) return BigInt(pv.buyAmount);
  let inv = null;
  const one = 10n ** BigInt(usdt.decimals);
  try { inv = await preview(usdt.address, token.address, one.toString()); } catch { inv = null; }
  if (inv?.status === "preview" && BigInt(inv.buyAmount) > 0n) return (BigInt(value) * one) / BigInt(inv.buyAmount);
  throw new Error(`No ${token.symbol} price right now (${pv?.status ?? inv?.status ?? "no answer"}), so the refund limits (in USD) can't be checked. Try again shortly. Nothing was sent.`);
}

/** The Transfer of `token` from the agent to `to` for exactly `value` in a receipt's logs, or null. */
export function refundTransferIn(logs, { token, agent, to, value }) {
  return parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: logs ?? [] }).find((l) =>
    lc(l.address) === lc(token) && lc(l.args.from) === lc(agent) && lc(l.args.to) === lc(to) && l.args.value === BigInt(value)) ?? null;
}

/**
 * Searches the chain for a refund that may have gone through: a Transfer of `token` from the agent to `to` for exactly
 * `value`, from block `fromBlock` on (the block when the refund was recorded). Returns the tx hash or null.
 */
export async function findRefundOnchain(pub, { token, agent, to, value, fromBlock }) {
  const latest = await pub.getBlockNumber();
  for (let a = BigInt(fromBlock); a <= latest; a += MAX_BLOCK_RANGE) {
    const b = a + MAX_BLOCK_RANGE - 1n < latest ? a + MAX_BLOCK_RANGE - 1n : latest;
    const logs = await pub.getLogs({
      address: token, event: erc20Abi.find((x) => x.type === "event" && x.name === "Transfer"), args: { from: agent, to }, fromBlock: a, toBlock: b, strict: true,
    });
    const hit = logs.find((l) => l.args.value === BigInt(value));
    if (hit) return hit.transactionHash;
  }
  return null;
}

// ---------- the flow ----------

/**
 * Plans one refund: every check, nothing written or sent. deps: { pub, agent, own, loadRecords, preview, now }
 *   (loadRecords() -> { requests, registrations, ntagPayments, receipts, refunds }).
 * opts: { retry, auto }. Returns the plan: { key, tx, logIndex, deposit, record, existing, token, payer, value, amount,
 * usdUnits, tooSmall, foundTx?, gas? }. Throws a plain-English reason when the deposit must not be refunded.
 */
export async function planRefund(input, deps, { retry = false, auto = false } = {}) {
  const { key, tx, logIndex } = parseDepositKey(input);
  const now = deps.now?.() ?? Date.now();
  const records = deps.loadRecords();
  const existing = records.refunds?.[key] ?? null;
  const blocker = refundRecordBlocker(existing, { retry, now });
  if (blocker) throw new Error(blocker);
  const { payout, refundable } = findDepositRecord({ key, tx, logIndex }, records);
  if (payout) {
    throw new Error(`${key} is ${payout.paid ? "PAID" : "recorded for a payout"} (${payout.what}). A deposit with a payout is never refunded` +
      `${payout.paid ? "" : "; settle it with retry"}. Nothing was sent.`);
  }
  if (!refundable) {
    throw new Error(`Autopilot has no refusal, unmatched or ambiguous record of ${key}. Only those are refunded: let "watch" see the deposit first ` +
      `(it may still match a link). Nothing was sent.`);
  }
  if (auto && refundable.category !== "refused") throw new Error(`${key} is ${refundable.category}; only refused deposits are refunded automatically.`);

  const deposit = await readDepositOnchain(deps.pub, { tx, logIndex }, deps.agent);
  if (refundable.payer && lc(refundable.payer) !== lc(deposit.from)) {
    throw new Error(`The record says ${key} came from ${refundable.payer}, but the chain says ${deposit.from}. Nothing was sent; check it by hand.`);
  }
  const who = depositorBlocker(deposit.from, { agent: deps.agent, own: deps.own ?? [], contracts: [...(deps.contracts ?? []), ...knownReactors(records.receipts)] });
  if (who) throw new Error(`${who} Nothing was sent.`);
  if (auto && refundsToPayer(records.refunds, deposit.from, now) >= AUTO_REFUND_PER_PAYER) {
    throw new Error(`${deposit.from} already had ${AUTO_REFUND_PER_PAYER} refunds in 24 hours; this one waits for the operator (node src/agent.mjs refund --deposit ${key}).`);
  }

  const token = deposit.token;
  const amount = formatUnits(deposit.value, token.decimals);
  const usdUnits = await refundUsdUnits(token, deposit.value, deps.preview);
  const tooSmall = usdUnits < parseUnits(MIN_REFUND_USD, 6);
  const plan = {
    key, tx, logIndex, deposit, record: refundable, existing, token, payer: deposit.from, value: deposit.value, amount, usdUnits, tooSmall,
  };
  if (tooSmall) return plan;
  assertRefundCap(refundUsedUnits(records.receipts, now), usdUnits, MAX_DAILY_REFUND_USD);

  // --retry: the refund may have gone through after all. Look before sending again.
  if (existing) {
    if (existing.refundTx) {
      const rc = await deps.pub.getTransactionReceipt({ hash: existing.refundTx }).catch(() => null);
      if (rc?.status === "success" && refundTransferIn(rc.logs, { token: token.address, agent: deps.agent, to: deposit.from, value: deposit.value })) {
        return { ...plan, foundTx: existing.refundTx };
      }
    }
    const fromBlock = existing.startBlock != null ? BigInt(existing.startBlock) : BigInt(deposit.block);
    const hit = await findRefundOnchain(deps.pub, { token: token.address, agent: deps.agent, to: deposit.from, value: deposit.value, fromBlock });
    if (hit) return { ...plan, foundTx: hit };
  }

  const [bal, celo] = await Promise.all([
    deps.pub.readContract({ address: token.address, abi: erc20Abi, functionName: "balanceOf", args: [deps.agent] }),
    deps.pub.getBalance({ address: deps.agent }),
  ]);
  if (bal < deposit.value) {
    throw new Error(`The agent holds ${formatUnits(bal, token.decimals)} ${token.symbol}; the refund needs ${amount}. Top it up first. Nothing was sent.`);
  }
  let gas = null;
  try {
    const [units, price] = await Promise.all([
      deps.pub.estimateContractGas({ address: token.address, abi: erc20Abi, functionName: "transfer", args: [deposit.from, deposit.value], account: deps.agent }),
      deps.pub.getGasPrice(),
    ]);
    gas = { units, fee: units * price };
  } catch { /* shown as "could not estimate" */ }
  const need = gas ? gas.fee * 2n : parseUnits("0.02", 18);
  if (celo < need) throw new Error(`The agent holds ${formatUnits(celo, 18)} CELO; a refund needs about ${formatUnits(need, 18)} CELO for gas. Nothing was sent.`);
  return { ...plan, gas, celo };
}

/** One line per plan detail, for the dry run and before the confirmation. */
export function describePlan(p) {
  const lines = [
    `Deposit ${p.key}: ${p.amount} ${p.token.symbol} from ${p.payer} (${p.record.category}: ${p.record.reason}).`,
    `Refund: ${p.amount} ${p.token.symbol} back to ${p.payer} (~${formatUnits(p.usdUnits, 6)} USD), same token and amount.`,
  ];
  if (p.tooSmall) lines.push(`It is worth less than ${MIN_REFUND_USD} USD (MIN_REFUND_USD): recorded as too_small_to_refund and left alone, never sent.`);
  else if (p.foundTx) lines.push(`The refund already went through: https://celoscan.io/tx/${p.foundTx}. It will be marked refunded; nothing is sent again.`);
  else lines.push(p.gas ? `Gas: ~${p.gas.units} gas, ~${formatUnits(p.gas.fee, 18)} CELO (the agent pays it).` : "Gas: could not estimate right now.");
  return lines;
}

/**
 * Carries out a plan (the caller holds the agent lock and has the operator's yes). deps: { pub, wallet, agent,
 * loadRefunds, saveRefunds, log, verifyTx, attributionCode, now, say, report, alert }. Records before sending; a failure
 * after that is saved as "failed" (never retried automatically) and thrown. Returns { status, refundTx?, refundNo? }.
 */
export async function executeRefund(p, deps, { auto = false } = {}) {
  const now = () => new Date(deps.now?.() ?? Date.now()).toISOString();
  const say = deps.say ?? (() => {});
  const save = (fields) => {
    const s = deps.loadRefunds();
    s[p.key] = { ...(s[p.key] ?? {}), ...fields };
    deps.saveRefunds(s);
    return s[p.key];
  };
  const base = {
    id: p.key, depositTx: p.tx, logIndex: p.logIndex, payer: p.payer, token: p.token.symbol, amount: p.amount, units: String(p.value),
    usd: formatUnits(p.usdUnits, 6), category: p.record.category, reason: p.record.reason, source: p.record.source, ...(auto ? { auto: true } : {}),
  };
  if (p.tooSmall) {
    save({ ...base, status: "too_small_to_refund", startedAt: now() });
    say(`${p.key} is worth less than ${MIN_REFUND_USD} USD: recorded as too_small_to_refund and left alone.`);
    return { status: "too_small_to_refund" };
  }
  if (p.foundTx) return finish(p.foundTx, { found: true });

  // Record BEFORE sending: a crash from here on leaves "sending", which every command treats as in progress.
  const startBlock = await deps.pub.getBlockNumber().catch(() => p.deposit.block);
  save({
    ...base, status: "sending", startedAt: now(), startBlock: String(startBlock), attempts: (p.existing?.attempts ?? 0) + 1,
    refundTx: undefined, error: undefined, failedAt: undefined,
  });
  let hash;
  try {
    hash = await deps.wallet.writeContract({ address: p.token.address, abi: erc20Abi, functionName: "transfer", args: [p.payer, p.value] });
  } catch (e) {
    return fail(`the transfer could not be sent (${e.shortMessage ?? e.message})`);
  }
  try { save({ refundTx: hash }); } catch (e) { say(`Could not save the refund tx ${hash} (${e.message}); it is still marked "sending".`); }
  let rc;
  try { rc = await deps.pub.waitForTransactionReceipt({ hash }); } catch (e) {
    return fail(`no receipt for ${hash} (${e.shortMessage ?? e.message}); it may still go through`, hash);
  }
  if (rc.status !== "success") return fail(`the refund transaction reverted (${hash})`, hash);
  if (!refundTransferIn(rc.logs, { token: p.token.address, agent: deps.agent, to: p.payer, value: p.value })) {
    return fail(`the refund transaction ${hash} succeeded but holds no matching transfer; check it on Celoscan`, hash);
  }
  return finish(hash, { found: false });

  function fail(why, tx) {
    const msg = `Refund of ${p.key} failed: ${why}. It is recorded as failed and not retried automatically; ` +
      `"node src/agent.mjs refund --deposit ${p.key} --retry" searches the chain first and only then sends.`;
    try { save({ status: "failed", error: why, failedAt: now(), ...(tx ? { refundTx: tx } : {}) }); } catch (e) {
      say(`Could not save the failure of ${p.key} (${e.message}). Do NOT refund it again before checking the agent's transactions on Celoscan.`);
    }
    try { deps.alert?.("refund_failed", `${msg}`); } catch { /* alerts never matter here */ }
    throw Object.assign(new Error(msg), { refundFailed: true });
  }

  async function finish(tx, { found }) {
    let tags = null;
    try { tags = deps.verifyTx ? ((await deps.verifyTx({ client: deps.pub, hash: tx }))?.codes ?? null) : null; } catch { tags = null; }
    const untagged = deps.attributionCode && !found && !tags?.includes(deps.attributionCode);
    const no = refundNo(tx);
    let rec;
    try {
      rec = save({ ...base, status: "refunded", refundTx: tx, refundNo: no, refundedAt: now(), ...(found ? { foundOnchain: true } : {}), error: undefined });
    } catch (e) {
      throw new Error(`${p.key} was REFUNDED (tx ${tx}), but saving that failed: ${e.message}. Do NOT refund it again: fix refunds.json by hand.`);
    }
    try {
      deps.log?.({
        kind: "refund", type: "refund", key: p.key, depositTx: p.tx, logIndex: p.logIndex, payer: p.payer, recipient: p.payer,
        token: p.token.symbol, amount: p.amount, usd: formatUnits(p.usdUnits, 6), refundNo: no, hashes: { refund: tx }, tags, ...(auto ? { auto: true } : {}),
      });
    } catch (e) { say(`Refunded, but could not log it to receipts.jsonl (${e.message}).`); }
    try { await deps.report?.(rec); } catch { /* reporting never matters here */ }
    say(`Refunded ${p.amount} ${p.token.symbol} to ${p.payer}${found ? " (found onchain; nothing sent again)" : ""}. ${no}: https://celoscan.io/tx/${tx}`);
    if (untagged) say(`WARNING: the refund transaction lacks the attribution tag ${deps.attributionCode}.`);
    return { status: "refunded", refundTx: tx, refundNo: no, found, untagged: Boolean(untagged) };
  }
}

/**
 * The whole refund command. deps as for planRefund + executeRefund, plus { confirm(question), lock() -> { release } }.
 * opts: { execute, yes, retry, auto }. Dry run unless execute. With execute: plan -> confirm (unless yes) -> lock ->
 * plan again from fresh records and the chain -> execute. Returns { dryRun, plan } | { cancelled } | executeRefund's result.
 */
export async function refundDeposit(input, deps, { execute = false, yes = false, retry = false, auto = false } = {}) {
  const say = deps.say ?? (() => {});
  const first = await planRefund(input, deps, { retry, auto });
  for (const l of describePlan(first)) say(l);
  if (!execute) {
    say("DRY RUN: nothing was written or sent. Add --execute to refund it for real.");
    return { dryRun: true, plan: first };
  }
  if (!yes && !first.tooSmall && !first.foundTx && !(await deps.confirm(`About to send ${first.amount} ${first.token.symbol} back to ${first.payer} on Celo MAINNET.`))) {
    say("Cancelled. Nothing was sent.");
    return { cancelled: true };
  }
  const lock = deps.lock?.() ?? null;
  try {
    const plan = await planRefund(input, deps, { retry, auto }); // fresh records and a fresh read of the chain
    if (plan.value !== first.value || lc(plan.payer) !== lc(first.payer)) throw new Error("The deposit changed between the dry run and now. Nothing was sent.");
    return await executeRefund(plan, deps, { auto });
  } finally {
    try { lock?.release?.(); } catch { /* the exit hook releases it */ }
  }
}
