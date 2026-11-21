#!/usr/bin/env node
// lokal (also installed as ntag, its name before the rename): send money to a Lokal tag (@ada) from your own terminal,
// with your own wallet.
//
//   node src/ntag.mjs <command>      npm run lokal -- <command>      lokal <command>   (after `npm link`; `ntag` works too)
//
// Paying @ada is an ordinary USD₮ (or cNGN) transfer to the agent with "NTP:ada" (or "NTP:ada:idrx", naming the currency
// they receive) appended to the calldata (see site/_spec/NTAGS.md). The agent then pays @ada's wallet in naira, rupiah or
// pesos (or dollars, for cNGN). This tool uses YOUR wallet only:
// it never touches the agent's key, never prints a key, and asks you to type the tag before any money moves.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, erc20Abi, formatUnits, getAddress, http, isAddress, parseEventLogs } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { celo } from "viem/chains";
import {
  AGENT_ADDRESS, EXPLORER_API, KEY_FILE, MAX_DAILY_USD, MAX_SLIPPAGE_BPS, MAX_USD, MAX_WALLET_DAILY_USD, SITE_URL, TOKENS,
} from "./config.mjs";
import {
  decodeNtagPayment, decodeNtagOp, encodeNtagClaim, encodeNtagRelease, encodeNtagTransfer, loadNtagOpsCache, ntagAvailability,
  ntagError, ntagNameError, ntagOf, normalizeNtag, ownerOf, refreshNtagOpsCache, resolveNtags, resolveNtagsBefore,
  verifyNtagOpOnchain, RELEASE_LOCK_DAYS,
} from "./ntags.mjs";
import { receiptNo, receiptNoLink } from "./requests.mjs";
import { CURRENCIES, currencyOf, findCurrency, formatCurrency, formatCurrencyUnits } from "./currencies.mjs";

// The deployed agent. Hard-coded as well as read from config, so an env override can never make this tool pay elsewhere
// without also being refused as "the agent's key".
export const AGENT = "0x8a695cf54CB44753c8b784EB36d266f748617a1e";
export const RPC_URL = process.env.CELO_RPC_URL || "https://forno.celo.org";
export const DEFAULT_WALLET_FILE = path.join(os.homedir(), ".lokal", "wallet.json");
// Where the wallet lived before the rename to Lokal. Still used, in place, when it exists and the new one doesn't:
// ntag never moves a wallet by itself.
export const LEGACY_WALLET_FILE = path.join(os.homedir(), ".naira-payout", "wallet.json");
// Marker (next to the old wallet) that the "still using your old wallet" note was shown, so it appears only once.
export const LEGACY_NOTICE_FILE = path.join(path.dirname(LEGACY_WALLET_FILE), ".lokal-notice-shown");
/** True when there is no wallet at the new place but there is one at the old place. */
export const usesLegacyWallet = (env = process.env, exists = fs.existsSync) =>
  !env.NTAG_WALLET_FILE && !exists(DEFAULT_WALLET_FILE) && exists(LEGACY_WALLET_FILE);
export const walletFile = (env = process.env, exists = fs.existsSync) => {
  if (env.NTAG_WALLET_FILE) return path.resolve(env.NTAG_WALLET_FILE);
  return usesLegacyWallet(env, exists) ? LEGACY_WALLET_FILE : DEFAULT_WALLET_FILE;
};
/**
 * The one-time note for people whose wallet is still at the old place. Returns the text to show, or null (new place,
 * custom NTAG_WALLET_FILE, or already shown). Marks it shown; if the marker can't be written the note simply shows again.
 */
const markLegacyNoticeShown = () => fs.writeFileSync(LEGACY_NOTICE_FILE, new Date().toISOString() + "\n");
export function legacyWalletNotice({ env = process.env, exists = fs.existsSync, markShown = markLegacyNoticeShown } = {}) {
  if (!usesLegacyWallet(env, exists) || exists(LEGACY_NOTICE_FILE)) return null;
  try { markShown(); } catch { /* shown again next time */ }
  return `Naira Payout is now Lokal. Your wallet stays where it was, ${LEGACY_WALLET_FILE}, and lokal keeps using it there. `
    + `New wallets go to ${DEFAULT_WALLET_FILE}. To move yours, close lokal and move the file there (keep a backup); nothing else changes.`;
}

const USDT = TOKENS.USDT;
const CNGN = TOKENS.CNGN;
const CELO_DECIMALS = 18;
export const MIN_USD = 1; // Textile's ~$1 minimum per swap
export const CAP_USD = Number(MAX_USD) || 25;
export const WALLET_DAY_USD = Number(MAX_WALLET_DAILY_USD) || 25; // per receiving wallet, rolling 24 h
export const DAY_USD = Number(MAX_DAILY_USD) || 100; // everything the agent pays out, rolling 24 h
/**
 * cNGN payments: the payer side stops 3% under the agent's per-payment cap. The agent values cNGN with a fresh quote when
 * it pays, so a deposit right at $25 could be refused after a small price move; 3% matches the agent's slippage limit.
 */
export const CNGN_CAP_MARGIN_BPS = 300;
export const CNGN_CAP_USD = (CAP_USD * (10000 - CNGN_CAP_MARGIN_BPS)) / 10000;
/** The limits line shown in help and in every send summary. */
export const LIMITS_TEXT = `$${CAP_USD} per payment, $${WALLET_DAY_USD} per person per day, $${DAY_USD} per day overall`;
export const CNGN_LIMIT_TEXT = `up to about $${Math.floor(CNGN_CAP_USD)} in naira so it stays under the agent's $${CAP_USD} limit after price moves`;
const WAIT_MINUTES = Number(process.env.NTAG_WAIT_MINUTES) || 30;

// ---------- errors / exit codes ----------

export class UsageError extends Error {
  constructor(message) { super(message); this.name = "UsageError"; this.exitCode = 2; }
}
export class CliError extends Error {
  constructor(message) { super(message); this.name = "CliError"; this.exitCode = 1; }
}

// ---------- colours ----------

export function palette(enabled) {
  const wrap = (open, close) => (s) => (enabled ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));
  return { bold: wrap(1, 22), dim: wrap(2, 22), green: wrap(32, 39), red: wrap(31, 39), yellow: wrap(33, 39), cyan: wrap(36, 39) };
}
const useColor = () => Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
let c = palette(false);

// ---------- argument parsing ----------

const BOOL_FLAGS = { "--yes": "yes", "-y": "yes", "--dry-run": "dryRun", "--wait": "wait", "--dollars": "dollars", "--naira": "naira", "--help": "help", "-h": "help" };
const VALUE_FLAGS = { "--name": "name", "--to": "to" };

/** argv (without node + script) -> { cmd, args: [...positionals after cmd], flags }. Throws UsageError on unknown flags. */
export function parseArgs(argv) {
  const flags = { yes: false, dryRun: false, wait: false, dollars: false, naira: false, help: false, name: undefined, to: undefined };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (a === "--") { pos.push(...argv.slice(i + 1).map(String)); break; }
    const eq = a.indexOf("=");
    const key = a.startsWith("--") && eq > 0 ? a.slice(0, eq) : a;
    if (BOOL_FLAGS[a]) { flags[BOOL_FLAGS[a]] = true; continue; }
    if (VALUE_FLAGS[key]) {
      let v;
      if (key !== a) v = a.slice(eq + 1);
      else {
        v = argv[++i];
        if (v == null) throw new UsageError(`${key} needs a value, for example: ${key} "Ada Obi"`);
      }
      flags[VALUE_FLAGS[key]] = String(v);
      continue;
    }
    // "-5" is never an amount here; any other dash-word is an unknown option. A lone "@" tag or number is positional.
    if (/^--?[a-z]/i.test(a)) throw new UsageError(`Unknown option ${a}. Run "lokal help" for the list.`);
    pos.push(a);
  }
  if (flags.dollars && flags.naira) throw new UsageError("Pick one: --dollars or --naira (the default).");
  if (flags.to != null && flags.dollars) throw new UsageError("Pick one: --dollars (pay in cNGN, they get dollars) or --to <currency>.");
  if (flags.to != null && flags.naira && parseCurrencyArg(flags.to) !== "cngn") throw new UsageError("Pick one: --naira or --to <currency>.");
  const [cmd = "help", ...args] = pos;
  return { cmd: cmd.toLowerCase(), args, flags };
}

// ---------- tags and amounts ----------

/** What they receive, from "--to": naira | rupiah | argentina-peso | colombia-peso (or cngn, idrx, ars, cop ...). */
export function parseCurrencyArg(input) {
  const c = findCurrency(input);
  if (!c) throw new UsageError(`"${input}" is not a currency Lokal pays in. Use --to naira, rupiah, argentina-peso or colombia-peso.`);
  return c.code;
}
/** "🇮🇩 Rupiah (IDRX)" */
export const currencyText = (code) => { const c = currencyOf(code ?? "cngn"); return `${c.flag} ${c.label} (${c.token})`; };

/** "@Ada" -> "ada". Throws UsageError with the exact rule broken. */
export function parseTag(input) {
  if (input == null || String(input).trim() === "") throw new UsageError("Which Lokal tag? For example: ada (in PowerShell leave out the @, or write '@ada' in quotes)");
  const t = normalizeNtag(input);
  const err = ntagError(t);
  if (err) throw new UsageError(`@${t || String(input).trim()} is not a valid Lokal tag: ${err}.`);
  return t;
}

/**
 * Exact decimal string -> 6-decimal base units (bigint), no floating point. At most 2 decimals, > 0.
 * Accepts a leading $ or ₦ and thousands commas ("₦14,000" , "$10.29").
 */
export function parseAmountUnits(input, decimals = 6) {
  const s = String(input ?? "").trim().replace(/^[$₦]/, "").replace(/,(?=\d{3}(\D|$))/g, "");
  if (!s) throw new UsageError("How much? For example: 10 or 10.50");
  if (/^\d*\.\d{3,}$/.test(s)) throw new UsageError(`${input} has more than 2 decimals. Use at most 2, like 10.29.`);
  const m = s.match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) throw new UsageError(`"${input}" is not an amount. Use a number like 10 or 10.50.`);
  const units = BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt((m[2] ?? "").padEnd(decimals, "0") || "0");
  if (units <= 0n) throw new UsageError("The amount must be more than 0.");
  return units;
}

/** USD value (6-dp units) of cNGN units at `usdtPerNgn` (rate.json reverseRate: USD₮ received per 1 NGN, fee included). */
export function cngnUsdUnits(units, usdtPerNgn) {
  const r = Number(usdtPerNgn);
  if (!(r > 0)) throw new CliError("No live naira rate right now, so the $25 cap can't be checked. Try again in a minute.");
  const scaled = BigInt(Math.round(r * 1e12));
  return (BigInt(units) * scaled) / 10n ** 12n;
}

