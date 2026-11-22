// A pot's public page: pot.html?id=12 (the link and QR code the host shares). No account needed: a guest connects a
// wallet, picks an amount within the per-guest cap and the room left, chooses what the host receives, and sprays.
//
// Read from LokalPots over RPC: the title, host, caps, total, guests and closing time (potInfo), the room left for
// this guest (remaining), the token's dollar rate (unitsPerUsd). The host's @tag and default currency come from
// LokalTags. The Spray Wall is the pot's PotPaid events (eth_getLogs), showing amounts and times, never who paid.
//
// Spraying: the contract's own dry run (validatePotPayment) explains any refusal before the wallet opens. LokalPots has
// no permit variant, so the guest approves LokalPots for exactly the amount, then payPot(potId, token, amount,
// "cur:<code>", payout wallet) is simulated from their wallet and sent, with the attribution suffix. The agent then
// pays the host in the chosen currency (src/contract-watch.mjs reads the ref).
import {
  $, el, icon, short, initChrome, loadRate, currencyOf, formatCurrency, celoscanTx, celoscanAddr, num2, parseMoneyInput,
  readContract, markWalletConnected, walletDisconnected,
} from "../assets/core.js";
import {
  LOKAL_POTS, approveData, payPotData, currencyRef, readPotInfo, readPotRemaining, readUnitsPerUsd, readTokenLimits, readAllowance,
  readTagOf, readTagInfo, checkPotPayment, simulate, potUsdValue, decodeRevert, tokenAmountText, payoutRoute, decodePotPaid,
} from "../assets/lokal-contracts.js";
import { currencyPicker } from "../assets/currency-ui.js";
import { currencyChoice, successPanel, successHeadline } from "../assets/disclose.js";
import { injectedWallet, ensureCelo, explainWalletError, CELO_CHAIN } from "../assets/session.js";
import { alertBox, plainError, sameAddr, waitForReceipt, noWalletHelp, noCeloAlert, celoBalance, slowNotice } from "../assets/ntag-ui.js";
import {
  potIdFrom, potState, timeLeftText, closeText, usd6Text, sprayRoom, sprayError, maxUnitsForUsd6, receiveChoices, QUICK_AMOUNTS,
  sprayToken, loadPotSprays, pollPotSprays, mergeSprays, sprayOf, agoText,
} from "../assets/pots.js";
import { potMeter, potBadge, potShare, sprayNote, flutter } from "../assets/pot-ui.js";

initChrome();
// A pot page is paying someone, so it sits under "Send" (it is opened from a shared link, not the sidebar).
for (const a of document.querySelectorAll(".sb-nav a, .nav-links a")) {
  if (a.getAttribute("href") === "quote.html") a.setAttribute("aria-current", "page");
  else if (a.getAttribute("aria-current") === "page") a.removeAttribute("aria-current");
}

const root = $("#pot-root");
const eth = injectedWallet();
const POLL_MS = 15_000;
const isHash = (h) => /^0x[0-9a-fA-F]{64}$/.test(String(h));
const errText = (e) => (e?.plain ? e.message : explainWalletError(e));
const nowSec = () => Math.floor(Date.now() / 1000);
const txLink = (hash, text = "View on Celoscan") => el("a", { class: "link", href: celoscanTx(hash), target: "_blank", rel: "noopener" }, text, " ", icon("ext"));
const PAY = { usdt: { label: "Dollars", token: "USD₮", flag: "usd" }, cngn: { label: "Naira", token: "cNGN", flag: "cngn" } };

const S = {
  id: null, info: null, host: null, hostTag: null, hostReceive: null, sprays: [], toBlock: 0, alive: true,
  payCode: "usdt", account: null, chainOk: null, bal: null, celo: null, celoAnyway: false, busy: false, touched: false,
  rpu: {}, limits: {}, remaining: null, rate: null,
};

function setHead(title, lead, eyebrow) {
  $("#pot-eyebrow").replaceChildren(...[].concat(eyebrow));
  $("#pot-title").replaceChildren(...[].concat(title));
  $("#pot-lead").replaceChildren(...[].concat(lead));
}
const hostName = () => (S.hostTag ? "@" + S.hostTag : "the host");
const hostEl = () => (S.hostTag ? el("span", { class: "np-tagname" }, "@" + S.hostTag) : el("a", { class: "mono link", href: celoscanAddr(S.host), title: S.host }, short(S.host)));

