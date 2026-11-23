// The currencies a recipient can receive: the single source of truth for the agent (src/) and the site.
// Everything between the "currencies" markers is a byte-for-byte copy of the same block in site/assets/core.js
// (test/currencies.test.mjs checks it), so the site and the agent always agree on codes, tokens and decimals.

// ---------- currencies: start ---------- (from site/assets/core.js; keep byte-for-byte identical)
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
/** The corridor that pays DOLLARS for a payment in a local currency: "idrx-usdt" (you send IDRX, they get USD₮). */
export const reverseCorridorFor = (code) => code + "-usdt";
/** The local currency a "<code>-usdt" corridor is paid in ("idrx-usdt" -> rupiah), or null for any other corridor. */
export const currencyOfReverse = (id) => (/^[a-z]+-usdt$/.test(String(id)) ? currencyOf(String(id).slice(0, -5)) : null);
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
