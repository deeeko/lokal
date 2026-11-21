import { AGENT, EXPLORER_API, TOKENS, CURRENCIES, formatCurrency, getJson, celoscanTx, celoscanAddr, lagosTime, lagosClock, short, num2, el, badge, icon, $, initChrome } from "../assets/core.js";
import { getSession } from "../assets/session.js";

initChrome();

// No one's wallet address is printed on this public page: a deposit shows "A payer" (or "You" for the signed-in
// wallet) and a payout shows only its amount. Each row still links its own transaction, and the timings stay, so
// anyone can see autopilot working without the page listing other people's wallets.
const isMe = (a) => { const s = getSession(); return Boolean(s && a && s.address.toLowerCase() === String(a).toLowerCase()); };

// The board is rebuilt from public ERC-20 transfers only. Payment requests live in the owner's
// requests.json, which this page never sees, so a deposit is paired with the agent's next
// outgoing transfer of the other token (its likely payout), not with a request.

const COLS = ["Deposit", "From", "Received (WAT)", "Status", "Payout", "Time to payout", "Receipt"];
const HASH_RE = /^0x[0-9a-f]{64}$/i;
const ADDR_RE = /^0x[0-9a-f]{40}$/i;
const MAX_PAGES = 4; // per direction, 50 transfers each
const WAIT_MS = 48 * 3600 * 1000; // default request lifetime (request --hours 48)
const POLL_MS = 30_000;
const agentLc = AGENT.toLowerCase();
// USD₮, cNGN, IDRX, wARS, wCOP: what the agent receives and pays out
const TOKEN_BY_ADDR = Object.fromEntries(Object.entries(TOKENS).map(([k, t]) => [t.address.toLowerCase(), k]));
/** Deposits pay out in the other kind: USD₮ in -> any local currency out (the memo or link chose it), cNGN in -> USD₮ out. */
const pairs = (dep, out) => (dep === "USDT" ? out !== "USDT" : dep === "cNGN" ? out === "USDT" : false);

const state = { loading: false, failed: false, loaded: false, rows: [], truncated: false, sig: "", gen: 0, updatedAt: null };

const tbody = $("#rows");
const refreshBtn = $("#refresh");
const updated = $("#updated");

// ---------- data ----------
async function loadTransfers(filter) {
  const out = [];
  let next = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const qs = new URLSearchParams({ type: "ERC-20", filter, ...(next ?? {}) });
    const d = await getJson(`${EXPLORER_API}/addresses/${AGENT}/token-transfers?${qs}`);
    if (!Array.isArray(d.items)) throw new Error("unexpected explorer response");
    out.push(...d.items);
    next = d.next_page_params ?? null;
    if (!next) return { items: out, more: false };
  }
  return { items: out, more: true };
}

/** Normalise a Blockscout token transfer; null if it isn't one of the agent's tokens or is malformed. */
function norm(t) {
  const key = TOKEN_BY_ADDR[String(t?.token?.address_hash ?? t?.token?.address ?? "").toLowerCase()];
  if (!key) return null;
  const hash = String(t.transaction_hash ?? "");
  const time = Date.parse(t.timestamp);
  if (!HASH_RE.test(hash) || !Number.isFinite(time)) return null;
  const dec = Number(t.total?.decimals ?? t.token?.decimals ?? 6);
  let amount;
  try { amount = Number(BigInt(String(t.total?.value ?? "0"))) / 10 ** (Number.isFinite(dec) ? dec : 6); } catch { return null; }
  const from = String(t.from?.hash ?? "");
  const to = String(t.to?.hash ?? "");
  return { key, symbol: TOKENS[key].symbol, hash, time, amount, from: ADDR_RE.test(from) ? from : "", to: ADDR_RE.test(to) ? to : "", logIndex: Number(t.log_index ?? 0) };
}

