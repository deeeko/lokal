// Who sees what. The few rules that decide what a visitor and a signed-in person see, kept pure so they are tested
// in Node (test/front-door.test.mjs):
//   - "/" (the landing): signed in on this device -> the dashboard (assets/gate.js, a classic script in <head>).
//   - Activity: visitors see a sign-in prompt, never the agent's feed or anyone's address; a signed-in wallet sees only
//     its own payments.
//   - The dashboard: signed out -> a sign-in panel (it never redirects, so it can't bounce with the landing);
//     signed in without a tag -> "claim your tag"; with a tag -> the full dashboard.
//   - The sign-up gateway: starts at the first step that isn't done yet.
// Public pages (a tag's pay page, payment links, quote, receipts, verify, cash-out, docs, privacy, terms, agent) are
// never gated: payers must be able to pay in seconds, without an account.

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const signedIn = (session) => Boolean(session && ADDR.test(String(session.address)));

/** Pages anyone can open without signing in. */
export const PUBLIC_PAGES = Object.freeze(["index.html", "start.html", "tag.html", "pay.html", "quote.html", "receipt.html", "verify.html",
  "cash-out.html", "docs.html", "privacy.html", "terms.html", "agent.html", "autopilot.html", "get-paid.html", "404.html"]);
/** Pages whose content is only for the signed-in wallet (they show a sign-in prompt otherwise, never a redirect loop). */
export const SIGNED_IN_PAGES = Object.freeze(["app.html", "transactions.html", "account.html"]);

/** Activity shows rows only to a signed-in wallet (and only that wallet's own rows). */
export const activityVisible = (session) => signedIn(session);

/** What the dashboard shows: "signed-out" | "loading" | "no-tag" | "tag". tag: undefined while unknown, null when none. */
export function dashboardView(session, tag) {
  if (!signedIn(session)) return "signed-out";
  if (tag === undefined) return "loading";
  return tag ? "tag" : "no-tag";
}

/**
 * The gateway's first open step: "connect" (no wallet account yet) | "sign" (connected, not signed in as it) |
 * "tag" (signed in, no tag) | "welcome" (signed in and already holds a tag).
 * account: the wallet's current account (or null); tag: undefined while unknown, null when none.
 */
export function gatewayStep({ session = null, account = null, tag } = {}) {
  if (signedIn(session) && (!account || account.toLowerCase() === session.address.toLowerCase())) {
    if (tag === undefined) return "tag"; // still checking: the tag step shows the check
    return tag ? "welcome" : "tag";
  }
  return account && ADDR.test(account) ? "sign" : "connect";
}

/** The gateway's steps, in order, as the progress indicator shows them. */
export const GATEWAY_STEPS = Object.freeze([
  { id: "connect", label: "Connect" },
  { id: "sign", label: "Sign in" },
  { id: "tag", label: "Your tag" },
  { id: "name", label: "Your name" },
]);
