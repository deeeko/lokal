import {
  AGENT, CAP, CORRIDORS, TOKENS, $, $$, el, icon, badge, naira, num2, short, lagosTime, celoscanTx, celoscanAddr,
  rpc, loadRate, loadReceipt, loadRegistrations, registrationStatuses, encodeRegistration, initChrome, parseMoneyInput,
  disconnectWallet, walletDisconnected, markWalletConnected, DISCONNECT_NOTE_FULL, DISCONNECT_NOTE_PARTIAL, toast,
  currencyOf, formatCurrency,
} from "../assets/core.js";
import { currencyPicker } from "../assets/currency-ui.js";
import { ensureCelo as ensureCeloOn, explainWalletError, CELO_CHAIN } from "../assets/session.js";
import { isDesktop, noWalletHelp } from "../assets/ntag-ui.js";
import { bindDisclosures, currencyChoice, shareRow } from "../assets/disclose.js";

initChrome();

// A recipient registers their own payment request onchain: a zero-value tx from their wallet to the agent whose
// calldata is the request (see docs/spec/REGISTRATIONS.md). The page never moves money; the wallet asks before sending.

const explain = explainWalletError;
const ensureCelo = () => ensureCeloOn(eth);
const MIN_HOURS = 1, MAX_HOURS = 168, DEFAULT_HOURS = 48;
const USDT_MIN_CENTS = 100, USDT_MAX_CENTS = 2499; // $1 to $24.99: the agent's shared registration rule (registrationError)
const NAIRA_RANGE = "$1 up to $24.99, so the payout stays under the $25 limit";
const POLL_MS = 2500, POLL_TRIES = 72; // about 3 minutes

const eth = window.ethereum ?? null;
const state = {
  corridor: "usdt-cngn",
  account: null,
  chainOk: null,
  lowGas: false,
  rate: null, rateFailed: false,
  regs: null, regsState: "loading", // loading | ok | err
  busy: false,
  touched: new Set(),
};

