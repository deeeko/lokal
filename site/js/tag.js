import {
  AGENT, CAP, TOKENS, $$, el, icon, badge, short, num2, naira, usd, celoscanAddr, celoscanTx, initChrome,
  toast, readContract, loadRate, loadNtagOps, resolveNtags, ownerOf, ntagAvailability, normalizeNtag, ntagError,
  encodeNtagTransfer, ntagUrl, receiptNo, walletDisconnected, markWalletConnected, parseMoneyInput, lagosTime, $,
  currencyOf, formatCurrency, celoscanAddr as addrLink, legacyNtagOps,
} from "../assets/core.js";
import {
  LOKAL_TAGS, ZERO_ADDRESS, approveData, checkPayment, currencyRef, payTagData, payTagWithPermitData, permitDomainOk,
  permitTypedData, readAllowance, readNonce, readPaymentRoom, readTagInfo, simulate, splitSignature, tokenAmountText,
} from "../assets/lokal-contracts.js";
import { currencyPicker, flagIcon } from "../assets/currency-ui.js";
import { getSession, explainWalletError, injectedWallet, ensureCelo, CELO_CHAIN } from "../assets/session.js";
import {
  ntagCard, stage, alertBox, availabilityMessage, ntagFinder, waitForReceipt, plainError, sameAddr, sleep, dayMonthYear,
  nameText, LIMITS, LIMITS_TEXT, CNGN_CAP_USD, REFUSED_NOTE, receivableToday, allowanceResetAt, loadNtagStateFresh,
  loadTagLedger, slowNotice, scrollToNode, focusHeading, noWalletHelp, noCeloAlert, celoBalance,
  agentStatus, depositStatus, allowanceFromStatus, combineAllowance, receivedStale, reasonText, paidText, sourceNote, refusedNote, refundedLine,
  DELAYED_NOTE, SLOW_NOTE, payoutText, lookupTag,
} from "../assets/ntag-ui.js";

initChrome();
// A pay page belongs under "Send". On Vercel it's served at /@ada, which no sidebar entry names, so mark it here.
for (const a of document.querySelectorAll(".sb-nav a, .nav-links a")) {
  if (a.getAttribute("href") === "quote.html") a.setAttribute("aria-current", "page");
  else if (a.getAttribute("aria-current") === "page") a.removeAttribute("aria-current");
}

// Public nTag page: /@ada on Vercel (rewritten to tag.html?t=ada, but the address bar keeps /@ada), tag.html?t=ada or
// tag.html#ada. The tag's holder, name and receive currency are read from the LokalTags contract. Paying is one call to
// LokalTags: payTagWithPermit for USD₮ (one signature, one transaction) or approve + payTag for cNGN. The contract checks
// every limit before the money moves straight to the agent, which then pays the holder in the currency they chose.
// Every refusal is simulated (eth_call) and explained before the wallet opens. A tag claimed with the older memo
// protocol before the cutover, and not on the contract, is still paid the old way: one ERC-20 transfer to the agent
// with "NTP:<tag>" after the usual calldata (site/_spec/NTAGS.md section 1e).

const root = $("#tag-root");
const title = $("#tag-title"), lead = $("#tag-lead");
const eth = injectedWallet();
const USDT_MIN_CENTS = 100, USDT_MAX_CENTS = CAP * 100; // $1.00 to $25.00
const NGN_MIN = 1500; // cNGN payments must also be worth at least $1 (the agent checks it live)
const PAYOUT_POLL_MS = 10_000, PAYOUT_WATCH_MS = 2 * 3600_000;
const PENDING_KEY = (tag) => `np-ntag-pay:${tag}`;
const isHash = (h) => /^0x[0-9a-fA-F]{64}$/.test(String(h));
const errText = (e) => (e?.plain ? e.message : explainWalletError(e));
const txLink = (hash, text = "View on Celoscan") => el("a", { class: "link", href: celoscanTx(hash) }, text, " ", icon("ext"));
const ngnText = (n) => num2.format(n).replace(/\.00$/, "");
const watTime = (ms) => (ms ? `${lagosTime(ms)} WAT` : "24 hours");
const dollars = (v) => usd(Math.floor(v * 100 + 1e-6) / 100).replace(/\.00$/, "");

