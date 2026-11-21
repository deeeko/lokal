// Cash out guide: the shared chrome (consent, sidebar, nav, copy buttons via data-copy) plus the currency switcher.
// Without JavaScript every currency is shown, one after another, and the switcher links jump to each one.
// With it, only the chosen currency is shown; the choice lives in the URL hash (cash-out.html#rupiah) so it can be shared.
import { initChrome, $$ } from "../assets/core.js";

initChrome();

const panels = $$("[data-currency]");
const links = $$(".co-switch a");
const ids = panels.map((p) => p.id);
const DEFAULT = ids[0];

function show(id) {
  for (const p of panels) p.hidden = p.id !== id;
  for (const a of links) {
    if (a.getAttribute("href") === `#${id}`) a.setAttribute("aria-current", "true");
    else a.removeAttribute("aria-current");
  }
}

const fromHash = () => {
  const id = decodeURIComponent(location.hash.slice(1));
  return ids.includes(id) ? id : null;
};

if (panels.length) {
  show(fromHash() ?? DEFAULT);

  for (const a of links) {
    a.addEventListener("click", (e) => {
      const id = a.getAttribute("href").slice(1);
      if (!ids.includes(id)) return;
      e.preventDefault(); // switch in place: no jump past the safety notes
      show(id);
      history.replaceState(null, "", `#${id}`);
    });
  }

  // a shared link or the back button can change the hash after load
  addEventListener("hashchange", () => { const id = fromHash(); if (id) show(id); });
}
