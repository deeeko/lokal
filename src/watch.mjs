// Autopilot. Polls Celo (Forno) for ERC-20 Transfer events TO the agent on USDT and cNGN, matches each deposit to an
// open payment request (sell token + exact amount + time window), and pays that request's contact.
//   - DRY RUN unless --execute: prints what it would do; writes nothing (no cursor, no request changes).
//   - With --execute: first runs the pre-flight checks that send nothing (contact, caps incl. daily cap, preview). If they
//     fail it stops WITHOUT recording anything and without moving the cursor past the deposit, so the deposit matches
//     again on the next run. Otherwise it records the payer + deposit tx on the request, then runs the normal pay flow
//     (yes=true), so a crash can never pay the same request twice. Stops on any payout error (see `agent.mjs retry`).
//   - Unmatched deposits are logged and never paid. Transfers the agent itself caused (its own swaps) are ignored.
//   - Block cursor persists in watch-state.json (git-ignored). Ctrl+C stops cleanly between steps.
//   - A deposit counts as handled only once its handling finished, writes included. Any error before that (a failed
//     lookup, a failed save) leaves it to be handled again on the next poll; it is never silently skipped.
//   - "Get paid" registrations (src/registrations.mjs) are discovered from Blockscout every poll. A deposit that matches
//     the ACTIVE registration for its token + exact amount (at the deposit's block time) pays the registration's sender,
//     after the registration is re-read from the chain over RPC. Self-payment, blocked recipients and registrations that
//     do not check out are refused (logged, recorded in registrations-state.json so a rescan never pays them, not paid,
//     autopilot continues); the global daily cap and prices stop it like owner requests.
//     The deposit is recorded in registrations-state.json before paying: one payout per registration.
//   - A deposit that matches BOTH an owner request and a registration is ambiguous: logged, never paid.
//   - Deposits are only scanned up to the block Blockscout has indexed, so a fresh registration is never missed.
//   - nTag payments (src/ntags.mjs): a deposit whose transfer calldata carries an "NTP:<tag>" memo pays the tag's owner
//     (resolved strictly before the deposit, claim re-read over RPC). The memo wins: such a deposit is NEVER matched
//     against requests or registrations, and neither is anything that merely looks like an nTag attempt (the "NTP:"
//     bytes anywhere in the input, or a transfer with extra bytes): those are refused unless the memo decodes cleanly on
//     a direct transfer. Refusals (unknown tags, broken recipient rules, per-payment / per-wallet caps, also when the
//     firm quote breaks them) are logged and recorded in ntag-payments.json as handled; only
//     `retry --ntag <key> --force-refused` can pay one later. The global daily cap and prices stop autopilot.
//     The nTag list is loaded in full once, then refreshed incrementally each poll; while it is not loaded up to a
//     deposit's block, that nTag deposit waits (cursor pinned before it) and requests/registrations before it go on.
//   - Status server (src/status-report.mjs): with --execute, every recorded, refused and paid deposit is also queued for
//     the site's /api/status (a payout error as "failed"). On start it also queues whatever its saved records of the
//     last 48 h say that the server hasn't confirmed (all kinds, incl. direct owner payouts from receipts.jsonl). Queuing
//     is a tiny local write; sending happens in the background. A reporting failure is logged once and never stops,
//     delays or changes a payout.
//   - One agent at a time (src/lock.mjs): with --execute it takes agent.lock first and refuses to start while another
//     agent or --execute command holds it. Released on exit, Ctrl+C, SIGTERM and crashes.
//   - Refunds (src/refund.mjs): a deposit with a refund record is never paid. With --auto-refund, refused LokalPay tag and
//     "Get paid" deposits are refunded right after they are refused (at most 3 per payer per 24 h); a failed refund is
//     recorded and alerted, and never stops autopilot.
//   - Alerts (src/alerts.mjs, optional): autopilot stopped, payout failed, refund failed, daily cap reached, CELO low
//     (checked at most once a minute, re-warned at most hourly), status server unreachable 10+ minutes, deposit refused,
//     payout paid. They wait in an outbox and never block a payout. With a status secret, a signed heartbeat goes to the
//     status server about once a minute (fire and forget).
//   - Payments through the contracts (src/contract-watch.mjs): LokalTags TagPaid and LokalPots PotPaid events in the same
//     block range pay the recipient they name, through the same safety path, exactly once per event. The Transfer into
//     the agent inside such a transaction is that payment, so it never reaches the deposit matching above. From the
//     cutover block (LEGACY_CUTOVER_BLOCK) legacy NT1: claims are ignored and an NTP: memo to a tag also held on
//     LokalTags pays the contract's owner.
import fs from "node:fs";
import { createPublicClient, formatUnits, getAddress, http, parseAbiItem, parseUnits } from "viem";
import { verifyTx } from "@celo/attribution-tags";
import { AGENT_ADDRESS, ATTRIBUTION_CODE, CHAIN, CORRIDORS, LOW_CELO_WARN, MIN_CELO_RESERVE, TOKENS, WATCH_STATE_FILE } from "./config.mjs";
import { corridorFor, currencyOf } from "./currencies.mjs";
import { loadAccount, makeClients } from "./chain.mjs";
import { getCorridor, refusal } from "./guards.mjs";
import { BLOCKED_RECIPIENTS, loadContacts, log, pay, preflight, readReceipts } from "./pay.mjs";
import { acquireLock, noLock, releaseLock } from "./lock.mjs";
import { GAS_CHECK_MS, gasAlert, makeAlerter } from "./alerts.mjs";
import { loadRefunds, refundDeposit, saveRefunds } from "./refund.mjs";
import { preview } from "./textile.mjs";
import { formatAmount, loadRequests, matchDeposit, receiptNoLink, requestStatus, saveRequests } from "./requests.mjs";
import {
  discoverRegistrations, indexedHeight, loadRegState, MAX_REG_HOURS, matchRegistration, registrationWindows, saveRegState,
  verifyRegistrationOnchain,
} from "./registrations.mjs";
import {
  decodeNtagPayment, loadNtagOpsCache, loadNtagPayments, looksLikeNtagAttempt, ownerOf, refreshNtagOpsCache, resolveNtagsBefore,
  saveNtagPayments, verifyNtagOpOnchain,
} from "./ntags.mjs";
import { agentVersion, depositEvent, makeStatusReporter, refundEvent } from "./status-report.mjs";
import { legacyNtagOps } from "./ntags.mjs";
import { CONTRACT_IO, contractDepositRecords, makeContractWatch } from "./contract-watch.mjs";

export const MAX_BLOCK_RANGE = 5000n; // Forno eth_getLogs limit
export const HEARTBEAT_MS = 60_000;
/** The status server counts as unreachable (warning alert) after this long without a good answer. */
export const STATUS_DOWN_ALERT_MS = 10 * 60_000;
const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const SYMBOL = { [TOKENS.USDT.address.toLowerCase()]: "USDT", [TOKENS.CNGN.address.toLowerCase()]: "cNGN" };
const MAX_BACKOFF_MS = 5 * 60_000;

// ---------- nTag payments (pure, unit-tested) ----------

/**
 * Corridor an nTag payment takes, by the token deposited and the currency its memo asks for: USDT -> usdt-<currency>
 * ("NTP:ada:idrx" -> usdt-idrx; no code -> usdt-cngn, naira), cNGN -> cngn-usdt (no code only). null = not accepted.
 */
