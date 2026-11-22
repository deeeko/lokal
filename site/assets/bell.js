// The notification bell: top right, next to the account menu, for a signed-in wallet only. A small badge counts the
// incoming payments since the dropdown was last opened (1–9, then 9+); the dropdown lists the latest five, one line
// each with a muted time, and links to the page with the full story. The data and the rules are in
// assets/notifications.js (tested in Node); this file only draws them.
//
// Where it sits: the app top bar's slot (#nav-bell, copied to every app page by scripts/sync-chrome.mjs; on desktop,
// where the sidebar replaces the top bar, the slot alone stays visible at the top right), and the landing, Features and
// Proof top bars (.lp-cta) when a session exists. Loaded by initChrome (assets/core.js) on its own, so a failure here
// never breaks a page.
import { el, icon } from "./core.js";
import { getSession, onSessionChange, watchSession } from "./session.js";
import { bellVisible } from "./front-door.js";
import { agoText } from "./pots.js";
import {
  SHOWN, POLL_MS, loadNotifications, readSeen, markSeen, unreadCount, badgeText, bellLabel, newestTime, createPoller,
} from "./notifications.js";

const NS = "http://www.w3.org/2000/svg";
/** A small line icon from path data (the bell's own icons, so no page has to add them to its sprite). */
function lineIcon(paths, cls = "i") {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", cls);
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
}
const ICONS = {
  bell: ["M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z", "M10 21a2.2 2.2 0 0 0 4 0"],
  payout: ["M12 4v11", "m7 10 5 5 5-5", "M5 20h14"],
  tag: ["M15.5 12a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0z", "M15.5 12v1.3a2.6 2.6 0 0 0 5.2 0V12a8.7 8.7 0 1 0-3.5 7"],
  pot: ["M12 3.5v3.5", "M12 17v3.5", "M3.5 12H7", "M17 12h3.5", "m6 6 2.3 2.3", "m15.7 15.7 2.3 2.3", "m18 6-2.3 2.3", "M8.3 15.7 6 18"],
  refund: ["M9 14 4 9l5-5", "M4 9h10.5a5.5 5.5 0 0 1 0 11H11"],
};
const storage = () => { try { return globalThis.localStorage ?? null; } catch { return null; } };
const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Finds (or makes) the bell's slot: the app top bar's #nav-bell, or a new one at the start of the landing's .lp-cta (next to #lp-signin). */
function slot() {
  const s = document.getElementById("nav-bell");
  if (s) return s;
  const cta = document.getElementById("lp-signin")?.closest(".lp-cta"); // landing, Features, Proof (not the gateway)
  if (!cta) return null;
  const n = el("div", { class: "nav-bell lp-bell", id: "nav-bell", hidden: true });
  cta.prepend(n);
  return n;
}

