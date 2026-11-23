// Autopilot for payments made through the contracts: LokalTags `TagPaid` and LokalPots `PotPaid`.
//
// Inside one payTag / payTagWithPermit / payPot transaction the contract checks every limit and then moves the tokens
// from the payer straight to its payout wallet (this agent) with ONE transferFrom; only then does it emit the event.
// So by the time autopilot sees TagPaid, the money is in the agent wallet and the event names who to pay:
//   TagPaid(tagHash, tag, recipient, payer, token, amount, ref, dayIndex)   -> pay `recipient` (the tag's holder then)
//   PotPaid(potId, host, payer, token, amount, ref, totalSoFar, amountUsd6) -> pay the pot's `host`
// in the currency the PAYER chose for this payment (the event's `ref`, "cur:<code>"), else the recipient's optional
// default on the contract (receiveTokenOf at the payment's block), else naira (see routeFor).
//
// The same safety path as every other payout: pre-flight (recipient rules, the agent's own caps, a live preview),
// the deposit recorded BEFORE paying (contract-payments.json, keyed by the event's tx:logIndex, so it is paid exactly
// once), then pay() (firm quote, exact approval, measured payout, attribution tag) or, when no conversion is needed,
// forward() (exact amount, same checks). The contract's caps are an outer bound: the agent's stricter caps still
// apply, and a refusal is recorded like any other (a rescan never pays it).
//
// The ERC-20 Transfer into the agent that happens INSIDE such a transaction is that payment, not a deposit of its own:
// `merge` removes it from the list the legacy deposit path (requests, registrations, NTP: memos) sees, so it can never
// be matched by amount or refused as an unmatched deposit. Events are read with plain eth_getLogs over the same block
// range, cursor and indexed head as the Transfer logs (src/watch.mjs calls this file at one point per chunk).
import fs from "node:fs";
import path from "node:path";
import { formatUnits, getAddress, parseAbi, parseUnits } from "viem";
import { CONTRACT_PAYMENTS_FILE, CORRIDORS, LEGACY_CUTOVER_BLOCK, PAYOUT_CORRIDORS, LOKAL_POTS, LOKAL_TAGS, LOKAL_TAGS_BLOCK, TOKENS } from "./config.mjs";
import { CURRENCIES, DEFAULT_CURRENCY, USDT_ADDRESS, corridorFor, reverseCorridorFor } from "./currencies.mjs";
import { refusal } from "./guards.mjs";
import { forward, forwardPreflight } from "./forward.mjs";

/** The parts of the verified ABIs (contracts/deployments/*.json) autopilot uses; test/contract-watch.test.mjs compares them. */
export const TAGS_ABI = parseAbi([
  "event TagPaid(bytes32 indexed tagHash, string tag, address indexed recipient, address indexed payer, address token, uint256 amount, bytes32 ref, uint256 dayIndex)",
  "function receiveTokenOf(address holder) view returns (address token)",
  "function tagOf(address holder) view returns (string)",
  "function tagInfo(string tag) view returns (address owner, string name, uint256 since, address lockedFor, uint256 lockedUntil, address receiveToken)",
]);
export const POTS_ABI = parseAbi([
  "event PotPaid(uint256 indexed potId, address indexed host, address indexed payer, address token, uint256 amount, bytes32 ref, uint256 totalSoFar, uint256 amountUsd6)",
  "function usdValue(address token, uint256 amount) view returns (uint256)",
]);
const TAG_PAID = TAGS_ABI[0];
const POT_PAID = POTS_ABI[0];
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO = "0x0000000000000000000000000000000000000000";
const lc = (s) => String(s ?? "").toLowerCase();
const short = (a) => `${String(a).slice(0, 6)}…${String(a).slice(-4)}`;

// ---------- pure (unit-tested) ----------

/** The TOKENS entry for a token address, or null. */
export const tokenByAddress = (addr) => Object.values(TOKENS).find((t) => lc(t.address) === lc(addr)) ?? null;
/** "usdt" | "cngn" | "idrx" | "wars" | "wcop" | null for a token address. */
export function tokenCode(addr) {
  if (lc(addr) === lc(USDT_ADDRESS)) return "usdt";
  return CURRENCIES.find((c) => lc(c.address) === lc(addr))?.code ?? null;
}