export function ntagCorridor(token, currency = null) {
  const t = String(token ?? "").toLowerCase();
  if (t === TOKENS.USDT.address.toLowerCase()) {
    const id = corridorFor(currency ?? "cngn");
    return currency == null || (currencyOf(currency) && CORRIDORS[id]) ? id : null;
  }
  if (t === TOKENS.CNGN.address.toLowerCase()) return currency == null ? "cngn-usdt" : null;
  return null;
}

/**
 * Smallest nTag deposit autopilot considers, in the deposited token. USDT: Textile's ~$1 swap minimum. cNGN: a dust
 * floor well under $1 at any plausible rate; a cNGN deposit must also preview at >= NTAG_MIN_USD (checked live, see
 * ntagUsdFloor). Smaller deposits are refused (logged, not paid), so dust does not stop autopilot with a price error.
 */
export const NTAG_MIN = {
  ...Object.fromEntries(Object.values(CORRIDORS).filter((c) => c.sell === "USDT").map((c) => [c.id, "1"])),
  "cngn-usdt": "1000",
};
export const NTAG_MIN_USD = "1";

/**
 * cNGN deposits: a permanent refusal when the live preview says the naira is worth less than NTAG_MIN_USD (the site and
 * the ntag CLI never let a payer send less). No price right now is left to preflight, which stops autopilot as usual.
 */
export async function ntagUsdFloor(corridor, units, previewImpl = preview) {
  if (corridor !== "cngn-usdt") return;
  const pv = await previewImpl(TOKENS.CNGN.address, TOKENS.USDT.address, BigInt(units).toString());
  if (pv?.status === "preview" && BigInt(pv.buyAmount) < parseUnits(NTAG_MIN_USD, 6)) {
    throw refusal(`${formatUnits(BigInt(units), 6)} cNGN is worth about ${formatUnits(BigInt(pv.buyAmount), 6)} USD, below the ${NTAG_MIN_USD} USD minimum for LokalPay tag payments. Not paid.`);
  }
}

/**
 * Deposit base units (6 dp) -> the amount string pay() accepts, rounded DOWN to `places` decimals, plus the dust kept
 * back. pay() takes up to 6 decimals, so by default the whole deposit is paid. Never more than was received.
 */
export function ntagPayAmount(units, places = 6) {
  const v = BigInt(units);
  const step = 10n ** BigInt(6 - Math.min(6, Math.max(0, places)));
  const paid = v - (v % step);
  return { amount: formatUnits(paid, 6), units: paid, dust: v - paid };
}

const word = (h, i) => h.slice(8 + i * 64, 8 + (i + 1) * 64);

export const NTAG_BAD_MEMO = "the transfer looks like a LokalPay tag payment, but its memo is not a valid one on a plain transfer to the agent";

/**
 * What autopilot does with a deposit that carries (or looks like it tries to carry) an nTag memo. Pure: no RPC, no files.
 *   dep = { key, tag (null when the memo does not decode), currency (the memo's currency code, null = naira), token,
 *           value (bigint), payer, tx: { from, to, input }, block, position }
 *   ops = every nTag op known up to the deposit's block, or null when that list is not loaded (then: "hold");
 *   payments = ntag-payments.json (plus dry-run records); agent = agent address.
 * Returns { action: "handled", record } | { action: "hold" } | { action: "refuse", reason } |
 *         { action: "pay", tag, entry, op, corridor, amount, units, dust }.
 * The memo's transfer must be the deposit itself (sent to the token, to the agent, same amount, same sender), and the
 * owner is resolved from the ops strictly before the deposit's (block, position).
 */
export function classifyNtagDeposit(dep, ops, payments, agent, contractEntry = null) {
  if (payments?.[dep.key]) return { action: "handled", record: payments[dep.key] };
  if (!dep.tag) return { action: "refuse", reason: NTAG_BAD_MEMO };
  const corridor = ntagCorridor(dep.token, dep.currency ?? null);
  if (!corridor && dep.currency != null && String(dep.token).toLowerCase() === TOKENS.CNGN.address.toLowerCase()) {
    return { action: "refuse", reason: "the currency in the LokalPay tag memo only applies to USD₮ payments (cNGN pays out in dollars)" };
  }
  if (!corridor) return { action: "refuse", reason: "token not accepted for LokalPay tag payments" };
  const h = String(dep.tx?.input ?? "").toLowerCase().replace(/^0x/, "");
  let memoValue = null;
  try { memoValue = BigInt("0x" + word(h, 1)); } catch { /* malformed: refused below */ }
  if (
    String(dep.tx?.to ?? "").toLowerCase() !== String(dep.token).toLowerCase()
    || word(h, 0).slice(24) !== String(agent).toLowerCase().replace(/^0x/, "")
    || memoValue !== BigInt(dep.value)
    || String(dep.tx?.from ?? "").toLowerCase() !== String(dep.payer ?? "").toLowerCase()
  ) return { action: "refuse", reason: "the LokalPay tag memo does not match this transfer" };
  const { amount, units, dust } = ntagPayAmount(dep.value);
  if (units < parseUnits(NTAG_MIN[corridor], 6)) return { action: "refuse", reason: `below the LokalPay tag minimum of ${NTAG_MIN[corridor]}` };
  // From the cutover on, a tag that is also held on LokalTags pays its contract owner (src/contract-watch.mjs memoOwner).
  if (contractEntry) return { action: "pay", tag: dep.tag, currency: currencyOf(CORRIDORS[corridor]?.currency)?.code ?? null, entry: contractEntry, op: null, corridor, amount, units, dust };
  if (ops == null) return { action: "hold" };
  const entry = ownerOf(resolveNtagsBefore(ops, dep.block, dep.position), dep.tag);
  if (!entry) return { action: "refuse", reason: "unknown LokalPay tag" };
  const op = ops.find((o) => o.hash === entry.hash);
  if (!op) return { action: "refuse", reason: "LokalPay tag claim not found" };
  return { action: "pay", tag: dep.tag, currency: currencyOf(CORRIDORS[corridor]?.currency)?.code ?? null, entry, op, corridor, amount, units, dust };
}

/** Inclusive [from, to] block ranges of at most `size` blocks each. */
export function chunkRanges(from, to, size = MAX_BLOCK_RANGE) {
  const out = [];
  for (let a = BigInt(from); a <= BigInt(to); a += BigInt(size)) {
    const b = a + BigInt(size) - 1n;
    out.push([a, b < BigInt(to) ? b : BigInt(to)]);
  }
  return out;
}

/**
 * First block to scan when there is no saved cursor: far enough back to cover the oldest open request
 * (Celo block time ~1 s, plus a 2-minute margin), else the latest block.
 */
export function initialFromBlock(latest, requests, now = Date.now(), blockMs = 1000) {
  const open = requests.filter((r) => requestStatus(r, now) === "open");
  if (!open.length) return BigInt(latest);
  const oldest = Math.min(...open.map((r) => r.created));
  const back = BigInt(Math.ceil(Math.max(0, now - oldest) / blockMs) + 120);
  const from = BigInt(latest) - back;
  return from > 0n ? from : 0n;
}

/** The first sentence of a message (at most 240 characters). */
export function firstSentence(msg) {
  const s = String(msg ?? "").split(/(?<=[.!?])\s/)[0].trim();
  return s.length > 240 ? s.slice(0, 239) + "…" : s;
}

/** The command that starts autopilot again with the same options. */
export const resumeCommand = ({ autoRefund = false } = {}) => `node src/agent.mjs watch --execute${autoRefund ? " --auto-refund" : ""}`;