/**
 * Checks the amount against the limits. token "USDT": $1.00 to $25.00. token "CNGN": worth $1 to about $24.25 (3% under
 * the $25 cap, see CNGN_CAP_MARGIN_BPS) at the live rate. Returns { units, usdUnits }. Throws UsageError (bad amount) or
 * CliError (no rate).
 */
export function checkAmount(units, token, { reverseRate } = {}) {
  const cap = BigInt(Math.round(CAP_USD * 1e6));
  const min = BigInt(MIN_USD * 1e6);
  if (token === "USDT") {
    if (units < min) throw new UsageError(`The smallest payment is $${MIN_USD.toFixed(2)} USD₮.`);
    if (units > cap) throw new UsageError(`The most you can send in one payment is $${CAP_USD.toFixed(2)} USD₮.`);
    return { units, usdUnits: units };
  }
  const usdUnits = cngnUsdUnits(units, reverseRate);
  const cngnCap = BigInt(Math.round(CNGN_CAP_USD * 1e6));
  const maxNgn = Math.floor(CNGN_CAP_USD / Number(reverseRate));
  if (usdUnits > cngnCap) {
    throw new UsageError(`₦${fmtGroup(formatUnits(units, 6))} is worth about $${fmt2(formatUnits(usdUnits, 6))}. In cNGN you can send ${CNGN_LIMIT_TEXT}. Send at most about ₦${fmtGroup(String(maxNgn))}.`);
  }
  if (usdUnits < min) throw new UsageError(`₦${fmtGroup(formatUnits(units, 6))} is worth less than $${MIN_USD}, the smallest payment. Send at least about ₦${fmtGroup(String(Math.ceil(MIN_USD / Number(reverseRate))))}.`);
  return { units, usdUnits };
}

/**
 * The exact transaction a payment sends: the TOKEN contract, transfer(agent, units) + "NTP:" memo + attribution suffix,
 * value 0. `currency` (USD₮ payments): what the owner receives; naira (the default) keeps the plain "NTP:<tag>" memo.
 */
export function buildTransfer({ token, units, tag, currency, agent = AGENT }) {
  const t = token === "CNGN" ? CNGN : USDT;
  if (token === "CNGN" && currency != null && currency !== "cngn") throw new UsageError("A cNGN payment pays out in dollars; it can't choose a currency.");
  return { to: t.address, data: encodeNtagTransfer(agent, BigInt(units), tag, token === "CNGN" ? undefined : currency ?? undefined), value: 0n };
}

/** First 68 bytes of an ERC-20 transfer: { to, units } or null. Trailing bytes (memo, suffix) are ignored. */
export function parseTransferCalldata(input) {
  const h = String(input ?? "").toLowerCase().replace(/^0x/, "");
  if (!h.startsWith("a9059cbb") || h.length < 136) return null;
  return { to: getAddress("0x" + h.slice(32, 72)), units: BigInt("0x" + h.slice(72, 136)) };
}

// ---------- formatting ----------

const fmt2 = (s) => Number(s).toFixed(2);
function fmtGroup(s, dp = null) {
  const n = Number(s);
  const d = dp ?? (Number.isInteger(n) ? 0 : 2);
  return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}
export const shortAddr = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
export const celoscanTx = (h) => `https://celoscan.io/tx/${h}`;
export const celoscanAddr = (a) => `https://celoscan.io/address/${a}`;
export const fmtUsd = (units) => `$${fmtGroup(formatUnits(BigInt(units), 6), 2)}`;
export const fmtNgn = (units) => `₦${fmtGroup(formatUnits(BigInt(units), 6), 2)}`;
/** An amount of a token by its TOKENS key ("USDT", "CNGN", "IDRX", "WARS", "WCOP"), rounded down: "Rp 91,967 IDRX". */
export const fmtToken = (units, token) => {
  if (token === "USDT") return `${fmtUsd(units)} USD₮`;
  const cur = CURRENCIES.find((x) => x.token.toUpperCase() === token);
  return cur ? `${formatCurrencyUnits(units, cur.code)} ${cur.token}` : `${units} ${token}`;
};
export const fmtCelo = (wei, dp = 4) => `${Number(formatUnits(BigInt(wei), CELO_DECIMALS)).toFixed(dp)} CELO`;
const isoDay = (sec) => new Date(Number(sec) * 1000).toISOString().slice(0, 10);
const visible = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "");

/** A box around [label, value] rows. `title` goes in the top border. Pure, so tests can check it. */
export function formatBox(title, rows, { color = false } = {}) {
  const p = palette(color);
  const labelW = Math.max(0, ...rows.map(([l]) => visible(l).length));
  const lines = rows.map(([l, v]) => `${p.dim(String(l).padEnd(labelW))}  ${v}`);
  const inner = Math.max(visible(title).length + 2, ...lines.map((l) => visible(l).length));
  const top = `┌─ ${p.bold(title)} ${"─".repeat(Math.max(0, inner - visible(title).length - 1))}┐`;
  const body = lines.map((l) => `│ ${l}${" ".repeat(inner - visible(l).length)} │`);
  return [top, ...body, `└${"─".repeat(inner + 2)}┘`].join("\n");
}

/**
 * The payment summary shown before anything is sent.
 * s = { tag, name, owner, token, units, receiveText, rateText, feeWei, fromAddress, todayText }
 * It always shows the agent's limits; cNGN payments also say why they stop a little under $25.
 */
export function formatSummary(s, opts = {}) {
  const rows = [
    ["To", `@${s.tag}${s.name ? `  (${s.name})` : ""}`],
    ["Owner wallet", shortAddr(s.owner)],
    ["You send", fmtToken(s.units, s.token)],
    ["They get", s.receiveText ?? "≈ unavailable right now"],
  ];
  if (s.preferText) rows.push(["Prefers", s.preferText]);
  if (s.rateText) rows.push(["Rate", s.rateText]);
  rows.push(["Network fee", s.feeWei != null ? `≈ ${fmtCelo(s.feeWei, 5)}` : "≈ unknown"]);
  if (s.fromAddress) rows.push(["From", shortAddr(s.fromAddress)]);
  rows.push(["Limits", LIMITS_TEXT]);
  if (s.token === "CNGN") rows.push(["In cNGN", CNGN_LIMIT_TEXT]);
  if (s.todayText) rows.push(["Today", s.todayText]);
  return formatBox(`Pay @${s.tag}`, rows, opts);
}

/** "@ada can receive about $X more today (limit $25 per person per day)", or why it could not be checked. Pure. */
export function todayText(tag, allowance) {
  const lim = `limit $${WALLET_DAY_USD} per person per day`;
  if (!allowance || allowance.error) return `could not check how much more @${tag} can receive today (${lim}); the agent still enforces it`;
  return `@${tag} can receive about ${fmtUsd(allowance.leftUnits)} more today (${lim})`;
}

/** Local money per 1 USD₮ for `code` from rate.json / api/rate data (rates.<code>; naira also from the older fields). */
export function rateFor(rate, code = "cngn") {
  const r = Number(rate?.rates?.[code]);
  if (r > 0 && rate?.available?.[code] !== false) return r;
  if (code !== "cngn") return null;
  return Number(rate?.effectiveRate) || Number(rate?.ticker?.bid) || null;
}

/**
 * What they get, from rate.json-style data. Returns { text, rateText } with text "≈ ₦14,443.66 in naira (cNGN)",
 * "≈ Rp 183,938 in rupiah (IDRX)" etc. `currency`: what a USD₮ payment pays out in (default naira). Rounded down.
 */
export function estimateReceive(token, units, rate, currency = "cngn") {
  if (token === "USDT") {
    const cur = currencyOf(currency) ?? currencyOf("cngn");
    const r = rateFor(rate, cur.code);
    if (!(r > 0)) return { text: null, rateText: null };
    const got = (Number(units) / 1e6) * r; // estimate only; the agent pays what the swap really delivers
    const word = cur.plural;
    return {
      text: `≈ ${cur.code === "cngn" ? fmtNgn(BigInt(Math.floor(Number(units) * r))) : formatCurrency(got, cur.code)} in ${word} (${cur.token})`,
      rateText: `$1 ≈ ${formatCurrency(r, cur.code, cur.code === "cngn" ? 2 : cur.places)}${rate?.stale ? " (may be out of date)" : ""}`,
    };
  }
  const rr = Number(rate?.reverseRate);
  if (!(rr > 0)) return { text: null, rateText: null };
  return { text: `≈ ${fmtUsd(cngnUsdUnits(units, rr))} in dollars (USD₮)`, rateText: `₦1,000 ≈ $${(rr * 1000).toFixed(2)}${rate?.stale ? " (may be out of date)" : ""}` };
}

// ---------- wallet file (encrypted with a send password) ----------
//
// The key is never stored in plaintext. wallet.json is a Web3 Secret Storage v3-style file:
//   { version: 3, id, address (checksummed, for display), crypto: { cipher: "aes-256-gcm", ciphertext, cipherparams: { iv },
//     mac (the 16-byte GCM tag), kdf: "scrypt", kdfparams: { dklen: 32, n: 131072, r: 8, p: 1, salt (32 bytes) } } }
// The address is bound into the GCM tag as associated data, so editing it (or any byte of the file) fails to decrypt.
// Test-only: NTAG_TEST_SCRYPT_N lowers scrypt's N, and is honoured ONLY inside `node --test` (NODE_TEST_CONTEXT set).

export const SCRYPT_N = 2 ** 17;
export function scryptN(env = process.env) {
  const t = Number(env.NTAG_TEST_SCRYPT_N);
  return env.NODE_TEST_CONTEXT && Number.isInteger(t) && t >= 2 && (t & (t - 1)) === 0 ? t : SCRYPT_N;
}
const deriveKey = (password, salt, { n, r, p, dklen }) =>
  crypto.scryptSync(Buffer.from(String(password).normalize("NFKC"), "utf8"), salt, dklen, { N: n, r, p, maxmem: 256 * n * r + (1 << 20) });

export class WrongPasswordError extends CliError {
  constructor() { super("Wrong password. Nothing was sent."); this.name = "WrongPasswordError"; }
}

