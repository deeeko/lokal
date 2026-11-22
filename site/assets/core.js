// Shared data + behaviour for every page. No libraries, no keys.
// Celo RPC (Forno) and Blockscout are read straight from the browser. The Textile rate comes from
// rate.json, refreshed every 30 min by a GitHub Action (Textile's rates feed blocks other sites).

export const RPC = "https://forno.celo.org";
// On Vercel the site has a cached, read-only explorer proxy (/api/explorer) and a live rate (/api/rate).
// GitHub Pages and the local preview server have neither, so they call Blockscout and rate.json directly.
const HOST = typeof location !== "undefined" ? location.hostname : "";
export const HAS_API = Boolean(HOST) && !/github\.io$/.test(HOST) && !/^(localhost|127\.0\.0\.1)$/.test(HOST);
const BLOCKSCOUT = "https://celo.blockscout.com/api/v2";
export const EXPLORER_API = HAS_API ? "/api/explorer" : BLOCKSCOUT;
export const AGENT = "0x8a695cf54CB44753c8b784EB36d266f748617a1e";
export const AGENT_ID = 10079n;
export const REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
export const TAG = "celo_7360953d1b53";

// ---------- currencies (what a recipient can receive) ----------
// ---------- currencies: start ---------- (copied byte-for-byte into src/currencies.mjs; test/currencies.test.mjs checks it)
/** USD₮ on Celo mainnet: Textile FX quotes every local currency against it. */
export const USDT_ADDRESS = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e";
export const USDT_DECIMALS = 6;
/**
 * What a recipient can receive, in display order. `code` is the id used in corridors ("usdt-<code>"), Lokal tag memos
 * ("NTP:ada:<code>") and tag preferences ({"t":"ada","c":"<code>"}). `decimals` are the token's onchain decimals;
 * `places` are the decimals shown to people (amounts are always rounded DOWN to them); `plural` reads in a sentence
 * ("they get rupiah"). `locale` is the country's own
 * number format (Intl), shown as a tooltip next to English-formatted amounts.
 */
export const CURRENCIES = [
  {
    code: "cngn", token: "cNGN", address: "0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f", decimals: 6, places: 2, iso: "NGN",
    symbol: "₦", label: "Naira", name: "Nigerian naira", plural: "naira", country: "Nigeria", city: "Lagos", flag: "🇳🇬", locale: "en-NG",
    aliases: ["naira", "ngn", "nigeria", "nigerian-naira"],
  },
  {
    code: "idrx", token: "IDRX", address: "0x18Bc5bcC660cf2B9cE3cd51a404aFe1a0cBD3C22", decimals: 2, places: 0, iso: "IDR",
    symbol: "Rp", label: "Rupiah", name: "Indonesian rupiah", plural: "rupiah", country: "Indonesia", city: "Jakarta", flag: "🇮🇩", locale: "id-ID",
    aliases: ["rupiah", "idr", "indonesia", "indonesian-rupiah"],
  },
  {
    code: "wars", token: "wARS", address: "0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D", decimals: 18, places: 2, iso: "ARS",
    symbol: "ARS", label: "Peso (AR)", name: "Argentine peso", plural: "Argentine pesos", country: "Argentina", city: "Buenos Aires", flag: "🇦🇷", locale: "es-AR",
    aliases: ["argentina-peso", "argentine-peso", "ars", "argentina", "peso-ar"],
  },
  {
    code: "wcop", token: "wCOP", address: "0x8a1D45e102e886510e891d2Ec656a708991e2D76", decimals: 18, places: 0, iso: "COP",
    symbol: "COP", label: "Peso (CO)", name: "Colombian peso", plural: "Colombian pesos", country: "Colombia", city: "Bogotá", flag: "🇨🇴", locale: "es-CO",
    aliases: ["colombia-peso", "colombian-peso", "cop", "colombia", "peso-co"],
  },
];
/** What a payment pays out in when nobody chose: naira (Lokal tag memos without a code, older links). */
export const DEFAULT_CURRENCY = "cngn";
export const CURRENCY_CODES = CURRENCIES.map((c) => c.code);
/** The currency for an exact code ("idrx"), or null. */
export const currencyOf = (code) => CURRENCIES.find((c) => c.code === code) ?? null;
/** Loose input ("rupiah", "IDRX", "idr", "Peso (AR)", "argentina-peso", "COP") -> the currency, or null. */
export function findCurrency(input) {
  const s = String(input ?? "").trim().toLowerCase().replace(/[()]/g, "").replace(/[\s_]+/g, "-");
  if (!s) return null;
  return CURRENCIES.find((c) => c.code === s || c.token.toLowerCase() === s || c.iso.toLowerCase() === s
    || c.label.toLowerCase().replace(/[()]/g, "").replace(/\s+/g, "-") === s || c.name.toLowerCase().replace(/\s+/g, "-") === s
    || c.aliases.includes(s)) ?? null;
}
/** The payout corridor for a currency: "usdt-idrx". */
export const corridorFor = (code) => "usdt-" + code;
/** The currency a "usdt-<code>" corridor pays out in, or null for any other corridor. */
export const currencyOfCorridor = (id) => (/^usdt-[a-z]+$/.test(String(id)) ? currencyOf(String(id).slice(5)) : null);
/** Base units -> a plain decimal string rounded DOWN to `places` ("92035.51"). Never more than the units say. */
export function unitsToDecimal(units, decimals, places = decimals) {
  const v = BigInt(units);
  if (v < 0n) throw new Error("negative amount");
  const p = Math.max(0, Math.min(Number(places), Number(decimals)));
  const base = 10n ** BigInt(decimals);
  const frac = (v % base).toString().padStart(Number(decimals), "0").slice(0, p);
  return p > 0 ? `${v / base}.${frac}` : `${v / base}`;
}
const groupDigits = (s) => {
  const [w, f] = String(s).split(".");
  return w.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (f != null ? "." + f : "");
};
const withSymbol = (c, s) => (c.symbol.length > 1 ? `${c.symbol} ${s}` : `${c.symbol}${s}`);
/** "₦7,212.83" · "Rp 92,035" · "ARS 8,848.74" · "COP 17,332" from the token's base units, rounded down. */
export function formatCurrencyUnits(units, code, places) {
  const c = currencyOf(code);
  if (!c) throw new Error(`unknown currency "${code}"`);
  return withSymbol(c, groupDigits(unitsToDecimal(units, c.decimals, places ?? c.places)));
}
/** The same for an estimate (a number: amount x rate), rounded down; "—" when it isn't a usable number. */
export function formatCurrency(n, code, places) {
  const c = currencyOf(code);
  if (!c) throw new Error(`unknown currency "${code}"`);
  const p = places ?? c.places;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n >= 1e15) return "—";
  const f = 10 ** p;
  return withSymbol(c, groupDigits((Math.floor(n * f + 1e-7) / f).toFixed(p)));
}
/** The amount in the country's own format ("Rp 92.035"), for a tooltip; English format if Intl can't. */
export function nativeCurrency(n, code) {
  const c = currencyOf(code);
  if (!c) return "";
  try {
    const f = 10 ** c.places;
    return new Intl.NumberFormat(c.locale, { style: "currency", currency: c.iso, minimumFractionDigits: c.places, maximumFractionDigits: c.places }).format(Math.floor(n * f + 1e-7) / f);
  } catch { return formatCurrency(n, code); }
}
// ---------- currencies: end ----------

export const TOKENS = {
  USDT: { address: USDT_ADDRESS, symbol: "USD₮", decimals: USDT_DECIMALS },
  // cNGN, IDRX, wARS, wCOP (from CURRENCIES: address, decimals and the currency code)
  ...Object.fromEntries(CURRENCIES.map((c) => [c.token, { address: c.address, symbol: c.token, decimals: c.decimals, currency: c.code }])),
};
export const CAP = 25;
/** The agent's rolling 24-hour limits (src/config.mjs MAX_WALLET_DAILY_USD and MAX_DAILY_USD). */
export const WALLET_DAILY_CAP = 25;
export const DAILY_CAP = 100;
/** The one-line summary every page shows next to an amount. */
export const LIMITS_TEXT = `$${CAP} per payment · $${WALLET_DAILY_CAP} per person per day · $${DAILY_CAP} per day overall`;
export const REPUTATION = "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63"; // ERC-8004 Reputation Registry (proxy), Celo mainnet
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/**
 * The supported corridors (same ids as src/config.mjs). sell/buy are TOKENS keys; the amount typed is in the sell token.
 * usdt-<code>: you send USD₮, they receive that local currency. cngn-usdt: you send cNGN, they receive dollars.
 */