const amountIn = $("#amount"), nameIn = $("#name"), noteIn = $("#note"), hoursIn = $("#hours"), agreeIn = $("#agree");
const actions = $("#actions"), sendMsg = $("#send-msg"), walletBox = $("#wallet-box");
const sameAddr = (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const setText = (node, text) => node.replaceChildren(text);
// isNaira: the payer sends USD₮ and the recipient gets local money (naira, rupiah or pesos); otherwise cNGN in, dollars out
const isNaira = () => state.corridor !== "cngn-usdt";
const code = () => (isNaira() ? state.corridor.slice(5) : null);
const cur = () => currencyOf(code());
const perUsd = () => (state.rate && code() && state.rate.available[code()] ? state.rate.rates[code()] : null);
const sellSym = () => TOKENS[CORRIDORS[state.corridor].sell].symbol;
const centsStr = (c) => (c / 100).toFixed(2);
const fmtAmount = (c) => num2.format(c / 100);

function alertBox(kind, iconName, ...children) {
  return el("div", { class: `alert${kind ? " " + kind : ""}`, role: kind === "err" ? "alert" : null }, icon(iconName), el("div", {}, ...children));
}
const txLink = (hash) => el("a", { class: "link", href: celoscanTx(hash) }, "View on Celoscan ", icon("ext"));

// ---------- form values ----------
/** Amount in cents, or { error }. core.js parseMoneyInput reads "1,250.5" as 1250.50 and "1,5" as 1.50; at most 2 decimals. */
function readAmount() {
  const p = parseMoneyInput(amountIn.value);
  if (p.error) return { error: p.error };
  const cents = p.cents;
  const err = amountRuleError(cents);
  return err ? { cents, error: err } : { cents };
}
/** The agent's rules for an amount (registrationError + the $25 cap for dollars), or null. */
function amountRuleError(cents) {
  if (!(cents > 0)) return "Enter an amount above zero.";
  if (isNaira()) {
    if (cents < USDT_MIN_CENTS || cents > USDT_MAX_CENTS) return `Enter ${NAIRA_RANGE}.`;
    const max = state.rate?.maxUsd?.[code()];
    if (max && cents / 100 > max) return `Textile can convert up to about $${max.toFixed(2)} into ${cur().plural} right now. Enter less, or choose another currency.`;
    return null;
  }
  const rr = state.rate?.reverseRate;
  if (rr && (cents / 100) * rr > CAP) return `That's more than $${CAP}. Enter up to about ₦${num2.format(Math.floor(CAP / rr))}.`;
  return null;
}
function readName() {
  const v = nameIn.value.trim();
  if (!v) return { error: "Enter the name the payer knows you by." };
  if (v.length > 40) return { error: "Use 40 characters or fewer." };
  return { value: v };
}
function readNote() {
  const v = noteIn.value.trim();
  return v.length > 80 ? { error: "Use 80 characters or fewer." } : { value: v };
}
function readHours() {
  const v = hoursIn.value.trim();
  if (!/^\d{1,3}$/.test(v)) return { error: "Enter whole hours, 1 to 168." };
  const h = Number(v);
  return h < MIN_HOURS || h > MAX_HOURS ? { error: "Enter 1 to 168 hours." } : { value: h };
}

// ---------- the same-amount rule ----------
/** "<sell token>:amount" keys held by an active registration right now (every usdt-* link is paid in USD₮). */
function takenKeys() {
  if (!state.regs) return new Set();
  const now = Math.floor(Date.now() / 1000);
  const st = registrationStatuses(state.regs, now);
  const keys = new Set();
  for (const r of state.regs) if (st.get(r.hash) === "active" && CORRIDORS[r.req.d]) keys.add(CORRIDORS[r.req.d].sell + ":" + Number(r.req.a).toFixed(2));
  return keys;
}
const isTaken = (cents, taken = takenKeys()) => taken.has(CORRIDORS[state.corridor].sell + ":" + centsStr(cents));
/** Nearest amount (± cents) that is free and within the limits, or null. */
function nearestFree(cents) {
  const taken = takenKeys();
  for (let k = 1; k <= 500; k++) {
    for (const c of [cents + k, cents - k]) {
      if (c > 0 && !amountRuleError(c) && !isTaken(c, taken)) return c;
    }
  }
  return null;
}
async function refreshRegs() {
  state.regsState = "loading";
  renderFree();
  try {
    state.regs = await loadRegistrations();
    state.regsState = "ok";
    // A newcomer shouldn't open the page on a warning: if the pre-filled amount is already taken and they haven't
    // typed anything yet, start them on the nearest free amount instead.
    if (!state.userTyped) {
      const a = readAmount();
      if (!a.error && isTaken(a.cents)) {
        const alt = nearestFree(a.cents);
        if (alt != null) { amountIn.value = centsStr(alt); renderAmountHint(); renderEstimate(); }
      }
    }
  } catch {
    state.regsState = "err";
  }
  renderFree();
  renderActions();
  return state.regsState === "ok";
}

// ---------- rendering ----------
function renderCorridor() {
  const off = isNaira() && state.rate && !perUsd();
  // a currency that would be refused, or one MiniPay can't show, is said in full under the line; the rest waits behind "Change"
  $("#corridor-hint").classList.toggle("err", Boolean(off));
  setText($("#corridor-hint"), off ? `${cur().label} isn't available on Textile FX right now. A payment would be refused until it is, so choose another currency or try later.`
    : isNaira() ? "Using MiniPay? Choose dollars (USD₮); MiniPay doesn't show local tokens yet." : "");
  $("#corridor-hint").hidden = !off && !isNaira();
  setText(choiceHint, isNaira() ? `The payer sends USD₮. You get ${cur().plural} (${cur().token}).` : "The payer sends cNGN. You get USD₮ (dollars), which MiniPay shows.");
  choice.refresh();
  setText($("#amount-token"), sellSym());
}

function renderAmountHint() {
  const a = readAmount();
  const hint = $("#amount-hint");
  const show = a.error && (state.touched.has("amount") || amountIn.value.trim());
  hint.classList.toggle("err", !!show);
  if (show) setText(hint, a.error);
  else setText(hint, isNaira() ? `${NAIRA_RANGE[0].toUpperCase()}${NAIRA_RANGE.slice(1)}${perUsd() ? ` (≈ ${formatCurrency(24.99 * perUsd(), code())})` : ""}.` : `Up to $${CAP} in value, up to 2 decimals.`);
  amountIn.setAttribute("aria-invalid", String(!!show));
}

function renderFree() {
  const box = $("#amount-free");
  const a = readAmount();
  if (a.error) { box.replaceChildren(); return; }
  if (state.regsState === "loading") {
    box.replaceChildren(el("p", { class: "small muted", role: "status" }, el("span", { class: "skel", style: "width:14px;height:14px;border-radius:50%;margin-right:8px" }), "Checking that no other active link uses this amount…"));
    return;
  }
  if (state.regsState === "err") {
    const retry = el("button", { class: "btn btn-ghost btn-sm", type: "button" }, icon("refresh"), "Check again");
    retry.addEventListener("click", refreshRegs);
    box.replaceChildren(el("div", { class: "row between" },
      el("p", { class: "small muted" }, "Couldn't check whether this amount is free. It is checked again when you create the link."), retry));
    return;
  }
  if (!isTaken(a.cents)) {
    box.replaceChildren(el("p", { class: "small soft row", style: "gap:8px" }, el("span", { class: "mint" }, icon("check")), "This amount is free to use."));
    return;
  }
  const alt = nearestFree(a.cents);
  const parts = [el("p", {}, el("b", {}, `Another active link already uses ${fmtAmount(a.cents)} ${sellSym()}.`),
    " The agent pays only the first link with an amount, so pick a slightly different one.")];
  if (alt != null) {
    const use = el("button", { class: "btn btn-secondary btn-sm mt-8", type: "button" }, `Use ${fmtAmount(alt)} ${sellSym()} instead`);
    use.addEventListener("click", () => {
      amountIn.value = centsStr(alt);
      update();
      amountIn.focus();
    });
    parts.push(use);
  } else {
    parts.push(el("p", { class: "mt-8" }, "Try another amount."));
  }
  box.replaceChildren(alertBox("warn", "alert", ...parts));
}

function renderEstimate() {
  const a = readAmount();
  const out = $("#receive"), sGet = $("#s-get"), sRate = $("#s-rate"), sSend = $("#s-send");
  setText(sSend, a.cents > 0 && !a.error ? `${fmtAmount(a.cents)} ${sellSym()}` : "—");
  if (!state.rate) {
    if (state.rateFailed) {
      setText(out, "—"); setText(sGet, "—"); setText(sRate, "Rate unavailable");
    }
    return;
  }
  const r = state.rate;
  let get = null, rateText = "—";
  if (isNaira()) {
    const pu = perUsd();
    rateText = pu ? `1 USD₮ = ${formatCurrency(pu, code(), code() === "cngn" ? 2 : cur().places)}` : `${cur().label}: not available right now`;
    if (a.cents > 0 && pu) get = formatCurrency((a.cents / 100) * pu, code());
  } else if (r.reverseRate) {
    rateText = `1 USD₮ = ${naira(1 / r.reverseRate)}`;
    if (a.cents > 0) get = `${num2.format((a.cents / 100) * r.reverseRate)} USD₮`;
  } else {
    rateText = "Not published yet";
  }
  setText(out, get ?? "—");
  out.classList.toggle("over", !!a.error && a.cents > 0);
  setText(sGet, get ?? "—");
  setText(sRate, rateText);
}

function renderExpiry() {
  const h = readHours();
  const hint = $("#hours-hint");
  const show = h.error && state.touched.has("hours");
  hint.classList.toggle("err", !!show);
  setText(hint, show ? h.error : "1 to 168 hours. The default is 48.");
  hoursIn.setAttribute("aria-invalid", String(!!show));
  setText($("#s-exp"), h.error ? "—" : `${lagosTime(Date.now() + h.value * 3600_000)} WAT`);
}

function renderTextHints() {
  const n = readName(), nh = $("#name-hint");
  const showN = n.error && state.touched.has("name");
  nh.classList.toggle("err", !!showN);
  setText(nh, showN ? n.error : "Shown to the payer. Up to 40 characters.");
  nameIn.setAttribute("aria-invalid", String(!!showN));
  const m = readNote(), mh = $("#note-hint");
  mh.classList.toggle("err", !!m.error);
  setText(mh, m.error ?? `Up to 80 characters.${noteIn.value.length > 60 ? ` ${80 - noteIn.value.length} left.` : ""}`);
}

function renderWallet() {
  const b = $("#wallet-badge");
  if (!eth) {
    b.replaceChildren(badge("No wallet", "neutral"));
    if (isDesktop()) { walletBox.replaceChildren(noWalletHelp({ action: "create a link" })); return; }
    const page = location.href.split("#")[0];
    const mm = "https://metamask.app.link/dapp/" + page.replace(/^https?:\/\//, "");
    walletBox.replaceChildren(alertBox("", "info",
      el("p", {}, el("b", {}, "No wallet found in this browser."), " To create a link, open this page inside a wallet app:"),
      el("ol", { class: "small soft mt-8", style: "margin:8px 0 0;padding-left:18px;display:grid;gap:4px" },
        el("li", {}, "Copy this page's link."),
        el("li", {}, "Open MiniPay or MetaMask on your phone."),
        el("li", {}, "Go to the wallet's built-in browser and paste the link."),
        el("li", {}, "Tap \"Connect wallet\" there.")),
      el("div", { class: "row mt-16" },
        el("button", { class: "btn btn-secondary btn-sm", type: "button", dataset: { copy: page, copyLabel: "Page link copied" } }, icon("copy"), "Copy page link"),
        el("a", { class: "btn btn-secondary btn-sm", href: mm }, icon("ext"), "Open in MetaMask"))));
    return;
  }
  if (!state.account) {
    b.replaceChildren(badge("Not connected", "neutral"));
    walletBox.replaceChildren(el("p", { class: "small soft" }, "Connect the wallet you want to be paid in. You can fill in the form first."));
    return;
  }
  b.replaceChildren(el("span", { class: "badge ok" }, el("span", { class: "dot" }), "Connected"));
  const walletLink = el("a", { class: "mono link", href: celoscanAddr(state.account), title: state.account }, short(state.account));
  const net = state.chainOk === false
    ? el("span", { class: "row", style: "justify-content:flex-end;gap:8px" }, badge("Not Celo", "warn"), switchBtn())
    : el("span", {}, "Celo mainnet");
  const parts = [el("ul", { class: "kv-list" },
    el("li", {}, el("span", {}, "Paid to"), el("span", { class: "row", style: "justify-content:flex-end;gap:8px" }, walletLink,
      el("button", { class: "icon-btn sm", type: "button", "aria-label": "Copy wallet address", dataset: { copy: state.account, copyLabel: "Address copied" } }, icon("copy")))),
    el("li", {}, el("span", {}, "Network"), net)),
    el("div", { class: "row mt-8" }, disconnectBtn())];
  if (sameAddr(state.account, AGENT)) {
    parts.push(alertBox("err", "alert", el("p", {}, "This is the agent's own wallet. It can't create a link to pay itself. Connect your own wallet.")));
  } else if (state.lowGas) {
    parts.push(alertBox("warn", "alert", el("p", {}, "This wallet has no CELO for the network fee. Add a few cents of CELO first, or your wallet may refuse to send. ",
      el("a", { class: "link", href: "https://celo.org" }, "Where to get CELO"))));
  }
  walletBox.replaceChildren(...parts);
  setText($("#s-wallet"), short(state.account));
  $("#s-wallet").title = state.account;
}
function disconnectBtn() {
  const d = el("button", { class: "btn btn-ghost btn-sm", type: "button", "aria-label": "Disconnect wallet" }, icon("x"), "Disconnect");
  d.addEventListener("click", async () => {
    if (state.busy) return; // never mid-send
    d.disabled = true;
    const revoked = await disconnectWallet(eth);
    await setAccount(null);
    toast("Wallet disconnected");
    showMsg(alertBox("", "info", el("p", {}, revoked ? DISCONNECT_NOTE_FULL : DISCONNECT_NOTE_PARTIAL)));
  });
  return d;
}
function switchBtn() {
  const s = el("button", { class: "btn btn-ghost btn-sm", type: "button" }, "Switch to Celo");
  s.addEventListener("click", async () => {
    try { await ensureCelo(); state.chainOk = true; } catch (e) { showMsg(alertBox("err", "alert", el("p", {}, explain(e)))); }
    renderWallet();
  });
  return s;
}

/** The one primary action: Connect wallet, then Create my link. */
function renderActions() {
  if (state.busy) return;
  if (!eth) { actions.replaceChildren(); return; }
  if (!state.account) {
    const c = el("button", { class: "btn btn-primary btn-lg", type: "button", id: "connect" }, "Connect wallet");
    c.addEventListener("click", connect);
    actions.replaceChildren(c);
    return;
  }
  const create = el("button", { class: "btn btn-primary btn-lg", type: "button", id: "create" }, "Create my link");
  create.addEventListener("click", submit);
  if (sameAddr(state.account, AGENT)) create.disabled = true;
  actions.replaceChildren(create);
}

function showMsg(...nodes) { sendMsg.replaceChildren(...nodes); }

function update() {
  renderAmountHint();
  renderFree();
  renderEstimate();
  renderExpiry();
  renderTextHints();
}

// ---------- wallet ----------
async function checkGas() {
  if (!state.account) return;
  const acct = state.account;
  try {
    const bal = await rpc("eth_getBalance", [acct, "latest"]);
    if (acct !== state.account) return;
    state.lowGas = BigInt(bal) === 0n;
  } catch { state.lowGas = false; } // unknown: don't warn
  renderWallet();
}

async function setAccount(acct) {
  state.account = acct ?? null;
  state.lowGas = false;
  if (state.account) {
    try { state.chainOk = String(await eth.request({ method: "eth_chainId" })).toLowerCase() === CELO_CHAIN; } catch { state.chainOk = null; }
  }
  renderWallet();
  renderActions();
  if (state.account) checkGas();
  else setText($("#s-wallet"), "The wallet you connect");
}

async function connect() {
  const btn = $("#connect");
  btn.disabled = true;
  btn.textContent = "Check your wallet…";
  showMsg();
  markWalletConnected(); // an explicit Connect click undoes an earlier Disconnect
  try {
    const accs = await eth.request({ method: "eth_requestAccounts" });
    if (!accs?.length) throw new Error("The wallet returned no account.");
    try { await ensureCelo(); } catch (e) {
      showMsg(alertBox("warn", "alert", el("p", {}, "Connected, but the wallet is not on Celo. ", explain(e))));
    }
    await setAccount(accs[0]);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = "Connect wallet";
    showMsg(alertBox("err", "alert", el("p", {}, explain(e))));
  }
}

/** Seconds "now" by the chain's clock (falls back to this device's clock). */
async function chainNow() {
  try {
    const b = await rpc("eth_getBlockByNumber", ["latest", false]);
    const t = Number(BigInt(b.timestamp));
    if (t > 0) return t;
  } catch { /* use the device clock */ }
  return Math.floor(Date.now() / 1000);
}

// ---------- create ----------
async function submit() {
  if (state.busy || !eth || !state.account) return;
  for (const k of ["amount", "name", "hours"]) state.touched.add(k);
  update();
  const a = readAmount(), n = readName(), m = readNote(), h = readHours();
  const firstBad = (a.error && amountIn) || (n.error && nameIn) || (m.error && noteIn) || (h.error && hoursIn);
  if (firstBad) { showMsg(alertBox("err", "alert", el("p", {}, "Check the highlighted field."))); firstBad.focus(); return; }
  if (!isNaira() && !state.rate?.reverseRate) {
    showMsg(alertBox("err", "alert", el("p", {}, "Couldn't load the dollar rate, so the $25 limit can't be checked. Reload the page in a minute, or choose Naira.")));
    return;
  }
  if (!agreeIn.checked) {
    showMsg(alertBox("warn", "alert", el("p", {}, "Tick the box to confirm you understand the link is public and permanent.")));
    agreeIn.focus();
    return;
  }

  const btn = $("#create");
  const from = state.account;
  state.busy = true;
  btn.disabled = true;
  btn.textContent = "Checking the amount…";
  showMsg();
  try {
    // fresh check right before sending, so a link made a minute ago is seen
    if (!(await refreshRegs())) {
      throw Object.assign(new Error("Couldn't check whether this amount is free, so nothing was sent. Try again in a moment."), { plain: true });
    }
    if (isTaken(a.cents)) {
      throw Object.assign(new Error("Another active link just took this amount, so nothing was sent. Use the suggested amount above."), { plain: true });
    }
    btn.textContent = "Check your wallet…";
    await ensureCelo();
    state.chainOk = true;
    const now = await chainNow();
    // the agent requires expiry <= block time + 168 h; keep a 2-minute margin at the maximum
    const e = now + h.value * 3600 - (h.value === MAX_HOURS ? 120 : 0);
    const reg = { a: centsStr(a.cents), d: state.corridor, e, n: n.value, ...(m.value ? { m: m.value } : {}) };
    const data = encodeRegistration(reg);
    const hash = await eth.request({ method: "eth_sendTransaction", params: [{ from, to: AGENT, value: "0x0", data }] });
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(hash))) throw new Error("The wallet didn't return a transaction id.");
    btn.textContent = "Waiting for Celo…";
    showMsg(alertBox("", "info", el("p", { role: "status" }, "Sent. Waiting for Celo to confirm it. This usually takes a few seconds. ", txLink(hash))));
    for (let i = 0; i < POLL_TRIES; i++) {
      await sleep(POLL_MS);
      let rc = null;
      try { rc = await loadReceipt(hash); } catch { continue; }
      if (!rc) continue;
      if (rc.status === "0x1") { state.busy = false; showDone(hash, reg, from); return; }
      throw Object.assign(new Error("The transaction failed on Celo, so no link was made. Only the network fee was spent."), { plain: true, hash });
    }
    state.busy = false;
    const url = linkUrl(hash);
    showMsg(alertBox("warn", "alert",
      el("p", {}, "Still not confirmed after three minutes. It may yet go through. ", txLink(hash)),
      el("p", { class: "mt-8" }, "Once it confirms, your link is: ", el("span", { class: "mono", style: "overflow-wrap:anywhere" }, url)),
      el("div", { class: "row mt-8" }, el("button", { class: "btn btn-secondary btn-sm", type: "button", dataset: { copy: url, copyLabel: "Link copied" } }, icon("copy"), "Copy link"))));
    renderActions();
  } catch (err) {
    state.busy = false;
    showMsg(alertBox("err", "alert", el("p", {}, err.plain ? err.message : explain(err), err.hash ? " " : "", err.hash ? txLink(err.hash) : "")));
    renderActions();
  }
}