/** privateKey (0x hex) + password -> keystore object. */
export function encryptKey(privateKey, password, { n = scryptN() } = {}) {
  const key = normalizePrivateKey(privateKey);
  const { address } = privateKeyToAccount(key);
  const salt = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const kdfparams = { dklen: 32, n, r: 8, p: 1, salt: salt.toString("hex") };
  const dk = deriveKey(password, salt, kdfparams);
  const cipher = crypto.createCipheriv("aes-256-gcm", dk, iv);
  cipher.setAAD(Buffer.from(address.toLowerCase(), "utf8"));
  const plain = Buffer.from(key.slice(2), "hex");
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  plain.fill(0); dk.fill(0);
  return {
    version: 3, id: crypto.randomUUID(), address,
    crypto: { cipher: "aes-256-gcm", ciphertext: ciphertext.toString("hex"), cipherparams: { iv: iv.toString("hex") }, mac: cipher.getAuthTag().toString("hex"), kdf: "scrypt", kdfparams },
    createdAt: new Date().toISOString(),
  };
}

/** Checks the keystore's shape (not the password). Throws CliError for plaintext or damaged files. */
export function assertKeystore(ks, file = "the wallet file") {
  if (ks && typeof ks === "object" && "privateKey" in ks) {
    throw new CliError(`${file} holds an unencrypted key, which lokal no longer accepts. Move it somewhere safe, then run "lokal wallet import" to store the key encrypted with a send password.`);
  }
  const cr = ks?.crypto, kp = cr?.kdfparams;
  const hex = (s, len) => typeof s === "string" && /^[0-9a-f]+$/i.test(s) && (len == null || s.length === len);
  const good = ks?.version === 3 && isAddress(String(ks.address ?? "")) && cr?.cipher === "aes-256-gcm" && cr?.kdf === "scrypt"
    && hex(cr.ciphertext, 64) && hex(cr.cipherparams?.iv, 24) && hex(cr.mac, 32) && hex(kp?.salt, 64) && kp.dklen === 32
    && Number.isInteger(kp.n) && kp.n >= 2 && kp.n <= 2 ** 20 && (kp.n & (kp.n - 1)) === 0 && kp.r === 8 && kp.p === 1;
  if (!good) throw new CliError(`${file} is damaged or not an lokal wallet. Not using it.`);
  return ks;
}

/** Keystore + password -> 0x private key (in memory only). Wrong password or any tampering -> WrongPasswordError. */
export function decryptKey(ks, password) {
  assertKeystore(ks);
  const cr = ks.crypto;
  const dk = deriveKey(password, Buffer.from(cr.kdfparams.salt, "hex"), cr.kdfparams);
  let plain;
  try {
    const d = crypto.createDecipheriv("aes-256-gcm", dk, Buffer.from(cr.cipherparams.iv, "hex"));
    d.setAAD(Buffer.from(String(ks.address).toLowerCase(), "utf8"));
    d.setAuthTag(Buffer.from(cr.mac, "hex"));
    plain = Buffer.concat([d.update(Buffer.from(cr.ciphertext, "hex")), d.final()]);
  } catch { throw new WrongPasswordError(); } finally { dk.fill(0); }
  const key = `0x${plain.toString("hex")}`;
  plain.fill(0);
  if (privateKeyToAccount(key).address.toLowerCase() !== String(ks.address).toLowerCase()) throw new CliError("The wallet file is damaged (its key does not match its address).");
  return key;
}

const WEAK = new Set([
  "password", "password1", "password12", "password123", "passw0rd", "p@ssw0rd", "p@ssword", "12345678", "123456789", "1234567890",
  "87654321", "11111111", "00000000", "qwerty12", "qwerty123", "qwertyuiop", "asdfghjk", "asdfghjkl", "zxcvbnm1", "iloveyou",
  "abcdefgh", "abc12345", "abcd1234", "letmein1", "letmein123", "welcome1", "welcome123", "admin123", "changeme", "trustno1",
  "football", "sunshine", "princess", "naira123", "ntag1234", "lokal123", "lokal1234", "celo1234", "wallet123", "mywallet", "secret12", "monkey123",
]);
/** Why a send password is too weak, or null. `tag` / `address` are refused as passwords too. */
export function passwordProblem(pw, { tag, address } = {}) {
  const s = String(pw ?? "");
  if (s.length < 8) return "use at least 8 characters";
  if (s.length > 256) return "use 256 characters or fewer";
  const l = s.toLowerCase();
  if (WEAK.has(l) || /^pass(word|w0rd)?\d*$/.test(l)) return "that password is too common";
  if (/^(.)\1+$/.test(s)) return "don't repeat one character";
  const digits = "01234567890", rev = "09876543210", abc = "abcdefghijklmnopqrstuvwxyz";
  if (digits.includes(l) || rev.includes(l) || abc.includes(l)) return "don't use a simple sequence";
  const t = tag ? normalizeNtag(tag) : "";
  if (t && (l === t || l === `@${t}` || l.replace(/[^a-z0-9]/g, "") === t.replace(/_/g, ""))) return "don't use your Lokal tag as your password";
  if (address && l.replace(/^0x/, "") === String(address).toLowerCase().replace(/^0x/, "")) return "don't use your wallet address";
  return null;
}

// Lockout: 3 tries per command; 5 failures within 10 minutes -> refuse for 5 minutes. Persisted next to the wallet.
export const LOCK_WINDOW_MS = 10 * 60_000;
export const LOCK_AFTER = 5;
export const LOCK_FOR_MS = 5 * 60_000;
export const TRIES_PER_COMMAND = 3;
/** Pure. failures = timestamps (ms). Returns { locked, retryAt, recent } at `now`. */
export function lockoutState(failures, now) {
  const recent = (Array.isArray(failures) ? failures : []).map(Number).filter((t) => Number.isFinite(t) && t > now - LOCK_WINDOW_MS && t <= now).sort((a, b) => a - b);
  if (recent.length >= LOCK_AFTER) {
    const retryAt = recent[recent.length - 1] + LOCK_FOR_MS;
    if (retryAt > now) return { locked: true, retryAt, recent };
  }
  return { locked: false, retryAt: null, recent };
}
/** Pure. Adds a failure at `now` and drops the ones outside the window. */
export const recordFailure = (failures, now) => [...lockoutState(failures, now).recent, now];

export const attemptsFile = (file) => `${file}.attempts.json`;
function readAttempts(file) {
  try { const j = JSON.parse(fs.readFileSync(attemptsFile(file), "utf8")); return Array.isArray(j?.failures) ? j.failures : []; } catch { return []; }
}
function writeAttempts(file, failures) {
  try {
    if (!failures.length) { fs.rmSync(attemptsFile(file), { force: true }); return; }
    fs.writeFileSync(attemptsFile(file), JSON.stringify({ failures }) + "\n", { mode: 0o600 });
  } catch { /* best effort */ }
}

const samePath = (a, b) => {
  const n = (p) => path.resolve(p).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
};

/** Aborts if `keyPath` is the agent's key file or `address` is the agent. This tool is for people's own wallets only. */
export function assertNotAgentKey({ keyPath, address } = {}, { agentKeyFile = KEY_FILE, agents = [AGENT, AGENT_ADDRESS] } = {}) {
  if (keyPath && samePath(keyPath, agentKeyFile)) {
    throw new CliError("That file is the payout agent's own key. lokal only works with your personal wallet. Set NTAG_WALLET_FILE to a different file.");
  }
  if (address && agents.some((a) => String(a).toLowerCase() === String(address).toLowerCase())) {
    throw new CliError("That key belongs to the payout agent. lokal only works with your personal wallet.");
  }
}

