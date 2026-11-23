import { CAP, HAS_API, $, $$, el, icon, badge, naira, usd, getJson, loadRate, initChrome, parseMoneyInput, ageText, normalizeNtag, ntagError, CURRENCIES, currencyOf, formatCurrency, reverseCorridorFor, currencyOfReverse } from "../assets/core.js";
import { currencyPicker } from "../assets/currency-ui.js";

initChrome();

const amountIn = $("#amount");
const hint = $("#amount-hint");
const out = $("#receive");
const presetBox = $("#presets");
const recipientIn = $("#recipient");
const recipientHint = $("#recipient-hint");
const modeBtns = $$("#mode button");
const cmdPre = $("#cmd");
const askPre = $("#ask");
const reqPre = $("#req");
const cmdCopy = $("#cmd-copy");
const askCopy = $("#ask-copy");
const reqCopy = $("#req-copy");
const reqHint = $("#req-hint");
const celoToggle = $("#celo-toggle");
const celoRow = $("#celo-toggle-row");
/** request (usdt-*) adds a 0.01–0.99 suffix and must stay within the cap, so the base can be at most CAP - 0.01. */
const REQ_MAX = CAP - 0.01;

const NAME_RE = /^[a-z][a-z0-9_.-]{0,31}$/;
const RECIPIENT_HINT = "The name as it appears in your contacts.json.";
const nairaWhole = new Intl.NumberFormat("en-NG", { maximumFractionDigits: 0 });

/** What changes between the corridors (ids match the agent's --corridor values). usdt-<currency>: one per currency. */
const localView = (c) => ({
  sendToken: "USD₮", getToken: c.token, presets: [5, 10, 20, 25], start: 10, currency: c.code,
  presetLabel: (v) => `$${v}`,
  corridorHint: `You send USD₮. The recipient gets ${c.plural} (${c.token}).`,
  receiveLabel: "Recipient gets (approx.)",
  route: `USD₮ → ${c.token} on Textile FX`,
  delivered: `${c.token} on Celo, ${c.code === "cngn" ? "redeemable for naira" : `${/^[aeiou]/i.test(c.name) ? "an" : "a"} ${c.name} stablecoin`}`,
  emptyHint: "Enter an amount in dollars.",
  badHint: "Enter an amount in dollars, like 10 or 12.50.",
});
const VIEW = {
  ...Object.fromEntries(CURRENCIES.map((c) => [`usdt-${c.code}`, localView(c)])),
  "cngn-usdt": {
    sendToken: "cNGN", getToken: "USD₮", presets: [5000, 10000, 20000, 35000], start: 10000,
    presetLabel: (v) => `₦${v / 1000}k`,
    presetAria: (v) => `₦${nairaWhole.format(v)}`,
    corridorHint: "You send cNGN (naira). The recipient gets USD₮ (dollars).",
    receiveLabel: "Recipient gets in USD₮ (approx.)",
    route: "cNGN → USD₮ on Textile FX",
    delivered: "USD₮ on Celo, a dollar stablecoin",
    emptyHint: "Enter an amount in naira.",
    badHint: "Enter an amount in naira, like 10000 or 12500.50.",
  },
  // the reverse corridors of the other currencies: you send IDRX, wARS or wCOP, the recipient gets USD₮ (about $5 to $24)
  ...Object.fromEntries(CURRENCIES.slice(1).map((c) => {
    const ten = { idrx: 184000, wars: 17500, wcop: 34500 }[c.code];
    const k = (v) => `${c.symbol.length > 1 ? c.symbol + " " : c.symbol}${Math.round(v / 1000)}k`;
    return [reverseCorridorFor(c.code), {
      sendToken: c.token, getToken: "USD₮", presets: [ten / 2, ten, ten * 2, Math.floor(ten * 2.4 / 1000) * 1000], start: ten,
      presetLabel: k, presetAria: (v) => formatCurrency(v, c.code),
      corridorHint: `You send ${c.token} (${c.plural}). The recipient gets USD₮ (dollars).`,
      receiveLabel: "Recipient gets in USD₮ (approx.)",
      route: `${c.token} → USD₮ on Textile FX`,
      delivered: "USD₮ on Celo, a dollar stablecoin",
      emptyHint: `Enter an amount in ${c.plural}.`,
      badHint: `Enter an amount in ${c.plural}, like ${ten}.`,
    }];
  })),
  "celo-cngn": {
    sendToken: "CELO", getToken: "cNGN", presets: [20, 50, 100, 250], start: 50,
    presetLabel: (v) => String(v),
    presetAria: (v) => `${v} CELO`,
    corridorHint: "The agent sells its own CELO for USD₮, then USD₮ for cNGN (naira). Two swaps, two Textile fees.",
    receiveLabel: "Recipient gets in cNGN (approx.)",
    route: "CELO → USD₮ → cNGN on Textile FX (two swaps)",
    delivered: "cNGN on Celo, redeemable for naira",
    emptyHint: "Enter an amount in CELO.",
    badHint: "Enter an amount in CELO, like 50 or 120.5.",
  },
};
/** Textile needs about $1 notional per swap; below this the first or second swap is refused. */
const MIN_SWAP_USD = 1.05;
/** CELO the agent keeps for gas and never sells (MIN_CELO_RESERVE, default 2). */
const GAS_RESERVE_CELO = 2;
const LINK_NOTE_CELO = "CELO payment links aren't supported. Payouts from CELO are run by the owner with pay.";
const LINK_NOTE_REVERSE = (t) => `Payment links take USD₮ or cNGN only. ${t} to dollars is paid through a LokalPay tag or a pot, or by the owner with pay.`;