const payoutCorridor = (c) => ({
  id: corridorFor(c.code), sell: "USDT", buy: c.token, currency: c.code, label: `USD₮ → ${c.token}`, blurb: `Pay someone in ${c.label.toLowerCase()}`,
});
export const CORRIDORS = {
  "usdt-cngn": payoutCorridor(CURRENCIES[0]),
  "cngn-usdt": { id: "cngn-usdt", sell: "cNGN", buy: "USDT", label: "cNGN → USD₮", blurb: "Pay someone in dollars" },
  ...Object.fromEntries(CURRENCIES.slice(1).map((c) => [corridorFor(c.code), payoutCorridor(c)])),
};
/** The corridor object for an id, or null (own keys only: "toString" is not a corridor). */
export const corridorOf = (id) => (Object.prototype.hasOwnProperty.call(CORRIDORS, id) ? CORRIDORS[id] : null);
/** Function selectors (computed with viem, see SPEC). */
export const SEL = {
  giveFeedback: "0x3c036a7e", // giveFeedback(uint256,int128,uint8,string,string,string,string,bytes32)
  getClients: "0x42dd519c", // getClients(uint256) -> address[]
  readAllFeedback: "0xd9d84224", // readAllFeedback(uint256,address[],string,string,bool) -> (address[],uint64[],int128[],uint8[],string[],string[],bool[])
  transfer: "0xa9059cbb",
};
export const celoscanTx = (h) => `https://celoscan.io/tx/${h}`;
export const celoscanAddr = (a) => `https://celoscan.io/address/${a}`;
const MARKER = "80218021802180218021802180218021"; // ERC-8021 suffix marker

// ---------- formatting ----------
export const num2 = new Intl.NumberFormat("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const naira = (n) => "₦" + num2.format(n);
/**
 * Reads a typed money amount as exact cents, never guessing. Accepts "10", "10.5", "1,250.75", "₦14,400",
 * and a decimal comma "1,5" / "1,50" (= 1.50). Commas count as thousands separators only in groups of three.
 * Returns { cents } or { error } (plain-English message).
 */
export function parseMoneyInput(raw) {
  let s = String(raw ?? "").replace(/[\s₦$]/g, "").replace(/(usd₮?|usdt|cngn|ngn)$/i, "");
  if (!s) return { error: "Enter an amount." };
  if (/^\d+,\d{1,2}$/.test(s) && !/^\d{1,3},\d{3}$/.test(s)) s = s.replace(",", ".");
  else if (s.includes(",")) {
    if (!/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) return { error: "Use a dot for decimals, like 10.50." };
    s = s.replace(/,/g, "");
  }
  if (/^\d+\.\d{3,}$/.test(s)) return { error: "Use at most 2 decimals." };
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return { error: "Enter a number, like 10 or 10.50." };
  const [w, f = ""] = s.split(".");
  const cents = Number(w) * 100 + Number((f + "00").slice(0, 2));
  if (!Number.isSafeInteger(cents)) return { error: "That amount is too large." };
  return { cents };
}
export const usd = (n) => "$" + num2.format(n);
/** "just now" / "12 min ago" / "3 h ago" / "2 days ago", from loadRate()'s ageMin. */
export function ageText(ageMin) {
  const m = Math.max(0, Math.round(Number(ageMin) || 0));
  if (m < 1) return "just now";
  if (m < 120) return `${m} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} days ago`;
}
/** True for failures to reach a server (fetch TypeError, timeout/abort, HTTP status errors), not for bugs or bad data. */
export function isNetworkError(e) {
  if (!e) return false;
  if (e.name === "TimeoutError" || e.name === "AbortError" || e.retry) return true;
  if (e.name === "TypeError" && /fetch|network|load failed/i.test(String(e.message))) return true;
  return /^HTTP \d{3}\b/.test(String(e.message));
}
export const short = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "");
export const lagos = (d, opts) => new Date(d).toLocaleString("en-GB", { timeZone: "Africa/Lagos", ...opts });
export const lagosTime = (d) => lagos(d, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
export const lagosClock = (d) => lagos(d, { hour: "2-digit", minute: "2-digit" });
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------- network ----------
/** AbortSignal.timeout needs iOS 16+ / Chrome 103+; older phones (common in Nigeria) get the manual equivalent. */
export function timeoutSignal(ms) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);
  if (typeof AbortController === "undefined") return undefined;
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}
/** fetch JSON with a 12 s timeout and one retry on network errors, 429 and 5xx. If the Vercel proxy itself fails,
 *  fall back to calling Blockscout directly so the page still works. */
