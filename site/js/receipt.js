import {
  AGENT, AGENT_ID, TAG, TOKENS, CORRIDORS, REPUTATION, SEL, EXPLORER_API,
  $, el, badge, icon, naira, usd, num2, short, lagos, lagosTime, celoscanTx, celoscanAddr,
  rpc, getJson, loadTxByHash, loadReceipt, decodeTransfers, decodeTag, loadTxPage, loadRegistrations,
  txKind, txLabel, txStatus, receiptNo, parseReceiptNo,
  tokenSymbol, tokenUnits, encodeCall, CURRENCIES, currencyOfCorridor, formatCurrency, tagSuffix, loadIdentity, copyText, toast, initChrome, isNetworkError,
} from "../assets/core.js";
import { disconnectWallet, markWalletConnected, DISCONNECT_NOTE_FULL, DISCONNECT_NOTE_PARTIAL, toast as toastMsg } from "../assets/core.js";

initChrome();

// Receipt links point at the published site, so shares, QR codes and onchain feedback always carry the
// public URL, even when this page is opened from a local copy.
// The receipt URL on whichever site is open (Vercel or the GitHub Pages mirror), so the QR always works.
const SITE_RECEIPT = new URL("receipt.html", location.href).href;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const REQ_RE = /^r_[a-z0-9]{6,16}$/;
const CELO_CHAIN = "0xa4ec";
const MAX_SCAN_PAGES = 40; // 50 transactions per page
const eq = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const knownToken = (a) => tokenSymbol(a) !== "token";
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const receiptUrl = (no) => `${SITE_RECEIPT}#${no}`;
const fullTime = (ms) => lagos(ms, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) + " WAT";
const celoFmt = new Intl.NumberFormat("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 6 });

const area = $("#slip-area");
const rateCard = $("#rate");
const rateBody = $("#rate-body");
const headEyebrow = $("#head-eyebrow");
const headTitle = $("#head-title");
const headLead = $("#head-lead");
let seq = 0;

// ---------- small builders ----------
const extA = (cls, href, ...kids) => el("a", { class: cls, href, target: "_blank", rel: "noopener" }, ...kids);
const addrLink = (a) => el("a", { class: "link mono", href: celoscanAddr(a), target: "_blank", rel: "noopener", title: a }, short(a), " ", icon("ext"));
const txLink = (h) => el("a", { class: "link mono", href: celoscanTx(h), target: "_blank", rel: "noopener", title: h }, short(h), " ", icon("ext"));
const kv = (label, ...value) => el("li", {}, el("span", {}, label), el("span", {}, ...value));
const alertBox = (kind, iconName, ...content) => el("div", { class: `alert${kind ? " " + kind : ""}` }, icon(iconName), el("div", {}, ...content));
const btnLink = (cls, href, text, ext) => el("a", { class: `btn ${cls} btn-sm`, href, ...(ext ? { target: "_blank", rel: "noopener" } : {}) }, text, ext ? icon("ext") : null);
const dash = () => el("span", { class: "muted" }, "—");
const isTaggedInput = (input) => !!decodeTag(input)?.codes?.includes(TAG);
function tagBadge(hash, input) {
  const tagged = isTaggedInput(input);
  return el("a", { href: `verify.html?tx=${hash}`, title: tagged ? "Carries the agent's attribution tag. Open the check." : "No agent attribution tag. Open the check." },
    badge(tagged ? "Tagged" : "No tag", tagged ? "ok" : "warn"));
}
function setHead(eyebrow, before, accent, lead) {
  headEyebrow.textContent = eyebrow;
  headTitle.replaceChildren(before, el("em", {}, accent));
  headLead.textContent = lead;
}
function card(id, title, ...content) {
  return el("section", { class: "card", ...(id ? { id } : {}), "aria-labelledby": `${id || "c"}-h` },
    el("div", { class: "card-h" }, el("h2", { id: `${id || "c"}-h` }, title)),
    el("div", { class: "card-b" }, ...content));
}
function show(...nodes) { area.replaceChildren(...nodes); }

// ---------- routing ----------
/** What the URL asks for: { kind: "none" } | { kind: "np", no, prefix } | { kind: "hash", hash, s, r, badS, via } | { kind: "bad", raw } */
function readRoute() {
  let raw = location.hash.slice(1);
  try { raw = decodeURIComponent(raw); } catch { /* keep raw */ }
  raw = raw.trim();
  if (!raw) return { kind: "none" };
  const prefix = parseReceiptNo(raw);
  if (prefix) return { kind: "np", no: "NP-" + prefix.slice(2, 6).toUpperCase() + "-" + prefix.slice(6, 10).toUpperCase(), prefix };
  if (HASH_RE.test(raw)) return { kind: "hash", hash: raw.toLowerCase(), via: "tx" };
  const q = new URLSearchParams(raw);
  const h = q.get("p") ?? q.get("tx");
  if (h != null) {
    if (!HASH_RE.test(h)) return { kind: "bad", raw };
    const s = q.get("s"), r = q.get("r");
    return { kind: "hash", hash: h.toLowerCase(), via: q.has("p") ? "p" : "tx", s: s && HASH_RE.test(s) ? s : null, badS: !!s && !HASH_RE.test(s), r: r && REQ_RE.test(r) ? r : null };
  }
  return { kind: "bad", raw };
}
/** URL used for the agent's reputation feedback (kept in the long #p= form so older reviews and new ones match). */
function feedbackUrl({ hash, s, r }) {
  return `${SITE_RECEIPT}#p=${hash}${s ? `&s=${s}` : ""}${r ? `&r=${r}` : ""}`;
}

// ---------- states ----------
function showLoading(note) {
  const row = (label, w) => kv(label, el("span", { class: "skel", style: `width:${w}px` }));
  show(el("section", { class: "card", id: "slip", "aria-labelledby": "slip-h", "aria-busy": "true" },
    el("div", { class: "card-h" }, el("h2", { id: "slip-h" }, "Receipt"), el("span", { class: "skel", style: "width:84px" })),
    el("div", { class: "card-b" },
      el("div", { class: "receive" }, el("span", { class: "label" }, "Loading"), el("output", { class: "num" }, el("span", { class: "skel lg", style: "width:180px" }))),
      el("ul", { class: "kv-list mt-16" }, row("Receipt number", 110), row("Date and time", 130), row("From", 110), row("To", 110), row("Amount", 90), row("Transaction", 140)),
      note ? el("p", { class: "small muted mt-16" }, note) : null,
      el("span", { class: "sr-only" }, note || "Loading receipt…"))));
}

function problem(kind, title, message, { hash, retry } = {}) {
  const btns = [];
  if (retry) {
    const b = el("button", { class: "btn btn-secondary btn-sm", type: "button" }, icon("refresh"), "Try again");
    b.addEventListener("click", retry);
    btns.push(b);
  }
  if (hash) btns.push(btnLink("btn-secondary", celoscanTx(hash), "View on Celoscan", true));
  btns.push(btnLink("btn-ghost", "receipt.html", "Find another receipt"));
  show(card("slip", title, alertBox(kind, "alert", ...[].concat(message)), el("div", { class: "row mt-16" }, btns)));
}

// ---------- find a receipt (no hash) ----------
function showFind(badRaw) {
  setHead("Receipts", "Find a ", "receipt", "Every transaction the agent sends has a receipt. Look one up by its receipt number or transaction hash.");
  document.title = "Receipts · Lokal";
  const input = el("input", { class: "input mono", id: "find-q", type: "text", inputmode: "text", autocomplete: "off", spellcheck: "false", placeholder: "NP-7F3A-91C2 or 0x…", "aria-describedby": "find-hint" });
  const hint = el("p", { class: "hint", id: "find-hint", "aria-live": "polite" }, "A receipt number looks like NP-7F3A-91C2. A transaction hash starts with 0x and has 64 characters after it.");
  const form = el("form", { class: "stack", novalidate: true },
    el("div", { class: "field" },
      el("label", { class: "label", for: "find-q" }, "Receipt number or transaction hash"),
      el("div", { class: "find-form" }, input, el("button", { class: "btn btn-primary", type: "submit" }, icon("search"), "Find receipt")),
      hint));
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const v = input.value.trim();
    const prefix = parseReceiptNo(v);
    if (prefix) { location.hash = receiptNo(prefix + "0".repeat(56)); return; }
    if (HASH_RE.test(v)) { location.hash = "tx=" + v.toLowerCase(); return; }
    hint.classList.add("err");
    hint.textContent = v ? "That isn't a receipt number or a transaction hash. Check it and try again." : "Type a receipt number or a transaction hash first.";
    input.setAttribute("aria-invalid", "true");
    input.focus();
  });
  input.addEventListener("input", () => {
    if (!hint.classList.contains("err")) return;
    hint.classList.remove("err");
    input.removeAttribute("aria-invalid");
    hint.textContent = "A receipt number looks like NP-7F3A-91C2. A transaction hash starts with 0x and has 64 characters after it.";
  });

  const tbody = el("tbody", {});
  const more = el("button", { class: "btn btn-secondary btn-sm", type: "button", hidden: true }, "Load more");
  const listNote = el("p", { class: "small muted" }, "Newest first, read live from Blockscout.");
  const list = el("section", { class: "card", "aria-labelledby": "recent-h" },
    el("div", { class: "card-h" }, el("h2", { id: "recent-h" }, "The agent's transactions")),
    el("div", { class: "table-wrap" },
      el("table", { class: "table" },
        el("thead", {}, el("tr", {}, el("th", { scope: "col" }, "Transaction"), el("th", { scope: "col" }, "Time (WAT)"), el("th", { scope: "col" }, "Status"), el("th", { scope: "col" }, "Receipt"))),
        tbody)),
    el("div", { class: "card-f" }, listNote, more));

  show(
    card("find", "Find a receipt",
      badRaw ? alertBox("err", "alert", el("p", {}, "This receipt link is damaged, so there's nothing to show. Ask whoever sent it to share it again, or look the receipt up below.")) : null,
      badRaw ? el("div", { class: "mt-16" }) : null,
      form),
    list);

  let next = null;
  const skelRow = () => el("tr", { "aria-hidden": "true" },
    el("td", { class: "lead-cell", "data-label": "Transaction" }, el("span", { class: "skel", style: "width:160px" })),
    el("td", { "data-label": "Time (WAT)" }, el("span", { class: "skel", style: "width:90px" })),
    el("td", { "data-label": "Status" }, el("span", { class: "skel", style: "width:60px" })),
    el("td", { "data-label": "Receipt" }, el("span", { class: "skel", style: "width:110px" })));
  const row = (t) => {
    const [st, sk] = txStatus(t);
    const no = receiptNo(t.hash);
    return el("tr", {},
      el("td", { class: "lead-cell", "data-label": "Transaction" }, el("span", { class: "tx-name" }, el("span", { class: "strong" }, txLabel(t)), el("span", { class: "mono muted" }, short(t.hash)))),
      el("td", { class: "num", "data-label": "Time (WAT)" }, t.timestamp ? lagosTime(t.timestamp) : "—"),
      el("td", { "data-label": "Status" }, badge(st, sk)),
      el("td", { "data-label": "Receipt" }, el("a", { class: "btn btn-secondary btn-sm receipt-btn", href: `#${no}`, "aria-label": `Open receipt ${no}` }, el("span", { class: "mono" }, no), icon("right"))));
  };
  const loadPage = async (first) => {
    more.disabled = true;
    if (first) tbody.replaceChildren(skelRow(), skelRow());
    try {
      const page = await loadTxPage(next);
      if (first) tbody.replaceChildren();
      for (const t of page.items) if (HASH_RE.test(t.hash ?? "")) tbody.append(row(t));
      if (first && !tbody.children.length) {
        tbody.append(el("tr", { class: "empty" }, el("td", { colspan: "4" }, "The agent hasn't sent any transactions yet, so there are no receipts.")));
      }
      next = page.next;
      more.hidden = !next;
      more.disabled = false;
    } catch (e) {
      more.disabled = false;
      const retry = el("button", { class: "btn btn-secondary btn-sm", type: "button" }, icon("refresh"), "Try again");
      retry.addEventListener("click", () => { listNote.textContent = "Newest first, read live from Blockscout."; loadPage(first); });
      if (first) tbody.replaceChildren(el("tr", { class: "empty" }, el("td", { colspan: "4" }, `Couldn't load the agent's transactions (${e?.message ?? e}). Try again, or `, extA("link", celoscanAddr(AGENT), "open the agent on Celoscan"), ".")));
      listNote.replaceChildren(retry);
    }
  };
  more.addEventListener("click", () => loadPage(false));
  loadPage(true);
}

