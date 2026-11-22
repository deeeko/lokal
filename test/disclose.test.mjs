// The calm payment screens (site/assets/disclose.js): which information is always in view, the one-line summaries
// that stand in for folded tables, and the share fallback. The pure helpers only; the DOM pieces are seen in
// scripts/screenshots-simple.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  SAFETY_CRITICAL, ON_DEMAND, alwaysShown, summaryLine, rateSummary, limitsSummary, tagAgeText, trustSummary, trustMustShow,
  receiveName, defaultReceive, canWebShare, shareActions, shareFallback, successHeadline, unknownChecksText, expiryBadge,
  choiceButtonLabel,
} from "../site/assets/disclose.js";
import { assessTag, agoText } from "../site/assets/trust.js";

const NOW = 1_800_000_000;
const DAY = 86_400;
const OWNER = "0x7b3D1e9a0C2f4E5d6A7b8C9d0E1f2A3b4C5d6E7f";

test("safety-critical information is always shown; optional details wait; anything unknown is shown", () => {
  for (const k of ["receive-amount", "pay-button", "warning", "refusal", "error"]) {
    assert.ok(SAFETY_CRITICAL.includes(k), k);
    assert.equal(alwaysShown(k), true, k);
  }
  for (const k of ["rate", "fees", "route", "limits", "qr", "settings", "tx-details", "owner", "history"]) assert.equal(alwaysShown(k), false, k);
  assert.equal(alwaysShown("something-new"), true, "when in doubt, show it");
  for (const k of SAFETY_CRITICAL) assert.ok(!ON_DEMAND.includes(k), `${k} can't be both`);
});

test("summaryLine joins the parts with a middle dot and drops empty ones", () => {
  assert.equal(summaryLine(["1 USD₮ = ₦1,444", "fees included"]), "1 USD₮ = ₦1,444 · fees included");
  assert.equal(summaryLine(["@ada", null, "", "  ", undefined, "paid once"]), "@ada · paid once");
  assert.equal(summaryLine([]), "");
});

test("rateSummary folds the rate and the fees into one line", () => {
  assert.equal(rateSummary({ rateText: "1 USD₮ = ₦1,440.77", fees: "included" }), "1 USD₮ = ₦1,440.77 · fees included");
  assert.equal(rateSummary({ rateText: "1 USD₮ = ₦1,440.77", fees: "before" }), "1 USD₮ = ₦1,440.77 · before fees");
  assert.equal(rateSummary({ rateText: "Rate unavailable" }), "Rate unavailable");
  assert.equal(rateSummary({ rateText: "—", fees: "included" }), "Rate loading…");
  assert.equal(rateSummary(), "Rate loading…");
});

test("limitsSummary: one payment's cap, or today's smaller room", () => {
  assert.equal(limitsSummary({ capUsd: 25 }), "Up to $25");
  assert.equal(limitsSummary({ capUsd: 25, roomUsd: 25 }), "Up to $25");
  assert.equal(limitsSummary({ capUsd: 25, roomUsd: 40 }), "Up to $25");
  assert.equal(limitsSummary({ capUsd: 25, roomUsd: 12.5 }), "Up to about $12.50 today");
  assert.equal(limitsSummary({ capUsd: 25, roomUsd: 5, exact: true }), "Up to $5 today");
  assert.equal(limitsSummary({ capUsd: 25, roomUsd: 12.999 }), "Up to about $12.99 today", "rounded down, never up");
  assert.equal(limitsSummary({ capUsd: 25, roomUsd: 0.4 }), "No room left today");
  assert.equal(limitsSummary({ capUsd: 25, roomUsd: NaN }), "Up to $25");
  // a room that couldn't be read is said in the line itself, never only behind "Limits"
  assert.equal(limitsSummary({ capUsd: 25, unchecked: true }), "Up to $25 · couldn't check today's limit");
  assert.equal(limitsSummary({ capUsd: 25, roomUsd: 12.5, unchecked: true }), "Up to about $12.50 today · couldn't check today's limit");
});

test("expiryBadge keeps the time left in view, rounded down, a warning under 10 minutes", () => {
  const MIN = 60_000, HOUR = 60 * MIN;
  assert.deepEqual(expiryBadge(47 * HOUR + 59 * MIN), { text: "Open · 1 d left", kind: "neutral" });
  assert.deepEqual(expiryBadge(5 * HOUR + 30 * MIN), { text: "Open · 5 h left", kind: "neutral" });
  assert.deepEqual(expiryBadge(59 * MIN + 59_000), { text: "Open · 59 min left", kind: "neutral" });
  assert.deepEqual(expiryBadge(10 * MIN), { text: "Open · 10 min left", kind: "neutral" });
  assert.deepEqual(expiryBadge(10 * MIN - 1000), { text: "Open · 9 min left", kind: "warn" });
  assert.deepEqual(expiryBadge(59_999), { text: "Open · under 1 min left", kind: "warn" });
  assert.deepEqual(expiryBadge(20_000), { text: "Open · under 1 min left", kind: "warn" });
  for (const ms of [999, 0, -5000, NaN]) assert.deepEqual(expiryBadge(ms), { text: "Expired", kind: "err" }, String(ms));
});