let quote = null; // result of loadRate(), or null while loading / on failure
let celo = null; // { celoUsdRate, celoPreviewCelo } from rate.json or /api/rate, or null if not published
let rateFailed = false;
let mode = "dry";
let corridor = "usdt-cngn";

const isReverse = () => /-usdt$/.test(corridor); // cngn-usdt, idrx-usdt, wars-usdt, wcop-usdt: local money in, dollars out
/** The local currency sent in a reverse corridor ("idrx"), or null. */
const fromCode = () => (isReverse() ? currencyOfReverse(corridor)?.code ?? null : null);
/** No payment link for this corridor: CELO, and the reverse corridors other than naira's. */
const noLink = () => isCelo() || (isReverse() && corridor !== "cngn-usdt");
const isCelo = () => corridor === "celo-cngn";
/** The local currency the recipient gets (usdt-* corridors and celo-cngn), or null (dollars). */
const curCode = () => (isReverse() ? null : isCelo() ? "cngn" : corridor.slice(5));
/** Local money per 1 USD₮ for the chosen currency, or null when not quoting / not loaded. */
const localRate = () => (quote && curCode() && quote.available[curCode()] ? quote.rates[curCode()] : null);
const fmtLocal = (n) => formatCurrency(n, curCode());
/** USD₮ received per 1 CELO (Textile fee included), or null when not published. */
const celoRate = () => (celo ? celo.celoUsdRate : null);
/** Smallest CELO amount that clears Textile's ~$1 minimum on both swaps (20 CELO when the rate is unknown). */
const minCelo = () => (celoRate() ? Math.max(1, Math.ceil(MIN_SWAP_USD / celoRate())) : 20);
const celoFmt = new Intl.NumberFormat("en-NG", { maximumFractionDigits: 2 });
const fmtCelo = (n) => `${celoFmt.format(n)} CELO`;
const usd4 = (n) => "$" + n.toFixed(4);
/** USD₮ received per 1 unit of the local currency sent (its <code>-usdt preview), or null when not published yet. */
const reverseRate = () => (fromCode() ? quote?.reverseRates?.[fromCode()] ?? (fromCode() === "cngn" ? quote?.reverseRate : null) ?? null : quote?.reverseRate ?? null);
/** A local amount in the currency sent ("Rp 446,369"). */
const fmtFrom = (n, places) => formatCurrency(n, fromCode() ?? "cngn", places);

// ---------- what they receive ----------
const picker = currencyPicker({
  label: "What the recipient receives", describedBy: "currency-label",
  extra: [{ code: "usd", label: "Dollars", flag: "usd", title: "Dollars (USD₮)" }],
  onChange: (code) => setCorridor(code === "usd" ? reverseCorridorFor(sendPicker.value) : `usdt-${code}`),
});
// for dollars: what you send (cNGN, IDRX, wARS or wCOP), each through its own <code>-usdt corridor
const sendPicker = currencyPicker({
  label: "What you send", value: "cngn", remember: false,
  options: CURRENCIES.map((c) => ({ code: c.code, label: c.token, flag: c.code, title: `${c.token} (${c.name})` })),
  onChange: (code) => setCorridor(reverseCorridorFor(code)),
});
const sendRow = el("div", { class: "mt-8" }, el("span", { class: "label" }, "You send"), sendPicker.el);
$("#currency-slot").replaceChildren(picker.el, sendRow);

