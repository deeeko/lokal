// The pieces of a pot that the dashboard and the public pot page both draw: the progress bar, the share block
// (link, copy, WhatsApp, QR) and the notes on the Spray Wall. DOM only inside functions; styles in pots.css.
import { el, icon, badge, currencyOf } from "./core.js";
import { renderQr, reducedMotion } from "./ntag-ui.js";
import { flagIcon } from "./currency-ui.js";
import { tokenAmountText, tokenOfCode } from "./lokal-contracts.js";
import { potProgress, potUrl, potWhatsappUrl, usd6Text, noteTilt, agoText, POT_STATE_LABEL } from "./pots.js";

/** "$42 of $100" with a bar; update(info) moves it (the fill eases unless reduced motion is on). */
export function potMeter(info, { size = "lg" } = {}) {
  const fill = el("span", { class: "pot-bar-fill" });
  const bar = el("span", { class: "pot-bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100" }, fill);
  const total = el("b", { class: "pot-total num" });
  const cap = el("span", { class: "pot-cap" });
  const root = el("div", { class: `pot-meter ${size}` }, el("div", { class: "pot-sum" }, total, cap), bar);
  const update = (i) => {
    const p = potProgress(i);
    fill.style.transform = `scaleX(${p})`;
    bar.setAttribute("aria-valuenow", String(Math.round(p * 100)));
    bar.setAttribute("aria-label", `${usd6Text(i.totalUsd6)} of ${usd6Text(i.capUsd6)} sprayed`);
    total.textContent = usd6Text(i.totalUsd6);
    cap.textContent = `of ${usd6Text(i.capUsd6)}`;
  };
  update(info);
  return { el: root, update, total };
}

/** A state badge for a pot ("Open", "Full", "Closed by the host", "Ended"). */
export const potBadge = (state) => badge(...(POT_STATE_LABEL[state] ?? ["Unknown", "neutral"]));

/** The QR-code glyph (the shared icon sprite has none). */
function qrGlyph() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  for (const [k, v] of [["class", "i"], ["viewBox", "0 0 24 24"], ["aria-hidden", "true"], ["fill", "none"], ["stroke", "currentColor"], ["stroke-width", "1.8"], ["stroke-linecap", "round"], ["stroke-linejoin", "round"]]) svg.setAttribute(k, v);
  const p = document.createElementNS(ns, "path");
  p.setAttribute("d", "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2.5v2.5H14zM18.5 14h1.5M20 18v2h-2M14 20h1.5");
  svg.append(p);
  return svg;
}

/**
 * Link field + Copy, WhatsApp, Open and a QR toggle for a pot. qr: "toggle" (a button shows it) or "open" (drawn at
 * once, larger, for the moment a pot is created).
 */
export function potShare(id, title, { qr = "toggle", openLabel = "Open pot page", open = true } = {}) {
  const url = potUrl(id);
  const qrBox = el("div", { class: `nt-qr pot-qr${qr === "open" ? " lg" : ""}`, id: `pot-qr-${id}`, hidden: qr !== "open" });
  const label = `QR code for the pot “${title}”`;
  let qrBtn = null;
  if (qr === "open") renderQr(qrBox, url, label);
  else {
    qrBtn = el("button", { class: "btn btn-ghost btn-sm", type: "button", "aria-expanded": "false", "aria-controls": `pot-qr-${id}` }, qrGlyph(), el("span", {}, "Show QR code"));
    qrBtn.addEventListener("click", () => {
      const show = qrBox.hidden;
      if (show && !qrBox.firstChild) renderQr(qrBox, url, label);
      qrBox.hidden = !show;
      qrBtn.setAttribute("aria-expanded", String(show));
      qrBtn.lastChild.textContent = show ? "Hide QR code" : "Show QR code";
    });
  }
  return el("div", { class: "nt-share pot-share" },
    qr === "open" ? qrBox : null,
    el("div", { class: "nt-linkfield" }, el("span", { title: url }, url.replace(/^https?:\/\//, "")),
      el("button", { class: "btn btn-primary btn-sm", type: "button", dataset: { copy: url, copyLabel: "Pot link copied" } }, icon("copy"), "Copy link")),
    el("div", { class: "row" },
      el("a", { class: "btn btn-wa btn-sm", href: potWhatsappUrl(title, url), target: "_blank", rel: "noopener" }, "Share on WhatsApp"),
      open ? el("a", { class: "btn btn-secondary btn-sm", href: url }, icon("right"), openLabel) : null,
      qrBtn),
    qr === "open" ? null : qrBox);
}

const PAY_LABEL = { usdt: "USD₮", cngn: "cNGN" };
/** What the host gets for a spray, in words ("naira", "dollars"), or null when the guest didn't choose. */
const receiveWord = (code) => (code === "usdt" ? "dollars" : code ? currencyOf(code)?.plural ?? null : null);

/**
 * One note on the Spray Wall: the dollar value large, what was sprayed and what the host gets, and when. No address.
 * fresh: it just landed (drops in and settles; a plain fade with reduced motion).
 */
export function sprayNote(s, nowSec, { fresh = false } = {}) {
  const tilt = noteTilt(s.key);
  const paid = s.pay && s.pay !== "usdt" ? tokenAmountText(s.amount, tokenOfCode(s.pay)).replace(/\.00$/, "") : null;
  const gets = receiveWord(s.receive);
  const n = el("li", { class: `pot-note pay-${s.pay ?? "other"}${fresh ? " is-fresh" : ""}`, style: `--tilt:${tilt}deg` },
    el("span", { class: "pot-note-amt num" }, usd6Text(s.amountUsd6)),
    el("span", { class: "pot-note-meta" },
      flagIcon(s.receive === "usdt" ? "usd" : s.receive ?? (s.pay === "cngn" ? "cngn" : "usd")),
      el("span", {}, [paid ? `${paid} ${PAY_LABEL[s.pay]}` : PAY_LABEL[s.pay] ?? "Token", gets ? `→ ${gets}` : null].filter(Boolean).join(" ")),
    ),
    el("span", { class: "pot-note-time micro", dataset: { time: s.time ?? "" } }, s.time ? agoText(s.time, nowSec) : "On Celo"));
  n.setAttribute("aria-label", `${usd6Text(s.amountUsd6)} sprayed${paid ? ` as ${paid}` : ""}${gets ? `, the host gets ${gets}` : ""}${s.time ? `, ${agoText(s.time, nowSec)}` : ""}`);
  return n;
}

/**
 * The celebration when a spray lands: a handful of small notes flutter down over the wall and are removed. Nothing
 * at all with reduced motion (the new note simply fades in).
 */
export function flutter(host, count = 7) {
  if (reducedMotion() || !host) return;
  const layer = el("div", { class: "pot-flutter", "aria-hidden": "true" });
  for (let i = 0; i < count; i++) {
    const x = 6 + ((i * 37) % 88);
    const d = (i % 4) * 90;
    const r = ((i * 53) % 50) - 25;
    layer.append(el("span", { style: `--x:${x}%;--d:${d}ms;--r:${r}` }));
  }
  host.append(layer);
  setTimeout(() => layer.remove(), 2200);
}
