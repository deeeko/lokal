// Pass-through payouts for contract payments that need no conversion: the payer paid in the very token the recipient
// receives (USD₮ to a pot host with no preference, cNGN to someone who receives naira, ...). No swap, so no quote: the
// agent sends exactly the amount the contract delivered, after the same recipient checks and caps as every payout
// (not the payer, agent, own wallets, token/registry contracts or zero; per-payout, per-wallet and rolling daily caps),
// with the attribution tag on the transfer, and logs it to receipts.jsonl (so the daily caps count it).
// Dry-run unless execute=true; autopilot passes yes=true (there is no prompt here).
import { erc20Abi, formatUnits } from "viem";
import { verifyTx } from "@celo/attribution-tags";
import { AGENT_ADDRESS, ATTRIBUTION_CODE, TOKENS } from "./config.mjs";
import { loadAccount, makeClients } from "./chain.mjs";
import { refusal } from "./guards.mjs";
import { balanceOf, loadContacts, log, registrationCaps, registrationRecipient } from "./pay.mjs";
import { receiptLink, receiptNo, receiptNoLink } from "./requests.mjs";

/** The TOKENS entry for a token address, or null. */
export const tokenByAddress = (addr) => Object.values(TOKENS).find((t) => t.address.toLowerCase() === String(addr ?? "").toLowerCase()) ?? null;

function ownWallets() {
  try { return loadContacts().own; } catch (e) {
    throw new Error(`Contract payouts need contacts.json for the own_wallets blocklist (contacts may be empty): ${e.message}`);
  }
}

/**
 * The checks that send nothing: a known token, the recipient rules (permanent refusals) and the caps on `usdUnits`
 * (the payment's value in 6-decimal USD). Returns { token, recipient }.
 */
export function forwardPreflight({ token, units, recipientAddress, payer, usdUnits, agent }) {
  const t = tokenByAddress(token);
  if (!t) throw refusal(`token not accepted for a pass-through payout (${token}). Not paid.`);
  if (BigInt(units) <= 0n) throw refusal("Nothing to pay out (zero amount). Not paid.");
  const recipient = registrationRecipient(recipientAddress, { agent: agent ?? AGENT_ADDRESS, payer, own: ownWallets() });
  registrationCaps(BigInt(usdUnits), recipient);
  return { token: t, recipient };
}

/**
 * Pays `units` of `token` to `recipientAddress` as they are. Returns the same shape as pay(): { hashes, tags, untagged,
 * receiptUrl, receiptNo, paid, paidToken, usd }. `to` is a display name ("@ada", "pot #3 (@ada)"); `ntag` is logged.
 */
export async function forward({ to, token, units, recipientAddress, payer, usdUnits, execute = false, yes = false, ntag, source } = {}) {
  const account = loadAccount({ required: execute });
  const agent = account?.address ?? AGENT_ADDRESS;
  const { token: t, recipient } = forwardPreflight({ token, units, recipientAddress, payer, usdUnits, agent });
  const amount = formatUnits(BigInt(units), t.decimals);
  console.log(`Pass-through [${t.symbol}]: ${amount} ${t.symbol} to ${to} (${recipient}), worth about ${formatUnits(BigInt(usdUnits), 6)} USD. No conversion needed.`);
  if (!execute) {
    console.log("DRY RUN: nothing was sent. Add --execute to run this for real.");
    return { dryRun: true, paid: amount, paidToken: t.symbol };
  }
  if (!yes) throw new Error("A pass-through payout runs only from autopilot (yes=true).");
  const { pub, wallet } = makeClients(account);
  const d = await pub.readContract({ address: t.address, abi: erc20Abi, functionName: "decimals" });
  if (Number(d) !== t.decimals) throw new Error(`${t.symbol} reports ${d} decimals, expected ${t.decimals}. Aborting.`);
  const [bal, celoBal] = await Promise.all([balanceOf(pub, t.address, account.address), pub.getBalance({ address: account.address })]);
  if (bal < BigInt(units)) throw new Error(`Agent wallet holds ${formatUnits(bal, t.decimals)} ${t.symbol}, needs ${amount}.`);
  if (celoBal < 10n ** 16n) throw new Error("Agent wallet needs ~0.01 CELO for gas.");
  const hashes = {};
  try {
    hashes.payout = await wallet.writeContract({ address: t.address, abi: erc20Abi, functionName: "transfer", args: [recipient, BigInt(units)] });
    const pr = await pub.waitForTransactionReceipt({ hash: hashes.payout });
    if (pr.status !== "success") throw new Error(`Payout reverted (${hashes.payout}).`);
  } catch (e) {
    if (hashes.payout && e && typeof e === "object") e.hashes = { ...hashes };
    throw e;
  }
  const tags = { payout: (await verifyTx({ client: pub, hash: hashes.payout }))?.codes ?? null };
  const untagged = tags.payout?.includes(ATTRIBUTION_CODE) ? [] : ["payout"];
  const no = receiptNo(hashes.payout);
  const receiptUrl = receiptLink({ payout: hashes.payout });
  const usd = formatUnits(BigInt(usdUnits), 6);
  log({
    corridor: `forward-${t.symbol.toLowerCase()}`, to, recipient, ...(ntag ? { ntag } : {}), payer, ...(source ? { source } : {}), receiptNo: no,
    sold: { token: t.symbol, amount: "0" }, paid: { token: t.symbol, amount }, usd, hashes, tags, untagged, receiptUrl,
  });
  console.log(`Paid ${amount} ${t.symbol} to ${to}. Receipt ${no}: ${receiptNoLink(no)}`);
  return { hashes, tags, untagged, receiptUrl, receiptNo: no, receiptNoUrl: receiptNoLink(no), paid: amount, paidToken: t.symbol, usd };
}