// ---------- resolve NP-XXXX-XXXX ----------
async function resolveNo(route, my) {
  setHead("Receipt", "Your ", "receipt", "Looking this receipt number up in the agent's transactions on Celo.");
  showLoading(`Looking up ${route.no} in the agent's transactions…`);
  const hits = [];
  let next = null, pages = 0;
  do {
    const page = await loadTxPage(next);
    if (my !== seq) return;
    for (const t of page.items) if ((t.hash ?? "").toLowerCase().startsWith(route.prefix)) hits.push(t);
    next = page.next;
    pages++;
  } while (next && pages < MAX_SCAN_PAGES);
  if (!hits.length) {
    setHead("Receipt", "Receipt not ", "found", "No transaction from the agent has this receipt number.");
    return problem("warn", "Receipt not found",
      [el("p", {}, `No transaction sent by the agent has the receipt number ${route.no}.`),
        el("p", { class: "small mt-8" }, next ? "Only the agent's latest 2,000 transactions were searched. If the receipt is older, open it with its transaction hash." : "Check the number against the one you were sent: it's NP- followed by eight letters and digits.")]);
  }
  if (hits.length > 1) return showMany(route, hits);
  return openTx(hits[0].hash, { via: "np", item: hits[0] }, my);
}

function showMany(route, hits) {
  setHead("Receipt", "More than one ", "match", "Pick the transaction you're looking for.");
  show(card("slip", `${hits.length} transactions share ${route.no}`,
    el("p", { class: "soft small" }, "Receipt numbers come from the first 8 characters of the transaction hash, so on rare occasions two transactions share one. Open the one you need:"),
    el("ul", { class: "kv-list mt-16" }, hits.map((t) => kv(
      el("span", { class: "tx-name" }, el("span", {}, txLabel(t)), el("span", { class: "mono micro" }, short(t.hash))),
      el("span", { class: "tx-cell" }, el("span", { class: "num small" }, t.timestamp ? lagosTime(t.timestamp) + " WAT" : "—"),
        el("a", { class: "btn btn-secondary btn-sm", href: `#tx=${t.hash}` }, "Open receipt", icon("right"))))))));
}

