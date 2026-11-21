// proof.html: every real Lokal payout, read from Celo when the page opens (assets/proof.js does the reading and the
// sums; this file only draws them): a short header, the totals and the list. Never an address. A named user who
// doesn't match a real payout is a red line in the list, never hidden.
import { $, el, icon, initChrome, celoscanTx, lagos, lagosClock, CURRENCIES, TAG } from "../assets/core.js";
import { agentStatus } from "../assets/ntag-ui.js";
import { loadProof, proofModel } from "../assets/proof.js";

document.documentElement.classList.add("js");
initChrome();

const body = $("#pf-body");
const timeEl = $("#pf-time");
const T = { payouts: $("#t-payouts"), usd: $("#t-usd"), currencies: $("#t-currencies"), recipients: $("#t-recipients") };
const money = (n) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (ms) => lagos(ms, { day: "numeric", month: "short", year: "numeric" });
/** Local tokens read as their currency ("cNGN" -> "naira"), USD₮ as "dollars". */
const curWord = (sym) => CURRENCIES.find((c) => c.token === sym)?.plural ?? (sym === "USD₮" ? "dollars" : sym);

function totals(t) {
  T.payouts.textContent = String(t.payouts);
  T.usd.replaceChildren(money(t.usd), ...(t.usdMissing ? [el("small", {}, ` + ${t.usdMissing} not priced`)] : []));
  T.currencies.textContent = t.currencies.length ? [...new Set(t.currencies.map(curWord))].join(", ") : "None yet";
  T.recipients.textContent = String(t.recipients);
}

function row(r, depositsRead) {
  const tx = (hash, label) => el("a", { class: "link", href: celoscanTx(hash) }, label, " ", icon("ext"));
  const deposit = r.depositHash ? tx(r.depositHash, "Deposit") : el("span", { class: "muted" }, depositsRead ? "Deposit not matched" : "Deposit: couldn't check");
  return el("li", { class: "pf-row" },
    el("div", { class: "pf-when" }, el("b", {}, r.time ? day(r.time) : "Date unknown"), el("span", {}, r.time ? `${lagosClock(r.time)} WAT` : "")),
    el("div", { class: "pf-corr" }, el("b", {}, r.from ?? "?", el("span", { class: "pf-arrow", "aria-label": "to" }, " → "), r.to)),
    el("div", { class: "pf-amts" }, el("span", {}, r.inText ?? "In: unknown"), el("span", { class: "pf-arrow", "aria-hidden": "true" }, "→"), el("b", {}, r.outText)),
    el("div", { class: "pf-rcpt" }, el("a", { class: "mono link", href: `receipt.html#${r.receiptNo}` }, r.receiptNo)),
    el("div", { class: "pf-tx" }, deposit, tx(r.payoutHash, "Payout")),
    el("div", { class: `pf-attr ${r.tagged ? "ok" : "bad"}`, title: r.tagged ? `The payout's input carries Lokal's attribution tag ${TAG}.` : `The payout's input does not carry ${TAG}.` },
      icon(r.tagged ? "check" : "x"), el("span", { class: "mono" }, TAG), r.tagged ? null : el("span", {}, "missing")),
    r.user ? el("p", { class: "pf-user" }, el("b", {}, r.user.label), [r.user.city, r.user.usedFor].filter(Boolean).map((s) => " · " + s).join("")) : null);
}

async function run() {
  let data;
  try {
    data = await loadProof({ statusFor: (recipient) => agentStatus({ recipient }) });
  } catch {
    for (const k of Object.keys(T)) T[k].textContent = "—";
    timeEl.textContent = "Offline";
    body.replaceChildren(el("p", { class: "pf-empty" }, icon("alert"), "Couldn't read the agent's payouts from Celo just now. Reload in a minute."));
    return;
  }
  const model = proofModel({ payouts: data.payouts, deposits: data.deposits, events: data.events, users: data.users ?? [] });
  totals(model.totals);
  timeEl.textContent = `Read at ${lagosClock(Date.now())} WAT`;
  const mismatched = model.users.mismatched.map(({ entry }) => el("li", { class: "pf-bad" }, icon("x"),
    `${String(entry?.label ?? "A named entry")} (${String(entry?.receiptNo ?? "no receipt number")}) doesn't match the chain.`));
  body.replaceChildren(...[
    model.rows.length
      ? el("ul", { class: "pf-rows" }, model.rows.map((r) => row(r, data.deposits != null)))
      : el("p", { class: "pf-empty" }, icon("receipt"), "No real payouts yet. The first one will appear here with its transactions."),
    mismatched.length ? el("ul", { class: "pf-bads" }, mismatched) : null,
  ].filter(Boolean));
}
run();
