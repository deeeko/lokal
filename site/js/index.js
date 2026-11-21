// The landing (index.html): six sections (hero, how it works, four countries, why it's safe, proof, the last word and
// four questions). Every feature with its label lives on features.html. Only three things on the landing are live:
//   1. the hero converter: type dollars, see naira / rupiah / pesos from the live Textile FX rate (/api/rate, or
//      rate.json where there is no API), each amount ticking in when it changes;
//   2. the four countries' rates;
//   3. Proof: real payouts read from the agent's transactions on Celo (amount, currency, receipt, transaction; never an
//      address), with an honest empty state until the first one.
// The activity feed and everyone's addresses are not on this page: they live behind sign-in (Activity, Dashboard).
// Signed-in visitors never get here by accident: assets/gate.js sends them to the dashboard unless they asked for
// "About Lokal" (index.html?about); then the top bar's "Sign in" becomes "Dashboard".
import { $, $$, el, initChrome, loadRate, loadTxPage, txKind, receiptNo, celoscanTx, lagosTime, lagosClock, parseMoneyInput, CAP, CURRENCIES, formatCurrency, tokenOf } from "../assets/core.js";
import { getSession } from "../assets/session.js";
import { flagIcon } from "../assets/currency-ui.js";
import { ntagCard, stage, reducedMotion } from "../assets/ntag-ui.js";

document.documentElement.classList.add("js");
initChrome();

// signed in, here on purpose ("About Lokal"): the top bar offers the way back
if (getSession()) {
  const a = $("#lp-signin");
  a.textContent = "Dashboard";
  a.href = "app.html";
}

// ---------- the converter ----------
const input = $("#conv-amount");
const hint = $("#conv-hint");
const list = $("#conv-rows");
let rate = null;
const cells = new Map();
for (const [i, c] of CURRENCIES.entries()) {
  const v = el("span", { class: "v" }, "…");
  const amt = el("span", { class: "conv-amt", title: `${c.name}, rounded down` }, v);
  const note = el("span", { class: "conv-note", hidden: true });
  const li = el("li", { class: "enter", style: `animation-delay:${i * 70}ms`, dataset: { code: c.code } },
    flagIcon(c.code), el("span", { class: "conv-where" }, el("b", {}, c.city), el("span", {}, `${c.label} · ${c.token}`)), amt, note);
  cells.set(c.code, { v, amt, note, last: null });
  list.append(li);
}

/** Puts `text` in a cell; when it changed, the new value ticks up into place (a cross-fade with reduced motion). */
function show(code, text, state = "") {
  const c = cells.get(code);
  c.amt.classList.toggle("is-off", state === "off");
  c.amt.classList.toggle("is-over", state === "over");
  if (c.last === text) return;
  c.last = text;
  c.v.textContent = text;
  c.v.classList.remove("tick");
  void c.v.offsetWidth;
  c.v.classList.add("tick");
}

function amount() {
  const raw = input.value;
  if (!String(raw).trim()) return { empty: true };
  const p = parseMoneyInput(raw);
  return p.error ? { invalid: true } : { value: p.cents / 100 };
}

function renderConverter() {
  const a = amount();
  hint.classList.remove("err");
  input.removeAttribute("aria-invalid");
  if (a.invalid) {
    hint.classList.add("err");
    input.setAttribute("aria-invalid", "true");
    hint.textContent = "Type an amount in dollars, for example 10.";
    for (const c of CURRENCIES) show(c.code, "—", "off");
    return;
  }
  const over = !a.empty && a.value > CAP;
  hint.textContent = over
    ? `Over the $${CAP} limit: the contract would refuse this before any money moves.`
    : "They receive, after the conversion fee:";
  if (over) hint.classList.add("err");
  if (!rate) return;
  for (const c of CURRENCIES) {
    const cell = cells.get(c.code);
    const r = rate.available[c.code] ? rate.rates[c.code] : null;
    const max = rate.maxUsd[c.code];
    cell.note.hidden = true;
    if (!r) { show(c.code, "Not quoting now", "off"); continue; }
    if (a.empty || a.value === 0) { show(c.code, "—", "off"); continue; }
    show(c.code, formatCurrency(a.value * r, c.code), over ? "over" : "");
    if (!over && max && a.value > max) {
      cell.note.hidden = false;
      cell.note.textContent = `Textile can convert up to about $${max.toFixed(2)} into ${c.plural} right now.`;
    }
  }
}
input.addEventListener("input", renderConverter);
input.addEventListener("focus", () => input.select());

