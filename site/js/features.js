// features.html: everything LokalPay does, each with its honest label. A static page; this only runs the shared chrome
// (privacy choices), swaps "Sign in" for "Dashboard" when signed in, and the calm reveals on scroll.
import { $, $$, initChrome } from "../assets/core.js";
import { getSession } from "../assets/session.js";

document.documentElement.classList.add("js");
initChrome();

if (getSession()) {
  const a = $("#lp-signin");
  a.textContent = "Dashboard";
  a.href = "app.html";
}

const io = "IntersectionObserver" in window ? new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
}, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 }) : null;
for (const n of $$(".reveal, .reveal-list")) { if (io) io.observe(n); else n.classList.add("in"); }
