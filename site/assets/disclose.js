// "Show what you need, hide what you might need": the pieces that keep the payment screens calm.
//   - disclosure(): a button (aria-expanded) that opens a panel with a calm height + opacity transition (instant with
//     reduced motion). The panel can be filled lazily on first open (a QR code is only drawn when someone asks for it).
//   - qrDisclosure(): "Show QR code" as a disclosure; shareRow(): one Share button (Web Share API) and Copy link, with a
//     WhatsApp link only where the browser can't share, plus the QR disclosure.
//   - currencyChoice(): "They receive: Naira · Change", the full picker inline on demand.
//   - successPanel(): the calm confirmation after a payment (big check, one sentence, Done), technical rows in Details.
//
// What is NEVER folded away (SAFETY_CRITICAL): the amount the recipient gets, the Pay button, every warning (including
// the "Who am I paying?" ones) and any refusal or limit that would block the payment. The pure helpers here decide
// that and write the one-line summaries; the top level stays free of window/document, so they are tested in Node
// (test/disclose.test.mjs). Styles: assets/ntags.css ("Disclosures").
import { el, icon, copyText, currencyOf } from "./core.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------- what is always shown, and what waits behind a "Details" ----------
/** Information a payer must always see. A refusal is anything the contract or the agent would refuse. */
export const SAFETY_CRITICAL = Object.freeze(["receive-amount", "pay-button", "warning", "refusal", "error"]);
/** Information that is optional: one tap away. */
export const ON_DEMAND = Object.freeze(["rate", "fees", "route", "paid-by", "delivered-as", "limits", "wallet-details", "tx-details", "owner", "history", "qr", "settings", "how-it-works"]);
/** True when `kind` must be visible by default. Anything unknown counts as critical: when in doubt, show it. */
export const alwaysShown = (kind) => SAFETY_CRITICAL.includes(kind) || !ON_DEMAND.includes(kind);

/** Parts joined with " · ", leaving out empty ones: summaryLine(["1 USD₮ = ₦1,440", "fees included"]). */
export const summaryLine = (parts) => parts.map((p) => (p == null ? "" : String(p).trim())).filter(Boolean).join(" · ");

/** The rate row folded into one line: "1 USD₮ = ₦1,440.77 · fees included" (or "before fees", or just the state). */
export function rateSummary({ rateText = null, fees = null } = {}) {
  const r = rateText && rateText !== "—" ? rateText : null;
  return summaryLine([r ?? "Rate loading…", r && fees === "included" ? "fees included" : r && fees === "before" ? "before fees" : null]);
}

const money2 = (n) => {
  const v = Math.floor(Number(n) * 100 + 1e-6) / 100;
  return "$" + (Number.isInteger(v) ? String(v) : v.toFixed(2));
};
/**
 * The limits block as one short line: "Up to $25", or "Up to about $12.50 today" when today's room (the smallest of
 * the agent's and the contract's) is lower than one payment's cap. capUsd: one payment's cap; roomUsd: room today
 * (null when unknown); exact: whether the room is exact.
 */
export function limitsSummary({ capUsd, roomUsd = null, exact = false, unchecked = false }) {
  // unchecked: today's room couldn't be read (the agent's or the contract's); that is said in the line, never folded
  const tail = unchecked ? " · couldn't check today's limit" : "";
  if (roomUsd != null && Number.isFinite(roomUsd) && roomUsd < capUsd - 0.005) {
    return (roomUsd < 1 ? "No room left today" : `Up to ${exact ? "" : "about "}${money2(roomUsd)} today`) + tail;
  }
  return `Up to ${money2(capUsd)}` + tail;
}

/**
 * The link's state badge with the time left, so the deadline is always in view: { text, kind } for badge(text, kind).
 * "Open · 2 d left", "Open · 5 h left", "Open · 12 min left" (warn under 10 minutes), "Open · under 1 min left",
 * "Expired". Always rounded down, so it never promises more time than there is.
 */
export function expiryBadge(leftMs) {
  const s = Math.floor(Number(leftMs) / 1000);
  if (!(s > 0)) return { text: "Expired", kind: "err" };
  const d = Math.floor(s / 86400), h = Math.floor(s / 3600), m = Math.floor(s / 60);
  const left = d >= 1 ? `${d} d` : h >= 1 ? `${h} h` : m >= 1 ? `${m} min` : "under 1 min";
  return { text: `Open · ${left} left`, kind: s < 600 ? "warn" : "neutral" };
}

