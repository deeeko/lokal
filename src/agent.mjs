#!/usr/bin/env node
// Lokal agent CLI entry point. Corridors: usdt-cngn (default, pay in naira), usdt-idrx (rupiah), usdt-wars (Argentine
// pesos), usdt-wcop (Colombian pesos), cngn-usdt (pay in dollars) and, for pay/quote only, celo-cngn (pay in naira from
// CELO: two swaps, CELO -> USDT -> cNGN; amount in CELO). --to-currency NAME picks the usdt-<currency> corridor by name:
// naira | rupiah | argentina-peso | colombia-peso (or the codes cngn | idrx | wars | wcop, or NGN | IDR | ARS | COP).
//   node src/agent.mjs keygen                                   create the agent wallet (key never printed)
//   node src/agent.mjs status                                   balances, limits, today's total
//   node src/agent.mjs quote --amount 10 [--corridor ID | --to-currency rupiah]   free indicative price, no wallet needed
//   node src/agent.mjs quote --all [--amount 5]                 every currency at once (what $5 becomes in each)
//   node src/agent.mjs quote --corridor celo-cngn --amount 20   CELO -> USDT -> cNGN estimate (two previews)
//   node src/agent.mjs pay --to ada --amount 10 [--corridor ID | --to-currency rupiah]   DRY RUN (add --execute for real money)
//   node src/agent.mjs pay --to ada --amount 20 --corridor celo-cngn   pay in naira from 20 CELO (DRY RUN unless --execute)
//   node src/agent.mjs ask "send $10 to ada"                    same, from plain language
//   node src/agent.mjs request --to ada --amount 5 [--corridor ID | --to-currency rupiah] [--note TEXT] [--hours 48]
//                                                               create a payment link with a unique amount
//   node src/agent.mjs requests                                 list payment requests
//   node src/agent.mjs watch [--execute] [--interval 15]        autopilot: pay matched deposits (DRY RUN by default)
//   node src/agent.mjs registrations                            list "Get paid" registrations found onchain
//   node src/agent.mjs retry --request ID [--execute] [--yes]  re-run a failed autopilot payout (DRY RUN by default)
//   node src/agent.mjs retry --registration HASH [--execute] [--yes]   same, for a "Get paid" registration
//   node src/agent.mjs retry --ntag TX:LOGINDEX [--execute] [--yes]    same, for an nTag payment
//   node src/agent.mjs retry --ntag TX:LOGINDEX --force-refused [--execute]   pay an nTag deposit autopilot refused (caps apply)
//   node src/agent.mjs ntag <tag|address>                       look up an nTag: owner, name, since, claim tx, status
//   node src/agent.mjs ntags                                    list every nTag that is held right now
//   node src/agent.mjs pay @ada 10 [--to-currency X] [--execute]  pay a tag's owner from the agent's own funds (caps apply;
//                                                               default currency: the tag's preferred one, else naira)
//   node src/agent.mjs pay --ntag ada --amount 10 [...]         same (PowerShell reads a bare @ada as splatting: quote it)
//   node src/agent.mjs ntag-data @ada 10 [--token usdt|cngn] [--to-currency X]   the to/data to pay a tag from YOUR OWN
//                                                               wallet (no key used; the memo names the currency)
//   node src/agent.mjs register --repo <url>                   ERC-8004 identity (DRY RUN unless --execute)
//   node src/agent.mjs verify <txHash>                          show the attribution tag on a transaction
//   node src/agent.mjs status-sync [--backfill]                 send queued reports to the site's status server
//                                                               (--backfill: re-send every saved deposit record too)
//   node src/agent.mjs refunds                                  deposits that can be refunded, and every refund so far
//   node src/agent.mjs refund --deposit TX:LOGINDEX [--execute] [--yes] [--retry]   send a deposit back to its sender
//                                                               (DRY RUN with a gas estimate unless --execute; docs/REFUNDS.md)
//   node src/agent.mjs watch --execute --auto-refund            autopilot that also refunds refused tag / Get paid deposits
//   node src/agent.mjs alert-test                               send a test alert (Telegram and/or ALERT_WEBHOOK_URL)
//   node src/agent.mjs doctor                                   PASS / WARN / FAIL checks of this setup (never reads the key)
// One agent at a time: watch --execute and every other command with --execute (pay, ask, retry, register, refund) take
// agent.lock. A lock left by a crash is never removed automatically: add --clear-stale-lock once you have checked.
import { createPublicClient, erc20Abi, formatUnits, http, isAddress, parseUnits } from "viem";
import { loadContractDeposits } from "./contract-watch.mjs"; // contract payments count as deposits (refunds, status)
import { verifyTx } from "@celo/attribution-tags";
import {
  AGENT_ADDRESS, ATTRIBUTION_CODE, CELO_MIN_USDT, CHAIN, DEFAULT_CORRIDOR, MAX_DAILY_USD, MAX_USD, MAX_WALLET_DAILY_USD,
  MIN_CELO_RESERVE, SITE_URL, STATUS_OUTBOX_FILE, STATUS_URL, TOKENS,
} from "./config.mjs";
import { keygen, loadAccount, makeClients } from "./chain.mjs";
import {
  assertRecipient, dailyUsedUnits, getCorridor, getPayCorridor, parseAmount, parseCurrency, payoutCorridor, resolveContact,
} from "./guards.mjs";
import { CURRENCIES, corridorFor, currencyOf, currencyOfCorridor, formatCurrencyUnits } from "./currencies.mjs";
import { celoQuote, describeQuote } from "./celo.mjs";
import { parseIntent } from "./intent.mjs";
import { BLOCKED_RECIPIENTS, confirm, loadContacts, log, pay, preflight, readReceipts } from "./pay.mjs";
import { createRequest, loadRequests, receiptNoLink, requestLink, requestStatus, retryBlocker, saveRequests } from "./requests.mjs";
import {
  discoverRegistrations, listStatus, loadRegState, MAX_REG_HOURS, registrationLink, registrationStatuses, saveRegState,
} from "./registrations.mjs";
import { preview } from "./textile.mjs";
import { register, updateCard } from "./register8004.mjs";
import {
  decodeNtagPayment, discoverNtagOps, encodeNtagTransfer, loadNtagPayments, normalizeNtag, ntagAvailability, ntagError, ntagOf,
  ownerOf, refusedRetryBlocker, resolveNtags, saveNtagPayments, verifyNtagOpOnchain,
} from "./ntags.mjs";
import { NTAG_MIN, NTAG_MIN_USD, ntagUsdFloor, watch } from "./watch.mjs";
import { directEvent, eventsFromRecords, isDirectReceipt, makeStatusReporter, refundEvent, retryPaidEvent } from "./status-report.mjs";
import { acquireLock } from "./lock.mjs";
import { age, loadRefunds, refundDeposit, refundRows, saveRefunds } from "./refund.mjs";
import { makeAlerter } from "./alerts.mjs";
import { runDoctor } from "./doctor.mjs";