/** What a payer can choose in the ref: dollars or any local currency. */
export const REF_CODES = ["usdt", ...CURRENCIES.map((c) => c.code)];
/**
 * The payer's per-payment currency choice from a TagPaid / PotPaid `ref`: the ASCII text "cur:<code>" left-aligned
 * and zero-padded to 32 bytes ("cur:idrx" -> rupiah, "cur:usdt" -> dollars). Anything else is the payer's own opaque
 * reference and chooses nothing: null. Same encoding as currencyRef / currencyOfRef in site/assets/lokal-contracts.js.
 */
export function currencyOfRef(ref) {
  const h = lc(ref).replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(h)) return null;
  const bytes = Buffer.from(h, "hex");
  const end = bytes.indexOf(0) === -1 ? 32 : bytes.indexOf(0);
  if (bytes.subarray(end).some((b) => b !== 0)) return null;
  const text = bytes.subarray(0, end).toString("latin1");
  if (!text.startsWith("cur:")) return null;
  const code = text.slice(4);
  return REF_CODES.includes(code) ? code : null;
}

/**
 * What a contract payment pays out in. The PAYER's choice for this payment (`chosen`, from the ref) wins; then the
 * recipient's optional default (their receive token on LokalTags, set with setReceiveToken); then: a TAG pays USD₮
 * payments in naira (DEFAULT_CURRENCY, as since the memo days) and cNGN payments in dollars and passes any other token
 * through; a POT pays dollars. A payment already in the token the recipient gets is passed through as is. USD₮ converts
 * into any local currency (usdt-<code>); any local token converts into dollars (<code>-usdt: cngn, idrx, wars, wcop);
 * one local currency into another is refused.
 * Returns { mode: "swap", corridor, receive } | { mode: "forward", receive } | null (refused: no route).
 * Same rule as payoutRoute in site/assets/lokal-contracts.js (a test checks every case).
 */
export function routeFor(paidToken, receiveToken, kind = "tag", chosen = null) {
  const paid = tokenCode(paidToken);
  if (!paid) return null;
  if (chosen != null && !REF_CODES.includes(chosen)) return null;
  const isSet = receiveToken != null && lc(receiveToken) !== ZERO;
  const set = isSet ? tokenCode(receiveToken) : null;
  if (chosen == null && isSet && !set) return null;
  const want = chosen ?? set ?? (kind === "pot" ? "usdt" : paid === "usdt" ? DEFAULT_CURRENCY : paid === "cngn" ? "usdt" : paid);
  if (paid === want) return { mode: "forward", receive: want };
  if (paid === "usdt" && CORRIDORS[corridorFor(want)]) return { mode: "swap", corridor: corridorFor(want), receive: want };
  if (want === "usdt" && PAYOUT_CORRIDORS[reverseCorridorFor(paid)]) return { mode: "swap", corridor: reverseCorridorFor(paid), receive: "usdt" };
  return null;
}

/**
 * Smallest swap autopilot pays, in the sell token's own units (TOKENS key -> decimal string). USD₮: Textile's ~$1
 * minimum. Local tokens: a dust floor well under $1; every local -> dollars swap is also checked live (ntagUsdFloor:
 * a preview under $1 is a permanent refusal).
 */
export const CONTRACT_MIN = { USDT: "1", CNGN: "1000", IDRX: "10000", WARS: "1000", WCOP: "2000" };

/**
 * A log from eth_getLogs (viem, decoded with TAGS_ABI / POTS_ABI) -> the payment, or null when it is not a TagPaid from
 * LokalTags or a PotPaid from LokalPots. { kind "tag"|"pot", key (tx:logIndex, lower-case), tx, logIndex, block (bigint),
 * txIndex, tag?, potId?, recipient, payer, token, amount (bigint), ref }.
 */
