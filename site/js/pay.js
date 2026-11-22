import {
  AGENT, CAP, WALLET_DAILY_CAP, DAILY_CAP, TOKENS, CORRIDORS, EXPLORER_API, SEL, $, $$, el, icon, badge, naira, usd, num2, short,
  lagosTime, lagosClock, celoscanTx, celoscanAddr, getJson, loadRate, parseRequest, initChrome, parseMoneyInput,
  loadTxByHash, decodeRegistration, registrationError, loadRegistrations, registrationStatuses, receiptNo,
  rpc, readContract, loadReceipt, encodeCall, tagSuffix, markWalletConnected, walletDisconnected, isNetworkError,
  CURRENCIES, currencyOfCorridor, formatCurrency,
} from "../assets/core.js";
import { currencyPicker, flagIcon } from "../assets/currency-ui.js";
import { bindDisclosures, qrDisclosure, successPanel, successHeadline, rateSummary, limitsSummary } from "../assets/disclose.js";
import { ensureCelo, explainWalletError } from "../assets/session.js";
import {
  agentStatus, depositStatus, allowanceFromStatus, globalFromStatus, receivedStale, statusFinal, sourceNote, refusedNote, refundedLine, refundedText,
  DELAYED_NOTE, SLOW_NOTE,
} from "../assets/ntag-ui.js";

initChrome();

const CELO_CHAIN_ID = 42220;
const POLL_MS = 10_000;
const NAME_RE = /^[^"`$\\]{1,40}$/; // any contacts.json key the CLI accepts, safe inside double quotes
const MAX_HOURS = 168; // src/requests.mjs MAX_HOURS
const MAX_USDT_BASE = 24.99; // the agent adds 0.01-0.99 and keeps the total <= CAP

const setText = (node, text) => node.replaceChildren(text);
const sameAddr = (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
const tokenOf = (key) => TOKENS[key]; // "USDT" | "cNGN" | "IDRX" | "wARS" | "wCOP"

/** "5.03" -> 5030000n (the payer sends USD₮ or cNGN: both use 6 decimals on Celo). parseRequest already checked the format. */
function toUnits(amount) {
  const [i, f = ""] = String(amount).split(".");
  return BigInt(i) * 1_000_000n + BigInt((f + "000000").slice(0, 6));
}
/** The exact amount with thousands separators and every decimal kept (never rounded). */
function exactAmount(amount) {
  const [i, f] = String(amount).split(".");
  return BigInt(i).toLocaleString("en-NG") + (f ? "." + f : "");
}
function countdown(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (d > 0) return `in ${d} d ${h} h`;
  if (h > 0) return `in ${h} h ${m} min`;
  if (m > 0) return `in ${m} min ${sec} s`;
  return `in ${sec} s`;
}

// ---------- routing ----------
const hashParams = new URLSearchParams(location.hash.slice(1));
const token = hashParams.get("r");
const regHash = hashParams.get("tx");
addEventListener("hashchange", () => location.reload());

if (!location.hash.slice(1)) {
  initBuilder();
  initOpenLink();
} else if (regHash !== null) {
  initRegistration(regHash.trim());
} else {
  let req = null;
  try {
    if (!token) throw new Error("This link is missing its payment details. Ask for a new one.");
    req = parseRequest(token);
  } catch (e) {
    showError(e.message);
  }
  if (req) initLink(req);
}

/**
 * The error view. opts: { title, lead, retry (bool), help: [children] , foot: [text, href, label] }
 */
function showError(message, opts = {}) {
  $("#view-explainer").hidden = true;
  $("#view-loading").hidden = true;
  $("#view-link").hidden = true;
  $("#view-error").hidden = false;
  setText($("#err-msg"), message);
  if (opts.title) setText($("#err-title"), opts.title);
  if (opts.lead) setText($("#err-lead"), opts.lead);
  if (opts.help) $("#err-help").replaceChildren(...opts.help);
  if (opts.foot) {
    const [text, href, label] = opts.foot;
    setText($("#err-foot-text"), text);
    const a = $("#err-foot-link");
    a.href = href;
    a.replaceChildren(label, icon("right"));
  }
  if (opts.retry) {
    $("#err-retry-row").hidden = false;
    $("#err-retry").addEventListener("click", () => location.reload(), { once: true });
  }
  document.title = (opts.title ? opts.title.replace(/\.$/, "") : "Link can't be opened") + " · Lokal";
}

// =====================================================================
// #tx=<hash>: a request the recipient registered onchain from their own wallet
// =====================================================================
async function initRegistration(hash) {
  const txHelp = [
    "Links can break when a chat app cuts them short. Copy the whole link, including everything after ",
    el("code", { class: "inline" }, "#tx="), ", and open it again.",
  ];
  const getPaidFoot = ["Want to be paid to your own wallet?", "get-paid.html", "Create a link"];
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    showError("The transaction id in this link is incomplete or has extra characters.", { help: txHelp, foot: getPaidFoot });
    return;
  }

  $("#view-explainer").hidden = true;
  $("#view-loading").hidden = false;

  // A brief network blip (or an RPC node a block behind a just-made link) shouldn't end in an error page:
  // try 3 more times, 1 s, 2 s and 4 s apart, before giving up.
  let tx;
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        tx = await loadTxByHash(hash);
        if (tx || attempt >= 3) break;
      } catch (e) {
        if (attempt >= 3) throw e;
      }
      await new Promise((res) => setTimeout(res, 1000 * 2 ** attempt));
    }
  } catch {
    showError("Couldn't reach the Celo network to read this link.", {
      title: "Couldn't load this link",
      lead: "This is usually a brief network problem. Don't send any money until the link loads.",
      retry: true,
      help: ["You can also look the transaction up on ", el("a", { class: "link", href: celoscanTx(hash) }, "Celoscan"), "."],
    });
    return;
  }
  const notALink = { title: "This isn't a payment link", lead: "Don't send any money for it. Ask the person who shared it for a new link.", foot: getPaidFoot };
  const onCeloscan = ["See the transaction on ", el("a", { class: "link", href: celoscanTx(hash) }, "Celoscan"), "."];

  if (!tx) {
    showError("No transaction with this id exists on Celo.", { help: txHelp, foot: getPaidFoot });
    return;
  }
  if (tx.status === "pending") {
    showError("This link was just created and its transaction hasn't confirmed yet.", {
      title: "Almost ready",
      lead: "Celo confirms a transaction in a few seconds. Try again shortly, and don't send money until the link loads.",
      retry: true, help: onCeloscan,
    });
    return;
  }
  const req = tx.to && sameAddr(tx.to, AGENT) ? decodeRegistration(tx.input) : null;
  if (!req) {
    // One of the agent's own transactions: it isn't a link, but it does have a receipt.
    const ownTx = tx.from && sameAddr(tx.from, AGENT);
    const help = ownTx
      ? ["This is one of the agent's own transactions. ", el("a", { class: "link", href: `receipt.html#${receiptNo(hash)}` }, `Open its receipt ${receiptNo(hash)}`), "."]
      : onCeloscan;
    showError("This transaction exists on Celo, but it isn't a payment request sent to the agent.", { ...notALink, help });
    return;
  }
  if (tx.status !== "ok") {
    showError("The transaction behind this link failed, so it never registered a payment request.", { ...notALink, help: onCeloscan });
    return;
  }
  const blockSec = Math.floor(tx.timestamp / 1000);
  const why = registrationError(req, blockSec);
  if (why) {
    showError(`This payment request breaks the rules the agent checks (${why}), so the agent will never pay it.`, { ...notALink, help: onCeloscan });
    return;
  }

  $("#view-loading").hidden = true;
  initLink({
    id: tx.hash.toLowerCase(), name: req.n.trim(), amount: req.a, dir: req.d, created: blockSec * 1000, exp: req.e * 1000,
    note: req.m || null, recipient: tx.from, regBlock: tx.blockNumber,
  });
}

