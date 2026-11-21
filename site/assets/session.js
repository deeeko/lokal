// Wallet sign-in for the site. "Sign in" = connect a wallet and sign a free EIP-4361 style message with personal_sign.
// No password, no gas, nothing sent onchain. The session lives in this browser's localStorage under "np-session".
// On Vercel the signature is also checked by /api/session (stateless, stores nothing). On GitHub Pages and the local
// preview there is no server, so the signature the wallet returns is accepted as is. See docs/spec/NTAGS.md section 3.
// Everything at the top level must stay free of window/document access: api/session.js and the tests import this file.
import {
  HAS_API, el, icon, short, toast, avatarSeed, loadNtagOps, resolveNtags, ntagOf, ownerOf, timeoutSignal,
  disconnectWallet, markWalletConnected, walletDisconnected, legacyNtagOps,
} from "./core.js";
import { readTagInfo, readTagOf } from "./lokal-contracts.js";

export const SESSION_KEY = "np-session";
export const SESSION_DAYS = 7;
export const CELO_CHAIN = "0xa4ec"; // 42220
export const CELO_CHAIN_ID = 42220;
export const SIGN_IN_STATEMENT = "Sign in to Lokal. This is free and sends nothing.";
// Signed before the rename to Lokal. Still accepted, so a sign-in from then stays valid until it expires (7 days at most).
export const LEGACY_SIGN_IN_STATEMENTS = ["Sign in to Naira Payout. This is free and sends nothing."];
const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---------- the sign-in message (built here, parsed here and in api/session.js) ----------
/** The exact text the wallet signs. Times are ISO strings; nonce is 16 hex characters. */
export function buildSignInMessage({ host, origin, address, nonce, issuedAt, expiresAt }) {
  return `${host} wants you to sign in with your Ethereum account:\n${address}\n\n${SIGN_IN_STATEMENT}\n\n`
    + `URI: ${origin}\nVersion: 1\nChain ID: ${CELO_CHAIN_ID}\nNonce: ${nonce}\nIssued At: ${issuedAt}\nExpiration Time: ${expiresAt}`;
}
const MSG_RE = new RegExp("^([A-Za-z0-9.-]+(?::\\d{1,5})?) wants you to sign in with your Ethereum account:\\n(0x[0-9a-fA-F]{40})\\n\\n"
  + "(?:" + [SIGN_IN_STATEMENT, ...LEGACY_SIGN_IN_STATEMENTS].map(escapeRe).join("|") + ")\\n\\n"
  + "URI: (https?://[^\\s]+)\\nVersion: (\\d+)\\nChain ID: (\\d+)\\nNonce: ([0-9a-f]{16})\\nIssued At: ([0-9TZ:.+-]+)\\nExpiration Time: ([0-9TZ:.+-]+)$");
/**
 * Parses a sign-in message. Returns { host, address, uri, uriHost, version, chainId, nonce, issuedAt, exp } (times in
 * seconds) or null when it isn't exactly our format.
 */
export function parseSignInMessage(message) {
  if (typeof message !== "string" || message.length > 2000) return null;
  const m = message.match(MSG_RE);
  if (!m) return null;
  let uriHost;
  try { const u = new URL(m[3]); if (u.pathname !== "/" || u.search || u.hash) return null; uriHost = u.host; } catch { return null; }
  const issuedAt = Math.floor(Date.parse(m[7]) / 1000), exp = Math.floor(Date.parse(m[8]) / 1000);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(exp)) return null;
  return { host: m[1].toLowerCase(), address: m[2], uri: m[3], uriHost: uriHost.toLowerCase(), version: Number(m[4]), chainId: Number(m[5]), nonce: m[6], issuedAt, exp };
}
/** Rules both sides apply to a parsed message: version 1, Celo, URI on the same host, not expired, at most 7 days long. Error or null. */
export function signInMessageError(p, nowSec = Math.floor(Date.now() / 1000)) {
  if (!p) return "not a sign-in message";
  if (p.version !== 1) return "unsupported version";
  if (p.chainId !== CELO_CHAIN_ID) return "wrong chain";
  if (p.uriHost !== p.host) return "the URI is not on the signing site";
  if (p.exp <= nowSec) return "the sign-in has expired";
  if (p.issuedAt > nowSec + 300) return "issued in the future";
  if (p.exp <= p.issuedAt || p.exp - p.issuedAt > SESSION_DAYS * 86400 + 60) return "the sign-in lasts too long";
  return null;
}