const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
/** "41 days ago" (trust.js agoText) -> "tag 41 days old"; "just now" -> "tag claimed just now". */
export function tagAgeText(ago) {
  const a = String(ago ?? "").trim();
  if (!a) return null;
  if (/^just now$/i.test(a)) return "tag claimed just now";
  return "tag " + a.replace(/ ago$/, " old");
}
/**
 * "Who am I paying?" in one line, from trust.js assessTag(): { text: "@ada · tag 41 days old · paid 4 times", ok }.
 * ok (shown with a check) only when every check ran and none warns. `ago` is agoText(since, now) or null.
 */
export function trustSummary(tag, a, ago = null) {
  const p = a?.payments;
  const paid = !p || p.state !== "ok" ? null
    : p.count === 0 ? "not paid through LokalPay yet"
      : p.count === 1 && !p.capped ? "paid once" : `paid ${p.count}${p.capped ? "+" : ""} times`;
  const unknown = a?.unknown?.length ?? 0;
  const text = summaryLine(["@" + tag, a?.age?.since ? tagAgeText(ago) : "tag age unknown", paid,
    unknown ? `${plural(unknown, "check")} couldn't run` : null]);
  return { text, ok: Boolean(a) && !(a.warnings?.length) && !unknown };
}
/** The trust card's warnings are never folded: true when the card must stay open (any warning at all). */
export const trustMustShow = (a) => Boolean(a?.warnings?.length);
/** The checks that couldn't run, in words, always in view: "Couldn't check: owner changes, name changes." or null. */
export function unknownChecksText(a) {
  const u = a?.unknown ?? [];
  return u.length ? `Couldn't check: ${u.map((c) => c.short).join(", ")}.` : null;
}

/** What a payer's choice is called: "Naira", "Rupiah", "Peso (AR)", "Peso (CO)", "Dollars". */
export function receiveName(code) {
  if (code === "usd" || code === "usdt") return "Dollars";
  return currencyOf(code)?.label ?? "Naira";
}
/** The currency a pay page starts on: the recipient's saved preference, else naira. */
export function defaultReceive({ receive = null, currency = null } = {}) {
  if (receive === "usdt") return "usd";
  return currencyOf(currency) ? currency : "cngn";
}
/**
 * The accessible name of the "Change" / "Done" button on the currency line. It starts with the visible word (WCAG
 * 2.5.3, label in name): "Change (They receive: Naira)", "Change (You receive: Dollars)", "Done choosing the currency".
 */
export function choiceButtonLabel({ open = false, label = "They receive", code } = {}) {
  return open ? "Done choosing the currency" : `Change (${label}: ${receiveName(code)})`;
}

// ---------- sharing ----------
/** True when this browser has the Web Share API (mostly phones). */
export const canWebShare = (nav = typeof navigator !== "undefined" ? navigator : null) => typeof nav?.share === "function";
/** The two share buttons: Share + Copy link where the browser can share, else Copy link + WhatsApp. */
export const shareActions = (canShare) => (canShare ? ["share", "copy"] : ["copy", "whatsapp"]);
/** After navigator.share() fails: "none" when the person closed the share sheet, else "copy" (fall back to copying). */
export const shareFallback = (err) => (err?.name === "AbortError" ? "none" : "copy");

/**
 * The calm confirmation's headline: "10.00 USD₮ is on its way to @ada" (or the honest version for each step).
 * "held": sent, but the page already knew the payout would wait or be refused, so nothing is promised.
 */
export function successHeadline({ state, amount, to }) {
  if (state === "pending") return `Sending ${amount} to ${to}…`;
  if (state === "paid") return `${to} has been paid`;
  if (state === "failed") return "The payment didn't go through";
  if (state === "held") return `Sent, but ${to} may not be paid yet`;
  return `${amount} is on its way to ${to}`;
}