// =====================================================================
// Payment link view
// =====================================================================
function initLink(req) {
  $("#view-explainer").hidden = true;
  $("#view-link").hidden = false;

  const corridor = CORRIDORS[req.dir];
  const sell = tokenOf(corridor.sell), buy = tokenOf(corridor.buy);
  const units = toUnits(req.amount);
  const uri = `ethereum:${sell.address}@${CELO_CHAIN_ID}/transfer?address=${AGENT}&uint256=${units}`;
  const cur = currencyOfCorridor(req.dir); // the local currency this link pays out in, or null (dollars)
  const inNaira = cur !== null; // the payer sends USD₮ and the recipient gets local money
  const sendText = `${exactAmount(req.amount)} ${sell.symbol}`;
  const isReg = !!req.recipient; // #tx= link: the recipient registered it from their own wallet

  document.title = `Pay ${req.name} · Lokal`;
  setText($("#l-name"), req.name);
  const to = isReg ? `${req.name}'s wallet` : req.name;
  setText($("#l-lead"), inNaira
    ? `Send USD₮ on Celo; the agent pays ${to} in ${cur.plural}.`
    : `Send cNGN on Celo; the agent pays ${to} in dollars.`);
  bindDisclosures(document);

  if (isReg) {
    $("#l-who").hidden = false;
    setText($("#w-name"), req.name);
    const w = $("#w-wallet");
    w.href = celoscanAddr(req.recipient);
    setText(w, short(req.recipient));
    w.title = req.recipient;
    setText($("#w-wallet-full"), short(req.recipient));
    $("#w-wallet-full").title = req.recipient;
    $("#w-wallet-copy").dataset.copy = req.recipient;
    setText($("#w-time"), `${lagosTime(req.created)} WAT`);
    $("#w-reg").href = celoscanTx(req.id);
    setText($("#l-id-label"), "Registration");
    $("#l-id").replaceChildren(el("a", { class: "link", href: celoscanTx(req.id), title: req.id }, short(req.id)));
    $("#l-safe-who").replaceChildren("The agent pays only ", el("b", { class: "mono" }, short(req.recipient)),
      ", the wallet that registered this link, up to ", el("b", {}, `$${CAP} per payment`), ". Don't pay from that same wallet: the agent won't pay it.");
  }
  const regNote = el("div", { "aria-live": "polite" });
  $("#l-notice").append(regNote);

  // amount + where to send
  $("#l-amount").value = exactAmount(req.amount);
  setText($("#l-token"), sell.symbol);
  $("#l-amount-copy").dataset.copy = req.amount;
  $("#l-receive-label").replaceChildren(`${req.name} gets (approx.) `,
    el("span", { class: "badge neutral cur-inline", style: "margin-left:6px" }, inNaira ? flagIcon(cur.code) : flagIcon("usd"), inNaira ? `${cur.label} · ${cur.token}` : "Dollars · USD₮"));
  const agentLink = $("#l-agent");
  agentLink.href = celoscanAddr(AGENT);
  setText(agentLink, short(AGENT));
  agentLink.title = AGENT;
  $("#l-agent-copy").dataset.copy = AGENT;
  setText($("#l-agent-short"), short(AGENT));
  setText($("#l-token-name"), sell.symbol);
  const tokenLink = $("#l-token-addr");
  tokenLink.href = celoscanAddr(sell.address);
  setText(tokenLink, short(sell.address));
  tokenLink.title = sell.address;
  setText($("#l-exp-time"), ` · ${lagosTime(req.exp)} WAT`);
  if (!isReg) setText($("#l-id"), req.id);
  if (req.note) { $("#l-note-row").hidden = false; setText($("#l-note"), req.note); }

  // pay options: "Open in wallet" up front when this browser has no wallet; the rest under "Other ways to pay"
  $("#l-open").href = uri;
  $("#l-open-alt").href = uri;
  $("#l-uri-copy").dataset.copy = uri;
  $("#l-manual-copy").dataset.copy = AGENT;
  setText($("#l-manual-addr"), AGENT);
  $("#l-manual-text").replaceChildren("Or send exactly ", el("b", { class: "num" }, sendText), " on the Celo network to the agent's address below. Use the ",
    el("a", { class: "link", href: celoscanAddr(sell.address) }, `${sell.symbol} token on Celo`), ", not one on another network.");
  // the QR code is drawn only when someone opens it
  $("#l-qr-slot").replaceChildren(qrDisclosure(uri, "QR code of the wallet payment link", { caption: "Scan with a Celo wallet camera. It fills in the token, amount and address." }).el);

  // live rate -> approximate amount received
  loadRate().then((r) => {
    let usdValue = null;
    if (inNaira) {
      usdValue = Number(req.amount);
      const pu = r.available[cur.code] ? r.rates[cur.code] : null;
      setText($("#l-receive"), pu ? formatCurrency(Number(req.amount) * pu, cur.code) : "—");
      setText($("#l-rate"), pu ? `1 USD₮ = ${formatCurrency(pu, cur.code, cur.code === "cngn" ? 2 : cur.places)}` : `${cur.label}: not available right now`);
      if (!pu) {
        $("#l-notice").append(el("div", { class: "alert warn mt-16" }, icon("alert"),
          el("span", {}, `${cur.label} isn't available on Textile FX right now. A payment sent now would be refused (never paid in another currency) and stay with the agent. Try again later.`)));
      }
    } else if (r.reverseRate) {
      usdValue = Number(req.amount) * r.reverseRate;
      setText($("#l-receive"), `${num2.format(usdValue)} USD₮`);
      setText($("#l-rate"), `1 USD₮ = ${naira(1 / r.reverseRate)}`);
    } else {
      setText($("#l-receive"), "—");
      setText($("#l-rate"), "Not published yet");
    }
    setText($("#l-rate-sum"), rateSummary({ rateText: $("#l-rate").textContent, fees: r.fromPreview ? "included" : "before" }));
    if (usdValue !== null && usdValue > CAP) {
      $("#l-notice").append(el("div", { class: "alert warn mt-16" }, icon("alert"),
        el("span", {}, `This is over the agent's $${CAP} per-payment limit, so autopilot won't pay it out. Ask for a smaller request before sending.`)));
    }
    // cNGN is valued in dollars at the rate (the reverse preview when published); other local money at its own rate
    const usdOfNgn = (n) => (r.reverseRate ? n * r.reverseRate : n / r.rate);
    const usdOfLocal = (code, n) => (code === "cngn" ? usdOfNgn(n) : r.rates[code] ? n / r.rates[code] : 0);
    renderRoom(usdValue ?? usdOfNgn(Number(req.amount)), usdOfLocal);
  }).catch(() => {
    setText($("#l-receive"), "—");
    setText($("#l-rate"), "Unavailable");
    setText($("#l-rate-sum"), "Rate unavailable");
    $("#l-notice").append(el("div", { class: "alert mt-16" }, icon("info"),
      el("span", {}, "Couldn't load the exchange rate, so the amount received isn't shown. The agent takes a fresh firm quote when it pays.")));
  });

  // state: the deposit and payout found on chain, if any
  // regs: every registration sent to the agent (#tx= links only), to apply the same-amount rule
  // agent: the agent's own record of the deposit from the status server (exact), or null (then the chain is read)
  const state = { deposit: null, payout: null, error: false, checkedAt: null, regs: null, agent: null };
  const refused = () => state.agent?.status === "refused" || state.agent?.status === "refunded";
  const refunded = () => state.agent?.status === "refunded";
  // what the agent says while no payout is known: "failed" (delayed), "received" (paying now, or slow when old)
  const agentWaiting = () => (state.payout ? null : state.agent?.status === "failed" ? "failed"
    : state.agent?.status === "received" ? (receivedStale(state.agent) ? "slow" : "paying") : null);
  let timer = null, busy = false;
  const expired = () => Date.now() >= req.exp;
  const regStatusAt = (sec) => registrationStatuses(state.regs, sec).get(req.id);
  /** null while unknown; "active" for #r= links. "in-use" = an earlier link took this amount. */
  const regNow = () => (!isReg ? "active" : state.regs ? regStatusAt(Math.floor(Date.now() / 1000)) : null);
  const selfPaid = () => isReg && state.deposit && sameAddr(state.deposit.from, req.recipient);
  /** Pay options show only while the link is open, unpaid and (for #tx= links) not taken by an earlier link. */
  const canPayNow = () => !expired() && !state.deposit && regNow() === "active";

  function renderRegNote() {
    if (!isReg || state.deposit || expired()) return regNote.replaceChildren();
    const s = regNow();
    if (s === null) {
      regNote.replaceChildren(state.error ? "" : el("p", { class: "small muted mt-16" }, "Checking that no earlier link uses this amount…"));
    } else if (s === "in-use") {
      regNote.replaceChildren(el("div", { class: "alert err mt-16" }, icon("alert"),
        el("span", {}, `Don't send money to this link. An earlier link already asks for exactly ${sendText}, so a payment of this amount would be matched to that link, not to ${req.name}. ${req.name} should `,
          el("a", { class: "link", href: "get-paid.html" }, "create a new link"), " with a slightly different amount.")));
    } else regNote.replaceChildren();
  }

  function render() {
    renderRegNote();
    const inUse = regNow() === "in-use";
    // pay options stay visible only while the link is open, unpaid and (for #tx= links) not taken by an earlier link
    // and never while a payment from this tab is on its way (no second payment by accident)
    const canPay = canPayNow() && !sentActive();
    $("#l-actions").hidden = !canPay || Boolean(eth);
    $("#l-open-alt").hidden = !eth;
    $("#l-other").hidden = !canPay;
    $("#l-amount-hint").hidden = !canPay;
    $("#l-limits").hidden = !canPayNow();
    $("#l-room-warn").hidden = !canPayNow();
    renderWallet();

    const expBadge = $("#l-exp-badge");
    if (state.deposit || inUse) expBadge.replaceChildren();
    else if (expired()) expBadge.replaceChildren(badge("Expired", "err"));
    else expBadge.replaceChildren(badge("Open", "neutral"));

    // header badge
    let b;
    if (state.payout) b = badge("", "ok"), b.append(el("span", { class: "dot" }), "Paid out");
    else if (refunded()) b = badge(refundedText(state.agent), "neutral");
    else if (refused()) b = badge("Not paid", "err");
    else if (selfPaid()) b = badge("Won't be paid out", "err");
    else if (state.deposit) b = badge("", "ok"), b.append(el("span", { class: "dot" }), "Payment received");
    else if (expired()) b = badge("Expired", "err");
    else if (inUse) b = badge("Amount in use", "err");
    else if (state.error && !state.checkedAt) b = badge("Couldn't check", "warn");
    else if (!state.checkedAt) b = null;
    else b = badge("", "warn"), b.append(el("span", { class: "dot" }), "Waiting for payment");
    if (b) $("#l-status-badge").replaceChildren(b);

    // deposit row
    const dep = $("#l-st-deposit");
    if (state.deposit) {
      dep.replaceChildren(el("span", { class: "row", style: "justify-content:flex-end;gap:8px" },
        el("span", {}, "From ", el("span", { class: "mono" }, short(state.deposit.from))),
        el("a", { class: "link", href: celoscanTx(state.deposit.hash) }, "View transaction ", icon("ext"))));
    } else if (inUse && state.checkedAt) {
      setText(dep, "—");
    } else if (state.checkedAt) {
      setText(dep, expired() ? "None before expiry" : "Not received yet");
    } else if (state.error) setText(dep, "—");

    // payout row
    setText($("#l-st-payout-label"), `Payout to ${req.name}`);
    const pay = $("#l-st-payout");
    if (state.payout) {
      const href = isReg ? `receipt.html#p=${state.payout.hash}` : `receipt.html#p=${state.payout.hash}&r=${req.id}`;
      pay.replaceChildren(el("a", { class: "link", href, title: receiptNo(state.payout.hash) }, "View receipt ", icon("right")));
    } else if (refunded()) {
      setText(pay, "Not paid: refunded");
    } else if (refused() || selfPaid()) {
      setText(pay, "Not paid");
    } else if (state.deposit) {
      const w = agentWaiting();
      setText(pay, w === "failed" ? "Delayed" : w === "slow" ? "Taking longer than usual" : w === "paying" ? "Paying now" : "In progress");
    } else if (state.checkedAt || state.error) {
      setText(pay, expired() || inUse ? "—" : "After payment");
    }

    setText($("#l-st-checked"), state.checkedAt ? `${lagosClock(state.checkedAt)} WAT` : state.error ? "—" : "");
    if (!state.checkedAt && !state.error) $("#l-st-checked").replaceChildren(el("span", { class: "skel" }));

    // explanatory message under the status
    const msg = $("#l-st-msg");
    if (state.error) {
      msg.replaceChildren(el("div", { class: "alert warn mt-16" }, icon("alert"),
        el("span", {}, "Couldn't reach the Celo explorer. Trying again in 10 s. You can also check the ",
          el("a", { class: "link", href: celoscanAddr(AGENT) }, "agent on Celoscan"), ".")));
    } else if (state.payout) {
      msg.replaceChildren(el("p", { class: "small muted mt-16" }, isReg
        ? `${req.name} has been paid to ${short(req.recipient)}, the wallet that registered this link. The receipt rebuilds the payout from the chain.`
        : `${req.name} has been paid. The receipt rebuilds the payout from the chain.`));
    } else if (refunded()) {
      msg.replaceChildren(el("div", { class: "alert mt-16" }, icon("check"), refundedLine(state.agent)));
    } else if (refused()) {
      msg.replaceChildren(el("div", { class: "alert err mt-16" }, icon("alert"), el("span", {}, refusedNote(state.agent.reason))));
    } else if (selfPaid()) {
      msg.replaceChildren(el("div", { class: "alert err mt-16" }, icon("alert"),
        el("span", {}, `This payment came from ${short(req.recipient)}, the same wallet the link pays. The agent doesn't pay a link from its own recipient, so it won't be paid out. `,
          el("a", { class: "link", href: "verify.html" }, "Look up a transaction"), " for details.")));
    } else if (state.deposit && agentWaiting() === "failed") {
      msg.replaceChildren(el("div", { class: "alert warn mt-16" }, icon("alert"),
        el("span", {}, el("b", {}, DELAYED_NOTE), " Don't send it again: the payment is safe with the agent and is paid once the owner retries it.")));
    } else if (state.deposit) {
      const w = agentWaiting();
      msg.replaceChildren(el("div", { class: "alert mt-16" }, icon("check"),
        el("span", {}, w === "paying"
          ? `Payment received. Don't send it again. The agent has recorded it and is paying ${req.name} now.`
          : w === "slow"
            ? `Payment received. Don't send it again. ${SLOW_NOTE} The agent recorded it but hasn't reported the payout yet.`
            : "Payment received. Don't send it again. Autopilot converts it and pays out on its next pass, usually within a few minutes while it is running.")));
    } else if (expired()) {
      msg.replaceChildren(el("div", { class: "alert err mt-16" }, icon("alert"),
        el("span", {}, `This link expired on ${lagosTime(req.exp)} WAT. Don't send money to it: the agent no longer matches deposits for it. Ask for a new link.`)));
    } else if (inUse) {
      msg.replaceChildren(el("p", { class: "small muted mt-16" }, "Nothing to track: this link can't be paid while an earlier link uses the same amount."));
    } else if (state.checkedAt) {
      msg.replaceChildren(el("p", { class: "small muted mt-16" }, "Checks the chain every 10 seconds while this tab is open. A payment shows here a few seconds after it confirms."));
    } else msg.replaceChildren();
    // where the payout status comes from, once there is a deposit to report on
    if (state.deposit && !state.error) msg.append(el("p", { class: "micro muted mt-8" }, sourceNote(Boolean(state.agent) && !state.payoutFromChain, "nt-source")));
  }

  function tickCountdown() {
    const left = req.exp - Date.now();
    setText($("#l-countdown"), left > 0 ? countdown(left) : "Expired");
    if (left <= 0 && !$("#l-other").hidden) render();
  }

  async function check() {
    if (busy || document.visibilityState !== "visible") return;
    busy = true;
    try {
      if (isReg && !state.regs) {
        const regs = (await loadRegistrations(20)).map((r) => ({ ...r, hash: String(r.hash).toLowerCase() }));
        // the explorer can lag a few seconds behind the RPC; without our own entry the rule can't be applied
        if (!regs.some((r) => r.hash === req.id)) throw new Error("registration not indexed yet");
        state.regs = regs;
      }
      if (regNow() !== "in-use" && !state.deposit) {
        // for #tx= links, a deposit counts only if this link was the active one for that amount when it arrived
        const accept = isReg ? (t) => regStatusAt(Math.floor(t.ts / 1000)) === "active" : () => true;
        state.deposit = await findDeposit(sell.address, units, req.created, req.exp, accept);
      }
      if (state.deposit && !state.payout && !selfPaid()) {
        // the agent's own record: "paid" / "refused" are final. For "received", "failed" or no record, look for the payout
        // on the chain as before; one found there wins.
        const ev = depositStatus(await agentStatus({ tx: state.deposit.hash }), state.deposit.hash,
          { logIndex: state.deposit.logIndex, kind: isReg ? "registration" : "request", amount: req.amount });
        state.agent = ev;
        if (ev?.status === "paid") state.payout = { hash: ev.payoutTx, exact: true };
        else if (ev?.status === "refused") { /* final for the payout; keep asking: it may be refunded */ }
        else if (!statusFinal(ev)) {
          state.payout = await findPayout(buy.address, state.deposit, isReg ? req.recipient : null);
          state.payoutFromChain = Boolean(state.payout);
        }
      }
      state.error = false;
      state.checkedAt = Date.now();
    } catch {
      state.error = true;
    } finally {
      busy = false;
    }
    render();
    schedule();
  }
  function schedule() {
    clearTimeout(timer);
    if (state.payout || selfPaid() || refunded()) return; // done (a refused payment is still watched for its refund)
    if (expired() && !state.deposit && state.checkedAt) return; // nothing more can happen
    timer = setTimeout(check, POLL_MS);
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !state.payout) { clearTimeout(timer); check(); }
  });

  // ---------- today's room under the limits ----------
  /**
   * Shows how much more the recipient (#tx= links: the registering wallet) or the agent overall (#r= links: the
   * contact's wallet isn't on the link) can be paid in the rolling 24 hours, from the agent's transfers on Blockscout,
   * and warns when this payment would go over. A failure here only hides the line.
   */
  async function renderRoom(payUsd, usdOfLocal) {
    const box = $("#l-room");
    const valueOf = (t) => {
      const tok = t.token?.address_hash ?? t.token?.address;
      const c = CURRENCIES.find((x) => sameAddr(x.address, tok));
      const v = Number(t.total?.value ?? 0) / 10 ** Number(t.total?.decimals ?? (c ? c.decimals : 6));
      if (sameAddr(tok, TOKENS.USDT.address)) return v;
      if (c) return usdOfLocal(c.code, v);
      return 0; // other tokens are never payouts
    };
    const since = Date.now() - 24 * 3600_000;
    try {
      // Both sources: the agent's totals (only when fresh) and its transfers on the chain. The LARGER amount used wins
      // (the smaller room); the numbers are exact only when the agent's figure is that larger one.
      const a = await agentStatus(isReg ? { recipient: req.recipient } : {}).catch(() => null);
      const sAll = globalFromStatus(a)?.usedUsd ?? null;
      const sPerson = isReg ? allowanceFromStatus(a)?.usedUsd ?? null : null;
      let cAll = null, cPerson = null;
      try {
        let o = 0;
        for await (const t of transfers("from", null, since)) {
          if (!sameAddr(t.from?.hash, AGENT) || sameAddr(t.to?.hash, AGENT) || t.method !== "transfer") continue;
          o += valueOf(t);
        }
        let p = null;
        if (isReg) {
          p = 0;
          for await (const t of addressTransfers(req.recipient, "to", since)) if (sameAddr(t.from?.hash, AGENT)) p += valueOf(t);
        }
        cAll = o; cPerson = p;
      } catch { cAll = null; cPerson = null; }
      const pick = (s, c) => (s == null ? (c == null ? null : { used: c, exact: false }) : c == null ? { used: s, exact: false } : { used: Math.max(s, c), exact: s >= c - 0.005 });
      const all = pick(sAll, cAll);
      const per = isReg ? pick(sPerson, cPerson) : null;
      if (!all || (isReg && !per)) throw new Error("no totals");
      const overall = Math.max(0, all.used);
      const person = per ? Math.max(0, per.used) : null;
      const exact = all.exact && (!per || per.exact);
      const roomAll = Math.max(0, DAILY_CAP - overall);
      const room = person === null ? roomAll : Math.max(0, Math.min(WALLET_DAILY_CAP - person, roomAll));
      const fmt = (n) => { const v = Math.floor(n * 100) / 100; return Number.isInteger(v) ? `$${v}` : usd(v); };
      const about = exact ? "" : "about ";
      const line = person === null
        ? `The agent can pay out ${about}${fmt(room)} more today, across everyone.`
        : `${req.name} can receive ${about}${fmt(room)} more today.`;
      box.replaceChildren(el("p", { class: "hint" }, line, " Limits count the last 24 hours. ", sourceNote(exact)));
      setText($("#l-limits-sum"), limitsSummary({ capUsd: CAP, roomUsd: room, exact }));
      // over today's room: the agent would refuse it (one person) or hold it (everyone). Never folded away.
      if (payUsd != null && payUsd > room + 0.005) {
        const personOver = person !== null && payUsd > WALLET_DAILY_CAP - person + 0.005;
        $("#l-room-warn").replaceChildren(el("div", { class: "alert warn" }, icon("alert"), el("span", {}, el("b", {}, `This payment (about ${fmt(payUsd)}) would go over today's limit. `),
          personOver
            ? `The agent refuses a payment that takes one person over $${WALLET_DAILY_CAP} in 24 hours, so it wouldn't be paid out. Wait until ${req.name}'s earlier payouts are more than a day old, or ask for a smaller link.`
            : `The agent pays at most $${DAILY_CAP} in 24 hours across everyone, so this payout would wait until there's room. Consider paying later.`)));
      } else $("#l-room-warn").replaceChildren();
    } catch {
      box.replaceChildren(); // the limits line still applies; the agent checks them before paying
    }
  }

  // ---------- pay from a connected wallet ----------
  const eth = window.ethereum ?? null;
  const PENDING_KEY = `np-linkpay:${req.id}`;
  const W = { account: null, chainOk: null, bal: null, celo: null, busy: false, msg: null, sent: null };
  /** A payment from this tab that is pending or confirmed: the pay options stay away so it is never sent twice. */
  const sentActive = () => Boolean(W.sent) && W.sent.phase !== "failed";

  const plain = (message) => Object.assign(new Error(message), { plain: true }); // our own explanation, shown as is
  const setMsg = (kind, text) => { W.msg = text ? { kind, text } : null; renderWallet(); };
  async function refreshBalances() {
    const acct = W.account;
    if (!acct) return;
    try {
      const [[b], c] = await Promise.all([readContract(sell.address, "0x70a08231", ["address"], [acct], ["uint256"]), rpc("eth_getBalance", [acct, "latest"])]);
      if (acct !== W.account) return;
      W.bal = b; W.celo = BigInt(c);
    } catch { W.bal = null; W.celo = null; }
    renderWallet();
  }
  function walletProblem() {
    if (!W.account) return null;
    if (sameAddr(W.account, AGENT)) return { kind: "err", text: "This is the agent's own wallet. Connect your own wallet to pay." };
    if (isReg && sameAddr(W.account, req.recipient)) return { kind: "err", text: `This wallet created this link, so the agent won't pay it out. Pay from a different wallet.` };
    if (W.bal !== null && W.bal < units) return { kind: "err", text: `This wallet has ${num2.format(Number(W.bal) / 1e6)} ${sell.symbol}, less than the ${sendText} this link asks for.` };
    if (W.celo === 0n) return { kind: "warn", text: "This wallet has no CELO for the network fee. Add a few cents of CELO first, or your wallet may refuse to send." };
    return null;
  }
  const txLink = (hash, label = "View on Celoscan") => el("a", { class: "link", href: celoscanTx(hash) }, label, " ", icon("ext"));

  function renderWallet() {
    const box = $("#l-wallet");
    if (!box) return;
    if (W.sent) { const v = trackView(); if (box.firstChild !== v) box.replaceChildren(v); return; }
    if (!eth || !canPayNow()) return box.replaceChildren();
    const parts = [];
    if (W.account) {
      const balText = W.bal !== null ? `${num2.format(Number(W.bal) / 1e6)} ${sell.symbol}` : el("span", { class: "skel" });
      parts.push(el("p", { class: "small soft nt-from" }, "Paying from ", el("a", { class: "mono link", href: celoscanAddr(W.account), title: W.account }, short(W.account)),
        " · ", el("span", { class: "num" }, balText), W.chainOk === false ? badge("Not Celo: switches when you pay", "warn") : null));
    }
    const problem = walletProblem();
    if (problem) parts.push(el("div", { class: `alert ${problem.kind}` }, icon("alert"), el("span", {}, problem.text)));
    if (W.msg) parts.push(el("div", { class: `alert ${W.msg.kind}`, role: W.msg.kind === "err" ? "alert" : null }, icon(W.msg.kind === "err" || W.msg.kind === "warn" ? "alert" : "info"), el("span", {}, W.msg.text)));
    let btn;
    if (!W.account) {
      btn = el("button", { class: "btn btn-primary btn-lg", type: "button", disabled: W.busy }, icon("wallet"), W.busy ? "Check your wallet…" : "Connect wallet");
      btn.addEventListener("click", connect);
    } else {
      btn = el("button", { class: "btn btn-primary btn-lg", type: "button", disabled: W.busy || problem?.kind === "err" }, W.busy ? "Check your wallet…" : `Pay ${sendText}`);
      btn.addEventListener("click", submit);
    }
    parts.push(el("div", { class: "row" }, btn));
    box.replaceChildren(...parts);
  }

  async function setAccount(acct) {
    W.account = acct ?? null;
    W.bal = null; W.celo = null;
    if (W.account) {
      try { W.chainOk = String(await eth.request({ method: "eth_chainId" })).toLowerCase() === "0xa4ec"; } catch { W.chainOk = null; }
    }
    renderWallet();
    refreshBalances();
  }
  async function connect() {
    if (W.busy) return;
    W.busy = true; W.msg = null;
    renderWallet();
    markWalletConnected();
    try {
      const accs = await eth.request({ method: "eth_requestAccounts" });
      if (!accs?.length) throw new Error("The wallet returned no account.");
      try { await ensureCelo(eth); W.chainOk = true; } catch (e) { W.msg = { kind: "warn", text: `Connected, but the wallet isn't on Celo. ${explainWalletError(e)}` }; }
      W.busy = false;
      await setAccount(accs[0]);
    } catch (e) {
      W.busy = false;
      setMsg("err", explainWalletError(e));
    }
  }
  async function submit() {
    if (W.busy || !W.account || W.sent) return;
    if (!canPayNow()) return renderWallet();
    const from = W.account;
    W.busy = true; W.msg = null;
    renderWallet();
    try {
      if (isReg && sameAddr(from, req.recipient)) throw plain("This wallet created this link, so nothing was sent. Pay from a different wallet.");
      if (sameAddr(from, AGENT)) throw plain("This is the agent's own wallet, so nothing was sent.");
      await ensureCelo(eth);
      W.chainOk = true;
      const [[bal], celo] = await Promise.all([readContract(sell.address, "0x70a08231", ["address"], [from], ["uint256"]), rpc("eth_getBalance", [from, "latest"])]);
      W.bal = bal; W.celo = BigInt(celo);
      if (bal < units) throw plain(`This wallet has ${num2.format(Number(bal) / 1e6)} ${sell.symbol}, less than ${sendText}. Nothing was sent.`);
      if (!canPayNow()) throw plain("This link can't be paid any more (it expired or was just paid). Nothing was sent.");
      // transfer(agent, exact units) + this app's attribution suffix. No memo: a link payment is matched by its exact amount.
      const data = encodeCall(SEL.transfer, ["address", "uint256"], [AGENT, units]) + tagSuffix();
      const hash = await eth.request({ method: "eth_sendTransaction", params: [{ from, to: sell.address, value: "0x0", data }] });
      if (!/^0x[0-9a-fA-F]{64}$/.test(String(hash))) throw plain("The wallet didn't return a transaction id. Check your wallet's activity before trying again.");
      W.sent = { hash: String(hash).toLowerCase(), from, at: Date.now(), phase: "pending" };
      try { sessionStorage.setItem(PENDING_KEY, JSON.stringify(W.sent)); } catch { /* storage blocked: tracking lasts while the page is open */ }
      W.busy = false;
      renderWallet();
      track();
    } catch (e) {
      W.busy = false;
      setMsg("err", e?.plain ? e.message : isNetworkError(e) ? "Couldn't reach Celo to check this wallet. Nothing was sent. Try again in a moment." : explainWalletError(e));
    }
  }

  /**
   * The calm confirmation for a payment sent from this tab: one big mark, one sentence, Done and the status. The steps
   * and the transaction sit in Details; a refusal is shown in full. Built once per payment and updated in place.
   */
  let okView = null;
  const recvWord = inNaira ? cur.plural : "dollars";
  function trackView() {
    const p = W.sent;
    if (!okView || okView.sent !== p) {
      const ui = successPanel();
      const done = el("button", { class: "btn btn-primary", type: "button" }, "Done");
      done.addEventListener("click", () => { okView.dismissed = true; renderWallet(); $("#status-h").scrollIntoView?.({ block: "nearest" }); });
      const again = el("button", { class: "btn btn-primary", type: "button" }, icon("refresh"), "Try again");
      again.addEventListener("click", () => { W.sent = null; okView = null; try { sessionStorage.removeItem(PENDING_KEY); } catch { /* ignore */ } render(); });
      const status = el("a", { class: "btn btn-secondary", href: `verify.html?tx=${p.hash}` }, "Check status", icon("right"));
      okView = { sent: p, ui, done, again, status, dismissed: false, steps: el("ol", { class: "pay-track" }), small: null };
      ui.details.append(okView.steps);
      requestAnimationFrame(() => ui.heading.focus({ preventScroll: true }));
    }
    const { ui, done, again, status, steps } = okView;
    if (okView.dismissed && p.phase !== "failed") {
      // after Done: one quiet line, never the pay button again for this payment
      okView.small ??= el("p", { class: "small soft" });
      okView.small.replaceChildren(icon("check"), ` You sent ${sendText}. `, txLink(p.hash));
      return okView.small;
    }
    const row = (state, title, sub) => el("li", { class: state }, el("span", { "aria-hidden": "true" }, state === "done" ? icon("check") : state === "err" ? icon("x") : ""), el("div", {}, el("b", {}, title), sub ? el("span", { class: "small" }, sub) : null));
    const chain = p.phase === "confirmed" ? row("done", "Confirmed on Celo", ["The agent pays ", req.name, " when autopilot next runs."])
      : p.phase === "failed" ? row("err", "The payment failed on Celo", ["Nothing was sent to the agent; only the network fee was spent. ", txLink(p.hash)])
      : p.phase === "slow" ? row("", "Not confirmed yet", ["It can still go through. ", txLink(p.hash, "Check it on Celoscan")])
      : row("active", "Waiting for Celo to confirm…", ["Usually a few seconds. ", txLink(p.hash)]);
    steps.replaceChildren(row("done", `Sent ${sendText} from your wallet`, [el("span", { class: "mono" }, short(p.from)), " · ", txLink(p.hash)]), chain);
    const to = req.name;
    if (p.phase === "failed") {
      ui.set({ state: "failed", title: successHeadline({ state: "failed" }), text: "Nothing was sent to the agent; only the network fee was spent.", actions: [again] });
    } else if (p.phase === "pending" || p.phase === "slow") {
      ui.set({ state: "pending", title: p.phase === "slow" ? "Still waiting for Celo" : successHeadline({ state: "pending", amount: sendText, to }),
        text: p.phase === "slow" ? ["It can still go through. ", txLink(p.hash, "Check it on Celoscan")] : "Waiting for Celo to confirm. Usually a few seconds; don't send it again.", actions: [] });
    } else if (state.payout) {
      const href = isReg ? `receipt.html#p=${state.payout.hash}` : `receipt.html#p=${state.payout.hash}&r=${req.id}`;
      ui.set({ state: "paid", title: successHeadline({ state: "paid", to }), text: `The agent paid ${to} in ${recvWord}.`, alert: null,
        actions: [done, el("a", { class: "btn btn-secondary", href }, "Open receipt", icon("right"))] });
    } else if (refused() || selfPaid()) {
      ui.set({ state: "failed", title: `${to} wasn't paid`, text: "", actions: [done],
        alert: el("div", { class: "alert err" }, icon("alert"), el("span", {}, refunded() ? refundedText(state.agent) : selfPaid() ? "This payment came from the wallet the link pays, so the agent won't pay it out." : refusedNote(state.agent.reason))) });
    } else {
      ui.set({ state: "done", title: successHeadline({ state: "done", amount: sendText, to }), alert: null,
        text: `Celo confirmed it. The agent pays ${to} in ${recvWord} when autopilot next runs; this page updates by itself.`, actions: [done, status] });
    }
    return ui.el;
  }
  async function track() {
    const p = W.sent;
    for (let i = 0; i < 72 && W.sent === p; i++) { // about 3 minutes
      let rc = null;
      try { rc = await loadReceipt(p.hash); } catch { /* RPC hiccup: try again */ }
      if (rc) {
        p.phase = rc.status === "0x1" ? "confirmed" : "failed";
        try { if (p.phase === "failed") sessionStorage.removeItem(PENDING_KEY); else sessionStorage.setItem(PENDING_KEY, JSON.stringify(p)); } catch { /* ignore */ }
        render();
        if (p.phase === "confirmed") { clearTimeout(timer); check(); }
        return;
      }
      await new Promise((res) => setTimeout(res, 2500));
    }
    if (W.sent === p) { p.phase = "slow"; render(); }
  }

  if (eth) {
    // a payment sent from this tab earlier (the page was reloaded): keep tracking it for an hour
    try {
      const saved = JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? "null");
      if (saved && /^0x[0-9a-f]{64}$/.test(saved.hash) && Date.now() - saved.at < 3600_000) {
        W.sent = { ...saved, phase: saved.phase === "confirmed" ? "confirmed" : "pending" };
        if (W.sent.phase === "pending") track();
      }
    } catch { /* storage blocked */ }
    eth.on?.("accountsChanged", (accs) => { if (W.account || accs?.length) setAccount(walletDisconnected() ? null : accs?.[0]); });
    // already connected to this site (and not disconnected in this tab): show the wallet without a prompt
    if (!walletDisconnected()) eth.request({ method: "eth_accounts" }).then((accs) => { if (accs?.[0]) setAccount(accs[0]); }).catch(() => { /* stays "Connect wallet" */ });
  }

  render();
  tickCountdown();
  setInterval(tickCountdown, 1000);
  check();
}