/** The one line autopilot prints last when it stops on an error: what happened and how to restart. */
export function stopLine(msg, opts = {}) {
  return `AUTOPILOT STOPPED: ${firstSentence(msg)} Nothing more is paid until you restart it. Fix the cause (details above), then run: ${resumeCommand(opts)}`;
}

/** Exponential backoff for RPC errors: interval, 2x, 4x ... capped at 5 minutes. */
export const backoffMs = (intervalMs, failures) => Math.min(intervalMs * 2 ** Math.max(0, failures), MAX_BACKOFF_MS);

const stamp = () => new Date().toISOString().slice(11, 19);
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function loadState() {
  try { return JSON.parse(fs.readFileSync(WATCH_STATE_FILE, "utf8")); } catch { return {}; }
}
function saveState(state) {
  const tmp = `${WATCH_STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  fs.renameSync(tmp, WATCH_STATE_FILE);
}

/** Ends autopilot: something needs the owner. */
class StopError extends Error {}
/** An nTag deposit that can't be decided yet (the nTag list is not loaded up to its block): it waits for the next poll. */
class HoldError extends Error {}

/** Everything autopilot touches outside its own memory. Tests replace parts of it (fake chain, files, payouts). */
const DEFAULT_IO = {
  makePub: () => createPublicClient({ chain: CHAIN, transport: http(process.env.CELO_RPC_URL || undefined, { timeout: 30_000, retryCount: 2 }) }),
  loadAccount, loadState, saveState, loadRequests, saveRequests, loadRegState, saveRegState, loadNtagPayments, saveNtagPayments,
  log, pay, preflight, discoverRegistrations, indexedHeight, loadNtagOpsCache, refreshNtagOpsCache, verifyRegistrationOnchain,
  verifyNtagOpOnchain, ntagUsdFloor, print: (s) => console.log(s), sleep: null, now: () => Date.now(),
  readReceipts, makeStatus: (say) => makeStatusReporter({ say }),
  loadRefunds, saveRefunds,
  // the agent lock: off under the test runner (tests pass their own), so a test never touches the real agent.lock
  acquireLock: (opts) => (process.env.NODE_TEST_CONTEXT ? noLock() : acquireLock(opts)),
  makeAlerter: (say) => makeAlerter({ say }),
  /** What an auto-refund needs beyond autopilot's own reads: the attribution-tagged wallet, prices, own_wallets. */
  refundChain: ({ account }) => ({ wallet: makeClients(account).wallet, verifyTx, preview, own: loadContacts().own }),
  version: () => agentVersion(),
  ...CONTRACT_IO, // payments through LokalTags / LokalPots (src/contract-watch.mjs)
};

/**
 * Runs autopilot until Ctrl+C or a StopError. `polls` (tests) stops after that many polls; `io` replaces any of
 * DEFAULT_IO (tests: a fake chain, files in a temp dir, a fake pay()). With `execute` it holds the agent lock for the
 * whole run (clearStaleLock: replace a lock whose process is gone). `autoRefund` (execute only): refund refused tag and
 * "Get paid" deposits right away.
 */
export async function watch(opts = {}) {
  const io = { ...DEFAULT_IO, ...(opts.io ?? {}) };
  const lock = opts.execute ? io.acquireLock({ command: "watch --execute", clearStale: Boolean(opts.clearStaleLock) }) : null;
  try {
    return await runWatch({ ...opts, io });
  } finally {
    releaseLock(lock);
  }
}

async function runWatch({ execute = false, interval = 15, polls = Infinity, autoRefund = false, io }) {
  const say = (msg) => io.print(`[${stamp()}] ${msg}`);
  const autoRefundOn = Boolean(execute && autoRefund);
  if (autoRefund && !execute) say("--auto-refund only works with --execute; this dry run refunds nothing.");
  const intervalMs = Math.max(5, Number(interval) || 15) * 1000;
  const account = io.loadAccount({ required: execute });
  const agent = account?.address ?? AGENT_ADDRESS;
  // Forno. eth_getLogs over 5000 blocks can take >10 s (viem's default timeout), so allow 30 s.
  const pub = io.makePub();
  const state = execute ? io.loadState() : {};
  const dryMatched = new Map(); // dry run only: request id -> simulated deposit, in memory
  const dryRegMatched = new Map(); // dry run only: registration hash -> simulated deposit, in memory
  const dryNtag = new Map(); // dry run only: LokalPay tag deposit key -> simulated record, in memory
  let regs = []; // "Get paid" registrations, refreshed every poll
  // nTag ops: loaded in full once, then refreshed incrementally. ntagOpsHeight = the indexed height the cache is
  // complete up to; nTag deposits above it wait.
  let ntagCache = null;
  let ntagOpsHeight = -1n;
  let ntagOpsError = null;
  let ntagRetryAt = 0;
  let ntagFailures = 0;
  const seen = new Set(); // deposits fully handled in this run (lower-case tx:logIndex)
  const heldNoted = new Set();
  const blockTime = new Map();
  const txInfo = new Map(); // tx hash -> { from, to, input, index }

  // Ctrl+C: finish the current step, then exit. A second Ctrl+C exits immediately.
  let stopping = false;
  let wake = null;
  const onSigint = () => {
    if (stopping) process.exit(130);
    stopping = true;
    say("Stopping after the current step… (Ctrl+C again to force)");
    wake?.();
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigint); // a service manager stopping autopilot: the same clean stop
  const sleep = io.sleep ?? ((ms) => new Promise((res) => { const t = setTimeout(res, ms); wake = () => { clearTimeout(t); res(); }; }));

  const requests = () => {
    const list = io.loadRequests();
    for (const r of list) if (dryMatched.has(r.id)) r.deposit = dryMatched.get(r.id);
    return list;
  };

  const regState = () => {
    const s = io.loadRegState();
    for (const [h, d] of dryRegMatched) s[h] = { ...(s[h] ?? {}), deposit: d };
    return s;
  };

  const ntagPayments = () => {
    const s = io.loadNtagPayments();
    for (const [k, d] of dryNtag) s[k] = { ...(s[k] ?? {}), ...d };
    return s;
  };

  /** Pins the rescan point before the current deposit (the cursor is the last fully processed block). */
  const pin = () => io.saveState({ cursor: String(cursor), updatedAt: new Date().toISOString() });

  /** Saves a failed payout's error. A failing save is reported, but never hides the StopError that follows it. */
  function saveFailure(what, fn) {
    try { fn(); } catch (se) {
      say(`Could not save the error for ${what}: ${se.message}. Do NOT retry it before checking the agent's transactions on Celoscan.`);
    }
  }
  /** Saves a finished payout. If that save fails, autopilot stops and says it WAS paid, so nobody pays it again. */
  function recordPaid(what, res, fn) {
    try { fn(); } catch (e) {
      throw new StopError(
        `${what} was PAID (payout ${res?.hashes?.payout ?? "?"}, receipt ${res?.receiptNo ?? "?"}), but saving that failed: ${e.message}. ` +
        "Do NOT retry it: the payout is in receipts.jsonl and on Celoscan. Fix the file, then restart autopilot. Stopping.",
      );
    }
  }

  say(`Watching ${agent} for USDT and cNGN deposits and LokalTags / LokalPots payments every ${intervalMs / 1000}s. ${execute ? "EXECUTE MODE: matched requests are paid for real." : "DRY RUN: nothing is paid or saved. Add --execute to pay."}`);
  const open = requests().filter((r) => requestStatus(r) === "open");
  say(`${open.length} open request(s)${open.length ? ": " + open.map((r) => `${r.id} ${r.amount} ${getCorridor(r.dir).sellToken.symbol} for ${r.name}`).join(", ") : ". Create one with: node src/agent.mjs request --to NAME --amount N"}`);

  // Status server: execute mode only (a dry run records nothing, so it reports nothing). Never throws into autopilot.
  let status = null;
  if (execute) {
    try {
      status = io.makeStatus?.(say) ?? null;
      if (status?.enabled) {
        say("Status server: reporting each deposit's status to the site in the background.");
        status.syncRecords({
          requests: io.loadRequests(), registrations: io.loadRegState(), ntagPayments: { ...io.loadNtagPayments(), ...contractDepositRecords(io.loadContractPayments()) },
          receipts: io.readReceipts(), refunds: io.loadRefunds(),
        }, { agent });
        status.flush().catch(() => {});
      }
    } catch { status = null; }
  }
  /** Queues a status event for the site. Reporting can never stop, delay or change a payout. */
  const report = (fields) => {
    if (!status?.enabled) return;
    try { status.report(depositEvent(fields)); } catch { /* reporting is best effort */ }
  };

  // Alerts: execute mode only. Queuing is a tiny local write; sending happens in the background. Never throws.
  let alerter = null;
  if (execute) {
    try {
      alerter = io.makeAlerter?.(say) ?? null;
      if (alerter?.enabled) say(`Alerts: on (${alerter.channels.join(" and ")}).`);
    } catch { alerter = null; }
  }
  const alert = (kind, text) => { try { alerter?.alert(kind, text); } catch { /* alerts are best effort */ } };
  /** A pre-flight that failed on the global daily cap: worth a warning on the operator's phone. */
  const noteCap = (e) => { if (/MAX_DAILY_USD/.test(String(e?.message))) alert("daily_cap", `Daily cap reached: ${firstSentence(e.message)} Autopilot stops until the rolling 24 h total has room again.`); };
  if (autoRefundOn) say("Auto-refund: ON. Refused LokalPay tag and \"Get paid\" deposits are refunded to their sender (at most 3 per payer per 24 h).");

  /** What refundDeposit needs, built from autopilot's own io (so tests see one consistent world). */
  let refundChain = null;
  const refundDeps = () => {
    refundChain ??= io.refundChain({ account, pub });
    return {
      pub, agent, own: refundChain.own ?? [], contracts: BLOCKED_RECIPIENTS, wallet: refundChain.wallet, verifyTx: refundChain.verifyTx,
      preview: refundChain.preview, attributionCode: ATTRIBUTION_CODE, now: io.now, say,
      loadRecords: () => ({
        requests: io.loadRequests(), registrations: io.loadRegState(), receipts: io.readReceipts(), refunds: io.loadRefunds(),
        // contract payments count as deposits too (keyed by their inner Transfer): a refused one refunds to its payer
        ntagPayments: { ...io.loadNtagPayments(), ...contractDepositRecords(io.loadContractPayments()) },
      }),
      loadRefunds: io.loadRefunds, saveRefunds: io.saveRefunds, log: io.log, alert,
      report: (rec) => { if (status?.enabled) { const ev = refundEvent(rec); if (ev) status.report(ev); } },
    };
  };
  /** --auto-refund: refunds a deposit autopilot just refused. Never throws: a failed refund is recorded and alerted. */
  async function autoRefundDeposit(key) {
    if (!autoRefundOn) return;
    try {
      await refundDeposit(key, refundDeps(), { execute: true, yes: true, auto: true });
    } catch (e) {
      say(e.refundFailed ? e.message : `Auto-refund of ${key} not done: ${e.message}`);
    }
  }

  let cursor = null; // last fully processed block
  // Payments through the contracts (TagPaid / PotPaid): handled in chain order with the deposits, see contract-watch.mjs.
  const contracts = makeContractWatch({
    io, pub, agent, execute, say, report, pin: () => pin(), StopError, rescanFrom: () => (cursor == null ? "?" : cursor + 1n),
    onRefused: async (depositKey, reason, where) => {
      alert("deposit_refused", `Refused ${where.amount} ${where.token} from ${where.from} (${where.what}): ${firstSentence(reason)} ` +
        `It stays in the agent wallet${autoRefundOn ? "; auto-refund is on" : `; refund it to the payer with: node src/agent.mjs refund --deposit ${depositKey}`}.`);
      await autoRefundDeposit(depositKey);
    },
  });
  let failures = 0;
  let caughtUp = false;

  /** One deposit. It counts as seen only after it was handled completely: an error leaves it for the next poll. */
  async function handle(l) {
    const key = `${l.transactionHash}:${l.logIndex}`.toLowerCase();
    if (seen.has(key)) return;
    await handleDeposit(l, key);
    seen.add(key);
  }

  async function handleDeposit(l, key) {
    const token = l.address;
    const sym = SYMBOL[token.toLowerCase()] ?? "token";
    const value = l.args.value;
    const payer = l.args.from;
    if (value === 0n) return;

    // Ignore transfers the agent caused itself (e.g. the output of its own swap).
    if (!txInfo.has(l.transactionHash)) {
      const t = await pub.getTransaction({ hash: l.transactionHash });
      txInfo.set(l.transactionHash, { from: t.from, to: t.to, input: t.input, index: t.transactionIndex });
    }
    const tx = txInfo.get(l.transactionHash);
    if (tx.from.toLowerCase() === agent.toLowerCase()) return;

    // A deposit with a refund record (sending, refunded, failed, too small) is never paid.
    const refund = io.loadRefunds()[key];
    if (refund) {
      say(`Deposit ${l.transactionHash} has a refund record (${refund.status}). It is never paid. Skipping.`);
      return;
    }

    if (!blockTime.has(l.blockNumber)) blockTime.set(l.blockNumber, Number((await pub.getBlock({ blockNumber: l.blockNumber })).timestamp) * 1000);
    const timeMs = blockTime.get(l.blockNumber);
    const amount = formatAmount(value);
    const list = requests();
    const rstate = regState();
    const handled = (d) => String(d?.tx ?? "").toLowerCase() === l.transactionHash.toLowerCase() && d?.logIndex === l.logIndex;
    if (list.some((r) => handled(r.deposit)) || Object.values(rstate).some((r) => handled(r.deposit))) {
      say(`Deposit ${l.transactionHash} was already handled. Skipping.`);
      return;
    }
    const refusedReg = Object.values(rstate).find((r) => r?.refused?.[key]);
    if (refusedReg) {
      say(`Deposit ${l.transactionHash} was refused earlier for registration ${refusedReg.hash} (${refusedReg.refused[key].reason}). Skipping.`);
      return;
    }
    // A transfer memo naming an nTag wins: such a deposit is never matched against requests or registrations. Neither is
    // anything that looks like an nTag attempt whose memo does not decode (refused in handleNtag).
    const memo = decodeNtagPayment(tx.input);
    const tag = memo?.tag ?? null;
    if (tag || looksLikeNtagAttempt(tx.input)) return handleNtag(l, key, tag, { sym, amount, payer, timeMs, tx, currency: memo?.currency ?? null });
    const req = matchDeposit({ token, value, timeMs }, list);
    const rm = matchRegistration({ token, value, timeMs }, regs, rstate);
    if (req && rm) {
      say(`Ambiguous deposit: ${amount} ${sym} from ${short(payer)} (tx ${l.transactionHash}) matches request ${req.id} AND registration ${rm.reg.hash}. NOT paid; settle it by hand.`);
      if (execute) io.log({ type: "ambiguous_deposit", requestId: req.id, registrationId: rm.reg.hash, token: sym, amount, from: payer, tx: l.transactionHash, logIndex: l.logIndex, block: String(l.blockNumber) });
      return;
    }
    if (rm?.used) {
      say(`Deposit ${amount} ${sym} from ${short(payer)} (tx ${l.transactionHash}) matches registration ${rm.reg.hash}, which was already used (one payout per registration). NOT paid.`);
      if (execute) io.log({ type: "unmatched_deposit", reason: "registration already used", registrationId: rm.reg.hash, token: sym, amount, from: payer, tx: l.transactionHash, logIndex: l.logIndex, block: String(l.blockNumber) });
      return;
    }
    if (rm) return handleRegistration(l, key, rm.reg, { sym, amount, payer, timeMs });
    if (!req) {
      say(`Unmatched deposit: ${amount} ${sym} from ${short(payer)} (tx ${l.transactionHash}). No open request has this exact amount and token. NOT paid.`);
      if (execute) io.log({ type: "unmatched_deposit", token: sym, amount, from: payer, tx: l.transactionHash, logIndex: l.logIndex, block: String(l.blockNumber) });
      return;
    }
    const deposit = { payer, tx: l.transactionHash, logIndex: l.logIndex, block: String(l.blockNumber), at: new Date(timeMs).toISOString() };
    say(`Matched ${req.id}: ${amount} ${sym} from ${short(payer)} (tx ${l.transactionHash}) -> pay ${req.name} via ${req.dir}.`);

    if (!execute) {
      try {
        await io.pay({ to: req.name, amount: req.amount, corridor: req.dir, execute: false, requestId: req.id });
        dryMatched.set(req.id, deposit);
      } catch (e) {
        say(`DRY RUN: pre-flight fails right now: ${e.message}. With --execute the deposit would NOT be recorded and autopilot would stop here.`);
      }
      return;
    }

    // Pre-flight (sends nothing): contact + allow-list, both caps incl. the daily cap, and a live preview.
    // If it fails, the request is left untouched and the cursor stays before this deposit, so after the owner fixes
    // the cause and restarts, the same deposit matches again. Nothing has been recorded or paid.
    let pf;
    try {
      pf = await io.preflight({ to: req.name, amount: req.amount, corridor: req.dir, agent });
    } catch (e) {
      pin();
      noteCap(e);
      io.log({ type: "preflight_failed", requestId: req.id, token: sym, amount, from: payer, tx: l.transactionHash, block: String(l.blockNumber), error: e.message });
      throw new StopError(
        `Pre-flight failed for ${req.id}: ${e.message}. NOTHING was recorded or paid; the deposit stays in the agent wallet ` +
        `and ${req.id} is still open. Fix the cause, then run "watch --execute" again: it rescans from block ${cursor + 1n} and matches this deposit again. Stopping.`,
      );
    }

    // Record the deposit BEFORE paying: one payout per request, even if we crash mid-flow. (If this save fails, nothing
    // was recorded or paid and the deposit is handled again on the next poll.)
    const fresh = io.loadRequests();
    const r = fresh.find((x) => x.id === req.id);
    r.deposit = deposit;
    io.saveRequests(fresh);
    const ev = { kind: "request", key, recipient: pf?.recipient ?? r.recipient, token: sym, amount, corridor: r.dir, payer };
    report({ ...ev, status: "received", at: deposit.at });
    let res;
    try {
      res = await io.pay({ to: r.name, amount: r.amount, corridor: r.dir, execute: true, yes: true, requestId: r.id });
    } catch (e) {
      report({ ...ev, status: "failed", at: new Date().toISOString() });
      saveFailure(r.id, () => {
        const after = io.loadRequests();
        const failed = after.find((x) => x.id === r.id);
        failed.error = e.message;
        if (e.hashes) failed.hashes = e.hashes;
        io.saveRequests(after);
      });
      alert("payout_failed", `Payout for request ${r.id} failed: ${firstSentence(e.message)} Retry (dry run first): node src/agent.mjs retry --request ${r.id}`);
      throw new StopError(
        `Payout for ${r.id} failed: ${e.message}. The deposit is recorded on the request; it is not retried automatically. ` +
        `Fix the cause, then "node src/agent.mjs retry --request ${r.id}" (dry run; add --execute to pay). Stopping.`,
      );
    }
    recordPaid(`Request ${r.id}`, res, () => {
      const after = io.loadRequests();
      const done = after.find((x) => x.id === r.id);
      Object.assign(done, { paidAt: new Date().toISOString(), hashes: res.hashes, receiptUrl: res.receiptUrl, receiptNo: res.receiptNo, paid: res.paid });
      io.saveRequests(after);
    });
    report({ ...ev, status: "paid", res, at: new Date().toISOString() });
    say(`Paid ${r.id}. Receipt ${res.receiptNo}: ${receiptNoLink(res.receiptNo)}`);
    alert("payout_paid", `Paid request ${r.id} (${r.amount} ${sym} deposit). Receipt ${res.receiptNo}: ${receiptNoLink(res.receiptNo)}`);
    if (res.untagged?.length) throw new StopError(`Payout ${r.id} sent, but ${res.untagged.join(", ")} lack the attribution tag. Stopping to investigate.`);
  }

  /**
   * A permanent refusal of a registration deposit: logged, and recorded under the registration's `refused` map, so the
   * deposit counts as handled and a rescan never pays it. The registration itself stays usable for a later deposit.
   */
  async function refuseRegistration(reg, key, deposit, reason, fields) {
    say(`Refused deposit ${deposit.tx} for registration ${reg.hash}: ${reason} The deposit stays in the agent wallet (recorded as refused). Continuing.`);
    io.log({ type: "refused_deposit", registrationId: reg.hash, ...fields, error: reason });
    const id = reg.hash.toLowerCase();
    const s = io.loadRegState();
    const rec = s[id] ?? { id, hash: reg.hash, from: reg.from, name: reg.req.n, amount: reg.req.a, dir: reg.req.d, exp: reg.req.e };
    // Refused after the deposit was recorded (a cap the firm quote broke; nothing was sent): un-record it.
    if (!rec.paidAt && String(rec.deposit?.tx ?? "").toLowerCase() === String(deposit.tx).toLowerCase() && rec.deposit?.logIndex === deposit.logIndex) {
      delete rec.deposit;
      delete rec.error;
    }
    const refusedAt = new Date().toISOString();
    rec.refused = { ...(rec.refused ?? {}), [key]: { ...deposit, reason, refusedAt } };
    s[id] = rec;
    io.saveRegState(s);
    report({
      kind: "registration", key, registration: reg.hash, recipient: rec.from ?? reg.from, token: fields.token, amount: fields.amount,
      corridor: reg.req.d, payer: deposit.payer, status: "refused", reason, at: refusedAt,
    });
    alert("deposit_refused", `Refused ${fields.amount} ${fields.token} from ${deposit.payer} for a "Get paid" link: ${firstSentence(reason)} ` +
      `It stays in the agent wallet${autoRefundOn ? "; auto-refund is on" : `; refund it with: node src/agent.mjs refund --deposit ${key}`}.`);
    await autoRefundDeposit(key);
  }

  async function handleRegistration(l, key, reg, { sym, amount, payer, timeMs }) {
    const deposit = { payer, tx: l.transactionHash, logIndex: l.logIndex, block: String(l.blockNumber), at: new Date(timeMs).toISOString() };
    const where = { token: sym, amount, from: payer, tx: l.transactionHash, logIndex: l.logIndex, block: String(l.blockNumber) };
    const id = reg.hash.toLowerCase();
    const args = { to: reg.req.n, amount: reg.req.a, corridor: reg.req.d, recipientAddress: reg.from, payer, registrationId: reg.hash };
    say(`Matched registration ${reg.hash}: ${amount} ${sym} from ${short(payer)} (tx ${l.transactionHash}) -> pay ${reg.req.n} (${short(reg.from)}) via ${reg.req.d}.`);

    if (!execute) {
      try {
        await io.verifyRegistrationOnchain(pub, reg, agent);
        await io.pay({ ...args, execute: false });
        dryRegMatched.set(id, deposit);
      } catch (e) {
        say(e.permanent
          ? `DRY RUN: would refuse: ${e.message} With --execute this is logged and recorded, and autopilot carries on.`
          : `DRY RUN: pre-flight fails right now: ${e.message}. With --execute the deposit would NOT be recorded and autopilot would stop here.`);
      }
      return;
    }

    // Pre-flight (sends nothing): the registration re-read over RPC, recipient rules (not the payer, agent, own wallets,
    // contracts, zero), per-payout / daily / per-wallet caps and a live preview.
    let from;
    try {
      ({ from } = await io.verifyRegistrationOnchain(pub, reg, agent));
      await io.preflight({ ...args, recipientAddress: from, agent });
    } catch (e) {
      if (e.permanent) return refuseRegistration(reg, key, deposit, e.message, where);
      pin();
      noteCap(e);
      io.log({ type: "preflight_failed", registrationId: reg.hash, ...where, error: e.message });
      throw new StopError(
        `Pre-flight failed for registration ${reg.hash}: ${e.message}. NOTHING was recorded or paid; the deposit stays in the agent wallet. ` +
        `Fix the cause, then run "watch --execute" again: it rescans from block ${cursor + 1n} and matches this deposit again. Stopping.`,
      );
    }

    // Record the deposit BEFORE paying: one payout per registration, even if we crash mid-flow.
    const fresh = io.loadRegState();
    fresh[id] = {
      ...(fresh[id]?.refused ? { refused: fresh[id].refused } : {}),
      id, hash: reg.hash, from, name: reg.req.n, amount: reg.req.a, dir: reg.req.d, exp: reg.req.e,
      ...(reg.req.m ? { note: reg.req.m } : {}), deposit,
    };
    io.saveRegState(fresh);
    const ev = { kind: "registration", key, registration: reg.hash, recipient: from, token: sym, amount, corridor: reg.req.d, payer };
    report({ ...ev, status: "received", at: deposit.at });
    let res;
    try {
      res = await io.pay({ ...args, recipientAddress: from, execute: true, yes: true });
    } catch (e) {
      // A per-payout / per-wallet cap the firm quote broke, before anything was sent: a refusal, not a stop.
      if (e.permanent && !e.hashes) return refuseRegistration(reg, key, deposit, e.message, where);
      report({ ...ev, status: "failed", at: new Date().toISOString() });
      saveFailure(`registration ${reg.hash}`, () => {
        const after = io.loadRegState();
        after[id].error = e.message;
        if (e.hashes) after[id].hashes = e.hashes;
        io.saveRegState(after);
      });
      alert("payout_failed", `Payout for "Get paid" registration ${reg.hash} failed: ${firstSentence(e.message)} Retry (dry run first): node src/agent.mjs retry --registration ${reg.hash}`);
      throw new StopError(
        `Payout for registration ${reg.hash} failed: ${e.message}. The deposit is recorded; it is not retried automatically. ` +
        `Fix the cause, then "node src/agent.mjs retry --registration ${reg.hash}" (dry run; add --execute to pay). Stopping.`,
      );
    }
    recordPaid(`Registration ${reg.hash}`, res, () => {
      const after = io.loadRegState();
      Object.assign(after[id], { paidAt: new Date().toISOString(), hashes: res.hashes, receiptUrl: res.receiptUrl, receiptNo: res.receiptNo, paid: res.paid });
      io.saveRegState(after);
    });
    report({ ...ev, status: "paid", res, at: new Date().toISOString() });
    say(`Paid registration ${reg.hash}. Receipt ${res.receiptNo}: ${receiptNoLink(res.receiptNo)}`);
    alert("payout_paid", `Paid "Get paid" link ${reg.hash.slice(0, 10)}… (${amount} ${sym} deposit). Receipt ${res.receiptNo}: ${receiptNoLink(res.receiptNo)}`);
    if (res.untagged?.length) throw new StopError(`Payout for ${reg.hash} sent, but ${res.untagged.join(", ")} lack the attribution tag. Stopping to investigate.`);
  }

  /**
   * A permanent refusal of an nTag deposit: logged, and recorded in ntag-payments.json as { status: "refused", reason }
   * so it counts as handled (a rescan never pays it). Dry run: printed only.
   */
  async function refuseNtag(key, reason, fields, where) {
    say(`Refused LokalPay tag deposit ${where.amount} ${where.token} from ${short(where.from)} (tx ${where.tx})${where.ntag ? ` for @${where.ntag}` : ""}: ${reason}. NOT paid; the deposit stays in the agent wallet${execute ? " (recorded as refused)" : ""}. Continuing.`);
    if (!execute) return;
    io.log({ type: "refused_deposit", reason, ...where });
    const s = io.loadNtagPayments();
    s[key] = { ...(s[key] ?? {}), id: key, ...fields, status: "refused", reason, refusedAt: new Date().toISOString() };
    io.saveNtagPayments(s);
    report({
      kind: "ntag", key, tag: where.ntag ?? undefined, recipient: s[key].from ?? s[key].owner, token: where.token, amount: where.amount,
      corridor: s[key].dir, payer: where.from, status: "refused", reason, at: s[key].refusedAt,
    });
    alert("deposit_refused", `Refused ${where.amount} ${where.token} from ${where.from}${where.ntag ? ` for @${where.ntag}` : ""}: ${firstSentence(reason)} ` +
      `It stays in the agent wallet${autoRefundOn ? "; auto-refund is on" : `; refund it with: node src/agent.mjs refund --deposit ${key}`}.`);
    await autoRefundDeposit(key);
  }

  async function handleNtag(l, key, tag, { sym, amount, payer, timeMs, tx, currency = null }) {
    const deposit = { payer, tx: l.transactionHash, logIndex: l.logIndex, block: String(l.blockNumber), at: new Date(timeMs).toISOString() };
    const where = { ntag: tag, token: sym, amount, from: payer, tx: l.transactionHash, logIndex: l.logIndex, block: String(l.blockNumber) };
    const ready = ntagCache != null && BigInt(l.blockNumber) <= ntagOpsHeight;
    const contractEntry = tag ? await contracts.memoOwner(tag, l.blockNumber) : null; // the contract owner wins from the cutover on
    const d = classifyNtagDeposit({
      key, tag, currency, token: l.address, value: l.args.value, payer, tx, block: l.blockNumber, position: l.transactionIndex ?? tx.index,
    }, ready ? legacyNtagOps(ntagCache.ops) : null, ntagPayments(), agent, contractEntry);
    if (d.action === "handled") {
      say(`Deposit ${l.transactionHash}${tag ? ` for @${tag}` : ""} was already handled${d.record?.status === "refused" ? ` (refused: ${d.record.reason})` : ""}. Skipping.`);
      return;
    }
    if (d.action === "hold") {
      throw Object.assign(new HoldError(
        `LokalPay tag deposit ${amount} ${sym} from ${short(payer)} (tx ${l.transactionHash}) for @${tag} waits: the LokalPay tag list is not loaded up to block ${l.blockNumber}` +
        `${ntagOpsError ? ` (${ntagOpsError})` : ""}. It is neither paid nor refused; autopilot keeps its place before it and tries again next poll.`,
      ), { key, where });
    }
    if (d.action === "refuse") {
      return refuseNtag(key, d.reason, { tag: tag ?? null, token: sym, amount, deposit, ...(tag ? { name: `@${tag}` } : {}), input: tag ? undefined : tx.input }, where);
    }
    const args = { to: `@${tag}`, amount: d.amount, corridor: d.corridor, recipientAddress: d.entry.owner, payer, ntag: tag };
    say(`LokalPay tag payment: ${amount} ${sym} from ${short(payer)} (tx ${l.transactionHash}) -> pay @${tag} (${short(d.entry.owner)}) via ${d.corridor}.`);
    if (d.dust > 0n) say(`  Paying ${d.amount} ${sym}; ${formatUnits(d.dust, 6)} ${sym} of dust stays in the agent wallet.`);
    const record = (from) => ({
      id: key, tag, name: `@${tag}`, from, owner: from, claim: d.entry.hash, ...(d.entry.source ? { ownerSource: d.entry.source } : {}), ...(d.entry.name ? { ownerName: d.entry.name } : {}),
      token: sym, amount: d.amount, dir: d.corridor, ...(d.currency ? { currency: d.currency } : {}), ...(d.dust > 0n ? { dust: formatUnits(d.dust, 6) } : {}), deposit,
    });

    if (!execute) {
      try {
        if (d.op) await io.verifyNtagOpOnchain(pub, d.op, agent);
        await io.ntagUsdFloor(d.corridor, d.units);
        await io.pay({ ...args, execute: false });
        dryNtag.set(key, record(d.entry.owner));
      } catch (e) {
        say(e.permanent
          ? `DRY RUN: would refuse: ${e.message} With --execute this is logged and recorded as refused, and autopilot carries on.`
          : `DRY RUN: pre-flight fails right now: ${e.message}. With --execute the deposit would NOT be recorded and autopilot would stop here.`);
      }
      return;
    }

    // Pre-flight (sends nothing): the winning claim re-read over RPC, recipient rules (not the payer, agent, own wallets,
    // contracts, zero), per-payout / daily / per-wallet caps and a live preview.
    let from;
    try {
      ({ from } = d.op ? await io.verifyNtagOpOnchain(pub, d.op, agent) : { from: getAddress(d.entry.owner) });
      await io.ntagUsdFloor(d.corridor, d.units);
      await io.preflight({ ...args, recipientAddress: from, agent });
    } catch (e) {
      if (e.permanent) return refuseNtag(key, e.message, record(from ?? d.entry.owner), where);
      pin();
      noteCap(e);
      io.log({ type: "preflight_failed", ...where, error: e.message });
      throw new StopError(
        `Pre-flight failed for the LokalPay tag payment to @${tag}: ${e.message}. NOTHING was recorded or paid; the deposit stays in the agent wallet. ` +
        `Fix the cause, then run "watch --execute" again: it rescans from block ${cursor + 1n} and matches this deposit again. Stopping.`,
      );
    }

    // Record the deposit BEFORE paying: one payout per deposit, even if we crash mid-flow.
    const fresh = io.loadNtagPayments();
    if (fresh[key]) { say(`Deposit ${l.transactionHash} for @${tag} was already handled. Skipping.`); return; }
    fresh[key] = record(from);
    io.saveNtagPayments(fresh);
    const ev = { kind: "ntag", key, tag, recipient: from, token: sym, amount, corridor: d.corridor, payer };
    report({ ...ev, status: "received", at: deposit.at });
    let res;
    try {
      res = await io.pay({ ...args, recipientAddress: from, execute: true, yes: true });
    } catch (e) {
      // A per-payout / per-wallet cap the firm quote broke (e.g. cNGN near $25), before anything was sent: a refusal.
      if (e.permanent && !e.hashes) return refuseNtag(key, e.message, {}, where);
      report({ ...ev, status: "failed", at: new Date().toISOString() });
      saveFailure(`the LokalPay tag payment ${key}`, () => {
        const after = io.loadNtagPayments();
        after[key].error = e.message;
        if (e.hashes) after[key].hashes = e.hashes;
        io.saveNtagPayments(after);
      });
      alert("payout_failed", `Payout to @${tag} failed: ${firstSentence(e.message)} Retry (dry run first): node src/agent.mjs retry --ntag ${key}`);
      throw new StopError(
        `Payout to @${tag} failed: ${e.message}. The deposit is recorded; it is not retried automatically. ` +
        `Fix the cause, then "node src/agent.mjs retry --ntag ${key}" (dry run; add --execute to pay). Stopping.`,
      );
    }
    recordPaid(`The LokalPay tag payment ${key} to @${tag}`, res, () => {
      const after = io.loadNtagPayments();
      Object.assign(after[key], { paidAt: new Date().toISOString(), hashes: res.hashes, receiptUrl: res.receiptUrl, receiptNo: res.receiptNo, paid: res.paid });
      io.saveNtagPayments(after);
    });
    report({ ...ev, status: "paid", res, at: new Date().toISOString() });
    say(`Paid @${tag}. Receipt ${res.receiptNo}: ${receiptNoLink(res.receiptNo)}`);
    alert("payout_paid", `Paid @${tag} (${amount} ${sym} deposit). Receipt ${res.receiptNo}: ${receiptNoLink(res.receiptNo)}`);
    if (res.untagged?.length) throw new StopError(`Payout to @${tag} sent, but ${res.untagged.join(", ")} lack the attribution tag. Stopping to investigate.`);
  }

  /**
   * Loads the nTag list (in full the first time, then only what is new). A failure never stops requests or
   * registrations: nTag deposits past the last good height just wait. A failed FULL load is retried with backoff.
   */
  async function refreshNtags(indexed) {
    if (!ntagCache && io.now() < ntagRetryAt) return;
    try {
      ntagCache = ntagCache ? await io.refreshNtagOpsCache(ntagCache, { agent }) : await io.loadNtagOpsCache({ agent });
      ntagOpsHeight = indexed;
      if (ntagOpsError) say(`LokalPay tag list loaded again (${ntagCache.ops.length} op(s)); waiting LokalPay tag payments are handled now.`);
      ntagOpsError = null;
      ntagFailures = 0;
    } catch (e) {
      const full = !ntagCache;
      if (full) ntagRetryAt = io.now() + backoffMs(intervalMs, ntagFailures);
      ntagFailures++;
      const msg = e.shortMessage ?? e.message;
      if (msg !== ntagOpsError) {
        say(`Could not ${full ? "load" : "refresh"} the LokalPay tag list: ${msg} Payment requests and "Get paid" registrations carry on; ` +
          `LokalPay tag payments ${ntagOpsHeight >= 0n ? `after block ${ntagOpsHeight} ` : ""}wait (not paid, not refused) until it loads.`);
      }
      ntagOpsError = msg;
    }
  }

  // Low CELO (read at most once a minute) and the heartbeat (execute mode with a status secret, about once a minute).
  let gasState = {};
  let lastGasCheck = -Infinity;
  let celoBalance = null;
  let lastBeat = -Infinity;
  let beating = false;
  let statusDownAlerted = false;
  const version = (() => { try { return io.version?.() ?? "0.0.0"; } catch { return "0.0.0"; } })();
  /** Once per poll, outside any payout. Never throws and never waits on the status server. */
  async function tick(latest) {
    const t = io.now();
    if (t - lastGasCheck >= GAS_CHECK_MS) {
      lastGasCheck = t;
      try {
        celoBalance = await pub.getBalance({ address: agent });
        const g = gasAlert(gasState, { balance: celoBalance, warnUnits: parseUnits(LOW_CELO_WARN, 18), reserveUnits: parseUnits(MIN_CELO_RESERVE, 18), now: t });
        gasState = g.state;
        if (g.warn) {
          const msg = `The agent holds only ${formatUnits(celoBalance, 18)} CELO for gas` + (g.warn === "reserve"
            ? `, below the hard reserve of ${MIN_CELO_RESERVE} CELO (MIN_CELO_RESERVE). Payouts will start failing: top up the agent wallet ${agent} now.`
            : `, under the warning level of ${LOW_CELO_WARN} CELO (LOW_CELO_WARN). Top up the agent wallet ${agent} soon.`);
          say(`WARNING: LOW GAS. ${msg}`);
          if (execute) alert("celo_low", msg);
        } else if (g.recovered) say(`CELO for gas is fine again (${formatUnits(celoBalance, 18)} CELO).`);
      } catch { /* a balance that can't be read never stops autopilot */ }
    }
    if (!execute || !status?.enabled) return;
    if (t - lastBeat >= HEARTBEAT_MS && !beating) {
      lastBeat = t;
      beating = true;
      const lag = cursor != null && latest != null && latest > cursor ? Number(latest - cursor) : 0;
      Promise.resolve(status.heartbeat?.({
        at: new Date(t).toISOString(), cursorBlock: cursor != null ? String(cursor) : null, chainHead: latest != null ? String(latest) : null,
        lagBlocks: cursor != null && latest != null ? lag : null, celoBalance: celoBalance != null ? formatUnits(celoBalance, 18) : null,
        lowGas: (gasState.level ?? "ok") !== "ok", version, autoRefund: autoRefundOn,
      })).catch(() => {}).finally(() => { beating = false; });
    }
    try {
      const since = status.health?.()?.failingSince ?? null;
      if (since == null) statusDownAlerted = false;
      else if (!statusDownAlerted && t - since >= STATUS_DOWN_ALERT_MS) {
        statusDownAlerted = true;
        const msg = `The status server has not answered for ${Math.round((t - since) / 60_000)} minutes. Payouts carry on; the site estimates from Celo until it is back.`;
        say(`WARNING: ${msg}`);
        alert("status_unreachable", msg);
      }
    } catch { /* never */ }
  }

  try {
    let done = 0;
    while (!stopping && done < polls) {
      done++;
      try {
        const latest = await pub.getBlockNumber();
        await tick(latest);
        // Blockscout's indexed height FIRST, then the registrations and nTag ops: every one in a block <= that height is
        // in the lists, and deposits are scanned only up to that height.
        const indexed = await io.indexedHeight();
        const from0 = cursor ?? (state.cursor != null ? BigInt(state.cursor) : latest);
        const sinceSec = Math.floor(Date.now() / 1000) - Number(latest > from0 ? latest - from0 : 0n) - (MAX_REG_HOURS + 24) * 3600;
        regs = await io.discoverRegistrations({ agent, sinceSec });
        await refreshNtags(indexed);
        if (cursor == null) {
          cursor = state.cursor != null ? BigInt(state.cursor) : initialFromBlock(latest, [...requests(), ...registrationWindows(regs)]) - 1n;
          say(`Scanning from block ${cursor + 1n} (latest ${latest}). ${regs.length} "Get paid" registration(s) and ${ntagCache ? ntagCache.ops.length : "no"} LokalPay tag op(s) found.`);
        }
        const head = indexed < latest ? indexed : latest;
        const chunks = chunkRanges(cursor + 1n, head);
        if (chunks.length > 2) say(`Catching up on ${head - cursor} blocks in ${chunks.length} queries…`);
        let held = null;
        for (const [i, [from, to]] of chunks.entries()) {
          if (stopping) break;
          if (chunks.length > 2 && i > 0 && i % 5 === 0) say(`  …block ${from} (${i}/${chunks.length})`);
          const logs = await pub.getLogs({
            address: [TOKENS.USDT.address, TOKENS.CNGN.address], event: TRANSFER, args: { to: agent }, fromBlock: from, toBlock: to, strict: true,
          });
          // Contract payments in the same range join in chain order; their inner Transfer into the agent is dropped here,
          // so the deposit path below never sees it (contract-watch.mjs).
          const items = contracts.merge(logs, await contracts.scan(from, to));
          for (const it of items) {
            try {
              // a payout is never interrupted mid-flow by Ctrl+C
              if (it.contract) await contracts.handle(it.contract);
              else await handle(it.transfer);
            } catch (e) {
              if (!(e instanceof HoldError)) throw e;
              held = e;
              break;
            }
            if (stopping) break;
          }
          if (stopping || held) break; // leave the cursor before this chunk so nothing is skipped
          cursor = to;
          if (execute) io.saveState({ cursor: String(cursor), updatedAt: new Date().toISOString() });
        }
        if (held) {
          if (!heldNoted.has(held.key)) {
            heldNoted.add(held.key);
            say(held.message);
            if (execute) io.log({ type: "ntag_held", ...held.where, error: ntagOpsError ?? "LokalPay tag list not loaded" });
          }
        } else if (failures > 0 || (chunks.length > 0 && !caughtUp)) {
          if (!stopping) say(`Up to date at block ${cursor}. Waiting for deposits… (Ctrl+C to stop)`);
          caughtUp = true;
        }
        failures = 0;
      } catch (e) {
        if (e instanceof StopError) throw e;
        const wait = backoffMs(intervalMs, failures++);
        say(`Error: ${e.shortMessage ?? e.message}. Nothing was skipped; retrying in ${Math.round(wait / 1000)}s.`);
        if (done < polls) await sleep(wait);
        continue;
      }
      if (!stopping && done < polls) await sleep(intervalMs);
    }
    say("Stopped.");
  } catch (e) {
    if (e instanceof StopError) {
      // What happened (in full), then one clear last line: what stopped it and how to restart.
      say(e.message);
      say(stopLine(e.message, { autoRefund: autoRefundOn }));
      alert("autopilot_stopped", `Autopilot stopped: ${firstSentence(e.message)} Resume after fixing it: ${resumeCommand({ autoRefund: autoRefundOn })}`);
      e.printed = true;
    }
    throw e;
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigint);
    // one last chance for queued status reports and alerts (at most a few seconds each; payouts are already done)
    try { await status?.close?.({ waitMs: 5_000 }); } catch { /* best effort */ }
    try { await alerter?.close?.({ waitMs: 5_000 }); } catch { /* best effort */ }
  }
}