export async function getJson(url, init = {}, attempt = 0) {
  if (typeof url === "string" && url.startsWith("/api/explorer/")) {
    try { return await getJsonRaw(url, init, attempt); }
    catch { return getJsonRaw(BLOCKSCOUT + url.slice("/api/explorer".length), init, 0); }
  }
  return getJsonRaw(url, init, attempt);
}
async function getJsonRaw(url, init = {}, attempt = 0) {
  try {
    const r = await fetch(url, { ...init, signal: timeoutSignal(12_000) });
    if (r.status === 429 || r.status >= 500) throw Object.assign(new Error(`HTTP ${r.status}`), { retry: true });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    const retryable = e.retry || e.name === "TypeError" || e.name === "TimeoutError" || e.name === "AbortError";
    if (attempt === 0 && retryable) {
      await new Promise((res) => setTimeout(res, 800));
      return getJsonRaw(url, init, 1);
    }
    throw e;
  }
}
export async function rpc(method, params) {
  const j = await getJson(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
const pad = (hex) => hex.replace(/^0x/, "").padStart(64, "0");
const call = (to, data) => rpc("eth_call", [{ to, data }, "latest"]);
const hexBytes = (h) => new Uint8Array((h.match(/../g) ?? []).map((b) => parseInt(b, 16)));
function decodeString(hex) {
  const h = hex.replace(/^0x/, "");
  const off = parseInt(h.slice(0, 64), 16) * 2;
  const len = parseInt(h.slice(off, off + 64), 16) * 2;
  return new TextDecoder().decode(hexBytes(h.slice(off + 64, off + 64 + len)));
}
const units = (hex, dec) => Number(BigInt(hex)) / 10 ** dec;

/** ERC-8021 schema 0: [codes][len:1][schema:1][marker:16] at the very end of calldata. */
export function decodeTag(input) {
  const h = (input ?? "").toLowerCase().replace(/^0x/, "");
  if (!h.endsWith(MARKER)) return null;
  const body = h.slice(0, -MARKER.length);
  const schema = parseInt(body.slice(-2), 16);
  if (schema !== 0) return { schema, codes: [] };
  const len = parseInt(body.slice(-4, -2), 16);
  const text = new TextDecoder().decode(hexBytes(body.slice(-4 - len * 2, -4)));
  return { schema: 0, codes: text.split(",") };
}
export const isTagged = (tx) => !!decodeTag(tx.raw_input ?? tx.input)?.codes?.includes(TAG);

/** The ERC-8021 schema-0 suffix for TAG, to append to calldata a page asks a wallet to send. */
export function tagSuffix() {
  const code = [...new TextEncoder().encode(TAG)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return code + (TAG.length).toString(16).padStart(2, "0") + "00" + MARKER;
}

// ---------- minimal ABI codec (enough for the registries and ERC-20) ----------
// Types: uintN, intN, address, bool, bytes32, string, bytes, and T[] of any of these.
const isDyn = (t) => t === "string" || t === "bytes" || t.endsWith("[]");
const word = (n) => n.toString(16).padStart(64, "0");
function encStatic(t, v) {
  if (t === "address") return String(v).toLowerCase().replace(/^0x/, "").padStart(64, "0");
  if (t === "bool") return word(v ? 1n : 0n);
  if (t === "bytes32") return String(v).replace(/^0x/, "").padEnd(64, "0");
  if (t.startsWith("int")) { const b = BigInt(v); return word(b < 0n ? (1n << 256n) + b : b); }
  if (t.startsWith("uint")) return word(BigInt(v));
  throw new Error(`abi: unsupported type ${t}`);
}
function encBytes(u8) {
  const hex = [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");
  return word(BigInt(u8.length)) + hex.padEnd(Math.ceil(hex.length / 64) * 64, "0");
}
export function abiEncode(types, values) {
  let head = "", tail = "";
  const headLen = types.length * 32;
  types.forEach((t, i) => {
    if (!isDyn(t)) { head += encStatic(t, values[i]); return; }
    head += word(BigInt(headLen + tail.length / 2));
    if (t === "string") tail += encBytes(new TextEncoder().encode(values[i]));
    else if (t === "bytes") tail += encBytes(hexBytes(String(values[i]).replace(/^0x/, "")));
    else { const inner = t.slice(0, -2); const arr = values[i]; tail += word(BigInt(arr.length)) + abiEncode(arr.map(() => inner), arr); }
  });
  return head + tail; // no 0x
}
export const encodeCall = (selector, types, values) => selector + abiEncode(types, values);
function decAt(t, h, pos) {
  const w = h.slice(pos * 2, pos * 2 + 64);
  if (t === "address") return "0x" + w.slice(24);
  if (t === "bool") return BigInt("0x" + w) !== 0n;
  if (t === "bytes32") return "0x" + w;
  if (t.startsWith("int")) { const b = BigInt("0x" + w); return b >= 1n << 255n ? b - (1n << 256n) : b; }
  if (t.startsWith("uint")) return BigInt("0x" + w);
  throw new Error(`abi: unsupported type ${t}`);
}
function decParams(types, h, base) {
  return types.map((t, i) => {
    const at = base + i * 32;
    if (!isDyn(t)) return decAt(t, h, at);
    const start = base + Number(BigInt("0x" + h.slice(at * 2, at * 2 + 64)));
    const len = Number(BigInt("0x" + h.slice(start * 2, start * 2 + 64)));
    if (t === "string" || t === "bytes") {
      const bytes = hexBytes(h.slice((start + 32) * 2, (start + 32 + len) * 2));
      return t === "string" ? new TextDecoder().decode(bytes) : "0x" + h.slice((start + 32) * 2, (start + 32 + len) * 2);
    }
    const inner = t.slice(0, -2);
    return decParams(Array(len).fill(inner), h, start + 32);
  });
}
export const abiDecode = (types, hex) => decParams(types, String(hex).replace(/^0x/, ""), 0);
/** eth_call with an encoded call; returns decoded outputs. */
export async function readContract(to, selector, inTypes, args, outTypes) {
  return abiDecode(outTypes, await rpc("eth_call", [{ to, data: encodeCall(selector, inTypes, args) }, "latest"]));
}

// ---------- receipts + transfers ----------
export const loadReceipt = (hash) => rpc("eth_getTransactionReceipt", [hash]);
/** ERC-20 Transfer events in a receipt: [{ token, from, to, value (BigInt), logIndex }] */
export function decodeTransfers(receipt) {
  return (receipt?.logs ?? [])
    .filter((l) => l.topics?.[0]?.toLowerCase() === TRANSFER_TOPIC && l.topics.length === 3)
    .map((l) => ({ token: l.address, from: "0x" + l.topics[1].slice(26), to: "0x" + l.topics[2].slice(26), value: BigInt(l.data), logIndex: Number(BigInt(l.logIndex)) }));
}
/** The TOKENS entry for a token address (USD₮, cNGN, IDRX, wARS, wCOP), or null. */
export const tokenOf = (addr) => Object.values(TOKENS).find((t) => t.address.toLowerCase() === String(addr ?? "").toLowerCase()) ?? null;
export const tokenSymbol = (addr) => tokenOf(addr)?.symbol ?? "token";
export const units6 = (v) => Number(v) / 1e6;
/** Base units of a known token as a number, with that token's own decimals (IDRX 2, wARS/wCOP 18, USD₮/cNGN 6). */
export const tokenUnits = (v, addr) => Number(v) / 10 ** (tokenOf(addr)?.decimals ?? 6);

// ---------- "Get paid" registrations (recipient's own wallet, onchain) ----------
// A zero-value tx FROM the recipient TO the agent with input = hex(utf8("NP1:" + JSON)) + tag suffix.
// JSON { a: "5.03", d: "usdt-cngn"|"usdt-idrx"|"usdt-wars"|"usdt-wcop"|"cngn-usdt", e: <expiry unix seconds>, n: <name 1-40>,
// m?: <note <=80> }. d = the corridor: usdt-<currency> is what the recipient receives (naira, rupiah, pesos), USD₮ in.
// The recipient is tx.from. Request id = the registration tx hash. See docs/spec/REGISTRATIONS.md.
export const REG_PREFIX = "NP1:";
const utf8Hex = (s) => [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, "0")).join("");
export const MAX_REG_HOURS = 168;
/** Validate the JSON body. `blockTimeSec` = registration block time (for the expiry window). Returns an error string or null. */
export function registrationError(r, blockTimeSec) {
  if (!r || typeof r !== "object") return "not a registration";
  const corridor = typeof r.d === "string" && Object.prototype.hasOwnProperty.call(CORRIDORS, r.d) ? CORRIDORS[r.d] : null;
  if (!corridor) return "unknown corridor";
  if (typeof r.a !== "string" || !/^\d+(\.\d{1,2})?$/.test(r.a) || Number(r.a) <= 0) return "invalid amount";
  if (corridor.sell === "USDT" && (Number(r.a) < 1 || Number(r.a) > 24.99)) return "amount must be $1 to $24.99";
  if (typeof r.n !== "string" || !r.n.trim() || r.n.length > 40) return "invalid name";
  if (r.m != null && (typeof r.m !== "string" || r.m.length > 80)) return "invalid note";
  if (!Number.isInteger(r.e)) return "invalid expiry";
  if (blockTimeSec != null && (r.e <= blockTimeSec || r.e > blockTimeSec + MAX_REG_HOURS * 3600)) return "expiry must be 1 to 168 hours after registration";
  return null;
}
/** Calldata for the registration tx (with this app's attribution tag). */
export function encodeRegistration(r) {
  const body = { a: r.a, d: r.d, e: r.e, n: r.n, ...(r.m ? { m: r.m } : {}) };
  const err = registrationError(body, null);
  if (err) throw new Error(err);
  return "0x" + utf8Hex(REG_PREFIX + JSON.stringify(body)) + tagSuffix();
}
/** Parse a registration tx input (any trailing ERC-8021 tag is stripped first). Returns the JSON body or null. */
export function decodeRegistration(input) {
  let h = String(input ?? "").toLowerCase().replace(/^0x/, "");
  if (h.endsWith(MARKER)) {
    const len = parseInt(h.slice(-MARKER.length - 4, -MARKER.length - 2), 16);
    h = h.slice(0, -(MARKER.length + 4 + len * 2));
  }
  if (!h.startsWith(utf8Hex(REG_PREFIX))) return null;
  try { return JSON.parse(new TextDecoder().decode(hexBytes(h.slice(utf8Hex(REG_PREFIX).length)))); } catch { return null; }
}
/**
 * The same-amount rule (the agent implements it identically): among VALID, UNEXPIRED registrations paid in the same
 * payer token (USD₮ for every usdt-* link) and the same exact amount, the earliest (block, then position) is active; later ones are "amount in use".
 * Input items: { hash, from, block, position, time (sec), req }. Returns a Map hash -> "active" | "in-use" | "expired" | "invalid".
 */
export function registrationStatuses(regs, nowSec) {
  const out = new Map();
  const live = [];
  for (const r of regs) {
    if (registrationError(r.req, r.time)) out.set(r.hash, "invalid");
    else if (r.req.e <= nowSec) out.set(r.hash, "expired");
    else live.push(r);
  }
  live.sort((x, y) => x.block - y.block || x.position - y.position);
  const taken = new Set();
  for (const r of live) {
    // keyed by the token the payer sends: every usdt-<currency> link is paid in USD₮, so a USD₮ amount can only be in use once
    const key = CORRIDORS[r.req.d].sell + ":" + Number(r.req.a).toFixed(2);
    out.set(r.hash, taken.has(key) ? "in-use" : "active");
    taken.add(key);
  }
  return out;
}
/**
 * Registration txs sent to the agent (Blockscout, newest first). Pages back over the SAME window the agent uses
 * (168 h max link life + 24 h), so the site and the agent always see the same list for the same-amount rule.
 * Throws instead of returning a partial list.
 */
export async function loadRegistrations(maxPages = 100) {
  const regs = [];
  const sinceSec = Math.floor(Date.now() / 1000) - (MAX_REG_HOURS + 24) * 3600;
  let next = null;
  for (let p = 0; p < maxPages; p++) {
    const qs = new URLSearchParams({ filter: "to", ...(next ?? {}) });
    const d = await getJson(`${EXPLORER_API}/addresses/${AGENT}/transactions?${qs}`);
    for (const t of d.items ?? []) {
      if (t.status !== "ok" || t.to?.hash?.toLowerCase() !== AGENT.toLowerCase()) continue;
      const req = decodeRegistration(t.raw_input);
      if (!req) continue;
      regs.push({ hash: t.hash, from: t.from?.hash, block: Number(t.block_number ?? t.block), position: Number(t.position ?? 0), time: Math.floor(Date.parse(t.timestamp) / 1000), req });
    }
    next = d.next_page_params ?? null;
    const items = d.items ?? [];
    const oldest = items.length ? Math.floor(Date.parse(items[items.length - 1].timestamp) / 1000) : 0;
    if (!next || oldest < sinceSec) return regs; // complete for the window
  }
  throw new Error("partial registration list");
}

// ---------- nTags (handles tied to a wallet, onchain) ----------
// A claim is a zero-value tx FROM the wallet TO the agent with input hex(utf8("NT1:" + JSON)) + tag suffix:
// {"t":"ada"} or {"t":"ada","n":"Ada Obi"}; {"t":""} releases the sender's tag. Paying a tag = an ERC-20 transfer to the
// agent with hex(utf8("NTP:" + tag)) appended after the standard 68 bytes. See docs/spec/NTAGS.md.
// The block between the "port" markers is copied byte-for-byte into src/ntags.mjs (test/ntags.test.mjs checks it).
// ---------- port: start ----------
export const NTAG_PREFIX = "NT1:";
export const NTAG_MEMO_PREFIX = "NTP:";
export const RELEASE_LOCK_DAYS = 30;
/** What a tag payment can ask to pay out in ("NTP:ada:idrx") and a tag owner can prefer ({"t":"ada","c":"idrx"}). None = naira.
 *  Written out (not CURRENCY_CODES) so this block stays self-contained; a test checks it equals the registry. */
export const NTAG_CURRENCIES = ["cngn", "idrx", "wars", "wcop"];
/** Tags nobody can claim. */
export const NTAG_RESERVED = new Set([
  "agent", "admin", "administrator", "root", "system", "support", "help", "official", "team", "staff", "mod", "moderator",
  "security", "celo", "minipay", "valora", "opera", "textile", "naira", "nairapayout", "payout", "payouts", "ntag", "ntags",
  "lokal", "lokalpay", "cngn", "usdt", "usdc", "tether", "cusd", "ceur", "wallet", "bank", "cbn", "null", "undefined",
  "anonymous", "everyone", "me", "you", "test", "demo", "api", "www", "app", "pay", "send", "receive",
  "lokal_support", "lokalsupport", "lokal_help", "lokal_team", "lokal_official", "lokalofficial", "support_team",
  "help_desk", "helpdesk", "admin1", "celo_team", "celoteam", "minipay_support", "textile_fx",
]);
const NTAG_RESERVED_ERR = "this tag is reserved";
const NTAG_LOCK_SEC = RELEASE_LOCK_DAYS * 86400;
/** UI/CLI input only: trim, strip one leading "@", lowercase. The onchain JSON must already be in this form. */
export const normalizeNtag = (s) => String(s ?? "").trim().replace(/^@/, "").toLowerCase();
/** Tag rules (3-20 chars, a-z 0-9 _, starts with a letter, no "__", no trailing "_", not reserved). Error string or null. */
export function ntagError(t) {
  if (typeof t !== "string" || !t) return "enter a tag";
  if (/[A-Z]/.test(t)) return "use lowercase letters only";
  if (!/^[a-z0-9_]+$/.test(t)) return "use only letters, numbers and _";
  if (!/^[a-z]/.test(t)) return "must start with a letter";
  if (t.length < 3) return "must be at least 3 characters";
  if (t.length > 20) return "must be 20 characters or fewer";
  if (t.includes("__")) return "can't contain __";
  if (t.endsWith("_")) return "can't end with _";
  if (NTAG_RESERVED.has(t)) return NTAG_RESERVED_ERR;
  return null;
}
/** Display name rules (optional; 1-40 characters after trimming, no control characters). Error string or null. */
export function ntagNameError(n) {
  if (typeof n !== "string") return "invalid name";
  const v = n.trim();
  if (!v) return "name can't be blank";
  if (v.length > 40) return "name must be 40 characters or fewer";
  if (/[\u0000-\u001f\u007f-\u009f]/.test(v)) return "name can't contain control characters";
  if (/[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/.test(v)) return "name can't contain invisible or text-direction characters";
  return null;
}
/** Validates a decoded nTag op body: claim/update {t[,n][,c]} (c = preferred currency) or release {t:""}. Error string or null. */
export function ntagOpError(op) {
  if (!op || typeof op !== "object" || Array.isArray(op)) return "not a Lokal tag op";
  const keys = Object.keys(op);
  if (keys.some((k) => k !== "t" && k !== "n" && k !== "c")) return "unexpected field";
  if (typeof op.t !== "string") return "invalid tag";
  if (op.t === "") return "n" in op ? "a release has no name" : "c" in op ? "a release has no currency" : null;
  const err = ntagError(op.t);
  if (err) return err;
  if ("c" in op && !NTAG_CURRENCIES.includes(op.c)) return "unknown currency";
  if ("n" in op) return ntagNameError(op.n);
  return null;
}
const stripErc8021 = (input) => {
  let h = String(input ?? "").toLowerCase().replace(/^0x/, "");
  if (h.endsWith(MARKER)) {
    const len = parseInt(h.slice(-MARKER.length - 4, -MARKER.length - 2), 16);
    h = h.slice(0, -(MARKER.length + 4 + len * 2));
  }
  return h;
};
/** Calldata for a claim (or update) tx: hex("NT1:" + JSON) + this app's attribution suffix. Throws on a bad tag, name or currency. */
export function encodeNtagClaim({ t, n, c } = {}) {
  const name = typeof n === "string" ? n.trim() : n;
  const body = name ? { t, n: name } : { t };
  if (c != null) body.c = c;
  const err = body.t === "" ? "enter a tag" : ntagOpError(body);
  if (err) throw new Error(err);
  return "0x" + utf8Hex(NTAG_PREFIX + JSON.stringify(body)) + tagSuffix();
}
/** Calldata for a release tx (gives up the sender's current tag). */
export const encodeNtagRelease = () => "0x" + utf8Hex(NTAG_PREFIX + JSON.stringify({ t: "" })) + tagSuffix();
/** Parse a tx input as an nTag op (any trailing ERC-8021 suffix stripped). Returns the parsed JSON (unvalidated) or null. */
export function decodeNtagOp(input) {
  const h = stripErc8021(input);
  if (!h.startsWith(utf8Hex(NTAG_PREFIX))) return null;
  try { return JSON.parse(new TextDecoder().decode(hexBytes(h.slice(utf8Hex(NTAG_PREFIX).length)))); } catch { return null; }
}
/** Blockscout transaction item -> op item { hash, from, block, position, time, value, op }, or null (same filter as registrations). */
export function ntagOpFromItem(t, agent) {
  if (t?.status !== "ok" || t.to?.hash?.toLowerCase() !== String(agent).toLowerCase()) return null;
  const op = decodeNtagOp(t.raw_input);
  if (op == null) return null;
  return { hash: t.hash, from: t.from?.hash, block: Number(t.block_number ?? t.block), position: Number(t.position ?? 0), time: Math.floor(Date.parse(t.timestamp) / 1000), value: t.value == null ? "0" : String(t.value), op };
}
const ntagZeroValue = (v) => {
  if (v == null) return true;
  try { return BigInt(String(v)) === 0n; } catch { return false; }
};
/**
 * Replays VALID ops with time <= atSec in (block, position) order. Returns { tags: Map<tag, {owner (lower-case), name,
 * since (sec), hash, block, position, currency? (the owner's preferred currency code, once set)}>, byOwner: Map<lower-case
 * address, tag>, locks: Map<tag, {owner, until (sec)}>,
 * statuses: Map<hash, "claimed"|"renamed"|"updated"|"released"|"taken"|"locked"|"reserved"|"invalid"|"noop"> }.
 */
export function resolveNtags(ops, atSec = Infinity) {
  const tags = new Map(), byOwner = new Map(), locks = new Map(), statuses = new Map();
  const list = (ops ?? []).filter((o) => o && Number(o.time) <= atSec)
    .sort((x, y) => Number(x.block) - Number(y.block) || Number(x.position) - Number(y.position));
  const release = (owner, time) => {
    const t = byOwner.get(owner);
    if (!t) return false;
    tags.delete(t);
    byOwner.delete(owner);
    locks.set(t, { owner, until: time + NTAG_LOCK_SEC });
    return true;
  };
  for (const o of list) {
    const from = String(o.from ?? "").toLowerCase();
    let err = ntagOpError(o.op);
    if (!err && !/^0x[0-9a-f]{40}$/.test(from)) err = "invalid sender";
    if (!err && from === AGENT.toLowerCase()) err = "agent";
    if (!err && !ntagZeroValue(o.value)) err = "non-zero value";
    if (err) { statuses.set(o.hash, err === NTAG_RESERVED_ERR ? "reserved" : "invalid"); continue; }
    const time = Number(o.time);
    const t = o.op.t;
    if (t === "") { statuses.set(o.hash, release(from, time) ? "released" : "noop"); continue; }
    const name = "n" in o.op ? o.op.n.trim() : null;
    const currency = "c" in o.op ? o.op.c : null;
    const cur = tags.get(t);
    if (cur && cur.owner === from) {
      const renamed = name != null && name !== cur.name;
      const recurrency = currency != null && currency !== (cur.currency ?? null);
      if (renamed) cur.name = name;
      if (recurrency) cur.currency = currency;
      statuses.set(o.hash, renamed ? "renamed" : recurrency ? "updated" : "noop");
      continue;
    }
    if (cur) { statuses.set(o.hash, "taken"); continue; }
    const lock = locks.get(t);
    if (lock && lock.until > time && lock.owner !== from) { statuses.set(o.hash, "locked"); continue; }
    release(from, time);
    locks.delete(t);
    tags.set(t, { owner: from, name, since: time, hash: o.hash, block: Number(o.block), position: Number(o.position), ...(currency ? { currency } : {}) });
    byOwner.set(from, t);
    statuses.set(o.hash, "claimed");
  }
  return { tags, byOwner, locks, statuses };
}
/** State from only the ops strictly before (block, position): what a deposit at that spot pays. */
export const resolveNtagsBefore = (ops, block, position) => resolveNtags((ops ?? []).filter((o) =>
  o && (Number(o.block) < Number(block) || (Number(o.block) === Number(block) && Number(o.position) < Number(position)))));
/** The tag an address currently holds, or null. */
export const ntagOf = (state, address) => state.byOwner.get(String(address ?? "").toLowerCase()) ?? null;
/** The current entry { owner, name, since, hash, block, position, currency? } for a tag, or null. */
export const ownerOf = (state, tag) => state.tags.get(tag) ?? null;
/** "invalid" | "reserved" | "yours" | "taken" | "locked" | "free" for `forAddress` claiming `tag` at nowSec. */
export function ntagAvailability(state, tag, forAddress, nowSec = Math.floor(Date.now() / 1000)) {
  const err = ntagError(tag);
  if (err) return err === NTAG_RESERVED_ERR ? "reserved" : "invalid";
  const me = String(forAddress ?? "").toLowerCase();
  const cur = state.tags.get(tag);
  if (cur) return me && cur.owner === me ? "yours" : "taken";
  const lock = state.locks.get(tag);
  if (lock && lock.until > nowSec && lock.owner !== me) return "locked";
  return "free";
}
/**
 * ERC-20 transfer(agent, units) calldata + hex("NTP:" + tag [+ ":" + currency]) memo + attribution suffix. Tokens ignore
 * the extra bytes. No currency (or "cngn") writes the original memo "NTP:<tag>", which pays out in naira.
 */
export function encodeNtagTransfer(agent, units, tag, currency) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(agent))) throw new Error("invalid agent address");
  const v = BigInt(units);
  if (v <= 0n || v >= 1n << 256n) throw new Error("invalid amount");
  const err = ntagError(tag);
  if (err) throw new Error(err);
  if (currency != null && !NTAG_CURRENCIES.includes(currency)) throw new Error("unknown currency");
  const code = currency != null && currency !== NTAG_CURRENCIES[0] ? ":" + currency : "";
  return "0xa9059cbb" + String(agent).toLowerCase().replace(/^0x/, "").padStart(64, "0") + v.toString(16).padStart(64, "0")
    + utf8Hex(NTAG_MEMO_PREFIX + tag + code) + tagSuffix();
}
/**
 * A transfer's Lokal tag memo (suffix stripped, selector a9059cbb, then exactly "NTP:" + a valid tag, optionally followed
 * by ":" + a currency code): { tag, currency } with currency null when the memo names none (= naira), or null.
 */
export function decodeNtagPayment(input) {
  const h = stripErc8021(input);
  if (!/^[0-9a-f]*$/.test(h) || h.length % 2 || !h.startsWith("a9059cbb") || h.length <= 136) return null;
  const memo = new TextDecoder().decode(hexBytes(h.slice(136)));
  if (!memo.startsWith(NTAG_MEMO_PREFIX)) return null;
  const [tag, currency, ...more] = memo.slice(NTAG_MEMO_PREFIX.length).split(":");
  if (more.length || ntagError(tag)) return null;
  if (currency !== undefined && !NTAG_CURRENCIES.includes(currency)) return null;
  return { tag, currency: currency ?? null };
}
/** The tag in a transfer's memo, or null (see decodeNtagPayment). */
export const decodeNtagMemo = (input) => decodeNtagPayment(input)?.tag ?? null;
// ---------- port: end ----------

// ---------- the cutover to the LokalTags contract (not ported: the formats above are frozen) ----------
/**
 * From this block on, tags are claimed, renamed and released only on LokalTags (site/assets/lokal-contracts.js), and
 * legacy NT1: ops change nothing. Legacy NTP: payments keep being paid. Same number as src/config.mjs.
 */
export const LEGACY_CUTOVER_BLOCK = 83405000;
/** The legacy ops that still count (mined before the cutover). */
export const legacyNtagOps = (ops) => (ops ?? []).filter((o) => o && Number(o.block) < LEGACY_CUTOVER_BLOCK);

let ntagCache = null; // { at (ms), ops } or { promise }
/**
 * Every nTag op ever sent to the agent, oldest first (Blockscout, paged to the end; tags never expire). Cached in memory
 * for 30 s; pass { force: true } to refetch. Throws instead of returning a partial list.
 */
export async function loadNtagOps(maxPages = 200, opts = {}) {
  if (typeof maxPages === "object" && maxPages) { opts = maxPages; maxPages = 200; }
  if (!opts.force && ntagCache?.ops && Date.now() - ntagCache.at < 30_000) return ntagCache.ops;
  if (!opts.force && ntagCache?.promise) return ntagCache.promise;
  const promise = (async () => {
    const ops = [];
    let next = null;
    for (let p = 0; p < maxPages; p++) {
      const qs = new URLSearchParams({ filter: "to", ...(next ?? {}) });
      const d = await getJson(`${EXPLORER_API}/addresses/${AGENT}/transactions?${qs}`);
      if (!Array.isArray(d?.items)) throw new Error("unexpected explorer response");
      for (const t of d.items) { const o = ntagOpFromItem(t, AGENT); if (o) ops.push(o); }
      next = d.next_page_params ?? null;
      if (!next) return ops.sort((x, y) => x.block - y.block || x.position - y.position);
    }
    throw new Error("partial Lokal tag list");
  })();
  ntagCache = { promise };
  try {
    const ops = await promise;
    if (ntagCache?.promise === promise) ntagCache = { at: Date.now(), ops };
    return ops;
  } catch (e) {
    if (ntagCache?.promise === promise) ntagCache = null;
    throw e;
  }
}
/** Public link to a tag: /@tag on Vercel, else tag.html#tag next to the current page (all pages sit at the site root). */
export function ntagUrl(tag) {
  if (typeof location === "undefined") return HAS_API ? `/@${tag}` : `tag.html#${tag}`;
  return HAS_API ? `${location.origin}/@${tag}` : new URL(`tag.html#${tag}`, location.href).href;
}
/** Three deterministic hues (0-359) from an address, for a CSS gradient avatar. */
export function avatarSeed(address) {
  let h = 0x811c9dc5; // FNV-1a over the lower-case address
  for (const c of String(address ?? "").toLowerCase()) { h ^= c.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  const a = h % 360;
  return [a, (a + 40 + ((h >>> 9) % 80)) % 360, (a + 160 + ((h >>> 17) % 80)) % 360];
}

// ---------- receipt numbers (Receipt v2) ----------
/** NP-XXXX-XXXX from a payout tx hash. */
export const receiptNo = (hash) => "NP-" + hash.slice(2, 6).toUpperCase() + "-" + hash.slice(6, 10).toUpperCase();
/** "NP-7F3A-91C2" -> "0x7f3a91c2" (hash prefix), or null. */
export function parseReceiptNo(s) {
  const m = String(s ?? "").trim().toUpperCase().match(/^NP-([0-9A-F]{4})-?([0-9A-F]{4})$/);
  return m ? ("0x" + m[1] + m[2]).toLowerCase() : null;
}

// ---------- payment requests (pay.html#r=...) ----------
// Created by the CLI (`node src/agent.mjs request ...`); the same format is parsed here.
// { v:1, id:"r_xxxxxxxx", name, amount:"5.03", dir:"usdt-cngn"|"cngn-usdt", created: ms, exp: ms, note? }
const b64url = {
  enc: (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  dec: (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))),
};
export function encodeRequest(req) { return b64url.enc(JSON.stringify(req)); }
export function parseRequest(token) {
  let r;
  try { r = JSON.parse(b64url.dec(String(token))); } catch { throw new Error("This payment link is damaged. Ask for a new one."); }
  const ok = r && r.v === 1 && /^r_[a-z0-9]{6,16}$/.test(r.id) && typeof r.name === "string" && r.name.length > 0 && r.name.length <= 40
    && /^\d+(\.\d{1,6})?$/.test(r.amount) && CORRIDORS[r.dir] && Number.isFinite(r.created) && Number.isFinite(r.exp)
    && (r.note == null || (typeof r.note === "string" && r.note.length <= 80));
  if (!ok) throw new Error("This payment link isn't valid. Ask for a new one.");
  return r;
}

/**
 * Every currency's rate from a /api/rate or rate.json body: { rates: { cngn, idrx, wars, wcop } (local money per 1 USD₮,
 * Textile fee included, null when not quoting), available: { code: boolean }, maxUsd: { code: number | null } (the most
 * Textile can convert right now, when it says) }. Older bodies only carry the naira fields: the others are then unavailable.
 */
export function ratesFrom(d) {
  const rates = {}, available = {}, maxUsd = {};
  for (const c of CURRENCIES) {
    let r = Number(d?.rates?.[c.code]);
    if (!(r > 0) && c.code === "cngn") r = Number(d?.effectiveRate) > 0 ? Number(d.effectiveRate) : Number(d?.ticker?.bid);
    rates[c.code] = r > 0 ? r : null;
    available[c.code] = r > 0 && d?.available?.[c.code] !== false;
    const m = Number(d?.maxUsd?.[c.code]);
    maxUsd[c.code] = m > 0 ? m : null;
  }
  return { rates, available, maxUsd };
}
let rateCache = null; // { at, promise }: the sidebar and the page share one request (refetched after 60 s)
/**
 * { rate (naira per USD₮, or null), rates, available, maxUsd (see ratesFrom), fromPreview, fetchedAt, ageMin, stale,
 * previewUsd, ticker, reverseRate, reversePreviewNgn }. Throws when no currency has a rate at all.
 */
export function loadRate() {
  if (rateCache && Date.now() - rateCache.at < 60_000) return rateCache.promise;
  const promise = fetchRate();
  rateCache = { at: Date.now(), promise };
  promise.catch(() => { if (rateCache?.promise === promise) rateCache = null; });
  return promise;
}
async function fetchRate() {
  let d;
  try { d = HAS_API ? await getJson("/api/rate") : null; } catch { d = null; } // live on Vercel
  if (!d || !(Number(d.effectiveRate) > 0 || d.ticker || d.rates)) d = await getJson("rate.json", { cache: "no-store" });
  const fromPreview = Number(d.effectiveRate) > 0 || Object.values(d.rates ?? {}).some((r) => Number(r) > 0);
  const { rates, available, maxUsd } = ratesFrom(d);
  if (!Object.values(rates).some(Boolean)) throw new Error("no rate");
  const ageMin = Math.max(0, Math.round((Date.now() - Date.parse(d.fetchedAt ?? d.at)) / 60000));
  // reverseRate = USD₮ received per 1 NGN (cNGN -> USD₮ preview, fee included); null if not published yet
  const reverseRate = Number(d.reverseRate) > 0 ? Number(d.reverseRate) : null;
  return {
    rate: rates.cngn, rates, available, maxUsd, fromPreview, fetchedAt: d.fetchedAt ?? d.at, ageMin, stale: !!d.stale || ageMin > 120,
    previewUsd: d.previewUsd ?? 10, ticker: d.ticker ?? null, reverseRate, reversePreviewNgn: d.reversePreviewNgn ?? null,
  };
}

/** { ok, owner, file, uri } — owner check + decoded ERC-8004 registration file. */
export async function loadIdentity() {
  const id = pad(AGENT_ID.toString(16));
  const owner = "0x" + (await call(REGISTRY, "0x6352211e" + id)).slice(-40);
  const uri = decodeString(await call(REGISTRY, "0xc87b56dd" + id));
  let file = null;
  if (uri.startsWith("data:application/json;base64,")) {
    const bin = atob(uri.slice(uri.indexOf(",") + 1));
    file = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
  }
  return { ok: owner.toLowerCase() === AGENT.toLowerCase(), owner, file, uri };
}

/** { celo, usdt, cngn } as numbers. */
export async function loadBalances() {
  const bal = (t) => call(t, "0x70a08231" + pad(AGENT));
  const dec = async (t) => parseInt(await call(t, "0x313ce567"), 16);
  const [celo, usdt, cngn, dU, dN] = await Promise.all([
    rpc("eth_getBalance", [AGENT, "latest"]), bal(TOKENS.USDT.address), bal(TOKENS.cNGN.address), dec(TOKENS.USDT.address), dec(TOKENS.cNGN.address),
  ]);
  return { celo: units(celo, 18), usdt: units(usdt, dU), cngn: units(cngn, dN) };
}

/** One page of the agent's outgoing transactions: { items, next } (next = params for the following page or null). */
export async function loadTxPage(next = null) {
  const qs = new URLSearchParams({ filter: "from", ...(next ?? {}) });
  const d = await getJson(`${EXPLORER_API}/addresses/${AGENT}/transactions?${qs}`);
  if (!Array.isArray(d.items)) throw new Error("unexpected explorer response");
  const items = d.items.filter((t) => t.from?.hash?.toLowerCase() === AGENT.toLowerCase());
  return { items, next: d.next_page_params ?? null };
}

/** Any Celo transaction by hash, via RPC: { hash, from, to, input, status, blockNumber, timestamp } or null. */
export async function loadTxByHash(hash) {
  const [tx, receipt] = await Promise.all([rpc("eth_getTransactionByHash", [hash]), rpc("eth_getTransactionReceipt", [hash])]);
  if (!tx) return null;
  let timestamp = null;
  if (tx.blockNumber) {
    const block = await rpc("eth_getBlockByNumber", [tx.blockNumber, false]);
    timestamp = block ? Number(BigInt(block.timestamp)) * 1000 : null;
  }
  return { hash: tx.hash, from: tx.from, to: tx.to, input: tx.input, status: receipt ? (receipt.status === "0x1" ? "ok" : "error") : "pending", blockNumber: tx.blockNumber ? Number(BigInt(tx.blockNumber)) : null, timestamp };
}

// ---------- transaction meaning ----------
/** "identity" | "approve" | "convert" | "payout" | "other" */
const isStable = (addr) => Object.values(TOKENS).some((t) => t.address.toLowerCase() === addr);
// CELO (ERC-20 at the CELO token address) is sold by celo-cngn payouts: label its approvals and swaps, never as a payout.
const CELO_ADDR = "0x471EcE3750Da237f93B8E339c536989b8978a438".toLowerCase();
const labelSymbol = (addr) => (addr?.toLowerCase() === CELO_ADDR ? "CELO" : tokenSymbol(addr));
export function txKind(tx) {
  const to = tx.to?.hash?.toLowerCase();
  if (to === REGISTRY.toLowerCase()) return "identity";
  if (isStable(to) && tx.method === "transfer") return "payout"; // any corridor: a local currency or USD₮ paid out
  if ((isStable(to) || to === CELO_ADDR) && tx.method === "approve") return "approve";
  if (tx.token_transfers || /execute/i.test(tx.method ?? "")) return "convert";
  return "other";
}
/** "USD₮ → cNGN" when the explorer item carries token transfers, else null. */
function swapDirection(tx) {
  const tt = Array.isArray(tx.token_transfers) ? tx.token_transfers : [];
  const sold = tt.find((t) => t.from?.hash?.toLowerCase() === AGENT.toLowerCase());
  const got = tt.find((t) => t.to?.hash?.toLowerCase() === AGENT.toLowerCase());
  const s = sold && labelSymbol(sold.token?.address_hash ?? sold.token?.address);
  const g = got && labelSymbol(got.token?.address_hash ?? got.token?.address);
  return s && g && s !== "token" && g !== "token" ? `${s} → ${g}` : null;
}
export function txLabel(tx) {
  const sym = labelSymbol(tx.to?.hash);
  switch (txKind(tx)) {
    case "identity": return tx.method === "register" ? "Registered identity" : tx.method === "setAgentURI" ? "Updated identity file" : "Updated identity";
    case "payout": return `Paid ${sym} to recipient`;
    case "approve": return /0{64}$/.test((tx.raw_input ?? "").slice(0, 138)) ? `Reset ${sym} allowance` : `Approved ${sym} for Textile`;
    case "convert": { const d = swapDirection(tx); return d ? `Converted ${d}` : "Converted on Textile FX"; }
    default: return tx.method ? `Called ${tx.method}` : "Other transaction";
  }
}
export function txStatus(tx) {
  return tx.status === "ok" ? ["Success", "ok"] : tx.status === "error" ? ["Failed", "err"] : ["Pending", "warn"];
}

// ---------- DOM helpers ----------
export function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "dataset") Object.assign(n.dataset, v);
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null) n.append(c);
  return n;
}
export const badge = (text, kind = "neutral") => el("span", { class: `badge ${kind}` }, text);
export const icon = (name, cls = "i") => {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", cls);
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(ns, "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
};

let toastTimer;
export function toast(message) {
  let t = document.getElementById("toast");
  if (!t) { t = el("div", { id: "toast", class: "toast", role: "status", "aria-live": "polite" }); document.body.append(t); }
  t.textContent = message;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 1600);
}
export async function copyText(text, label = "Copied") {
  try { await navigator.clipboard.writeText(text); toast(label); } catch { toast("Copy failed. Select and copy manually."); }
}
export function download(filename, text, type = "text/csv") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el("a", { href: url, download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- wallet disconnect ----------
// A site can't force an injected wallet to disconnect. "Disconnect" therefore (1) asks the wallet to revoke this
// site's access (EIP-2255 wallet_revokePermissions; MetaMask supports it, some wallets ignore it) and (2) marks the
// wallet as disconnected for this browser tab so pages don't silently reconnect via eth_accounts.
const WALLET_OFF = "np-wallet-off";
export function walletDisconnected() { try { return sessionStorage.getItem(WALLET_OFF) === "1"; } catch { return false; } }
export function markWalletConnected() { try { sessionStorage.removeItem(WALLET_OFF); } catch { /* storage blocked */ } }
/** Returns true if the wallet confirmed it revoked this site's access, false if it only disconnected on the page. */
export async function disconnectWallet(eth) {
  try { sessionStorage.setItem(WALLET_OFF, "1"); } catch { /* storage blocked */ }
  if (!eth?.request) return false;
  try { await eth.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] }); return true; }
  catch { return false; }
}
export const DISCONNECT_NOTE_PARTIAL = "Disconnected on this page. To remove this site's access completely, also disconnect it in your wallet's \"Connected sites\" settings.";
export const DISCONNECT_NOTE_FULL = "Disconnected. This site no longer has access to your wallet.";