const [cmd, ...rest] = process.argv.slice(2);
const flag = (n) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : undefined; };
const has = (n) => rest.includes(`--${n}`);
/** --to-currency NAME (naira, rupiah, argentina-peso, colombia-peso, or a code) -> its usdt-<currency> corridor id, or undefined. */
const currencyCorridor = () => {
  const v = flag("to-currency");
  if (v == null) return undefined;
  if (flag("corridor") != null) throw new Error("Use --corridor or --to-currency, not both.");
  return payoutCorridor(v);
};
const corridorFlag = (fallback = DEFAULT_CORRIDOR) => getCorridor(currencyCorridor() ?? flag("corridor") ?? fallback); // payment-link corridors only
const payCorridorFlag = () => getPayCorridor(currencyCorridor() ?? flag("corridor") ?? DEFAULT_CORRIDOR); // + celo-cngn (pay / quote)
/** "rupiah (IDRX)" for a usdt-<currency> corridor, "dollars (USDT)" for cngn-usdt. */
const receiveWord = (c) => { const cur = currencyOfCorridor(c.id); return cur ? `${cur.plural} (${cur.token})` : "dollars (USDT)"; };
const agentAddress = () => loadAccount({ required: false })?.address ?? AGENT_ADDRESS;
/** Positional arguments (everything that is not a --flag or a flag's value). */
const positional = () => {
  const out = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith("--")) { if (!["--execute", "--yes", "--clear-stale-lock", "--auto-refund", "--retry"].includes(rest[i])) i++; continue; }
    out.push(rest[i]);
  }
  return out;
};
const readClient = () => createPublicClient({ chain: CHAIN, transport: http(process.env.CELO_RPC_URL || undefined, { timeout: 30_000, retryCount: 2 }) });
const nowSec = () => Math.floor(Date.now() / 1000);
const iso = (sec) => new Date(sec * 1000).toISOString();
const tagLink = (tag) => `${SITE_URL}/tag.html#${tag}`;

/** A tag from user input ("@Ada" -> "ada"), or throws with the rule it breaks. */
function tagArg(input, usage) {
  if (!input) throw new Error(`Usage: ${usage}`);
  const tag = normalizeNtag(input);
  const err = ntagError(tag);
  if (err) throw new Error(`@${tag}: ${err}.`);
  return tag;
}

/** Current nTag state (Blockscout, all pages) and the entry + claim op for `tag`, or a clear error when nobody holds it. */
async function resolveOwner(tag) {
  const ops = await discoverNtagOps({ agent: agentAddress() });
  const entry = ownerOf(resolveNtags(ops, nowSec()), tag);
  if (!entry) throw new Error(`@${tag} has no owner right now. Nothing was sent.`);
  const op = ops.find((o) => o.hash === entry.hash);
  if (!op) throw new Error(`The claim for @${tag} was not found. Nothing was sent.`);
  return { entry, op };
}

/**
 * The record `retry` works on: a request (owner link), a "Get paid" registration or an nTag payment. Same fields: id,
 * deposit, error, hashes ...
 */
const KINDS = {
  request: { load: () => loadRequests(), get: (l, id) => l.find((x) => x.id === id), save: saveRequests },
  registration: { load: loadRegState, get: (s, id) => s[String(id).toLowerCase()], save: saveRegState },
  ntag: { load: loadNtagPayments, get: (s, id) => s[String(id).toLowerCase()], save: saveNtagPayments },
};
const target = (kind, id) => KINDS[kind].get(KINDS[kind].load(), id);
function updateTarget(kind, id, fn) {
  const k = KINDS[kind];
  const s = k.load();
  fn(k.get(s, id));
  k.save(s);
}

/**
 * After a payout made from this command line: tell the site's status server (best effort, a few seconds at most; the
 * payout is already done and nothing here can change it). Whatever isn't sent stays queued for autopilot.
 */
async function reportAfterPayout(events) {
  try {
    const list = [].concat(events ?? []).filter(Boolean);
    if (!list.length) return;
    const rep = makeStatusReporter({ quiet: true, say: (m) => console.log(m) });
    if (!rep.enabled) return;
    // send directly (this command may be running next to autopilot); only what isn't accepted waits in the outbox
    const { queued } = await rep.sendNow(list);
    if (queued) console.log(`Status server: ${queued} report(s) wait in the outbox; autopilot or status-sync sends them.`);
    await rep.close({ waitMs: 2_000 });
  } catch { /* reporting never affects a payout */ }
}
/** Direct payouts this command just made, read back from receipts.jsonl by payout hash. */
const directEventsFor = (res) => {
  const h = String(res?.hashes?.payout ?? "").toLowerCase();
  if (!h) return [];
  return readReceipts().filter((e) => String(e?.hashes?.payout ?? "").toLowerCase() === h && isDirectReceipt(e, agentAddress())).map(directEvent);
};

/** The agent lock for a command that moves money (only with --execute). Released on exit, Ctrl+C, SIGTERM and crashes. */
const takeLock = (command) => acquireLock({ command, clearStale: has("clear-stale-lock"), signals: true });

/** A refund the operator just made: tell the site's status server (best effort). */
async function reportRefund(rec) {
  const ev = refundEvent(rec);
  if (ev) await reportAfterPayout([ev]);
}

