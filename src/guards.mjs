// Safety rules. Pure functions, unit-tested. The AI layer can never bypass these.
import { formatUnits, getAddress, isAddress, parseUnits, zeroAddress } from "viem";
import { CELO_TOKEN, CORRIDORS, DIRECT_CORRIDORS, PAYOUT_CORRIDORS, REVERSE_CORRIDORS, TOKENS } from "./config.mjs";
import { currencyOf, findCurrency, corridorFor } from "./currencies.mjs";

/**
 * Resolves a payment-link corridor id ("usdt-cngn" default, "cngn-usdt") to its sell/buy tokens. Used by payment
 * requests, "Get paid" registrations and the watch loop, so "celo-cngn" (direct payouts only) is refused here.
 */
export function getCorridor(id) {
  const key = String(id ?? "usdt-cngn").trim().toLowerCase();
  if (DIRECT_CORRIDORS[key]) {
    throw new Error(
      `Corridor "${key}" is for direct payouts only (pay / quote). Payment links, "Get paid" and autopilot support: ` +
      `${Object.keys(CORRIDORS).join(", ")}`,
    );
  }
  if (REVERSE_CORRIDORS[key]) {
    throw new Error(
      `Corridor "${key}" is for payments through the contracts and direct payouts only (pay / quote). Payment links, ` +
      `"Get paid" and Lokal tag memos support: ${Object.keys(CORRIDORS).join(", ")}`,
    );
  }
  const c = CORRIDORS[key];
  if (!c) throw new Error(`Unknown corridor "${id}". Use one of: ${Object.keys(CORRIDORS).join(", ")}`);
  return { ...c, sellToken: TOKENS[c.sell], buyToken: TOKENS[c.buy] };
}

/**
 * Any corridor pay() runs: the payment-link corridors plus the reverse ones ("idrx-usdt", "wars-usdt", "wcop-usdt":
 * the payer sends that local token, the recipient gets USD₮). Used by pay()'s pre-flight and contract autopilot.
 */
export function getPayoutCorridor(id) {
  const key = String(id ?? "usdt-cngn").trim().toLowerCase();
  const c = REVERSE_CORRIDORS[key];
  return c ? { ...c, sellToken: TOKENS[c.sell], buyToken: TOKENS[c.buy] } : getCorridor(key);
}

/** The refusal code for a payout currency Textile FX isn't quoting (recorded as refused, reported to the status server). */
export const CURRENCY_UNAVAILABLE = "currency_unavailable";

/**
 * A preview (or firm quote) that did not quote. For a corridor that pays out in a local currency this is a permanent
 * refusal with the code `currency_unavailable`: the deposit is recorded as refused and is NEVER paid in another currency.
 * Any other corridor (cngn-usdt) keeps the old behaviour: a plain error, so autopilot stops and tries again later.
 * `status`/`reason` are Textile's (e.g. "no_quote", "no_makers_online").
 */
export function notQuoting(c, status, reason) {
  const why = [status, reason].filter(Boolean).join(": ") || "no price";
  if (!c?.currency) return new Error(`No indicative price right now (${why}).`);
  const cur = currencyOf(c.currency);
  return refusal(
    `${CURRENCY_UNAVAILABLE}: ${cur ? `${cur.label} (${cur.token})` : c.currency} isn't available on Textile FX right now (${why}). ` +
    "Not paid, and never paid in another currency.",
  );
}

/** Any corridor the CLI's `pay` and `quote` accept: the payment-link corridors plus "celo-cngn". */
export function getPayCorridor(id) {
  const key = String(id ?? "usdt-cngn").trim().toLowerCase();
  const d = DIRECT_CORRIDORS[key];
  if (!d) {
    if (PAYOUT_CORRIDORS[key]) return getPayoutCorridor(key);
    throw new Error(`Unknown corridor "${id}". Use one of: ${[...Object.keys(PAYOUT_CORRIDORS), ...Object.keys(DIRECT_CORRIDORS)].join(", ")}`);
  }
  return { ...d, sellToken: CELO_TOKEN, viaToken: TOKENS[d.via], buyToken: TOKENS[d.buy] };
}