// ---------- open one transaction ----------
const SELECTORS = { "0xa9059cbb": "transfer", "0x095ea7b3": "approve" };
/** A Blockscout-shaped item for txKind/txLabel, built from RPC data when Blockscout has none. */
function itemFromRpc(tx, rc) {
  const transfers = decodeTransfers(rc).map((t) => ({ from: { hash: t.from }, to: { hash: t.to }, token: { address_hash: t.token } }));
  return {
    hash: tx.hash, from: { hash: tx.from }, to: tx.to ? { hash: tx.to } : null, raw_input: tx.input,
    method: SELECTORS[(tx.input ?? "").slice(0, 10).toLowerCase()] ?? null, status: tx.status,
    token_transfers: transfers.length ? transfers : undefined,
  };
}

async function openTx(hash, ctx, my) {
  if (ctx.via !== "np") { setHead("Receipt", "Your ", "receipt", "Rebuilt in your browser from Celo mainnet. Every figure on this receipt is read from the transactions themselves."); showLoading(); }
  const [tx, rc, bs] = await Promise.all([
    loadTxByHash(hash), loadReceipt(hash),
    ctx.item ? Promise.resolve(ctx.item) : getJson(`${EXPLORER_API}/transactions/${hash}`).catch(() => null),
  ]);
  if (my !== seq) return;
  if (!tx) {
    setHead("Receipt", "Receipt not ", "found", "There's no transaction with this hash on Celo mainnet.");
    return problem("err", "Transaction not found", el("p", {}, "No transaction with this hash on Celo mainnet. Check that the link wasn't cut short, or ask whoever sent it to share it again."), { hash });
  }
  if (!rc) {
    problem("warn", "Waiting for confirmation", el("p", {}, "This transaction isn't confirmed yet. The receipt fills in automatically once it is."), { hash });
    await sleep(5000);
    if (my === seq) openTx(hash, ctx, my);
    return;
  }
  if (!eq(tx.from, AGENT)) {
    setHead("Receipt", "Not an agent ", "transaction", "Receipts here cover transactions the agent sent.");
    return show(card("slip", "No receipt for this transaction",
      alertBox("warn", "alert", el("p", {}, "This transaction wasn't sent by the agent, so this site has no receipt for it."),
        el("p", { class: "small mt-8" }, "Payments into the agent show up on the receipt of the payout they funded. You can still check this transaction's tag on Verify.")),
      el("ul", { class: "kv-list mt-16" },
        kv("From", tx.from ? addrLink(tx.from) : dash()),
        kv("To", tx.to ? addrLink(tx.to) : dash()),
        kv("Date and time", el("span", { class: "num" }, tx.timestamp ? fullTime(tx.timestamp) : "—")),
        kv("Transaction", el("span", { class: "tx-cell" }, txLink(tx.hash), tagBadge(tx.hash, tx.input)))),
      el("div", { class: "row mt-24" },
        el("a", { class: "btn btn-secondary btn-sm", href: `verify.html?tx=${tx.hash}` }, icon("shield"), "Check its tag on Verify"),
        btnLink("btn-secondary", celoscanTx(tx.hash), "View on Celoscan", true),
        btnLink("btn-ghost", "receipt.html", "Find another receipt"))));
  }
  const item = bs && bs.hash ? { ...bs, raw_input: bs.raw_input ?? tx.input, status: tx.status } : itemFromRpc(tx, rc);
  const transfers = decodeTransfers(rc);
  const out = transfers.filter((t) => eq(t.from, AGENT) && knownToken(t.token));
  const into = transfers.filter((t) => eq(t.to, AGENT) && knownToken(t.token));
  if (tx.status === "ok" && out.length && !into.length) return openPayout({ ...ctx, hash }, tx, out, my);
  return renderTransaction(tx, rc, item, bs);
}

// ---------- payout ----------
const sum = (list) => list.reduce((a, t) => a + t.value, 0n);

/** The conversion that funded the payout: from the link (s) or the agent's latest convert before the payout. */
async function findSwap(s, payout, corridor) {
  let hash = s, source = "link";
  if (!hash) {
    source = "search";
    let next = null;
    for (let i = 0; i < 5 && !hash; i++) {
      const page = await loadTxPage(next);
      const hit = page.items.find((t) => !eq(t.hash, payout.hash) && t.status === "ok" && txKind(t) === "convert"
        && payout.blockNumber != null && Number(t.block_number) <= payout.blockNumber);
      if (hit) hash = hit.hash;
      if (!page.next) break;
      next = page.next;
    }
    if (!hash) return { missing: "No conversion by the agent was found before this payout." };
  }
  const [tx, rc] = await Promise.all([loadTxByHash(hash), loadReceipt(hash)]);
  if (!tx || !rc) return { missing: "The conversion transaction in this link wasn't found on Celo mainnet.", hash };
  const tr = decodeTransfers(rc);
  const soldRaw = sum(tr.filter((t) => eq(t.from, AGENT) && eq(t.token, TOKENS[corridor.sell].address)));
  const boughtRaw = sum(tr.filter((t) => eq(t.to, AGENT) && eq(t.token, TOKENS[corridor.buy].address)));
  if (rc.status !== "0x1" || !soldRaw || !boughtRaw) {
    return { missing: `The ${source === "link" ? "linked" : "agent's latest"} conversion doesn't show the agent selling ${TOKENS[corridor.sell].symbol} for ${TOKENS[corridor.buy].symbol}.`, hash, tx };
  }
  return { tx, soldRaw, sold: tokenUnits(soldRaw, TOKENS[corridor.sell].address), bought: tokenUnits(boughtRaw, TOKENS[corridor.buy].address), source };
}

