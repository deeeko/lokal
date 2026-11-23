// Settle a contract payment whose swap went through but whose payout was never sent (autopilot stopped on purpose,
// e.g. "Swap succeeded but no USDT was received" after a lagging RPC node). It never swaps again: it pays the
// recipient exactly what the recorded swap delivered to the agent, read from that swap's own Transfer logs, once.
//
//   node src/agent.mjs settle --contract TX:EVENTLOGINDEX              dry run: what would be sent, to whom
//   node src/agent.mjs settle --contract TX:EVENTLOGINDEX --execute    send it (asks you to type yes; --yes skips)
import { erc20Abi, formatUnits, getAddress, parseAbiItem } from "viem";
import { verifyTx } from "@celo/attribution-tags";
import { ATTRIBUTION_CODE } from "./config.mjs";
import { getPayoutCorridor } from "./guards.mjs";
import { BLOCKED_RECIPIENTS, log, transfersTo } from "./pay.mjs";
import { receiptLink, receiptNo, receiptNoLink } from "./requests.mjs";
import { loadContractPayments, saveContractPayments } from "./contract-watch.mjs";

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

/** Why this record can't be settled, or null when it can. Pure. */
export function settleBlocker(rec) {
  if (!rec) return "no contract payment with that key in contract-payments.json";
  if (rec.paidAt || rec.hashes?.payout) return `already paid (payout ${rec.hashes?.payout ?? "?"})`;
  if (rec.status === "refused") return "it was refused, not swapped: use refunds / refund instead";
  if (!rec.hashes?.swap) return "no swap was sent for it, so autopilot can pay it normally: just restart autopilot";
  if (!rec.owner || !rec.dir) return "the record has no recipient or corridor";
  return null;
}

export async function settleContract({ key, execute = false, yes = false, deps }) {
  const { account, pub, wallet, confirm, lock, say = console.log, file } = deps;
  const all = loadContractPayments(file);
  const rec = all[key];
  const blocker = settleBlocker(rec);
  if (blocker) throw new Error(`Can't settle ${key}: ${blocker}.`);
  const c = getPayoutCorridor(rec.dir);
  const buy = c.buyToken;
  const recipient = getAddress(rec.owner);
  if (BLOCKED_RECIPIENTS.some((b) => b.toLowerCase() === recipient.toLowerCase())) throw new Error(`Recipient ${recipient} is blocked.`);

  // What the swap actually delivered to the agent: its own Transfer logs, at its own block (no "latest" reads).
  const sr = await pub.getTransactionReceipt({ hash: rec.hashes.swap });
  if (sr.status !== "success") throw new Error(`The recorded swap ${rec.hashes.swap} did not succeed; nothing to settle.`);
  const received = transfersTo(sr.logs, buy.address, account.address);
  if (received <= 0n) throw new Error(`The swap ${rec.hashes.swap} delivered no ${buy.symbol} to the agent.`);
  const amount = formatUnits(received, buy.decimals);

  // Never pay twice: an agent → recipient transfer of exactly that amount after the swap means it was already sent.
  const sent = await pub.getLogs({ address: buy.address, event: TRANSFER, args: { from: account.address, to: recipient }, fromBlock: sr.blockNumber, toBlock: "latest" });
  const already = sent.find((l) => BigInt(l.args.value) === received);

  say(`Contract payment ${key} to ${rec.name ?? rec.tag} (${recipient}).`);
  say(`  The swap ${rec.hashes.swap} delivered ${amount} ${buy.symbol} to the agent; that is what ${rec.name ?? "the recipient"} is owed.`);
  if (already) {
    say(`  Already sent in ${already.transactionHash}; recording it as paid, nothing is sent.`);
    if (!execute) return { dryRun: true, already: already.transactionHash };
    return record(already.transactionHash, null);
  }
  if (!execute) { say("DRY RUN: add --execute to send it (one transfer from the agent, attribution-tagged)."); return { dryRun: true, amount, recipient }; }
  if (!yes && !(await confirm(`Send ${amount} ${buy.symbol} to ${recipient}?`))) throw new Error("Not confirmed; nothing sent.");
  lock?.();

  const payout = await wallet.writeContract({ address: buy.address, abi: erc20Abi, functionName: "transfer", args: [recipient, received] });
  const pr = await pub.waitForTransactionReceipt({ hash: payout });
  if (pr.status !== "success") throw new Error(`The payout reverted (${payout}). Nothing was paid; run settle again.`);
  const tags = (await verifyTx({ client: pub, hash: payout }))?.codes ?? null;
  return record(payout, tags);

  function record(payoutHash, tags) {
    const fresh = loadContractPayments(file);
    const r = fresh[key];
    const no = receiptNo(payoutHash);
    const hashes = { ...r.hashes, payout: payoutHash };
    Object.assign(r, { paidAt: new Date().toISOString(), hashes, receiptNo: no, receiptUrl: receiptLink({ payout: payoutHash, swap: hashes.swap }), settled: { error: r.error, at: new Date().toISOString() } });
    delete r.error;
    saveContractPayments(fresh, file);
    log({
      corridor: c.id, to: r.name ?? r.tag, recipient, ntag: r.tag, payer: r.deposit?.payer, receiptNo: no,
      sold: { token: r.token, amount: r.amount }, paid: { token: buy.symbol, amount },
      usd: c.usd === "buy" ? amount : undefined, hashes, tags: tags ? { payout: tags } : undefined,
      untagged: tags && !tags.includes(ATTRIBUTION_CODE) ? ["payout"] : [], settled: true,
    });
    say(`Paid ${amount} ${buy.symbol} to ${r.name ?? r.tag}. payout: https://celoscan.io/tx/${payoutHash}  tag=${JSON.stringify(tags)}`);
    say(`Receipt ${no}: ${receiptNoLink(no)}`);
    return { paid: true, payout: payoutHash, receiptNo: no, amount };
  }
}