// ---------- wallet helpers (shared by every page that talks to a wallet) ----------
/** A plain-language explanation of a wallet error. */
export function explainWalletError(e) {
  const m = String(e?.data?.message ?? e?.message ?? e ?? "");
  if (e?.code === 4001 || /user (rejected|denied|cancel)|rejected by user|denied (transaction|request|message signature)|cancell?ed/i.test(m)) return "You cancelled in your wallet. Nothing was sent.";
  if (/insufficient funds|exceeds balance|gas required exceeds/i.test(m)) return "This wallet doesn't have enough CELO for the network fee. Add a few cents of CELO and try again.";
  if (e?.code === -32002) return "Your wallet already has a request open. Switch to it and finish or cancel that first.";
  if (e?.code === 4100) return "The wallet hasn't given this page access. Connect again and approve the request.";
  return `The wallet reported: ${m || "unknown error"}. Try again, and check the wallet is on Celo mainnet.`;
}
/** Switches (or adds) the wallet to Celo mainnet. Throws if the wallet stays on another network. */
export async function ensureCelo(eth) {
  const id = String(await eth.request({ method: "eth_chainId" })).toLowerCase();
  if (id === CELO_CHAIN) return;
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CELO_CHAIN }] });
  } catch (e) {
    const unknown = e?.code === 4902 || e?.data?.originalError?.code === 4902 || /unrecognized|not been added|unknown chain/i.test(String(e?.message));
    if (!unknown) throw e;
    await eth.request({ method: "wallet_addEthereumChain", params: [{
      chainId: CELO_CHAIN, chainName: "Celo", nativeCurrency: { name: "CELO", symbol: "CELO", decimals: 18 },
      rpcUrls: ["https://forno.celo.org"], blockExplorerUrls: ["https://celoscan.io"],
    }] });
  }
  const now = String(await eth.request({ method: "eth_chainId" })).toLowerCase();
  if (now !== CELO_CHAIN) throw new Error("The wallet is still on another network. Switch it to Celo and try again.");
}
/** The injected wallet, or null. */
export const injectedWallet = () => (typeof window !== "undefined" && window.ethereum) || null;

// ---------- the session ----------
const sameAddr = (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
const nowSec = () => Math.floor(Date.now() / 1000);
const wallet = { checked: false, account: null }; // the injected wallet's current eth_accounts[0], once known
const listeners = new Set();
let memorySession = null; // used only when saving to localStorage failed, so the page that signed in still sees the session
let memoryOnly = false; // true when that save failed (storage blocked or full)
const NTAG_CACHE_KEY = "np-ntag";
const NTAG_CACHE_MS = 5 * 60_000;
let ntagMemory = null; // same shape as the sessionStorage entry, for when storage is blocked

function readStored() {
  let s;
  try { s = JSON.parse(localStorage.getItem(SESSION_KEY) ?? "null"); } catch { return null; }
  if (!s || typeof s !== "object" || typeof s.message !== "string" || typeof s.signature !== "string") return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(s.address)) || !Number.isFinite(s.exp)) return null;
  const p = parseSignInMessage(s.message);
  if (!p || !sameAddr(p.address, s.address) || p.exp !== s.exp) return null;
  if (s.exp <= nowSec()) { clearStored(); return null; }
  return { address: s.address, message: s.message, signature: s.signature, exp: s.exp };
}
function clearStored() { try { localStorage.removeItem(SESSION_KEY); } catch { /* storage blocked */ } }

/**
 * The current session { address, message, signature, exp } or null. Signed out when: nothing stored, expired, the
 * wallet was disconnected in this tab, or an injected wallet now reports a different (or no) account.
 */