/** The deposit that funded the swap: the latest transfer INTO the agent of the sold token, for exactly the sold amount, before the swap. */
async function findPayer(swap, corridor) {
  if (!swap?.soldRaw || !swap.tx) return null;
  const token = TOKENS[corridor.sell].address;
  let params = null;
  for (let i = 0; i < 4; i++) {
    const qs = new URLSearchParams({ type: "ERC-20", filter: "to", token, ...(params ?? {}) });
    const d = await getJson(`${EXPLORER_API}/addresses/${AGENT}/token-transfers?${qs}`);
    for (const t of d.items ?? []) {
      if (!eq(t.to?.hash, AGENT) || !eq(t.token?.address_hash ?? t.token?.address, token)) continue;
      if (swap.tx.blockNumber != null && Number(t.block_number) > swap.tx.blockNumber) continue;
      let v;
      try { v = BigInt(t.total?.value ?? "-1"); } catch { continue; }
      if (v === swap.soldRaw) return { from: t.from?.hash, hash: t.transaction_hash ?? t.tx_hash };
    }
    if (!d.next_page_params) return null;
    params = d.next_page_params;
  }
  return null;
}

/** The name a recipient gave in their own onchain "Get paid" registration, if any (latest one before the payout). */
async function findName(wallet, payoutBlock) {
  const regs = await loadRegistrations(3);
  const mine = regs.filter((r) => eq(r.from, wallet) && (payoutBlock == null || r.block <= payoutBlock));
  mine.sort((a, b) => b.block - a.block || b.position - a.position);
  const n = mine[0]?.req?.n;
  return typeof n === "string" && n.trim() ? n.trim().slice(0, 40) : null;
}

async function openPayout(ctx, tx, out, my) {
  const pay = out[0];
  // each token by its own decimals (cNGN 6, IDRX 2, wARS/wCOP 18, USD₮ 6); a local currency was bought with USD₮
  const amount = tokenUnits(sum(out.filter((t) => eq(t.token, pay.token) && eq(t.to, pay.to))), pay.token);
  const cur = CURRENCIES.find((c) => eq(c.address, pay.token));
  const corridor = cur ? CORRIDORS[`usdt-${cur.code}`] : CORRIDORS["cngn-usdt"];
  let swap;
  try { swap = await findSwap(ctx.s, tx, corridor); }
  catch (e) { swap = { missing: `Couldn't load the conversion (${e?.message ?? e}).` }; }
  if (my !== seq) return;
  const [payer, name] = await Promise.all([
    findPayer(swap, corridor).catch(() => null),
    findName(pay.to, tx.blockNumber).catch(() => null),
  ]);
  if (my !== seq) return;
  renderPayout({ ctx, tx, pay, amount, corridor, swap, payer, name });
  renderRate(feedbackUrl({ hash: tx.hash, s: ctx.s ?? (swap.tx?.hash || null), r: ctx.r }));
}

function renderPayout({ ctx, tx, pay, amount, corridor, swap, payer, name }) {
  const local = currencyOfCorridor(corridor.id); // the currency paid out, or null (dollars)
  const isNaira = local !== null;
  const amountText = isNaira ? formatCurrency(amount, local.code, local.code === "cngn" ? 2 : local.places) : usd(amount);
  const no = receiptNo(tx.hash);
  const time = tx.timestamp ? fullTime(tx.timestamp) : "—";
  let rateText = null, sentText = null;
  if (!swap.missing) {
    const perUsd = isNaira ? swap.bought / swap.sold : swap.sold / swap.bought;
    rateText = isNaira ? `1 USD₮ = ${formatCurrency(perUsd, local.code, 2)}` : `1 USD₮ = ${naira(perUsd)}`;
    sentText = `${num2.format(swap.sold)} ${TOKENS[corridor.sell].symbol}`;
  }
  const paidTo = name ? `${name} · ${short(pay.to)}` : short(pay.to);
  const slip = {
    kind: "payout", no, url: receiptUrl(no),
    eyebrow: "Payout receipt", label: "Received", headline: amountText,
    sub: isNaira ? (local.code === "cngn" ? "Paid as cNGN on Celo, redeemable for naira" : `Paid as ${local.token} on Celo, ${local.plural} (${local.country})`) : "Paid as USD₮ on Celo",
    status: ["Completed", "ok"],
    rows: [
      { label: "Receipt number", text: no, node: el("span", { class: "mono" }, no) },
      { label: "Date and time", text: time, node: el("span", { class: "num" }, time) },
      { label: "Paid by", text: payer?.from ? short(payer.from) : "—", node: payer?.from ? addrLink(payer.from) : dash() },
      { label: "Paid to", text: paidTo, node: name ? el("span", { class: "who" }, el("span", {}, name), addrLink(pay.to)) : addrLink(pay.to) },
      { label: "Amount sent", text: sentText ?? "—", node: sentText ? el("span", { class: "num" }, sentText) : dash() },
      { label: "Exchange rate", text: rateText ?? "—", node: rateText ? el("span", { class: "num" }, rateText) : dash() },
      { label: "Route", text: "Textile FX on Celo" },
      ctx.r ? { label: "Payment request", text: ctx.r, node: el("span", { class: "mono" }, ctx.r) } : null,
    ].filter(Boolean),
    proof: [
      { label: "Payout", hash: tx.hash, input: tx.input },
      swap.tx ? { label: "Conversion", hash: swap.tx.hash, input: swap.tx.input } : swap.hash ? { label: "Conversion", hash: swap.hash } : null,
      payer?.hash && HASH_RE.test(payer.hash) ? { label: "Payment in", hash: payer.hash, noTag: true } : null,
    ].filter(Boolean),
    notes: [],
  };
  if (swap.missing) slip.notes.push(alertBox("warn", "info", el("p", { class: "small" }, swap.missing, " The payout is confirmed; only the amount sent and the rate can't be shown.")));
  else if (swap.source === "search") slip.notes.push(el("p", { class: "small muted" }, "This link doesn't name the conversion, so the receipt uses the agent's latest conversion before the payout."));
  if (!payer?.from) slip.notes.push(el("p", { class: "small muted" }, "Paid by shows a wallet only when a deposit of exactly the amount sent is found before the conversion."));
  if (ctx.badS) slip.notes.push(el("p", { class: "small muted" }, "The conversion hash in this link was damaged and has been ignored."));
  setHead("Payout receipt", "Payout ", "receipt", "Rebuilt in your browser from Celo mainnet. Every figure on this receipt is read from the transactions themselves.");
  renderSlip(slip, `Receipt ${no}: ${amountText} received on ${time}${rateText ? ` (${rateText}, via Textile FX on Celo)` : ""}. Check it on Celo: ${slip.url}`);
}

