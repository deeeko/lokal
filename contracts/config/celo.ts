// Deployment constants for LokalTags on Celo mainnet. Shared by the deploy script, the demo and the tests, so the
// reserved list and the limits the README states are the ones that actually ship.

/** Celo mainnet. */
export const CELO_CHAIN_ID = 42220;
export const CELO_RPC_URL = "https://forno.celo.org";

/** The agent's wallet: the deployer (from its key file) and the initial payout wallet. */
export const AGENT_ADDRESS = "0x8a695cf54CB44753c8b784EB36d266f748617a1e";

/**
 * The owner's admin wallet. The deploy script hands ownership of LokalTags (and so of LokalPots) to it straight after
 * deployment (two-step: it must call acceptOwnership), so the agent's hot key is never the long-term admin.
 */
export const ADMIN_WALLET = "0xc2808B63906F48C1BaCaa1E2Ad2e1Cb2A363A070";

/** Celo Sepolia testnet, for deploy-and-verify rehearsals (chain id from Celo's docs and chainlist). */
export const CELO_SEPOLIA_CHAIN_ID = 11142220;
export const CELO_SEPOLIA_RPC_URL = "https://forno.celo-sepolia.celo-testnet.org";

/** ERC-8021 attribution code carried by every transaction this project sends (same as src/config.mjs). */
export const ATTRIBUTION_CODE = "celo_7360953d1b53";
const ERC8021_MARKER = "80218021802180218021802180218021";

/**
 * The ERC-8021 schema-0 suffix for `code`, as hex without 0x: utf8(code) ++ len(code) ++ 0x00 ++ marker. Byte-for-byte
 * what `@celo/attribution-tags` `toDataSuffix(code)` and src/ntags.mjs `tagSuffix()` produce.
 */
export function attributionSuffix(code: string = ATTRIBUTION_CODE): string {
  if (!/^[a-z0-9_]{1,32}$/.test(code)) throw new Error("attribution code must be 1-32 chars of a-z, 0-9, _");
  return Buffer.from(code, "utf8").toString("hex") + code.length.toString(16).padStart(2, "0") + "00" + ERC8021_MARKER;
}

/**
 * Reserved tags, identical to NTAG_RESERVED in src/ntags.mjs and site/assets/core.js (a test checks this). Stored
 * onchain as keccak256 hashes, seeded in the constructor so none can be claimed in the window after deployment.
 */
export const RESERVED_TAGS: readonly string[] = [
  "agent", "admin", "administrator", "root", "system", "support", "help", "official", "team", "staff", "mod", "moderator",
  "security", "celo", "minipay", "valora", "opera", "textile", "naira", "nairapayout", "payout", "payouts", "ntag", "ntags",
  "lokal", "lokalpay", "cngn", "usdt", "usdc", "tether", "cusd", "ceur", "wallet", "bank", "cbn", "null", "undefined",
  "anonymous", "everyone", "me", "you", "test", "demo", "api", "www", "app", "pay", "send", "receive",
  "lokal_support", "lokalsupport", "lokal_help", "lokal_team", "lokal_official", "lokalofficial", "support_team",
  "help_desk", "helpdesk", "admin1", "celo_team", "celoteam", "minipay_support", "textile_fx",
];

/** Limits in the token's own units. Same order as the contract's TokenLimits struct. */
export interface Limits {
  minPerPayment: bigint;
  maxPerPayment: bigint;
  maxPerRecipientPerDay: bigint;
  maxPerPayerPerDay: bigint;
  maxPerDay: bigint;
}

/** One token the router accepts. `perUsd` is how many tokens one US dollar buys (1 for USD₮). */
export interface TokenConfig {
  symbol: string;
  address: string;
  decimals: number;
  /** Local currency units per US dollar, used only to size the default limits. */
  perUsd: number;
  /** Where `perUsd` came from. */
  rateSource: string;
}

/**
 * Celo mainnet tokens (addresses from Textile FX's address book, checked on Blockscout). Rates are Textile previews
 * from 21 Nov 2026 (5 USD₮ ≈ ₦7,205 / 92,035 IDRX / 8,826 wARS / 17,278 wCOP). The admin re-tunes the limits with
 * setTokenLimits as rates move; nothing onchain reads a price.
 */
