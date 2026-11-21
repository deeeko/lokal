// The currency picker: "what do they receive?" as flag + name chips (Naira · Rupiah · Peso (AR) · Peso (CO)).
// One component for every page that takes or shows a payment (Overview, Send, a tag's pay page, Get paid, Account).
//   - A radio group: one Tab stop, arrow keys / Home / End move and select, Space / Enter select.
//   - A currency Textile FX isn't quoting right now is greyed out and can't be picked; the note under the chips says so.
//     The note line is always there (reserved height), so nothing jumps when rates load.
//   - Remembers the last choice on this device, only if the visitor said "Sure" to remembering preferences
//     (the same rule as the sidebar layout; see privacy.html). Storage failures are ignored.
//   - Flags are drawn with CSS (emoji flags don't render on Windows), and old browsers are fine (no .at(), no new APIs).
import { CURRENCIES, currencyOf, el, formatCurrency, getConsent } from "./core.js";

export const CURRENCY_KEY = "np-currency";
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** The last currency picked on this device (only stored with consent), or null. */
export function lastCurrency() {
  try { const v = localStorage.getItem(CURRENCY_KEY); return v && currencyOf(v) ? v : null; } catch { return null; }
}
/** Remembers a choice, only if preferences may be saved (privacy choice "Sure"). */
export function rememberCurrency(code) {
  if (!currencyOf(code) || getConsent() !== "accepted") return;
  try { localStorage.setItem(CURRENCY_KEY, code); } catch { /* storage blocked: nothing remembered */ }
}

/** A small CSS-drawn flag (or a "$" badge for dollars). Decorative: the chip's text names the currency. */
export function flagIcon(code) {
  return el("span", { class: `cur-flag cur-flag-${code}`, "aria-hidden": "true" });
}

/** "₦14,443.65" for a number of local money (rounded down), or "—". */
export const money = (n, code) => formatCurrency(n, code);

/**
 * Builds a picker. opts:
 *   label       accessible name of the group ("What does @ada receive?")
 *   value       the code selected at first (falls back to the remembered one, then naira)
 *   extra       more options after the four currencies, e.g. [{ code: "usd", label: "Dollars", flag: "usd" }]
 *   remember    false to not read or save the device's last choice (e.g. a link whose currency is fixed)
 *   onChange    (code, { user }) => void, called when the selection changes
 *   describedBy id of an element that explains the choice (added to aria-describedby with the note)
 * Returns { el, value (getter), set(code, { silent }), setAvailability({ code: true | false }), note(text) }.
 */
let pickers = 0;
export function currencyPicker(opts = {}) {
  const id = `cur-${++pickers}`;
  const options = [
    ...CURRENCIES.map((c) => ({ code: c.code, label: c.label, title: `${c.name} (${c.token})` })),
    ...(opts.extra ?? []),
  ];
  const remember = opts.remember !== false;
  const start = [opts.value, remember ? lastCurrency() : null, "cngn"].find((c) => c && options.some((o) => o.code === c));
  let value = start;
  let off = {}; // code -> true when not available right now
  let userNote = "";

  const note = el("p", { class: "cur-note hint", id: `${id}-note`, "aria-live": "polite" });
  const buttons = options.map((o) => {
    const b = el("button", {
      type: "button", role: "radio", class: "cur-chip", dataset: { code: o.code }, title: o.title ?? o.label,
      "aria-checked": String(o.code === value), tabindex: o.code === value ? "0" : "-1",
    }, flagIcon(o.flag ?? o.code), el("span", { class: "cur-name" }, o.label));
    b.addEventListener("click", () => choose(o.code, true));
    return b;
  });
  const group = el("div", {
    class: "segmented cur-picker", role: "radiogroup", id,
    "aria-label": opts.label ?? "What they receive",
    "aria-describedby": [opts.describedBy, `${id}-note`].filter(Boolean).join(" "),
  }, buttons);
  const root = el("div", { class: "cur-field" }, group, note);

  group.addEventListener("keydown", (e) => {
    const keys = ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    const usable = buttons.filter((b) => !off[b.dataset.code]);
    if (!usable.length) return;
    const at = Math.max(0, usable.indexOf(document.activeElement));
    let next;
    if (e.key === "Home") next = usable[0];
    else if (e.key === "End") next = usable[usable.length - 1];
    else {
      const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1;
      next = usable[(at + step + usable.length) % usable.length];
    }
    next.focus();
    choose(next.dataset.code, true);
  });

  function paint() {
    for (const b of buttons) {
      const code = b.dataset.code;
      const sel = code === value;
      b.setAttribute("aria-checked", String(sel));
      b.tabIndex = sel ? 0 : -1;
      if (off[code]) { b.setAttribute("aria-disabled", "true"); b.classList.add("off"); }
      else { b.removeAttribute("aria-disabled"); b.classList.remove("off"); }
      const o = options.find((x) => x.code === code);
      b.title = off[code] ? `${o.label}: not available right now` : o.title ?? o.label;
    }
    const downs = options.filter((o) => off[o.code]).map((o) => o.label);
    const offText = downs.length ? `${downs.join(" and ")}: not available right now.` : "";
    note.textContent = [userNote, offText].filter(Boolean).join(" ") || " ";
  }
  function choose(code, user) {
    if (!options.some((o) => o.code === code) || off[code]) return;
    const changed = code !== value;
    value = code;
    paint();
    if (user && remember && currencyOf(code)) rememberCurrency(code);
    if (changed) opts.onChange?.(code, { user: Boolean(user) });
  }
  paint();

  return {
    el: root,
    group,
    get value() { return value; },
    /** Selects `code` (ignored when unknown or unavailable). silent: no onChange. */
    set(code, { silent = false } = {}) {
      if (!options.some((o) => o.code === code) || off[code]) return;
      const changed = code !== value;
      value = code;
      paint();
      if (changed && !silent) opts.onChange?.(code, { user: false });
    },
    /** Greys out what isn't quoting ({ idrx: false }). If the selection becomes unavailable it stays selected but marked. */
    setAvailability(map = {}) {
      off = {};
      for (const o of options) if (has(map, o.code) && map[o.code] === false) off[o.code] = true;
      paint();
    },
    /** A short line under the chips (e.g. "@ada prefers rupiah."). */
    note(text) { userNote = text ? String(text) : ""; paint(); },
    isAvailable: (code) => !off[code],
  };
}