// ---------- any other agent transaction ----------
function renderTransaction(tx, rc, item, bs) {
  const no = receiptNo(tx.hash);
  const [stText, stKind] = txStatus({ status: tx.status });
  const title = txLabel(item);
  const time = tx.timestamp ? fullTime(tx.timestamp) : "—";
  let feeText = null;
  try {
    const gasToken = bs?.celo?.gas_token;
    if (gasToken && bs?.fee?.value != null) {
      const dec = Number(gasToken.decimals ?? 18);
      feeText = `${celoFmt.format(Number(BigInt(bs.fee.value)) / 10 ** dec)} ${gasToken.symbol ?? "token"}`;
    } else if (rc.gasUsed && (rc.effectiveGasPrice ?? bs?.gas_price)) {
      const wei = BigInt(rc.gasUsed) * BigInt(rc.effectiveGasPrice ?? bs.gas_price);
      feeText = `${celoFmt.format(Number(wei) / 1e18)} CELO`;
    }
  } catch { feeText = null; }
  const tag = decodeTag(tx.input);
  const tagText = tag?.codes?.length ? tag.codes.join(", ") : null;
  const tagged = !!tag?.codes?.includes(TAG);
  const method = item.method || null;
  const slip = {
    kind: "tx", no, url: receiptUrl(no),
    eyebrow: "Transaction receipt", label: "Transaction", headline: title,
    sub: "Sent by the Lokal agent on Celo",
    status: [stText, stKind],
    rows: [
      { label: "Receipt number", text: no, node: el("span", { class: "mono" }, no) },
      { label: "Date and time", text: time, node: el("span", { class: "num" }, time) },
      { label: "Status", text: stText, imageOnly: true },
      { label: "From", text: `Agent · ${short(tx.from)}`, node: el("span", { class: "who" }, el("span", {}, "The agent"), addrLink(tx.from)) },
      { label: "To", text: tx.to ? short(tx.to) : "Contract creation", node: tx.to ? addrLink(tx.to) : el("span", { class: "muted" }, "Contract creation") },
      method ? { label: "Function", text: method, node: el("span", { class: "mono" }, method) } : null,
      { label: "Network fee", text: feeText ?? "—", node: feeText ? el("span", { class: "num" }, feeText) : dash() },
      { label: "Attribution tag", text: tagText ?? "None", node: tagText ? el("span", { class: "tx-cell" }, el("span", { class: "mono" }, tagText), badge(tagged ? "Agent tag" : "Other tag", tagged ? "ok" : "neutral")) : el("span", { class: "muted" }, "None") },
      { label: "Block", text: tx.blockNumber != null ? String(tx.blockNumber) : "—", node: tx.blockNumber != null ? el("span", { class: "num" }, tx.blockNumber.toLocaleString("en-NG")) : dash() },
    ].filter(Boolean),
    proof: [{ label: "Transaction", hash: tx.hash, input: tx.input }],
    notes: tx.status === "error" ? [alertBox("err", "alert", el("p", { class: "small" }, "This transaction failed on chain. Nothing it tried to do happened, but the network fee was still paid."))] : [],
  };
  setHead("Transaction receipt", "Transaction ", "receipt", "Rebuilt in your browser from Celo mainnet. Every figure on this receipt is read from the transaction itself.");
  renderSlip(slip, `Receipt ${no}: ${title} by the Lokal agent on ${time}. Check it on Celo: ${slip.url}`);
}

// ---------- the slip (DOM) ----------
function qrModules(text) {
  const lib = globalThis.qrcode;
  if (typeof lib !== "function") return null;
  try {
    const qr = lib(0, "M");
    qr.addData(text);
    qr.make();
    return qr;
  } catch { return null; }
}
function qrSvg(qr) {
  const n = qr.getModuleCount(), quiet = 3, size = n + quiet * 2;
  let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "QR code of this receipt's link");
  svg.setAttribute("shape-rendering", "crispEdges");
  const bg = document.createElementNS(ns, "rect");
  bg.setAttribute("width", size); bg.setAttribute("height", size); bg.setAttribute("fill", "#fff");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", d); path.setAttribute("fill", "#07120c");
  svg.append(bg, path);
  return svg;
}