export function decodeContractLog(l) {
  const addr = lc(l?.address);
  const base = { tx: l?.transactionHash, logIndex: Number(l?.logIndex), block: BigInt(l?.blockNumber ?? 0), txIndex: Number(l?.transactionIndex ?? 0) };
  if (!base.tx || !Number.isInteger(base.logIndex)) return null;
  const key = `${base.tx}:${base.logIndex}`.toLowerCase();
  const a = l.args ?? {};
  if (addr === lc(LOKAL_TAGS) && l.eventName === "TagPaid") {
    return { kind: "tag", key, ...base, tag: a.tag, recipient: getAddress(a.recipient), payer: getAddress(a.payer), token: getAddress(a.token), amount: BigInt(a.amount), ref: a.ref };
  }
  if (addr === lc(LOKAL_POTS) && l.eventName === "PotPaid") {
    return { kind: "pot", key, ...base, potId: BigInt(a.potId), recipient: getAddress(a.host), payer: getAddress(a.payer), token: getAddress(a.token), amount: BigInt(a.amount), ref: a.ref };
  }
  return null;
}

/**
 * The Transfer log inside the payment's own transaction that moved the money into `agent`: same token, from the payer,
 * to the agent, exactly `amount`, and the last such log BEFORE the event (the contract emits right after its single
 * transferFrom). `logs` are the receipt's raw logs. Returns { key (tx:logIndex), logIndex } or null (the money went
 * elsewhere, e.g. the payout wallet was changed to another address).
 */
export function innerTransfer(ev, logs, agent) {
  let best = null;
  for (const l of logs ?? []) {
    const i = Number(l.logIndex);
    if (!(i < ev.logIndex) || lc(l.address) !== lc(ev.token) || lc(l.topics?.[0]) !== TRANSFER_TOPIC || (l.topics?.length ?? 0) !== 3) continue;
    if (lc("0x" + String(l.topics[1]).slice(26)) !== lc(ev.payer) || lc("0x" + String(l.topics[2]).slice(26)) !== lc(agent)) continue;
    let v;
    try { v = BigInt(l.data); } catch { continue; }
    if (v !== ev.amount) continue;
    if (!best || i > best.logIndex) best = { key: `${ev.tx}:${i}`.toLowerCase(), logIndex: i };
  }
  return best;
}

/**
 * The scanned Transfer logs (to the agent) and the contract payments of one block range, in chain order, with every
 * payment's inner Transfer removed: [{ transfer: log } | { contract: ev }]. `innerKeys` = Set of tx:logIndex.
 */
export function mergeLogs(transfers, events, innerKeys) {
  const items = [
    ...transfers.filter((l) => !innerKeys.has(`${l.transactionHash}:${l.logIndex}`.toLowerCase())).map((l) => ({ block: BigInt(l.blockNumber), logIndex: Number(l.logIndex), transfer: l })),
    ...events.map((ev) => ({ block: ev.block, logIndex: ev.logIndex, contract: ev })),
  ];
  items.sort((a, b) => (a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1));
  return items;
}

/** Base units of the sell token -> pay() amount string in its own decimals (the whole payment, to the last unit). */
const payAmount = (units, decimals) => ({ amount: formatUnits(BigInt(units), decimals), units: BigInt(units) });

// ---------- local state (git-ignored) ----------

/** { [event tx:logIndex]: { kind, tag, from, token, amount, dir, deposit, status?, reason?, paidAt?, hashes?, ... } } */
export function loadContractPayments(file = CONTRACT_PAYMENTS_FILE) {
  if (!fs.existsSync(file)) return {};
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  return j && typeof j.payments === "object" && j.payments && !Array.isArray(j.payments) ? j.payments : {};
}
/** Atomic write (tmp + rename). */
export function saveContractPayments(state, file = CONTRACT_PAYMENTS_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ payments: state }, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

/**
 * contract-payments.json seen as deposits: { [depositKey (the inner Transfer's tx:logIndex)]: record } in the shape of
 * ntag-payments.json records. refund.mjs and the status sync read deposits by that key, so a refused contract payment
 * is refundable to the payer (from the event; the Transfer's `from`), and a paid or recorded one never is.
 */