/** Validates a private key string. Returns the 0x-prefixed lower-case key. Never echoes the key in errors. */
export function normalizePrivateKey(raw) {
  const k = String(raw ?? "").trim().replace(/^["']|["']$/g, "");
  const hex = k.startsWith("0x") || k.startsWith("0X") ? k.slice(2) : k;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new CliError("That isn't a private key. A key is 64 hex characters (0-9, a-f), optionally starting with 0x.");
  if (/^0+$/.test(hex)) throw new CliError("That private key is not valid.");
  const key = `0x${hex.toLowerCase()}`;
  try { privateKeyToAccount(key); } catch { throw new CliError("That private key is not valid."); }
  return key;
}

/**
 * Encrypts `privateKey` with `password` and writes a NEW wallet file (refuses to overwrite). Restricts access where the
 * OS allows. Returns the address. The plaintext key never touches the disk.
 */
export function saveWallet(privateKey, password, file = walletFile(), { n } = {}) {
  assertNotAgentKey({ keyPath: file });
  const key = normalizePrivateKey(privateKey);
  const { address } = privateKeyToAccount(key);
  assertNotAgentKey({ address });
  const weak = passwordProblem(password, { address });
  if (weak) throw new UsageError(`Send password: ${weak}.`);
  if (fs.existsSync(file)) throw new CliError(`A wallet already exists at ${file}. lokal never overwrites a wallet. Move that file away first if you really mean to replace it.`);
  const ks = encryptKey(key, password, n ? { n } : {});
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(ks, null, 2) + "\n", { mode: 0o600, flag: "wx" }); // "wx": fails if the file appeared meanwhile
  restrictWindowsAcl(file);
  return address;
}

/** Re-encrypts the wallet under a new password, atomically (tmp + rename). Throws WrongPasswordError on a bad old one. */
export function changePassword(file, oldPassword, newPassword, { n, tag } = {}) {
  const ks = readKeystore(file);
  const key = decryptKey(ks, oldPassword);
  const weak = passwordProblem(newPassword, { tag, address: ks.address });
  if (weak) throw new UsageError(`New send password: ${weak}.`);
  if (newPassword === oldPassword) throw new UsageError("The new password is the same as the old one.");
  const next = { ...encryptKey(key, newPassword, n ? { n } : {}), id: ks.id ?? crypto.randomUUID(), createdAt: ks.createdAt ?? new Date().toISOString() };
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  restrictWindowsAcl(tmp);
  fs.renameSync(tmp, file);
  return ks.address;
}

/** Reads and checks the (encrypted) wallet file. Refuses the agent's key path before reading anything. */
export function readKeystore(file = walletFile()) {
  assertNotAgentKey({ keyPath: file });
  if (!fs.existsSync(file)) throw new CliError(`No wallet yet. Create one with "lokal wallet new" or bring yours with "lokal wallet import".`);
  let j;
  try { j = JSON.parse(fs.readFileSync(file, "utf8")); } catch { throw new CliError(`The wallet file ${file} is damaged (not valid JSON).`); }
  assertKeystore(j, file);
  assertNotAgentKey({ address: j.address });
  return j;
}

function restrictWindowsAcl(file) {
  if (process.platform !== "win32" || !process.env.USERNAME) return;
  try {
    execFileSync("icacls", [file, "/inheritance:r", "/grant:r", `${process.env.USERNAME}:F`], { stdio: "ignore", windowsHide: true });
  } catch { /* best effort: the file still lives in the user's own profile */ }
}

/** The wallet WITHOUT its key: { address, file }. Enough for balances, checks and summaries. */
export function loadWallet(file = walletFile()) {
  const ks = readKeystore(file);
  return { address: getAddress(ks.address), file };
}

/**
 * Asks for the send password (or uses NTAG_PASSWORD), with the lockout. Returns a viem account built in memory.
 * `getPassword(attempt)` is injectable for tests. Throws CliError after TRIES_PER_COMMAND wrong answers or while locked.
 */
export async function unlockWallet(file = walletFile(), { getPassword, now = () => Date.now(), env = process.env } = {}) {
  const ks = readKeystore(file);
  const fromEnv = env.NTAG_PASSWORD;
  const tries = fromEnv ? 1 : TRIES_PER_COMMAND;
  const ask = getPassword ?? (() => readLine("Send password (hidden): ", { hidden: true }));
  for (let i = 0; i < tries; i++) {
    const st = lockoutState(readAttempts(file), now());
    if (st.locked) {
      const mins = Math.max(1, Math.ceil((st.retryAt - now()) / 60_000));
      throw new CliError(`Too many wrong passwords. Wallet locked for about ${mins} more minute${mins === 1 ? "" : "s"}. Nothing was sent.`);
    }
    const pw = fromEnv ?? (await ask(i));
    try {
      let key = decryptKey(ks, pw);
      const account = privateKeyToAccount(key);
      key = null;
      writeAttempts(file, []);
      return account;
    } catch (e) {
      if (!(e instanceof WrongPasswordError)) throw e;
      writeAttempts(file, recordFailure(readAttempts(file), now()));
      const left = tries - i - 1;
      if (left > 0) out(`${c.red("Wrong password.")} ${left} ${left === 1 ? "try" : "tries"} left.`);
    }
  }
  throw new CliError(`Wrong password${fromEnv ? " (from NTAG_PASSWORD)" : ", 3 times"}. Nothing was sent. The password can't be recovered; if it is lost, re-import your key backup with a new password.`);
}

/** Asks for a new send password twice (or uses NTAG_PASSWORD). */
async function chooseNewPassword({ tag, address } = {}, label = "Choose a send password") {
  if (process.env.NTAG_PASSWORD) {
    const weak = passwordProblem(process.env.NTAG_PASSWORD, { tag, address });
    if (weak) throw new UsageError(`NTAG_PASSWORD: ${weak}.`);
    return process.env.NTAG_PASSWORD;
  }
  out(c.dim("The send password unlocks your wallet each time you send. It can't be recovered, so remember it (and keep your key backed up)."));
  for (let i = 0; i < 3; i++) {
    const a = await readLine(`${label} (min 8 characters, hidden): `, { hidden: true });
    const weak = passwordProblem(a, { tag, address });
    if (weak) { out(`${c.red("Too weak:")} ${weak}.`); continue; }
    const b = await readLine("Type it again: ", { hidden: true });
    if (a !== b) { out(c.red("The two passwords don't match.")); continue; }
    return a;
  }
  throw new CliError("No password set. Nothing was saved.");
}

// ---------- prompts ----------

// Piped (non-TTY) stdin: one shared buffer, so several prompts can each take their own line.
let pipeBuf = "";
let pipeEnded = false;

/**
 * Reads one line. `hidden`: no echo (raw mode on a terminal, Windows included; handles paste, backspace, Ctrl+C).
 * Piped input works for both. Never logs what was typed.
 */
export function readLine(prompt, { hidden = false, input = process.stdin, output = process.stderr } = {}) {
  const tty = Boolean(input.isTTY);
  if (tty && !hidden) {
    const rl = readline.createInterface({ input, output, terminal: true });
    return rl.question(prompt).then((a) => a.trim()).finally(() => rl.close());
  }
  return new Promise((resolve, reject) => {
    output.write(prompt);
    input.setEncoding("utf8");
    const raw = tty && typeof input.setRawMode === "function";
    let s = "";
    const cleanup = () => {
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      if (raw) input.setRawMode(false);
      input.pause();
    };
    const done = (v) => { cleanup(); output.write("\n"); resolve(hidden ? v : v.trim()); };
    const takePiped = () => {
      const i = pipeBuf.search(/\r?\n/);
      if (i < 0) return false;
      const line = pipeBuf.slice(0, i);
      pipeBuf = pipeBuf.slice(i + (pipeBuf[i] === "\r" ? 2 : 1));
      done(line);
      return true;
    };
    function onEnd() {
      pipeEnded = true;
      if (raw) return done(s);
      const line = pipeBuf; pipeBuf = ""; done(line);
    }
    function onData(chunk) {
      if (!raw) { pipeBuf += String(chunk); takePiped(); return; }
      for (const ch of String(chunk)) {
        if (ch === "\r" || ch === "\n") return done(s);
        if (ch === "\u0003") { cleanup(); output.write("\n"); return reject(new CliError("Cancelled. Nothing was sent.")); }
        if (ch === "\u0008" || ch === "\u007f") { s = s.slice(0, -1); continue; }
        if (ch < " ") continue;
        s += ch;
      }
    }
    if (!raw && takePiped()) return;
    if (!raw && pipeEnded) { const line = pipeBuf; pipeBuf = ""; return done(line); }
    if (raw) input.setRawMode(true);
    input.on("data", onData);
    input.on("end", onEnd);
    input.resume();
  });
}

const ask = (question) => readLine(question, { output: process.stdout }).then((a) => a.trim());

/** True when the typed answer is the tag (with or without "@", any case). */
export const typedTagMatches = (answer, tag) => normalizeNtag(answer) === tag;

// ---------- network ----------

export function makePublic(url = RPC_URL) {
  return createPublicClient({ chain: celo, transport: http(url, { timeout: 20_000, retryCount: 2 }) });
}

function timeoutSignal(ms) {
  if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);
  const ac = new AbortController(); setTimeout(() => ac.abort(), ms).unref?.(); return ac.signal;
}

async function getJson(url, { ms = 15_000, retries = 1 } = {}) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { signal: timeoutSignal(ms), headers: { accept: "application/json" } });
      if (r.status === 429 || r.status >= 500) throw Object.assign(new Error(`HTTP ${r.status} from ${new URL(url).host}`), { retry: true });
      if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(url).host}`);
      return await r.json();
    } catch (e) {
      if (i < retries && (e.retry || e.name === "TypeError" || e.name === "TimeoutError" || e.name === "AbortError")) {
        await sleep(1000);
        continue;
      }
      throw e;
    }
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The site's rate: live /api/rate, then the published rate.json, then a direct Textile preview (lib/rate.mjs). */
export async function loadRate() {
  for (const u of [`${SITE_URL}/api/rate`, `${SITE_URL}/rate.json`]) {
    try {
      const d = await getJson(u, { ms: 10_000, retries: 0 });
      if (Number(d?.effectiveRate) > 0 || d?.ticker) return withAge(d);
    } catch { /* next source */ }
  }
  try {
    const { buildRate } = await import("../lib/rate.mjs");
    return withAge(await buildRate({ timeoutMs: 15_000 }));
  } catch { return null; }
}
function withAge(d) {
  const ageMin = Math.max(0, Math.round((Date.now() - Date.parse(d.fetchedAt)) / 60000));
  return { ...d, stale: Boolean(d.stale) || !(ageMin <= 120) };
}

// The nTag list: read in full once per run, then only what is new (cheap however long the history is, and never partial).
let opsCache = null;
async function discoverOps() {
  try {
    opsCache = opsCache ? await refreshNtagOpsCache(opsCache, { agent: AGENT }) : await loadNtagOpsCache({ agent: AGENT });
    return opsCache.ops;
  } catch (e) {
    throw new CliError(`Could not load the Lokal tag list from Blockscout (${e.message}). Check your connection and try again.`);
  }
}

/** Resolves a tag NOW and verifies the winning claim over RPC. Returns { entry, op, state, ops } or { entry: null, state }. */
async function resolveVerified(pub, tag) {
  const ops = await discoverOps();
  const state = resolveNtags(ops);
  const entry = ownerOf(state, tag);
  if (!entry) return { entry: null, state, ops };
  const op = ops.find((o) => o.hash === entry.hash);
  try { await verifyNtagOpOnchain(pub, op, AGENT); } catch (e) {
    throw new CliError(`@${tag}'s claim could not be verified on the Celo network, so nothing was sent. ${e.permanent ? e.message : explainError(e)}`);
  }
  return { entry: { ...entry, owner: getAddress(entry.owner) }, op, state, ops };
}

const balanceOf = (pub, token, owner) => pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] });

async function estimateFee(pub, tx, from) {
  let gas;
  try { gas = await pub.estimateGas({ account: from, to: tx.to, data: tx.data, value: tx.value ?? 0n }); } catch { gas = 150_000n; }
  const price = await pub.getGasPrice();
  return { gas, price, fee: (gas * price * 12n) / 10n }; // 20% headroom so the estimate does not under-promise
}

/**
 * Blockscout ERC-20 transfers TO `owner` (newest first), up to `pages`, stopping once older than `sinceSec` or below
 * `sinceBlock`. Returns { items, complete } (complete = reached that point, or the end, within the page limit).
 */
async function transfersToAddress(owner, { token, sinceSec = 0, sinceBlock = 0, pages = 5 } = {}) {
  const items = [];
  let next = null;
  for (let p = 0; p < pages; p++) {
    const qs = new URLSearchParams({ type: "ERC-20", filter: "to", ...(token ? { token } : {}), ...(next ?? {}) });
    const d = await getJson(`${EXPLORER_API}/addresses/${owner}/token-transfers?${qs}`);
    const page = Array.isArray(d?.items) ? d.items.map(transferFromItem).filter(Boolean) : [];
    items.push(...page);
    next = d?.next_page_params ?? null;
    if (!next || page.some((i) => i.time < sinceSec || i.block < sinceBlock)) return { items, complete: true };
  }
  return { items, complete: false };
}

/** Blockscout token-transfer item -> { hash, from, to, token, units, block, logIndex, time } (handles old and new field names). */
export function transferFromItem(t) {
  const hash = t?.transaction_hash ?? t?.tx_hash;
  const token = t?.token?.address_hash ?? t?.token?.address;
  if (!hash || !token || !t?.from?.hash || !t?.to?.hash) return null;
  let units;
  try { units = BigInt(t.total?.value ?? "0"); } catch { return null; }
  return { hash, from: t.from.hash, to: t.to.hash, token, units, block: Number(t.block_number ?? 0), logIndex: Number(t.log_index ?? 0), time: Math.floor(Date.parse(t.timestamp) / 1000) };
}

const lc = (s) => String(s ?? "").toLowerCase();
const byChainOrder = (a, b) => a.block - b.block || a.logIndex - b.logIndex;
/** Strictly later in the chain than d (block, then log index). */
const isAfter = (p, d) => p.block > d.block || (p.block === d.block && p.logIndex > d.logIndex);
const sameLog = (a, b) => lc(a.hash) === lc(b.hash) && Number(a.logIndex) === Number(b.logIndex);