/** One address's ERC-20 transfers (newest first) in one direction since a time. */
async function* addressTransfers(address, filter, sinceMs) {
  let next = null;
  for (let page = 0; page < 5; page++) {
    const qs = new URLSearchParams({ type: "ERC-20", filter, ...(next ?? {}) });
    const d = await getJson(`${EXPLORER_API}/addresses/${address}/token-transfers?${qs}`);
    if (!Array.isArray(d.items)) throw new Error("unexpected explorer response");
    for (const it of d.items) {
      const ts = Date.parse(it.timestamp);
      if (ts < sinceMs) return;
      yield { ...it, ts };
    }
    next = d.next_page_params;
    if (!next) return;
  }
}

/** Walk the agent's ERC-20 transfers (newest first) in one direction since a time, for one token or (null) all. */
async function* transfers(filter, tokenAddr, sinceMs) {
  let next = null;
  for (let page = 0; page < 10; page++) {
    const qs = new URLSearchParams({ type: "ERC-20", filter, ...(tokenAddr ? { token: tokenAddr } : {}), ...(next ?? {}) });
    const d = await getJson(`${EXPLORER_API}/addresses/${AGENT}/token-transfers?${qs}`);
    if (!Array.isArray(d.items)) throw new Error("unexpected explorer response");
    for (const it of d.items) {
      const ts = Date.parse(it.timestamp);
      if (ts < sinceMs) return;
      yield { ...it, ts };
    }
    next = d.next_page_params;
    if (!next) return;
  }
}
/** The earliest transfer to the agent of exactly `units` of the sell token between created and exp that `accept` allows. */
async function findDeposit(tokenAddr, units, created, exp, accept = () => true) {
  const since = Math.floor(created / 1000) * 1000; // block times are whole seconds
  let found = null;
  for await (const t of transfers("to", tokenAddr, since)) {
    // a deposit exactly at expiry is unmatched, as in the CLI
    if (t.ts >= exp || !sameAddr(t.to?.hash, AGENT) || sameAddr(t.from?.hash, AGENT)) continue;
    if (!sameAddr(t.token?.address_hash ?? t.token?.address, tokenAddr)) continue;
    if (String(t.total?.value) !== units.toString()) continue;
    if (!accept(t)) continue;
    found = t; // newest first, so the last match is the earliest
  }
  return found && { hash: found.transaction_hash, from: found.from?.hash, ts: found.ts, block: found.block_number, logIndex: found.log_index ?? null };
}