export const TOKENS: readonly TokenConfig[] = [
  { symbol: "USDT", address: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e", decimals: 6, perUsd: 1, rateSource: "dollar token" },
  { symbol: "cNGN", address: "0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f", decimals: 6, perUsd: 1441, rateSource: "Textile preview: 5 USDT = 7,205 cNGN" },
  { symbol: "IDRX", address: "0x18Bc5bcC660cf2B9cE3cd51a404aFe1a0cBD3C22", decimals: 2, perUsd: 18407, rateSource: "Textile preview: 5 USDT = 92,035 IDRX" },
  { symbol: "wARS", address: "0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D", decimals: 18, perUsd: 1765.2, rateSource: "Textile preview: 5 USDT = 8,826 wARS" },
  { symbol: "wCOP", address: "0x8a1D45e102e886510e891d2Ec656a708991e2D76", decimals: 18, perUsd: 3455.6, rateSource: "Textile preview: 5 USDT = 17,278 wCOP" },
];
export const USDT_ADDRESS = TOKENS[0].address;
export const CNGN_ADDRESS = TOKENS[1].address;

/** The dollar policy every token's default limits are sized from. */
export const POLICY_USD = {
  /** Smallest payment. */
  min: 1,
  /** Largest payment, and most per recipient and per payer per UTC day, for the dollar token. */
  max: 25,
  /**
   * Most overall per UTC day, as a multiple of `max`: $250 for the dollar token. With a $25 per-payer cap, using up a
   * token's whole day takes at least 10 different paying wallets.
   */
  dayMultiple: 10,
  /**
   * Local tokens are capped 3% under $25 (≈ $24.25, and 10 x that ≈ $242.50 a day), matching the agent's slippage
   * margin, so a payment the contract accepts is still under the agent's per-payout cap after a small price move.
   */
  localMarginBps: 300,
};

/** `whole` (a decimal string or number) in base units of a token with `decimals`. Exact, no floating point. */
export function toUnits(whole: number | string, decimals: number): bigint {
  const [i, f = ""] = String(whole).split(".");
  if (!/^\d+$/.test(i) || !/^\d*$/.test(f) || f.length > decimals) throw new Error(`bad amount ${whole} for ${decimals} decimals`);
  return BigInt(i) * 10n ** BigInt(decimals) + BigInt(f.padEnd(decimals, "0") || "0");
}

/**
 * Default limits for a token, in its own units, rounded to whole tokens: min = $1 rounded up; for the dollar token
 * $25 per payment, per recipient per day and per payer per day, $250 overall per day; for a local token the same with
 * $24.25 (rounded down) in place of $25, and 10 x that overall per day.
 */
export function defaultLimits(t: Pick<TokenConfig, "decimals" | "perUsd">): Limits {
  if (!(t.perUsd > 0) || !Number.isInteger(t.decimals) || t.decimals < 0 || t.decimals > 36) throw new Error("bad token config");
  const u = (n: number) => toUnits(String(n), t.decimals);
  const min = Math.ceil(POLICY_USD.min * t.perUsd);
  const max = t.perUsd === 1
    ? POLICY_USD.max
    : Math.floor((POLICY_USD.max * (10_000 - POLICY_USD.localMarginBps) * t.perUsd) / 10_000);
  if (max < min) throw new Error("cap is below the minimum");
  return {
    minPerPayment: u(min),
    maxPerPayment: u(max),
    maxPerRecipientPerDay: u(max),
    maxPerPayerPerDay: u(max),
    maxPerDay: u(max) * BigInt(POLICY_USD.dayMultiple),
  };
}

/** A token's rate for LokalPots: base units per US dollar (1e6 for USD₮, 1441e6 for cNGN at ₦1,441/$). */
export function unitsPerUsd(t: Pick<TokenConfig, "decimals" | "perUsd">): bigint {
  return toUnits(String(t.perUsd), t.decimals);
}

/**
 * LokalPots maxima, in US dollars with 6 decimals: a host may set a pot cap up to $100 and a per-payer cap up to $5;
 * one host's pots take at most $100 per UTC day, and all pots together at most $250 (so draining the pots' day takes
 * at least 3 hosts and 50 paying wallets).
 */
export const POT_DEFAULTS = {
  maxPotCapUsd6: 100_000_000n,
  maxPerPayerCapUsd6: 5_000_000n,
  maxPerHostDailyUsd6: 100_000_000n,
  maxDailyUsd6: 250_000_000n,
};

/** USD₮: $1 minimum, $25 per payment, per recipient and per payer per UTC day, $250 overall per UTC day. */
export const USDT_LIMITS: Limits = defaultLimits(TOKENS[0]);

/** Where the deploy script looks for the agent's key: %USERPROFILE%\.celo-naira-agent\agent.json (same as src/config.mjs). */
export const AGENT_KEY_FILE_PARTS = [".celo-naira-agent", "agent.json"] as const;