// ---------- DOM: the disclosure ----------
/** The small chevron of a disclosure (the shared icon sprite has none). */
export function chevron() {
  const svg = document.createElementNS(SVG_NS, "svg");
  for (const [k, v] of [["class", "i dc-chev"], ["viewBox", "0 0 24 24"], ["aria-hidden", "true"], ["fill", "none"], ["stroke", "currentColor"], ["stroke-width", "2"], ["stroke-linecap", "round"], ["stroke-linejoin", "round"]]) svg.setAttribute(k, v);
  const p = document.createElementNS(SVG_NS, "path");
  p.setAttribute("d", "m6 9 6 6 6-6");
  svg.append(p);
  return svg;
}
let ids = 0;
/** Opens or closes a panel: height and opacity ease over --t-calm; with reduced motion it is instant. */
function animate(panel, open) {
  const token = (panel._dcToken = (panel._dcToken ?? 0) + 1);
  const done = () => { if (panel._dcToken !== token) return; panel.style.height = ""; panel.style.opacity = ""; if (!open) panel.hidden = true; panel.classList.remove("is-moving"); };
  if (reducedMotion()) { panel.hidden = !open; done(); return; }
  panel.classList.add("is-moving");
  if (open) {
    panel.hidden = false;
    const h = panel.scrollHeight;
    panel.style.height = "0px"; panel.style.opacity = "0";
    void panel.offsetHeight;
    panel.style.height = h + "px"; panel.style.opacity = "1";
  } else {
    panel.style.height = panel.scrollHeight + "px"; panel.style.opacity = "1";
    void panel.offsetHeight;
    panel.style.height = "0px"; panel.style.opacity = "0";
  }
  const end = (e) => { if (e.target === panel && e.propertyName === "height") { panel.removeEventListener("transitionend", end); done(); } };
  panel.addEventListener("transitionend", end);
  setTimeout(() => { panel.removeEventListener("transitionend", end); done(); }, 520); // a missed transitionend never leaves it half-open
}
/**
 * Wires a toggle button to its panel (aria-controls). opts: render (called once, before the first open), onToggle.
 * Returns { open(), close(), toggle(), isOpen() }.
 */
export function wireDisclosure(button, panel = document.getElementById(button.getAttribute("aria-controls")), opts = {}) {
  if (!button || !panel || button._dc) return button?._dc ?? null;
  let rendered = !opts.render;
  const labels = { closed: button.dataset.closedLabel ?? null, open: button.dataset.openLabel ?? null };
  const textNode = button.querySelector(".dc-more-text");
  const set = (open, instant = false) => {
    if (open && !rendered) { rendered = true; opts.render(panel); }
    // a closing panel takes no focus and is out of the accessibility tree while it fades (hidden comes at the end)
    panel.inert = !open;
    button.setAttribute("aria-expanded", String(open));
    if (textNode && labels.closed && labels.open) textNode.textContent = open ? labels.open : labels.closed;
    if (instant) panel.hidden = !open; else animate(panel, open);
    opts.onToggle?.(open);
  };
  const api = {
    open: ({ instant = false } = {}) => { if (button.getAttribute("aria-expanded") !== "true") set(true, instant); },
    close: () => { if (button.getAttribute("aria-expanded") === "true") set(false); },
    toggle: () => set(button.getAttribute("aria-expanded") !== "true"),
    isOpen: () => button.getAttribute("aria-expanded") === "true",
  };
  button.addEventListener("click", api.toggle);
  button._dc = api;
  return api;
}
/** Wires every .dc-toggle inside `root` (static markup in the HTML pages). */
export function bindDisclosures(root = document) {
  for (const b of root.querySelectorAll(".dc-toggle[aria-controls]")) wireDisclosure(b);
}
/**
 * A disclosure: a full-width row button showing `summary` (text or nodes) with "Details ▾" on the right, and a panel.
 * opts: { summary, more = "Details", moreOpen = more, content | render(panel), open = false, cls, id, lead (node before
 * the summary, e.g. an icon) }. Returns { el, button, panel, open, close, toggle, isOpen, setSummary(nodes) }.
 */
export function disclosure(opts = {}) {
  const id = opts.id ?? `dc-${++ids}`;
  const sum = el("span", { class: "dc-sum" }, ...[].concat(opts.summary ?? []));
  const moreText = el("span", { class: "dc-more-text" }, opts.more ?? "Details");
  const button = el("button", {
    class: `dc-toggle${opts.compact ? " compact" : ""}`, type: "button", "aria-expanded": "false", "aria-controls": id,
    dataset: { closedLabel: opts.more ?? "Details", openLabel: opts.moreOpen ?? opts.more ?? "Details" },
  }, opts.lead ?? null, opts.summary != null ? sum : null, el("span", { class: "dc-more" }, moreText, chevron()));
  const panel = el("div", { class: "dc-panel", id, hidden: true }, el("div", { class: "dc-inner" }, ...[].concat(opts.content ?? [])));
  const root = el("div", { class: `dc${opts.cls ? " " + opts.cls : ""}` }, button, panel);
  const api = wireDisclosure(button, panel, { render: opts.render ? () => opts.render(panel.firstChild) : null, onToggle: opts.onToggle });
  if (opts.open) api.open({ instant: true });
  return { el: root, button, panel, inner: panel.firstChild, ...api, setSummary: (...nodes) => sum.replaceChildren(...nodes.flat()) };
}

