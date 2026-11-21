// Screenshots of the front door: every landing section at 390 px and 1440 px, each sign-up gateway step, the
// dashboard, Activity for a visitor, and the Account claim step at the widths around the sidebar breakpoint.
//
//   node scripts/screenshots.mjs [out-folder]          (default: ./screenshots)
//
// Needs Google Chrome and playwright-core, which is NOT a dependency of this repo; point at them with PLAYWRIGHT_CORE
// and CHROME exactly as for scripts/brand.mjs. Serves site/ locally. The rate is the live one from
// lokalpay.vercel.app/api/rate (read-only); the landing reads the agent's real payouts from Blockscout.
//
// MOCKED, in this script's browser only: a wallet (window.ethereum that signs nothing real and sends nothing), a
// sign-in session, and the chain answers for the example account "@ada" (its tag, its payouts, its payment link).
// None of it is ever served by the site. Nothing is broadcast: eth_sendTransaction returns a made-up hash.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { buildSignInMessage, SESSION_KEY } from "../site/assets/session.js";
import { abiEncode, AGENT, CURRENCIES, USDT_ADDRESS, encodeRegistration } from "../site/assets/core.js";
import { LOKAL_TAGS, FN, payTagData, currencyRef } from "../site/assets/lokal-contracts.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const SITE = path.join(ROOT, "site");
const OUT = path.resolve(process.argv[2] ?? "screenshots");
fs.mkdirSync(OUT, { recursive: true });
const CHROME = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const pw = createRequire(path.join(process.env.PLAYWRIGHT_CORE ?? ROOT, "x.js"))("playwright-core");

// ---------- the live rate (falls back to site/rate.json) ----------
let rateJson = null;
try { const r = await fetch("https://lokalpay.vercel.app/api/rate", { signal: AbortSignal.timeout(15000) }); if (r.ok) rateJson = await r.text(); } catch { /* fallback */ }
if (!rateJson && fs.existsSync(path.join(SITE, "rate.json"))) rateJson = fs.readFileSync(path.join(SITE, "rate.json"), "utf8");