loadRate().then((r) => {
  rate = r;
  $("#conv-time").textContent = r.stale ? "Delayed" : r.fetchedAt ? `${lagosClock(r.fetchedAt)} WAT` : "";
  renderConverter();
  renderCountries();
}).catch(() => {
  for (const c of CURRENCIES) show(c.code, "—", "off");
  hint.textContent = "The live rate couldn't be loaded. Reload, or open the quote page.";
  $("#conv-time").textContent = "Offline";
  for (const li of $$("#countries-list li")) li.querySelector("[data-rate]").firstChild.textContent = "—";
});
renderConverter();

// ---------- the four countries ----------
function renderCountries() {
  for (const li of $$("#countries-list li")) {
    const code = li.dataset.code;
    const box = li.querySelector("[data-rate]");
    const r = rate.available[code] ? rate.rates[code] : null;
    const c = CURRENCIES.find((x) => x.code === code);
    box.firstChild.textContent = r ? formatCurrency(r, code, code === "cngn" ? 2 : c.places) : "Not quoting now";
    const max = rate.maxUsd[code];
    box.lastChild.textContent = r ? (max && max < CAP ? `per $1 · up to about $${max.toFixed(2)} right now` : "per $1, fee included") : "Try again later";
  }
}

// ---------- the example card in "How it works" ----------
const card = ntagCard({ tag: "ada", name: "Ada", kind: "live", currency: "cngn", tilt: !reducedMotion() });
$("#how-card").append(stage(card));

// ---------- proof: real payouts, read from Celo (no addresses shown) ----------
const payouts = $("#payouts");
const msg = $("#payouts-msg");
/** A payout's amount from its transfer(to, amount) calldata, in the token's own decimals. */
function payoutAmount(tx) {
  const t = tokenOf(tx.to?.hash);
  const hex = String(tx.raw_input ?? "").slice(74, 138);
  if (!t || !/^[0-9a-f]{64}$/i.test(hex)) return null;
  const v = Number(BigInt("0x" + hex)) / 10 ** t.decimals;
  const c = CURRENCIES.find((x) => x.token === t.symbol);
  return c ? formatCurrency(v, c.code) + " " + t.symbol : `$${v.toFixed(2)} ${t.symbol}`;
}
loadTxPage().then(({ items }) => {
  const rows = items.filter((t) => txKind(t) === "payout" && t.status === "ok" && /^0x[0-9a-f]{64}$/i.test(String(t.hash)));
  if (!rows.length) {
    msg.textContent = "The first real payout will appear here with its transaction.";
    return;
  }
  payouts.classList.add("has-rows");
  msg.textContent = "Each one was paid by the agent on Celo mainnet. Open a receipt to check it.";
  payouts.append(el("ul", {}, rows.slice(0, 5).map((t) => {
    const no = receiptNo(t.hash);
    return el("li", {},
      el("span", {}, el("b", {}, payoutAmount(t) ?? "A payout"), el("span", { class: "muted" }, t.timestamp ? ` · ${lagosTime(t.timestamp)} WAT` : "")),
      el("span", { class: "row" }, el("a", { class: "link mono", href: `receipt.html#${no}` }, no), el("a", { class: "link small", href: celoscanTx(t.hash) }, "Transaction ↗")));
  })));
}).catch(() => {
  msg.textContent = "Couldn't read the agent's payouts from Celo just now. The first real payout will appear here with its transaction.";
});

// ---------- calm reveals on scroll ----------
const io = "IntersectionObserver" in window ? new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
}, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 }) : null;
for (const n of $$(".reveal, .reveal-list")) { if (io) io.observe(n); else n.classList.add("in"); }
