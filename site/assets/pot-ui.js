// The pieces of a pot that the dashboard and the public pot page both draw: the progress bar, the share block
// (Share · Copy link, and the QR code on demand) and the notes on the Spray Wall. DOM only inside functions; styles in pots.css.
import { el, badge, currencyOf } from "./core.js";
import { reducedMotion } from "./ntag-ui.js";
import { shareRow } from "./disclose.js";
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

/**
 * A pot's link: Share · Copy link (Copy link · WhatsApp where the browser can't share), and "Show QR code", drawn only
 * when someone opens it (also right after a pot is created: the host asks for the QR when the guests are there).
 * opts.link: false leaves out the link line (a host's pot row already links the pot).
 */
export function potShare(id, title, { link = true } = {}) {
  const url = potUrl(id);
  const text = `${title}: spray in dollars or naira on Celo, from any wallet.`;
  const wa = decodeURIComponent(potWhatsappUrl(title, url).split("?text=")[1]);
  const node = shareRow({ url, title, text, whatsappText: wa, copyLabel: "Pot link copied", link,
    qrLabel: `QR code for the pot “${title}”`, qrCaption: "Guests scan this to open the pot." });
  node.classList.add("pot-share");
  return node;
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

/**
 * "Delete pot?": a modal confirm (a native <dialog>, so focus stays inside it and the page behind is inert).
 * Focus starts on the safe choice (keep it); Esc, the cancel button or a click on the backdrop cancel. Resolves true
 * only for the confirm button. Focus goes back to `returnTo` (the button that opened it) when it closes.
 * copy: { heading, body: [paragraphs], note, confirm, cancel } (deleteConfirmCopy in pots-hidden.js).
 */
export function confirmDelete(copy, returnTo) {
  return new Promise((resolve) => {
    const id = `pot-del-${Math.random().toString(36).slice(2, 8)}`;
    const cancel = el("button", { class: "btn btn-secondary", type: "button" }, copy.cancel);
    const ok = el("button", { class: "btn btn-danger", type: "button" }, copy.confirm);
    const dlg = el("dialog", { class: "pot-dialog", "aria-labelledby": `${id}-h`, "aria-describedby": `${id}-b` },
      el("div", { class: "pot-dialog-in" },
        el("h2", { class: "pot-dialog-h", id: `${id}-h` }, el("bdi", {}, copy.heading)),
        el("div", { class: "pot-dialog-b", id: `${id}-b` }, copy.body.map((t) => el("p", {}, t))),
        copy.note ? el("p", { class: "micro muted" }, copy.note) : null,
        el("div", { class: "pot-dialog-f" }, cancel, ok)));
    if (reducedMotion()) dlg.classList.add("no-motion");
    let result = false;
    const done = (v) => { result = v; if (dlg.open) dlg.close(); };
    cancel.addEventListener("click", () => done(false));
    ok.addEventListener("click", () => done(true));
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); done(false); }); // Esc
    dlg.addEventListener("click", (e) => { if (e.target === dlg) done(false); }); // the backdrop
    dlg.addEventListener("close", () => {
      dlg.remove();
      if (returnTo?.isConnected) returnTo.focus();
      resolve(result);
    }, { once: true });
    document.body.append(dlg);
    dlg.showModal();
    cancel.focus();
  });
}