function notFound(message, detail) {
  setHead(["A ", el("em", {}, "pot"), " that isn't here"], detail, "Pot");
  root.replaceChildren(el("section", { class: "card gate-card" }, el("div", { class: "card-b gate-body" },
    el("span", { class: "gate-icon", "aria-hidden": "true" }, icon("info")),
    el("div", {}, el("h2", {}, message),
      el("p", { class: "soft mt-8" }, "Ask the host to send the link again, or open your own pot from the dashboard."),
      el("div", { class: "row mt-16" }, el("a", { class: "btn btn-secondary", href: "app.html#pots" }, "Open a pot"),
        el("a", { class: "text-link", href: "index.html?about" }, "About Lokal ", el("span", { class: "arrow", "aria-hidden": "true" }, "→")))))));
}

async function start() {
  S.id = potIdFrom(location);
  if (S.id == null) return notFound("That isn't a pot link", "A pot link looks like lokalpay.vercel.app/pot.html?id=12.");
  try {
    S.info = await readPotInfo(S.id);
  } catch (e) {
    if (decodeRevert(e?.revert)?.name === "PotNotFound") return notFound(`There's no pot #${S.id}`, "Nobody has opened a pot with that number on the LokalPots contract.");
    const retry = el("button", { class: "btn btn-secondary btn-sm", type: "button" }, icon("refresh"), "Try again");
    retry.addEventListener("click", () => { root.replaceChildren(el("p", { class: "small muted" }, "Reading the pot from Celo…")); start(); });
    root.replaceChildren(alertBox("err", "alert", el("p", {}, "Couldn't reach Celo to read this pot. The pot is safe onchain; this page just can't read it right now."), el("div", { class: "row mt-8" }, retry)));
    return;
  }
  S.host = S.info.host;
  try {
    S.hostTag = await readTagOf(S.host);
    if (S.hostTag) S.hostReceive = (await readTagInfo(S.hostTag)).receive;
  } catch { /* shown as a short address */ }
  document.title = `${S.info.title} · Lokal pot`;
  render();
}

// ---------- the page ----------
function render() {
  const info = S.info;
  setHead(el("bdi", {}, info.title),
    "Spray from any Celo wallet. No account needed.",
    [`Pot #${S.id} · hosted by `, hostEl()]);
  const summary = summaryCard();
  const wall = wallCard();
  const spray = sprayCard();
  root.replaceChildren(el("div", { class: "pot-layout" }, summary.el, spray, wall.el));
  S.summary = summary; S.wall = wall;
  loadWall();
  const tick = setInterval(() => { if (!S.alive) return clearInterval(tick); summary.paint(); wall.ages(); }, 30_000);
  // a pot that stopped taking sprays won't change: no need to keep asking Celo
  const poll = setInterval(() => {
    if (!S.alive || ["closed", "ended"].includes(potState(S.info, nowSec()))) return clearInterval(poll);
    if (!document.hidden) refresh();
  }, POLL_MS);
}

function summaryCard() {
  const meter = potMeter(S.info);
  const stateBadge = el("span", {});
  const guests = el("b", { class: "num" }), left = el("b", {}), each = el("b", { class: "num" });
  const leftLabel = el("span", { class: "micro muted" }), closes = el("p", { class: "micro muted" });
  const taking = (st) => st === "open" || st === "full";
  const share = el("div", { class: "card-f pot-share-f" }, el("span", { class: "label" }, "Share this pot"), potShare(S.id, S.info.title));
  const paint = () => {
    const st = potState(S.info, nowSec());
    meter.update(S.info);
    stateBadge.replaceChildren(potBadge(st));
    guests.textContent = String(S.info.payerCount);
    const t = timeLeftText(S.info.closesAt, nowSec());
    leftLabel.textContent = t && st !== "closed" ? "Time left" : "Status";
    left.textContent = t && st !== "closed" ? t.replace(/ left$/, "") : st === "closed" ? "Closed" : "Ended";
    each.textContent = usd6Text(S.info.perPayerCapUsd6);
    closes.textContent = `${taking(st) ? "Closes" : "Closed"} ${closeText(S.info.closesAt)}.`;
    closes.hidden = st === "closed";
    share.hidden = !taking(st); // an ended pot has nothing left to share
  };
  paint();
  const node = el("section", { class: "card pot-summary", "aria-labelledby": "pot-sum-h" },
    el("div", { class: "card-h" }, el("h2", { id: "pot-sum-h" }, "Sprayed so far"), stateBadge),
    el("div", { class: "card-b stack" },
      meter.el,
      el("ul", { class: "pot-stats" },
        el("li", {}, el("span", { class: "micro muted" }, "Guests"), guests),
        el("li", {}, leftLabel, left),
        el("li", {}, el("span", { class: "micro muted" }, "Per guest"), each)),
      closes),
    share);
  return { el: node, paint, meter };
}