/** The amount field read exactly (core.js parseMoneyInput: "1,5" is 1.50, "1,250" is 1250): { cents } or { error }. */
const parsedAmount = () => parseMoneyInput(amountIn.value);

/** Parse the amount field. Returns a positive number with at most 2 decimals, or null. */
function readAmount() {
  const p = parsedAmount();
  return p.error || !(p.cents > 0) ? null : p.cents / 100;
}
/** Why the typed amount can't be used, for the hint (null when it's fine or empty). */
function amountProblem(v) {
  if (!amountIn.value.trim()) return null;
  const p = parsedAmount();
  if (p.error) return p.error.startsWith("Enter a number") ? v.badHint : p.error;
  return p.cents > 0 ? null : "Enter an amount above zero.";
}

/** Amount as it would be typed on the command line: up to 2 decimals, no trailing zeros. */
const cliAmount = (n) => String(Math.round(n * 100) / 100);

/** USD value used for the cap: dollars sold (local money out) or USD₮ bought (dollars out). null if unknown. */
function usdValue(n) {
  if (n === null) return null;
  if (isCelo()) return celoRate() ? n * celoRate() : null;
  if (!isReverse()) return n;
  const rr = reverseRate();
  return rr ? n * rr : null;
}

function setText(node, ...children) { node.replaceChildren(...children); }

// ---------- corridor ----------
function renderPresets() {
  const v = VIEW[corridor];
  presetBox.replaceChildren(...v.presets.map((p) =>
    el("button", { type: "button", dataset: { amount: String(p) }, "aria-pressed": "false", "aria-label": v.presetAria?.(p) }, v.presetLabel(p))));
}

function renderCorridor() {
  const v = VIEW[corridor];
  // the CELO switch only makes sense for naira (the agent's CELO -> USD₮ -> cNGN)
  celoRow.hidden = picker.value !== "cngn";
  celoRow.style.display = celoRow.hidden ? "none" : "";
  celoToggle.checked = isCelo();
  sendRow.hidden = !isReverse();
  sendRow.style.display = sendRow.hidden ? "none" : "";
  setText($("#corridor-hint"), v.corridorHint);
  setText($("#amount-token"), v.sendToken);
  setText($("#receive-label"), v.receiveLabel);
  setText($("#kv-route"), v.route);
  setText($("#kv-delivered"), v.delivered);
  setText($("#check-wallet"), isCelo()
    ? el("span", {}, "The agent wallet holds the ", el("b", {}, "CELO"), " to sell, about 0.1 CELO for this payout's gas, and ", el("b", {}, `${GAS_RESERVE_CELO} CELO`), " more that it always keeps.")
    : el("span", {}, "The agent wallet holds the ", el("b", {}, v.sendToken), " and a little ", el("b", {}, "CELO"), " for gas."));
  setText($("#check-cap"), isCelo()
    ? el("span", {}, "The CELO is worth ", el("b", {}, `$${CAP} or less`), " in USD₮, and at least about ", el("b", {}, "$1.10"), ".")
    : isReverse()
    ? el("span", {}, "The amount is worth ", el("b", {}, `$${CAP} or less`), " in USD₮.")
    : el("span", {}, "The amount is ", el("b", {}, `$${CAP} or less`), "."));
  for (const id of ["#kv-leg1-row", "#kv-leg2-row", "#kv-min-row"]) $(id).hidden = !isCelo();
  $("#kv-market-row").hidden = !(corridor === "usdt-cngn" || isCelo() || corridor === "cngn-usdt"); // the market feed is naira only
  // plain-language commands take dollar amounts paid in naira only (.field sets display, so [hidden] alone isn't enough)
  const askField = $("#ask-field");
  const noAsk = corridor !== "usdt-cngn";
  askField.hidden = noAsk;
  askField.style.display = noAsk ? "none" : "";
  // CELO payouts and the reverse corridors other than naira's are not payment links: no link to build
  $("#req-code").style.display = noLink() ? "none" : "";
  $("#req-note").style.display = noLink() ? "none" : "";
  renderPresets();
}