/** Units of the payout token a deposit should bring the owner at today's rate (an estimate), or null without a rate. */
export function expectedPayoutUnits(token, units, rate, currency = "cngn") {
  if (token === "USDT") {
    const cur = currencyOf(currency) ?? currencyOf("cngn");
    const r = rateFor(rate, cur.code);
    if (!(r > 0)) return null;
    const micro = BigInt(Math.floor(Number(units) * r)); // 6-dp units of the local money
    return cur.decimals >= 6 ? micro * 10n ** BigInt(cur.decimals - 6) : micro / 10n ** BigInt(6 - cur.decimals);
  }
  const rr = Number(rate?.reverseRate);
  return rr > 0 ? cngnUsdUnits(units, rr) : null;
}

/**
 * Why the agent would NOT pay an nTag deposit automatically (self-payment, under the minimum, over the per-payment
 * cap), or null. cNGN is valued at the live rate; without one only the fixed floor is checked. Pure.
 */
export function depositIneligible({ token, units, payer, owner }, rate) {
  if (lc(payer) === lc(owner)) return "the payer is the tag's own wallet (self-payment)";
  const cap = BigInt(Math.round(CAP_USD * 1e6));
  const min = BigInt(MIN_USD * 1e6);
  if (token === "USDT") {
    if (BigInt(units) < min) return `under the $${MIN_USD} minimum`;
    if (BigInt(units) > cap) return `over the $${CAP_USD} per-payment limit`;
    return null;
  }
  if (BigInt(units) < 1000n * 1_000_000n) return "under the ₦1,000 minimum";
  const rr = Number(rate?.reverseRate);
  if (!(rr > 0)) return null;
  const usd = cngnUsdUnits(units, rr);
  if (usd < min) return `worth under the $${MIN_USD} minimum`;
  if (usd > cap) return `worth over the $${CAP_USD} per-payment limit`;
  return null;
}

/**
 * Which agent payout (if any) is for THIS nTag deposit. Pure.
 *   target / deposits: the owner's eligible nTag deposits since the claim, { hash, block, logIndex, expected (payout
 *   token units at today's rate, or null) }; payouts: the agent's transfers to the owner in the payout token since the
 *   claim, { hash, block, logIndex, units, time }.
 * In chain order, each deposit takes the earliest unused payout after it whose value is within `marginBps` of what it
 * should bring. Returns { status: "paid", payout } only when that payout could not also be another deposit's;
 * { status: "maybe", payout, assigned } when a payout exists after the deposit but can't be pinned to it; else
 * { status: "none" }.
 */
export function matchNtagPayout({ target, deposits = [], payouts = [], marginBps = MAX_SLIPPAGE_BPS }) {
  const fits = (p, d) => {
    if (d.expected == null || BigInt(d.expected) <= 0n) return false;
    const e = BigInt(d.expected), u = BigInt(p.units);
    return (u > e ? u - e : e - u) * 10000n <= e * BigInt(marginBps);
  };
  const ds = deposits.some((d) => sameLog(d, target)) ? [...deposits] : [...deposits, target];
  ds.sort(byChainOrder);
  const ps = [...payouts].sort(byChainOrder);
  const used = new Set();
  let mine = null;
  for (const d of ds) {
    const p = ps.find((x) => !used.has(x) && isAfter(x, d) && fits(x, d));
    if (!p) continue;
    used.add(p);
    if (sameLog(d, target)) mine = p;
  }
  if (mine) {
    const shared = ds.some((o) => !sameLog(o, target) && isAfter(mine, o) && fits(mine, o));
    return { status: shared ? "maybe" : "paid", payout: mine, assigned: true };
  }
  const any = ps.find((p) => isAfter(p, target));
  return any ? { status: "maybe", payout: any, assigned: false } : { status: "none" };
}

/** The deposit's Transfer to the agent in a receipt: { hash, block, logIndex, units, payer }, or null. */
export function depositFromReceipt(rc, tokenAddress, agent = AGENT) {
  const l = parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: rc?.logs ?? [] })
    .find((x) => lc(x.address) === lc(tokenAddress) && lc(x.args.to) === lc(agent));
  return l ? { hash: rc.transactionHash, block: Number(rc.blockNumber), logIndex: Number(l.logIndex), units: l.args.value, payer: l.args.from } : null;
}

const MAX_MEMO_LOOKUPS = 40;

/**
 * Has the agent paid THIS nTag deposit? dep = { hash, block, logIndex, units, payer }; token = the deposited token
 * ("USDT" | "CNGN"); owner + claimBlock = the owner at deposit time and their winning claim's block; rate = loadRate().
 * Lists the agent's payouts to the owner since the claim and the owner's other nTag deposits (memo to this tag) that
 * one of them could belong to, then matches them in order (matchNtagPayout). Returns { status: "paid" | "maybe" |
 * "none" | "ineligible", payout?, reason? }. Anything it can't see completely turns "paid" into "maybe".
 */
async function checkNtagPayout(pub, { tag, owner, token, dep, claimBlock, rate, currency = "cngn" }) {
  const why = depositIneligible({ token, units: dep.units, payer: dep.payer, owner }, rate);
  if (why) return { status: "ineligible", reason: why };
  const sell = token === "CNGN" ? CNGN : USDT;
  const buy = token === "CNGN" ? USDT : TOKENS[currencyOf(currency ?? "cngn").token.toUpperCase()];
  const out = await transfersToAddress(owner, { token: buy.address, sinceBlock: claimBlock, pages: 10 });
  const payouts = out.items.filter((t) => lc(t.from) === lc(AGENT) && lc(t.to) === lc(owner) && lc(t.token) === lc(buy.address) && t.block > claimBlock);
  if (!payouts.some((p) => isAfter(p, dep))) return { status: "none" };
  const target = { ...dep, expected: expectedPayoutUnits(token, dep.units, rate, currency) };
  if (target.expected == null) return matchNtagPayout({ target, payouts }); // no rate: never "paid"
  // Other deposits to the agent since the claim whose value could explain one of these payouts: check their memo.
  const ins = await transfersToAddress(AGENT, { token: sell.address, sinceBlock: claimBlock, pages: 10 });
  const fitsSome = (t, expected) => expected != null && payouts.some((p) => isAfter(p, t) && matchNtagPayout({ target: { ...t, expected }, payouts: [p] }).status === "paid");
  const near = ins.items
    .filter((t) => lc(t.to) === lc(AGENT) && lc(t.token) === lc(sell.address) && t.block > claimBlock && !sameLog(t, dep))
    .map((t) => ({ ...t, expected: expectedPayoutUnits(token, t.units, rate, currency) }))
    .filter((t) => fitsSome(t, t.expected));
  const others = [];
  for (const t of near.slice(0, MAX_MEMO_LOOKUPS)) {
    const tx = await pub.getTransaction({ hash: t.hash });
    const m = decodeNtagPayment(tx.input);
    if (m?.tag !== tag || (m.currency ?? "cngn") !== (token === "CNGN" ? "cngn" : currency ?? "cngn") || lc(tx.from) !== lc(t.from) || lc(tx.to) !== lc(sell.address)) continue;
    if (depositIneligible({ token, units: t.units, payer: t.from, owner }, rate)) continue;
    others.push(t);
  }
  const r = matchNtagPayout({ target, deposits: others, payouts });
  const partial = !out.complete || !ins.complete || near.length > MAX_MEMO_LOOKUPS;
  return r.status === "paid" && partial ? { ...r, status: "maybe" } : r;
}

/** USD the agent paid a wallet in the last 24 h and what is left of the per-wallet daily cap. Pure. */
export function walletAllowance(usedUnits) {
  const cap = BigInt(Math.round(WALLET_DAY_USD * 1e6));
  const used = BigInt(usedUnits);
  return { usedUnits: used, leftUnits: used < cap ? cap - used : 0n, capUnits: cap };
}

/**
 * How much more `owner` can receive from the agent today: the agent's USD₮ and cNGN payouts to that wallet in the last
 * 24 h (Blockscout token transfers; cNGN valued at the live rate) against the per-wallet daily cap. Never throws:
 * { error } when it can't tell.
 */
async function dailyAllowance(owner, rate, now = Date.now()) {
  try {
    const sinceSec = Math.floor(now / 1000) - 86400;
    const toks = Object.values(TOKENS); // USD₮ and every local currency the agent pays out
    const lists = await Promise.all(toks.map((t) => transfersToAddress(owner, { token: t.address, sinceSec, pages: 10 })));
    if (lists.some((l) => !l.complete)) return { error: "too many transfers to check" };
    const perUsd = Object.fromEntries(CURRENCIES.map((c) => [c.code, rateFor(rate, c.code)]));
    for (const [i, t] of toks.entries()) {
      if (!t.currency || perUsd[t.currency] > 0) continue;
      if (lists[i].items.some((x) => lc(x.from) === lc(AGENT) && x.time >= sinceSec)) return { error: `no ${currencyOf(t.currency).plural} rate right now` };
    }
    return walletAllowance(agentPaidUsd(lists.flatMap((l) => l.items), { owner, sinceSec, ngnPerUsd: perUsd.cngn, perUsd }));
  } catch (e) {
    return { error: e.message };
  }
}

/**
 * USD value (6-dp) the agent paid `owner` since `sinceSec`: USD₮ as is, cNGN at `ngnPerUsd`, any other local currency at
 * `perUsd[code]` (local money per 1 USD₮). Pure.
 */
export function agentPaidUsd(transfers, { agent = AGENT, owner, sinceSec, ngnPerUsd, perUsd = {} }) {
  const lc = (s) => String(s).toLowerCase();
  let sum = 0n;
  for (const t of transfers) {
    if (lc(t.from) !== lc(agent) || lc(t.to) !== lc(owner) || t.time < sinceSec) continue;
    if (lc(t.token) === lc(USDT.address)) { sum += t.units; continue; }
    const cur = CURRENCIES.find((x) => lc(x.address) === lc(t.token));
    const r = cur?.code === "cngn" ? Number(ngnPerUsd) || Number(perUsd.cngn) : Number(perUsd[cur?.code]);
    if (cur && r > 0) sum += BigInt(Math.floor((Number(t.units) / 10 ** cur.decimals / r) * 1e6));
  }
  return sum;
}

