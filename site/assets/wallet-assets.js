// "Add <token> to my wallet": asks the wallet to show a LokalPay token (EIP-747 wallet_watchAsset), so the money the
// agent pays out is visible in the recipient's own wallet. Nothing is sent and nothing is signed; the wallet asks the
// person to confirm. The wallet is switched to Celo first, because a wallet adds the token to whatever network it is
// on. Addresses and decimals come from the one currency list (core.js); symbols are exactly what each token contract
// returns from symbol() on Celo (checked 21 Nov 2026), because some wallets refuse a symbol that doesn't match.
// MiniPay only shows USDT, USDC and USDm, so it may refuse local tokens: the button then says so in plain words.
// The top level stays free of window/document access (tested in Node).
import { CURRENCIES, USDT_ADDRESS, USDT_DECIMALS, el, icon } from "./core.js";
import { ensureCelo, explainWalletError, injectedWallet } from "./session.js";
import { flagIcon } from "./currency-ui.js";

/** Every token a LokalPay recipient can hold, in display order (the four local currencies, then dollars). */
export const WALLET_TOKENS = [
  ...CURRENCIES.map((c) => ({ code: c.code, symbol: c.token, address: c.address, decimals: c.decimals, label: c.label, flag: c.code })),
  { code: "usdt", symbol: "USD₮", address: USDT_ADDRESS, decimals: USDT_DECIMALS, label: "Dollars", flag: "usd" },
];
/** The token entry for a code ("cngn", "idrx", "wars", "wcop", "usdt"), or null. */
export const walletToken = (code) => WALLET_TOKENS.find((t) => t.code === code) ?? null;

/** The exact wallet_watchAsset params for a code: { type: "ERC20", options: { address, symbol, decimals } }. Throws on an unknown code. */
export function watchAssetParams(code) {
  const t = walletToken(code);
  if (!t) throw new Error(`unknown token "${code}"`);
  return { type: "ERC20", options: { address: t.address, symbol: t.symbol, decimals: t.decimals } };
}

/**
 * Asks `eth` to add the token: switches to Celo, then wallet_watchAsset. Resolves true when the wallet added it,
 * false when the person said no. Throws (plain message in .message) when the wallet can't do it.
 */
export async function addTokenToWallet(eth, code) {
  if (!eth?.request) throw Object.assign(new Error("No wallet found in this browser. Open this page in your wallet's browser to add the token."), { plain: true });
  const params = watchAssetParams(code);
  await ensureCelo(eth);
  const ok = await eth.request({ method: "wallet_watchAsset", params });
  return ok !== false;
}

/** Plain words for a failed add (the wallet's own error otherwise). */
export function addTokenError(e, code) {
  const t = walletToken(code);
  if (e?.plain) return e.message;
  if (e?.code === 4001) return `You cancelled. ${t?.symbol ?? "The token"} was not added.`;
  if (e?.code === -32601 || e?.code === 4200 || /not supported|unsupported|does not exist|not available/i.test(String(e?.message ?? ""))) {
    return `This wallet can't add tokens this way. Add ${t.symbol} by hand: Celo network, contract ${t.address}, ${t.decimals} decimals. (MiniPay only shows USDT, USDC and USDm.)`;
  }
  return explainWalletError(e);
}

/**
 * A row of "Add cNGN" / "Add IDRX" / ... buttons with a status line. opts: { codes (default every token), onResult }.
 * Returns the element.
 */
export function addToWalletRow({ codes = WALLET_TOKENS.map((t) => t.code), compact = false } = {}) {
  const status = el("p", { class: "micro muted atw-status", role: "status", "aria-live": "polite" });
  const buttons = codes.map((code) => {
    const t = walletToken(code);
    const b = el("button", { class: `btn btn-secondary ${compact ? "btn-sm" : ""} atw-btn`, type: "button", dataset: { code }, "aria-label": `Add ${t.symbol} (${t.label}) to your wallet` },
      flagIcon(t.flag), el("span", {}, `Add ${t.symbol}`));
    b.addEventListener("click", async () => {
      b.disabled = true;
      status.textContent = `Check your wallet to add ${t.symbol}…`;
      try {
        const added = await addTokenToWallet(injectedWallet(), code);
        status.replaceChildren(...(added ? [icon("check"), ` ${t.symbol} is in your wallet's token list now.`] : [`${t.symbol} was not added.`]));
      } catch (e) {
        status.textContent = addTokenError(e, code);
      } finally {
        b.disabled = false;
      }
    });
    return b;
  });
  return el("div", { class: "atw" }, el("div", { class: "atw-row" }, buttons), status);
}