function renderSlip(slip, shareText) {
  document.title = `Receipt ${slip.no} · Lokal`;
  const qr = qrModules(slip.url);
  const [stText, stKind] = slip.status;
  const dl = el("button", { class: "btn btn-primary btn-sm", type: "button" }, icon("download"), "Download image");
  const pdf = el("button", { class: "btn btn-secondary btn-sm", type: "button" }, icon("doc"), "Save as PDF");
  const wa = el("a", { class: "btn btn-secondary btn-sm", href: "https://wa.me/?text=" + encodeURIComponent(shareText), target: "_blank", rel: "noopener" }, "Share on WhatsApp", icon("ext"));
  const copy = el("button", { class: "btn btn-secondary btn-sm", type: "button" }, icon("copy"), "Copy link");
  dl.addEventListener("click", async () => {
    dl.disabled = true;
    try { await downloadImage(slip, qr); toast("Image saved"); }
    catch (e) { toast("Couldn't make the image. Try Save as PDF instead."); console.error(e); }
    finally { dl.disabled = false; }
  });
  pdf.addEventListener("click", () => window.print());
  copy.addEventListener("click", () => copyText(slip.url, "Link copied"));

  const notes = slip.notes.length ? el("div", { class: "stack mt-16" }, slip.notes) : null;
  show(el("section", { class: "card", id: "slip", "aria-labelledby": "slip-h" },
    el("div", { class: "card-h" },
      el("h2", { id: "slip-h" }, slip.kind === "payout" ? "Payout receipt" : "Transaction receipt", el("span", { class: "slip-no" }, slip.no)),
      el("span", { class: `badge ${stKind}` }, stKind === "ok" ? el("span", { class: "dot" }) : null, stText)),
    el("div", { class: "card-b" },
      el("div", { class: "receive" },
        el("span", { class: "label" }, slip.label),
        el("output", { class: slip.kind === "payout" ? "num" : "title" }, slip.headline),
        el("p", { class: "micro" }, slip.sub)),
      el("ul", { class: "kv-list mt-16" }, slip.rows.filter((r) => !r.imageOnly).map((r) => kv(r.label, r.node ?? r.text))),
      el("h3", { class: "slip-sec" }, "Verified onchain"),
      el("ul", { class: "kv-list" }, slip.proof.map((p) => kv(p.label, el("span", { class: "tx-cell" }, txLink(p.hash), p.noTag ? null : tagBadge(p.hash, p.input))))),
      notes,
      el("div", { class: "qr-row" },
        qr ? qrSvg(qr) : null,
        el("div", {},
          el("p", { class: "small" }, el("b", {}, "Scan to check this receipt")),
          el("p", { class: "micro muted mt-8" }, "Opens this page, which rebuilds the receipt from Celo mainnet."),
          el("p", { class: "mono micro soft mt-8" }, slip.url.replace(/^https:\/\//, ""))))),
    el("div", { class: "card-f no-print" }, el("div", { class: "row" }, dl, pdf, wa, copy,
      slip.kind === "payout" ? el("a", { class: "btn btn-ghost btn-sm", href: "cash-out.html" }, "Cash out", icon("right")) : null))),
    el("p", { class: "small no-print" }, el("a", { class: "link", href: "receipt.html" }, "Find another receipt")));
}

// ---------- the slip (PNG, drawn on canvas) ----------
function rrect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function fit(ctx, text, max) {
  let t = String(text);
  if (ctx.measureText(t).width <= max) return t;
  while (t.length > 1 && ctx.measureText(t + "…").width > max) t = t.slice(0, -1);
  return t + "…";
}
const loadImg = (src) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = src; });

/** Lays the slip out at width W; draws only when given the final height H (0 = measure only). Returns the height in CSS pixels. */
function paintSlip(ctx, slip, qr, logo, W, H) {
  const draw = H > 0;
  const cs = getComputedStyle(document.documentElement);
  const tok = (n, f) => cs.getPropertyValue(n).trim() || f;
  const C = {
    bg: tok("--bg", "#040806"), raise: tok("--bg-raise", "#07100b"), surface: tok("--surface-2", "rgba(255,255,255,.07)"),
    line: tok("--line", "rgba(255,255,255,.09)"), text: tok("--text", "#f1f5f2"), text2: tok("--text-2", "rgba(241,245,242,.74)"),
    text3: tok("--text-3", "rgba(241,245,242,.56)"), mint: tok("--mint", "#6ff0b0"), warn: tok("--warn", "#ffcc7a"), err: tok("--err", "#ff8f80"),
    celo: tok("--celo", "#fcff52"), green: tok("--green", "#00a862"), ink: tok("--on-light", "#07120c"),
  };
  const sans = '"General Sans", system-ui, sans-serif';
  const mono = 'ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace';
  const P = 40, inner = W - P * 2;
  if (draw) {
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);
    // a soft green wash at the top, as on the site
    const g = ctx.createLinearGradient(0, 0, 0, 260);
    g.addColorStop(0, "rgba(0,168,98,.28)"); g.addColorStop(1, "rgba(0,168,98,0)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, 260);
  }
  let y = P;
  // brand + status
  if (draw) {
    if (logo) ctx.drawImage(logo, P, y, 34, 34);
    ctx.fillStyle = C.text; ctx.font = `600 17px ${sans}`; ctx.textBaseline = "middle"; ctx.textAlign = "left";
    ctx.fillText("Lokal", P + (logo ? 46 : 0), y + 17);
    const [st, sk] = slip.status;
    const col = sk === "ok" ? C.mint : sk === "err" ? C.err : sk === "warn" ? C.warn : C.text2;
    ctx.font = `500 13px ${sans}`;
    const tw = ctx.measureText(st).width + 34;
    rrect(ctx, W - P - tw, y + 3, tw, 28, 14);
    ctx.fillStyle = "rgba(255,255,255,.06)"; ctx.fill();
    ctx.strokeStyle = col; ctx.globalAlpha = .45; ctx.lineWidth = 1; ctx.stroke(); ctx.globalAlpha = 1;
    ctx.beginPath(); ctx.arc(W - P - tw + 15, y + 17, 3.5, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill();
    ctx.fillStyle = col; ctx.fillText(st, W - P - tw + 25, y + 17.5);
  }
  y += 34 + 36;
  // eyebrow + headline
  if (draw) {
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = C.celo; ctx.font = `500 12.5px ${sans}`;
    ctx.fillText(slip.eyebrow.toUpperCase().split("").join(String.fromCharCode(8202)), P, y);
  }
  y += 18;
  const big = slip.kind === "payout";
  const hSize = big ? 56 : 34;
  y += hSize;
  if (draw) {
    ctx.fillStyle = C.text; ctx.font = `${big ? 300 : 400} ${hSize}px ${sans}`;
    ctx.fillText(fit(ctx, slip.headline, inner), P, y - (big ? 4 : 2));
  }
  y += 12;
  if (draw) {
    ctx.fillStyle = C.text2; ctx.font = `400 15px ${sans}`;
    ctx.fillText(fit(ctx, slip.sub, inner), P, y + 12);
  }
  y += 12 + 28;
  // rows
  const rowH = 42;
  const row = (label, value, monoVal) => {
    if (draw) {
      ctx.strokeStyle = C.line; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(P, y + .5); ctx.lineTo(W - P, y + .5); ctx.stroke();
      ctx.textBaseline = "middle";
      ctx.fillStyle = C.text3; ctx.font = `400 14px ${sans}`; ctx.textAlign = "left";
      ctx.fillText(label, P, y + rowH / 2);
      ctx.fillStyle = C.text; ctx.font = monoVal ? `400 13.5px ${mono}` : `500 14px ${sans}`; ctx.textAlign = "right";
      ctx.fillText(fit(ctx, value, inner * .62), W - P, y + rowH / 2);
      ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    }
    y += rowH;
  };
  const monoish = (t) => /^(NP-|0x)/.test(t) || /0x[0-9a-f]{4}…/i.test(t);
  for (const r of slip.rows) row(r.label, r.text, monoish(r.text) && !/·/.test(r.text));
  y += 22;
  if (draw) {
    ctx.fillStyle = C.text3; ctx.font = `500 12px ${sans}`;
    ctx.fillText("VERIFIED ONCHAIN".split("").join(String.fromCharCode(8202)), P, y);
  }
  y += 8;
  for (const p of slip.proof) {
    const tagged = !p.noTag && p.input != null && isTaggedInput(p.input);
    row(p.label, `${short(p.hash)}${p.noTag || p.input == null ? "" : tagged ? "  ·  Tagged" : "  ·  No tag"}`, true);
  }
  y += 22;
  // QR block
  const qS = 132;
  if (draw) {
    rrect(ctx, P, y, inner, qS + 32, 16);
    ctx.fillStyle = C.surface; ctx.fill();
    ctx.strokeStyle = C.line; ctx.stroke();
    if (qr) {
      const n = qr.getModuleCount(), quiet = 3, cell = qS / (n + quiet * 2);
      const qx = P + 16, qy = y + 16;
      rrect(ctx, qx, qy, qS, qS, 10); ctx.fillStyle = "#fff"; ctx.fill();
      ctx.fillStyle = C.ink;
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
        if (qr.isDark(r, c)) ctx.fillRect(qx + (c + quiet) * cell, qy + (r + quiet) * cell, Math.ceil(cell * 100) / 100 + .02, Math.ceil(cell * 100) / 100 + .02);
      }
    }
    const tx = P + (qr ? qS + 36 : 20), tmax = W - P - 20 - tx;
    ctx.textAlign = "left";
    ctx.fillStyle = C.text; ctx.font = `600 16px ${sans}`;
    ctx.fillText("Scan to check this receipt", tx, y + 52);
    ctx.fillStyle = C.text2; ctx.font = `400 13.5px ${sans}`;
    ctx.fillText(fit(ctx, "Rebuilt live from Celo mainnet.", tmax), tx, y + 76);
    ctx.fillStyle = C.mint; ctx.font = `400 12.5px ${mono}`;
    const u = slip.url.replace(/^https:\/\//, "");
    const cut = u.indexOf("/receipt.html");
    ctx.fillText(fit(ctx, cut > 0 ? u.slice(0, cut) : u, tmax), tx, y + 106);
    if (cut > 0) ctx.fillText(fit(ctx, u.slice(cut), tmax), tx, y + 124);
  }
  y += qS + 32 + 26;
  if (draw) {
    ctx.fillStyle = C.text3; ctx.font = `400 12px ${sans}`;
    ctx.fillText(fit(ctx, "Agent 0x8a69…7a1e · ERC-8004 agent 10079 · Data: Celo Forno RPC · Blockscout", inner), P, y);
  }
  return y + P - 10;
}

async function downloadImage(slip, qr) {
  if (document.fonts?.ready) {
    await document.fonts.ready;
    await Promise.all(["300 56px", "400 15px", "500 14px", "600 16px"].map((f) => document.fonts.load(`${f} "General Sans"`).catch(() => null)));
  }
  const logo = await loadImg("logo.png?v=lokal2");
  const W = 640, S = 2;
  const probe = document.createElement("canvas");
  probe.width = W; probe.height = 10;
  const H = Math.ceil(paintSlip(probe.getContext("2d"), slip, qr, logo, W, 0));
  const canvas = document.createElement("canvas");
  canvas.width = W * S; canvas.height = H * S;
  const ctx = canvas.getContext("2d");
  ctx.scale(S, S);
  paintSlip(ctx, slip, qr, logo, W, H);
  const blob = await new Promise((res) => (canvas.toBlob ? canvas.toBlob(res, "image/png") : res(null)));
  const url = blob ? URL.createObjectURL(blob) : canvas.toDataURL("image/png");
  const a = el("a", { href: url, download: `${slip.no}.png` });
  document.body.append(a); a.click(); a.remove();
  if (blob) setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ---------- rate this payout ----------
let account = null;
let rateUrl = "";
let stars = 0;
let rateSeq = 0;

function renderRate(url, notice) {
  rateUrl = url;
  rateCard.hidden = false;
  const intro = el("p", { class: "soft small" }, "Paid through this agent? Rate the payout on the agent's public ERC-8004 reputation record. The rating is a transaction from your own wallet, which you approve there.");
  const eth = window.ethereum;
  if (!eth) {
    rateBody.replaceChildren(intro,
      alertBox("", "info", el("p", {}, "No wallet found in this browser. To rate, open this page in a wallet's built-in browser, such as MiniPay or MetaMask mobile: copy the link, then paste it into the wallet's browser.")),
      el("div", { class: "row" }, el("button", { class: "btn btn-secondary btn-sm", type: "button", dataset: { copy: url, copyLabel: "Link copied" } }, icon("copy"), "Copy link")));
    return;
  }
  if (account) return renderRateForm();
  const connect = el("button", { class: "btn btn-secondary", type: "button" }, "Connect wallet");
  const msg = el("div", { "aria-live": "polite" });
  if (notice) msg.replaceChildren(alertBox("", "info", el("p", {}, notice)));
  connect.addEventListener("click", async () => {
    connect.disabled = true;
    msg.replaceChildren();
    markWalletConnected();
    try {
      const accs = await eth.request({ method: "eth_requestAccounts" });
      if (!accs?.length) throw new Error("The wallet returned no account.");
      account = accs[0];
      renderRateForm();
    } catch (e) {
      connect.disabled = false;
      msg.replaceChildren(alertBox("err", "alert", el("p", {}, explain(e))));
    }
  });
  rateBody.replaceChildren(intro, el("div", { class: "row" }, connect), msg);
}

async function isVerifiedPayer(addr) {
  let params = null;
  for (let i = 0; i < 5; i++) {
    const qs = new URLSearchParams({ type: "ERC-20", filter: "to", ...(params ?? {}) });
    const d = await getJson(`${EXPLORER_API}/addresses/${AGENT}/token-transfers?${qs}`);
    for (const t of d.items ?? []) {
      if (eq(t.from?.hash, addr) && knownToken(t.token?.address_hash ?? t.token?.address)) return true;
    }
    if (!d.next_page_params) return false;
    params = d.next_page_params;
  }
  return false;
}

function renderRateForm() {
  const my = ++rateSeq;
  stars = 0;
  const payerCell = el("span", {}, el("span", { class: "skel", style: "width:90px" }));
  const payerNote = el("div", { "aria-live": "polite" });
  const ownerNote = el("div", { "aria-live": "polite" });
  const group = el("div", { class: "segmented stars", role: "group", "aria-labelledby": "stars-label", style: "justify-self:start" });
  const starHint = el("p", { class: "hint", id: "stars-hint", "aria-live": "polite" }, "Pick 1 to 5 stars.");
  const send = el("button", { class: "btn btn-secondary", type: "button", disabled: true }, "Send rating");
  const result = el("div", { "aria-live": "polite" });
  for (let n = 1; n <= 5; n++) {
    const b = el("button", { type: "button", "aria-pressed": "false", "aria-label": `${n} star${n > 1 ? "s" : ""}`, dataset: { n: String(n) } }, `${n} ★`);
    b.addEventListener("click", () => {
      stars = n;
      for (const x of group.children) x.setAttribute("aria-pressed", String(x === b));
      starHint.textContent = `${"★".repeat(n)}${"☆".repeat(5 - n)}  ${n} out of 5`;
      if (!send.dataset.blocked) send.disabled = false;
    });
    group.append(b);
  }
  send.addEventListener("click", () => submit(send, result));
  const disconnect = el("button", { class: "btn btn-ghost btn-sm", type: "button", "aria-label": "Disconnect wallet" }, icon("x"), "Disconnect");
  disconnect.addEventListener("click", async () => {
    if (send.textContent !== "Send rating" && send.disabled && !send.dataset.blocked) return; // a rating is being sent
    disconnect.disabled = true;
    const revoked = await disconnectWallet(window.ethereum);
    account = null;
    rateSeq++;
    toastMsg("Wallet disconnected");
    renderRate(rateUrl, revoked ? DISCONNECT_NOTE_FULL : DISCONNECT_NOTE_PARTIAL);
  });

  rateBody.replaceChildren(
    el("ul", { class: "kv-list" },
      kv("Wallet", el("span", { class: "row", style: "justify-content:flex-end;gap:8px" }, addrLink(account), disconnect)),
      kv("Payer check", payerCell)),
    payerNote,
    ownerNote,
    el("div", { class: "field" },
      el("span", { class: "label", id: "stars-label" }, "Your rating"),
      group,
      starHint),
    el("div", { class: "row" }, send),
    el("p", { class: "small muted" }, "Your wallet asks you to approve one transaction on Celo, which costs a small network fee. The rating links back to this receipt."),
    result,
  );

  isVerifiedPayer(account).then((ok) => {
    if (my !== rateSeq) return;
    payerCell.replaceChildren(badge(ok ? "Verified payer" : "Unverified", ok ? "ok" : "neutral"));
    payerNote.replaceChildren(el("p", { class: "small muted" }, ok
      ? "This wallet has sent USD₮ or cNGN to the agent, so its rating shows as from a verified payer. That's our own check against deposits; the registry itself can't check it."
      : "This wallet has never sent USD₮ or cNGN to the agent, so its rating will show as \"unverified\". If you paid from another wallet, connect that one instead."));
  }).catch(() => {
    if (my !== rateSeq) return;
    payerCell.replaceChildren(dash());
    payerNote.replaceChildren(el("p", { class: "small muted" }, "Couldn't check this wallet's deposits right now. You can still send a rating; the Agent page re-checks it."));
  });

  loadIdentity().then((id) => {
    if (my !== rateSeq) return;
    if (eq(account, id.owner) || eq(account, AGENT)) {
      send.dataset.blocked = "1";
      send.disabled = true;
      ownerNote.replaceChildren(alertBox("err", "alert", el("p", {}, "This wallet owns the agent. The reputation registry rejects ratings from an agent's owner or operators, so it can't rate its own payouts. Connect the wallet that paid.")));
    }
  }).catch(() => { /* the contract still rejects self-feedback; submit() explains it */ });
}

function explain(e) {
  const m = String(e?.data?.message ?? e?.message ?? e ?? "");
  if (e?.code === 4001 || /user (rejected|denied|cancel)|rejected by user|denied transaction/i.test(m)) return "You cancelled in your wallet. Nothing was sent.";
  if (/self-feedback|self feedback|owner|operator/i.test(m)) return "The reputation registry rejected this rating because the wallet owns or operates the agent, and agents can't rate themselves. Connect the wallet that paid.";
  if (/insufficient funds/i.test(m)) return "This wallet doesn't have enough CELO for the network fee. Add a little CELO and try again.";
  if (e?.code === -32002) return "Your wallet already has a request open. Switch to it and finish or cancel that first.";
  return `The wallet reported: ${m || "unknown error"}. Try again, and check the wallet is on Celo mainnet.`;
}

async function ensureCelo(eth) {
  const id = String(await eth.request({ method: "eth_chainId" })).toLowerCase();
  if (id === CELO_CHAIN) return;
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CELO_CHAIN }] });
  } catch (e) {
    const unknown = e?.code === 4902 || e?.data?.originalError?.code === 4902 || /unrecognized|not been added|unknown chain/i.test(String(e?.message));
    if (!unknown) throw e;
    await eth.request({ method: "wallet_addEthereumChain", params: [{
      chainId: CELO_CHAIN, chainName: "Celo", nativeCurrency: { name: "CELO", symbol: "CELO", decimals: 18 },
      rpcUrls: ["https://forno.celo.org"], blockExplorerUrls: ["https://celoscan.io"],
    }] });
  }
  const now = String(await eth.request({ method: "eth_chainId" })).toLowerCase();
  if (now !== CELO_CHAIN) throw new Error("The wallet is still on another network. Switch it to Celo and try again.");
}

