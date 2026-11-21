import {
  AGENT, TOKENS, EXPLORER_API, loadTxPage, receiptNo, celoscanTx, celoscanAddr, lagosTime, short, isTagged, txKind, txLabel, txStatus,
  el, badge, icon, toast, download, $, $$, initChrome, getJson, num2, naira, decodeNtagOp, decodeNtagMemo, decodeRegistration, CORRIDORS,
} from "../assets/core.js";
import { getSession, onSessionChange } from "../assets/session.js";

initChrome();

const COLS = ["Activity", "Status", "Attribution tag", "Time (WAT)", "Transaction", "Receipt"];
const HASH_RE = /^0x[0-9a-f]{64}$/i;
const EMPTY = {
  all: "No transactions from the agent wallet yet.",
  payout: "No payouts yet.",
  convert: "No conversions yet.",
  approve: "No approvals yet.",
  identity: "No identity transactions yet.",
  mine: "No payments between your wallet and the agent yet.",
};
const NAMES = { all: "transactions", payout: "payouts", convert: "conversions", approve: "approvals", identity: "identity transactions", mine: "of your payments" };

const state = { rows: [], next: null, filter: "all", query: "", loading: false, failed: false, gen: 0 };
/** "Yours": the signed-in wallet's own payments with the agent. rows = null until loaded. */
const mine = { address: null, rows: null, more: false, loading: false, failed: false, gen: 0 };

const tbody = $("#rows");
const moreBtn = $("#more");
const moreErr = $("#more-err");
const count = $("#count");
const exportBtn = $("#export");
const refreshBtn = $("#refresh");

// ---------- rendering ----------
const cell = (label, cls, ...kids) => el("td", { "data-label": label, class: cls }, ...kids);

function skeletonRows(n = 6) {
  const widths = [150, 70, 70, 110, 120, 110];
  return Array.from({ length: n }, () =>
    el("tr", { "aria-hidden": "true" }, COLS.map((c, i) => cell(c, i === 0 ? "lead-cell" : null, el("span", { class: "skel", style: `width:${widths[i]}px` })))),
  );
}

function emptyRow(...kids) {
  return el("tr", { class: "empty" }, el("td", { colspan: String(COLS.length) }, ...kids));
}

function row(tx) {
  const [statusText, statusKind] = txStatus(tx);
  const tagged = isTagged(tx);
  const hash = String(tx.hash ?? "");
  const valid = HASH_RE.test(hash);
  const time = tx.timestamp ? lagosTime(tx.timestamp) : "—";
  const hashCell = valid
    ? el("span", { class: "tx-hash" },
        el("a", { class: "mono", href: celoscanTx(hash), target: "_blank", rel: "noopener", title: hash, "aria-label": `Open transaction ${short(hash)} on Celoscan` }, short(hash)),
        el("button", { class: "icon-btn sm", type: "button", "aria-label": "Copy transaction hash", dataset: { copy: hash, copyLabel: "Transaction hash copied" } }, icon("copy")))
    : el("span", { class: "muted" }, "—");
  const no = valid ? receiptNo(hash) : "";
  const receiptCell = valid
    ? el("a", { class: "btn btn-secondary btn-sm receipt-btn", href: `receipt.html#${no}`, "aria-label": `Open receipt ${no}` },
        icon("doc"), el("span", { class: "mono" }, no))
    : el("span", { class: "muted" }, "—");
  return el("tr", {},
    cell("Activity", "lead-cell", el("span", { class: "strong" }, txLabel(tx))),
    cell("Status", null, badge(statusText, statusKind)),
    cell("Attribution tag", null, tagged ? badge("Tagged", "ok") : badge("Missing", "warn")),
    cell("Time (WAT)", "num", time),
    cell("Transaction", null, hashCell),
    cell("Receipt", null, receiptCell),
  );
}