// ---------- a static server for site/ ----------
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".woff2": "font/woff2", ".json": "application/json" };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "") || "index.html";
  if (rel === "rate.json" && rateJson) { res.writeHead(200, { "content-type": TYPES[".json"] }); return res.end(rateJson); }
  const file = path.resolve(SITE, rel);
  if (!file.startsWith(SITE) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;
const HOST = new URL(ORIGIN).host;

// ---------- the example account and its mocked chain ----------
const ME = "0x5aD4e1b2C3f4A5b6C7d8E9f0a1B2c3D4e5F6a7B8";
const lc = (s) => String(s ?? "").toLowerCase();
const word = (n) => BigInt(n).toString(16).padStart(64, "0");
// made-up hashes that look like real ones (so receipt numbers read like real ones); never sent anywhere
const hash = (n) => { let h = "", x = n >>> 0; for (let i = 0; i < 8; i++) { x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d) >>> 0; x = (x + 0x9e3779b9) >>> 0; h += x.toString(16).padStart(8, "0"); } return "0x" + h; };
const day = (h) => new Date(Date.UTC(2026, 10, 21, h)).toISOString();
function mockChain({ tag = null, name = "", receive = null } = {}) {
  const st = { tag, name, receive, pending: null };
  const tagInfo = (t) => (t && t === st.tag
    ? abiEncode(["address", "string", "uint256", "address", "uint256", "address"], [ME, st.name, 1795300000n, "0x" + "0".repeat(40), 0n, st.receive ?? "0x" + "0".repeat(40)])
    : abiEncode(["address", "string", "uint256", "address", "uint256", "address"], ["0x" + "0".repeat(40), "", 0n, "0x" + "0".repeat(40), 0n, "0x" + "0".repeat(40)]));
  const decodeStr = (data) => { const h = data.slice(10); const off = parseInt(h.slice(0, 64), 16) * 2; const len = parseInt(h.slice(off, off + 64), 16); return Buffer.from(h.slice(off + 64, off + 64 + len * 2), "hex").toString("utf8"); };
  function call({ to, data, from }) {
    const sel = data.slice(0, 10);
    if (lc(to) === lc(LOKAL_TAGS)) {
      if (from) { // a simulated transaction from the wallet: the contract says yes, and the claim is about to land
        if (sel === FN.claim) st.pending = { tag: decodeStr(data) };
        return "0x";
      }
      if (sel === FN.tagOf) return abiEncode(["string"], [st.tag ?? ""]);
      if (sel === FN.tagInfo) return tagInfo(decodeStr(data));
      if (sel === FN.availability) { const t = decodeStr(data); return "0x" + word(t === st.tag ? 1 : t === "lokal" ? 3 : 0); }
      return "0x" + word(0);
    }
    if (sel === "0x313ce567") return "0x" + word(CURRENCIES.find((c) => lc(c.address) === lc(to))?.decimals ?? 6); // decimals()
    if (sel === "0x70a08231") return "0x" + word(0); // balanceOf
    return "0x" + word(0);
  }
  function rpc(body) {
    const { id, method, params } = body;
    let result = null;
    if (method === "eth_chainId") result = "0xa4ec";
    else if (method === "eth_blockNumber") result = "0x" + (83500000).toString(16);
    else if (method === "eth_getBalance") result = "0xde0b6b3a7640000"; // 1 CELO for the fee
    else if (method === "eth_call") result = call(params[0]);
    else if (method === "eth_getTransactionReceipt") { if (st.pending) { st.tag = st.pending.tag; st.pending = null; } result = { status: "0x1", logs: [], blockNumber: "0x1" }; }
    return { jsonrpc: "2.0", id, result };
  }
  // Blockscout: the example account's payments with Lokal, and its payment link
  const transfers = [
    { transaction_hash: hash(0xa11ce1), timestamp: day(15), token: { address_hash: CURRENCIES[0].address }, total: { value: "14407670000", decimals: "6" }, from: { hash: AGENT }, to: { hash: ME } },
    { transaction_hash: hash(0xa11ce2), timestamp: day(12), token: { address_hash: CURRENCIES[0].address }, total: { value: "7203830000", decimals: "6" }, from: { hash: AGENT }, to: { hash: ME } },
    { transaction_hash: hash(0xa11ce3), timestamp: day(10), token: { address_hash: USDT_ADDRESS }, total: { value: "5000000", decimals: "6" }, from: { hash: ME }, to: { hash: AGENT } },
  ];
  const sent = [
    { hash: hash(0xa11ce3), to: { hash: LOKAL_TAGS }, raw_input: payTagData({ tag: "tunde", token: USDT_ADDRESS, amount: 5_000_000n, ref: currencyRef("cngn") }), status: "ok", timestamp: day(10) },
    { hash: hash(0xa11ce4), to: { hash: LOKAL_TAGS }, raw_input: FN.claim + abiEncode(["string", "string"], ["ada", "Ada Obi"]), status: "ok", timestamp: day(9) },
  ];
  const regTime = Math.floor(Date.now() / 1000) - 3600;
  const regs = [{ hash: hash(0xa11ce5), from: { hash: ME }, to: { hash: AGENT }, status: "ok", block_number: 83490000, position: 1, timestamp: new Date(regTime * 1000).toISOString(),
    raw_input: encodeRegistration({ a: "12.00", d: "usdt-cngn", e: regTime + 47 * 3600, n: "Ada", m: "School fees" }) }];
  function explorer(url) {
    const u = new URL(url);
    if (u.pathname.includes(`/addresses/${ME}/token-transfers`)) return { items: tag ? transfers : [], next_page_params: null };
    if (u.pathname.includes(`/addresses/${ME}/transactions`)) return { items: tag ? sent : [], next_page_params: null };
    if (u.pathname.includes(`/addresses/${AGENT}/transactions`) && u.searchParams.get("filter") === "to") return { items: tag ? regs : [], next_page_params: null };
    return { items: [], next_page_params: null };
  }
  return { st, rpc, explorer };
}