/**
 * The agent's first plain outgoing transfer of the buy token in a block after the deposit.
 * Transactions that also move tokens INTO the agent are swap legs, not payouts, so they are skipped.
 * With `recipient` (#tx= links) only a transfer TO that wallet counts.
 */
async function findPayout(tokenAddr, deposit, recipient = null) {
  const incoming = new Set();
  for await (const t of transfers("to", null, deposit.ts)) {
    if (sameAddr(t.to?.hash, AGENT) && t.transaction_hash) incoming.add(String(t.transaction_hash).toLowerCase());
  }
  let found = null;
  for await (const t of transfers("from", tokenAddr, deposit.ts)) {
    if (!sameAddr(t.from?.hash, AGENT) || sameAddr(t.to?.hash, AGENT)) continue;
    if (t.method !== "transfer") continue;
    if (!(Number(t.block_number) > Number(deposit.block))) continue;
    if (incoming.has(String(t.transaction_hash ?? "").toLowerCase())) continue;
    if (!sameAddr(t.token?.address_hash ?? t.token?.address, tokenAddr)) continue;
    if (recipient && !sameAddr(t.to?.hash, recipient)) continue;
    found = t; // newest first, so the last match is the earliest
  }
  return found && { hash: found.transaction_hash, to: found.to?.hash, ts: found.ts };
}

