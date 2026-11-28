// The payout flow, for every corridor (one flow, any configured local token):
//   preview -> firm quote -> approve SELL token -> swap -> pay out the BUY token to the recipient.
//   usdt-cngn (default): sell USDT, pay cNGN.   usdt-idrx / usdt-wars / usdt-wcop: sell USDT, pay IDRX / wARS / wCOP.
//   cngn-usdt: sell cNGN, pay USDT.   idrx-usdt / wars-usdt / wcop-usdt: sell IDRX / wARS / wCOP, pay USDT.
// Every amount is read and written with its own token's decimals (USDT 6, cNGN 6, IDRX 2, wARS 18, wCOP 18); the USD
// values the caps use are always 6-decimal USDT units. A local currency Textile isn't quoting is refused with the code
// currency_unavailable: the payment is never paid in another currency.
// Dry-run by default. Real money moves only with execute=true AND an explicit confirmation (or yes=true,
// which only the CLI flag --yes and the watch --execute autopilot set).
import fs from "node:fs";
import readline from "node:readline/promises";
import { erc20Abi, formatUnits, parseEventLogs, parseUnits } from "viem";
import { verifyTx } from "@celo/attribution-tags";
import {
  AGENT_ADDRESS, ATTRIBUTION_CODE, CELO_TOKEN, CONTACTS_FILE, IDENTITY_REGISTRY, LOG_FILE, MAX_DAILY_USD, MAX_SLIPPAGE_BPS, MAX_USD,
  MAX_WALLET_DAILY_USD, REPUTATION_REGISTRY, TOKENS,
} from "./config.mjs";
import { loadAccount, makeClients } from "./chain.mjs";
import {
  assertDailyCap, assertNotSelfPayment, assertRecipient, assertSlippage, assertWalletCap, assertWithinCap, dailyUsedUnits,
  getCorridor, getPayoutCorridor, measuredReceived, notQuoting, parseAmount, parseContacts, refusal, resolveContact, walletUsedUnits,
} from "./guards.mjs";
import { receiptLink, receiptNo, receiptNoLink } from "./requests.mjs";
import { firmQuote, preview, submit } from "./textile.mjs";
import { currencyOf, formatCurrencyUnits } from "./currencies.mjs";

export function loadContacts() {
  // Read the env at call time too, so tests can point at a temporary file without touching the real one.
  const file = process.env.CONTACTS_FILE ?? CONTACTS_FILE;
  if (!fs.existsSync(file)) {
    throw new Error(`No contacts file. Copy docs/examples/contacts.example.json to contacts.json and add your recipient.`);
  }
  return parseContacts(JSON.parse(fs.readFileSync(file, "utf8")));
}

/** All entries in receipts.jsonl (bad lines are skipped). */
export function readReceipts(file = LOG_FILE) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => {
    try { return [JSON.parse(l)]; } catch { return []; }
  });
}