/** Refuses when a deposit has a refund record: a refunded (or refunding) deposit is never paid. */
function assertNotRefunded(depositKey) {
  const r = depositKey ? loadRefunds()[String(depositKey).toLowerCase()] : null;
  if (r) throw new Error(`Deposit ${depositKey} has a refund record (${r.status}${r.refundTx ? `, ${r.refundTx}` : ""}). A refunded deposit is never paid. Nothing was sent.`);
}

async function main() {
  // Every command that can move money takes the agent lock first (dry runs never do). watch and refund take it themselves.
  if (has("execute") && ["pay", "ask", "retry", "register"].includes(cmd)) takeLock(`${cmd} --execute`);
  switch (cmd) {
    case "keygen": {
      const r = keygen();
      console.log(r.created ? "Created agent wallet." : "Agent wallet already exists (not overwritten).");
      console.log(`Address: ${r.address}\nBack up the key file offline. Never open it in an editor with an AI assistant or paste it anywhere.`);
      break;
    }
    case "status": {
      const account = loadAccount();
      const { pub } = makeClients(account);
      const toks = Object.values(TOKENS);
      const [celo, ...bals] = await Promise.all([
        pub.getBalance({ address: account.address }),
        ...toks.map((t) => pub.readContract({ address: t.address, abi: erc20Abi, functionName: "balanceOf", args: [account.address] })),
      ]);
      const used = formatUnits(dailyUsedUnits(readReceipts()), 6);
      const open = loadRequests().filter((r) => requestStatus(r) === "open").length;
      console.log(`Agent: ${account.address}\nCELO: ${formatUnits(celo, 18)}  ${toks.map((t, i) => `${t.symbol}: ${formatUnits(bals[i], t.decimals)}`).join("  ")}`);
      console.log(`Tag: ${ATTRIBUTION_CODE}  Per-payout cap: ${MAX_USD} USD  Daily cap: ${MAX_DAILY_USD} USD (used in last 24 h: ${used} USD)`);
      console.log(`CELO gas reserve kept by celo-cngn payouts: ${MIN_CELO_RESERVE} CELO (MIN_CELO_RESERVE)`);
      console.log(`Per-wallet cap for "Get paid" payouts: ${MAX_WALLET_DAILY_USD} USD per rolling 24 h (MAX_WALLET_DAILY_USD)`);
      console.log(`Open payment requests: ${open}`);
      break;
    }
    case "quote": {
      if (has("all")) {
        // What one USD₮ amount becomes in every currency (free previews, no wallet).
        const amount = parseAmount(flag("amount") ?? "5");
        const units = parseUnits(amount, TOKENS.USDT.decimals);
        console.log(`What ${amount} USDT becomes (indicative Textile FX previews, fee included):`);
        for (const cur of CURRENCIES) {
          const c = getCorridor(corridorFor(cur.code));
          let line;
          try {
            const pv = await preview(c.sellToken.address, c.buyToken.address, units.toString());
            line = pv.status === "preview"
              ? `${formatCurrencyUnits(pv.buyAmount, cur.code).padEnd(16)} = ${formatUnits(BigInt(pv.buyAmount), c.buyToken.decimals)} ${c.buyToken.symbol} (${c.buyToken.decimals} decimals)`
              : `not available right now (${[pv.status, pv.reason].filter(Boolean).join(": ")})`;
          } catch (e) { line = `could not check (${e.message})`; }
          console.log(`  ${cur.flag} ${cur.label.padEnd(10)} [${c.id}]  ${line}`);
        }
        break;
      }
      const c = payCorridorFlag();
      if (c.id === "celo-cngn") {
        const q = await celoQuote(flag("amount") ?? "20");
        console.log(`[${c.id}] ${describeQuote(q)}`);
        if (q.belowMinimum) {
          console.log(`  Too small: Textile needs about $1 per swap; swap 1 must buy at least ${CELO_MIN_USDT} USDT. Send at least ~20 CELO.`);
        }
        if (q.leg2Error) console.log(`  No USDT -> cNGN price for this size right now (${q.leg2Error}).`);
        console.log(`  Real payouts keep at least ${MIN_CELO_RESERVE} CELO in the agent wallet for gas (MIN_CELO_RESERVE).`);
        console.log(JSON.stringify({ leg1: q.pv1, leg2: q.pv2 }, null, 2));
        break;
      }
      const amount = parseAmount(flag("amount") ?? (c.sell === "USDT" ? "10" : "14400"));
      const pv = await preview(c.sellToken.address, c.buyToken.address, parseUnits(amount, c.sellToken.decimals).toString());
      if (pv.status === "preview") {
        console.log(`[${c.id}] ${amount} ${c.sellToken.symbol} -> ~${formatUnits(BigInt(pv.buyAmount), c.buyToken.decimals)} ${c.buyToken.symbol} (indicative, ${c.blurb})`);
      } else if (c.currency) {
        console.log(`[${c.id}] ${currencyOf(c.currency).label} isn't available on Textile FX right now (${[pv.status, pv.reason].filter(Boolean).join(": ")}). A payout now would be refused (currency_unavailable).`);
      }
      console.log(JSON.stringify(pv, null, 2));
      break;
    }
    case "pay": {
      const [p0, p1] = positional();
      const to = flag("ntag") != null ? `@${normalizeNtag(flag("ntag"))}` : flag("to") ?? p0;
      if (String(to ?? "").trim().startsWith("@")) {
        // Owner payout to an nTag: the agent's own funds go to the tag owner's wallet. Same recipient rules and caps
        // (incl. per-wallet) as "Get paid" payouts; dry run unless --execute. (PowerShell: quote '@ada' or use --ntag ada.)
        const usage = "pay @tag <amount> | pay --ntag TAG --amount N [--to-currency naira|rupiah|argentina-peso|colombia-peso | --corridor ID] [--execute] [--yes]";
        const tag = tagArg(to, usage);
        const amount = flag("amount") ?? (flag("to") != null || flag("ntag") != null ? p0 : p1);
        if (!amount) throw new Error(`Usage: ${usage}`);
        const agent = agentAddress();
        const { entry, op } = await resolveOwner(tag);
        // celo-cngn is for contacts only. No --to-currency / --corridor: the tag's preferred currency, else naira.
        const c = corridorFlag(corridorFor(entry.currency ?? "cngn"));
        const { from } = await verifyNtagOpOnchain(readClient(), op, agent);
        console.log(`@${tag} belongs to ${from}${entry.name ? ` (${entry.name})` : ""}; claim ${op.hash} checks out onchain.`);
        console.log(`@${tag} receives ${receiveWord(c)}${entry.currency && flag("to-currency") == null && flag("corridor") == null ? " (their preferred currency)" : ""}.`);
        const res = await pay({ to: `@${tag}`, amount, corridor: c.id, recipientAddress: from, payer: agent, execute: has("execute"), yes: has("yes"), ntag: tag });
        await reportAfterPayout(directEventsFor(res));
        break;
      }
      const res = await pay({ to: flag("to"), amount: flag("amount"), corridor: payCorridorFlag().id, execute: has("execute"), yes: has("yes") });
      await reportAfterPayout(directEventsFor(res));
      break;
    }
    case "ask": {
      const text = rest.filter((a) => !a.startsWith("--")).join(" ");
      if (/\bcelo\b/i.test(text)) {
        throw new Error("ask pays in USD only. For CELO use: node src/agent.mjs pay --to NAME --amount N --corridor celo-cngn");
      }
      const { contacts } = loadContacts();
      const intent = await parseIntent(text, [...contacts.keys()]);
      console.log(`Understood: pay ${intent.amount} USD to "${intent.to}"`);
      const res = await pay({ to: intent.to, amount: intent.amount, execute: has("execute"), yes: has("yes") });
      await reportAfterPayout(directEventsFor(res));
      break;
    }
    case "request": {
      const c = corridorFlag();
      const name = flag("to");
      if (!name || !flag("amount")) throw new Error("Usage: request --to NAME --amount N [--corridor ID | --to-currency rupiah] [--note TEXT] [--hours 48]");
      const { contacts, own } = loadContacts();
      const recipient = assertRecipient(resolveContact(name, contacts), {
        agent: loadAccount({ required: false })?.address ?? AGENT_ADDRESS,
        own,
        blocked: BLOCKED_RECIPIENTS,
      });
      const existing = loadRequests();
      // Avoid the amounts of active "Get paid" registrations in this corridor: a deposit matching both is never paid.
      let reserved = [];
      try {
        const now = Math.floor(Date.now() / 1000);
        const regs = await discoverRegistrations({ agent: agentAddress(), sinceSec: now - (MAX_REG_HOURS + 24) * 3600 });
        const st = registrationStatuses(regs, now);
        // every link the payer pays in the same token counts (all usdt-<currency> links are paid in USD₮)
        reserved = regs.filter((r) => st.get(r.hash) === "active" && getCorridor(r.req.d).sell === c.sell).map((r) => r.req.a);
      } catch (e) {
        console.warn(`Could not check "Get paid" registrations (${e.message}). If one uses the same amount, a matching deposit is held back, not paid.`);
      }
      const req = createRequest({
        name, amount: flag("amount"), corridor: c.id, note: flag("note"), hours: flag("hours") ?? 48, existing, reserved,
        // usdt-cngn: the amount is USD, so the cents suffix must keep it within the per-payout cap.
        maxUnits: c.usd === "sell" ? parseUnits(MAX_USD, 6) : undefined,
      });
      if (c.usd === "buy") {
        // cngn-usdt: the USD value is what the naira buys. Refuse links the autopilot would not be allowed to pay.
        const pv = await preview(c.sellToken.address, c.buyToken.address, parseUnits(req.amount, 6).toString());
        if (pv.status !== "preview") throw new Error(`No indicative price right now (${pv.status}); try again shortly.`);
        if (BigInt(pv.buyAmount) > parseUnits(MAX_USD, 6)) {
          throw new Error(`₦${req.amount} is worth ~${formatUnits(BigInt(pv.buyAmount), 6)} USD, over the per-payout cap of ${MAX_USD} USD. Use a smaller amount.`);
        }
        console.log(`At today's indicative rate ${req.name} would receive ~${formatUnits(BigInt(pv.buyAmount), 6)} USDT.`);
      }
      existing.push({ ...req, recipient });
      saveRequests(existing);
      console.log(`Request ${req.id} for ${req.name} (${c.blurb}: they receive ${receiveWord(c)}), expires ${new Date(req.exp).toISOString()}.`);
      console.log(`The payer must send EXACTLY ${req.amount} ${c.sellToken.symbol} on Celo to ${loadAccount({ required: false })?.address ?? AGENT_ADDRESS}.`);
      console.log(`Link: ${requestLink(req)}`);
      console.log(`Run "node src/agent.mjs watch --execute" to pay it automatically when the deposit arrives.`);
      break;
    }
    case "requests": {
      const list = loadRequests();
      if (!list.length) { console.log('No payment requests yet. Create one with: node src/agent.mjs request --to NAME --amount N'); break; }
      for (const r of list) {
        const st = requestStatus(r);
        const sym = getCorridor(r.dir).sellToken.symbol;
        console.log(`${r.id}  ${st.padEnd(8)}  ${r.amount} ${sym}  ${r.dir}  ${r.name}  expires ${new Date(r.exp).toISOString()}`);
        if (r.note) console.log(`    note: ${r.note}`);
        if (r.deposit) console.log(`    deposit: ${r.deposit.tx} from ${r.deposit.payer}`);
        if (r.receiptNo) console.log(`    receipt ${r.receiptNo}: ${receiptNoLink(r.receiptNo)}`);
        else if (r.receiptUrl) console.log(`    receipt: ${r.receiptUrl}`);
        if (r.error) console.log(`    error: ${r.error} (not retried automatically${retryBlocker(r) ? "" : `; retry with: node src/agent.mjs retry --request ${r.id}`})`);
        console.log(`    link: ${requestLink(r)}`);
      }
      break;
    }
    case "retry": {
      // Re-run the payout of a request ("Get paid" registration, nTag payment) whose deposit is recorded but whose payout
      // failed before any swap/payout tx.
      // --force-refused (nTag payments only): pay a deposit autopilot REFUSED (e.g. over a cap at the time), by hand.
      // Same flow: dry run unless --execute, the claim is re-checked onchain, and every cap applies again.
      const kind = flag("ntag") != null ? "ntag" : flag("registration") != null ? "registration" : "request";
      const id = flag("ntag") ?? flag("registration") ?? flag("request");
      if (!id) throw new Error("Usage: retry --request ID | --registration HASH | --ntag TX:LOGINDEX [--force-refused] [--execute] [--yes]");
      const what = kind === "ntag" ? "Lokal tag payment" : kind;
      const isReg = kind !== "request";
      const force = has("force-refused");
      if (force && kind !== "ntag") throw new Error("--force-refused is only for Lokal tag payments (retry --ntag TX:LOGINDEX --force-refused).");
      const r = target(kind, id);
      if (!r) throw new Error(`No ${what} with that id.`);
      const refused = kind === "ntag" && r.status === "refused";
      if (refused && !force) {
        throw new Error(
          `${what} ${r.id} was refused by autopilot (${r.reason}) and is not paid automatically. To pay it anyway, run ` +
          `"node src/agent.mjs retry --ntag ${r.id} --force-refused" (dry run; add --execute to pay). All caps still apply.`,
        );
      }
      if (force && !refused) throw new Error(`${what} ${r.id} was not refused by autopilot; retry it without --force-refused.`);
      const blocker = force ? refusedRetryBlocker(r) : retryBlocker(r);
      if (blocker) throw new Error(blocker);
      const depositKey = r.deposit?.tx != null && r.deposit?.logIndex != null ? `${r.deposit.tx}:${r.deposit.logIndex}` : kind === "ntag" ? r.id : null;
      assertNotRefunded(depositKey);
      if (force) {
        // The tag's claim must still check out onchain and still belong to the wallet recorded at refusal time.
        const agent = agentAddress();
        const op = (await discoverNtagOps({ agent })).find((o) => o.hash.toLowerCase() === String(r.claim).toLowerCase());
        if (!op) throw new Error(`The claim ${r.claim} for @${r.tag} was not found. Nothing was sent.`);
        const { from } = await verifyNtagOpOnchain(readClient(), op, agent);
        if (from.toLowerCase() !== String(r.from).toLowerCase()) throw new Error(`The claim for @${r.tag} now points at ${from}, not ${r.from}. Nothing was sent.`);
      }
      const execute = has("execute");
      const sym = getCorridor(r.dir).sellToken.symbol;
      console.log(`Retry ${what} ${r.id}: ${r.amount} ${sym} deposited by ${r.deposit.payer} (tx ${r.deposit.tx}) -> pay ${r.name}${isReg ? ` (${r.from})` : ""} via ${r.dir}.`);
      console.log(force ? `Refused by autopilot: ${r.reason}. Paying it anyway because of --force-refused; every cap still applies.` : `Last error: ${r.error}`);
      const args = kind === "ntag"
        ? { to: r.name, amount: r.amount, corridor: r.dir, recipientAddress: r.from, payer: r.deposit.payer, ntag: r.tag }
        : kind === "registration"
          ? { to: r.name, amount: r.amount, corridor: r.dir, recipientAddress: r.from, payer: r.deposit.payer, registrationId: r.hash }
          : { to: r.name, amount: r.amount, corridor: r.dir, requestId: r.id };
      if (!execute) { await pay({ ...args, execute: false }); break; }

      const { amountStr, pv, c } = await preflight({ ...args, agent: loadAccount().address });
      console.log(`Preview: ${amountStr} ${c.sellToken.symbol} -> ~${formatUnits(BigInt(pv.buyAmount), 6)} ${c.buyToken.symbol} for ${r.name}.`);
      if (!has("yes") && !(await confirm(`About to pay ${what} ${r.id} for real on Celo MAINNET.`))) { console.log("Cancelled. Nothing was sent."); break; }
      // Mark the retry BEFORE sending (like watch records the deposit first): a crash mid-flow can never lead to a second retry.
      const again = (force ? refusedRetryBlocker : retryBlocker)(target(kind, id));
      if (again) throw new Error(again);
      assertNotRefunded(depositKey);
      updateTarget(kind, id, (m) => { m.retrying = new Date().toISOString(); });
      let res;
      try {
        res = await pay({ ...args, execute: true, yes: true });
      } catch (e) {
        updateTarget(kind, id, (f) => {
          f.error = e.message;
          if (e.hashes) f.hashes = e.hashes;
          delete f.retrying;
        });
        throw new Error(`Retry of ${id} failed: ${e.message}. The error is saved on the ${what}.`);
      }
      updateTarget(kind, id, (done) => {
        Object.assign(done, { paidAt: new Date().toISOString(), hashes: res.hashes, receiptUrl: res.receiptUrl, receiptNo: res.receiptNo, paid: res.paid });
        if (force) { done.forcedAfterRefusal = done.reason; delete done.status; }
        delete done.error;
        delete done.retrying;
      });
      console.log(`${what[0].toUpperCase()}${what.slice(1)} ${id} is paid.`);
      await reportAfterPayout([retryPaidEvent(kind, target(kind, id), res, readReceipts())]);
      break;
    }
    case "registrations": {
      // "Get paid" registrations sent to the agent (Blockscout, all pages), with the same status rule as the site,
      // plus what autopilot did locally (registrations-state.json).
      const regs = await discoverRegistrations({ agent: agentAddress() });
      if (!regs.length) { console.log('No "Get paid" registrations yet. Recipients create one at site/get-paid.html.'); break; }
      const now = Math.floor(Date.now() / 1000);
      const st = registrationStatuses(regs, now);
      const local = loadRegState();
      for (const g of regs.slice().reverse()) {
        const rec = local[g.hash.toLowerCase()];
        const status = listStatus(g, st, rec);
        const req = g.req ?? {};
        let sym = "?";
        try { sym = getCorridor(req.d).sellToken.symbol; } catch { /* invalid corridor: shown as invalid */ }
        const exp = Number.isInteger(req.e) ? new Date(req.e * 1000).toISOString() : "?";
        console.log(`${g.hash}  ${status.padEnd(8)}  ${req.a ?? "?"} ${sym}  ${req.d ?? "?"}  ${String(req.n ?? "?").slice(0, 40)}  to ${g.from}  expires ${exp}`);
        if (req.m) console.log(`    note: ${String(req.m).slice(0, 80)}`);
        if (rec?.deposit) console.log(`    deposit: ${rec.deposit.tx} from ${rec.deposit.payer}`);
        for (const x of Object.values(rec?.refused ?? {})) console.log(`    refused deposit: ${x.tx} from ${x.payer} (${x.reason}); not paid`);
        if (rec?.receiptNo) console.log(`    receipt ${rec.receiptNo}: ${receiptNoLink(rec.receiptNo)}`);
        if (rec?.error) console.log(`    error: ${rec.error} (not retried automatically${retryBlocker(rec) ? "" : `; retry with: node src/agent.mjs retry --registration ${g.hash}`})`);
        console.log(`    link: ${registrationLink(g.hash)}`);
      }
      break;
    }
    case "ntag": {
      // Read-only lookup (Blockscout + RPC); needs no key.
      const q = positional()[0];
      if (!q) throw new Error("Usage: ntag <@tag | 0x address>");
      const ops = await discoverNtagOps({ agent: agentAddress() });
      const now = nowSec();
      const state = resolveNtags(ops, now);
      let tag;
      if (isAddress(q)) {
        tag = ntagOf(state, q);
        if (!tag) { console.log(`${q} holds no Lokal tag right now.`); break; }
      } else {
        tag = normalizeNtag(q);
      }
      const status = ntagAvailability(state, tag, undefined, now);
      const words = {
        taken: "held", free: "free to claim", reserved: "reserved (nobody can claim it)", locked: "locked after a release", invalid: "not a valid tag",
      };
      console.log(`@${tag}  ${words[status] ?? status}`);
      if (status === "invalid") console.log(`  rule: ${ntagError(tag)}`);
      const lock = state.locks.get(tag);
      if (status === "locked") console.log(`  only ${lock.owner} can claim it until ${iso(lock.until)}`);
      const entry = ownerOf(state, tag);
      if (!entry) break;
      console.log(`  owner: ${entry.owner}${entry.name ? `  name: ${entry.name}` : ""}`);
      const pref = currencyOf(entry.currency ?? "cngn");
      console.log(`  prefers: ${pref.flag} ${pref.label} (${pref.token})${entry.currency ? "" : ", the default"}`);
      console.log(`  since: ${iso(entry.since)}`);
      console.log(`  claim: https://celoscan.io/tx/${entry.hash}`);
      try {
        await verifyNtagOpOnchain(readClient(), ops.find((o) => o.hash === entry.hash), agentAddress());
        console.log("  claim checks out onchain: yes");
      } catch (e) {
        console.log(`  claim checks out onchain: ${e.permanent ? `no (${e.message})` : `could not check right now (${e.shortMessage ?? e.message})`}`);
      }
      const mine = Object.values(loadNtagPayments()).filter((p) => p.tag === tag);
      if (mine.length) console.log(`  payments seen by this agent: ${mine.length} (${mine.filter((p) => p.paidAt).length} paid, ${mine.filter((p) => p.status === "refused").length} refused)`);
      console.log(`  pay link: ${tagLink(tag)}`);
      break;
    }
    case "ntags": {
      // Every tag held right now (Blockscout, all pages, same resolver as the site).
      const ops = await discoverNtagOps({ agent: agentAddress() });
      const { tags } = resolveNtags(ops, nowSec());
      if (!tags.size) { console.log("No Lokal tags yet. Claim one at site/account.html."); break; }
      const list = [...tags].sort((a, b) => a[1].since - b[1].since);
      for (const [tag, e] of list) {
        console.log(`@${tag.padEnd(20)}  ${e.owner}  since ${iso(e.since).slice(0, 10)}  ${(e.currency ?? "cngn").padEnd(4)}${e.name ? `  ${e.name}` : ""}`);
      }
      console.log(`${list.length} Lokal tag(s).`);
      break;
    }
    case "ntag-data": {
      // What a payer sends from THEIR OWN wallet to pay a tag: an ERC-20 transfer to the agent with the tag memo appended.
      // Prints calldata only; never loads a key and never sends anything.
      const usage = "ntag-data @tag <amount> [--token usdt|cngn] [--to-currency naira|rupiah|argentina-peso|colombia-peso]";
      const [p0, p1] = positional();
      const tag = tagArg(p0, usage);
      const amountIn = flag("amount") ?? p1;
      if (!amountIn) throw new Error(`Usage: ${usage}`);
      const tok = String(flag("token") ?? "usdt").trim().toLowerCase();
      if (tok !== "usdt" && tok !== "cngn") throw new Error("--token must be usdt or cngn.");
      const token = tok === "cngn" ? TOKENS.CNGN : TOKENS.USDT;
      if (tok === "cngn" && flag("to-currency") != null) throw new Error("--to-currency is for USDT payments (a cNGN payment pays out in dollars).");
      const currency = flag("to-currency") != null ? parseCurrency(flag("to-currency")) : null;
      const corridor0 = tok === "cngn" ? "cngn-usdt" : corridorFor(currency ?? "cngn"); // limits only: same for every usdt-*
      const amount = parseAmount(amountIn);
      const units = parseUnits(amount, 6);
      if (units < parseUnits(NTAG_MIN[corridor0], 6)) {
        throw new Error(tok === "usdt"
          ? `The smallest Lokal tag payment is ${NTAG_MIN[corridor0]} USDT; smaller deposits are not paid.`
          : `The smallest Lokal tag payment is about ${NTAG_MIN_USD} USD of cNGN (and never under ${NTAG_MIN[corridor0]} cNGN); smaller deposits are not paid.`);
      }
      if (tok === "usdt" && units > parseUnits(MAX_USD, 6)) throw new Error(`The largest Lokal tag payment is ${MAX_USD} USDT (per-payout cap); larger deposits are not paid automatically.`);
      const { entry } = await resolveOwner(tag);
      const code = tok === "cngn" ? null : currency ?? entry.currency ?? "cngn"; // default: the tag's preference, else naira
      const corridor = tok === "cngn" ? "cngn-usdt" : corridorFor(code);
      await ntagUsdFloor(corridor, units); // cNGN: refuse amounts worth under the minimum at today's price
      if (tok === "cngn") {
        // Stay 3% under the per-payout cap: autopilot values cNGN with a fresh quote when it pays, and a deposit that
        // lands over the cap after a price move is refused (it stays with the agent for review).
        const pv = await preview(TOKENS.CNGN.address, TOKENS.USDT.address, units.toString());
        if (pv.status !== "preview") throw new Error(`No indicative price right now (${pv.status}), so the ${MAX_USD} USD cap can't be checked. Try again shortly.`);
        const max = (parseUnits(MAX_USD, 6) * 97n) / 100n;
        if (BigInt(pv.buyAmount) > max) {
          throw new Error(`${amount} cNGN is worth about ${formatUnits(BigInt(pv.buyAmount), 6)} USD. In cNGN send up to about ${formatUnits(max, 6)} USD in naira, so it stays under the agent's ${MAX_USD} USD limit after price moves.`);
        }
      }
      const agent = agentAddress();
      const data = encodeNtagTransfer(agent, units, tag, code ?? undefined);
      const back = decodeNtagPayment(data);
      if (back?.tag !== tag || (back.currency ?? "cngn") !== (code ?? "cngn")) throw new Error("Internal check failed: the memo does not decode. Nothing to send.");
      console.log(`Pay @${tag} (${entry.owner}${entry.name ? `, ${entry.name}` : ""}): ${amount} ${token.symbol}, they get ${receiveWord(getCorridor(corridor))}.`);
      console.log(`Send this from your own wallet on Celo mainnet (chain id 42220):`);
      console.log(`  to:    ${token.address}   (the ${token.symbol} token contract)`);
      console.log(`  value: 0`);
      console.log(`  data:  ${data}`);
      console.log(`The data is a normal transfer of ${amount} ${token.symbol} to the agent ${agent}, with "NTP:${tag}${code && code !== "cngn" ? ":" + code : ""}" appended.`);
      console.log(`The agent pays @${tag} when autopilot runs. Limits: ${MAX_USD} USD per payment, ${MAX_WALLET_DAILY_USD} USD per person per day, ${MAX_DAILY_USD} USD per day overall.`);
      console.log("Nothing was sent. This command never asks for a key.");
      break;
    }
    case "status-sync": {
      // Sends what is waiting in the status outbox to the site's /api/status. --backfill first queues an event for every
      // saved record (requests.json, registrations-state.json, ntag-payments.json, receipts.jsonl) from the last 30 days.
      const rep = makeStatusReporter({ say: (m) => console.log(m) });
      if (!rep.enabled) { process.exitCode = 1; break; }
      console.log(`Status server: ${STATUS_URL}`);
      const check = await rep.ping();
      if (!check.ok) {
        console.log(`The status server did not accept a signed check (${check.error}). Nothing was sent; queued reports stay in ${STATUS_OUTBOX_FILE}.`);
        process.exitCode = 1;
        break;
      }
      console.log("Signed check accepted (the secret and this PC's clock are fine).");
      if (has("backfill")) {
        const events = eventsFromRecords({
          requests: loadRequests(), registrations: loadRegState(), ntagPayments: { ...loadNtagPayments(), ...loadContractDeposits() }, receipts: readReceipts(),
          agent: agentAddress(), sinceMs: Date.now() - 30 * 86_400_000,
        });
        console.log(`Queued ${rep.report(events)} report(s) from the saved records of the last 30 days.`);
      } else {
        // like autopilot on start: anything from the last 48 h the server hasn't confirmed yet
        const n = rep.syncRecords({ requests: loadRequests(), registrations: loadRegState(), ntagPayments: { ...loadNtagPayments(), ...loadContractDeposits() }, receipts: readReceipts() }, { agent: agentAddress() });
        if (n) console.log(`Queued ${n} report(s) from the last 48 hours that the server hadn't confirmed.`);
      }
      const r = await rep.flush();
      if (r.left) console.log(`Sent ${r.sent}; ${r.left} still waiting (${r.error}). They are sent the next time autopilot runs or you run status-sync.`);
      else console.log(r.sent ? `Sent ${r.sent} report(s). Nothing is waiting.` : "Nothing was waiting to be sent.");
      await rep.close({ waitMs: 0 });
      break;
    }
    case "watch":
      try {
        await watch({
          execute: has("execute"), interval: flag("interval") ?? 15, autoRefund: has("auto-refund"), clearStaleLock: has("clear-stale-lock"),
        });
      } catch (e) {
        if (!e?.printed) throw e;
        process.exitCode = 1; // autopilot already printed what happened and how to restart, as its last line
      }
      break;
    case "refunds": {
      // Refundable deposits (refused, unmatched incl. expired or used links, ambiguous) and every refund so far.
      const records = { requests: loadRequests(), registrations: loadRegState(), ntagPayments: { ...loadNtagPayments(), ...loadContractDeposits() }, receipts: readReceipts() };
      const rows = refundRows(records, loadRefunds());
      if (!rows.length) { console.log("Nothing to refund: autopilot has no refused, unmatched or ambiguous deposits on record."); break; }
      for (const r of rows) {
        console.log(`${r.key}  ${String(r.status).padEnd(19)}  ${r.amount ?? "?"} ${r.token ?? "?"}  from ${r.payer ?? "?"}  ${age(r.at)} ago`);
        console.log(`    ${r.category ?? "?"}: ${String(r.reason ?? "").slice(0, 120)}`);
        if (r.refundTx) console.log(`    refund ${r.refundNo ?? ""}: https://celoscan.io/tx/${r.refundTx}`);
        if (r.error) console.log(`    error: ${r.error}`);
        if (r.key.endsWith(":?")) console.log("    (an older record without its log index: find it on Celoscan, then refund --deposit <tx>:<logIndex>)");
        else if (r.status === "refundable") console.log(`    refund (dry run): node src/agent.mjs refund --deposit ${r.key}`);
        else if (r.status === "failed") console.log(`    retry (searches the chain first): node src/agent.mjs refund --deposit ${r.key} --retry --execute`);
      }
      const n = rows.filter((r) => r.status === "refundable").length;
      console.log(`${rows.length} deposit(s); ${n} refundable now.`);
      break;
    }
    case "refund": {
      // Sends one deposit back to its sender (same token, same amount). Dry run unless --execute. docs/REFUNDS.md
      const input = flag("deposit") ?? positional()[0];
      if (!input) throw new Error("Usage: refund --deposit <tx>:<logIndex> [--execute] [--yes] [--retry]   (see: node src/agent.mjs refunds)");
      const execute = has("execute");
      const account = execute ? loadAccount() : null;
      const agent = account?.address ?? agentAddress();
      const deps = {
        pub: readClient(), agent, own: loadContacts().own, contracts: BLOCKED_RECIPIENTS, preview, verifyTx, attributionCode: ATTRIBUTION_CODE,
        wallet: execute ? makeClients(account).wallet : null, // the attribution-tagged wallet client (src/chain.mjs)
        loadRecords: () => ({
          requests: loadRequests(), registrations: loadRegState(), ntagPayments: { ...loadNtagPayments(), ...loadContractDeposits() }, receipts: readReceipts(), refunds: loadRefunds(),
        }),
        loadRefunds, saveRefunds, log, now: () => Date.now(), say: (m) => console.log(m), confirm,
        lock: () => takeLock("refund --execute"),
        report: reportRefund,
        alert: (kind, text) => { try { (alerter ??= makeAlerter({ say: (m) => console.log(m) })).alert(kind, text); } catch { /* best effort */ } },
      };
      let alerter = null;
      try {
        await refundDeposit(input, deps, { execute, yes: has("yes"), retry: has("retry") });
      } finally {
        await alerter?.close({ waitMs: 5_000 }).catch(() => {});
      }
      break;
    }
    case "alert-test": {
      const a = makeAlerter({ say: (m) => console.log(m) });
      if (!a.enabled) {
        console.log("Alerts are off. Set ALERT_TELEGRAM_TOKEN + ALERT_TELEGRAM_CHAT_ID and/or ALERT_WEBHOOK_URL (see .env.example).");
        process.exitCode = 1;
        break;
      }
      const r = await a.sendNow("test", `Test alert from the agent ${agentAddress()}. If you can read this, alerts work.`);
      console.log(r.ok ? `Sent a test alert via ${a.channels.join(" and ")}.` : `The test alert was not sent (${r.error}); it stays queued and is retried by autopilot.`);
      if (!r.ok) process.exitCode = 1;
      await a.close({ waitMs: 0 });
      break;
    }
    case "doctor": {
      const results = await runDoctor();
      for (const r of results) console.log(`${r.level.padEnd(4)}  ${r.name}: ${r.detail}`);
      const fails = results.filter((r) => r.level === "FAIL").length;
      const warns = results.filter((r) => r.level === "WARN").length;
      console.log(`${results.length} checks: ${results.length - fails - warns} pass, ${warns} warn, ${fails} fail.`);
      if (fails) process.exitCode = 1;
      break;
    }
    case "register":
      if (has("update")) await updateCard({ repoUrl: flag("repo") ?? "https://github.com/deeeko/lokal", agentId: Number(flag("agent-id") ?? 10079), execute: has("execute") });
      else await register({ repoUrl: flag("repo") ?? "https://github.com/deeeko/lokal", execute: has("execute") });
      break;
    case "verify": {
      const hash = rest[0];
      if (!/^0x[0-9a-fA-F]{64}$/.test(hash ?? "")) throw new Error("Usage: verify <0x transaction hash>");
      const { pub } = makeClients(loadAccount());
      console.log(JSON.stringify(await verifyTx({ client: pub, hash }), null, 2));
      break;
    }
    default:
      console.log("Lokal agent. Commands: keygen | status | quote | pay | ask | request | requests | registrations | ntag | ntags | ntag-data | watch | retry | refunds | refund | status-sync | alert-test | doctor | register | verify  (see README)");
      console.log("  Refunds: refunds (what can be refunded) · refund --deposit TX:LOGINDEX [--execute] [--yes] [--retry] · watch --execute --auto-refund");
      console.log("    A refund sends a refused, unmatched or ambiguous deposit back to its sender, same token and amount (docs/REFUNDS.md).");
      console.log("  One agent at a time: watch --execute and pay/ask/retry/register/refund --execute take agent.lock; after a crash add --clear-stale-lock.");
      console.log("  Alerts: set ALERT_TELEGRAM_TOKEN + ALERT_TELEGRAM_CHAT_ID and/or ALERT_WEBHOOK_URL; alert-test sends a test message.");
      console.log("  Lokal tags: ntag <@tag|address> · ntags · pay @tag <amount> [--to-currency X] [--execute] · ntag-data @tag <amount> [--token usdt|cngn] [--to-currency X] · retry --ntag TX:LOGINDEX [--force-refused]");
      console.log("  Currencies (--to-currency): naira (cngn) · rupiah (idrx) · argentina-peso (wars) · colombia-peso (wcop). quote --all shows them side by side.");
      console.log("  In PowerShell quote the tag ('@ada') or leave out the @ (ntag ada, pay --ntag ada --amount 5).");
      console.log("  Status server: autopilot (watch --execute) reports each deposit's status (paid, refused, received) and the day's");
      console.log("    totals to the site's /api/status, so pay pages show exact facts instead of estimates from Celo. Set up once:");
      console.log("    put the shared secret in NP_STATUS_SECRET or in the file status-secret next to the agent key (the same value");
      console.log("    as the site's NP_STATUS_SECRET). Reports wait in status-outbox.jsonl and are sent in the background; they never");
      console.log("    block or change a payout. status-sync sends what is waiting; status-sync --backfill re-sends every saved record.");
      process.exitCode = cmd ? 1 : 0;
  }
}

await main().catch((e) => { console.error(`error: ${e.message}`); process.exitCode = 1; });