// ---------- page chrome: nav, sidebar, copy buttons ----------
// ---------- privacy consent ----------
// No cookies, no analytics, fonts are self-hosted. The only OPTIONAL things are remembering layout
// preferences on this device (the sidebar state, the last currency) and the Lokal tags paid from this browser (so a tag
// page can warn about a first-time payee or a lookalike: assets/trust.js) in localStorage. The choice itself is stored under
// CONSENT_KEY (needed to honour it). Declining keeps every feature working; nothing is remembered.
const CONSENT_KEY = "np-consent";
const CONSENT_VERSION = 2; // bumped: fonts are no longer part of the ask, so people are asked again
export function getConsent() {
  try {
    const v = JSON.parse(localStorage.getItem(CONSENT_KEY) ?? "null");
    return v && v.v === CONSENT_VERSION && (v.choice === "accepted" || v.choice === "declined") ? v.choice : null;
  } catch { return null; }
}
function saveConsent(choice) {
  try { localStorage.setItem(CONSENT_KEY, JSON.stringify({ v: CONSENT_VERSION, choice, at: new Date().toISOString() })); } catch { /* blocked: ask again next visit */ }
  // declining forgets everything optional: the layout, the last currency and the tags paid from here (assets/trust.js)
  if (choice === "declined") { try { localStorage.removeItem(SB_KEY); localStorage.removeItem("np-currency"); localStorage.removeItem("np-paid-tags"); } catch {} }
}
function applyConsent(choice) {
  document.documentElement.dataset.consent = choice ?? "unset";
}
function consentBanner() {
  document.getElementById("consent")?.remove();
  const policy = el("a", { class: "link", href: "privacy.html" }, "The short version");
  const accept = el("button", { class: "btn btn-secondary btn-sm", type: "button", "data-consent": "accepted" }, "Sure");
  const decline = el("button", { class: "btn btn-secondary btn-sm", type: "button", "data-consent": "declined" }, "No thanks");
  const box = el("section", { id: "consent", class: "consent", role: "dialog", "aria-modal": "false", "aria-labelledby": "consent-title", "aria-describedby": "consent-text" },
    el("div", { class: "consent-body" },
      el("h2", { id: "consent-title" }, "Quick one"),
      el("p", { id: "consent-text" },
        // phones get the short line (the long one would cover a fifth of the screen); both say the same thing
        el("span", { class: "consent-long" }, "We don't track you. No cookies, no analytics. Can we remember your layout, and which tags you've paid, on this device? Everything works either way. "),
        el("span", { class: "consent-short" }, "No tracking, no cookies. Remember your layout and who you've paid, on this device? "),
        policy, ".")),
    el("div", { class: "consent-actions" }, decline, accept));
  box.addEventListener("click", (e) => {
    const b = e.target.closest("[data-consent]");
    if (!b) return;
    const choice = b.dataset.consent;
    saveConsent(choice);
    applyConsent(choice);
    box.classList.add("leaving");
    setTimeout(() => box.remove(), 220);
    toast(choice === "accepted" ? "Got it, we'll remember them on this device" : "No problem, nothing is stored");
  });
  document.body.append(box);
  requestAnimationFrame(() => box.classList.add("shown"));
  return box;
}
function initConsent() {
  const choice = getConsent();
  applyConsent(choice);
  if (!choice) consentBanner();
  document.addEventListener("click", (e) => {
    if (!e.target.closest("[data-consent-open]")) return;
    e.preventDefault();
    consentBanner().querySelector("button")?.focus();
  });
}