// ---------- the Spray Wall ----------
function wallCard() {
  const list = el("ul", { class: "pot-notes", "aria-label": "Sprays, newest first" });
  const body = el("div", { class: "card-b pot-wall-b", "aria-busy": "true" }, el("p", { class: "small muted" }, el("span", { class: "skel" }), " Reading the sprays from Celo…"));
  const count = el("span", { class: "micro muted" });
  const node = el("section", { class: "card pot-wall", "aria-labelledby": "pot-wall-h" },
    el("div", { class: "card-h" }, el("h2", { id: "pot-wall-h" }, "The ", el("em", {}, "Spray"), " Wall"),
      potState(S.info, nowSec()) === "open" ? el("span", { class: "pot-live" }, el("span", { class: "live-dot", "aria-hidden": "true" }), "Live") : null),
    body,
    el("div", { class: "card-f" }, count, el("span", { class: "micro muted" }, "Never shows who sprayed.")));
  const empty = () => el("div", { class: "dash-empty pot-empty" }, el("p", { class: "dash-empty-title" }, "No sprays yet"),
    el("p", { class: "small soft" }, potState(S.info, nowSec()) === "open" ? "Be the first." : "Nobody sprayed into this pot."));
  const paintCount = () => { count.textContent = S.sprays.length ? `${S.sprays.length} spray${S.sprays.length === 1 ? "" : "s"} on the wall` : ""; };
  return {
    el: node,
    fill(sprays) {
      body.removeAttribute("aria-busy");
      list.replaceChildren(...sprays.map((s) => sprayNote(s, nowSec())));
      body.replaceChildren(sprays.length ? list : empty());
      paintCount();
    },
    failed(retry) {
      body.removeAttribute("aria-busy");
      const b = el("button", { class: "btn btn-ghost btn-sm", type: "button" }, icon("refresh"), "Try again");
      b.addEventListener("click", retry);
      body.replaceChildren(alertBox("err", "alert", el("p", {}, "Couldn't read the sprays from Celo right now."), el("div", { class: "row mt-8" }, b)));
    },
    /** New sprays land on top: each drops in and settles, and a few notes flutter over the wall. */
    land(fresh) {
      if (!fresh.length) return;
      if (!list.isConnected) body.replaceChildren(list);
      for (const s of [...fresh].reverse()) list.prepend(sprayNote(s, nowSec(), { fresh: true }));
      flutter(body);
      paintCount();
    },
    ages() { for (const t of list.querySelectorAll(".pot-note-time[data-time]")) if (t.dataset.time) t.textContent = agoText(Number(t.dataset.time), nowSec()); },
  };
}
async function loadWall() {
  try {
    const r = await loadPotSprays(S.id, { closesAt: S.info.closesAt });
    S.sprays = r.sprays; S.toBlock = r.toBlock;
    S.wall.fill(S.sprays);
  } catch { S.wall.failed(() => loadWall()); }
}
/** Every 15 s while the page is visible: new sprays since the last block read, and the pot's fresh totals. */
async function refresh() {
  try {
    if (S.toBlock) {
      const r = await pollPotSprays(S.id, S.toBlock);
      S.toBlock = r.toBlock;
      addSprays(r.sprays);
    }
    S.info = await readPotInfo(S.id);
    S.summary.paint();
    S.form?.repaint();
  } catch { /* the next tick tries again */ }
}
function addSprays(list) {
  const known = new Set(S.sprays.map((s) => s.key));
  const fresh = list.filter((s) => s && !known.has(s.key));
  if (!fresh.length) return;
  S.sprays = mergeSprays(S.sprays, fresh);
  S.wall.land(mergeSprays([], fresh));
  S.summary.meter.total.classList.remove("bump");
  void S.summary.meter.total.offsetWidth;
  S.summary.meter.total.classList.add("bump");
}