async function submit(send, result) {
  const eth = window.ethereum;
  if (!eth || !account || !(stars >= 1 && stars <= 5)) return;
  const from = account;
  const label = send.textContent;
  send.disabled = true;
  send.textContent = "Check your wallet…";
  result.replaceChildren();
  try {
    await ensureCelo(eth);
    const data = encodeCall(SEL.giveFeedback,
      ["uint256", "int128", "uint8", "string", "string", "string", "string", "bytes32"],
      [AGENT_ID, stars * 20, 0, "starred", "payout", rateUrl, "", "0x" + "00".repeat(32)]) + tagSuffix();
    // Dry-run on Forno first, so a registry rejection is explained before the wallet asks for a signature.
    try { await rpc("eth_call", [{ from, to: REPUTATION, data }, "latest"]); }
    catch (e) { if (/revert/i.test(String(e?.message))) throw e; /* RPC unreachable: let the wallet estimate */ }
    const hash = await eth.request({ method: "eth_sendTransaction", params: [{ from, to: REPUTATION, data }] });
    send.textContent = "Rating sent";
    result.replaceChildren(alertBox("", "info", el("p", {}, "Sent. Waiting for Celo to confirm it… ", txLink(hash))));
    for (let i = 0; i < 60; i++) {
      await sleep(3000);
      let rc = null;
      try { rc = await loadReceipt(hash); } catch { continue; }
      if (!rc) continue;
      if (rc.status === "0x1") {
        result.replaceChildren(alertBox("", "check",
          el("p", {}, `Your ${stars}-star rating is on chain. `, txLink(hash)),
          el("p", { class: "small mt-8" }, el("a", { class: "link", href: "agent.html" }, "See it with the agent's reviews"), ".")));
        return;
      }
      result.replaceChildren(alertBox("err", "alert", el("p", {}, "The rating transaction failed on chain, so nothing was recorded. ", txLink(hash))));
      send.disabled = false; send.textContent = label;
      return;
    }
    result.replaceChildren(alertBox("warn", "alert", el("p", {}, "Still not confirmed after three minutes. It may yet go through: check it on Celoscan. ", txLink(hash))));
  } catch (e) {
    result.replaceChildren(alertBox("err", "alert", el("p", {}, explain(e))));
    send.disabled = !!send.dataset.blocked;
    send.textContent = label;
  }
}