/** Plain-English wallet / network errors. */
export function explainError(e) {
  const parts = [];
  for (let x = e, i = 0; x && i < 8; x = x.cause, i++) parts.push(`${x.name ?? ""} ${x.shortMessage ?? ""} ${x.message ?? ""} ${x.details ?? ""} ${x.code ?? ""}`);
  const all = parts.join(" ").toLowerCase();
  if (/insufficient funds|exceeds the balance|gas required exceeds|insufficientfunds/.test(all)) return "Not enough CELO to pay the network fee. Add a little CELO (0.05 is plenty) to your wallet and try again.";
  if (/transfer amount exceeds balance|exceeds balance/.test(all)) return "Your token balance is too low for this payment.";
  if (/nonce too low|replacement transaction underpriced|already known/.test(all)) return "Your wallet has another transaction in flight. Wait a moment and try again.";
  if (/user rejected|cancelled/.test(all)) return "Cancelled.";
  if (/fetch failed|enotfound|econnrefused|econnreset|etimedout|timeout|timed out|network|socket|httprequesterror|eai_again/.test(all)) return "Network problem: could not reach the Celo network. Check your connection (or set CELO_RPC_URL) and try again.";
  return e?.shortMessage ?? e?.message ?? String(e);
}

// ---------- commands ----------

const out = (...a) => console.log(...a);
const ok = (s) => out(`${c.green("✓")} ${s}`);
const warn = (s) => out(`${c.yellow("!")} ${s}`);

function cmdHelp() {
  out(`${c.bold("lokal")}: send money to a Lokal tag (@handle) on Celo, from your own wallet. Lokal: pay anyone in their local money.
(The old name, ntag, runs the same command.)

${c.bold("Get started")}
  lokal wallet new                  create your wallet (key encrypted with a send password)
  lokal wallet import               use a wallet you already have (key typed hidden, or NTAG_PRIVATE_KEY)
  lokal wallet                      address, CELO / USD₮ / cNGN balances and your Lokal tag

${c.bold("Pay someone")}
  lokal whois ada                   who owns the Lokal tag @ada
  lokal send ada 10                 you send $10 USD₮, @ada gets their preferred currency (else naira)
  lokal send ada 10 --to rupiah     ... and @ada gets rupiah (IDRX); also naira, argentina-peso, colombia-peso
  lokal send ada 14000 --dollars    you send ₦14,000 cNGN, @ada gets dollars (USD₮)
  lokal status 0x<txhash>           is that payment confirmed and paid out?
  In PowerShell a leading @ is special: write ada, or put it in quotes ('@ada').

${c.bold("Your own tag")}
  lokal claim ada --name "Ada Obi"  claim @ada for your wallet (public and permanent)
  lokal claim ada --to rupiah       set (or change) the currency you prefer to receive
  lokal release                     give up your tag (locked for you for ${RELEASE_LOCK_DAYS} days)

${c.bold("Send password")}
  Your key is stored encrypted. send, claim and release ask for your send password after you confirm,
  before anything is signed. 3 tries per command; 5 wrong in 10 minutes locks the wallet for 5 minutes.
  lokal wallet password             change it (asks for the old one, then the new one twice)
  There is no recovery: if you forget it, re-import your own key backup with a new password.

${c.bold("Options")}
  --to X        what they receive: naira, rupiah, argentina-peso or colombia-peso (codes cngn, idrx, wars,
                wcop and ISO codes NGN, IDR, ARS, COP work too). Default: the tag's preferred currency, else naira
  --dollars     pay in cNGN so the owner gets dollars (default: pay USD₮, owner gets local money)
  --yes, -y     skip typing the tag to confirm (for scripts)
  --wait        after sending, wait for the agent's payout and print the receipt number
  --dry-run     show the exact transaction (to / data / value) and send nothing
  --name "..."  display name for claim (1-40 characters)

${c.bold("Limits")}  ${LIMITS_TEXT}.
  USD₮: $1.00 to $${CAP_USD.toFixed(2)} per payment. cNGN: worth at least $1, and ${CNGN_LIMIT_TEXT}.
  At most 2 decimals. "lokal whois ada" and "lokal send" show how much more @ada can receive today.
${c.bold("Gas")}     every send needs a little CELO in your wallet for the network fee.

${c.bold("PowerShell examples")}
  PS> lokal send ada 10 --wait
  PS> npm run lokal -- send ada 5.50 --dry-run   # from a checkout, without npm link
  PS> node src/ntag.mjs wallet import            # paste the key at the hidden prompt, then pick a send password
  PS> $env:NTAG_WALLET_FILE = "D:\\keys\\lokal.json"; lokal wallet

${c.bold("Settings")}  NTAG_WALLET_FILE (default ${DEFAULT_WALLET_FILE}; a wallet made before the rename,
  in ${LEGACY_WALLET_FILE}, keeps being used there), CELO_RPC_URL (default Forno).
  NTAG_PASSWORD (and NTAG_OLD_PASSWORD for "wallet password") answer the password prompts for scripts.
  That is less safe: environment variables can be read by other programs you run. The key itself is never stored
  unencrypted either way.`);
}

async function cmdWallet(args, flags) {
  const sub = (args[0] ?? "").toLowerCase();
  if (sub === "new") return walletNew();
  if (sub === "import") return walletImport();
  if (sub === "password") return walletPassword();
  if (sub === "export") throw new UsageError("lokal does not export keys. Keep your own backup of the key you imported.");
  if (sub && sub !== "show") throw new UsageError(`Unknown wallet command "${args[0]}". Use: lokal wallet, lokal wallet new, lokal wallet import, lokal wallet password.`);
  return walletShow(flags);
}

const NO_RECOVERY = "There is no password recovery. If you forget the send password, the only way back is your own key backup.";

async function walletNew() {
  const file = walletFile();
  assertNotAgentKey({ keyPath: file });
  if (fs.existsSync(file)) throw new CliError(`You already have a wallet at ${file}. lokal never overwrites a wallet.`);
  const password = await chooseNewPassword();
  const address = saveWallet(generatePrivateKey(), password, file);
  ok(`New wallet created: ${c.bold(address)}`);
  out(`  Saved, encrypted with your send password, to ${file}`);
  warn(`Back up that file now (a USB stick or password manager) and remember the password. You need BOTH to spend. ${NO_RECOVERY} lokal never shows or exports the key.`);
  out(`  Next: send a little CELO (for fees) and some USD₮ to ${address}, then run "lokal wallet".`);
}

async function walletImport() {
  const file = walletFile();
  assertNotAgentKey({ keyPath: file });
  if (fs.existsSync(file)) throw new CliError(`You already have a wallet at ${file}. lokal never overwrites a wallet.`);
  let raw = process.env.NTAG_PRIVATE_KEY;
  if (raw) out("Using the key from NTAG_PRIVATE_KEY.");
  else raw = await readLine("Paste your private key (hidden), then press Enter: ", { hidden: true });
  const key = normalizePrivateKey(raw);
  raw = null;
  const address = privateKeyToAccount(key).address;
  assertNotAgentKey({ address });
  let tag = null;
  try { tag = ntagOf(resolveNtags(await discoverOps()), address); } catch { /* offline is fine */ }
  const password = await chooseNewPassword({ tag, address });
  saveWallet(key, password, file);
  ok(`Wallet imported: ${c.bold(address)}${tag ? ` (@${tag})` : ""}`);
  out(`  Saved, encrypted with your send password, to ${file}`);
  warn(`Keep your own backup of the key. ${NO_RECOVERY}`);
}

async function walletPassword() {
  const file = walletFile();
  const { address } = loadWallet(file);
  let tag = null;
  try { tag = ntagOf(resolveNtags(await discoverOps()), address); } catch { /* offline is fine */ }
  const st = lockoutState(readAttempts(file), Date.now());
  if (st.locked) throw new CliError(`Too many wrong passwords. Try again in about ${Math.max(1, Math.ceil((st.retryAt - Date.now()) / 60_000))} minutes.`);
  const old = process.env.NTAG_OLD_PASSWORD ?? (await readLine("Current send password (hidden): ", { hidden: true }));
  try { decryptKey(readKeystore(file), old); } catch (e) {
    if (e instanceof WrongPasswordError) { writeAttempts(file, recordFailure(readAttempts(file), Date.now())); throw new CliError(`Wrong password. Nothing changed. ${NO_RECOVERY}`); }
    throw e;
  }
  writeAttempts(file, []);
  const next = await chooseNewPassword({ tag, address }, "New send password");
  changePassword(file, old, next, { tag });
  ok("Send password changed. The old one no longer works.");
}

async function walletShow() {
  const account = loadWallet(); // address only; no password needed to look
  const pub = makePublic();
  const [celoBal, usdt, cngn, ops] = await Promise.all([
    pub.getBalance({ address: account.address }),
    balanceOf(pub, USDT.address, account.address),
    balanceOf(pub, CNGN.address, account.address),
    discoverOps().catch(() => null),
  ]);
  const tag = ops ? ntagOf(resolveNtags(ops), account.address) : undefined;
  out(formatBox("Your wallet", [
    ["Address", account.address],
    ["CELO", fmtCelo(celoBal)],
    ["USD₮", fmtUsd(usdt)],
    ["cNGN", fmtNgn(cngn)],
    ["Lokal tag", tag ? `@${tag}` : tag === null ? `none yet (lokal claim <name>)` : "could not load"],
  ], { color: useColor() }));
  if (celoBal === 0n) warn("You have no CELO, so you can't pay network fees yet. Add a little CELO first.");
}

async function cmdWhois(args) {
  if (!args[0]) throw new UsageError("Usage: lokal whois ada");
  const pub = makePublic();
  if (isAddress(args[0])) {
    const tag = ntagOf(resolveNtags(await discoverOps()), args[0]);
    out(tag ? `${getAddress(args[0])} is @${tag}` : `${getAddress(args[0])} has no Lokal tag.`);
    return;
  }
  const tag = parseTag(args[0]);
  const { entry, state } = await resolveVerified(pub, tag);
  if (!entry) {
    const a = ntagAvailability(state, tag, null);
    const why = { reserved: "It is reserved and can't be claimed.", locked: "It was released recently and is locked for its previous owner for now.", free: `Anyone can claim it: lokal claim ${tag}` }[a] ?? "";
    out(`@${tag} is not claimed. ${why}`.trim());
    process.exitCode = 1;
    return;
  }
  const allowance = await dailyAllowance(entry.owner, await loadRate());
  out(formatBox(`@${tag}`, [
    ["Name", entry.name ?? c.dim("(no display name)")],
    ["Owner", entry.owner],
    ["Prefers", `${currencyText(entry.currency)}${entry.currency ? "" : c.dim("  (the default; the owner hasn't chosen)")}`],
    ["Since", isoDay(entry.since)],
    ["Claim tx", celoscanTx(entry.hash)],
    ["Checked", "claim verified on the Celo network"],
    ["Today", todayText(tag, allowance)],
    ["Limits", LIMITS_TEXT],
  ], { color: useColor() }));
}