function setCorridor(next) {
  if (next === corridor || !VIEW[next]) return;
  const sameUnit = VIEW[next].sendToken === VIEW[corridor].sendToken;
  corridor = next;
  if (!sameUnit) amountIn.value = String(VIEW[corridor].start); // amounts mean a different currency now
  renderCorridor();
  renderAll();
}

// ---------- amount + estimate ----------
function renderAmount() {
  const v = VIEW[corridor];
  const n = readAmount();
  for (const b of $$("button", presetBox)) b.setAttribute("aria-pressed", String(n !== null && Number(b.dataset.amount) === n));

  const usdv = usdValue(n);
  const lr = localRate();
  const code = curCode();
  const maxUsd = quote && code && !isCelo() ? quote.maxUsd[code] : null;
  const over = usdv !== null && usdv > CAP;
  const thin = !over && !isCelo() && !isReverse() && maxUsd !== null && n !== null && n > maxUsd;
  const unavailable = !isReverse() && quote !== null && code !== null && !quote.available[code];
  const under = (isCelo() && n !== null && (usdv !== null ? usdv < MIN_SWAP_USD : n < minCelo())) || (isReverse() && usdv !== null && usdv < 1);
  hint.classList.toggle("err", n === null || over || under || thin || unavailable);
  const capLocal = lr ? ` ≈ ${fmtLocal(CAP * lr)}` : "";
  if (n === null) setText(hint, amountProblem(v) ?? v.emptyHint);
  else if (unavailable) setText(hint, `${currencyOf(code).label} isn't available on Textile FX right now, so the agent would refuse this payment. Pick another currency, or try again later.`);
  else if (isCelo() && !celoRate() && !(quote || rateFailed)) setText(hint, `Checking the $${CAP} limit once the rate loads.`);
  else if (isCelo() && !celoRate() && under) setText(hint, `CELO rate not published yet. Textile needs about $1 per swap, so send at least about ${fmtCelo(minCelo())}.`);
  else if (isCelo() && !celoRate()) setText(hint, `CELO rate not published yet. The agent checks the $${CAP} limit on its own quote before paying.`);
  else if (under && isCelo()) setText(hint, `Worth about ${usd(usdv)}. Textile needs about $1 per swap, so send at least about ${fmtCelo(minCelo())}.`);
  else if (over && isCelo()) setText(hint, `Worth about ${usd(usdv)}, over the $${CAP} limit. The agent would refuse this payment.`);
  else if (isCelo()) setText(hint, `Worth about ${usd(usdv)}. The agent pays from about ${fmtCelo(minCelo())} up to $${CAP} (about ${fmtCelo(Math.floor(CAP / celoRate()))}).`);
  else if (over && isReverse()) setText(hint, `Worth about ${usd(usdv)}, over the $${CAP} limit. The agent would refuse this payment.`);
  else if (over) setText(hint, `Over the $${CAP}${capLocal} limit. The agent would refuse this payment.`);
  else if (thin) setText(hint, `Textile can convert up to about $${maxUsd.toFixed(2)} into ${currencyOf(code).plural} right now. Send less, or pick another currency.`);
  else if (!isReverse()) setText(hint, `$1 to $${CAP}${capLocal}, up to 2 decimals.`);
  else if (usdv !== null && usdv < MIN_SWAP_USD) setText(hint, `Worth about ${usd(usdv)}. Textile needs about $1 per swap, so send at least about ${fmtFrom(Math.ceil(MIN_SWAP_USD / reverseRate()), 0)}.`);
  else if (usdv !== null) setText(hint, `Worth about ${usd(usdv)}. The agent pays up to $${CAP} (about ${fmtFrom(CAP / reverseRate())}) per payment.`);
  else if (quote || rateFailed) setText(hint, `The agent pays up to $${CAP} per payment, checked against its firm quote before paying.`);
  else setText(hint, `Checking the $${CAP} limit once the rate loads.`);
  amountIn.setAttribute("aria-invalid", String(n === null || over || under || thin || unavailable));

  out.classList.toggle("over", over || under || thin || unavailable);
  if (isCelo()) {
    const ngn = quote?.rates.cngn;
    if (ngn && usdv !== null) setText(out, naira(usdv * ngn));
    else if (quote || rateFailed) setText(out, "—");
    setText($("#kv-leg1"), usdv !== null ? `${fmtCelo(n)} → about ${usd(usdv)}` : "—");
    setText($("#kv-leg2"), ngn && usdv !== null ? `about ${usd(usdv)} → about ${naira(usdv * ngn)}` : "—");
  } else if (!isReverse()) {
    if (quote) setText(out, n === null || !lr ? "—" : el("span", { title: `${currencyOf(code).name}, rounded down` }, fmtLocal(n * lr)));
    else if (rateFailed) setText(out, "—");
  } else if (quote || rateFailed) {
    setText(out, n === null || usdv === null ? "—" : usd(usdv));
  }

  if (quote) {
    if (isCelo()) {
      setText($("#kv-fees"), !celoRate() ? "Two Textile fees, one per swap"
        : quote.fromPreview ? `Two Textile fees, both included — previews for ${fmtCelo(celo.celoPreviewCelo)} and $${cliAmount(quote.previewUsd)}`
        : "Two Textile fees: CELO swap included, cNGN swap not (market bid)");
    } else if (!isReverse()) setText($("#kv-fees"), quote.fromPreview ? "Included — from a Textile FX preview" : "Not included — market bid");
    else setText($("#kv-fees"), !reverseRate() ? "—" : fromCode() === "cngn" ? `Included — Textile preview for ${naira(quote.reversePreviewNgn ?? 14400)}` : "Included — from a Textile FX preview");
  }
  return n;
}