const sameAddr = (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
const fmtToken = (sym, v) => (sym === "cNGN" ? naira(v) + " cNGN" : num2.format(v) + " " + sym);

function mineRow(r) {
  const valid = HASH_RE.test(r.hash);
  // payouts are the agent's own transactions: their tag is known when the agent-wide list has loaded them
  const agentTx = r.tagged == null ? state.rows.find((t) => sameAddr(t.hash, r.hash)) : null;
  const tagged = r.tagged ?? (agentTx ? isTagged(agentTx) : null);
  const no = r.kind === "payout" && valid ? receiptNo(r.hash) : null;
  return el("tr", {},
    cell("Activity", "lead-cell", el("span", { class: "strong" }, r.label), r.sub ? el("span", { class: "micro muted", style: "display:block" }, r.sub) : null),
    cell("Status", null, badge(...r.status)),
    cell("Attribution tag", null, tagged == null ? el("span", { class: "muted" }, "—") : tagged ? badge("Tagged", "ok") : badge("Missing", "warn")),
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

function visibleMine() {
  const q = state.query.trim().toLowerCase();
  return (mine.rows ?? []).filter((r) => !q || r.hash.toLowerCase().includes(q) || (HASH_RE.test(r.hash) && receiptNo(r.hash).toLowerCase().includes(q)));
}

function renderMine() {
  if (mine.failed && !mine.rows) {
    const retry = el("button", { class: "btn btn-ghost btn-sm", type: "button" }, "Try again");
    retry.addEventListener("click", () => loadMine(true));
    tbody.replaceChildren(emptyRow(el("span", { class: "row", style: "justify-content:center" }, icon("alert"), "Could not load your payments from Blockscout."), el("div", { class: "mt-8" }, retry)));
    return;
  }
  if (!mine.rows) { tbody.replaceChildren(...skeletonRows(3)); return; }
  const list = visibleMine();
  if (!list.length) {
    tbody.replaceChildren(emptyRow(state.query.trim() ? "None of your payments matches that hash or receipt number." : EMPTY.mine));
    return;
  }
  tbody.replaceChildren(...list.map(mineRow));
}

function visibleRows() {
  const q = state.query.trim().toLowerCase();
  return state.rows.filter((tx) => {
    if (state.filter !== "all" && txKind(tx) !== state.filter) return false;
    if (!q) return true;
    const hash = String(tx.hash ?? "");
    return hash.toLowerCase().includes(q) || (HASH_RE.test(hash) && receiptNo(hash).toLowerCase().includes(q));
  });
}

function renderTable() {
  if (state.filter === "mine") return renderMine();
  if (state.failed && !state.rows.length) {
    tbody.replaceChildren(emptyRow(
      el("span", { class: "row", style: "justify-content:center" }, icon("alert"), "Could not load transactions from Blockscout."),
      el("div", { class: "mt-8" },
        el("a", { class: "link", href: celoscanAddr(AGENT), target: "_blank", rel: "noopener" }, "View the agent wallet on Celoscan"),
        " or ",
        el("button", { class: "btn btn-ghost btn-sm", type: "button", id: "retry" }, "Try again")),
    ));
    $("#retry")?.addEventListener("click", () => reload());
    return;
  }
  if (state.loading && !state.rows.length) { tbody.replaceChildren(...skeletonRows()); return; }

  const list = visibleRows();
  if (!list.length) {
    let msg;
    if (state.query.trim()) msg = "No loaded transaction matches that hash or receipt number.";
    else if (state.next) msg = `No ${NAMES[state.filter]} in the loaded transactions.`;
    else msg = EMPTY[state.filter];
    const hint = state.next ? el("div", { class: "mt-8 small" }, "Load more to include older transactions.") : null;
    tbody.replaceChildren(emptyRow(msg, hint));
    return;
  }
  tbody.replaceChildren(...list.map(row));
}

function renderStats() {
  const set = (id, text) => { $(id).textContent = text; };
  if (state.failed && !state.rows.length) {
    for (const id of ["#s-loaded", "#s-tagged", "#s-payouts", "#s-last"]) set(id, "—");
    set("#s-tagged-sub", "ERC-8021 attribution in calldata");
    return;
  }
  if (state.loading && !state.rows.length) return;

  const n = state.rows.length;
  const tagged = state.rows.filter(isTagged).length;
  const payouts = state.rows.filter((t) => txKind(t) === "payout").length;
  const allLoaded = !state.next;

  set("#s-loaded", allLoaded ? String(n) : `${n}+`);
  set("#s-loaded-sub", allLoaded ? "Full history from the agent wallet" : "More available below");
  set("#s-tagged", n ? `${tagged} / ${n}` : "—");
  set("#s-tagged-sub", n ? `${Math.round((tagged / n) * 100)}% carry the ERC-8021 tag` : "ERC-8021 attribution in calldata");
  set("#s-payouts", String(payouts));
  if (!allLoaded) set("#s-payouts-sub", "in loaded transactions");
  else set("#s-payouts-sub", payouts === 0 ? "No payout yet" : "cNGN transfers to the recipient");
  const newest = state.rows.find((t) => t.timestamp);
  set("#s-last", newest ? lagosTime(newest.timestamp) : "—");

  // Only claim "registering its identity" when that is literally what every loaded transaction is.
  $("#no-payout").hidden = !(allLoaded && n > 0 && payouts === 0 && state.rows.every((t) => txKind(t) === "identity"));
}

function renderFooter() {
  const shown = visibleRows().length;
  if (state.filter === "mine") {
    const n = visibleMine().length, all = mine.rows?.length ?? 0;
    count.textContent = !mine.rows ? (mine.failed ? "Showing 0" : "Loading your payments…")
      : `${n === all ? `Showing ${n}` : `Showing ${n} of ${all}`} for ${short(mine.address)}${mine.more ? " (latest only)" : ""}`;
    moreBtn.hidden = true;
    exportBtn.disabled = !mine.rows?.length;
    refreshBtn.disabled = mine.loading;
    $("#tx-card").setAttribute("aria-busy", String(mine.loading));
    return;
  }
  if (state.loading && !state.rows.length) count.textContent = "Loading transactions…";
  else if (state.failed && !state.rows.length) count.textContent = "Showing 0";
  else count.textContent = shown === state.rows.length ? `Showing ${shown}` : `Showing ${shown} of ${state.rows.length} loaded`;

  moreBtn.hidden = !state.next;
  moreBtn.disabled = state.loading;
  moreBtn.textContent = state.loading && state.rows.length ? "Loading…" : "Load more";
  exportBtn.disabled = !state.rows.length;
  refreshBtn.disabled = state.loading;
  $("#tx-card").setAttribute("aria-busy", String(state.loading));
}

function render() { renderTable(); renderStats(); renderFooter(); }

// ---------- data ----------
const fetchPage = (next) => loadTxPage(next);

async function reload() {
  const gen = ++state.gen;
  Object.assign(state, { rows: [], next: null, loading: true, failed: false });
  moreErr.hidden = true;
  for (const id of ["#s-loaded", "#s-tagged", "#s-payouts", "#s-last"]) $(id).replaceChildren(el("span", { class: "skel lg" }));
  render();
  try {
    const page = await fetchPage(null);
    if (gen !== state.gen) return;
    state.rows = page.items;
    state.next = page.next;
  } catch {
    if (gen !== state.gen) return;
    state.failed = true;
  }
  state.loading = false;
  render();
}

async function loadMore() {
  if (!state.next || state.loading) return;
  const gen = state.gen;
  state.loading = true;
  moreErr.hidden = true;
  renderFooter();
  try {
    const page = await fetchPage(state.next);
    if (gen !== state.gen) return;
    const seen = new Set(state.rows.map((t) => t.hash));
    state.rows.push(...page.items.filter((t) => !seen.has(t.hash)));
    state.next = page.next;
  } catch {
    if (gen !== state.gen) return;
    moreErr.textContent = "Could not load older transactions. Try again.";
    moreErr.hidden = false;
  }
  state.loading = false;
  render();
}

/** Up to `max` pages of a Blockscout list. */
async function pages(url, max = 3) {
  const items = [];
  let next = null;
  for (let p = 0; p < max; p++) {
    const qs = new URLSearchParams(next ?? {});
    const d = await getJson(url + (url.includes("?") ? "&" : "?") + qs);
    if (!Array.isArray(d?.items)) throw new Error("unexpected explorer response");
    items.push(...d.items);
    next = d.next_page_params ?? null;
    if (!next) return { items, more: false };
  }
  return { items, more: true };
}
const tokenName = (t) => (sameAddr(t?.address_hash ?? t?.address, TOKENS.USDT.address) ? "USD₮" : sameAddr(t?.address_hash ?? t?.address, TOKENS.cNGN.address) ? "cNGN" : null);

/**
 * The wallet's payments with the agent: its token transfers to the agent (link and nTag payments), its nTag and
 * "Get paid" registrations (NT1 / NP1 transactions to the agent) and the agent's payouts to it. Newest first.
 */
async function loadMine(force = false) {
  const s = getSession();
  if (!s) return;
  if (!force && mine.rows && sameAddr(mine.address, s.address)) return render();
  const gen = ++mine.gen;
  Object.assign(mine, { address: s.address, rows: null, more: false, loading: true, failed: false });
  render();
  try {
    const [tt, txs] = await Promise.all([
      pages(`${EXPLORER_API}/addresses/${s.address}/token-transfers?type=ERC-20`),
      pages(`${EXPLORER_API}/addresses/${s.address}/transactions?filter=from`),
    ]);
    if (gen !== mine.gen) return;
    const own = new Map(txs.items.map((t) => [String(t.hash).toLowerCase(), t]));
    const rows = [];
    for (const t of tt.items) {
      const sym = tokenName(t.token);
      const hash = String(t.transaction_hash ?? "");
      if (!sym || !HASH_RE.test(hash)) continue;
      const v = Number(t.total?.value ?? 0) / 10 ** Number(t.total?.decimals ?? 6);
      if (sameAddr(t.from?.hash, s.address) && sameAddr(t.to?.hash, AGENT)) {
        const tx = own.get(hash.toLowerCase());
        const tag = tx ? decodeNtagMemo(tx.raw_input) : null;
        rows.push({ hash, time: t.timestamp, kind: "sent", status: ["Success", "ok"], tagged: tx ? isTagged(tx) : null,
          label: tag ? `You paid @${tag} ${fmtToken(sym, v)}` : `You sent ${fmtToken(sym, v)} to the agent`,
          sub: tag ? "nTag payment" : "Payment link or direct payment" });
      } else if (sameAddr(t.from?.hash, AGENT) && sameAddr(t.to?.hash, s.address)) {
        rows.push({ hash, time: t.timestamp, kind: "payout", status: ["Success", "ok"], tagged: null,
          label: `The agent paid you ${fmtToken(sym, v)}`, sub: "Payout" });
      }
    }
    for (const t of txs.items) {
      if (!sameAddr(t.to?.hash, AGENT)) continue;
      const hash = String(t.hash ?? "");
      const op = decodeNtagOp(t.raw_input);
      const reg = op ? null : decodeRegistration(t.raw_input);
      if (!op && !reg) continue;
      const label = op
        ? (op.t === "" ? "You released your nTag" : `You claimed @${op.t}${op.n ? ` (${op.n})` : ""}`)
        : `You made a payment link for ${reg.a} ${CORRIDORS[reg.d]?.sell === "cNGN" ? "cNGN" : "USD₮"}`;
      rows.push({ hash, time: t.timestamp, kind: op ? "ntag" : "link", status: txStatus(t), tagged: isTagged(t),
        label, sub: op ? "nTag" : "Get paid", link: reg && t.status === "ok" ? `pay.html#tx=${hash}` : null });
    }
    rows.sort((a, b) => Date.parse(b.time ?? 0) - Date.parse(a.time ?? 0));
    Object.assign(mine, { rows, more: tt.more || txs.more });
  } catch {
    if (gen !== mine.gen) return;
    mine.failed = true;
  }
  mine.loading = false;
  render();
}

function syncMineButton(session) {
  const b = $("#filter-mine");
  b.hidden = !session;
  if (!session && state.filter === "mine") setFilter("all");
  else if (session && state.filter === "mine" && !sameAddr(session.address, mine.address)) loadMine();
}

// ---------- CSV ----------
const csvCell = (v) => {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function exportCsv() {
  if (state.filter === "mine") return exportMine();
  if (!state.rows.length) return;
  const header = ["hash", "receipt_no", "activity", "status", "tagged", "time_utc", "celoscan_url"];
  const lines = state.rows.map((tx) => {
    const hash = String(tx.hash ?? "");
    const t = tx.timestamp ? new Date(tx.timestamp) : null;
    return [
      hash,
      HASH_RE.test(hash) ? receiptNo(hash) : "",
      txLabel(tx),
      txStatus(tx)[0],
      isTagged(tx) ? "yes" : "no",
      t && !isNaN(t) ? t.toISOString() : "",
      HASH_RE.test(hash) ? celoscanTx(hash) : "",
    ].map(csvCell).join(",");
  });
  download("lokal-transactions.csv", [header.join(","), ...lines].join("\r\n") + "\r\n");
  toast(`Exported ${state.rows.length} transactions`);
}

function exportMine() {
  if (!mine.rows?.length) return;
  const header = ["hash", "receipt_no", "activity", "status", "time_utc", "celoscan_url"];
  const lines = mine.rows.map((r) => [r.hash, r.kind === "payout" ? receiptNo(r.hash) : "", r.label, r.status[0],
    r.time ? new Date(r.time).toISOString() : "", celoscanTx(r.hash)].map(csvCell).join(","));
  download("lokal-my-payments.csv", [header.join(","), ...lines].join("\r\n") + "\r\n");
  toast(`Exported ${mine.rows.length} payments`);
}

// ---------- controls ----------
function setFilter(kind) {
  state.filter = kind;
  for (const o of $$("#filter button")) o.setAttribute("aria-pressed", String(o.dataset.kind === kind));
  if (kind === "mine") loadMine();
  renderTable(); renderFooter();
}
for (const b of $$("#filter button")) b.addEventListener("click", () => setFilter(b.dataset.kind));
syncMineButton(getSession());
onSessionChange(syncMineButton);
$("#q").addEventListener("input", (e) => { state.query = e.target.value; renderTable(); renderFooter(); });
refreshBtn.addEventListener("click", () => (state.filter === "mine" ? loadMine(true) : reload()));
moreBtn.addEventListener("click", () => loadMore());
exportBtn.addEventListener("click", exportCsv);

reload();