async function cmdSend(args, flags) {
  if (args.length < 2) throw new UsageError("Usage: lokal send ada 10 [--to rupiah]   (or --dollars to pay in cNGN)");
  if (args.length > 2) throw new UsageError(`Too many values: ${args.slice(2).join(" ")}. Usage: lokal send ada 10 [--to rupiah]`);
  const tag = parseTag(args[0]);
  const token = flags.dollars ? "CNGN" : "USDT";
  const chosen = flags.to != null ? parseCurrencyArg(flags.to) : flags.naira ? "cngn" : null; // null: the tag's preference
  const units = parseAmountUnits(args[1]);
  if (token === "USDT") checkAmount(units, token); // fail fast, before any network call

  const rate = await loadRate();
  const { usdUnits } = checkAmount(units, token, { reverseRate: rate?.reverseRate });

  const pub = makePublic();
  let account = null;
  try { account = loadWallet(); } catch (e) { if (!flags.dryRun) throw e; }

  out(c.dim(`Looking up @${tag}…`));
  const { entry } = await resolveVerified(pub, tag);
  if (!entry) throw new CliError(`@${tag} is not claimed by anyone, so there is nobody to pay. Nothing was sent.`);
  if (account && account.address.toLowerCase() === entry.owner.toLowerCase()) throw new CliError(`@${tag} is your own tag. You can't pay yourself.`);

  // What they receive: --to, else the tag's preferred currency, else naira. A currency Textile isn't quoting right now
  // would be refused by the agent (never paid in another one), so stop here instead.
  const currency = token === "CNGN" ? null : chosen ?? entry.currency ?? "cngn";
  if (currency && rate && !rateFor(rate, currency)) {
    throw new CliError(`${currencyText(currency)} isn't available on Textile FX right now, so the agent couldn't pay it out. Nothing was sent. Try again later or pick another currency with --to.`);
  }
  const maxUsd = currency ? Number(rate?.maxUsd?.[currency]) : 0;
  if (maxUsd > 0 && Number(units) / 1e6 > maxUsd) {
    throw new CliError(`Right now Textile FX can convert at most about $${maxUsd.toFixed(2)} into ${currencyOf(currency).plural}. Send less, or choose another currency with --to. Nothing was sent.`);
  }
  const preferText = token === "USDT" && entry.currency && currency !== entry.currency ? `${currencyText(entry.currency)}; you chose ${currencyOf(currency).plural}` : null;
  const tx = buildTransfer({ token, units, tag, currency: currency ?? undefined });
  const tok = token === "CNGN" ? CNGN : USDT;
  let feeWei = null;
  if (account) {
    const [bal, celoBal] = await Promise.all([balanceOf(pub, tok.address, account.address), pub.getBalance({ address: account.address })]);
    if (bal < units) throw new CliError(`Not enough ${token === "CNGN" ? "cNGN" : "USD₮"}: you have ${fmtToken(bal, token)} and this payment is ${fmtToken(units, token)}.`);
    const { fee } = await estimateFee(pub, tx, account.address);
    feeWei = fee;
    if (celoBal < fee) throw new CliError(`No CELO for gas: the network fee is about ${fmtCelo(fee, 5)} and you have ${fmtCelo(celoBal, 5)}. Add a little CELO and try again.`);
  } else {
    try { feeWei = (await estimateFee(pub, tx, AGENT)).fee; } catch { feeWei = null; }
  }

  // The owner's wallet may only receive $25 a day from the agent. Over that, the agent refuses the payment (it stays
  // with the agent for review), so refuse it here, before anything is sent.
  const allowance = await dailyAllowance(entry.owner, rate);
  if (!allowance.error && usdUnits > allowance.leftUnits) {
    throw new CliError(
      `${todayText(tag, allowance)}, and this payment is about ${fmtUsd(usdUnits)}. The agent would not pay it out automatically. ` +
      `${allowance.leftUnits >= BigInt(MIN_USD * 1e6) ? `Send at most about ${fmtUsd(allowance.leftUnits)}, or try again tomorrow.` : "Try again tomorrow."} Nothing was sent.`,
    );
  }

  const est = estimateReceive(token, units, rate, currency ?? "cngn");
  out("");
  out(formatSummary({ tag, name: entry.name, owner: entry.owner, token, units, receiveText: est.text, rateText: est.rateText, feeWei, fromAddress: account?.address, todayText: todayText(tag, allowance), preferText }, { color: useColor() }));
  out(c.dim(`  The agent pays @${tag}'s wallet ${shortAddr(entry.owner)} after your transfer confirms. The amount they get is an estimate at today's rate.`));

  if (flags.dryRun) {
    out("");
    out(c.bold("Dry run: nothing sent. The exact transaction is:"));
    out(`  to:    ${tx.to}   (${token === "CNGN" ? "cNGN" : "USD₮"} token contract)`);
    out(`  value: ${tx.value}`);
    out(`  data:  ${tx.data}`);
    out(c.dim(`  The data is transfer(${AGENT}, ${units}) + "NTP:${tag}${currency && currency !== "cngn" ? ":" + currency : ""}" + attribution suffix.`));
    return;
  }

  if (!flags.yes) {
    const answer = await ask(`\nType ${c.bold("@" + tag)} to send ${fmtToken(units, token)}, or press Enter to cancel: `);
    if (!typedTagMatches(answer, tag)) throw new CliError(answer ? `You typed "${answer}", which is not @${tag}. Nothing was sent.` : "Cancelled. Nothing was sent.");
  }

  // Password after the summary and the typed tag, before signing. Then re-check the owner right before sending, in
  // case the tag changed hands while you were reading.
  const hash = await signAndSend(account.file, tx, async () => {
    const again = await resolveVerified(pub, tag);
    if (!again.entry || again.entry.owner.toLowerCase() !== entry.owner.toLowerCase()) {
      throw new CliError(`@${tag} changed owner a moment ago. Nothing was sent; run the command again to see the new owner.`);
    }
  });
  out(`Sent. Waiting for confirmation… ${c.dim(hash)}`);
  let rc;
  try { rc = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 }); } catch (e) {
    throw new CliError(`Sent, but not confirmed yet (${explainError(e)}). Check it later with: lokal status ${hash}`);
  }
  if (rc.status !== "success") throw new CliError(`The transfer failed onchain and no tokens moved. See ${celoscanTx(hash)}`);
  ok(`Confirmed in block ${rc.blockNumber}. ${celoscanTx(hash)}`);
  if (!flags.wait) {
    out(`  @${tag} is paid when the agent's autopilot runs. Follow it with: lokal status ${hash}`);
    return;
  }
  const dep = depositFromReceipt(rc, tok.address) ?? { hash, block: Number(rc.blockNumber), logIndex: 0, units, payer: account.address };
  await waitForPayout(pub, { owner: entry.owner, token, tag, dep, claimBlock: Number(entry.block), rate, currency: currency ?? "cngn" });
}

/** One line about a payout check, for status and --wait. */
function payoutRows(tag, r, buyToken) {
  if (r.status === "paid") {
    const no = receiptNo(r.payout.hash);
    return [["Payout", `${c.green("paid")} ${fmtToken(r.payout.units, buyToken)}`], ["Receipt", no], ["Receipt link", receiptNoLink(no)]];
  }
  if (r.status === "maybe") {
    return [["Payout", c.yellow(`a payout to @${tag} was sent at ${new Date(r.payout.time * 1000).toISOString()}; it may be for another payment`)], ["That payout", celoscanTx(r.payout.hash)]];
  }
  if (r.status === "ineligible") return [["Payout", c.red(`not paid automatically: ${r.reason}`)]];
  return [["Payout", c.yellow("not yet")]];
}

/**
 * Unlocks the wallet (password prompt), runs `beforeSign` (last-moment checks), signs and sends `tx`, then drops the
 * in-memory account. Returns the tx hash. A wrong password or failed check sends nothing.
 */
async function signAndSend(file, tx, beforeSign) {
  let account = await unlockWallet(file);
  try {
    if (beforeSign) await beforeSign(account);
    const wallet = createWalletClient({ account, chain: celo, transport: http(RPC_URL, { timeout: 30_000 }) });
    try { return await wallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ?? 0n }); } catch (e) { throw new CliError(explainError(e)); }
  } finally { account = null; }
}

async function waitForPayout(pub, { owner, token, tag, dep, claimBlock, rate, currency = "cngn" }) {
  const buyToken = token === "CNGN" ? "USDT" : currencyOf(currency).token.toUpperCase();
  const until = Date.now() + WAIT_MINUTES * 60_000;
  out(c.dim(`Waiting for the agent to pay @${tag} (up to ${WAIT_MINUTES} min; Ctrl+C stops waiting, your payment is safe)…`));
  let last = null;
  while (Date.now() < until) {
    try {
      const r = await checkNtagPayout(pub, { tag, owner, token, dep, claimBlock, rate, currency });
      if (r.status === "paid") {
        if (process.stdout.isTTY) process.stdout.write("\n");
        const no = receiptNo(r.payout.hash);
        ok(`Paid out: ${fmtToken(r.payout.units, buyToken)} to @${tag}. Receipt ${c.bold(no)}`);
        out(`  ${receiptNoLink(no)}`);
        out(`  ${celoscanTx(r.payout.hash)}`);
        return;
      }
      // Matched to this deposit but it could also be another one's: waiting longer can't settle that.
      if (r.status === "ineligible" || (r.status === "maybe" && r.assigned)) { last = r; break; }
      last = r;
    } catch { /* keep waiting through explorer hiccups */ }
    if (process.stdout.isTTY) process.stdout.write(".");
    await sleep(15_000);
  }
  if (process.stdout.isTTY) process.stdout.write("\n");
  if (last?.status === "maybe") { warn(`A payout to @${tag} was sent at ${new Date(last.payout.time * 1000).toISOString()}; it may be for another payment. ${celoscanTx(last.payout.hash)}`); return; }
  if (last?.status === "ineligible") { warn(`The agent does not pay this deposit automatically: ${last.reason}.`); return; }
  warn(`No payout seen yet. Your deposit is confirmed; the agent pays when autopilot next runs. Check later with lokal status ${dep.hash}.`);
}