const linkUrl = (hash) => new URL("pay.html#tx=" + hash, location.href).href;

function showDone(hash, reg, from) {
  const url = linkUrl(hash);
  const send = `${num2.format(Number(reg.a))} ${sellSym()}`;
  $("#form-card").hidden = true;
  $("#sum-card").hidden = true;
  $("#done-card").hidden = false;
  setText($("#done-lead"), `Share it with the person paying you. They send exactly ${send}; the agent pays your wallet in ${isNaira() ? cur().plural : "dollars"}.`);
  const text = `Hi, you can pay me ${send} on Celo with this link${reg.m ? ` (${reg.m})` : ""}.`;
  $("#done-share").replaceChildren(shareRow({ url, title: "Pay me with LokalPay", text, whatsappText: `${text} ${url}`,
    qrLabel: "QR code of your payment link", qrCaption: "The payer can scan this to open your link." }));
  setText($("#done-sum"), `${send} · expires ${lagosTime(reg.e * 1000)} WAT`);
  setText($("#d-send"), send);
  $("#d-wallet").replaceChildren(el("a", { class: "mono link", href: celoscanAddr(from), title: from }, short(from)));
  setText($("#d-exp"), `${lagosTime(reg.e * 1000)} WAT`);
  $("#d-tx").replaceChildren(el("a", { class: "link", href: celoscanTx(hash), title: hash }, short(hash), " ", icon("ext")));
  showMsg();
  $("#done-h").focus();
}