export function initBell() {
  if (typeof document === "undefined") return;
  const root = slot();
  if (!root) return;
  const B = { address: null, items: null, failed: false, loading: false, open: false, seenAtOpen: null, lastCount: null, poller: null };

  const button = el("button", { class: "np-bell", type: "button", "aria-haspopup": "true", "aria-expanded": "false", "aria-controls": "np-bell-panel", "aria-label": bellLabel(0) },
    lineIcon(ICONS.bell, "i np-bell-icon"));
  const badge = el("span", { class: "np-bell-badge", "aria-hidden": "true", hidden: true });
  button.append(badge);
  const list = el("div", { class: "np-bell-body" });
  const panel = el("div", { class: "np-bell-panel", id: "np-bell-panel", role: "region", "aria-label": "Notifications", hidden: true },
    el("div", { class: "np-bell-head" }, el("b", {}, "Notifications"), el("span", {}, "Payments to you")),
    list,
    el("a", { class: "text-link np-bell-foot", href: "transactions.html" }, "See all activity", el("span", { class: "arrow", "aria-hidden": "true" }, "→")));

  const seen = () => (B.address ? readSeen(storage(), B.address) : null);
  function paintBadge() {
    const n = B.items ? unreadCount(B.items, seen()) : 0;
    const text = badgeText(n);
    badge.textContent = text;
    badge.hidden = !text;
    button.setAttribute("aria-label", bellLabel(n));
    // a gentle swing when something new arrives while the page is open (not on the first check)
    if (B.lastCount != null && n > B.lastCount && !reduced()) {
      button.classList.remove("ring");
      void button.offsetWidth;
      button.classList.add("ring");
    }
    B.lastCount = n;
  }
  function paintList() {
    if (!B.items) {
      list.replaceChildren(B.failed
        ? el("p", { class: "np-bell-note" }, "Couldn't check right now.")
        : el("p", { class: "np-bell-note", role: "status" }, el("span", { class: "skel" }), " Checking…"));
      return;
    }
    if (!B.items.length) {
      list.replaceChildren(el("p", { class: "np-bell-note" }, "Nothing new yet. Payments to you show up here."));
      return;
    }
    const nowSec = Date.now() / 1000;
    const isNew = (i) => B.seenAtOpen === undefined ? false : B.seenAtOpen == null || (i.time ?? 0) > B.seenAtOpen;
    list.replaceChildren(el("ul", { class: "np-bell-list" }, B.items.slice(0, SHOWN).map((i) => {
      const fresh = isNew(i);
      return el("li", {}, el("a", { class: `np-bell-item${fresh ? " is-new" : ""}`, href: i.href, ...(i.external ? { rel: "noopener" } : {}) },
        el("span", { class: `np-bell-ic k-${i.kind}` }, lineIcon(ICONS[i.kind] ?? ICONS.payout)),
        el("span", { class: "np-bell-text" },
          el("span", { class: "np-bell-line", title: i.text }, i.text),
          el("span", { class: "np-bell-time" }, [i.time != null ? agoText(i.time, nowSec) : "", fresh ? el("span", { class: "np-bell-new", title: "New" }, el("span", { class: "sr-only" }, "New")) : null].filter(Boolean))),
        i.external ? icon("ext", "i np-bell-ext") : null));
    })));
  }

  async function check() {
    const address = B.address;
    if (!address) return;
    B.loading = true;
    try {
      const { items } = await loadNotifications(address);
      if (address !== B.address) return;
      B.items = items;
      B.failed = false;
    } catch {
      if (address !== B.address) return;
      B.failed = true; // quiet: keep what was shown before, if anything
    } finally { B.loading = false; }
    paintBadge();
    if (B.open) paintList();
  }

  function openPanel() {
    if (B.open) return;
    B.open = true;
    B.seenAtOpen = B.items ? seen() : undefined; // what was new when it opened keeps its "New" until it closes
    paintList();
    panel.hidden = false;
    button.setAttribute("aria-expanded", "true");
    if (B.items && B.address) { markSeen(storage(), B.address, newestTime(B.items) ?? Math.floor(Date.now() / 1000)); paintBadge(); }
    else if (!B.loading) B.poller?.refresh();
    (panel.querySelector(".np-bell-item") ?? panel.querySelector(".np-bell-foot"))?.focus();
  }
  function closePanel(focusBack = false) {
    if (!B.open) return;
    B.open = false;
    B.seenAtOpen = undefined;
    panel.hidden = true;
    button.setAttribute("aria-expanded", "false");
    if (focusBack) button.focus();
  }
  // open while a check lands (or opened before the first one finished): what it shows is seen
  const markIfOpen = () => {
    if (!B.open || !B.items || !B.address) return;
    if (B.seenAtOpen === undefined) B.seenAtOpen = seen();
    markSeen(storage(), B.address, newestTime(B.items) ?? Math.floor(Date.now() / 1000));
    paintBadge();
    paintList();
  };

  button.addEventListener("click", () => (B.open ? closePanel() : openPanel()));
  panel.addEventListener("click", (e) => { if (e.target.closest("a")) closePanel(); });
  panel.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const links = [...panel.querySelectorAll("a")];
    const i = links.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    links[(i + (e.key === "ArrowDown" ? 1 : links.length - 1)) % links.length].focus();
  });
  // capture phase: the account menu's button stops its click from bubbling, and opening it must still close this
  document.addEventListener("click", (e) => { if (B.open && !root.contains(e.target)) closePanel(); }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && B.open) { e.stopPropagation(); closePanel(true); } }, true);
  root.addEventListener("focusout", (e) => { if (B.open && e.relatedTarget && !root.contains(e.relatedTarget)) closePanel(); });
  button.addEventListener("animationend", () => button.classList.remove("ring"));

  const run = async () => { await check(); markIfOpen(); };
  function render() {
    const s = getSession();
    const address = bellVisible(s) ? s.address : null;
    if (address && B.address && address.toLowerCase() === B.address.toLowerCase()) return;
    B.poller?.stop();
    B.poller = null;
    closePanel();
    Object.assign(B, { address, items: null, failed: false, lastCount: null });
    if (!address) {
      root.hidden = true;
      root.replaceChildren();
      delete document.documentElement.dataset.bell;
      return;
    }
    root.replaceChildren(button, panel);
    root.hidden = false;
    document.documentElement.dataset.bell = "on";
    paintBadge();
    B.poller = createPoller({
      run, interval: POLL_MS, firstDelay: 1800, // after the page's own reads have started (they may answer for the bell)
      timers: { set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id) },
      isVisible: () => document.visibilityState !== "hidden",
      onVisibility: (cb) => { document.addEventListener("visibilitychange", cb); return () => document.removeEventListener("visibilitychange", cb); },
    });
    B.poller.start();
  }
  onSessionChange(render);
  watchSession();
  render();
}