async function cmdClaim(args, flags) {
  if (!args[0]) throw new UsageError('Usage: lokal claim ada [--name "Ada Obi"] [--to rupiah]');
  if (args.length > 1) throw new UsageError(`Unexpected "${args.slice(1).join(" ")}". Put a display name in quotes after --name.`);
  const tag = parseTag(args[0]);
  if (flags.name != null) {
    const e = ntagNameError(flags.name);
    if (e) throw new UsageError(`Display name: ${e}.`);
  }
  const prefer = flags.to != null ? parseCurrencyArg(flags.to) : null;
  const data = encodeNtagClaim({ t: tag, ...(flags.name != null ? { n: flags.name } : {}), ...(prefer ? { c: prefer } : {}) });
  const account = loadWallet();
  const pub = makePublic();
  const ops = await discoverOps();
  const state = resolveNtags(ops);
  const avail = ntagAvailability(state, tag, account.address);
  const current = ntagOf(state, account.address);
  const msg = {
    free: `@${tag} is free.`,
    yours: `@${tag} is already yours.`,
    taken: `@${tag} is taken by ${shortAddr(ownerOf(state, tag)?.owner)}.`,
    reserved: `@${tag} is reserved and can't be claimed.`,
    locked: `@${tag} was released recently and is locked for its previous owner (up to ${RELEASE_LOCK_DAYS} days).`,
    invalid: `@${tag} is not a valid tag.`,
  }[avail];
  if (avail !== "free" && avail !== "yours") throw new CliError(msg);
  if (avail === "yours") {
    const cur = ownerOf(state, tag);
    const rename = flags.name != null && flags.name.trim() !== cur?.name;
    const recur = prefer != null && prefer !== (cur?.currency ?? null);
    if (!rename && !recur) { ok(`${msg} Nothing to do.`); return; }
    if (rename) out(`${msg} This will change its display name to "${flags.name.trim()}".`);
    if (recur) out(`${rename ? "It" : msg + " This"} will set the currency you prefer to receive to ${currencyText(prefer)}.`);
  } else {
    ok(msg);
    if (current) warn(`Claiming @${tag} releases your current tag @${current}, which then stays locked for you for ${RELEASE_LOCK_DAYS} days.`);
  }
  await sendOp(pub, account, data, flags, {
    notice: `Tags and display names are public and permanent: they are written to the Celo blockchain and can be seen by anyone, forever.`,
    confirmWord: "yes",
    after: (st) => {
      const now = resolveNtags(st.ops);
      if (ntagOf(now, account.address) === tag) {
        const e = ownerOf(now, tag);
        ok(`@${tag} is yours${e?.name ? ` (${e.name})` : ""}${e?.currency ? `, and you prefer ${currencyText(e.currency)}` : ""}. People can now pay you with: lokal send ${tag} 10`);
        return;
      }
      const s = st.status;
      if (s === "taken") throw new CliError(`Someone claimed @${tag} a moment before you, so it is not yours. Your transaction only cost a network fee. Try another tag.`);
      if (s === "locked") throw new CliError(`@${tag} is locked for its previous owner, so the claim did not count.`);
      throw new CliError(`The claim was recorded but did not take effect (${s ?? "unknown"}). Run "lokal whois @${tag}".`);
    },
  });
}

async function cmdRelease(args, flags) {
  if (args.length) throw new UsageError("Usage: lokal release   (releases your current tag)");
  const account = loadWallet();
  const pub = makePublic();
  const state = resolveNtags(await discoverOps());
  const tag = ntagOf(state, account.address);
  if (!tag) { out("This wallet has no Lokal tag, so there is nothing to release."); return; }
  out(`Your tag is @${tag}.`);
  await sendOp(pub, account, encodeNtagRelease(), flags, {
    notice: `Releasing @${tag} stops payments to it. It stays locked for you for ${RELEASE_LOCK_DAYS} days, then anyone can claim it. The release is public and permanent onchain.`,
    confirmWord: tag,
    after: (st) => {
      if (ntagOf(resolveNtags(st.ops), account.address)) throw new CliError(`The release was recorded but you still hold a tag. Run "lokal wallet".`);
      ok(`@${tag} released.`);
    },
  });
}

/** Sends a zero-value nTag op to the agent, waits for it, then re-resolves until Blockscout shows it. */
async function sendOp(pub, account, data, flags, { notice, confirmWord, after }) {
  const tx = { to: AGENT, data, value: 0n };
  const [celoBal, { fee }] = await Promise.all([pub.getBalance({ address: account.address }), estimateFee(pub, tx, account.address)]);
  out(formatBox("Transaction", [["To", `${shortAddr(AGENT)} (the payout agent)`], ["Value", "0 (free apart from the network fee)"], ["Network fee", `≈ ${fmtCelo(fee, 5)}`], ["From", shortAddr(account.address)]], { color: useColor() }));
  warn(notice);
  if (flags.dryRun) {
    out(c.bold("Dry run: nothing sent."));
    out(`  to:    ${tx.to}\n  value: 0\n  data:  ${tx.data}`);
    return;
  }
  if (celoBal < fee) throw new CliError(`No CELO for gas: the fee is about ${fmtCelo(fee, 5)} and you have ${fmtCelo(celoBal, 5)}.`);
  if (!flags.yes) {
    const label = confirmWord === "yes" ? `"yes"` : `@${confirmWord}`;
    const a = await ask(`Type ${c.bold(label)} to continue: `);
    const good = confirmWord === "yes" ? a.toLowerCase() === "yes" : typedTagMatches(a, confirmWord);
    if (!good) throw new CliError("Cancelled. Nothing was sent.");
  }
  const hash = await signAndSend(account.file, tx);
  out(`Sent. Waiting for confirmation… ${c.dim(hash)}`);
  const rc = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 }).catch((e) => { throw new CliError(`Not confirmed yet (${explainError(e)}). Check later: lokal status ${hash}`); });
  if (rc.status !== "success") throw new CliError(`The transaction failed onchain. ${celoscanTx(hash)}`);
  ok(`Confirmed. ${celoscanTx(hash)}`);
  out(c.dim("Waiting for the explorer to index it…"));
  const until = Date.now() + 180_000;
  while (Date.now() < until) {
    try {
      const ops = await discoverOps(); // incremental after the first load: cheap to poll
      if (ops.some((o) => o.hash.toLowerCase() === hash.toLowerCase())) {
        const status = resolveNtags(ops).statuses.get(ops.find((o) => o.hash.toLowerCase() === hash.toLowerCase()).hash);
        return after({ ops, status });
      }
    } catch { /* retry */ }
    await sleep(8_000);
  }
  warn(`Confirmed onchain, but the explorer has not shown it yet. Check in a minute with "lokal wallet".`);
}

async function cmdStatus(args) {
  const hash = args[0];
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(hash ?? ""))) throw new UsageError("Usage: lokal status 0x<64 hex transaction hash>");
  const pub = makePublic();
  let tx;
  try { tx = await pub.getTransaction({ hash }); } catch (e) {
    if (/not be found|not found/i.test(String(e?.shortMessage ?? e?.message))) throw new CliError("No such transaction on Celo (yet). If you just sent it, wait a few seconds.");
    throw new CliError(explainError(e));
  }
  const rc = await pub.getTransactionReceipt({ hash }).catch(() => null);
  const confirmed = rc ? (rc.status === "success" ? c.green("confirmed") : c.red("failed")) : c.yellow("pending");
  const to = String(tx.to ?? "").toLowerCase();

  if (to === AGENT.toLowerCase() && decodeNtagOp(tx.input)) {
    const op = decodeNtagOp(tx.input);
    out(formatBox("Lokal tag " + (op?.t ? "claim" : "release"), [["Tag", op?.t ? `@${op.t}` : "(release)"], ["From", tx.from], ["Status", confirmed], ["Link", celoscanTx(hash)]], { color: useColor() }));
    if (rc?.status === "success") {
      const ops = await discoverOps();
      const found = ops.find((o) => o.hash.toLowerCase() === hash.toLowerCase());
      out(found ? `Result: ${resolveNtags(ops).statuses.get(found.hash) ?? "unknown"}` : "Not indexed by the explorer yet.");
    }
    return;
  }

  const memo = decodeNtagPayment(tx.input);
  const tag = memo?.tag ?? null;
  const currency = memo?.currency ?? "cngn";
  const tr = parseTransferCalldata(tx.input);
  const token = to === USDT.address.toLowerCase() ? "USDT" : to === CNGN.address.toLowerCase() ? "CNGN" : null;
  if (!tag || !tr || !token || tr.to.toLowerCase() !== AGENT.toLowerCase()) {
    out("This is not a Lokal tag payment (no tag memo on a USD₮ / cNGN transfer to the agent).");
    process.exitCode = 1;
    return;
  }
  const rows = [["Tag", `@${tag}`], ["Paid", fmtToken(tr.units, token)], ["They get", token === "CNGN" ? "dollars (USD₮)" : currencyText(currency)], ["From", tx.from], ["Status", confirmed]];
  let owner = null;
  let e = null;
  if (rc?.status === "success") {
    const ops = await discoverOps();
    e = ownerOf(resolveNtagsBefore(ops, Number(rc.blockNumber), Number(rc.transactionIndex)), tag);
    owner = e ? getAddress(e.owner) : null;
    rows.push(["Owner then", owner ? `${owner}${e.name ? ` (${e.name})` : ""}` : c.red("nobody (the agent refuses it)")]);
  }
  rows.push(["Deposit", celoscanTx(hash)]);
  if (owner) {
    const dep = depositFromReceipt(rc, token === "CNGN" ? CNGN.address : USDT.address)
      ?? { hash, block: Number(rc.blockNumber), logIndex: 0, units: tr.units, payer: tx.from };
    let r = null;
    try { r = await checkNtagPayout(pub, { tag, owner, token, dep, claimBlock: Number(e.block), rate: await loadRate(), currency }); } catch { /* shown as unknown */ }
    rows.push(...(r ? payoutRows(tag, r, token === "CNGN" ? "USDT" : currencyOf(currency).token.toUpperCase()) : [["Payout", c.yellow("could not check right now")]]));
  }
  out(formatBox("Lokal tag payment", rows, { color: useColor() }));
}

// ---------- main ----------

export async function main(argv = process.argv.slice(2)) {
  c = palette(useColor());
  try {
    const { cmd, args, flags } = parseArgs(argv);
    if (flags.help || cmd === "help") { cmdHelp(); return 0; }
    const note = process.env.NODE_TEST_CONTEXT ? null : legacyWalletNotice(); // tests never touch a real home folder
    if (note) console.error(`${c.yellow("!")} ${note}`);
    const run = { wallet: cmdWallet, whois: cmdWhois, send: cmdSend, pay: cmdSend, claim: cmdClaim, release: cmdRelease, status: cmdStatus }[cmd];
    if (!run) throw new UsageError(`Unknown command "${cmd}". Run "lokal help".`);
    await run(args, flags);
    return process.exitCode ?? 0;
  } catch (e) {
    const code = e?.exitCode ?? 1;
    const text = e instanceof UsageError || e instanceof CliError ? e.message : explainError(e);
    console.error(`${c.red(code === 2 ? "Usage:" : "Error:")} ${text}`);
    return code;
  }
}

const isMain = (() => {
  try { return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) main().then((code) => { process.exitCode = code; });
