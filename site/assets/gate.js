// The landing's front door. Loaded as a plain (classic) script in the <head> of index.html, so it runs before the
// page paints: someone who is signed in on this device goes straight to their dashboard (app.html) instead of seeing
// the story again. "About Lokal" links (index.html?about) always show the landing.
//
// It reads the same browser storage as assets/session.js: the sign-in "np-session" (localStorage) and the
// "np-wallet-off" flag a Disconnect sets for this tab (sessionStorage). It only decides where to send the browser;
// the dashboard checks the session in full again (session.js getSession) and never sends anyone back here, so the two
// pages can never bounce between each other. Nothing is sent anywhere. Tested in test/front-door.test.mjs.
(function (root) {
  "use strict";
  var ADDR = /^0x[0-9a-fA-F]{40}$/;

  /** True when `raw` (the stored JSON) is a sign-in that is still valid at nowSec and this tab didn't disconnect. */
  function hasSession(raw, walletOff, nowSec) {
    if (walletOff === "1") return false;
    var s;
    try { s = JSON.parse(raw == null ? "null" : raw); } catch (e) { return false; }
    if (!s || typeof s !== "object" || typeof s.message !== "string" || typeof s.signature !== "string") return false;
    if (!ADDR.test(String(s.address)) || typeof s.exp !== "number" || !isFinite(s.exp) || s.exp <= nowSec) return false;
    // the signed message must name this address and expire exactly when the session says it does
    var lines = s.message.split("\n");
    if (String(lines[1]).toLowerCase() !== String(s.address).toLowerCase()) return false;
    var m = s.message.match(/\nExpiration Time: ([0-9TZ:.+-]+)$/);
    return Boolean(m) && Math.floor(Date.parse(m[1]) / 1000) === s.exp;
  }

  /** Where the landing should send this visit: "app.html", or null to stay. */
  function gateTarget(o) {
    if (/(?:^\?|&)about(?:=|&|$)/.test(String(o.search || ""))) return null;
    return hasSession(o.stored, o.walletOff, o.nowSec) ? "app.html" : null;
  }

  root.LokalGate = { hasSession: hasSession, gateTarget: gateTarget };

  if (typeof document === "undefined" || typeof location === "undefined") return;
  var stored = null, off = null;
  try { stored = root.localStorage.getItem("np-session"); } catch (e) { stored = null; }
  try { off = root.sessionStorage.getItem("np-wallet-off"); } catch (e) { off = null; }
  var to = gateTarget({ search: location.search, stored: stored, walletOff: off, nowSec: Math.floor(Date.now() / 1000) });
  if (to) location.replace(to);
})(typeof window !== "undefined" ? window : globalThis);