if (window.ethereum?.on) {
  window.ethereum.on("accountsChanged", (accs) => {
    if (!account) return;
    account = accs?.[0] ?? null;
    if (!rateCard.hidden) renderRate(rateUrl);
  });
}

// ---------- main ----------
async function load() {
  const my = ++seq;
  const route = readRoute();
  rateCard.hidden = true;
  if (route.kind === "none") return showFind(false);
  if (route.kind === "bad") return showFind(true);
  try {
    if (route.kind === "np") await resolveNo(route, my);
    else await openTx(route.hash, route, my);
  } catch (e) {
    if (my !== seq) return;
    // only a real network failure is blamed on the network; anything else is our problem, said plainly
    if (isNetworkError(e)) {
      setHead("Receipt", "Receipt ", "unavailable", "The data behind this receipt couldn't be read just now.");
      problem("err", "Couldn't load this receipt",
        el("p", {}, `Could not reach Celo's RPC or Blockscout (${e?.message ?? e}). Check your connection and try again${route.hash ? ", or open the transaction on Celoscan" : ""}.`),
        { hash: route.hash, retry: load });
    } else {
      setHead("Receipt", "Receipt ", "unavailable", "Something went wrong showing this receipt.");
      problem("err", "Something went wrong showing this receipt",
        el("p", {}, route.hash
          ? ["Try again, or check the transaction on ", el("a", { class: "link", href: celoscanTx(route.hash) }, "Celoscan"), "."]
          : "Try again in a moment, or look the receipt up by its transaction hash."),
        { hash: route.hash, retry: load });
    }
  }
}

addEventListener("hashchange", () => { scrollTo({ top: 0 }); load(); });
load();