export function contractDepositRecords(payments) {
  const out = {};
  for (const p of Object.values(payments ?? {})) if (p?.depositKey) out[p.depositKey] = { ...p, id: p.depositKey, eventKey: p.id, source: "contract" };
  return out;
}
/** The same, read from disk. */
export const loadContractDeposits = (file = CONTRACT_PAYMENTS_FILE) => contractDepositRecords(loadContractPayments(file));

// ---------- chain reads (replaceable in tests through io) ----------

/** At the payment's block when the node still has that state, else now (then `latest: true`). */
async function readAt(pub, args, block) {
  try { return { value: await pub.readContract({ ...args, blockNumber: BigInt(block) }), latest: false }; } catch {
    return { value: await pub.readContract(args), latest: true };
  }
}

/** Everything autopilot needs from the outside world for contract payments. watch.mjs merges this into its io. */
export const CONTRACT_IO = {
  loadContractPayments, saveContractPayments, forward, forwardPreflight,
  /** TagPaid / PotPaid logs in [fromBlock, toBlock] (nothing before the contracts were deployed). */
  getContractLogs: async (pub, { fromBlock, toBlock }) => {
    if (BigInt(toBlock) < LOKAL_TAGS_BLOCK) return [];
    const from = BigInt(fromBlock) < LOKAL_TAGS_BLOCK ? LOKAL_TAGS_BLOCK : BigInt(fromBlock);
    return pub.getLogs({ address: [LOKAL_TAGS, LOKAL_POTS], events: [TAG_PAID, POT_PAID], fromBlock: from, toBlock: BigInt(toBlock), strict: true });
  },
  readReceiveToken: (pub, holder, block) => readAt(pub, { address: LOKAL_TAGS, abi: TAGS_ABI, functionName: "receiveTokenOf", args: [holder] }, block),
  readTagOfAt: (pub, holder, block) => readAt(pub, { address: LOKAL_TAGS, abi: TAGS_ABI, functionName: "tagOf", args: [holder] }, block),
  readTagInfoAt: (pub, tag, block) => readAt(pub, { address: LOKAL_TAGS, abi: TAGS_ABI, functionName: "tagInfo", args: [tag] }, block),
  readUsdValue: (pub, token, amount) => pub.readContract({ address: LOKAL_POTS, abi: POTS_ABI, functionName: "usdValue", args: [token, BigInt(amount)] }),
};

// ---------- autopilot ----------

/**
 * ctx: { io (watch's io, incl. CONTRACT_IO), pub, agent, execute, say, report (status event fields), pin, StopError,
 * rescanFrom: () => bigint }. Returns { scan, merge, handle, memoOwner }.
 */