function resetForm() {
  $("#done-card").hidden = true;
  $("#form-card").hidden = false;
  $("#sum-card").hidden = false;
  agreeIn.checked = false;
  state.touched.clear();
  renderActions();
  update();
  refreshRegs();
  amountIn.focus();
}

// ---------- wire up ----------
const picker = currencyPicker({
  label: "What you receive", describedBy: "corridor-label",
  extra: [{ code: "usd", label: "Dollars", flag: "usd", title: "Dollars (USD₮): the payer sends cNGN" }],
  onChange: (c) => {
    const next = c === "usd" ? "cngn-usdt" : `usdt-${c}`;
    const unitChange = (next === "cngn-usdt") !== (state.corridor === "cngn-usdt");
    state.corridor = next;
    if (unitChange) amountIn.value = isNaira() ? "10" : "14400";
    renderCorridor();
    update();
  },
});
// "You receive: Naira · Change": the full picker opens inline on demand
const choice = currencyChoice({ picker, label: "You receive" });
const choiceHint = el("p", { class: "hint" });
choice.el.querySelector(".dc-inner").append(choiceHint);
$("#currency-slot").replaceChildren(choice.el);
bindDisclosures(document);
state.corridor = picker.value === "usd" ? "cngn-usdt" : `usdt-${picker.value}`;
amountIn.addEventListener("input", () => { state.userTyped = true; update(); });
amountIn.addEventListener("blur", () => { state.touched.add("amount"); update(); });
nameIn.addEventListener("input", renderTextHints);
nameIn.addEventListener("blur", () => { if (nameIn.value) state.touched.add("name"); renderTextHints(); });
noteIn.addEventListener("input", renderTextHints);
hoursIn.addEventListener("input", renderExpiry);
hoursIn.addEventListener("blur", () => { state.touched.add("hours"); renderExpiry(); });
$("#again").addEventListener("click", resetForm);

if (eth?.on) {
  eth.on("accountsChanged", (accs) => {
    if (state.busy) return;
    if (walletDisconnected() && !state.account) return; // the user disconnected: don't let wallet events reconnect
    setAccount(accs?.[0] ?? null);
  });
  eth.on("chainChanged", (id) => { state.chainOk = String(id).toLowerCase() === CELO_CHAIN; if (state.account) renderWallet(); });
}

hoursIn.value = String(DEFAULT_HOURS);
renderCorridor();
renderWallet();
renderActions();
update();

loadRate().then((r) => { state.rate = r; picker.setAvailability(r.available); renderCorridor(); update(); }).catch(() => {
  state.rateFailed = true;
  setText($("#s-rate-note"), "Couldn't load the live rate. Your link still works: the agent uses the live rate when it converts.");
  update();
});
refreshRegs();
// already connected (no prompt): eth_accounts only lists accounts the user approved before
if (eth && !walletDisconnected()) eth.request({ method: "eth_accounts" }).then((accs) => { if (accs?.[0] && !state.account) setAccount(accs[0]); }).catch(() => {});
