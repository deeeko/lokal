// Activity: the signed-in wallet's own payments with LokalPay ("Yours"), and nothing else. Visitors who are not signed in
// see a sign-in prompt instead: the agent's full feed and other people's addresses are not shown here. (Every payout
// still has a public receipt on receipt.html, and the chain itself is public on Celoscan.)
import { receiptNo, celoscanTx, lagosTime, short, el, badge, icon, toast, download, $, initChrome } from "../assets/core.js";
import { getSession, onSessionChange, watchSession } from "../assets/session.js";
import { sharedActivity } from "../assets/my-activity.js";
import { activityVisible } from "../assets/front-door.js";

initChrome();

const COLS = ["Activity", "Status", "Attribution tag", "Time (WAT)", "Transaction", "Receipt"];
const HASH_RE = /^0x[0-9a-f]{64}$/i;
const mine = { address: null, rows: null, more: false, loading: false, failed: false, gen: 0, query: "" };

const gate = $("#gate");
const card = $("#tx-card");
const tbody = $("#rows");
const count = $("#count");
const exportBtn = $("#export");
const refreshBtn = $("#refresh");
const sameAddr = (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
const cell = (label, cls, ...kids) => el("td", { "data-label": label, class: cls }, ...kids);
const emptyRow = (...kids) => el("tr", { class: "empty" }, el("td", { colspan: String(COLS.length) }, ...kids));
const skeletonRows = (n = 3) => Array.from({ length: n }, () =>
  el("tr", { "aria-hidden": "true" }, COLS.map((c, i) => cell(c, i === 0 ? "lead-cell" : null, el("span", { class: "skel", style: `width:${[150, 70, 70, 110, 120, 110][i]}px` })))));

function row(r) {
  const valid = HASH_RE.test(r.hash);
  const no = r.kind === "payout" && valid ? receiptNo(r.hash) : null;
  return el("tr", {},
    cell("Activity", "lead-cell", el("span", { class: "strong" }, r.label), r.sub ? el("span", { class: "micro muted", style: "display:block" }, r.sub) : null),
    cell("Status", null, badge(...r.status)),
    cell("Attribution tag", null, r.tagged == null ? el("span", { class: "muted" }, "—") : r.tagged ? badge("Tagged", "ok") : badge("Missing", "warn")),
    cell("Time (WAT)", "num", r.time ? lagosTime(r.time) : "—"),
    cell("Transaction", null, valid
      ? el("span", { class: "tx-hash" },
          el("a", { class: "mono", href: celoscanTx(r.hash), target: "_blank", rel: "noopener", title: r.hash, "aria-label": `Open transaction ${short(r.hash)} on Celoscan` }, short(r.hash)),
          el("button", { class: "icon-btn sm", type: "button", "aria-label": "Copy transaction hash", dataset: { copy: r.hash, copyLabel: "Transaction hash copied" } }, icon("copy")))
      : el("span", { class: "muted" }, "—")),
    cell("Receipt", null, no
      ? el("a", { class: "btn btn-secondary btn-sm receipt-btn", href: `receipt.html#${no}`, "aria-label": `Open receipt ${no}` }, icon("doc"), el("span", { class: "mono" }, no))
      : r.link ? el("a", { class: "link small", href: r.link }, "Open link ", icon("right")) : el("span", { class: "muted" }, "—")),
  );
}

function visible() {
  const q = mine.query.trim().toLowerCase();
  return (mine.rows ?? []).filter((r) => !q || r.hash.toLowerCase().includes(q) || (HASH_RE.test(r.hash) && receiptNo(r.hash).toLowerCase().includes(q)));
}

function render() {
  if (mine.failed && !mine.rows) {
    const retry = el("button", { class: "btn btn-ghost btn-sm", type: "button" }, "Try again");
    retry.addEventListener("click", () => load(true));
    tbody.replaceChildren(emptyRow(el("span", { class: "row", style: "justify-content:center" }, icon("alert"), "Couldn't load your payments from Blockscout."), el("div", { class: "mt-8" }, retry)));
  } else if (!mine.rows) {
    tbody.replaceChildren(...skeletonRows());
  } else {
    const list = visible();
    tbody.replaceChildren(...(list.length ? list.map(row) : [emptyRow(mine.query.trim()
      ? "None of your payments matches that hash or receipt number."
      : el("span", {}, "No payments between your wallet and LokalPay yet. ", el("a", { class: "link", href: "quote.html" }, "Send money"), " or ", el("a", { class: "link", href: "start.html" }, "claim your LokalPay tag"), "."))]));
  }
  const n = visible().length, all = mine.rows?.length ?? 0;
  count.textContent = !mine.rows ? (mine.failed ? "Showing 0" : "Loading your activity…")
    : `${n === all ? `Showing ${n}` : `Showing ${n} of ${all}`} for ${short(mine.address)}${mine.more ? " (latest only)" : ""}`;
  exportBtn.disabled = !mine.rows?.length;
  refreshBtn.disabled = mine.loading;
  card.setAttribute("aria-busy", String(mine.loading));
}

async function load(force = false) {
  const s = getSession();
  if (!s) return;
  if (!force && mine.rows && sameAddr(mine.address, s.address)) return render();
  const gen = ++mine.gen;
  Object.assign(mine, { address: s.address, rows: null, more: false, loading: true, failed: false });
  render();
  try {
    const { rows, more } = await sharedActivity(s.address, { force });
    if (gen !== mine.gen) return;
    Object.assign(mine, { rows, more });
  } catch {
    if (gen !== mine.gen) return;
    mine.failed = true;
  }
  mine.loading = false;
  render();
}

/** Visitors see the sign-in prompt; a signed-in wallet sees its own payments only. */
function sync(session) {
  const show = activityVisible(session);
  gate.hidden = show;
  card.hidden = !show;
  if (!show) { mine.gen++; Object.assign(mine, { address: null, rows: null, loading: false, failed: false }); tbody.replaceChildren(); return; }
  load();
}

const csvCell = (v) => { const s = String(v ?? ""); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
exportBtn.addEventListener("click", () => {
  if (!mine.rows?.length) return;
  const header = ["hash", "receipt_no", "activity", "status", "time_utc", "celoscan_url"];
  const lines = mine.rows.map((r) => [r.hash, r.kind === "payout" ? receiptNo(r.hash) : "", r.label, r.status[0],
    r.time ? new Date(r.time).toISOString() : "", celoscanTx(r.hash)].map(csvCell).join(","));
  download("lokal-my-activity.csv", [header.join(","), ...lines].join("\r\n") + "\r\n");
  toast(`Exported ${mine.rows.length} payments`);
});
$("#q").addEventListener("input", (e) => { mine.query = e.target.value; render(); });
refreshBtn.addEventListener("click", () => load(true));

onSessionChange(sync);
watchSession();
sync(getSession());