export function makeContractWatch({
  io, pub, agent, execute, say, report = () => {}, pin = () => {}, StopError = Error, rescanFrom = () => "?", onRefused = async () => {},
}) {
  const dry = new Map(); // dry run only: event key -> simulated record
  const seen = new Set(); // events fully handled in this run
  const blockTime = new Map();
  const payments = () => {
    const s = io.loadContractPayments();
    for (const [k, d] of dry) s[k] = { ...(s[k] ?? {}), ...d };
    return s;
  };

  /** The contract payments in [from, to], each with `inner` = its Transfer into the agent (or null). */
  async function scan(from, to) {
    const logs = await io.getContractLogs(pub, { fromBlock: from, toBlock: to });
    const events = [];
    const receipts = new Map();
    for (const l of logs) {
      const ev = decodeContractLog(l);
      if (!ev) continue;
      if (!receipts.has(ev.tx)) receipts.set(ev.tx, await pub.getTransactionReceipt({ hash: ev.tx }));
      const rc = receipts.get(ev.tx);
      ev.inner = rc?.status === "success" || rc?.status === "0x1" ? innerTransfer(ev, rc.logs, agent) : null;
      events.push(ev);
    }
    return events;
  }
  /** Chain-ordered items for one chunk: the legacy Transfer logs minus the payments' inner transfers, plus the payments. */
  function merge(transfers, events) {
    return mergeLogs(transfers, events, new Set(events.map((e) => e.inner?.key).filter(Boolean)));
  }

  /**
   * Who a legacy NTP: memo deposit pays when the tag is ALSO held on LokalTags: from LEGACY_CUTOVER_BLOCK on, the
   * contract's owner (at the deposit's block) wins. Returns an entry like the legacy resolver's { owner, name, since,
   * hash: null, source: "contract" }, or null (before the cutover, or nobody holds it on the contract).
   */
  async function memoOwner(tag, block) {
    if (!tag || BigInt(block) < LEGACY_CUTOVER_BLOCK) return null;
    const { value } = await io.readTagInfoAt(pub, tag, block);
    const [owner, name, since] = value ?? [];
    if (!owner || lc(owner) === ZERO) return null;
    return { owner: lc(owner), name: name || null, since: Number(since ?? 0), hash: null, block: Number(block), position: 0, source: "contract" };
  }

  async function handle(ev) {
    if (seen.has(ev.key)) return;
    await handleEvent(ev);
    seen.add(ev.key);
  }

  /**
   * A permanent refusal: logged and recorded (a rescan never pays it). When the money reached this agent, the deposit
   * (the inner Transfer, from the payer) is refundable like any refused deposit: `refund --deposit <depositKey>` sends
   * it back to the PAYER named in the event, never to the contract; with --auto-refund that happens right away.
   */
  async function refuse(ev, reason, rec, where, { quiet = false } = {}) {
    say(`Refused ${where.what}: ${where.amount} ${where.token} from ${short(where.from)} (tx ${where.tx}): ${reason}${/[.!]$/.test(reason) ? "" : "."} NOT paid; the money stays in the agent wallet${execute ? " (recorded as refused)" : ""}. Continuing.`);
    if (!execute) return;
    io.log({ type: "refused_deposit", source: "contract", reason, ...where, ...(ev.inner ? { depositKey: ev.inner.key } : {}) });
    const s = io.loadContractPayments();
    s[ev.key] = { ...(s[ev.key] ?? {}), ...rec, id: ev.key, status: "refused", reason, refusedAt: new Date().toISOString() };
    io.saveContractPayments(s);
    if (quiet || !ev.inner) return;
    reportEvent(ev, s[ev.key], "refused", { reason, at: s[ev.key].refusedAt });
    try { await onRefused(ev.inner.key, reason, where); } catch { /* refunds and alerts never stop autopilot */ }
  }
  /**
   * Status server: kind "ntag" (pots: the host's tag), under the DEPOSIT's id (the inner Transfer's tx:logIndex), the
   * same id refunds use. Any token the agent knows (USD₮, cNGN, IDRX, wARS, wCOP).
   */
  function reportEvent(ev, rec, status, extra = {}) {
    if (!ev.inner || !rec?.tag || !Object.values(TOKENS).some((t) => t.symbol === rec.token)) return;
    try {
      report({ kind: "ntag", key: ev.inner.key, tag: rec.tag, recipient: rec.from, token: rec.token, amount: rec.amount, corridor: rec.dir, payer: ev.payer, status, ...extra });
    } catch { /* best effort */ }
  }

  async function handleEvent(ev) {
    const t = tokenByAddress(ev.token);
    const sym = t?.symbol ?? "token";
    const amountText = t ? formatUnits(ev.amount, t.decimals) : String(ev.amount);
    const what = ev.kind === "tag" ? `payment to @${ev.tag} through LokalTags` : `payment into pot #${ev.potId} through LokalPots`;
    const where = { what, event: ev.kind === "tag" ? "TagPaid" : "PotPaid", token: sym, amount: amountText, from: ev.payer, tx: ev.tx, logIndex: ev.logIndex, block: String(ev.block), ...(ev.kind === "pot" ? { pot: String(ev.potId) } : { ntag: ev.tag }) };
    const done = payments()[ev.key];
    if (done) {
      say(`Contract ${what} (tx ${ev.tx}) was already handled${done.status === "refused" ? ` (refused: ${done.reason})` : ""}. Skipping.`);
      return;
    }
    // A deposit with a refund record (sending, refunded, failed, too small) is never paid.
    const refund = ev.inner ? io.loadRefunds?.()?.[ev.inner.key] : null;
    if (refund) {
      say(`Contract ${what} (tx ${ev.tx}) has a refund record (${refund.status}). It is never paid. Skipping.`);
      return;
    }
    if (!blockTime.has(ev.block)) blockTime.set(ev.block, Number((await pub.getBlock({ blockNumber: ev.block })).timestamp) * 1000);
    // deposit = the money's arrival (the inner Transfer, which refunds and the status server key on); eventLogIndex = the event
    const deposit = { payer: ev.payer, tx: ev.tx, logIndex: ev.inner?.logIndex ?? ev.logIndex, eventLogIndex: ev.logIndex, block: String(ev.block), at: new Date(blockTime.get(ev.block)).toISOString() };
    const base = {
      kind: ev.kind, event: where.event, token: sym, tokenAddress: ev.token, amount: amountText, units: ev.amount.toString(), deposit,
      ...(ev.inner ? { depositKey: ev.inner.key } : {}), ...(ev.kind === "pot" ? { potId: String(ev.potId) } : {}),
    };

    if (!ev.inner) {
      return refuse(ev, "the money did not reach this agent's wallet in that transaction (the contract's payout wallet was another address)", base, where, { quiet: true });
    }
    // Who and in what, as it was at the payment's block: the tag (pots: the host's tag) and their receive token.
    const tag = ev.kind === "tag" ? ev.tag : (await io.readTagOfAt(pub, ev.recipient, ev.block)).value || null;
    const rt = await io.readReceiveToken(pub, ev.recipient, ev.block);
    const receiveToken = rt.value && lc(rt.value) !== ZERO ? getAddress(rt.value) : null;
    const chosen = currencyOfRef(ev.ref); // the payer's choice for this payment wins over the recipient's default
    const route = routeFor(ev.token, receiveToken, ev.kind, chosen);
    const name = ev.kind === "tag" ? `@${tag}` : `pot #${ev.potId}${tag ? ` (@${tag})` : ""}`;
    const rec = (from) => ({
      ...base, tag, name, from, owner: from, receiveToken, ...(chosen ? { chosen } : {}), ...(rt.latest ? { receiveTokenReadAt: "latest" } : {}),
      dir: route ? (route.mode === "swap" ? route.corridor : `forward-${sym.toLowerCase()}`) : null, ...(route ? { receive: route.receive } : {}),
    });
    if (!route) {
      const wants = chosen ? (chosen === "usdt" ? "USDT" : chosen.toUpperCase()) : receiveToken ? tokenByAddress(receiveToken)?.symbol ?? receiveToken : "the default";
      return refuse(ev, `token not accepted: ${sym} can't be paid out as ${wants} (no corridor)`, rec(ev.recipient), where);
    }
    let args;
    let usdUnits = null;
    if (route.mode === "swap") {
      const sell = PAYOUT_CORRIDORS[route.corridor].sell;
      const { amount, units } = payAmount(ev.amount, TOKENS[sell].decimals);
      if (units < parseUnits(CONTRACT_MIN[sell], TOKENS[sell].decimals)) return refuse(ev, `below the minimum of ${CONTRACT_MIN[sell]} ${sym} for a payout`, rec(ev.recipient), where);
      args = { to: name, amount, corridor: route.corridor, recipientAddress: ev.recipient, payer: ev.payer, ntag: tag ?? undefined };
    } else {
      usdUnits = route.receive === "usdt" ? ev.amount : BigInt(await io.readUsdValue(pub, ev.token, ev.amount));
      args = { to: name, token: ev.token, units: ev.amount, recipientAddress: ev.recipient, payer: ev.payer, usdUnits, ntag: tag ?? undefined, source: ev.kind };
    }
    say(`Contract ${what}: ${amountText} ${sym} from ${short(ev.payer)} (tx ${ev.tx}) -> pay ${name} (${short(ev.recipient)}) ${route.mode === "swap" ? `via ${route.corridor}` : `as is (${sym})`}.`);

    if (!execute) {
      try {
        if (route.mode === "swap") {
          await io.ntagUsdFloor(route.corridor, ev.amount);
          await io.pay({ ...args, execute: false });
        } else await io.forward({ ...args, execute: false });
        dry.set(ev.key, rec(ev.recipient));
      } catch (e) {
        say(e.permanent
          ? `DRY RUN: would refuse: ${e.message} With --execute this is logged and recorded as refused, and autopilot carries on.`
          : `DRY RUN: pre-flight fails right now: ${e.message}. With --execute the payment would NOT be recorded and autopilot would stop here.`);
      }
      return;
    }

    // Pre-flight (sends nothing): recipient rules, the agent's own caps and a live preview. The contract already
    // enforced its limits; these are the agent's, and they may be stricter.
    let from = ev.recipient;
    try {
      if (route.mode === "swap") {
        await io.ntagUsdFloor(route.corridor, ev.amount);
        const pf = await io.preflight({ ...args, agent });
        if (pf?.recipient) from = pf.recipient;
      } else {
        from = io.forwardPreflight({ ...args, agent }).recipient ?? from;
      }
    } catch (e) {
      if (e.permanent) return refuse(ev, e.message, rec(ev.recipient), where);
      pin();
      io.log({ type: "preflight_failed", source: "contract", ...where, error: e.message });
      throw new StopError(
        `Pre-flight failed for the contract ${what}: ${e.message}. NOTHING was recorded or paid; the money stays in the agent wallet. ` +
        `Fix the cause, then run "watch --execute" again: it rescans from block ${rescanFrom()} and handles this payment again. Stopping.`,
      );
    }

    // Record BEFORE paying: one payout per event, even if we crash mid-flow.
    const fresh = io.loadContractPayments();
    if (fresh[ev.key]) { say(`Contract ${what} (tx ${ev.tx}) was already handled. Skipping.`); return; }
    fresh[ev.key] = rec(from);
    io.saveContractPayments(fresh);
    reportEvent(ev, fresh[ev.key], "received", { at: deposit.at });
    let res;
    try {
      res = route.mode === "swap"
        ? await io.pay({ ...args, recipientAddress: from, execute: true, yes: true })
        : await io.forward({ ...args, recipientAddress: from, execute: true, yes: true });
    } catch (e) {
      // A cap the firm quote broke before anything was sent: a refusal, not a stop.
      if (e.permanent && !e.hashes) return refuse(ev, e.message, {}, where);
      reportEvent(ev, fresh[ev.key], "failed", { at: new Date().toISOString() });
      try {
        const after = io.loadContractPayments();
        after[ev.key].error = e.message;
        if (e.hashes) after[ev.key].hashes = e.hashes;
        io.saveContractPayments(after);
      } catch (se) {
        say(`Could not save the error for ${ev.key}: ${se.message}. Do NOT pay it again before checking the agent's transactions on Celoscan.`);
      }
      throw new StopError(
        `Payout for the contract ${what} failed: ${e.message}. The payment is recorded in contract-payments.json (${ev.key}); it is not retried ` +
        "automatically. Check the agent's transactions on Celoscan, then settle it by hand. Stopping.",
      );
    }
    try {
      const after = io.loadContractPayments();
      Object.assign(after[ev.key], { paidAt: new Date().toISOString(), hashes: res.hashes, receiptUrl: res.receiptUrl, receiptNo: res.receiptNo, paid: res.paid });
      io.saveContractPayments(after);
    } catch (e) {
      throw new StopError(
        `The contract ${what} was PAID (payout ${res?.hashes?.payout ?? "?"}, receipt ${res?.receiptNo ?? "?"}), but saving that failed: ${e.message}. ` +
        "Do NOT pay it again: the payout is in receipts.jsonl and on Celoscan. Fix the file, then restart autopilot. Stopping.",
      );
    }
    reportEvent(ev, fresh[ev.key], "paid", { res, at: new Date().toISOString() });
    say(`Paid ${name} for the contract payment. Receipt ${res.receiptNo}.`);
    if (res.untagged?.length) throw new StopError(`Payout to ${name} sent, but ${res.untagged.join(", ")} lack the attribution tag. Stopping to investigate.`);
  }

  return { scan, merge, handle, memoOwner };
}
