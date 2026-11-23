// The Textile FX rates, shared by scripts/fetch-rate.mjs (static rate.json) and api/rate.js (live, on Vercel).
// Read-only: free Textile price previews and the public rates feed. No wallet, no keys, no transactions.
// Every source is fetched in parallel; each can fail on its own without hiding the others (graceful partial failure).
//
// Shape (rate.json and /api/rate):
//   { base: "USDT", rates: { cngn, idrx, wars, wcop }, available: { cngn: true, ... }, maxUsd: { ... }, at, fetchedAt,
//     previewUsd, effectiveRate, previewReceive, reverseRate, reversePreviewNgn, reversePreviewReceive, reverseRates,
//     celoUsdRate, celoPreviewCelo, celoPreviewReceive, ticker, stale?, errors? }
// rates = local money per 1 USD₮ (Textile fee included); available = whether Textile quotes it right now; maxUsd = the
// most USD₮ Textile can convert into it right now (its availableSellAmount), when it says. reverseRates = USD₮ received
// per 1 unit of each local currency (its <code>-usdt preview, fee included; cngn is reverseRate). The naira fields that pages
// and scripts already read (effectiveRate, previewReceive, reverse*, celo*, ticker) keep their meaning.
import { CURRENCIES, USDT_ADDRESS, USDT_DECIMALS } from "../src/currencies.mjs";

const USDT = USDT_ADDRESS;
const CNGN = CURRENCIES.find((c) => c.code === "cngn").address;
const CELO = "0x471EcE3750Da237f93B8E339c536989b8978a438"; // CELO (GoldToken), ERC-20 interface
const DECIMALS = USDT_DECIMALS; // USD₮ (and cNGN) on Celo: 6
const CELO_DECIMALS = 18;
export const PREVIEW_USD = 10;
/** When a currency doesn't quote PREVIEW_USD (thin liquidity), the rate is read from this smaller preview instead. */
export const SMALL_PREVIEW_USD = 1;
export const REVERSE_PREVIEW_NGN = 14400; // ≈ $10 in naira, for the cNGN -> USD₮ preview
/** About $10 of each other local currency, for its <code>-usdt preview (whole units). */
export const REVERSE_PREVIEW = { idrx: 184000, wars: 17500, wcop: 34500 };
// CELO -> USD₮ preview size. Textile needs about $1 per swap, and a CELO payout swaps twice (CELO -> USD₮ -> cNGN),
// so 20 CELO (about $1.10) is roughly the smallest amount that clears both hops.
export const CELO_PREVIEW = 20;
export const TEXTILE_PREVIEW_URL = "https://api.textilecredit.com/v2/rfq/preview";

function signal(ms) {
  if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);
  const c = new AbortController(); setTimeout(() => c.abort(), ms); return c.signal;
}
async function getJson(url, init = {}, ms, fetchImpl = fetch) {
  const r = await fetchImpl(url, { ...init, signal: signal(ms) });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.json();
}
const previewUnits = (sellToken, buyToken, sellAmount, ms, fetchImpl) => getJson(TEXTILE_PREVIEW_URL, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ chainId: 42220, sellToken, buyToken, sellAmount: String(sellAmount) }),
}, ms, fetchImpl);
const preview = (sellToken, buyToken, whole, ms, decimals = DECIMALS, fetchImpl) =>
  previewUnits(sellToken, buyToken, BigInt(whole) * 10n ** BigInt(decimals), ms, fetchImpl);

/** buyAmount (base units, `decimals`) per `sellUsd` USD₮ -> local money per 1 USD₮, as a number with sensible precision. */
export function ratePerUsd(buyAmount, decimals, sellUsd) {
  const whole = Number(BigInt(buyAmount)) / 10 ** decimals;
  return +(whole / sellUsd).toFixed(decimals >= 4 ? 4 : decimals);
}

/**
 * One currency: preview PREVIEW_USD; if Textile has no quote for that size, try SMALL_PREVIEW_USD so a thin market still
 * shows its rate (with maxUsd saying how much it can take). Returns { rate, available, maxUsd, previewUsd, receive } or
 * { available: false, error }.
 */
export async function currencyQuote(c, { timeoutMs = 30_000, fetchImpl = fetch } = {}) {
  let lastStatus = null;
  for (const usd of [PREVIEW_USD, SMALL_PREVIEW_USD]) {
    const pv = await preview(USDT, c.address, usd, timeoutMs, DECIMALS, fetchImpl);
    const d = pv?.data;
    if (d?.status === "preview" && BigInt(d.buyAmount ?? 0) > 0n) {
      const avail = Number(d.availableSellAmount);
      return {
        rate: ratePerUsd(d.buyAmount, c.decimals, usd),
        available: true,
        maxUsd: avail > 0 ? +(avail / 10 ** DECIMALS).toFixed(2) : null,
        previewUsd: usd,
        receive: +(Number(BigInt(d.buyAmount)) / 10 ** c.decimals).toFixed(Math.min(c.decimals, 6)),
      };
    }
    lastStatus = [d?.status, d?.reason].filter(Boolean).join(": ") || "no data";
  }
  return { available: false, error: `${c.code} preview ${lastStatus}` };
}

/**
 * @param {{ timeoutMs?: number, carryForwardUrl?: string, fetchImpl?: typeof fetch }} opts
 * @returns the rate.json-shaped object described at the top of this file.
 */