const SB_KEY = "np-sidebar";
const store = {
  get() { try { return getConsent() === "accepted" ? localStorage.getItem(SB_KEY) : null; } catch { return null; } },
  set(v) { if (getConsent() !== "accepted") return; try { localStorage.setItem(SB_KEY, v); } catch { /* storage blocked */ } },
};
const desktop = () => matchMedia("(min-width: 1100px)").matches;

function initSidebar() {
  const root = document.documentElement;
  const sidebar = document.getElementById("sidebar");
  if (!sidebar) return;
  const scrim = document.querySelector(".sb-scrim");
  const menuBtn = document.querySelector(".menu-btn");
  const collapseBtn = sidebar.querySelector(".sb-collapse");
  const closeBtn = sidebar.querySelector(".sb-close");

  // desktop rail / expanded (remembered)
  const setRail = (rail) => {
    root.dataset.sb = rail ? "rail" : "open";
    collapseBtn?.setAttribute("aria-expanded", String(!rail));
    collapseBtn?.setAttribute("aria-label", rail ? "Expand sidebar" : "Collapse sidebar");
    store.set(rail ? "rail" : "open");
  };
  root.dataset.sb = store.get() === "rail" ? "rail" : "open";
  collapseBtn?.setAttribute("aria-expanded", String(root.dataset.sb !== "rail"));
  collapseBtn?.setAttribute("aria-label", root.dataset.sb === "rail" ? "Expand sidebar" : "Collapse sidebar");
  collapseBtn?.addEventListener("click", () => setRail(root.dataset.sb !== "rail"));

  // mobile/tablet drawer
  let lastFocus = null;
  const openDrawer = () => {
    lastFocus = document.activeElement;
    root.dataset.drawer = "open";
    menuBtn?.setAttribute("aria-expanded", "true");
    sidebar.setAttribute("aria-modal", "true");
    sidebar.setAttribute("role", "dialog");
    requestAnimationFrame(() => sidebar.querySelector(".sb-nav a")?.focus());
  };
  const closeDrawer = () => {
    if (root.dataset.drawer !== "open") return;
    delete root.dataset.drawer;
    menuBtn?.setAttribute("aria-expanded", "false");
    sidebar.removeAttribute("aria-modal");
    sidebar.removeAttribute("role");
    lastFocus?.focus?.();
  };
  menuBtn?.addEventListener("click", () => (root.dataset.drawer === "open" ? closeDrawer() : openDrawer()));
  closeBtn?.addEventListener("click", closeDrawer);
  scrim?.addEventListener("click", closeDrawer);
  sidebar.addEventListener("click", (e) => { if (e.target.closest(".sb-nav a") && !desktop()) closeDrawer(); });
  addEventListener("resize", () => { if (desktop()) closeDrawer(); });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") return closeDrawer();
    // "[" toggles the rail on desktop (ignored while typing)
    if (e.key === "[" && desktop() && !e.metaKey && !e.ctrlKey && !e.altKey && !e.target.closest("input, textarea, select, [contenteditable]")) {
      setRail(root.dataset.sb !== "rail");
    }
    // keep Tab inside the open drawer
    if (e.key === "Tab" && root.dataset.drawer === "open") {
      const f = [...sidebar.querySelectorAll("a[href], button:not([disabled])")].filter((n) => n.offsetParent !== null);
      if (!f.length) return;
      const last = f[f.length - 1]; // (not .at(-1): older Safari)
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); f[0].focus(); }
    }
  });

  // live status card: what 1 USD₮ buys in every currency (a compact 2 x 2 list; the rail shows it as a tooltip)
  const rateEl = document.getElementById("sb-rate");
  if (rateEl) {
    loadRate().then((r) => {
      const cells = CURRENCIES.map((c) => {
        const ok = r.available[c.code];
        const text = ok ? formatCurrency(r.rates[c.code], c.code, 0) : `${c.symbol} —`;
        return el("span", { class: `sb-rate${ok ? "" : " off"}`, title: ok ? `${c.label}: ${text} per 1 USD₮` : `${c.label}: not available right now` }, text);
      });
      rateEl.classList.add("sb-rates");
      rateEl.setAttribute("aria-label", "1 USD₮ buys " + CURRENCIES.map((c) => (r.available[c.code] ? formatCurrency(r.rates[c.code], c.code, 0) : `no ${c.label} right now`)).join(", "));
      rateEl.replaceChildren(...cells);
      const box = rateEl.closest(".sb-status");
      box?.setAttribute("title", "Celo mainnet · 1 USD₮ = " + CURRENCIES.filter((c) => r.available[c.code]).map((c) => formatCurrency(r.rates[c.code], c.code, 0)).join(" · "));
    }).catch(() => { rateEl.textContent = "Rates unavailable"; });
  }

  // enable transitions only after the first paint, so the remembered state doesn't animate in
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add("sb-ready")));
}