// ---------- commands ----------
/** In the CELO corridor the payment-link builder is replaced by a plain note; otherwise the hint starts hidden. */
function showLinkNote() {
  reqHint.classList.toggle("err", !noLink());
  reqHint.hidden = !noLink();
  setText(reqHint, isCelo() ? LINK_NOTE_CELO : noLink() ? LINK_NOTE_REVERSE(VIEW[corridor].sendToken) : "");
}

/** The friendliest flag for this corridor on the agent's command line. */
function corridorFlagText() {
  if (corridor === "usdt-cngn") return "";
  const c = corridor.startsWith("usdt-") ? currencyOf(corridor.slice(5)) : null;
  return c ? ` --to-currency ${c.aliases[0]}` : ` --corridor ${corridor}`;
}

function renderCommand() {
  const n = readAmount();
  const raw = recipientIn.value;
  const lower = raw.toLowerCase();
  if (lower !== raw) {
    const pos = recipientIn.selectionStart;
    recipientIn.value = lower;
    try { recipientIn.setSelectionRange(pos, pos); } catch { /* not focused */ }
  }
  const name = recipientIn.value.trim();
  const nameOk = NAME_RE.test(name);
  recipientHint.classList.toggle("err", !nameOk);
  recipientIn.setAttribute("aria-invalid", String(!nameOk));
  setText(recipientHint, nameOk ? RECIPIENT_HINT
    : name ? "Start with a letter. Letters, numbers, dot, dash and underscore only."
    : "Enter the recipient's contact name.");

  for (const b of modeBtns) b.setAttribute("aria-pressed", String(b.dataset.mode === mode));

  const ready = nameOk && n !== null;
  if (!ready) {
    const msg = !nameOk ? "Fix the recipient name to build the command." : amountIn.value.trim() ? "Fix the amount to build the command." : "Enter an amount to build the command.";
    for (const p of [cmdPre, askPre, reqPre]) setText(p, msg);
    for (const b of [cmdCopy, askCopy, reqCopy]) { b.disabled = true; b.removeAttribute("data-copy"); }
    showLinkNote();
    return;
  }
  const amt = cliAmount(n);
  const exec = mode === "real" ? " --execute" : "";
  const corr = corridorFlagText();
  const cmd = `node src/agent.mjs pay --to ${name} --amount ${amt}${corr}${exec}`;
  // Single quotes keep "$10" literal in bash, zsh and PowerShell (double quotes would expand $1).
  const ask = `node src/agent.mjs ask 'send $${amt} to ${name}'${exec}`;
  const req = `node src/agent.mjs request --to ${name} --amount ${amt}${corr}`;
  setText(cmdPre, cmd);
  cmdCopy.disabled = false; cmdCopy.dataset.copy = cmd;
  if (noLink()) {
    setText(reqPre, "");
    reqCopy.disabled = true; reqCopy.removeAttribute("data-copy");
    setText(askPre, ""); askCopy.disabled = true; askCopy.removeAttribute("data-copy");
    showLinkNote();
    return;
  }
  setText(reqPre, req);
  const reqTooBig = !isReverse() && n > REQ_MAX + 1e-9;
  reqHint.classList.add("err");
  reqHint.hidden = !reqTooBig;
  setText(reqHint, reqTooBig ? `Leave room for the cents the agent adds: at most $${REQ_MAX.toFixed(2)}.` : "");
  if (reqTooBig) { reqCopy.disabled = true; reqCopy.removeAttribute("data-copy"); }
  else { reqCopy.disabled = false; reqCopy.dataset.copy = req; }
  if (corridor !== "usdt-cngn") { setText(askPre, ""); askCopy.disabled = true; askCopy.removeAttribute("data-copy"); }
  else { setText(askPre, ask); askCopy.disabled = false; askCopy.dataset.copy = ask; }
}