function build(inRaw, outRaw) {
  const ins = inRaw.map(norm).filter((t) => t && t.to.toLowerCase() === agentLc && t.from.toLowerCase() !== agentLc);
  const outs = outRaw.map(norm).filter((t) => t && t.from.toLowerCase() === agentLc && t.to.toLowerCase() !== agentLc);
  // A transaction that moves tokens both into and out of the agent is a conversion on Textile, not a deposit or payout.
  const inHashes = new Set(ins.map((t) => t.hash.toLowerCase()));
  const outHashes = new Set(outs.map((t) => t.hash.toLowerCase()));
  const deposits = ins.filter((t) => !outHashes.has(t.hash.toLowerCase())).sort((a, b) => a.time - b.time || a.logIndex - b.logIndex);
  const payouts = outs.filter((t) => !inHashes.has(t.hash.toLowerCase())).sort((a, b) => a.time - b.time || a.logIndex - b.logIndex);

  const used = new Set();
  const now = Date.now();
  const rows = deposits.map((d) => {
    // The CLI adds a cents suffix to every payment-link amount; a whole amount is most likely the owner
    // topping up, so it gets no payment status and isn't paired with a payout.
    if (Math.round(d.amount * 100) % 100 === 0) return { d, p: null, status: "topup" };
    const p = payouts.find((x) => !used.has(x) && pairs(d.key, x.key) && x.time >= d.time && x.hash.toLowerCase() !== d.hash.toLowerCase());
    if (p) used.add(p);
    const status = p ? "paid" : now - d.time < WAIT_MS ? "waiting" : "unmatched";
    return { d, p: p ?? null, status };
  });
  return { rows: rows.reverse(), lastTime: Math.max(0, ...deposits.map((t) => t.time), ...payouts.map((t) => t.time)) || null };
}

// ---------- formatting ----------
const amountText = (t) => {
  const c = CURRENCIES.find((x) => x.token === t.symbol);
  return c ? `${formatCurrency(t.amount, c.code, c.code === "cngn" ? 2 : c.places)} ${t.symbol}` : `${num2.format(t.amount)} ${t.symbol}`;
};
function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}
function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ---------- rendering ----------
const cell = (label, cls, ...kids) => el("td", { "data-label": label, class: cls }, ...kids);
const dash = () => el("span", { class: "muted" }, "—");
const txLink = (hash, text) => el("a", { class: "mono", href: celoscanTx(hash), target: "_blank", rel: "noopener", title: hash, "aria-label": `Open transaction ${short(hash)} on Celoscan` }, text);

function skeletonRows(n = 4) {
  const widths = [110, 90, 100, 80, 110, 60, 70];
  return Array.from({ length: n }, () =>
    el("tr", { "aria-hidden": "true" }, COLS.map((c, i) => cell(c, i === 0 ? "lead-cell" : null, el("span", { class: "skel", style: `width:${widths[i]}px` })))));
}
const emptyRow = (...kids) => el("tr", { class: "empty" }, el("td", { colspan: String(COLS.length) }, ...kids));

const STATUS = {
  paid: ["Paid out", "ok"],
  waiting: ["Received", "warn"],
  unmatched: ["Not matched yet", "neutral"],
  topup: ["Likely a top-up", "neutral"],
};

function row({ d, p, status }) {
  const [text, kind] = STATUS[status];
  return el("tr", {},
    cell("Deposit", "lead-cell", el("span", { class: "board-pay" },
      el("span", { class: "strong num" }, amountText(d)),
      txLink(d.hash, short(d.hash)))),
    cell("From", null, d.from ? el("span", { class: isMe(d.from) ? "strong" : "soft" }, isMe(d.from) ? "You" : "A payer") : dash()),
    cell("Received (WAT)", "num", lagosTime(d.time)),
    cell("Status", null, badge(text, kind)),
    cell("Payout", null, p
      ? el("span", { class: "board-pay" }, el("span", { class: "strong num" }, amountText(p)), el("span", { class: "small muted" }, isMe(p.to) ? "to you" : "to the recipient"))
      : dash()),
    cell("Time to payout", "num", p ? duration(p.time - d.time) : dash()),
    cell("Receipt", null, p
      ? el("a", { class: "link", href: `receipt.html#p=${p.hash}` }, "View receipt")
      : dash()),
  );
}

function setStat(id, value, sub) {
  $(id).textContent = value;
  if (sub != null) $(`${id}-sub`).textContent = sub;
}