// ---------- spraying ----------
function sprayCard() {
  const st = potState(S.info, nowSec());
  const head = el("div", { class: "card-h" }, el("h2", { id: "spray-h" }, "Spray ", hostEl()));
  if (st !== "open") {
    const why = st === "full" ? "This pot is full, so it can't take more sprays." : st === "closed" ? "The host closed this pot, so it can't take more sprays." : `This pot closed ${closeText(S.info.closesAt)}, so it can't take more sprays.`;
    return el("section", { class: "card pot-spray", "aria-labelledby": "spray-h" }, head,
      el("div", { class: "card-b stack" }, alertBox("", "info", el("p", {}, why)),
        el("a", { class: "text-link", href: "app.html#pots" }, "Open a pot of your own ", el("span", { class: "arrow", "aria-hidden": "true" }, "→"))));
  }
  const form = sprayForm();
  S.form = form;
  return el("section", { class: "card pot-spray", "aria-labelledby": "spray-h" }, head, form.el,
    el("div", { class: "card-f" }, el("span", { class: "micro muted" }, "Your wallet asks before anything is sent.")));
}

function sprayForm() {
  // pay with: dollars (USD₮, any currency for the host) or naira (cNGN, the host gets naira or dollars)
  const payBtns = ["usdt", "cngn"].map((code) => {
    const b = el("button", { type: "button", class: "cur-chip", "aria-pressed": String(code === S.payCode), dataset: { code } },
      el("span", { class: `cur-flag cur-flag-${PAY[code].flag}`, "aria-hidden": "true" }), el("span", {}, `${PAY[code].label} (${PAY[code].token})`));
    b.addEventListener("click", () => setPay(code));
    return b;
  });
  const payGroup = el("div", { class: "segmented pot-pay", role: "group", "aria-labelledby": "pay-with-l" }, payBtns);
  const amountIn = el("input", { id: "spray-amount", type: "text", inputmode: "decimal", autocomplete: "off", spellcheck: "false", size: "4", value: "2", "aria-describedby": "spray-hint" });
  const tokenEl = el("span", { class: "token" }, "USD₮");
  const prefix = el("span", { class: "pot-cur", "aria-hidden": "true" }, "$");
  const quick = el("div", { class: "pot-quick", role: "group", "aria-label": "Quick amounts" });
  const hint = el("p", { class: "hint", id: "spray-hint" });
  const pickerSlot = el("div", {});
  const estimate = el("p", { class: "small soft pot-estimate", "aria-live": "polite" });
  const room = el("p", { class: "small soft", id: "spray-room" });
  const walletBox = el("div", { class: "stack", style: "gap:12px" });
  const actions = el("div", { class: "nt-actions" });
  const msg = el("div", { "aria-live": "polite" });
  const sprayBtn = el("button", { class: "btn btn-primary btn-lg", type: "button" }, "Spray");
  const connectBtn = el("button", { class: "btn btn-primary btn-lg", type: "button" }, icon("wallet"), el("span", {}, "Connect wallet"));
  sprayBtn.addEventListener("click", () => submit());
  connectBtn.addEventListener("click", () => connect());
  amountIn.addEventListener("input", () => { S.touched = true; paint(); });
  amountIn.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });

  let picker = null;
  function buildPicker() {
    const only = receiveChoices(S.payCode);
    const want = S.hostReceive === "usdt" ? "usd" : S.hostReceive;
    const value = only.includes(want) ? want : only.includes("cngn") && S.payCode === "cngn" ? "cngn" : "usd";
    picker = currencyPicker({ label: `What does ${hostName()} receive?`, value, remember: false, only,
      extra: [{ code: "usd", label: "Dollars", flag: "usd", title: "Dollars (USD₮)" }], onChange: () => { choice.refresh(); paint(); } });
    // "They receive: Naira · Change": the choices open inline on demand
    const choice = currencyChoice({ picker, label: "They receive" });
    pickerSlot.replaceChildren(choice.el);
    if (S.rate) picker.setAvailability({ ...S.rate.available, cngn: S.payCode === "cngn" ? true : S.rate.available.cngn });
  }
  const receiveCode = () => (picker.value === "usd" ? "usdt" : picker.value);
  const token = () => sprayToken(S.payCode);
  const fmt = (u) => tokenAmountText(u, token());

  function setPay(code) {
    if (code === S.payCode || S.busy) return;
    S.payCode = code;
    for (const b of payBtns) b.setAttribute("aria-pressed", String(b.dataset.code === code));
    amountIn.value = code === "cngn" ? "3000" : "2";
    buildPicker();
    loadTokenFacts().then(() => refreshRoom());
    refreshBalance();
    paint();
  }

  /** { units, usd6 } or { error }. */
  function readAmount() {
    const p = parseMoneyInput(amountIn.value);
    if (p.error) return { error: p.error };
    const units = BigInt(p.cents) * 10_000n; // USD₮ and cNGN both have 6 decimals
    const rpu = S.rpu[S.payCode];
    if (!rpu) return { units, error: "Loading the contract's rate…" };
    const usd6 = potUsdValue(units, rpu);
    const r = S.remaining ? sprayRoom(S.remaining) : null;
    const error = sprayError({ units, usd6, limits: S.limits[S.payCode], room: r, fmt });
    return error ? { units, usd6, error } : { units, usd6 };
  }
  function paintQuick() {
    const rpu = S.rpu[S.payCode];
    const r = S.remaining ? sprayRoom(S.remaining) : null;
    const lim = S.limits[S.payCode];
    const most = rpu && r ? maxUnitsForUsd6(r.room, rpu) : null;
    const opts = QUICK_AMOUNTS[S.payCode].map((n) => BigInt(n) * 1_000_000n).filter((u) => (!lim || u >= lim.min) && (most == null || u <= most));
    if (most != null && most > 0n && lim && most >= lim.min && !opts.some((u) => u === most)) opts.push(most - (most % 10_000n)); // "the most you can"
    quick.replaceChildren(...opts.map((u) => {
      const b = el("button", { type: "button", class: "pot-quick-btn" }, fmt(u).replace(/\.00$/, ""));
      b.addEventListener("click", () => { amountIn.value = (Number(u) / 1e6).toFixed(2).replace(/\.00$/, ""); S.touched = true; paint(); amountIn.focus(); });
      return b;
    }));
  }
  function paintEstimate(a) {
    const want = receiveCode();
    if (a.error || !a.units) { estimate.textContent = " "; return; }
    if (!payoutRoute(token(), null, "pot", want)) { estimate.textContent = "That pairing isn't paid by the agent. Pick another currency."; return; }
    const r = S.rate;
    let text = null;
    if (S.payCode === "usdt") {
      const usd = Number(a.units) / 1e6;
      if (want === "usdt") text = `${hostName()} gets ${tokenAmountText(a.units, token())} in dollars (USD₮).`;
      else if (r?.rates?.[want] && r.available[want]) text = `${hostName()} gets about ${formatCurrency(usd * r.rates[want], want)} (${currencyOf(want).token}).`;
      else text = `${currencyOf(want).label} isn't quoting on Textile FX right now, so the agent couldn't convert it. Pick another currency.`;
    } else {
      if (want === "cngn") text = `${hostName()} gets ${tokenAmountText(a.units, token())} in naira, passed straight through.`;
      else if (r?.reverseRate) text = `${hostName()} gets about $${num2.format(Math.floor((Number(a.units) / 1e6) * r.reverseRate * 100) / 100)} (USD₮).`;
      else text = `${hostName()} gets dollars (USD₮), converted on Textile FX.`;
    }
    estimate.textContent = text;
  }
  function paintRoom() {
    const rem = S.remaining;
    if (!rem) { room.textContent = "Checking the room left in this pot…"; return; }
    if (rem.error) { room.textContent = "Couldn't read the room left right now. The contract still checks it before any money moves."; return; }
    const r = sprayRoom(rem);
    room.replaceChildren(el("b", {}, `You can spray up to ${usd6Text(r.room, { cents: "always" })}`), ` · ${usd6Text(rem.forPot)} left in the pot.`);
  }
  function walletProblem(a) {
    if (!S.account) return null;
    if (sameAddr(S.account, S.host)) return { kind: "err", text: "This is the host's own wallet: a host can't spray into their own pot. Connect a different wallet." };
    if (!a.error && S.bal && sameAddr(S.bal.token, token()) && S.bal.units < a.units) return { kind: "warn", text: `This wallet has ${fmt(S.bal.units)} in ${PAY[S.payCode].token}, less than the ${fmt(a.units)} you're spraying.` };
    if (S.celo === 0n && !S.celoAnyway) return { kind: "celo" };
    return null;
  }
  const fromLink = el("a", { class: "mono link" }), balCell = el("span", { class: "num" });
  const walletInfo = el("p", { class: "small soft nt-from" }, "Spraying from ", fromLink, " · ", balCell);
  const problemBox = el("div", {});
  let problemKey = "";
  function paintWallet(a) {
    if (S.busy) return;
    if (!eth) {
      if (!walletBox.firstChild) walletBox.append(noWalletHelp({ action: "spray" }));
      actions.replaceChildren();
      return;
    }
    if (!S.account) { walletBox.replaceChildren(); if (actions.firstChild !== connectBtn) actions.replaceChildren(connectBtn); return; }
    fromLink.href = celoscanAddr(S.account); fromLink.title = S.account; fromLink.textContent = short(S.account);
    if (S.bal && sameAddr(S.bal.token, token())) balCell.textContent = `${fmt(S.bal.units)} ${PAY[S.payCode].token}`;
    else balCell.replaceChildren(el("span", { class: "skel" }));
    const problem = walletProblem(a);
    const key = problem ? problem.kind + (problem.text ?? "") : "";
    if (key !== problemKey) {
      problemKey = key;
      if (!problem) problemBox.replaceChildren();
      else if (problem.kind === "celo") problemBox.replaceChildren(noCeloAlert(() => { S.celoAnyway = true; paint(); submit(); }, "Spray anyway"));
      else problemBox.replaceChildren(alertBox(problem.kind, "alert", el("p", {}, problem.text)));
    }
    if (walletBox.firstChild !== walletInfo) walletBox.replaceChildren(walletInfo, problemBox);
    sprayBtn.disabled = Boolean(a.error) || problem?.kind === "err" || problem?.kind === "celo" || !payoutRoute(token(), null, "pot", receiveCode());
    sprayBtn.textContent = a.error ? "Spray" : `Spray ${fmt(a.units).replace(/\.00$/, "")}`;
    if (actions.firstChild !== sprayBtn) actions.replaceChildren(sprayBtn);
  }
  function paint() {
    const a = readAmount();
    tokenEl.textContent = PAY[S.payCode].token;
    prefix.textContent = S.payCode === "cngn" ? "₦" : "$";
    const show = a.error && (S.touched || amountIn.value.trim()) && !/^Loading/.test(a.error);
    hint.classList.toggle("err", Boolean(show));
    hint.textContent = show ? a.error : "";
    amountIn.setAttribute("aria-invalid", String(Boolean(show)));
    paintQuick(); paintEstimate(a); paintRoom(); paintWallet(a);
  }

  async function loadTokenFacts() {
    const code = S.payCode, t = token();
    try {
      const [rpu, lim] = await Promise.all([S.rpu[code] ? S.rpu[code] : readUnitsPerUsd(t), S.limits[code] ? S.limits[code] : readTokenLimits(t)]);
      S.rpu[code] = rpu; S.limits[code] = lim;
    } catch { /* checked again by the contract's dry run */ }
    if (S.alive) paint();
  }
  async function refreshRoom() {
    try { S.remaining = await readPotRemaining(S.id, S.account); } catch { S.remaining = { error: true }; }
    if (S.alive) paint();
  }
  async function refreshBalance() {
    const acct = S.account;
    if (!acct) return;
    const t = token();
    try {
      const [[b], c] = await Promise.all([readContract(t, "0x70a08231", ["address"], [acct], ["uint256"]), celoBalance(acct)]);
      if (acct !== S.account) return;
      S.bal = { token: t, units: b }; S.celo = c;
    } catch { S.bal = null; S.celo = null; }
    paint();
  }
  async function setAccount(acct) {
    S.account = acct ?? null; S.bal = null; S.celo = null; S.celoAnyway = false;
    if (S.account) { try { S.chainOk = String(await eth.request({ method: "eth_chainId" })).toLowerCase() === CELO_CHAIN; } catch { S.chainOk = null; } }
    paint(); refreshBalance(); refreshRoom();
  }
  async function connect() {
    connectBtn.disabled = true;
    connectBtn.lastChild.textContent = "Check your wallet…";
    msg.replaceChildren();
    markWalletConnected();
    try {
      const accs = await eth.request({ method: "eth_requestAccounts" });
      if (!accs?.length) throw plainError("The wallet returned no account.");
      try { await ensureCelo(eth); S.chainOk = true; } catch (e) { msg.replaceChildren(alertBox("warn", "alert", el("p", {}, "Connected, but the wallet is not on Celo. ", errText(e)))); }
      await setAccount(accs[0]);
    } catch (e) {
      msg.replaceChildren(alertBox("err", "alert", el("p", {}, errText(e))));
    } finally {
      connectBtn.disabled = false;
      connectBtn.lastChild.textContent = "Connect wallet";
    }
  }
  const status = (text, hash) => msg.replaceChildren(el("p", { class: "small soft", role: "status" }, text, hash ? [" ", txLink(hash)] : null));

  async function submit() {
    if (S.busy || !S.account) return;
    S.touched = true;
    let a = readAmount();
    if (a.error) { paint(); amountIn.focus(); return; }
    const from = S.account, t = token(), want = receiveCode(), code = S.payCode;
    const ctx = { potId: S.id, token: t };
    S.busy = true;
    sprayBtn.disabled = true;
    sprayBtn.textContent = "Checking the pot…";
    msg.replaceChildren();
    try {
      // fresh from the contract: the pot (open, its caps) and the room for this guest
      try {
        S.info = await readPotInfo(S.id);
        S.remaining = await readPotRemaining(S.id, from);
      } catch { throw plainError("Couldn't re-check the pot on Celo, so nothing was sent. Try again in a moment."); }
      S.summary.paint();
      if (potState(S.info, nowSec()) !== "open") throw plainError("This pot isn't taking sprays any more. Nothing was sent.");
      a = readAmount();
      if (a.error) throw plainError(`${a.error} Nothing was sent.`);
      if (!S.celoAnyway) {
        const c = await celoBalance(from);
        if (c === 0n) { S.busy = false; S.celo = 0n; paint(); problemBox.querySelector("button")?.focus(); return; }
      }
      sprayBtn.textContent = "Check your wallet…";
      await ensureCelo(eth);
      S.chainOk = true;
      const [bal] = await readContract(t, "0x70a08231", ["address"], [from], ["uint256"]);
      if (bal < a.units) throw plainError(`This wallet has ${fmt(bal)} in ${PAY[code].token}, less than ${fmt(a.units)}. Nothing was sent.`);
      // the contract's own dry run: every cap and rule, before anything is signed
      const chk = await checkPotPayment({ potId: S.id, token: t, amount: a.units, payer: from });
      if (!chk.ok) throw plainError(chk.message);
      // LokalPots has no permit: approve exactly this amount (only if the current approval doesn't cover it)
      const allowance = await readAllowance(t, from, LOKAL_POTS);
      if (allowance < a.units) {
        const approve = approveData(LOKAL_POTS, a.units);
        const simA = await simulate({ from, to: t, data: approve }, ctx);
        if (!simA.ok) throw plainError(simA.message);
        sprayBtn.textContent = "Approve in your wallet…";
        status(`Step 1 of 2: approve exactly ${fmt(a.units)} for the LokalPots contract. Then you confirm the spray.`);
        const ah = await eth.request({ method: "eth_sendTransaction", params: [{ from, to: t, value: "0x0", data: approve }] });
        if (!isHash(ah)) throw plainError("The wallet didn't return a transaction id. Check your wallet's activity before trying again.");
        sprayBtn.textContent = "Waiting for Celo…";
        status("Approval sent. Waiting for Celo to confirm it…", ah);
        const rc = await waitForReceipt(ah, { failMessage: "The approval failed on Celo, so nothing was sprayed. Only the network fee was spent." });
        if (!rc) throw plainError("Celo hasn't confirmed the approval yet, so nothing was sprayed. Try again in a minute.");
      }
      const data = payPotData({ potId: S.id, token: t, amount: a.units, ref: currencyRef(want) });
      // the exact transaction, simulated from this wallet: a refusal is explained here, before anything is sent
      const sim = await simulate({ from, to: LOKAL_POTS, data }, ctx);
      if (!sim.ok) throw plainError(sim.message);
      sprayBtn.textContent = allowance < a.units ? "Step 2 of 2: confirm…" : "Confirm in your wallet…";
      msg.replaceChildren();
      const hash = await eth.request({ method: "eth_sendTransaction", params: [{ from, to: LOKAL_POTS, value: "0x0", data }] });
      if (!isHash(hash)) throw plainError("The wallet didn't return a transaction id. Check your wallet's activity before trying again.");
      sprayBtn.textContent = "Waiting for Celo…";
      const slow = el("p", { class: "micro muted" });
      msg.replaceChildren(el("p", { class: "small soft", role: "status" }, "Sprayed. Waiting for Celo to confirm it… ", txLink(hash)), slow);
      const stopSlow = slowNotice(slow, hash);
      let rc;
      try { rc = await waitForReceipt(hash, { failMessage: "The contract refused the spray on Celo, so nothing moved. Only the network fee was spent." }); } finally { stopSlow(); }
      if (!rc) throw plainError("Celo hasn't confirmed the spray after a few minutes. It may still go through; this page adds it to the wall when it does.");
      // the PotPaid event in the receipt goes on the wall right away
      const landed = (rc.logs ?? []).filter((l) => decodePotPaid(l)).map((l) => sprayOf({ ...l, blockNumber: parseInt(l.blockNumber, 16) || 0, logIndex: parseInt(l.logIndex, 16) || 0, transactionHash: l.transactionHash ?? hash }, nowSec()));
      addSprays(landed);
      const gets = want === "usdt" ? "dollars" : currencyOf(want)?.plural;
      // the calm confirmation in place of the form; Done brings the form back
      msg.replaceChildren();
      const ok = successPanel();
      const done = el("button", { class: "btn btn-primary", type: "button" }, "Done");
      done.addEventListener("click", () => { node.replaceChildren(...formKids); paint(); amountIn.focus(); });
      ok.details.append(el("ul", { class: "kv-list" },
        el("li", {}, el("span", {}, "You sprayed"), el("span", {}, `${fmt(a.units)} ${PAY[code].token}`)),
        el("li", {}, el("span", {}, "From"), el("span", { class: "mono" }, short(from))),
        el("li", {}, el("span", {}, "Transaction"), txLink(hash))));
      ok.set({ state: "done", title: successHeadline({ state: "done", amount: fmt(a.units).replace(/\.00$/, ""), to: hostName() }),
        text: `It's on the wall. The agent pays ${hostName()} in ${gets} when autopilot next runs.`, actions: [done] });
      node.replaceChildren(ok.el);
      requestAnimationFrame(() => ok.heading.focus({ preventScroll: true }));
      S.busy = false;
      S.info = await readPotInfo(S.id).catch(() => S.info);
      S.summary.paint();
      await Promise.all([refreshRoom(), refreshBalance()]);
    } catch (e) {
      S.busy = false;
      msg.replaceChildren(alertBox("err", "alert", el("p", {}, errText(e))));
      paint();
    }
  }

  buildPicker();
  const node = el("div", { class: "card-b stack pot-form" },
    el("div", { class: "field" }, el("span", { class: "label", id: "pay-with-l" }, "Spray with"), payGroup),
    el("div", { class: "field" }, el("label", { class: "label", for: "spray-amount" }, "How much?"),
      el("div", { class: "money" }, prefix, amountIn, tokenEl), quick, hint),
    el("div", { class: "field" }, pickerSlot, estimate),
    room, walletBox, actions, msg);
  const formKids = [...node.childNodes];
  loadTokenFacts();
  refreshRoom();
  loadRate().then((r) => { S.rate = r; picker.setAvailability({ ...r.available, cngn: S.payCode === "cngn" ? true : r.available.cngn }); paint(); }).catch(() => paint());
  if (eth && !walletDisconnected()) {
    eth.request({ method: "eth_accounts" }).then((accs) => { if (accs?.[0]) setAccount(accs[0]); }).catch(() => {});
    eth.on?.("accountsChanged", (accs) => setAccount(accs?.[0] ?? null));
  }
  paint();
  return { el: node, repaint: () => { if (!S.busy) refreshRoom(); } };
}

start();