/**
 * What the recipient receives, from loose input ("rupiah", "idrx", "argentina-peso", "COP", "naira"): the currency
 * code, or throws with the accepted names. Used by `lokal send --to`, `agent request --to-currency` and friends.
 */
export function parseCurrency(input) {
  const c = findCurrency(input);
  if (!c) {
    throw new Error(`Unknown currency "${input}". Use one of: naira (cngn), rupiah (idrx), argentina-peso (wars, ars), colombia-peso (wcop, cop).`);
  }
  return c.code;
}

/** The payment-link corridor that pays out in `code` ("idrx" -> "usdt-idrx"). */
export const payoutCorridor = (code) => getCorridor(corridorFor(parseCurrency(code))).id;

/** CELO amount: "20", "20.5", "1,000 CELO". At most 6 decimal places. Returns { str, units } (18-dp base units). */
export function parseCeloAmount(input) {
  const t = String(input ?? "").trim().replace(/\s*celo$/i, "").replace(/,/g, "");
  if (!/^\d+(\.\d{1,6})?$/.test(t)) throw new Error(`Invalid CELO amount: "${input}" (a number with at most 6 decimal places)`);
  const units = parseUnits(t, 18);
  if (units === 0n) throw new Error("Amount must be greater than zero");
  return { str: t, units };
}

/**
 * Gas reserve for selling CELO (all 18-dp units): after selling `sellUnits` and setting aside `marginUnits` for gas,
 * the wallet must still hold `reserveUnits`. Returns the CELO left; throws with the largest amount that would pass, or,
 * when even that is below `minSellUnits` (the ~20 CELO a payout needs to clear Textile's ~$1 minimum), asks for a top-up.
 * Every error it throws has `celoReserve: true`.
 */
export function assertCeloReserve(balanceUnits, sellUnits, reserveUnits, marginUnits, minSellUnits = parseUnits("20", 18)) {
  const left = balanceUnits - sellUnits - marginUnits;
  if (left < reserveUnits) {
    const maxSell = balanceUnits - reserveUnits - marginUnits;
    const f = (u) => formatUnits(u, 18);
    if (maxSell < BigInt(minSellUnits)) {
      throw Object.assign(new Error(
        `The agent wallet holds ${f(balanceUnits)} CELO; a CELO payout needs about ${f(BigInt(minSellUnits))} CELO plus the ` +
        `${f(reserveUnits)} CELO reserve and gas (~${f(BigInt(minSellUnits) + reserveUnits + marginUnits)} CELO). ` +
        "Top up the agent wallet first. Nothing was sent.",
      ), { celoReserve: true });
    }
    throw Object.assign(new Error(
      `Selling ${formatUnits(sellUnits, 18)} CELO would leave ${formatUnits(left > 0n ? left : 0n, 18)} CELO after ~${formatUnits(marginUnits, 18)} CELO of gas, ` +
      `below the gas reserve of ${formatUnits(reserveUnits, 18)} CELO (MIN_CELO_RESERVE). ` +
      `Sell at most ${formatUnits(maxSell, 18)} CELO. Nothing was sent.`,
    ), { celoReserve: true });
  }
  return left;
}

/** Leg 1 must buy at least `minUnits` USDT (6 dp), or Textile's ~$1-per-swap minimum fails one of the two swaps. */
export function assertCeloMinimum(usdtUnits, minUnits) {
  if (BigInt(usdtUnits) < BigInt(minUnits)) {
    throw new Error(
      `That much CELO is worth only ~${formatUnits(BigInt(usdtUnits), 6)} USDT, below Textile's ~$1 minimum per swap ` +
      `(need at least ${formatUnits(BigInt(minUnits), 6)} USDT from the first swap); send at least ~20 CELO. Nothing was sent.`,
    );
  }
}

/**
 * What a swap really delivered to the agent: the wallet's balance change of the token bought, never more than the swap's
 * own Transfer events to the agent (so a deposit landing at the same moment is never counted). 0n if nothing arrived.
 */
export function measuredReceived(balanceDelta, transferredInSwap) {
  const d = BigInt(balanceDelta);
  const t = BigInt(transferredInSwap);
  const r = d < t ? d : t;
  return r > 0n ? r : 0n;
}