test("tagAgeText turns trust.js agoText into a tag's age", () => {
  assert.equal(tagAgeText(agoText(NOW - 41 * DAY, NOW)), "tag 41 days old");
  assert.equal(tagAgeText(agoText(NOW - 5 * 3600, NOW)), "tag 5 hours old");
  assert.equal(tagAgeText(agoText(NOW - 10, NOW)), "tag claimed just now");
  assert.equal(tagAgeText(null), null);
});

/** A contract tag claimed `ageDays` ago that was paid `paid` times; paidTags: what this browser paid before. */
function assess({ tag = "ada", ageDays = 41, paid = 4, paidTags = ["ada"], consent = true } = {}) {
  const since = NOW - ageDays * DAY;
  const events = [{ type: "claimed", owner: OWNER, time: since }, ...Array.from({ length: paid }, (_, i) => ({ type: "paid", owner: OWNER, time: since + (i + 1) * 3600 }))];
  return assessTag({ tag, entry: { owner: OWNER, since, name: "Ada", source: "contract" }, history: { events, complete: true, capped: false },
    legacyClaims: [], paid: { consent, tags: paidTags }, nowSec: NOW });
}
const agoOf = (a) => (a.age.since ? a.age.text.replace(/^Claimed /, "") : null);

test("Who am I paying?: one line with a check when every check passes", () => {
  const a = assess();
  assert.equal(a.warnings.length, 0);
  assert.equal(trustMustShow(a), false);
  assert.deepEqual(trustSummary("ada", a, agoOf(a)), { text: "@ada · tag 41 days old · paid 4 times", ok: true });
  const once = assess({ paid: 1 });
  assert.equal(trustSummary("ada", once, agoOf(once)).text, "@ada · tag 41 days old · paid once");
  const none = assess({ paid: 0 });
  assert.equal(trustSummary("ada", none, agoOf(none)).text, "@ada · tag 41 days old · not paid through Lokal yet");
});

test("Who am I paying?: any warning keeps the card open, and the line never claims all is well", () => {
  const first = assess({ tag: "bola", paidTags: ["ada"], ageDays: 41 }); // never paid @bola from this browser
  assert.ok(first.warnings.some((w) => w.id === "first"));
  assert.equal(trustMustShow(first), true);
  assert.equal(trustSummary("bola", first, agoOf(first)).ok, false);
  const fresh = assess({ tag: "ada", ageDays: 0.2, paid: 0 }); // claimed hours ago
  assert.ok(fresh.warnings.some((w) => w.id === "new"));
  assert.equal(trustMustShow(fresh), true);
  // checks that couldn't run are said, and they take the check mark away too
  const noConsent = assess({ consent: false, paidTags: [] });
  const line = trustSummary("ada", noConsent, agoOf(noConsent));
  assert.equal(line.ok, false);
  assert.match(line.text, /couldn't run/);
  assert.equal(trustSummary("ada", null).ok, false);
});

test("Who am I paying?: the checks that couldn't run are named, for the line that is always in view", () => {
  assert.equal(unknownChecksText(assess()), null, "every check ran");
  const noConsent = assess({ consent: false, paidTags: [] });
  assert.ok(noConsent.warnings.length, "the first-time warning shows too");
  assert.equal(unknownChecksText(noConsent), "Couldn't check: tags you've paid.");
  // a tag claimed 3 days ago whose holder history couldn't be read: owner and name changes are unknown
  const since = NOW - 3 * DAY;
  const blind = assessTag({ tag: "ada", entry: { owner: OWNER, since, name: "Ada", source: "contract" }, history: null, legacyClaims: null,
    paid: { consent: false, tags: [] }, nowSec: NOW });
  assert.equal(unknownChecksText(blind), "Couldn't check: owner changes, tags you've paid, name changes.");
  assert.equal(unknownChecksText(null), null);
  const read = (f) => fs.readFileSync(new URL(`../site/${f}`, import.meta.url), "utf8");
  // the tag page puts that line outside the folded "Who am I paying?" facts, next to the warnings or under the line
  const tag = read("js/tag.js");
  assert.match(tag, /a\.warnings\.map\(warn\)\), unknownLine\)/);
  assert.match(tag, /\}\)\.el, unknownLine\]\.filter\(Boolean\)/);
});