export function getSession() {
  const s = readStored() ?? (memoryOnly && memorySession && memorySession.exp > nowSec() ? memorySession : null);
  if (!s) return null;
  if (walletDisconnected()) return null;
  if (wallet.checked && injectedWallet() && !sameAddr(wallet.account, s.address)) return null;
  return s;
}
/** Calls cb(session | null) whenever sign-in state may have changed (this tab, other tabs, wallet account switches). Returns an unsubscribe function. */
export function onSessionChange(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function emit() {
  const s = getSession();
  for (const cb of [...listeners]) { try { cb(s); } catch { /* a listener's bug must not break the others */ } }
}

let watching = false;
/** Starts tracking the wallet's account (eth_accounts, accountsChanged) and other tabs. Safe to call more than once. */
export function watchSession(eth = injectedWallet()) {
  if (watching || typeof window === "undefined") return;
  watching = true;
  addEventListener("storage", (e) => {
    if (e.key !== SESSION_KEY && e.key !== null) return;
    // signed out in another tab (key removed, or storage cleared): forget any in-memory copy too
    if (e.key === null || e.newValue == null) { memorySession = null; memoryOnly = false; }
    emit();
  });
  if (!eth?.request) return;
  eth.request({ method: "eth_accounts" }).then((accs) => {
    wallet.checked = true;
    wallet.account = accs?.[0] ?? null;
    emit();
  }).catch(() => { /* unknown: keep the stored session */ });
  eth.on?.("accountsChanged", (accs) => {
    wallet.checked = true;
    wallet.account = accs?.[0] ?? null;
    emit();
  });
}

function randomNonce() {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
const utf8Hex = (s) => "0x" + [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Asks the server (Vercel only) to check the signature. Resolves true, false (rejected) or null (server unreachable). */
async function serverCheck(message, signature, address) {
  if (!HAS_API) return null;
  let r;
  try {
    r = await fetch("/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message, signature }), signal: timeoutSignal(12_000) });
  } catch { return null; }
  if (r.status === 400) return false;
  if (!r.ok) return null; // 404 on an old deploy, 5xx: fall back to the client-side check
  try { const j = await r.json(); return Boolean(j?.ok) && sameAddr(j.address, address); } catch { return null; }
}

/**
 * Connects the wallet and asks it to sign the sign-in message. Resolves the new session. Throws an Error with
 * code "NO_WALLET" when no wallet is injected; other errors come from the wallet (use explainWalletError).
 */
export async function signIn(eth = injectedWallet()) {
  if (!eth?.request) throw Object.assign(new Error("No wallet found in this browser. Open this page inside MiniPay, MetaMask or another Celo wallet."), { code: "NO_WALLET" });
  markWalletConnected(); // an explicit sign-in undoes an earlier Disconnect in this tab
  const accs = await eth.request({ method: "eth_requestAccounts" });
  const address = accs?.[0];
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(address))) throw new Error("The wallet returned no account.");
  const issued = new Date();
  const message = buildSignInMessage({
    host: location.host, origin: location.origin, address, nonce: randomNonce(),
    issuedAt: issued.toISOString(), expiresAt: new Date(issued.getTime() + SESSION_DAYS * 86400_000).toISOString(),
  });
  const signature = await eth.request({ method: "personal_sign", params: [utf8Hex(message), address] });
  // 65 bytes from a normal wallet; smart-contract wallets (ERC-1271 / ERC-6492) can return longer signatures
  if (!/^0x(?:[0-9a-fA-F]{2}){65,}$/.test(String(signature))) throw new Error("The wallet didn't return a signature.");
  const checked = await serverCheck(message, signature, address);
  if (checked === false) throw Object.assign(new Error("The sign-in signature didn't check out. Try again, or use a different wallet."), { plain: true });
  const p = parseSignInMessage(message);
  const session = { address, message, signature, exp: p.exp };
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    memorySession = null;
    memoryOnly = false;
  } catch {
    memorySession = session; // storage blocked: signed in for this page only
    memoryOnly = true;
  }
  wallet.checked = true;
  wallet.account = address;
  emit();
  return session;
}

/** Signs out: forgets the session and disconnects the wallet (same as Disconnect elsewhere). Resolves true if the wallet confirmed it revoked access. */
export async function signOut(eth = injectedWallet()) {
  clearStored();
  memorySession = null;
  memoryOnly = false;
  ntagMemory = null;
  try { sessionStorage.removeItem(NTAG_CACHE_KEY); } catch { /* storage blocked */ }
  const revoked = await disconnectWallet(eth);
  wallet.account = null;
  emit();
  return revoked;
}

// ---------- the signed-in user's nTag (public data, cached briefly in this tab) ----------
function readNtagCache(address) {
  let c = null;
  try { c = JSON.parse(sessionStorage.getItem(NTAG_CACHE_KEY) ?? "null"); } catch { c = null; }
  for (const x of [c, ntagMemory]) if (x && sameAddr(x.address, address) && Date.now() - x.at < NTAG_CACHE_MS) return x;
  return null;
}
function writeNtagCache(address, tag, name) {
  ntagMemory = { address, tag: tag ?? null, name: name ?? null, at: Date.now() };
  try { sessionStorage.setItem(NTAG_CACHE_KEY, JSON.stringify(ntagMemory)); } catch { /* storage blocked: memory only */ }
}
/** Remembers an address's tag for this tab (pages call this right after a claim, change or release). */
export function rememberNtag(address, tag, name = null) {
  writeNtagCache(address, tag, name);
  emit();
}
/** The cached { tag, name } for an address, or undefined when not looked up yet. */
export function cachedNtag(address) {
  const c = readNtagCache(address);
  return c ? { tag: c.tag, name: c.name } : undefined;
}
/**
 * Looks up an address's current tag: the LokalTags contract first, then a legacy memo claim made before the cutover.
 * Resolves { tag, name } ({ tag: null } when none).
 */
export async function lookupNtag(address, { force = false } = {}) {
  if (!force) { const c = cachedNtag(address); if (c) return c; }
  let tag = await readTagOf(address);
  let name = tag ? (await readTagInfo(tag)).name || null : null;
  if (!tag) {
    const state = resolveNtags(legacyNtagOps(await loadNtagOps({ force })));
    tag = ntagOf(state, address);
    name = tag ? ownerOf(state, tag)?.name ?? null : null;
  }
  writeNtagCache(address, tag, name);
  return { tag, name };
}

// ---------- UI: avatar + user chip (sidebar foot and mobile top bar) ----------
/** A round gradient avatar for an address (CSS only, deterministic). */
export function avatar(address, cls = "") {
  const [a, b, c] = avatarSeed(address);
  const n = el("span", { class: `np-avatar${cls ? " " + cls : ""}`, "aria-hidden": "true" });
  n.style.setProperty("--h1", String(a));
  n.style.setProperty("--h2", String(b));
  n.style.setProperty("--h3", String(c));
  return n;
}

// Signed out, the chip is a link to the sign-up gateway (start.html): signing up and signing in are the same flow.
async function chipSignOut() {
  const revoked = await signOut();
  toast(revoked ? "Signed out" : "Signed out on this site");
}

let openMenu = null;
function closeMenu(focusBack = false) {
  if (!openMenu) return;
  const { menu, trigger } = openMenu;
  menu.hidden = true;
  trigger.setAttribute("aria-expanded", "false");
  openMenu = null;
  if (focusBack) trigger.focus();
}
const BODY_FACE = "font-family:var(--sans);font-style:normal;font-weight:600;font-size:15px;color:var(--text)";
/** info: undefined (still looking up), { tag: null } or { tag, name }. */
function userMenu(id, s, info) {
  const tag = info?.tag ?? null;
  const who = tag ? el("b", {}, "@" + tag) : el("b", { style: BODY_FACE }, info === undefined ? "Signed in" : "No Lokal tag yet");
  const items = [
    el("div", { class: "np-menu-head" }, avatar(s.address, "lg"),
      el("div", { class: "np-menu-who" }, who, el("span", { class: "mono", title: s.address }, short(s.address)))),
    el("a", { class: "np-menu-item", href: "app.html" }, icon("home"), "Dashboard"),
    tag || info === undefined
      ? el("a", { class: "np-menu-item", href: "account.html" }, icon("user"), "Account")
      : el("a", { class: "np-menu-item", href: "start.html" }, icon("user"), "Claim your Lokal tag"),
    el("button", { class: "np-menu-item", type: "button", dataset: { copy: s.address, copyLabel: "Address copied" } }, icon("copy"), "Copy wallet address"),
    el("a", { class: "np-menu-item", href: "index.html?about" }, icon("info"), "About Lokal"),
  ];
  const out = el("button", { class: "np-menu-item", type: "button" }, icon("logout"), "Sign out");
  out.addEventListener("click", () => { closeMenu(); chipSignOut(); });
  items.push(el("hr", { class: "np-menu-sep" }), out);
  return el("div", { class: "np-menu", id, hidden: true }, ...items);
}
function wireMenu(trigger, menu) {
  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    if (openMenu?.menu === menu) { closeMenu(); return; }
    closeMenu();
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    openMenu = { menu, trigger };
    menu.querySelector("a, button")?.focus();
  });
}

