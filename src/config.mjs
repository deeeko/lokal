// Central, auditable configuration. Everything that touches money lives here or in guards.mjs.
import os from "node:os";
import path from "node:path";
import { celo } from "viem/chains";
import { CURRENCIES, USDT_ADDRESS, USDT_DECIMALS, corridorFor, currencyOf } from "./currencies.mjs";

export const CHAIN = celo; // Celo mainnet, chain id 42220. This event only counts mainnet.

export const TEXTILE_API = process.env.TEXTILE_API ?? "https://api.textilecredit.com/v2";

// Token addresses from the official Agents Open for Business page (Celo mainnet). The local currencies come from the
// shared registry (src/currencies.mjs, mirrored in site/assets/core.js): cNGN 6 decimals, IDRX 2, wARS 18, wCOP 18.
// Each token's decimals are also re-checked on-chain before any real payout.
const local = Object.fromEntries(CURRENCIES.map((c) => [c.token.toUpperCase(), { symbol: c.token, address: c.address, decimals: c.decimals, currency: c.code }]));
export const TOKENS = {
  USDT: { symbol: "USDT", address: USDT_ADDRESS, decimals: USDT_DECIMALS },
  ...local, // CNGN, IDRX, WARS, WCOP
};
/** The TOKENS key of a currency code: "idrx" -> "IDRX". */
export const tokenKey = (code) => currencyOf(code)?.token.toUpperCase() ?? null;

// The corridors payment links, "Get paid", Lokal tags and autopilot support (same ids as site/assets/core.js CORRIDORS).
// The amount a user types is always in the SELL token. `usd` says how the USD value used for the caps is measured:
// "sell" = the USD₮ sold (every usdt-<currency> corridor), "buy" = the USD₮ bought (cngn-usdt, valued by the quote).
// `currency` = the local currency the corridor pays out in (usdt-* corridors only).
const payout = (c) => [corridorFor(c.code), {
  id: corridorFor(c.code), sell: "USDT", buy: c.token.toUpperCase(), usd: "sell", currency: c.code,
  blurb: `pay someone in ${c.plural}`,
}];
export const CORRIDORS = {
  [corridorFor("cngn")]: payout(currencyOf("cngn"))[1],
  "cngn-usdt": { id: "cngn-usdt", sell: "CNGN", buy: "USDT", usd: "buy", blurb: "pay someone in dollars" },
  ...Object.fromEntries(CURRENCIES.filter((c) => c.code !== "cngn").map(payout)),
};
export const DEFAULT_CORRIDOR = "usdt-cngn";

// CELO on Celo mainnet (GoldToken: native CELO with an ERC-20 interface, 18 decimals). Only the agent's own `pay`/`quote`
// can sell it; it is NOT in TOKENS, so payment links, "Get paid" registrations and the watch loop never see it.
export const CELO_TOKEN = { symbol: "CELO", address: "0x471EcE3750Da237f93B8E339c536989b8978a438", decimals: 18 };
// "Pay in naira from CELO": two Textile swaps (CELO -> USDT, then USDT -> cNGN) and a cNGN payout. Direct payouts only.
// There is no direct CELO -> cNGN pair on Textile. The USD value for the caps is the USDT bought in leg 1.
export const DIRECT_CORRIDORS = {
  "celo-cngn": { id: "celo-cngn", sell: "CELO", via: "USDT", buy: "CNGN", usd: "leg1", blurb: "pay someone in naira from CELO (two swaps)" },
};
// Textile's minimum is about $1 notional per swap. Leg 1 must preview at least this much USDT, so leg 2 also clears it.
export const CELO_MIN_USDT = "1.05";
// CELO the agent wallet must still hold AFTER a celo-cngn payout (it pays every network fee in CELO).
export const MIN_CELO_RESERVE = process.env.MIN_CELO_RESERVE ?? "2";
// Set aside for the gas of up to 7 transactions (2 resets, 2 approvals, 2 swaps, 1 payout) in a celo-cngn payout.
export const CELO_GAS_MARGIN = process.env.CELO_GAS_MARGIN ?? "0.1";

// ERC-8004 Identity Registry on Celo mainnet (docs.celo.org/build/agents/8004).
export const IDENTITY_REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
// ERC-8004 Reputation Registry (proxy) on Celo mainnet. Never a payout recipient.
export const REPUTATION_REGISTRY = "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63";

// The deployed agent's public address. Used by `watch` in dry-run mode when no key file is present.
export const AGENT_ADDRESS = process.env.AGENT_ADDRESS ?? "0x8a695cf54CB44753c8b784EB36d266f748617a1e";