// ---------- rate ----------
function renderRate() {
  const rr = reverseRate();
  const cr = celoRate();
  const lr = localRate();
  const code = curCode();
  const ngn = quote.rates.cngn;
  if (isCelo()) setText($("#kv-rate"), cr && ngn ? `1 CELO ≈ ${usd4(cr)} ≈ ${naira(cr * ngn)}` : "CELO rate not published yet");
  else if (!isReverse()) setText($("#kv-rate"), lr ? `1 USD₮ = ${formatCurrency(lr, code, code === "cngn" ? 2 : currencyOf(code).places)}` : `${currencyOf(code).label}: not available right now`);
  else setText($("#kv-rate"), rr ? `1 USD₮ costs ${fmtFrom(1 / rr, 2)}` : "Not published yet");
  if (isCelo()) setText($("#kv-cap"), cr ? `$${CAP} per payment (about ${fmtCelo(Math.floor(CAP / cr))})` : `$${CAP} per payment`);
  else if (isReverse()) setText($("#kv-cap"), rr ? `$${CAP} per payment (about ${fmtFrom(CAP / rr)})` : `$${CAP} per payment`);
  else setText($("#kv-cap"), lr ? `$${CAP} per payment ≈ ${fmtLocal(CAP * lr)}` : `$${CAP} per payment`);
  setText($("#kv-min"), cr ? `About ${fmtCelo(minCelo())} (about ${usd(minCelo() * cr)}), $1 per swap` : "About 20 CELO (about $1.10), $1 per swap");
  setText($("#basis"), quote.fromPreview ? "Fees included" : "Before fees");

  // a stale feed (an old rate.json on a host without the live API) must not claim the 30-minute refresh
  const age = ageText(quote.ageMin);
  const fresh = badge("", quote.stale ? "warn" : "ok");
  fresh.append(el("span", { class: "dot" }), quote.stale ? `Stale · updated ${age}` : `Updated ${age}`);
  $("#kv-source").replaceChildren(
    el("span", { class: "row", style: "justify-content:flex-end;gap:8px" }, el("span", {}, quote.stale ? "Textile FX, not refreshed recently" : HAS_API ? "Textile FX, live" : "Textile FX, refreshed every 30 min"), fresh),
  );
  const nextRefresh = quote.stale ? "on its next refresh" : "on its next refresh (every 30 min)";
  const t = quote.ticker;
  const bid = Number(t?.bid), ask = Number(t?.ask);
  setText($("#kv-market"), bid > 0 && ask > 0 ? `${naira(bid)} / ${naira(ask)}` : "—");

  const alerts = [];
  if (isCelo() && !cr) {
    alerts.push(el("div", { class: "alert warn mt-16" }, icon("alert"),
      el("span", {}, el("b", {}, "CELO rate not published yet. "),
        `The CELO price is added to the rate feed ${nextRefresh}. For a live price now, run `,
        el("code", { class: "inline" }, "node src/agent.mjs quote --amount 50 --corridor celo-cngn"), ".")));
  }
  if (isReverse() && !rr) {
    alerts.push(el("div", { class: "alert warn mt-16" }, icon("alert"),
      el("span", {}, el("b", {}, "Reverse rate not published yet. "),
        `The ${currencyOf(fromCode()).plural}-to-dollar price is added to the rate feed ${nextRefresh}. For a live price now, run `,
        el("code", { class: "inline" }, `node src/agent.mjs quote --amount ${VIEW[corridor].start} --corridor ${corridor}`), ".")));
  }
  if (quote.stale) {
    alerts.push(el("div", { class: "alert warn mt-16" }, icon("alert"),
      el("span", {}, "This rate is older than usual, so the real quote may differ. The agent always takes a fresh firm quote before paying.")));
  }
  $("#rate-error").replaceChildren(...alerts);
}