function renderSidebarChip(slot, s, info) {
  if (!slot) return;
  if (!s) {
    // aria-label: in the icon rail the text is display:none, which would leave the button unnamed
    slot.replaceChildren(el("a", { class: "sb-user-chip signed-out", href: "start.html", "data-label": "Sign in", "aria-label": "Sign in with your wallet" },
      el("span", { class: "np-avatar is-anon", "aria-hidden": "true" }, icon("user")),
      el("span", { class: "sb-user-text sb-label" }, el("b", {}, "Sign in"), el("span", {}, "With your wallet, free"))));
    return;
  }
  const tag = info?.tag ?? null;
  const label = tag ? "@" + tag : short(s.address);
  const trigger = el("button", { class: "sb-user-chip", type: "button", "aria-haspopup": "true", "aria-expanded": "false", "aria-controls": "sb-user-menu", "data-label": label, "aria-label": `Account menu, signed in as ${label}` },
    avatar(s.address),
    el("span", { class: "sb-user-text sb-label" },
      el("b", { class: tag ? "np-tagname" : "mono" }, label),
      el("span", {}, info === undefined ? "Signed in" : tag ? (info.name ? el("bdi", {}, info.name) : "Signed in") : "Claim your Lokal tag")),
    icon("updown", "i sb-user-more sb-label"));
  const menu = userMenu("sb-user-menu", s, info);
  wireMenu(trigger, menu);
  slot.replaceChildren(trigger, menu);
}
function renderNavChip(slot, s, info) {
  if (!slot) return;
  if (!s) {
    slot.replaceChildren(el("a", { class: "nav-user-btn signed-out", href: "start.html", "aria-label": "Sign in with your wallet" }, icon("user"), el("span", {}, "Sign in")));
    return;
  }
  const tag = info?.tag ?? null;
  const trigger = el("button", { class: "nav-user-btn", type: "button", "aria-haspopup": "true", "aria-expanded": "false", "aria-controls": "nav-user-menu", "aria-label": `Account menu, signed in as ${tag ? "@" + tag : short(s.address)}` },
    avatar(s.address));
  const menu = userMenu("nav-user-menu", s, info);
  wireMenu(trigger, menu);
  slot.replaceChildren(trigger, menu);
}