/**
 * Amount in the corridor's sell token: "10", "$10", "₦14,400.50". At most `decimals` decimal places: 6 by default (USD₮,
 * cNGN); pay() passes the sell token's own (IDRX 2, wARS and wCOP 18), so a contract payment is paid to the last unit.
 */
export function parseAmount(input, decimals = 6) {
  const t = String(input ?? "").trim().replace(/^[₦$]/, "").replace(/,/g, "");
  if (Number(decimals) === 6) return parseUsd(t);
  const d = Math.max(0, Number(decimals));
  if (!(d > 0 ? new RegExp(`^\\d+(\\.\\d{1,${d}})?$`) : /^\d+$/).test(t)) throw new Error(`Invalid amount: "${input}" (at most ${d} decimal places)`);
  if (parseUnits(t, d) === 0n) throw new Error("Amount must be greater than zero");
  return t;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** USD value (6-dp base units) of one receipts.jsonl entry. Older usdt-cngn entries only have usdtSpent. */
export function receiptUsdUnits(entry) {
  const v = entry?.usd ?? entry?.usdtSpent;
  if (v == null || !/^\d+(\.\d{1,6})?$/.test(String(v))) return 0n;
  return parseUnits(String(v), 6);
}

/**
 * Sum of USD paid out by executed payouts (entries with a payout hash) in the 24 h before `now`. Refunds
 * (kind "refund") are never payouts: they have their own cap (refundUsedUnits) and are skipped here.
 */
export function dailyUsedUnits(entries, now = Date.now()) {
  let sum = 0n;
  for (const e of entries ?? []) {
    if (!e?.hashes?.payout || e.kind === "refund") continue;
    const t = Date.parse(e.at);
    if (!Number.isFinite(t) || t <= now - DAY_MS || t > now + 60_000) continue;
    sum += receiptUsdUnits(e);
  }
  return sum;
}

/** Throws if adding `addUnits` (6-dp USD) to what was already paid in the last 24 h exceeds `cap` (USD string). */
export function assertDailyCap(usedUnits, addUnits, cap) {
  const capUnits = parseUnits(String(cap), 6);
  if (usedUnits + addUnits > capUnits) {
    throw new Error(
      `This payout (${formatUnits(addUnits, 6)} USD) would take the last 24 h total to ${formatUnits(usedUnits + addUnits, 6)} USD, ` +
      `over the daily cap of ${cap} USD (MAX_DAILY_USD). Nothing was sent.`,
    );
  }
}

/** Sum of USD paid to ONE recipient wallet by executed payouts in the 24 h before `now` (any source: contacts or registrations). */
export function walletUsedUnits(entries, recipient, now = Date.now()) {
  const who = String(recipient ?? "").toLowerCase();
  if (!who) return 0n;
  return dailyUsedUnits((entries ?? []).filter((e) => String(e?.recipient ?? "").toLowerCase() === who), now);
}

/** Throws if adding `addUnits` to what this wallet already received in the last 24 h exceeds `cap` (USD string). */
export function assertWalletCap(usedUnits, addUnits, cap) {
  const capUnits = parseUnits(String(cap), 6);
  if (usedUnits + addUnits > capUnits) {
    throw new Error(
      `This payout (${formatUnits(addUnits, 6)} USD) would take this wallet's last 24 h total to ${formatUnits(usedUnits + addUnits, 6)} USD, ` +
      `over the per-wallet cap of ${cap} USD (MAX_WALLET_DAILY_USD). Nothing was sent.`,
    );
  }
}

/** Sum of USD refunded (receipts.jsonl lines with kind "refund" and a refund hash) in the 24 h before `now`. */
export function refundUsedUnits(entries, now = Date.now()) {
  let sum = 0n;
  for (const e of entries ?? []) {
    if (e?.kind !== "refund" || !e?.hashes?.refund) continue;
    const t = Date.parse(e.at);
    if (!Number.isFinite(t) || t <= now - DAY_MS || t > now + 60_000) continue;
    sum += receiptUsdUnits(e);
  }
  return sum;
}

/** Throws if refunding `addUnits` (6-dp USD) more would take the last 24 h of refunds over `cap` (USD string). */
export function assertRefundCap(usedUnits, addUnits, cap) {
  const capUnits = parseUnits(String(cap), 6);
  if (usedUnits + addUnits > capUnits) {
    throw new Error(
      `This refund (${formatUnits(addUnits, 6)} USD) would take the refunds of the last 24 h to ${formatUnits(usedUnits + addUnits, 6)} USD, ` +
      `over the refund cap of ${cap} USD (MAX_DAILY_REFUND_USD). Nothing was sent.`,
    );
  }
}

/**
 * A refusal that will never pass, however often it is retried (self-payment, blocked recipient, a registration that
 * does not check out onchain). Autopilot logs it and moves on instead of stopping.
 */
export function refusal(message) {
  return Object.assign(new Error(message), { permanent: true });
}

/** The payer of a deposit must not be the wallet that gets paid (no self-payment / wash). */
export function assertNotSelfPayment(payer, recipient) {
  if (!isAddress(String(payer ?? "")) || !isAddress(String(recipient ?? ""))) throw refusal("Payer or recipient is not a valid address");
  if (String(payer).toLowerCase() === String(recipient).toLowerCase()) {
    throw refusal("The payer and the recipient are the same wallet (self-payment). Not paid.");
  }
}

/** "10", "$10", "10.5" -> "10" / "10.5". At most 6 decimals (USDT precision). */
export function parseUsd(input) {
  const t = String(input).trim().replace(/^\$/, "");
  if (!/^\d+(\.\d{1,6})?$/.test(t)) throw new Error(`Invalid amount: "${input}"`);
  if (parseUnits(t, 6) === 0n) throw new Error("Amount must be greater than zero");
  return t;
}

export function assertWithinCap(amount, cap) {
  if (parseUnits(amount, 6) > parseUnits(cap, 6)) {
    throw new Error(`Amount ${amount} exceeds the per-payout cap of ${cap} USD (MAX_USD)`);
  }
}

/** contacts.json: { "contacts": { "ada": "0x..." }, "own_wallets": ["0x..."] } */
export function parseContacts(raw) {
  const contacts = new Map();
  for (const [name, addr] of Object.entries(raw?.contacts ?? {})) {
    if (!isAddress(addr)) throw new Error(`Contact "${name}" has an invalid address`);
    contacts.set(name.trim().toLowerCase(), getAddress(addr));
  }
  const own = (raw?.own_wallets ?? []).map((a) => {
    if (!isAddress(a)) throw new Error("own_wallets contains an invalid address");
    return getAddress(a);
  });
  return { contacts, own };
}

export function resolveContact(name, contacts) {
  const addr = contacts.get(String(name ?? "").trim().toLowerCase());
  if (!addr) {
    const known = [...contacts.keys()].join(", ") || "(none)";
    throw new Error(`Unknown recipient "${name}". Known contacts: ${known}`);
  }
  return addr;
}

/**
 * The recipient must be an explicitly allow-listed contact, and must not be the agent itself,
 * one of the builder's own wallets, a token/registry contract, or the zero address.
 * (Hackathon rule too: self-payments and own wallets do not count as independent users.)
 */
export function assertRecipient(recipient, { agent, own = [], blocked = [] }) {
  if (!isAddress(recipient)) throw new Error("Recipient is not a valid address");
  const r = getAddress(recipient);
  // Compare lowercase. (Never `.map(getAddress)`: viem would read the array index as a chain id
  // and change the checksum, so letters-containing addresses would silently fail to match.)
  const deny = new Set([zeroAddress, agent, ...own, ...blocked].filter(Boolean).map((a) => String(a).toLowerCase()));
  if (deny.has(r.toLowerCase())) throw new Error("Recipient is blocked (agent, own wallet or contract)");
  return r;
}

/** Abort if the firm quote pays out materially less than the free preview promised. */
export function assertSlippage(previewBuy, firmBuy, maxBps) {
  const p = BigInt(previewBuy);
  const f = BigInt(firmBuy);
  if (p === 0n) throw new Error("Preview returned zero output");
  const shortfallBps = p > f ? ((p - f) * 10000n) / p : 0n;
  if (shortfallBps > BigInt(maxBps)) {
    throw new Error(`Firm quote is ${shortfallBps} bps worse than the preview (limit ${maxBps}). Aborting.`);
  }
}