function renderRateError() {
  for (const id of ["#kv-rate", "#kv-fees", "#kv-source", "#kv-market", "#kv-leg2"]) setText($(id), "—");
  setText($("#kv-cap"), `$${CAP} per payment`);
  setText($("#kv-min"), "About 20 CELO (about $1.10), $1 per swap");
  setText($("#basis"), "Unavailable");
  $("#rate-error").replaceChildren(el("div", { class: "alert err mt-16" }, icon("alert"),
    el("span", {}, "Couldn't load the exchange rate. Refresh the page to try again, or check live rates in the ",
      el("a", { class: "link", href: "https://fx-docs.textilecredit.com" }, "Textile FX docs"), ".")));
}

function renderAll() {
  if (quote) renderRate();
  renderAmount();
  renderCommand();
}

// ---------- events ----------
amountIn.addEventListener("input", () => { renderAmount(); renderCommand(); });
presetBox.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-amount]");
  if (!b) return;
  amountIn.value = b.dataset.amount;
  renderAmount(); renderCommand();
});
celoToggle.addEventListener("change", () => setCorridor(celoToggle.checked ? "celo-cngn" : "usdt-cngn"));
recipientIn.addEventListener("input", renderCommand);

// "Pay someone by @nTag": Enter (or Go) opens that tag's pay page
const tagIn = $("#tag-q"), tagHint = $("#tag-hint");
$("#tag-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const tag = normalizeNtag(tagIn.value);
  const err = tag ? ntagError(tag) : "enter a tag, like @ada";
  if (err) {
    tagHint.classList.add("err");
    setText(tagHint, err[0].toUpperCase() + err.slice(1) + ".");
    tagIn.setAttribute("aria-invalid", "true");
    tagIn.focus();
    return;
  }
  location.href = `tag.html#${tag}`;
});
tagIn.addEventListener("input", () => { tagHint.classList.remove("err"); setText(tagHint, ""); tagIn.removeAttribute("aria-invalid"); });
for (const b of modeBtns) {
  b.addEventListener("click", () => { mode = b.dataset.mode; renderCommand(); });
}

// quote.html#corridor=usdt-idrx (or cngn-usdt, celo-cngn) opens in that corridor (shareable from other pages and docs);
// otherwise the picker's own start (the last currency chosen on this device, else naira).
const hashCorridor = new URLSearchParams(location.hash.slice(1)).get("corridor");
if (hashCorridor && VIEW[hashCorridor]) {
  corridor = hashCorridor;
  picker.set(isReverse() ? "usd" : isCelo() ? "cngn" : corridor.slice(5), { silent: true });
  if (isReverse()) sendPicker.set(fromCode(), { silent: true });
  amountIn.value = String(VIEW[corridor].start);
} else if (picker.value !== "cngn") {
  corridor = `usdt-${picker.value}`;
}

renderCorridor();
renderAmount();
renderCommand();

/** core.js loadRate() doesn't pass celoUsdRate through, so read it from the same source (the live API on Vercel,
 *  else rate.json). A failure here only hides the CELO corridor's estimate. */
async function loadCeloRate() {
  let d = null;
  if (HAS_API) { try { d = await getJson("/api/rate"); } catch { d = null; } }
  if (!(Number(d && d.celoUsdRate) > 0)) { try { d = await getJson("rate.json", { cache: "no-store" }); } catch { d = null; } }
  const r = Number(d && d.celoUsdRate);
  return r > 0 ? { celoUsdRate: r, celoPreviewCelo: Number(d.celoPreviewCelo) > 0 ? Number(d.celoPreviewCelo) : 20 } : null;
}
const celoP = loadCeloRate().catch(() => null);

try {
  quote = await loadRate();
  picker.setAvailability(quote.available);
} catch {
  rateFailed = true;
  renderRateError();
}
celo = await celoP;
renderAll();