/** Renders the user chip into #sb-user and #nav-user on every page and keeps it current. Called by initChrome. */
export function initUserChip() {
  if (typeof document === "undefined") return;
  const sb = document.getElementById("sb-user"), nav = document.getElementById("nav-user");
  if (!sb && !nav) return;
  let lookingUp = null;
  const lookup = (address, delay) => {
    if (lookingUp === address) return;
    lookingUp = address;
    // on page load, after the page's own data has started loading (the lookup pages through Blockscout)
    setTimeout(() => {
      lookupNtag(address).then(() => { if (sameAddr(getSession()?.address, address)) render(); })
        .catch(() => { /* keep showing the short address */ })
        .finally(() => { lookingUp = null; });
    }, delay);
  };
  const render = () => {
    const s = getSession();
    closeMenu();
    const info = s ? cachedNtag(s.address) : undefined;
    renderSidebarChip(sb, s, info);
    renderNavChip(nav, s, info);
    document.documentElement.dataset.signedIn = s ? "true" : "false";
    if (s && info === undefined) lookup(s.address, 1200);
  };
  document.addEventListener("click", (e) => { if (openMenu && !e.target.closest(".np-menu")) closeMenu(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && openMenu) closeMenu(true); });
  onSessionChange(render);
  watchSession();
  render();
}