export function initChrome() {
  initConsent();
  const here = location.pathname.split("/").pop() || "index.html";
  // a sidebar entry also stays current on the pages grouped under it (data-also="receipt.html verify.html")
  for (const a of document.querySelectorAll(".nav-links a, .sb-nav a, .subnav a")) {
    const also = (a.getAttribute("data-also") || "").split(/\s+/);
    if (a.getAttribute("href") === here || also.includes(here)) a.setAttribute("aria-current", "page");
  }
  initSidebar();
  // any element with data-copy="text" copies that text on click
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-copy]");
    if (b) copyText(b.dataset.copy, b.dataset.copyLabel ?? "Copied");
  });
  const y = document.getElementById("year");
  if (y) y.textContent = String(new Date().getFullYear());
  // the signed-in user chip (sidebar foot + mobile top bar); loaded separately so a failure never breaks the page
  if (document.getElementById("sb-user") || document.getElementById("nav-user")) {
    import("./session.js").then((m) => m.initUserChip()).catch(() => { /* the static "Sign in" link stays */ });
  }
  // the notification bell (signed in only): the app top bar's slot, or the landing / Features / Proof top bar (not the gateway)
  if (document.getElementById("nav-bell") || document.getElementById("lp-signin")) {
    import("./bell.js").then((m) => m.initBell()).catch(() => { /* no bell; the page works the same */ });
  }
}