export async function buildRate({ timeoutMs = 30_000, carryForwardUrl, fetchImpl = fetch } = {}) {
  const fetchedAt = new Date().toISOString();
  const result = { base: "USDT", fetchedAt, at: fetchedAt, previewUsd: PREVIEW_USD, rates: {}, available: {}, maxUsd: {} };
  const errors = [];
  const ms = Math.max(timeoutMs, 8_000);
  const others = CURRENCIES.filter((c) => REVERSE_PREVIEW[c.code]);
  const [locals, rev, celo, tick, revs] = await Promise.all([
    Promise.allSettled(CURRENCIES.map((c) => currencyQuote(c, { timeoutMs: ms, fetchImpl }))),
    Promise.allSettled([preview(CNGN, USDT, REVERSE_PREVIEW_NGN, ms, DECIMALS, fetchImpl)]).then((x) => x[0]),
    Promise.allSettled([preview(CELO, USDT, CELO_PREVIEW, ms, CELO_DECIMALS, fetchImpl)]).then((x) => x[0]),
    Promise.allSettled([getJson("https://api.textilecredit.com/tickers?ticker_id=USDT_NGN", {}, timeoutMs, fetchImpl)]).then((x) => x[0]),
    Promise.allSettled(others.map((c) => preview(c.address, USDT, REVERSE_PREVIEW[c.code], ms, c.decimals, fetchImpl))),
  ]);

  CURRENCIES.forEach((c, i) => {
    const s = locals[i];
    const q = s.status === "fulfilled" ? s.value : { available: false, error: `${c.code} preview: ${s.reason?.message ?? s.reason}` };
    result.rates[c.code] = q.available ? q.rate : null;
    result.available[c.code] = Boolean(q.available);
    result.maxUsd[c.code] = q.available ? q.maxUsd ?? null : null;
    if (!q.available) errors.push(q.error);
    // the naira fields pages and scripts already use (from the same preview)
    if (c.code === "cngn" && q.available) {
      result.effectiveRate = q.rate;
      if (q.previewUsd === PREVIEW_USD) result.previewReceive = +q.receive.toFixed(2);
    }
  });

  try {
    if (rev.status === "rejected") throw rev.reason;
    const pv = rev.value;
    if (pv?.data?.status !== "preview") throw new Error(`reverse preview status ${pv?.data?.status}`);
    const received = Number(BigInt(pv.data.buyAmount)) / 10 ** DECIMALS;
    if (!(received > 0)) throw new Error("reverse preview returned zero");
    result.reversePreviewNgn = REVERSE_PREVIEW_NGN;
    result.reverseRate = +(received / REVERSE_PREVIEW_NGN).toFixed(8); // USD₮ received per 1 NGN, fee included
    result.reversePreviewReceive = +received.toFixed(6);
  } catch (e) { errors.push(`reverse preview: ${e.message}`); }
  result.reverseRates = { cngn: result.reverseRate ?? null };
  others.forEach((c, i) => {
    try {
      const s = revs[i];
      if (s.status === "rejected") throw s.reason;
      if (s.value?.data?.status !== "preview") throw new Error(`status ${s.value?.data?.status}`);
      const received = Number(BigInt(s.value.data.buyAmount)) / 10 ** DECIMALS;
      if (!(received > 0)) throw new Error("returned zero");
      result.reverseRates[c.code] = +(received / REVERSE_PREVIEW[c.code]).toPrecision(8); // USD₮ per 1 unit, fee included
    } catch (e) { result.reverseRates[c.code] = null; errors.push(`${c.code} reverse preview: ${e.message}`); }
  });

  try {
    if (celo.status === "rejected") throw celo.reason;
    const pv = celo.value;
    if (pv?.data?.status !== "preview") throw new Error(`celo preview status ${pv?.data?.status}`);
    const received = Number(BigInt(pv.data.buyAmount)) / 10 ** DECIMALS; // USD₮, 6 decimals
    if (!(received > 0)) throw new Error("celo preview returned zero");
    result.celoPreviewCelo = CELO_PREVIEW;
    result.celoUsdRate = +(received / CELO_PREVIEW).toFixed(6); // USD₮ received per 1 CELO, Textile fee included
    result.celoPreviewReceive = +received.toFixed(6);
  } catch (e) { errors.push(`celo preview: ${e.message}`); }

  try {
    if (tick.status === "rejected") throw tick.reason;
    const t = tick.value;
    if (Array.isArray(t) && t[0]) result.ticker = { bid: t[0].bid, ask: t[0].ask, last: t[0].last_price };
    else throw new Error("empty ticker");
  } catch (e) { errors.push(`ticker: ${e.message}`); }

  const anyLocal = Object.values(result.available).some(Boolean);
  if (!result.effectiveRate && !result.ticker && !anyLocal && carryForwardUrl) {
    // Textile is down: carry the last published file forward (marked stale), keeping anything fetched just now.
    try {
      const prev = await getJson(carryForwardUrl, {}, 8_000, fetchImpl);
      if (prev.effectiveRate || prev.ticker || prev.rates) {
        const fresh = {
          ...(result.reverseRate ? { reversePreviewNgn: result.reversePreviewNgn, reverseRate: result.reverseRate, reversePreviewReceive: result.reversePreviewReceive } : {}),
          ...(result.celoUsdRate ? { celoPreviewCelo: result.celoPreviewCelo, celoUsdRate: result.celoUsdRate, celoPreviewReceive: result.celoPreviewReceive } : {}),
        };
        Object.assign(result, prev, fresh, { base: "USDT", stale: true });
        if (!prev.rates) Object.assign(result, { rates: { cngn: prev.effectiveRate ?? null }, available: { cngn: Boolean(prev.effectiveRate) }, maxUsd: {} });
      }
    } catch (e) { errors.push(`carry-forward: ${e.message}`); }
  }
  if (errors.length) result.errors = errors;
  return result;
}

/** True when the result has any rate worth serving (a page can show at least one currency). */
export const hasAnyRate = (r) => Boolean(r?.effectiveRate || r?.ticker || Object.values(r?.available ?? {}).some(Boolean));