function render(lastTime) {
  $("#board").setAttribute("aria-busy", String(state.loading));
  refreshBtn.disabled = state.loading;

  if (state.loading && !state.loaded) {
    tbody.replaceChildren(...skeletonRows());
    updated.textContent = "Loading deposits…";
    return;
  }
  if (state.failed && !state.loaded) {
    for (const id of ["#s-deposits", "#s-paid", "#s-median", "#s-last"]) $(id).textContent = "—";
    const retry = el("button", { class: "btn btn-ghost btn-sm", type: "button" }, "Try again");
    retry.addEventListener("click", () => reload(true));
    tbody.replaceChildren(emptyRow(
      el("span", { class: "row", style: "justify-content:center" }, icon("alert"), "Could not load transfers from Blockscout."),
      el("div", { class: "mt-8" },
        el("a", { class: "link", href: `${celoscanAddr(AGENT)}#tokentxns`, target: "_blank", rel: "noopener" }, "Check the agent's token transfers on Celoscan"),
        " or ", retry)));
    updated.textContent = "Not loaded";
    return;
  }

  const rows = state.rows;
  const paid = rows.filter((r) => r.status === "paid");
  const payable = rows.filter((r) => r.status !== "topup");
  const med = median(paid.map((r) => r.p.time - r.d.time));
  const plus = state.truncated ? "+" : "";
  setStat("#s-deposits", `${rows.length}${plus}`, state.truncated ? "Most recent transfers only" : "USD₮ and cNGN sent to the agent");
  setStat("#s-paid", payable.length ? `${paid.length} / ${payable.length}` : "0",
    payable.length ? "Transfers with cents followed by a payout" : "No payout yet");
  $("#s-median").textContent = med == null ? "—" : duration(med);
  $("#s-last").textContent = lastTime ? lagosTime(lastTime) : "—";

  if (!rows.length) {
    tbody.replaceChildren(emptyRow(
      "No incoming transfers yet. When someone pays a payment link, the deposit and the agent's payout appear here.",
      el("div", { class: "mt-8 small" }, el("a", { class: "link", href: "pay.html" }, "How payment links work"))));
  } else {
    tbody.replaceChildren(...rows.map(row));
  }
  if (state.failed) updated.textContent = `Couldn't refresh. Showing data from ${lagosClock(state.updatedAt)} WAT.`;
  else updated.textContent = `Updated ${lagosClock(state.updatedAt)} WAT · refreshes every 30 s`;
}

let lastTimeCache = null;
async function reload(user = false) {
  if (state.loading) return;
  const gen = ++state.gen;
  state.loading = true;
  if (user && !state.loaded) state.failed = false;
  if (!state.loaded) render();
  else { refreshBtn.disabled = true; $("#board").setAttribute("aria-busy", "true"); }
  try {
    const [ins, outs] = await Promise.all([loadTransfers("to"), loadTransfers("from")]);
    if (gen !== state.gen) return;
    const { rows, lastTime } = build(ins.items, outs.items);
    const sig = rows.map((r) => `${r.d.hash}:${r.d.logIndex}:${r.status}:${r.p?.hash ?? ""}`).join("|");
    const changed = sig !== state.sig || !state.loaded || state.failed;
    Object.assign(state, { rows, truncated: ins.more, sig, loaded: true, failed: false, updatedAt: Date.now() });
    lastTimeCache = lastTime;
    state.loading = false;
    if (changed) render(lastTimeCache);
    else {
      refreshBtn.disabled = false;
      $("#board").setAttribute("aria-busy", "false");
      updated.textContent = `Updated ${lagosClock(state.updatedAt)} WAT · refreshes every 30 s`;
    }
  } catch {
    if (gen !== state.gen) return;
    state.loading = false;
    state.failed = true;
    render(lastTimeCache);
  }
}

refreshBtn.addEventListener("click", () => reload(true));
setInterval(() => { if (document.visibilityState === "visible") reload(); }, POLL_MS);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && state.updatedAt && Date.now() - state.updatedAt > POLL_MS) reload(); });

reload();
