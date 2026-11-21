// proof.html: every real Lokal payout, read from Celo when the page opens (assets/proof.js does the reading and the
// sums; this file only draws them). Never an address: rows show amounts, receipt numbers and transaction links.
import { $, el, icon, initChrome, celoscanTx, lagos, lagosClock, CURRENCIES, TAG } from "../assets/core.js";
import { agentStatus } from "../assets/ntag-ui.js";
import { loadProof, proofModel } from "../assets/proof.js";

document.documentElement.classList.add("js");
initChrome();

const body = $("#pf-body");
const timeEl = $("#pf-time");
const note = $("#pf-note");
const again = $("#pf-again");
const named = $("#named"), namedList = $("#pf-named");
const T = { payouts: $("#t-payouts"), usd: $("#t-usd"), currencies: $("#t-currencies"), recipients: $("#t-recipients") };
const money = (n) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (ms) => lagos(ms, { day: "numeric", month: "short", year: "numeric" });
/** "USD₮" stays; local tokens read as their currency ("cNGN" -> "naira"). */
const curWord = (sym) => CURRENCIES.find((c) => c.token === sym)?.plural ?? (sym === "USD₮" ? "dollars" : sym);

function totals(t) {
  T.payouts.textContent = String(t.payouts);
  T.usd.replaceChildren(money(t.usd), ...(t.usdMissing ? [el("small", {}, ` + ${t.usdMissing} not priced`)] : []));
  T.currencies.textContent = t.currencies.length ? [...new Set(t.currencies.map(curWord))].join(", ") : "None yet";
  T.recipients.textContent = String(t.recipients);
}

function row(r, depositsRead) {
  const tx = (hash, label) => el("a", { class: "link", href: celoscanTx(hash) }, label, " ", icon("ext"));
  const deposit = r.depositHash ? tx(r.depositHash, "Deposit")
    : el("span", { class: "muted", title: depositsRead ? "No matching payment was found on the contracts or in the agent's records (an older memo payment or a direct payout)." : "The contracts' payment events couldn't be read just now." },
      depositsRead ? "Deposit not matched" : "Deposit: couldn't check");
  return el("li", { class: "pf-row" },
    el("div", { class: "pf-when" }, el("b", {}, r.time ? day(r.time) : "Date unknown"), el("span", {}, r.time ? `${lagosClock(r.time)} WAT` : "")),
    el("div", { class: "pf-corr" }, el("b", {}, r.from ?? "?", el("span", { class: "pf-arrow", "aria-label": "to" }, " → "), r.to),
      el("span", {}, r.kind === "pot" ? "A pot" : r.kind === "tag" ? "A Lokal tag" : r.matchedBy ? "A payment" : "Payout")),
    el("div", { class: "pf-amts" }, el("span", {}, r.inText ?? "In: unknown"), el("span", { class: "pf-arrow", "aria-hidden": "true" }, "→"), el("b", {}, r.outText)),
    el("div", { class: "pf-rcpt" }, el("a", { class: "mono link", href: `receipt.html#${r.receiptNo}` }, r.receiptNo)),
    el("div", { class: "pf-tx" }, deposit, tx(r.payoutHash, "Payout")),
    el("div", { class: `pf-attr ${r.tagged ? "ok" : "bad"}`, title: r.tagged ? `The payout's input ends with Lokal's ERC-8021 tag ${TAG}.` : `The payout's input does not carry ${TAG}.` },
      icon(r.tagged ? "check" : "x"), el("span", { class: "mono" }, TAG), el("span", { class: "pf-attr-say" }, r.tagged ? "in the payout" : "missing")),
    r.user ? el("p", { class: "pf-user" }, el("b", {}, r.user.label), [r.user.city, r.user.usedFor ? `used it for ${r.user.usedFor}` : null].filter(Boolean).map((s) => " · " + s).join("")) : null);
}

function renderNamed(users, usersRead) {
  const items = [
    ...users.matched.map(({ entry }) => el("li", { class: "ok" }, icon("check"),
      el("div", {}, el("b", {}, entry.label), el("span", {}, [entry.city, entry.usedFor].filter(Boolean).join(" · ")),
        el("a", { class: "mono link", href: `receipt.html#${entry.receiptNo}` }, entry.receiptNo, " · matches a real payout")))),
    ...users.mismatched.map(({ entry, reason }) => el("li", { class: "bad" }, icon("x"),
      el("div", {}, el("b", {}, String(entry?.label ?? "An entry")), el("span", { class: "mono" }, String(entry?.receiptNo ?? "no receipt number")),
        el("span", { class: "pf-bad-say" }, `Doesn't match the chain. ${reason}`)))),
  ];
  if (!usersRead) items.push(el("li", { class: "unknown" }, icon("info"), el("div", {}, el("b", {}, "Couldn't read the list of named people just now."))));
  named.hidden = items.length === 0;
  namedList.replaceChildren(...items);
}

let seq = 0;
async function run() {
  const my = ++seq;
  again.disabled = true;
  timeEl.textContent = "Reading…";
  let data;
  try {
    data = await loadProof({ statusFor: (recipient) => agentStatus({ recipient }) });
  } catch {
    if (my !== seq) return;
    for (const k of Object.keys(T)) T[k].textContent = "—";
    timeEl.textContent = "Offline";
    body.replaceChildren(el("div", { class: "pf-empty" }, icon("alert"),
      el("p", {}, el("b", {}, "Couldn't read the agent's payouts from Celo just now."), el("span", {}, "Nothing is shown rather than a guess. Try again in a minute."))));
    again.disabled = false;
    return;
  }
  if (my !== seq) return;
  const model = proofModel({ payouts: data.payouts, deposits: data.deposits, events: data.events, users: data.users ?? [] });
  totals(model.totals);
  timeEl.textContent = `Read at ${lagosClock(Date.now())} WAT`;
  note.textContent = (data.checked ? `Checked the agent's ${data.complete ? "" : "latest "}${data.checked} transaction${data.checked === 1 ? "" : "s"} on Celo.` : "The agent hasn't sent any transactions yet.")
    + (data.depositsCapped ? " Some deposits may be missing (too many events for one read)." : "")
    + " Each receipt number is taken from its own transaction, so anyone can rebuild it.";
  if (!model.rows.length) {
    body.replaceChildren(el("div", { class: "pf-empty" }, icon("receipt"),
      el("p", {}, el("b", {}, "No real payouts yet."), el("span", {}, "The first one will appear here with its transactions."))));
  } else {
    body.replaceChildren(
      el("div", { class: "pf-head", "aria-hidden": "true" }, ["When", "Corridor", "In → out", "Receipt", "Transactions", "Attribution"].map((h) => el("span", {}, h))),
      el("ul", { class: "pf-rows" }, model.rows.map((r) => row(r, data.deposits != null))));
  }
  renderNamed(model.users, data.users != null);
  again.disabled = false;
}
again.addEventListener("click", run);
run();