const browser = await pw.chromium.launch({ executablePath: CHROME });
const consent = JSON.stringify({ v: 2, choice: "declined", at: "2026-11-21T00:00:00.000Z" });
/** A browser context. mock: a mockChain() (chain answers mocked) or null (the real public chain, read-only). */
async function context({ width, height = 900, mock = null, session = false, wallet = null, reduced = false }) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: width < 500 ? 2 : 1, reducedMotion: reduced ? "reduce" : "no-preference" });
  await ctx.route("**/*", async (route) => {
    const req = route.request();
    const url = req.url();
    if (url.startsWith(ORIGIN)) return route.continue();
    if (mock && url.startsWith("https://forno.celo.org")) {
      const body = JSON.parse(req.postData() ?? "{}");
      const out = Array.isArray(body) ? body.map(mock.rpc) : mock.rpc(body);
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(out) });
    }
    if (mock && url.startsWith("https://celo.blockscout.com")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mock.explorer(url)) });
    if (!mock && (url.startsWith("https://forno.celo.org") || url.startsWith("https://celo.blockscout.com"))) return route.continue(); // public reads only
    return route.abort();
  });
  const exp = Math.floor(Date.now() / 1000) + 6 * 86400;
  const sess = session ? JSON.stringify({ address: ME, signature: "0x" + "11".repeat(65), exp,
    message: buildSignInMessage({ host: HOST, origin: ORIGIN, address: ME, nonce: "0123456789abcdef", issuedAt: new Date().toISOString(), expiresAt: new Date(exp * 1000).toISOString() }) }) : null;
  await ctx.addInitScript(({ consent, sess, key, wallet, me }) => {
    try { localStorage.setItem("np-consent", consent); if (sess) localStorage.setItem(key, sess); } catch {}
    if (!wallet) return;
    let accs = wallet.connected ? [me] : [];
    window.ethereum = {
      isMetaMask: true, on() {}, removeListener() {},
      async request({ method }) {
        if (method === "eth_accounts") return accs;
        if (method === "eth_requestAccounts") { accs = [me]; return accs; }
        if (method === "eth_chainId") return "0xa4ec";
        if (method === "personal_sign") return "0x" + "22".repeat(65);
        if (method === "eth_sendTransaction") return "0x" + "ab".repeat(32); // never broadcast: a made-up hash
        if (method === "wallet_watchAsset") return true;
        if (method === "wallet_switchEthereumChain") return null;
        throw Object.assign(new Error("unsupported in the screenshot wallet"), { code: 4200 });
      },
    };
  }, { consent, sess, key: SESSION_KEY, wallet, me: ME });
  return ctx;
}
const shots = [];
const save = async (target, name, opts = {}) => {
  const file = path.join(OUT, name + ".png");
  await target.screenshot({ path: file, ...opts });
  shots.push(name + ".png");
};
const settle = (page, ms = 700) => page.waitForTimeout(ms);
/** The whole page in one image: a viewport as tall as the page (not fullPage), so fixed and sticky bars sit where they belong. */
async function tall(page, name) {
  const vp = page.viewportSize();
  await page.evaluate(() => scrollTo(0, 0));
  const h = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width: vp.width, height: h });
  await settle(page, 500);
  await save(page, name);
  await page.setViewportSize(vp);
}

// first, the images the landing itself shows (so its section shots include them)
// the README's hero image (compressed)
{
  const ctx = await context({ width: 1440, height: 900 });
  const page = await ctx.newPage();
  await page.goto(ORIGIN + "/index.html");
  await page.waitForFunction(() => !document.querySelector("#conv-rows .v")?.textContent.includes("…"));
  await settle(page, 1200);
  await page.screenshot({ path: path.join(ROOT, "docs", "assets", "landing.jpg"), type: "jpeg", quality: 78 });
  // the real cash-out page, for the landing's "Getting it to your bank" frame
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto(ORIGIN + "/cash-out.html");
  await settle(page, 1200);
  fs.mkdirSync(path.join(SITE, "assets", "img"), { recursive: true });
  await page.screenshot({ path: path.join(SITE, "assets", "img", "cash-out.jpg"), type: "jpeg", quality: 70, clip: { x: 284, y: 120, width: 900, height: 675 } });
  await ctx.close();
}

// ---------- the landing, section by section ----------
const SECTIONS = [
  ["01-hero", ".lp-hero"], ["02-problem", "section[aria-labelledby=problem-h]"], ["03-how-it-works", "#how"], ["04-countries", "#countries"],
  ["05-everything", "#everything"], ["06-safety", "#safety"], ["07-cash-out", "#cash-out"], ["08-proof", "#proof"],
  ["09-developers", "#developers"], ["10-faq", "#faq"], ["11-final-and-footer", "section[aria-labelledby=final-h]"],
];
for (const width of [390, 1440]) {
  const ctx = await context({ width, height: width < 500 ? 844 : 900 });
  const page = await ctx.newPage();
  await page.goto(ORIGIN + "/index.html");
  await page.waitForFunction(() => !document.querySelector("#conv-rows .v")?.textContent.includes("…"));
  await settle(page, 1200);
  // the hero with its top bar, as it first appears
  const hero = await page.locator(".lp-hero").boundingBox();
  await save(page, `landing-${SECTIONS[0][0]}-${width}`, { clip: { x: 0, y: 0, width, height: Math.ceil(hero.y + hero.height) } });
  // the rest: every reveal finished, the sticky bar out of the way, the first FAQ open
  await page.evaluate(() => { for (const n of document.querySelectorAll(".reveal, .reveal-list")) n.classList.add("in"); document.querySelector(".lp-faq details")?.setAttribute("open", ""); });
  await page.addStyleTag({ content: ".lp-bar { visibility: hidden; }" });
  // lazy images load as they scroll in; load them all now so each section shot has its real screen
  await page.evaluate(() => Promise.all([...document.images].map((i) => { i.loading = "eager"; return i.complete ? null : new Promise((r) => { i.onload = i.onerror = r; }); })));
  await page.waitForFunction(() => !/Reading/.test(document.querySelector("#payouts-msg")?.textContent ?? ""), null, { timeout: 20000 }).catch(() => {});
  await settle(page);
  for (const [name, sel] of SECTIONS.slice(1)) {
    if (name.startsWith("11")) {
      // the last word and the footer together, in page coordinates
      const box = await page.evaluate(() => { const a = document.querySelector("section[aria-labelledby=final-h]").getBoundingClientRect(); const f = document.querySelector(".lp-foot").getBoundingClientRect(); return { y: a.top + scrollY, h: f.bottom - a.top }; });
      await save(page, `landing-${name}-${width}`, { clip: { x: 0, y: box.y, width, height: Math.ceil(box.h) }, fullPage: true });
    } else await save(page.locator(sel), `landing-${name}-${width}`);
  }
  if (width === 1440) {
    // the signature moment over the limit: $30 is refused before any money moves
    await page.addStyleTag({ content: ".lp-bar { visibility: visible; }" });
    await page.evaluate(() => scrollTo(0, 0));
    await page.fill("#conv-amount", "30");
    await settle(page, 600);
    await save(page.locator("#conv"), "landing-01b-hero-converter-over-limit-1440");
  }
  await ctx.close();
}