export const log = (entry) => fs.appendFileSync(LOG_FILE, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");

export async function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question} Type "yes" to continue: `)).trim().toLowerCase();
  rl.close();
  return answer === "yes";
}

/**
 * Everything pay() touches outside this file: the wallet, Textile, the attribution check, the prompt and the log.
 * Tests replace entries (a fake chain, fake quotes) and put them back afterwards; nothing else changes them.
 */
export const payDeps = { loadAccount, makeClients, preview, firmQuote, submit, verifyTx, confirm, log: (e) => log(e), balanceDeltaAtBlock: (...a) => balanceDeltaAtBlock(...a) };

/** USD values (the caps): always 6-decimal USDT units. */
const fmt = (units) => formatUnits(units, 6);
/** An amount of `token` (one of TOKENS) as a decimal string, exact, in that token's own decimals. */
export const fmtToken = (units, token) => formatUnits(BigInt(units), token.decimals);
export const balanceOf = (pub, token, owner, blockNumber) =>
  pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner], ...(blockNumber != null ? { blockNumber } : {}) });

/**
 * The balance change of `token` for `owner` across exactly one block (the swap's): the balance AT that block minus
 * the balance at the block before. Reading both at fixed blocks means a public RPC node that is a few blocks behind
 * can't make a delivered swap look like "nothing arrived" (a read of "latest" on a lagging node returns the old
 * balance). A node that hasn't reached the block yet errors; we wait and ask again, then give up loudly.
 */
export async function balanceDeltaAtBlock(pub, token, owner, block, { tries = 6, waitMs = 2000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const [before, after] = await Promise.all([balanceOf(pub, token, owner, block - 1n), balanceOf(pub, token, owner, block)]);
      return after - before;
    } catch (e) { last = e; if (i < tries - 1) await sleep(waitMs); }
  }
  throw new Error(`Couldn't read the balance at the swap's block ${block}: ${last?.shortMessage ?? last?.message ?? last}`);
}

/** Sum of the ERC-20 Transfer events of `token` to `owner` in a transaction's logs. */
export const transfersTo = (logs, token, owner) =>
  parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs })
    .filter((l) => l.address.toLowerCase() === token.toLowerCase() && l.args.to.toLowerCase() === owner.toLowerCase())
    .reduce((sum, l) => sum + l.args.value, 0n);

/**
 * USD value (6-dp units) used for the caps: USDT sold (usdt-cngn) or USDT bought (cngn-usdt).
 * `wallet` (registrations only): also enforce the per-recipient-wallet rolling 24 h cap.
 */
export function checkCaps(usdUnits, wallet) {
  assertWithinCap(fmt(usdUnits), MAX_USD);
  const entries = readReceipts();
  assertDailyCap(dailyUsedUnits(entries), usdUnits, MAX_DAILY_USD);
  if (wallet) assertWalletCap(walletUsedUnits(entries, wallet), usdUnits, MAX_WALLET_DAILY_USD);
}

/** Contracts that are never a payout recipient: every token contract (USDT, cNGN, IDRX, wARS, wCOP, CELO) and the ERC-8004 registries. */
export const BLOCKED_RECIPIENTS = [
  ...Object.values(TOKENS).map((t) => t.address), CELO_TOKEN.address, IDENTITY_REGISTRY, REPUTATION_REGISTRY,
];

/**
 * Recipient checks for a "Get paid" registration (a raw wallet address, not a contact): not the agent, not one of the
 * owner's own_wallets (contacts.json), not a token/registry contract or the zero address, and not the payer.
 * These are permanent refusals (retrying can never make them pass).
 */
export function registrationRecipient(address, { agent, payer, own = [] }) {
  let r;
  try {
    r = assertRecipient(address, { agent, own, blocked: BLOCKED_RECIPIENTS });
  } catch (e) {
    throw refusal(`${e.message}. Not paid.`);
  }
  assertNotSelfPayment(payer, r);
  return r;
}

function ownWallets() {
  try {
    return loadContacts().own;
  } catch (e) {
    throw new Error(`Get-paid payouts need contacts.json for the own_wallets blocklist (contacts may be empty): ${e.message}`);
  }
}

/**
 * The checks that need no wallet and send nothing: contact lookup + allow-list (contacts.json), both USD caps
 * (incl. the rolling daily cap) and a Textile preview for the amount. Throws on the first failure.
 * Used by pay() and by autopilot BEFORE it records a deposit on a request.
 */
export async function preflight({ to, amount, corridor = "usdt-cngn", agent, recipientAddress, payer } = {}) {
  if (recipientAddress != null) return preflightRegistration({ amount, corridor, agent, recipientAddress, payer });
  const c = getPayoutCorridor(corridor);
  const { contacts, own } = loadContacts();
  const amountStr = parseAmount(amount, c.sellToken.decimals);
  const sellAmount = parseUnits(amountStr, c.sellToken.decimals);
  // usdt-<currency>: the amount itself is the USD value, so check the caps before asking anyone for a price.
  if (c.usd === "sell") checkCaps(sellAmount);
  const recipient = assertRecipient(resolveContact(to, contacts), {
    agent,
    own,
    blocked: BLOCKED_RECIPIENTS,
  });
  const pv = await payDeps.preview(c.sellToken.address, c.buyToken.address, sellAmount.toString());
  if (pv.status !== "preview") throw notQuoting(c, pv.status, pv.reason);
  // cngn-usdt: the USD value is what we would buy; check it against the caps from the preview, and again on the firm quote.
  if (c.usd === "buy") checkCaps(BigInt(pv.buyAmount));
  return { c, amountStr, sellAmount, recipient, pv };
}

/**
 * Pre-flight for a "Get paid" registration: the recipient is the registration's sender (a raw address). Checks the
 * recipient (permanent refusals first), then the per-payout, rolling daily and per-wallet caps and a live preview.
 */
async function preflightRegistration({ amount, corridor, agent, recipientAddress, payer }) {
  const c = getPayoutCorridor(corridor);
  const amountStr = parseAmount(amount, c.sellToken.decimals);
  const sellAmount = parseUnits(amountStr, c.sellToken.decimals);
  const recipient = registrationRecipient(recipientAddress, { agent: agent ?? AGENT_ADDRESS, payer, own: ownWallets() });
  if (c.usd === "sell") registrationCaps(sellAmount, recipient);
  const pv = await payDeps.preview(c.sellToken.address, c.buyToken.address, sellAmount.toString());
  if (pv.status !== "preview") throw notQuoting(c, pv.status, pv.reason);
  if (c.usd === "buy") registrationCaps(BigInt(pv.buyAmount), recipient);
  return { c, amountStr, sellAmount, recipient, pv, wallet: recipient };
}

/**
 * Caps for a permissionless registration. One stranger's link must never halt autopilot for everyone, so the caps that
 * are about THAT payment (per-payout, per-recipient-wallet) are permanent refusals: logged, not paid, autopilot carries
 * on, and the owner can review it. Only the GLOBAL rolling daily cap still stops autopilot (it is the system-wide brake).
 */
export function registrationCaps(usdUnits, wallet) {
  try { assertWithinCap(fmt(usdUnits), MAX_USD); }
  catch (e) { throw refusal(`${e.message}. Not paid automatically; review it manually.`); }
  const entries = readReceipts();
  assertDailyCap(dailyUsedUnits(entries), usdUnits, MAX_DAILY_USD);
  try { assertWalletCap(walletUsedUnits(entries, wallet), usdUnits, MAX_WALLET_DAILY_USD); }
  catch (e) { throw refusal(`${e.message}. Not paid automatically; review it manually.`); }
}

/**
 * Owner payouts: `to` is a contact name in contacts.json. "Get paid" registrations: `recipientAddress` is the
 * registration's sender, `payer` the deposit's sender, `to` only a display name, `registrationId` the registration hash.
 * nTag payouts: like registrations, with `recipientAddress` the tag owner, `to` "@tag" and `ntag` the tag (logged).
 */
export async function pay({ to, amount, corridor = "usdt-cngn", execute = false, yes = false, requestId, recipientAddress, payer, registrationId, ntag } = {}) {
  if (String(corridor).trim().toLowerCase() === "celo-cngn") {
    // Direct owner payouts only: never from a payment request or a "Get paid" registration.
    if (requestId != null || recipientAddress != null) getCorridor("celo-cngn"); // throws the "direct payouts only" message
    const { payFromCelo } = await import("./celo.mjs");
    return payFromCelo({ to, amount, execute, yes });
  }
  const account = payDeps.loadAccount({ required: execute });
  const agent = account?.address ?? (recipientAddress != null ? AGENT_ADDRESS : undefined);
  const { c, amountStr, sellAmount, recipient, pv, wallet: capWallet } = await preflight({ to, amount, corridor, agent, recipientAddress, payer });
  const sell = c.sellToken;
  const buy = c.buyToken;
  console.log(
    `Preview [${c.id}]: ${amountStr} ${sell.symbol} -> ~${fmtToken(pv.buyAmount, buy)} ${buy.symbol}` +
    ` (fee ${pv.feeAmount} base units) for ${to} (${recipient})`,
  );

  if (c.currency) console.log(`  They get about ${formatCurrencyUnits(pv.buyAmount, c.currency)} (${currencyOf(c.currency).label}, ${buy.symbol}), before the firm quote.`);
  if (!execute) {
    console.log("DRY RUN: nothing was sent. Add --execute to run this for real.");
    return { dryRun: true, preview: pv, corridor: c.id, buyToken: buy.symbol, buyAmount: fmtToken(pv.buyAmount, buy) };
  }

  const { pub, wallet } = payDeps.makeClients(account);
  // Both tokens must really have the decimals the registry says (USDT 6, cNGN 6, IDRX 2, wARS 18, wCOP 18); every
  // amount above is read and written with them.
  for (const t of [sell, buy]) {
    const d = await pub.readContract({ address: t.address, abi: erc20Abi, functionName: "decimals" });
    if (Number(d) !== t.decimals) throw new Error(`${t.symbol} reports ${d} decimals, expected ${t.decimals}. Aborting.`);
  }
  const [sellBal, buyBefore, celoBal] = await Promise.all([
    balanceOf(pub, sell.address, account.address),
    balanceOf(pub, buy.address, account.address),
    pub.getBalance({ address: account.address }),
  ]);
  if (sellBal < sellAmount) throw new Error(`Agent wallet holds ${fmtToken(sellBal, sell)} ${sell.symbol}, needs ${amountStr}.`);
  if (celoBal < parseUnits("0.02", 18)) throw new Error("Agent wallet needs ~0.02 CELO for gas.");

  if (!yes && !(await payDeps.confirm(`About to convert ${amountStr} ${sell.symbol} to ${buy.symbol} and pay ${to} on Celo MAINNET.`))) {
    console.log("Cancelled. Nothing was sent.");
    return { cancelled: true };
  }

  const hashes = {};
  try {
    return await send();
  } catch (e) {
    // Hand any transactions already sent back to the caller, so a failed payout records what moved on chain.
    if (Object.keys(hashes).length && e && typeof e === "object") e.hashes = { ...hashes };
    throw e;
  }

  async function send() {
    // 1. Firm quote (signs a no-funds proof of wallet control only if Textile asks).
    let q;
    try {
      q = await payDeps.firmQuote(account, sell.address, buy.address, sellAmount.toString());
    } catch (e) {
      // Nothing was sent yet: a local currency that stopped quoting is refused (never paid in another currency).
      if (e?.noQuote) throw notQuoting(c, "no_quote", e.reason);
      throw e;
    }
    assertSlippage(pv.buyAmount, q.quote.buyAmount, MAX_SLIPPAGE_BPS);
    const takerPays = BigInt(q.quote.takerPays);
    if (takerPays > sellAmount) throw new Error("Quote asks for more than the amount requested. Aborting.");
    const quotedBuy = BigInt(q.quote.buyAmount);
    const usdUnits = c.usd === "sell" ? takerPays : quotedBuy;
    // Registration / nTag payouts (capWallet set): a per-payout or per-wallet cap that only the FIRM quote breaks (cNGN
    // near the $25 cap after a price move) is a permanent refusal, like in pre-flight: nothing has been sent yet, so
    // autopilot records it as refused and carries on. The global daily cap still stops it. Contact payouts: unchanged.
    if (c.usd === "buy") (capWallet ? registrationCaps : checkCaps)(quotedBuy, capWallet);
    const reactor = q.quote.reactor;
    console.log(`Firm quote: pay ${fmtToken(takerPays, sell)} ${sell.symbol}, receive ${fmtToken(quotedBuy, buy)} ${buy.symbol}`);

    // 2. Approve only what is needed, on the SELL token. USDT-style tokens reject nonzero -> nonzero approvals, so reset first.
    const allowance = await pub.readContract({
      address: sell.address, abi: erc20Abi, functionName: "allowance", args: [account.address, reactor],
    });
    if (allowance < takerPays) {
      if (allowance > 0n) {
        hashes.reset = await wallet.writeContract({ address: sell.address, abi: erc20Abi, functionName: "approve", args: [reactor, 0n] });
        const rr = await pub.waitForTransactionReceipt({ hash: hashes.reset });
        if (rr.status !== "success") throw new Error("Allowance reset reverted. Nothing was swapped.");
      }
      // Build the approval ourselves: exactly takerPays, to the quote's reactor, on the sell-token contract.
      // (Not Textile's prepared approval calldata, so the amount and spender are guaranteed here.)
      hashes.approval = await wallet.writeContract({ address: sell.address, abi: erc20Abi, functionName: "approve", args: [reactor, takerPays] });
      const ar = await pub.waitForTransactionReceipt({ hash: hashes.approval });
      if (ar.status !== "success") throw new Error("Approval reverted. Nothing was swapped.");
    }

    // 3. Swap. Re-check the clock first: an expired quote must not be sent.
    if (Date.now() >= Date.parse(q.quote.expiresAt)) throw new Error("Quote expired during approval. Run again for a fresh quote.");
    const s = q.transactions.swap; // always broadcast transactions.swap, never the top-level order
    hashes.swap = await wallet.sendTransaction({ to: s.to, data: s.data, value: BigInt(s.value) });
    const sr = await pub.waitForTransactionReceipt({ hash: hashes.swap });
    if (sr.status !== "success") throw new Error(`Swap reverted (${hashes.swap}).`);
    await payDeps.submit(q.rfqId, q.claimToken, hashes.swap).catch(() => {});

    // 4. Pay out exactly what the swap delivered: the measured balance change of the BUY token, never more than
    //    the swap's own Transfer events to the agent (so a deposit landing at the same moment is never paid on).
    // Read at the swap's own block (a lagging RPC node can't hide a delivered swap). A receipt always carries its
    // block number on a real chain; without one, fall back to "now minus before the swap".
    const delta = sr.blockNumber != null
      ? await payDeps.balanceDeltaAtBlock(pub, buy.address, account.address, BigInt(sr.blockNumber))
      : (await balanceOf(pub, buy.address, account.address)) - buyBefore;
    const received = measuredReceived(delta, transfersTo(sr.logs, buy.address, account.address));
    if (received <= 0n) throw new Error(`Swap succeeded but no ${buy.symbol} was received. Check ${hashes.swap}.`);
    if (c.usd === "buy") assertWithinCap(fmt(received), MAX_USD); // never pay out more dollars than the cap
    if (c.usd === "buy" && capWallet) checkCaps(received, capWallet); // nor more than the wallet's 24 h allowance
    hashes.payout = await wallet.writeContract({ address: buy.address, abi: erc20Abi, functionName: "transfer", args: [recipient, received] });
    const pr = await pub.waitForTransactionReceipt({ hash: hashes.payout });
    if (pr.status !== "success") throw new Error(`Payout reverted (${hashes.payout}).`);

    // 5. Prove every transaction (reset, approval, swap, payout) carries our attribution tag.
    const tags = {};
    for (const [k, h] of Object.entries(hashes)) tags[k] = (await payDeps.verifyTx({ client: pub, hash: h }))?.codes ?? null;
    const untagged = Object.keys(hashes).filter((k) => !tags[k]?.includes(ATTRIBUTION_CODE));
    const receiptUrl = receiptLink({ payout: hashes.payout, swap: hashes.swap, requestId });
    const no = receiptNo(hashes.payout);
    payDeps.log({
      corridor: c.id, to, recipient, requestId, ...(registrationId ? { registrationId, payer } : {}), ...(ntag ? { ntag, payer } : {}), receiptNo: no,
      sold: { token: sell.symbol, amount: fmtToken(takerPays, sell) },
      paid: { token: buy.symbol, amount: fmtToken(received, buy) },
      ...(c.currency ? { currency: c.currency } : {}),
      usd: fmt(usdUnits),
      ...(c.id === "usdt-cngn" ? { usdtSpent: fmt(takerPays), cngnPaid: fmt(received) } : {}),
      hashes, tags, untagged, receiptUrl, reactor, // reactor: refunds never send to it (src/refund.mjs)
    });
    console.log(`Paid ${fmtToken(received, buy)} ${buy.symbol} to ${to}.`);
    for (const [k, h] of Object.entries(hashes)) console.log(`  ${k}: https://celoscan.io/tx/${h}  tag=${JSON.stringify(tags[k])}`);
    console.log(`Receipt ${no}: ${receiptNoLink(no)}`);
    console.log(`  full receipt link: ${receiptUrl}`);
    if (untagged.length) {
      console.error(`WARNING: missing attribution tag ${ATTRIBUTION_CODE} on: ${untagged.join(", ")}. These will not be credited.`);
      process.exitCode = 1;
    }
    return {
      hashes, tags, untagged, receiptUrl, receiptNo: no, receiptNoUrl: receiptNoLink(no), paid: fmtToken(received, buy), paidToken: buy.symbol,
      usd: fmt(usdUnits),
    };
  }
}