// =====================================================================
// Explainer: open a link someone sent you (paste the URL, or just a registration tx hash)
// =====================================================================
function initOpenLink() {
  const form = $("#open-form"), input = $("#open-link"), hint = $("#open-hint");
  if (!form || !input) return;
  const fail = (msg) => {
    hint.classList.add("err");
    setText(hint, msg);
    input.setAttribute("aria-invalid", "true");
    input.focus();
  };
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const v = input.value.trim();
    if (!v) return fail("Paste the payment link you were sent.");
    let hash = "";
    if (/^0x[0-9a-fA-F]{64}$/.test(v)) hash = "#tx=" + v;
    else {
      try { hash = new URL(v, location.href).hash; } catch { hash = v.startsWith("#") ? v : ""; }
    }
    if (!/^#(tx|r)=/.test(hash)) return fail("That doesn't look like a payment link. It should contain #tx= or #r=. Ask the sender to share it again.");
    location.href = new URL("pay.html" + hash, location.href).href;
  });
  input.addEventListener("input", () => {
    hint.classList.remove("err");
    input.removeAttribute("aria-invalid");
    setText(hint, "It starts with this site's address and contains #tx= or #r=.");
  });
}

// =====================================================================
// Explainer: command builder
// =====================================================================
function initBuilder() {
  const nameIn = $("#b-name"), amountIn = $("#b-amount"), noteIn = $("#b-note"), hoursIn = $("#b-hours");
  const reqPre = $("#req-cmd"), reqCopy = $("#req-copy");
  let corridor = "usdt-cngn";
  const picker = currencyPicker({
    label: "What the contact receives", describedBy: "corridor-label",
    extra: [{ code: "usd", label: "Dollars", flag: "usd", title: "Dollars (USD₮): the payer sends cNGN" }],
    onChange: (c) => {
      const next = c === "usd" ? "cngn-usdt" : `usdt-${c}`;
      if ((next === "cngn-usdt") !== (corridor === "cngn-usdt")) amountIn.value = next === "cngn-usdt" ? "7200" : "5";
      corridor = next;
      render();
    },
  });
  $("#corridor-slot").replaceChildren(picker.el);
  corridor = picker.value === "usd" ? "cngn-usdt" : `usdt-${picker.value}`;
  let rate = null;

  const hint = (id, text, isErr) => { const h = $(id); h.classList.toggle("err", !!isErr); setText(h, text); };

  function readName() {
    const name = nameIn.value.trim();
    const ok = NAME_RE.test(name);
    nameIn.setAttribute("aria-invalid", String(!ok));
    hint("#b-name-hint", ok ? "The name as it appears in your contacts.json."
      : name ? "Leave out quotes, backticks, $ and backslashes. Up to 40 characters." : "Enter the recipient's contact name.", !ok);
    return ok ? name : null;
  }

  function readAmount() {
    // core.js parseMoneyInput: "1,5" is 1.50 and "1,250" is 1250, never a guess
    const p = parseMoneyInput(amountIn.value);
    const inNgn = corridor === "cngn-usdt";
    let n = null, msg, err = true;
    if (!amountIn.value.trim()) msg = inNgn ? "Enter an amount in naira." : "Enter an amount in dollars.";
    else if (p.error && !p.error.startsWith("Enter a number")) msg = p.error;
    else if (p.error || !(p.cents > 0)) msg = inNgn ? "Enter an amount in naira, like 7200." : "Enter an amount in dollars, like 5 or 12.50.";
    else {
      n = p.cents / 100;
      const usdValue = inNgn ? (rate?.reverseRate ? n * rate.reverseRate : null) : n;
      if (!inNgn && n > MAX_USDT_BASE) {
        msg = `Leave room for the cents the agent adds: at most $${MAX_USDT_BASE}.`;
        n = null;
      } else if (usdValue !== null && usdValue > CAP) {
        msg = inNgn ? `About ${usd(usdValue)}, over the $${CAP} per-payment limit. Autopilot would refuse it.` : `Over the $${CAP} per-payment limit. Autopilot would refuse it.`;
        n = null;
      } else {
        err = false;
        const approx = inNgn
          ? (usdValue !== null ? `Contact gets about ${num2.format(usdValue)} USD₮. ` : "")
          : (rate && rate.available[corridor.slice(5)] ? `Contact gets about ${formatCurrency(n * rate.rates[corridor.slice(5)], corridor.slice(5))}. ` : "");
        msg = `${approx}The agent adds 0.01 to 0.99 so the amount is unique.`;
      }
    }
    amountIn.setAttribute("aria-invalid", String(err));
    hint("#b-amount-hint", msg, err);
    return n === null ? null : String(Math.round(n * 100) / 100);
  }

  function readNote() {
    const note = noteIn.value.trim();
    const bad = /["`$\\]/.test(note);
    noteIn.setAttribute("aria-invalid", String(bad));
    hint("#b-note-hint", bad ? "Leave out quotes, backticks, $ and backslashes so the command runs as typed." : "Shown on the link. Up to 80 characters.", bad);
    return bad ? null : note;
  }

  function readHours() {
    const raw = hoursIn.value.trim();
    const h = /^\d{1,3}$/.test(raw) ? Number(raw) : NaN;
    const ok = h >= 1 && h <= MAX_HOURS;
    hoursIn.setAttribute("aria-invalid", String(!ok));
    hint("#b-hours-hint", ok ? `1 to ${MAX_HOURS} hours. The default is 48.` : `Enter whole hours from 1 to ${MAX_HOURS}.`, !ok);
    return ok ? h : null;
  }

  function render() {
    const c = CORRIDORS[corridor];
    const lc = currencyOfCorridor(corridor);
    setText($("#b-token"), tokenOf(c.sell).symbol);
    setText($("#corridor-hint"), lc
      ? `The payer sends USD₮. The contact receives ${lc.plural} (${lc.token}).`
      : "The payer sends cNGN. The contact receives USD₮ (dollars).");

    const name = readName(), amount = readAmount(), note = readNote(), hours = readHours();
    if (name === null || amount === null || note === null || hours === null) {
      setText(reqPre, "Fix the fields above to build the command.");
      reqCopy.disabled = true;
      reqCopy.removeAttribute("data-copy");
      return;
    }
    let cmd = `node src/agent.mjs request --to "${name}" --amount ${amount}`;
    if (corridor !== "usdt-cngn") cmd += lc ? ` --to-currency ${lc.aliases[0]}` : ` --corridor ${corridor}`;
    if (note) cmd += ` --note "${note}"`;
    if (hours !== 48) cmd += ` --hours ${hours}`;
    setText(reqPre, cmd);
    reqCopy.disabled = false;
    reqCopy.dataset.copy = cmd;
  }

  for (const i of [nameIn, amountIn, noteIn, hoursIn]) i.addEventListener("input", render);

  render();
  loadRate().then((r) => { rate = r; picker.setAvailability(r.available); render(); }).catch(() => { /* the estimate is optional; the command still builds */ });
}