/** The tag in the address. /@tag wins over ?t= and #, so /@ada?t=x or /@ada#x can never show another tag. */
function readTag() {
  const m = location.pathname.match(/^\/@([^/?#]+)$/);
  if (m) {
    let t = m[1];
    try { t = decodeURIComponent(t); } catch { /* malformed escape: shown as not a valid tag */ }
    return normalizeNtag(t);
  }
  const q = new URLSearchParams(location.search).get("t");
  let h = location.hash.replace(/^#/, "");
  try { h = decodeURIComponent(h); } catch { /* keep as is */ }
  return normalizeNtag(q || h);
}
function finderCard(heading, value) {
  return el("section", { class: "card" }, el("div", { class: "card-b stack" },
    heading ? el("h2", { class: "section-title", style: "font-size:20px" }, heading) : null,
    ntagFinder({ id: "tag-find", label: "Find a Lokal tag", value, address: () => getSession()?.address })));
}

// ---------- page ----------
// Everything a render starts (wallet listeners, the payout tracker, timers) registers a clean-up here, so a new render
// (another tag via the hash) never leaves the old one running.
let cleanups = [];
const onCleanup = (fn) => { cleanups.push(fn); };
function teardown() { for (const fn of cleanups.splice(0)) { try { fn(); } catch { /* keep tearing down */ } } }

let renderSeq = 0, shownTag;
async function render() {
  teardown();
  const my = ++renderSeq;
  const tag = readTag();
  shownTag = tag;
  if (!tag) {
    document.title = "Pay by Lokal tag · Lokal";
    title.replaceChildren("Find a ", el("em", {}, "Lokal tag"));
    lead.textContent = "A Lokal tag is a short name tied to a Celo wallet. Pay the tag in dollars and the agent pays that wallet in naira, rupiah or pesos.";
    root.replaceChildren(finderCard(null));
    return;
  }
  const err = ntagError(tag);
  if (err && !/reserved/.test(err)) {
    title.replaceChildren("Pay by ", el("em", {}, "Lokal tag"));
    root.replaceChildren(el("div", { class: "stack" },
      alertBox("warn", "alert", el("p", {}, el("b", {}, `@${tag} isn't a valid Lokal tag. `), `It ${err.replace(/^use /, "should use ").replace(/^must /, "must ").replace(/^can't /, "can't ")}. Check the link with whoever sent it.`)),
      finderCard("Look someone up", tag)));
    return;
  }
  document.title = `@${tag} · Lokal`;
  title.replaceChildren("Pay ", el("em", {}, "@" + tag));
  root.replaceChildren(el("p", { class: "small muted", role: "status" }, el("span", { class: "skel", style: "width:14px;height:14px;border-radius:50%;margin-right:8px" }), `Looking up @${tag} on Celo…`));
  let found;
  try { found = await lookupTag(tag, getSession()?.address); }
  catch {
    if (my !== renderSeq) return;
    const retry = el("button", { class: "btn btn-secondary btn-sm", type: "button" }, icon("refresh"), "Try again");
    retry.addEventListener("click", render);
    root.replaceChildren(alertBox("err", "alert", el("p", {}, "Couldn't reach Celo to look up this tag. Nothing was sent."), el("div", { class: "row mt-8" }, retry)));
    return;
  }
  if (my !== renderSeq) return;
  if (!found.entry) { renderUnclaimed(tag, found); return; }
  renderProfile(tag, found.entry);
}

function renderUnclaimed(tag, found) {
  const kind = found.kind;
  title.replaceChildren(el("em", {}, "@" + tag), kind === "reserved" ? " is reserved" : kind === "locked" ? " is on hold" : " is free");
  const card = ntagCard({ tag, kind: "ghost", stamp: kind === "reserved" ? "Reserved" : kind === "locked" ? "On hold" : "Unclaimed" });
  let copy;
  if (kind === "reserved") {
    lead.textContent = "Some tags are kept back so nobody can pretend to be the service, a bank or a wallet.";
    copy = [el("p", { class: "soft" }, `Nobody can claim @${tag}, so there's no one to pay here. If someone gave you this tag, ask them for their real one.`)];
  } else if (kind === "locked") {
    const lock = found.lock;
    lead.textContent = "This tag was released recently.";
    copy = [el("p", { class: "soft" }, availabilityMessage(tag, kind, { lock }).text, " There's no one to pay at this tag right now.")];
  } else {
    lead.textContent = "Nobody has claimed this tag, so there's no one to pay here yet.";
    copy = [
      el("p", { class: "soft" }, `If someone sent you this link, check the spelling with them. If it's the name you want, it's yours to take: claiming takes a minute and costs only the network fee.`),
      el("div", { class: "nt-actions" }, el("a", { class: "btn btn-primary btn-lg", href: `account.html#claim=${tag}` }, `Claim @${tag} yourself`, icon("right"))),
    ];
  }
  root.replaceChildren(el("div", { class: "stack", style: "gap:24px" },
    el("section", { class: "card" }, el("div", { class: "card-b", style: "padding:clamp(22px,4vw,40px)" },
      el("div", { class: "nt-signin" },
        el("div", { class: "stack" }, el("h2", { class: "section-title" }, kind === "free" ? `Nobody has @${tag} yet` : `You can't pay @${tag}`), ...copy),
        stage(card)))),
    finderCard("Looking for someone else?")));
}

function renderProfile(tag, entry) {
  const C = entry.source === "contract";
  const pref = entry.currency ? currencyOf(entry.currency) : null;
  const gets = pref ? `prefers to receive ${pref.plural}` : C && entry.receive === "usdt" ? "prefers to receive dollars" : "gets paid in their own local money";
  if (entry.name) lead.replaceChildren(nameText(entry.name), ` ${gets} on Celo. You send USD₮; the agent converts it on Textile FX and pays their wallet.`);
  else lead.textContent = `@${tag} ${gets}. You send USD₮; the agent converts it on Textile FX and pays this tag's wallet.`;
  const card = ntagCard({ tag, name: entry.name, address: entry.owner, since: entry.since, currency: entry.currency, as: "button", label: `Lokal tag @${tag}. Copy the link to this page` });
  card.dataset.copy = ntagUrl(tag);
  card.dataset.copyLabel = "Link copied";
  const details = el("section", { class: "card", "aria-labelledby": "who-h" },
    el("div", { class: "card-h" }, el("h2", { id: "who-h" }, "Who you're paying"), badge(C ? "On the LokalTags contract" : "Older memo tag", "neutral")),
    el("div", { class: "card-b" }, el("ul", { class: "kv-list" },
      el("li", {}, el("span", {}, "Lokal tag"), el("span", { class: "np-tagname", style: "font-size:17px;color:var(--celo)" }, "@" + tag)),
      entry.name ? el("li", {}, el("span", {}, "Name"), el("span", { class: "nt-namecell" }, nameText(entry.name), el("small", { class: "micro muted" }, "Name set by the owner"))) : null,
      el("li", {}, el("span", {}, "Wallet"), el("a", { class: "mono link", href: celoscanAddr(entry.owner), title: entry.owner }, short(entry.owner), " ", icon("ext"))),
      el("li", {}, el("span", {}, "Prefers"), pref
        ? el("span", { class: "cur-inline" }, flagIcon(pref.code), `${pref.label} (${pref.token})`)
        : C && entry.receive === "usdt" ? el("span", { class: "cur-inline" }, flagIcon("usd"), "Dollars (USD₮)")
          : el("span", { class: "soft" }, "Not set (naira by default)")),
      el("li", {}, el("span", {}, "Since"), el("span", {}, dayMonthYear(entry.since))),
      C ? el("li", {}, el("span", {}, "Registry"), el("a", { class: "link", href: addrLink(LOKAL_TAGS) }, "LokalTags contract ", icon("ext")))
        : el("li", {}, el("span", {}, "Claim"), el("a", { class: "link", href: celoscanTx(entry.hash) }, "Transaction ", icon("ext"))))),
    el("div", { class: "card-f" }, el("span", { class: "small muted" }, "The tag's owner chose this name; nobody checks it. Make sure it's who you expect."),
      el("button", { class: "btn btn-ghost btn-sm", type: "button", dataset: { copy: ntagUrl(tag), copyLabel: "Link copied" } }, icon("copy"), "Copy link")));
  root.replaceChildren(el("div", { class: "grid-main" }, payCard(tag, entry), el("div", { class: "nt-profile" }, stage(card), details)));
}

// ---------- pay ----------
function payCard(tag, entry) {
  // C: the tag is on the LokalTags contract and is paid through it. Either way the PAYER chooses what the owner gets on
  // this payment (the owner's optional default is pre-selected, else naira): you send USD₮ for naira, rupiah or pesos,
  // or cNGN for dollars. On the contract the choice travels in payTag's `ref` ("cur:<code>"), which the agent reads.
  const C = entry.source === "contract";
  const startCode = entry.receive === "usdt" ? "usd" : entry.currency ?? "cngn";
  const P = {
    corridor: startCode === "usd" ? "cngn-usdt" : `usdt-${startCode}`, rate: null, rateFailed: false, account: null, chainOk: null, bal: null, celo: null, busy: false,
    touched: false, allowance: null, celoAnyway: false, alive: true, room: null,
  };
  onCleanup(() => { P.alive = false; });
  // isNaira: you send USD₮ and they get local money (any currency); otherwise you send cNGN and they get dollars
  const isNaira = () => P.corridor !== "cngn-usdt";
  const code = () => (isNaira() ? P.corridor.slice(5) : null); // the currency they receive, or null (dollars)
  const cur = () => currencyOf(code());
  const perUsd = () => (P.rate && code() && P.rate.available[code()] ? P.rate.rates[code()] : null);
  const sellToken = () => (isNaira() ? TOKENS.USDT : TOKENS.cNGN);
  const pref = entry.currency ?? null;

  const picker = currencyPicker({
    label: `What does @${tag} receive?`, describedBy: "corridor-l", value: startCode, remember: false,
    extra: [{ code: "usd", label: "Dollars", flag: "usd", title: "Dollars (USD₮): you send cNGN" }],
    onChange: (c) => {
      const next = c === "usd" ? "cngn-usdt" : `usdt-${c}`;
      const unitChange = (next === "cngn-usdt") !== (P.corridor === "cngn-usdt");
      P.corridor = next;
      if (unitChange) { amountIn.value = isNaira() ? "10" : "15000"; P.bal = null; P.room = null; refreshBalances(); refreshRoom(); }
      renderForm();
    },
  });
  const seg = picker.el;
  const segHint = el("p", { class: "hint" });
  const amountIn = el("input", { id: "pay-amount", type: "text", inputmode: "decimal", autocomplete: "off", spellcheck: "false", size: "4", value: "10", "aria-describedby": "pay-amount-hint pay-today" });
  const tokenEl = el("span", { class: "token" }, "USD₮");
  const amountHint = el("p", { class: "hint", id: "pay-amount-hint" });
  const out = el("output", { for: "pay-amount", "aria-live": "polite" }, el("span", { class: "skel lg" }));
  const sRate = el("span", {}, "—"), sSend = el("span", {}, "—");
  const today = el("p", { class: "small soft", id: "pay-today" }, `Checking how much more @${tag} can receive today…`);
  const ctrRoom = el("p", { class: "small soft", id: "pay-contract-room" });
  const limits = el("div", { class: "nt-limits" }, today, C ? ctrRoom : null,
    el("p", { class: "micro muted" }, LIMITS_TEXT, ". ", REFUSED_NOTE));

  // wallet area: built once and updated in place, so a click is never lost to a rebuild (blur re-renders the form)
  const fromLink = el("a", { class: "mono link" });
  const balCell = el("span", { class: "num" });
  const netCell = el("span", {});
  const walletInfo = el("ul", { class: "kv-list" },
    el("li", {}, el("span", {}, "Paying from"), fromLink),
    el("li", {}, el("span", {}, "Balance"), balCell),
    el("li", {}, el("span", {}, "Network"), netCell));
  const problemBox = el("div", {});
  const noWalletBox = el("div", {});
  const walletBox = el("div", { class: "stack", style: "gap:12px" });
  const payBtn = el("button", { class: "btn btn-primary btn-lg", type: "button" }, "Pay");
  const connectBtn = el("button", { class: "btn btn-primary btn-lg", type: "button" }, icon("wallet"), el("span", {}, "Connect wallet"));
  payBtn.addEventListener("click", () => submit());
  connectBtn.addEventListener("click", () => connect());
  const actions = el("div", { class: "nt-actions" });
  const msg = el("div", { "aria-live": "polite" });
  const form = el("div", { class: "stack" },
    el("div", { class: "field" }, el("span", { class: "label", id: "corridor-l" }, "What does @" + tag + " get?"), seg, segHint),
    el("div", { class: "field" }, el("label", { class: "label", for: "pay-amount" }, "You send"), el("div", { class: "money" }, amountIn, tokenEl), amountHint),
    el("div", { class: "swap-arrow", "aria-hidden": "true" }, el("span", {}, icon("down"))),
    el("div", { class: "receive" }, el("div", { class: "label" }, el("span", {}, "@" + tag + " gets about")), out),
    el("ul", { class: "kv-list" },
      el("li", {}, el("span", {}, "You send"), sSend),
      el("li", {}, el("span", {}, "Rate"), sRate),
      el("li", {}, el("span", {}, "Through"), el("span", {}, C ? "The LokalTags contract, which checks every limit first" : "A transfer to the agent with a memo")),
      el("li", {}, el("span", {}, "Paid by"), el("span", {}, "The agent, when autopilot next runs"))),
    limits, walletBox, actions, msg);
  const body = el("div", { class: "card-b" }, form);
  const basis = el("span", { class: "badge neutral", id: "pay-basis" }, "Estimate");
  const section = el("section", { class: "card", "aria-labelledby": "pay-h" },
    el("div", { class: "card-h" }, el("h2", { id: "pay-h" }, "Pay ", el("span", { class: "np-tagname", style: "font-size:17px" }, "@" + tag)), basis),
    body,
    el("div", { class: "card-f" }, el("span", { class: "small muted" }, "Your wallet asks before anything is sent. The final amount is set by Textile FX when the agent converts.")));

  // ----- amount -----
  /** { cents, units (bigint, 6 dp), usd } or { error } */
  function readAmount() {
    const p = parseMoneyInput(amountIn.value);
    if (p.error) return { error: p.error };
    const cents = p.cents;
    const units = BigInt(cents) * 10_000n;
    let value;
    if (isNaira()) {
      if (cents < USDT_MIN_CENTS || cents > USDT_MAX_CENTS) return { cents, units, error: `Send $1 to $${CAP}${perUsd() ? ` (≈ ${formatCurrency(CAP * perUsd(), code())})` : ""}.` };
      value = cents / 100;
      if (code() && P.rate && !perUsd()) return { cents, units, error: `${cur().label} isn't available on Textile FX right now, so the agent would refuse it. ${C ? "Try again later." : "Pick another currency, or try again later."}` };
      const max = code() ? P.rate?.maxUsd?.[code()] : null;
      if (max && value > max) return { cents, units, error: `Textile can convert up to about $${max.toFixed(2)} into ${cur().plural} right now. Send less, or pick another currency.` };
    } else {
      if (cents < NGN_MIN * 100) return { cents, units, error: `Send at least ₦${ngnText(NGN_MIN)}.` };
      const rr = P.rate?.reverseRate;
      if (!rr) return { cents, units, error: P.rateFailed ? `Couldn't load the dollar rate, so the $${CAP} limit can't be checked. Choose naira, or reload in a minute.` : "Loading the dollar rate…" };
      value = (cents / 100) * rr;
      if (value > CNGN_CAP_USD) return { cents, units, error: `That's worth about ${dollars(value)}. In cNGN, send up to about ₦${ngnText(Math.floor(CNGN_CAP_USD / rr))} so it stays under the agent's $${CAP} limit after price moves.` };
      if (value < 1) return { cents, units, error: "That's worth less than $1. Send a little more." };
    }
    // the contract's own room today (per payment, per recipient, per payer, overall): it would refuse anything over it
    const room = C && P.room && !P.room.error ? P.room : null;
    if (room && units > room.room) return { cents, units, usd: value, limit: true, error: roomError(room) };
    const alw = P.allowance;
    if (alw && !alw.error && value > alw.leftUsd + 0.005) {
      const at = allowanceResetAt(alw, value);
      if (alw.leftUsd < 1) return { cents, units, usd: value, limit: true, error: `@${tag} has reached today's limit; try again after ${watTime(at)}.` };
      return { cents, units, usd: value, limit: true, error: `@${tag} can receive ${alw.exact ? "" : "about "}${dollars(alw.leftUsd)} more today. Send less, or try again after ${watTime(at)}.` };
    }
    return { cents, units, usd: value };
  }
  const fmtSend = (cents) => (isNaira() ? `${num2.format(cents / 100)} USD₮` : `${num2.format(cents / 100)} cNGN`);
  /** Why the contract would refuse an amount over its room today, in plain English. */
  const roomError = (r) => {
    const t = sellToken().address, amt = (u) => tokenAmountText(u, t);
    if (r.room === 0n) {
      if (r.remaining.forRecipient === 0n) return `@${tag} has reached today's limit on the contract. Try again after midnight UTC.`;
      if (r.remaining.forPayer === 0n) return "You've reached today's limit for paying through the contract. Try again after midnight UTC.";
      return "The contract has reached today's total for everyone. Try again after midnight UTC.";
    }
    if (r.room === r.remaining.forRecipient && r.room < r.max) return `@${tag} can receive ${amt(r.room)} more in ${sellToken().symbol} today on the contract. Send less.`;
    if (r.room === r.remaining.forPayer && r.room < r.max) return `You can pay ${amt(r.room)} more in ${sellToken().symbol} today on the contract. Send less.`;
    if (r.room === r.remaining.overall && r.room < r.max) return `The contract can take ${amt(r.room)} more in ${sellToken().symbol} today across everyone. Send less.`;
    return `The contract takes at most ${amt(r.max)} in one payment. Send less.`;
  };
  function renderRoom() {
    if (!C) return;
    const r = P.room;
    const t = sellToken().address, amt = (u) => tokenAmountText(u, t);
    if (!r) ctrRoom.textContent = "Checking the contract's limits for today…";
    else if (r.error) ctrRoom.textContent = "Couldn't read the contract's limits right now. It still checks them before any money moves.";
    else ctrRoom.replaceChildren(el("b", {}, `Contract room today: up to ${amt(r.room)}`),
      ` (@${tag} can receive ${amt(r.remaining.forRecipient)} more, ${P.account ? `you can pay ${amt(r.remaining.forPayer)} more` : "per payer up to " + amt(r.limits.perPayerDay)}; ${amt(r.min)} minimum).`);
  }
  async function refreshRoom() {
    if (!C) return;
    const token = sellToken().address, who = P.account;
    try {
      const r = await readPaymentRoom(token, entry.owner, who ?? ZERO_ADDRESS);
      if (!P.alive || token !== sellToken().address || who !== P.account) return;
      P.room = r;
    } catch { P.room = { error: true }; }
    if (P.alive) renderForm();
  }
  const cngnHint = () => {
    const rr = P.rate?.reverseRate;
    const most = rr ? `about ₦${ngnText(Math.floor(CNGN_CAP_USD / rr))} (about $${CNGN_CAP_USD})` : `about $${CNGN_CAP_USD} in value`;
    return `₦${ngnText(NGN_MIN)} up to ${most}. That's a little under the $${CAP} limit, so price moves before the agent pays can't push it over.`;
  };

  function renderToday() {
    const a = P.allowance;
    const lim = `limit $${LIMITS.perPersonDay} per person per day`;
    if (!a) today.textContent = `Checking how much more @${tag} can receive today…`;
    else if (a.error) today.textContent = `Couldn't check how much more @${tag} can receive today (${lim}). The agent still checks it before paying.`;
    else {
      // "about" unless the agent's fresh records and the chain agree (or the agent's are the stricter): see combineAllowance
      const all = Number.isFinite(a.globalLeftUsd) && a.globalLeftUsd < a.leftUsd - 0.005
        ? ` The agent can pay out ${a.exact ? "" : "about "}${dollars(a.globalLeftUsd)} more today across everyone; a payment over that waits until there's room.` : "";
      today.replaceChildren(el("b", {}, `@${tag} can receive ${a.exact ? "" : "about "}${dollars(a.leftUsd)} more today`), ` · ${lim}.${all} `, sourceNote(a.source === "agent"));
    }
  }
  function renderForm() {
    const chose = isNaira() ? cur() : null;
    const prefC = pref ? currencyOf(pref) : null;
    picker.note(prefC ? (chose && chose.code === pref ? `@${tag} prefers ${prefC.plural}.` : `@${tag} prefers ${prefC.plural}; you chose ${chose ? chose.plural : "dollars"}.`) : "");
    segHint.textContent = isNaira() ? `You send USD₮. @${tag} gets ${chose.plural} (${chose.token}).` : `You send cNGN. @${tag} gets USD₮ (dollars).`;
    tokenEl.textContent = sellToken().symbol;
    const a = readAmount();
    const show = a.error && (P.touched || a.limit || amountIn.value.trim()) && !/^Loading/.test(a.error);
    amountHint.classList.toggle("err", !!show);
    amountHint.textContent = show ? a.error : isNaira() ? `$1 to $${CAP}${perUsd() ? ` (up to ≈ ${formatCurrency(CAP * perUsd(), code())})` : ""}, up to 2 decimals.` : cngnHint();
    amountIn.setAttribute("aria-invalid", String(!!show));
    sSend.textContent = a.cents > 0 && !a.error ? fmtSend(a.cents) : "—";
    const r = P.rate;
    let get = null, rateText = "—";
    if (r) {
      if (isNaira()) {
        const pu = perUsd();
        rateText = pu ? `1 USD₮ = ${formatCurrency(pu, code(), code() === "cngn" ? 2 : cur().places)}` : `${cur().label}: not available right now`;
        if (a.cents > 0 && pu) get = el("span", { title: `${cur().name}, rounded down` }, formatCurrency((a.cents / 100) * pu, code()));
      }
      else if (r.reverseRate) { rateText = `1 USD₮ = ${naira(1 / r.reverseRate)}`; if (a.cents > 0) get = usd((a.cents / 100) * r.reverseRate); }
      else if (isNaira() && !code()) { rateText = "No conversion"; if (a.cents > 0) get = usd(a.cents / 100); }
      else rateText = "Not published yet";
      basis.textContent = r.fromPreview ? "Fees included" : "Before fees";
    } else if (P.rateFailed) rateText = "Rate unavailable";
    if (r || P.rateFailed) out.replaceChildren(get ?? "—");
    out.classList.toggle("over", !!a.error && a.cents > 0 && !/^Loading/.test(a.error));
    sRate.textContent = rateText;
    renderToday();
    renderRoom();
    renderWallet();
  }

  // ----- wallet -----
  async function refreshBalances() {
    const acct = P.account;
    if (!acct) return;
    const token = sellToken().address;
    try {
      const [[b], c] = await Promise.all([readContract(token, "0x70a08231", ["address"], [acct], ["uint256"]), celoBalance(acct)]);
      if (acct !== P.account || !P.alive) return;
      P.bal = { token, units: b };
      P.celo = c;
    } catch { P.bal = null; P.celo = null; }
    renderWallet();
  }
  function walletProblem() {
    if (!P.account) return null;
    if (sameAddr(P.account, entry.owner)) return { kind: "err", text: `This is @${tag}'s own wallet. The agent doesn't pay a tag from its owner's wallet, so this payment would be refused. Connect a different wallet.` };
    if (sameAddr(P.account, AGENT)) return { kind: "err", text: "This is the agent's own wallet. Connect your own wallet." };
    const a = readAmount();
    if (!a.error && P.bal && sameAddr(P.bal.token, sellToken().address) && P.bal.units < a.units) {
      return { kind: "warn", text: `This wallet has ${num2.format(Number(P.bal.units) / 1e6)} ${sellToken().symbol}, less than the ${fmtSend(a.cents)} you're sending.` };
    }
    if (P.celo === 0n && !P.celoAnyway) return { kind: "celo" };
    return null;
  }
  const setActions = (node) => { if (actions.childNodes.length !== 1 || actions.firstChild !== node) actions.replaceChildren(node); };
  let problemKey = "";
  function renderWallet() {
    if (P.busy) return;
    if (!eth) {
      if (!noWalletBox.firstChild) noWalletBox.append(noWalletHelp({ action: "pay" }));
      if (walletBox.firstChild !== noWalletBox) walletBox.replaceChildren(noWalletBox);
      actions.replaceChildren();
      return;
    }
    if (!P.account) {
      if (walletBox.firstChild) walletBox.replaceChildren();
      setActions(connectBtn);
      return;
    }
    fromLink.href = celoscanAddr(P.account);
    fromLink.title = P.account;
    fromLink.textContent = short(P.account);
    if (P.bal && sameAddr(P.bal.token, sellToken().address)) balCell.textContent = `${num2.format(Number(P.bal.units) / 1e6)} ${sellToken().symbol}`;
    else if (!balCell.querySelector(".skel")) balCell.replaceChildren(el("span", { class: "skel" }));
    if (P.chainOk === false) { if (!netCell.querySelector(".badge")) netCell.replaceChildren(badge("Not Celo: switch when you pay", "warn")); }
    else if (netCell.textContent !== "Celo mainnet") netCell.textContent = "Celo mainnet";
    const problem = walletProblem();
    const key = problem ? problem.kind + ":" + (problem.text ?? "") : "";
    if (key !== problemKey) {
      problemKey = key;
      if (!problem) problemBox.replaceChildren();
      else if (problem.kind === "celo") problemBox.replaceChildren(noCeloAlert(() => { P.celoAnyway = true; renderWallet(); submit(); }, "Pay anyway"));
      else problemBox.replaceChildren(alertBox(problem.kind, "alert", el("p", {}, problem.text)));
    }
    if (walletBox.childNodes.length !== 2 || walletBox.firstChild !== walletInfo) walletBox.replaceChildren(walletInfo, problemBox);
    const a = readAmount();
    payBtn.disabled = Boolean(a.error) || problem?.kind === "err" || problem?.kind === "celo"; // no CELO: confirm with "Pay anyway"
    const label = a.error ? "Pay" : `Pay ${fmtSend(a.cents)}`;
    if (payBtn.textContent !== label) payBtn.textContent = label;
    setActions(payBtn);
  }
  async function setAccount(acct) {
    P.account = acct ?? null;
    P.bal = null; P.celo = null; P.celoAnyway = false;
    if (P.account) {
      try { P.chainOk = String(await eth.request({ method: "eth_chainId" })).toLowerCase() === CELO_CHAIN; } catch { P.chainOk = null; }
    }
    if (!P.alive) return;
    renderWallet();
    refreshBalances();
    refreshRoom();
  }
  async function connect() {
    connectBtn.disabled = true;
    connectBtn.lastChild.textContent = "Check your wallet…";
    msg.replaceChildren();
    markWalletConnected();
    try {
      const accs = await eth.request({ method: "eth_requestAccounts" });
      if (!accs?.length) throw plainError("The wallet returned no account.");
      try { await ensureCelo(eth); P.chainOk = true; } catch (e) { msg.replaceChildren(alertBox("warn", "alert", el("p", {}, "Connected, but the wallet is not on Celo. ", errText(e)))); }
      await setAccount(accs[0]);
    } catch (e) {
      msg.replaceChildren(alertBox("err", "alert", el("p", {}, errText(e))));
    } finally {
      connectBtn.disabled = false;
      connectBtn.lastChild.textContent = "Connect wallet";
    }
  }
  /**
   * Room today: ALWAYS read from the chain (straight from Blockscout for the live check before sending), and from the
   * agent's records when they are fresh; the smaller room wins. Never throws.
   */
  async function loadAllowance({ live = false } = {}) {
    try {
      const [server, chain] = await Promise.all([
        agentStatus({ recipient: entry.owner }).then((a) => allowanceFromStatus(a)).catch(() => null),
        receivableToday(entry.owner, P.rate, { live }).catch(() => null),
      ]);
      P.allowance = combineAllowance(server, chain) ?? { error: true };
    } catch { P.allowance = { error: true }; }
  }

  // ----- send -----
  async function submit() {
    if (P.busy || !P.account) return;
    P.touched = true;
    const a0 = readAmount();
    if (a0.error) { renderForm(); amountIn.focus(); return; }
    if (C) return submitContract();
    const from = P.account, token = sellToken(), corridor = P.corridor;
    P.busy = true;
    payBtn.disabled = true;
    payBtn.textContent = "Checking @" + tag + "…";
    msg.replaceChildren();
    try {
      // the tag could have moved since the page loaded: re-check right before sending, straight from Blockscout
      let now;
      // (legacy claims before the cutover only; and a tag someone now holds on the contract is paid there instead)
      let onContract;
      try {
        now = ownerOf(resolveNtags(legacyNtagOps((await loadNtagStateFresh()).ops)), tag);
        onContract = (await readTagInfo(tag)).owner;
      } catch { throw plainError(`Couldn't re-check @${tag} on Celo, so nothing was sent. Try again in a moment.`); }
      if (onContract) throw plainError(`@${tag} is now held on the LokalTags contract, so nothing was sent. Reload the page to pay its holder there.`);
      if (!now || !sameAddr(now.owner, entry.owner)) throw plainError(`@${tag} changed wallets a moment ago, so nothing was sent. Reload the page to see who has it now.`);
      if (sameAddr(from, now.owner)) throw plainError(`This is @${tag}'s own wallet, so nothing was sent. Connect a different wallet.`);
      await loadAllowance({ live: true });
      const a = readAmount();
      if (a.error) throw plainError(`${a.error} Nothing was sent.`, { limit: a.limit });
      if (!P.celoAnyway) {
        const c = await celoBalance(from);
        if (c === 0n) {
          P.busy = false;
          P.celo = 0n;
          renderForm(); // shows the warning with "Get CELO" and "Pay anyway"
          problemBox.querySelector("button")?.focus();
          return;
        }
      }
      payBtn.textContent = "Check your wallet…";
      await ensureCelo(eth);
      P.chainOk = true;
      const [bal] = await readContract(token.address, "0x70a08231", ["address"], [from], ["uint256"]);
      if (bal < a.units) throw plainError(`This wallet has ${num2.format(Number(bal) / 1e6)} ${token.symbol}, less than ${fmtSend(a.cents)}. Nothing was sent.`);
      // the memo names the currency they receive ("NTP:budi:idrx"); naira keeps the original "NTP:budi"
      const data = encodeNtagTransfer(AGENT, a.units, tag, isNaira() ? code() : undefined);
      const hash = await eth.request({ method: "eth_sendTransaction", params: [{ from, to: token.address, value: "0x0", data }] });
      if (!isHash(hash)) throw plainError("The wallet didn't return a transaction id. Check your wallet's activity before trying again.");
      const pending = { hash, from, corridor, cents: a.cents, owner: entry.owner, since: entry.since, at: Date.now() };
      try { sessionStorage.setItem(PENDING_KEY(tag), JSON.stringify(pending)); } catch { /* storage blocked: tracking works until the page closes */ }
      P.busy = false;
      track(pending, { scroll: true });
    } catch (e) {
      P.busy = false;
      if (!P.alive) return;
      if (e.limit) renderForm();
      msg.replaceChildren(alertBox("err", "alert", el("p", {}, errText(e))));
      renderWallet();
    }
  }

  /**
   * Pays through LokalTags. Before the wallet opens: the tag and its receive currency are re-read from the contract,
   * the contract's own dry run (validatePayment) explains any refusal, and the exact transaction is simulated from the
   * payer's wallet. USD₮: one permit signature (EIP-2612) and one payTagWithPermit. cNGN: approve exactly the amount,
   * then payTag. Both carry the attribution suffix.
   */
  async function submitContract() {
    const from = P.account, token = sellToken(), corridor = P.corridor, payCode = isNaira() ? "usdt" : "cngn";
    const ref = currencyRef(code() ?? "usdt"); // the payer's choice for this payment: "cur:idrx", ... or "cur:usdt" (dollars)
    P.busy = true;
    payBtn.disabled = true;
    payBtn.textContent = "Checking @" + tag + "…";
    msg.replaceChildren();
    const ctx = { tag, token: token.address };
    try {
      let info;
      try { info = await readTagInfo(tag); } catch { throw plainError(`Couldn't re-check @${tag} on Celo, so nothing was sent. Try again in a moment.`); }
      if (!info.owner || !sameAddr(info.owner, entry.owner)) throw plainError(`@${tag} changed wallets a moment ago, so nothing was sent. Reload the page to see who has it now.`);
      if (sameAddr(from, info.owner)) throw plainError(`This is @${tag}'s own wallet, so nothing was sent. Connect a different wallet.`);
      await Promise.all([loadAllowance({ live: true }), refreshRoom()]);
      const a = readAmount();
      if (a.error) throw plainError(`${a.error} Nothing was sent.`, { limit: a.limit });
      if (!P.celoAnyway) {
        const c = await celoBalance(from);
        if (c === 0n) {
          P.busy = false;
          P.celo = 0n;
          renderForm();
          problemBox.querySelector("button")?.focus();
          return;
        }
      }
      payBtn.textContent = "Check your wallet…";
      await ensureCelo(eth);
      P.chainOk = true;
      const [bal] = await readContract(token.address, "0x70a08231", ["address"], [from], ["uint256"]);
      if (bal < a.units) throw plainError(`This wallet has ${num2.format(Number(bal) / 1e6)} ${token.symbol}, less than ${fmtSend(a.cents)}. Nothing was sent.`);
      // the contract's own dry run: every limit, before any signature
      const chk = await checkPayment({ tag, token: token.address, amount: a.units, payer: from });
      if (!chk.ok) throw plainError(chk.message, { limit: true });
      let data;
      if (payCode === "usdt" && (await permitDomainOk(token.address))) {
        const nonce = await readNonce(token.address, from);
        const deadline = BigInt(Math.floor(Date.now() / 1000) + 30 * 60);
        payBtn.textContent = "Sign in your wallet…";
        msg.replaceChildren(el("p", { class: "small soft", role: "status" }, `Sign the permit: it lets the LokalTags contract move exactly ${fmtSend(a.cents)} once, within 30 minutes. Signing sends nothing.`));
        const sig = await eth.request({ method: "eth_signTypedData_v4", params: [from, JSON.stringify(permitTypedData({ owner: from, value: a.units, nonce, deadline }))] });
        const { v, r, s } = splitSignature(sig);
        data = payTagWithPermitData({ tag, token: token.address, amount: a.units, ref, deadline, v, r, s });
      } else {
        const allowance = await readAllowance(token.address, from, LOKAL_TAGS);
        if (allowance < a.units) {
          const approve = approveData(LOKAL_TAGS, a.units);
          const simA = await simulate({ from, to: token.address, data: approve }, ctx);
          if (!simA.ok) throw plainError(simA.message);
          payBtn.textContent = "Approve in your wallet…";
          msg.replaceChildren(el("p", { class: "small soft", role: "status" }, `Step 1 of 2: approve exactly ${fmtSend(a.cents)} for the LokalTags contract. Then you confirm the payment.`));
          const ah = await eth.request({ method: "eth_sendTransaction", params: [{ from, to: token.address, value: "0x0", data: approve }] });
          if (!isHash(ah)) throw plainError("The wallet didn't return a transaction id. Check your wallet's activity before trying again.");
          payBtn.textContent = "Waiting for Celo…";
          msg.replaceChildren(el("p", { class: "small soft", role: "status" }, "Approval sent. Waiting for Celo to confirm it… ", txLink(ah)));
          const rc = await waitForReceipt(ah, { failMessage: "The approval failed on Celo, so nothing was paid. Only the network fee was spent." });
          if (!rc) throw plainError("Celo hasn't confirmed the approval yet, so nothing was paid. Try again in a minute.");
        }
        data = payTagData({ tag, token: token.address, amount: a.units, ref });
      }
      // the exact transaction, simulated from this wallet: a refusal is explained here, before anything is sent
      const sim = await simulate({ from, to: LOKAL_TAGS, data }, ctx);
      if (!sim.ok) throw plainError(sim.message);
      payBtn.textContent = "Confirm in your wallet…";
      msg.replaceChildren();
      const hash = await eth.request({ method: "eth_sendTransaction", params: [{ from, to: LOKAL_TAGS, value: "0x0", data }] });
      if (!isHash(hash)) throw plainError("The wallet didn't return a transaction id. Check your wallet's activity before trying again.");
      const pending = { hash, from, corridor, payCode, cents: a.cents, owner: entry.owner, since: entry.since, at: Date.now(), contract: true };
      try { sessionStorage.setItem(PENDING_KEY(tag), JSON.stringify(pending)); } catch { /* storage blocked: tracking works until the page closes */ }
      P.busy = false;
      track(pending, { scroll: true });
    } catch (e) {
      P.busy = false;
      if (!P.alive) return;
      if (e.limit) renderForm();
      msg.replaceChildren(alertBox("err", "alert", el("p", {}, errText(e))));
      renderWallet();
    }
  }

  // ----- tracking: confirmed on Celo, then the agent's payout to the owner -----
  function track(p, { scroll = false } = {}) {
    let stopped = false, stopSlow = null;
    const stop = () => { stopped = true; stopSlow?.(); };
    onCleanup(stop);
    const sendUsdt = p.payCode ? p.payCode === "usdt" : p.corridor !== "cngn-usdt";
    const sendText = sendUsdt ? `${num2.format(p.cents / 100)} USD₮` : `${num2.format(p.cents / 100)} cNGN`;
    const rows = {};
    const step = (id, t, sub) => {
      const small = el("small", {}, sub ?? "");
      const b = el("b", {}, t);
      const li = el("li", {}, el("span", { class: "nt-p-icon", "aria-hidden": "true" }), el("div", {}, b, small));
      rows[id] = { li, small, b };
      return li;
    };
    const set = (id, state, sub, heading) => {
      const r = rows[id];
      r.li.className = state ?? "";
      r.li.firstChild.replaceChildren(...(state === "done" ? [icon("check")] : state === "err" ? [icon("x")] : []));
      if (state === "active") r.li.setAttribute("aria-current", "step"); else r.li.removeAttribute("aria-current");
      if (sub !== undefined) r.small.replaceChildren(...[].concat(sub));
      if (heading) r.b.textContent = heading;
    };
    const list = el("ol", { class: "nt-progress" },
      step("sent", "Sent from your wallet", [sendText, " · ", txLink(p.hash)]),
      step("chain", "Waiting for Celo to confirm…", ""),
      step("agent", `The agent pays @${tag}`, "When autopilot next runs, after Celo confirms your payment."),
      step("paid", "Paid", ""));
    const status = el("div", { "aria-live": "polite" });
    const source = el("p", { class: "micro muted" }); // where the status comes from: the agent's records or the chain
    const setSource = (fromAgent) => source.replaceChildren(sourceNote(fromAgent, "nt-source"));
    const again = el("button", { class: "btn btn-secondary", type: "button" }, "Send another payment");
    again.addEventListener("click", () => {
      stop();
      try { sessionStorage.removeItem(PENDING_KEY(tag)); } catch { /* ignore */ }
      body.replaceChildren(form);
      loadAllowance().then(() => { if (P.alive) renderForm(); });
      renderForm();
      amountIn.focus();
    });
    const h = el("h3", { style: "font-size:20px;font-weight:500" }, "Waiting for Celo to confirm…");
    const lede = el("p", { class: "small soft mt-8", role: "status" }, `You sent ${sendText} to @${tag}. Keep this page open until Celo confirms it.`);
    const box = el("div", { class: "nt-track" }, el("div", {}, h, lede), list, status, source, el("div", { class: "nt-actions" }, again));
    body.replaceChildren(box);
    focusHeading(h);
    if (scroll) requestAnimationFrame(() => scrollToNode(section));
    set("sent", "done");
    set("chain", "active", "Usually a few seconds.");
    stopSlow = slowNotice(rows.chain.small, p.hash);

    const clear = () => { try { sessionStorage.removeItem(PENDING_KEY(tag)); } catch { /* ignore */ } };
    (async () => {
      let rc;
      try {
        rc = await waitForReceipt(p.hash, { tries: 120, failMessage: p.contract ? "The payment failed on Celo, so nothing reached the agent. Only the network fee was spent." : "The transfer failed on Celo, so nothing was sent to the agent. Only the network fee was spent." });
      } catch (e) {
        stopSlow?.();
        if (stopped) return;
        h.textContent = "Payment failed";
        lede.textContent = "Nothing reached the agent.";
        set("chain", "err", errText(e), "Celo refused the transfer");
        clear();
        return;
      }
      stopSlow?.();
      if (stopped) return;
      if (!rc) {
        h.textContent = "Still waiting for Celo";
        set("chain", "", ["Not confirmed after five minutes. It may still go through. ", txLink(p.hash, "Check it on Celoscan")], "Waiting for Celo to confirm…");
        return;
      }
      h.textContent = "Payment confirmed";
      lede.textContent = `Celo confirmed your ${sendText} to @${tag}. You can close this page now; the payment still goes through.`;
      set("chain", "done", "Confirmed.", "Celo confirmed it");
      set("agent", "active", "When autopilot next runs.");
      const until = p.at + PAYOUT_WATCH_MS;
      let noted = "";
      const showPaid = (no, gotText) => {
        set("agent", "done", "Converted on Textile FX and sent.");
        set("paid", "done", "");
        status.replaceChildren(el("div", { class: "nt-paid" }, el("span", { class: "nt-paid-icon" }, icon("check")),
          el("div", {}, el("b", {}, `Paid · ${no}`),
            gotText ? el("span", { class: "small soft" }, `@${tag} got ${gotText}. `) : null,
            el("a", { class: "link small", href: `receipt.html#${no}` }, "Open receipt ", icon("right")))));
        toast(`@${tag} has been paid`);
        clear();
      };
      const depositUnits = BigInt(p.cents) * 10_000n; // what the payer sent, to tell this transfer from others in the tx
      while (!stopped && Date.now() < until) {
        if (document.visibilityState === "visible") {
          try {
            // 1. the agent's own record of this deposit: "paid" and "refused" are final and exact
            const ev = depositStatus(await agentStatus({ tx: p.hash }), p.hash, { kind: "ntag", tag, amount: depositUnits });
            if (stopped) return;
            if (ev?.status === "paid") {
              setSource(true);
              showPaid(ev.receiptNo, paidText(ev));
              return;
            }
            if (ev?.status === "refunded") {
              setSource(true);
              set("agent", "err", "Not paid: sent back to you.");
              status.replaceChildren(alertBox("", "info", el("p", {}, refundedLine(ev))));
              clear();
              return;
            }
            if (ev?.status === "refused") {
              setSource(true);
              set("agent", "err", "Not paid.");
              status.replaceChildren(alertBox("warn", "alert", el("p", {}, refusedNote(ev.reason))));
              // keep watching: a refund shows here as "Refunded"
            }
            // 2. "received", "failed" or no record: read the chain as before; a payout found there wins
            try {
              const { deposits } = await loadTagLedger({ tag, owner: p.owner, sinceSec: p.since ?? entry.since, rate: P.rate, currency: C ? code() : null });
              if (stopped) return;
              const d = deposits.find((x) => String(x.hash).toLowerCase() === p.hash.toLowerCase());
              if (d?.status === "paid") {
                setSource(false);
                showPaid(receiptNo(d.payout.hash), payoutText(d.payout.token, d.payout.units));
                return;
              }
              // the chain's guesses about refusals only count when the agent has no record of this deposit
              if (!ev && d?.status === "ineligible") {
                setSource(false);
                const over = d.reason.kind === "over" || d.reason.kind === "day";
                set("agent", "err", over ? "Above the limit — not paid automatically." : `${d.reason.text} — not paid.`);
                status.replaceChildren(alertBox("warn", "alert", el("p", {}, el("b", {}, `${d.reason.text}. `),
                  over ? `The agent's limits are ${LIMITS_TEXT}. ` : "", REFUSED_NOTE, " Your payment stays with the agent.")));
                clear();
                return;
              }
              if (!ev && d?.status === "maybe") {
                setSource(false);
                const key = d.payout.hash;
                if (noted !== key) {
                  noted = key;
                  status.replaceChildren(alertBox("", "info", el("p", {}, `A payout to @${tag} was sent at ${watTime(d.payout.ts)}; it may be for another payment. `,
                    el("a", { class: "link", href: `receipt.html#${receiptNo(d.payout.hash)}` }, "Open that receipt ", icon("right")))));
                }
              }
            } catch { /* explorer hiccup: try again next round */ }
            // 3. what the agent says while no payout is visible
            if (ev?.status === "failed") {
              setSource(true);
              set("agent", "active", DELAYED_NOTE);
              status.replaceChildren(alertBox("warn", "alert", el("p", {}, el("b", {}, DELAYED_NOTE), " Your payment is safe with the agent and is paid once the owner retries it.")));
            } else if (ev?.status === "received") {
              setSource(true);
              set("agent", "active", receivedStale(ev)
                ? `${SLOW_NOTE} The agent recorded your payment at ${watTime(Date.parse(ev.at))} but hasn't reported the payout yet.`
                : `The agent has your payment and is paying @${tag} now.`);
            }
          } catch { /* never let the tracker die: try again next round */ }
        }
        await sleep(PAYOUT_POLL_MS);
      }
      if (!stopped) set("agent", "", "Not paid yet. The agent pays when autopilot next runs; check the Autopilot page, or come back later.");
    })();
  }

  // ----- wire up -----
  amountIn.addEventListener("input", renderForm);
  amountIn.addEventListener("blur", () => { P.touched = true; renderForm(); });
  if (eth?.on) {
    const onAccounts = (accs) => { if (P.busy) return; if (walletDisconnected() && !P.account) return; setAccount(accs?.[0] ?? null); };
    const onChain = (id) => { P.chainOk = String(id).toLowerCase() === CELO_CHAIN; renderWallet(); };
    eth.on("accountsChanged", onAccounts);
    eth.on("chainChanged", onChain);
    onCleanup(() => { eth.removeListener?.("accountsChanged", onAccounts); eth.removeListener?.("chainChanged", onChain); });
  }
  loadRate().then((r) => { P.rate = r; picker?.setAvailability(r.available); }).catch(() => { P.rateFailed = true; })
    .then(() => { if (P.alive) renderForm(); return loadAllowance(); })
    .then(() => { if (P.alive) renderForm(); });
  renderForm();
  refreshRoom();
  if (eth && !walletDisconnected()) eth.request({ method: "eth_accounts" }).then((accs) => { if (P.alive && accs?.[0] && !P.account) setAccount(accs[0]); }).catch(() => {});

  // a payment sent from this tab earlier (page reloaded): keep tracking it
  let pending = null;
  try { pending = JSON.parse(sessionStorage.getItem(PENDING_KEY(tag)) ?? "null"); } catch { pending = null; }
  if (pending && isHash(pending.hash) && sameAddr(pending.owner, entry.owner) && Date.now() - pending.at < 24 * 3600_000
    && Boolean(pending.contract) === C && /^(usdt-(cngn|idrx|wars|wcop)|cngn-usdt|forward-(usdt|cngn))$/.test(String(pending.corridor))) {
    setTimeout(() => { if (P.alive) track(pending); }, 0);
  }
  return section;
}

// a hash change only matters when it names another tag (on /@ada the path wins, so the hash never changes the tag)
addEventListener("hashchange", () => { if (readTag() !== shownTag) render(); });
render();