// ---------- QR codes, drawn only when asked for ----------
/** QR as DOM SVG (no innerHTML, no data: URLs, works under the CSP). Needs assets/vendor/qrcode.js on the page. */
export function drawQr(box, text, label = "QR code of the link") {
  const lib = globalThis.qrcode;
  if (typeof lib !== "function") {
    box.replaceChildren(el("p", { class: "small muted" }, "The QR code couldn't be drawn. Copy the link instead."));
    return;
  }
  const qr = lib(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount(), quiet = 4, size = n + quiet * 2;
  let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", label);
  svg.setAttribute("shape-rendering", "crispEdges");
  const bg = document.createElementNS(SVG_NS, "rect");
  bg.setAttribute("width", size); bg.setAttribute("height", size); bg.setAttribute("fill", "#fff");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", d); path.setAttribute("fill", "#07120c");
  svg.append(bg, path);
  box.replaceChildren(svg);
}
/** A QR-code glyph (the shared icon sprite has none). */
export function qrGlyph() {
  const svg = document.createElementNS(SVG_NS, "svg");
  for (const [k, v] of [["class", "i"], ["viewBox", "0 0 24 24"], ["aria-hidden", "true"], ["fill", "none"], ["stroke", "currentColor"], ["stroke-width", "1.8"], ["stroke-linecap", "round"], ["stroke-linejoin", "round"]]) svg.setAttribute(k, v);
  const p = document.createElementNS(SVG_NS, "path");
  p.setAttribute("d", "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2.5v2.5H14zM18.5 14h1.5M20 18v2h-2M14 20h1.5");
  svg.append(p);
  return svg;
}
/** "Show QR code ▾": the code is drawn on the first open, never before. caption: a line under it. */
export function qrDisclosure(text, label, { caption = null, size = "" } = {}) {
  return disclosure({
    cls: "dc-qr", compact: true, lead: qrGlyph(), more: "Show QR code", moreOpen: "Hide QR code",
    render: (inner) => {
      const box = el("div", { class: `nt-qr${size ? " " + size : ""}` });
      drawQr(box, text, label);
      inner.replaceChildren(box, caption ? el("p", { class: "micro muted dc-qr-cap" }, caption) : null);
    },
  });
}

/**
 * Share · Copy link (or Copy link · WhatsApp where the browser can't share), with the link shown above and an optional
 * QR disclosure below. opts: { url, title, text, whatsappText, copyLabel, qrLabel, qrCaption, qr = true, link = true }.
 */
export function shareRow(opts) {
  const { url, title = "LokalPay", text = "", copyLabel = "Link copied" } = opts;
  const buttons = shareActions(canWebShare()).map((kind, i) => {
    const cls = `btn ${i === 0 ? "btn-primary" : "btn-secondary"} btn-sm`;
    if (kind === "copy") return el("button", { class: cls, type: "button", dataset: { copy: url, copyLabel } }, icon("copy"), "Copy link");
    if (kind === "whatsapp") return el("a", { class: cls, href: "https://wa.me/?text=" + encodeURIComponent(opts.whatsappText ?? `${text} ${url}`.trim()), target: "_blank", rel: "noopener" }, "WhatsApp", icon("ext"));
    const b = el("button", { class: cls, type: "button" }, shareGlyph(), "Share");
    b.addEventListener("click", async () => {
      try { await navigator.share({ title, text, url }); }
      catch (e) { if (shareFallback(e) === "copy") copyText(url, copyLabel); }
    });
    return b;
  });
  return el("div", { class: "nt-share" },
    opts.link === false ? null : el("a", { class: "nt-linkfield", href: url, title: "Open the link" }, el("span", {}, url.replace(/^https?:\/\//, ""))),
    el("div", { class: "row nt-share-btns" }, buttons),
    opts.qr === false ? null : qrDisclosure(url, opts.qrLabel ?? "QR code of the link", { caption: opts.qrCaption ?? null }).el);
}
/** The "share" glyph (an arrow out of a tray). */
function shareGlyph() {
  const svg = document.createElementNS(SVG_NS, "svg");
  for (const [k, v] of [["class", "i"], ["viewBox", "0 0 24 24"], ["aria-hidden", "true"], ["fill", "none"], ["stroke", "currentColor"], ["stroke-width", "1.9"], ["stroke-linecap", "round"], ["stroke-linejoin", "round"]]) svg.setAttribute(k, v);
  const p = document.createElementNS(SVG_NS, "path");
  p.setAttribute("d", "M12 15V4M8 8l4-4 4 4M5 13v5.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V13");
  svg.append(p);
  return svg;
}

// ---------- "They receive: Naira · Change" ----------
/**
 * Wraps a currencyPicker (assets/currency-ui.js) in one line with a Change button that opens the full picker inline.
 * opts: { picker, label = "They receive", id }. Returns { el, refresh(), open(), close() }; call refresh() after a change.
 */
export function currencyChoice({ picker, label = "They receive", id } = {}) {
  const pid = id ?? `cc-${++ids}`;
  const name = el("b", { class: "cc-name" });
  const flag = el("span", { class: "cc-flag" });
  const btn = el("button", { class: "linklike cc-change", type: "button", "aria-expanded": "false", "aria-controls": pid }, "Change");
  const panel = el("div", { class: "dc-panel cc-panel", id: pid, hidden: true }, el("div", { class: "dc-inner" }, picker.el));
  const line = el("p", { class: "cc-line" }, el("span", { class: "cc-label" }, label + ":"), flag, name, el("span", { class: "cc-dot", "aria-hidden": "true" }, "·"), btn);
  const api = wireDisclosure(btn, panel, { onToggle: (open) => { btn.textContent = open ? "Done" : "Change"; btn.setAttribute("aria-label", choiceButtonLabel({ open, label, code: picker.value })); } });
  const refresh = () => {
    name.textContent = receiveName(picker.value);
    flag.replaceChildren(el("span", { class: `cur-flag cur-flag-${picker.value === "usdt" ? "usd" : picker.value}`, "aria-hidden": "true" }));
    if (!api.isOpen()) btn.setAttribute("aria-label", choiceButtonLabel({ open: false, label, code: picker.value }));
  };
  refresh();
  return { el: el("div", { class: "cc" }, line, panel), refresh, open: api.open, close: api.close };
}

// ---------- the calm confirmation ----------
/**
 * The success state: a big round mark (spinner while pending, check when done, cross on failure), one headline, one
 * sentence, the actions (Done, a receipt or status link) and the technical rows folded into Details.
 * Returns { el, heading, set({ state, title, text, actions, alert }), details (the Details panel's inner node) }.
 */
export function successPanel({ detailsLabel = "Details" } = {}) {
  const mark = el("span", { class: "ok-mark", "aria-hidden": "true" });
  const heading = el("h3", { class: "ok-title", tabindex: "-1" });
  const text = el("p", { class: "ok-text", role: "status" });
  const alert = el("div", { class: "ok-alert", "aria-live": "polite" });
  const actions = el("div", { class: "ok-actions" });
  const details = disclosure({ more: detailsLabel, cls: "ok-details", compact: true });
  const root = el("div", { class: "ok-panel" }, mark, heading, text, alert, actions, details.el);
  return {
    el: root, heading, details: details.inner,
    set({ state, title, text: t, actions: acts, alert: al } = {}) {
      if (state && root.dataset.state !== state) {
        root.dataset.state = state;
        mark.replaceChildren(state === "pending" ? "" : state === "failed" ? icon("x") : state === "held" ? icon("alert") : icon("check"));
      }
      if (title != null) heading.textContent = title;
      // the sentence and the alert are live regions: the same words again are not re-announced (pages poll every 10 s)
      const words = (nodes) => nodes.map((n) => (typeof n === "string" ? n : n?.textContent ?? "")).join("");
      if (t != null) { const next = [].concat(t); if (!next.every((n) => typeof n === "string") || words(next) !== text.textContent) text.replaceChildren(...next); }
      if (al !== undefined) { const next = [].concat(al ?? []), w = words(next); if (!w || w !== alert.textContent) alert.replaceChildren(...next); }
      // the same buttons stay where they are, so keyboard focus on one survives an update
      if (acts) { const next = acts.filter(Boolean); if (next.length !== actions.childNodes.length || next.some((n, i) => actions.childNodes[i] !== n)) actions.replaceChildren(...next); }
    },
  };
}