// ---------- the sign-up gateway, step by step (mocked wallet and chain) ----------
for (const width of [390, 1440]) {
  const mock = mockChain();
  const ctx = await context({ width, height: width < 500 ? 844 : 900, mock, wallet: { connected: false } });
  const page = await ctx.newPage();
  await page.goto(ORIGIN + "/start.html");
  await page.waitForSelector("text=Connect wallet");
  await settle(page);
  await tall(page, `gateway-1-connect-${width}`);
  await page.click("text=Connect wallet");
  await page.waitForSelector("button:has-text('Sign in')");
  await settle(page);
  await tall(page, `gateway-2-sign-in-${width}`);
  await page.click("button:has-text('Sign in')");
  await page.waitForSelector("#gw-tag");
  await page.fill("#gw-tag", "ada");
  await page.waitForSelector(".nt-avail[data-state=free]");
  await settle(page);
  await tall(page, `gateway-3-your-tag-${width}`);
  await page.click("button:has-text('Continue')");
  await page.waitForSelector("#gw-name");
  await page.fill("#gw-name", "Ada Obi");
  await page.check("#gw-agree");
  await settle(page);
  await tall(page, `gateway-4-your-name-${width}`);
  await page.click("button:has-text('Claim @ada')");
  await page.waitForSelector("text=Welcome,", { timeout: 30000 });
  await settle(page, 2800);
  await tall(page, `gateway-5-welcome-${width}`);
  await ctx.close();
}

// ---------- the dashboard (mocked session and chain for the example account @ada) ----------
for (const width of [390, 1440]) {
  const mock = mockChain({ tag: "ada", name: "Ada Obi", receive: CURRENCIES[0].address });
  const ctx = await context({ width, height: width < 500 ? 844 : 900, mock, session: true });
  const page = await ctx.newPage();
  await page.goto(ORIGIN + "/app.html");
  await page.waitForSelector(".dash-totals", { timeout: 20000 });
  await page.waitForSelector("#links .dash-list, #links .dash-empty", { timeout: 20000 });
  await settle(page, 1500);
  await tall(page, `dashboard-mocked-${width}`);
  await ctx.close();
}
// signed out: the dashboard and Activity show a sign-in prompt, never a feed
for (const [file, name] of [["app.html", "dashboard-signed-out"], ["transactions.html", "activity-visitor"]]) {
  const ctx = await context({ width: 1440 });
  const page = await ctx.newPage();
  await page.goto(ORIGIN + "/" + file);
  await settle(page, 1200);
  await save(page, `${name}-1440`);
  await ctx.close();
}

// ---------- the Account claim step around the sidebar breakpoint: the top bar never covers content ----------
for (const width of [1280, 1100, 1099, 1024, 768, 390]) {
  const mock = mockChain();
  const ctx = await context({ width, height: width < 500 ? 844 : 800, mock, session: true });
  const page = await ctx.newPage();
  await page.goto(ORIGIN + "/account.html");
  await page.waitForSelector("button:has-text('Skip for now')", { timeout: 20000 });
  await page.click("button:has-text('Skip for now')");
  await page.waitForSelector("text=Network fee");
  await settle(page);
  // scroll so the claim summary sits right at the top edge, where the old floating bar covered it
  await page.evaluate(() => { const li = [...document.querySelectorAll(".kv-list li")].find((n) => /Sends/.test(n.textContent)); li.parentElement.scrollIntoView({ block: "start" }); });
  await settle(page, 400);
  await save(page, `account-claim-step-${width}`);
  await ctx.close();
}

await browser.close();
server.close();
console.log(`${shots.length} screenshots in ${OUT}:\n` + shots.map((s) => "  " + s).join("\n"));