// Issued by Loops House when the entry was created. A public code, not a secret.
export const ATTRIBUTION_CODE = process.env.ATTRIBUTION_CODE ?? "celo_7360953d1b53";
if (!/^[a-z0-9_]{1,32}$/.test(ATTRIBUTION_CODE)) {
  throw new Error("ATTRIBUTION_CODE must be 1-32 chars of a-z, 0-9, _");
}

// Hard ceiling per payout in USD. Enforced in code, never delegated to the AI layer.
export const MAX_USD = process.env.MAX_USD ?? "25";
// Hard ceiling on the USD value paid out in any rolling 24 hours (computed from receipts.jsonl).
export const MAX_DAILY_USD = process.env.MAX_DAILY_USD ?? "100";
// Hard ceiling on the USD value paid to any ONE wallet in a rolling 24 hours ("Get paid" registrations).
export const MAX_WALLET_DAILY_USD = process.env.MAX_WALLET_DAILY_USD ?? "25";

// Blockscout API, used to discover "Get paid" registrations (transactions TO the agent).
export const EXPLORER_API = (process.env.BLOCKSCOUT_API ?? "https://celo.blockscout.com/api/v2").replace(/\/+$/, "");

// Max allowed gap between the free preview and the firm quote (basis points).
export const MAX_SLIPPAGE_BPS = Number(process.env.MAX_SLIPPAGE_BPS ?? 300);

// Public site that renders payment links and receipts (Lokal; the older naira-payout.vercel.app address still works).
export const SITE_URL = (process.env.SITE_URL ?? "https://lokalpay.vercel.app").replace(/\/+$/, "");

const root = path.join(import.meta.dirname, "..");
export const KEY_FILE =
  process.env.CELO_AGENT_KEY_FILE ?? path.join(os.homedir(), ".celo-naira-agent", "agent.json");
export const CONTACTS_FILE = process.env.CONTACTS_FILE ?? path.join(root, "contacts.json");
export const LOG_FILE = process.env.RECEIPTS_FILE ?? path.join(root, "receipts.jsonl");
export const REQUESTS_FILE = process.env.REQUESTS_FILE ?? path.join(root, "requests.json");
export const WATCH_STATE_FILE = process.env.WATCH_STATE_FILE ?? path.join(root, "watch-state.json");
export const REGISTRATIONS_STATE_FILE = process.env.REGISTRATIONS_STATE_FILE ?? path.join(root, "registrations-state.json");
// nTag payments autopilot has seen (deposits whose transfer memo names a tag), keyed by `${tx}:${logIndex}`.
export const NTAG_PAYMENTS_FILE = process.env.NTAG_PAYMENTS_FILE ?? path.join(root, "ntag-payments.json");

// Status server (api/status.js on the site): autopilot reports what happened to each deposit, so the site shows exact
// facts. Reports wait in a local outbox and are sent in the background; reporting never blocks or changes a payout.
// The signing secret comes from NP_STATUS_SECRET or this file (next to the agent key, never the key file itself).
// JSON lines: one queued event per line (appended, never rewritten while a payout runs). Next to it: .sent.json, .lock
export const STATUS_OUTBOX_FILE = process.env.STATUS_OUTBOX_FILE ?? path.join(root, "status-outbox.jsonl");
export const STATUS_SECRET_FILE = process.env.STATUS_SECRET_FILE ?? path.join(path.dirname(KEY_FILE), "status-secret");
export const STATUS_URL = (process.env.STATUS_URL ?? `${SITE_URL}/api/status`).replace(/\/+$/, "");

// Refunds (src/refund.mjs, docs/REFUNDS.md): a deposit autopilot will never pay can be sent back to its sender.
// refunds.json is keyed by `${tx}:${logIndex}` (git-ignored). Refunds have their own rolling 24 h cap and never count
// towards the payout caps above; deposits worth less than MIN_REFUND_USD are left alone (gas would cost more).
export const REFUNDS_FILE = process.env.REFUNDS_FILE ?? path.join(root, "refunds.json");
export const MAX_DAILY_REFUND_USD = process.env.MAX_DAILY_REFUND_USD ?? "100";
export const MIN_REFUND_USD = process.env.MIN_REFUND_USD ?? "1";
// One agent at a time: watch --execute and every --execute command take this lock (src/lock.mjs).
export const AGENT_LOCK_FILE = process.env.AGENT_LOCK_FILE ?? path.join(path.dirname(WATCH_STATE_FILE), "agent.lock");
// Alerts (src/alerts.mjs): autopilot warns when the agent holds less CELO than this (it pays every network fee in CELO).
export const LOW_CELO_WARN = process.env.LOW_CELO_WARN ?? "3";
export const ALERTS_OUTBOX_FILE = process.env.ALERTS_OUTBOX_FILE ?? path.join(root, "alerts-outbox.jsonl");