test("the currency line: names and the starting choice (the recipient's preference, else naira)", () => {
  assert.equal(receiveName("cngn"), "Naira");
  assert.equal(receiveName("idrx"), "Rupiah");
  assert.equal(receiveName("wars"), "Peso (AR)");
  assert.equal(receiveName("wcop"), "Peso (CO)");
  assert.equal(receiveName("usd"), "Dollars");
  assert.equal(receiveName("usdt"), "Dollars");
  assert.equal(defaultReceive({ receive: "usdt" }), "usd");
  assert.equal(defaultReceive({ receive: "idrx", currency: "idrx" }), "idrx");
  assert.equal(defaultReceive({ currency: "wcop" }), "wcop");
  assert.equal(defaultReceive({}), "cngn");
  assert.equal(defaultReceive({ currency: "nope" }), "cngn");
  assert.equal(defaultReceive(), "cngn");
  // the Change / Done button's accessible name starts with the word on it, and names the page's own label
  assert.equal(choiceButtonLabel({ open: false, label: "They receive", code: "cngn" }), "Change (They receive: Naira)");
  assert.equal(choiceButtonLabel({ open: false, label: "You receive", code: "usd" }), "Change (You receive: Dollars)");
  assert.match(choiceButtonLabel({ open: true, label: "You receive", code: "idrx" }), /^Done /);
});

test("sharing: the Web Share API where it exists, else Copy link and WhatsApp", () => {
  assert.equal(canWebShare({ share: async () => {} }), true);
  assert.equal(canWebShare({}), false);
  assert.equal(canWebShare(null), false);
  assert.deepEqual(shareActions(true), ["share", "copy"]);
  assert.deepEqual(shareActions(false), ["copy", "whatsapp"]);
  // closing the share sheet does nothing; any other failure copies the link instead
  assert.equal(shareFallback(Object.assign(new Error("cancelled"), { name: "AbortError" })), "none");
  assert.equal(shareFallback(Object.assign(new Error("no"), { name: "NotAllowedError" })), "copy");
  assert.equal(shareFallback(new TypeError("bad data")), "copy");
  assert.equal(shareFallback(undefined), "copy");
});

test("the success headline is honest about each step", () => {
  assert.equal(successHeadline({ state: "pending", amount: "10.00 USD₮", to: "@ada" }), "Sending 10.00 USD₮ to @ada…");
  assert.equal(successHeadline({ state: "done", amount: "10.00 USD₮", to: "@ada" }), "10.00 USD₮ is on its way to @ada");
  assert.equal(successHeadline({ state: "paid", to: "@ada" }), "@ada has been paid");
  assert.equal(successHeadline({ state: "failed" }), "The payment didn't go through");
  // the page already knew the payout would wait or be refused: nothing is promised
  assert.equal(successHeadline({ state: "held", amount: "10.00 USD₮", to: "@ada" }), "Sent, but @ada may not be paid yet");
  assert.doesNotMatch(successHeadline({ state: "held", amount: "10.00 USD₮", to: "@ada" }), /on its way|has been paid/);
});

test("the confirmations speak only for the payer's own payment, and link to it honestly", () => {
  const read = (f) => fs.readFileSync(new URL(`../site/${f}`, import.meta.url), "utf8");
  const pay = read("js/pay.js"), tag = read("js/tag.js");
  // verify.html only checks the attribution tag; it never shows whether the agent paid
  for (const [name, src] of [["pay.js", pay], ["tag.js", tag]]) {
    assert.doesNotMatch(src, /verify\.html\?tx=/, name);
    assert.doesNotMatch(src, /"Check status"/, name);
  }
  // the link's first matching deposit decides "paid" or "refused" only when it is this tab's own transaction
  assert.match(pay, /const mine = Boolean\(state\.deposit\) && sameAddr\(state\.deposit\.hash, p\.hash\)/);
  assert.match(pay, /else if \(state\.deposit && !mine\)/);
});

test("the pay pages draw no QR code until someone asks for one", () => {
  const read = (f) => fs.readFileSync(new URL(`../site/${f}`, import.meta.url), "utf8");
  // the payment-link page: the QR is a disclosure under "Other ways to pay"; Get paid: drawn after "Show QR code"
  assert.doesNotMatch(read("js/pay.js"), /\brenderQr\(uri\)/);
  assert.match(read("js/pay.js"), /qrDisclosure\(uri/);
  assert.doesNotMatch(read("js/get-paid.js"), /renderQr\(/);
  assert.doesNotMatch(read("get-paid.html"), /id="link-qr"/);
  // pots: no "open" QR any more, on the pot page, after creating one, or on the host's row
  assert.doesNotMatch(read("js/app.js"), /qr: "open"/);
  assert.doesNotMatch(read("assets/pot-ui.js"), /renderQr\(/);
  // and the warnings are never folded: the tag page shows every warning in full
  assert.match(read("js/tag.js"), /a warning is never folded/);
});
