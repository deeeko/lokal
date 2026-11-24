// Screenshots of the payment screens at 390 px and 1440 px, to compare how much each one shows by default:
//   - the tag pay page with no warnings, with warnings (first-time payee, new tag), and with a refusal (over the room
//     the contract has left today);
//   - "Max" in the amount field (ONLY=max): before a tap, after one capped by the wallet's balance, by the $25 per
//     payment and by what @ada can still receive today;
//   - the success state after paying a tag, and after paying a payment link;
//   - the payment-link page;
//   - Get paid with a created link (the QR code collapsed, then opened);
//   - the dashboard.
// The pot screens come from scripts/screenshots-pots.mjs.
//
//   node scripts/screenshots-simple.mjs [out-folder]          (default: ./screenshots/simple)
//
// Needs Google Chrome and playwright-core, exactly like scripts/screenshots.mjs (PLAYWRIGHT_CORE, CHROME).
// MOCKED, in this script's browser only: a wallet (window.ethereum that signs nothing real and sends nothing), a
// sign-in session for the dashboard, every Celo read (Forno and Blockscout) and the rate. Nothing is served by the
// site and nothing is broadcast: eth_sendTransaction returns a made-up hash and the "receipt" is invented here.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { buildSignInMessage, SESSION_KEY } from "../site/assets/session.js";
import { abiEncode, AGENT, CURRENCIES, USDT_ADDRESS, encodeRequest, encodeRegistration } from "../site/assets/core.js";
import { LOKAL_TAGS, FN, TOPIC, USDT_DOMAIN_SEPARATOR, payTagData, currencyRef } from "../site/assets/lokal-contracts.js";
import { tagHashOf } from "../site/assets/trust.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const SITE = path.join(ROOT, "site");
const OUT = path.resolve(process.argv[2] ?? path.join("screenshots", "simple"));
const ONLY = process.env.ONLY ? process.env.ONLY.split(",") : null; // e.g. ONLY=tag,link: just those scenes
const want = (k) => !ONLY || ONLY.includes(k);
fs.mkdirSync(OUT, { recursive: true });
const CHROME = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const pw = createRequire(path.join(process.env.PLAYWRIGHT_CORE ?? ROOT, "x.js"))("playwright-core");

// ---------- a static server for site/ (rate.json is a fixed example) ----------
const RATE = JSON.stringify({ fetchedAt: new Date().toISOString(), rates: { cngn: 1440.77, idrx: 16200, wars: 1180.5, wcop: 3890 }, available: { cngn: true, idrx: true, wars: true, wcop: true }, maxUsd: {}, reverseRate: 0.000694 });
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".woff2": "font/woff2", ".json": "application/json" };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "") || "index.html";
  if (rel === "rate.json") { res.writeHead(200, { "content-type": TYPES[".json"] }); return res.end(RATE); }
  const file = path.resolve(SITE, rel);
  if (!file.startsWith(SITE) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;
const HOST = new URL(ORIGIN).host;

// ---------- the mocked chain ----------
const OWNER = "0x7b3D1e9a0C2f4E5d6A7b8C9d0E1f2A3b4C5d6E7f"; // holds @ada (and is the dashboard's signed-in wallet)
const PAYER = "0x1111111111111111111111111111111111111111"; // the wallet that pays
const BOLA = "0x9c8B7a6F5e4D3c2B1a0F9e8D7c6B5a4F3e2D1c0B";
const NOW = Math.floor(Date.now() / 1000);
const HEAD = 83_460_000; // Celo: one block a second
const blockAt = (sec) => HEAD - (NOW - sec);
const timeOf = (block) => NOW - (HEAD - block);
const lc = (s) => String(s ?? "").toLowerCase();
const word = (a) => "0x" + lc(a).slice(2).padStart(64, "0");
const w64 = (n) => BigInt(n).toString(16).padStart(64, "0");
const hash = (n) => { let h = "", x = n >>> 0; for (let i = 0; i < 8; i++) { x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d) >>> 0; x = (x + 0x9e3779b9) >>> 0; h += x.toString(16).padStart(8, "0"); } return "0x" + h; };
const ZERO = "0x" + "0".repeat(40);
const strOf = (data) => { const h = data.slice(10); const off = parseInt(h.slice(0, 64), 16) * 2; const len = parseInt(h.slice(off, off + 64), 16); return Buffer.from(h.slice(off + 64, off + 64 + len * 2), "hex").toString("utf8"); };
const addrArg = (data, i) => "0x" + data.slice(10 + i * 64 + 24, 10 + (i + 1) * 64);
let li = 0;
const log = (address, topics, data, block) => ({ address, topics, data, blockNumber: "0x" + block.toString(16), logIndex: "0x" + (li++ % 9).toString(16), transactionHash: hash(block) });
const claimedLog = (tag, who, name, sec) => log(LOKAL_TAGS, [TOPIC.TagClaimed, tagHashOf(tag), word(who)], "0x" + abiEncode(["string", "string"], [tag, name]), blockAt(sec));
const paidLog = (tag, who, payer, amount, sec) => log(LOKAL_TAGS, [TOPIC.TagPaid, tagHashOf(tag), word(who), word(payer)],
  "0x" + abiEncode(["string", "address", "uint256", "bytes32", "uint256"], [tag, USDT_ADDRESS, BigInt(amount), "0x" + "0".repeat(64), BigInt(Math.floor(sec / 86400))]), blockAt(sec));
const DAY = 86400, HOUR = 3600;
const TAGS = {
  ada: { owner: OWNER, name: "Ada Obi", since: NOW - 41 * DAY, receive: CURRENCIES[0].address,
    logs: [claimedLog("ada", OWNER, "Ada Obi", NOW - 41 * DAY), ...[38, 30, 21, 12].map((d, i) => paidLog("ada", OWNER, PAYER, (5 + i) * 1_000_000, NOW - d * DAY))] },
  bola: { owner: BOLA, name: "Bola", since: NOW - 5 * HOUR, receive: null, logs: [claimedLog("bola", BOLA, "Bola", NOW - 5 * HOUR)] },
};
const usd = (n) => BigInt(Math.round(n * 1e6));
const day = (h) => new Date((NOW - 30 * HOUR + h * HOUR) * 1000).toISOString();

/** roomUsd: how much more the recipient can receive on the contract today (USD₮). */
function mockChain({ roomUsd = 25, me = OWNER, balUsd = 48.5 } = {}) {
  const st = { sent: null, link: null };
  const tagInfo = (t) => {
    const x = TAGS[t];
    return "0x" + abiEncode(["address", "string", "uint256", "address", "uint256", "address"], x ? [x.owner, x.name, BigInt(x.since), ZERO, 0n, x.receive ?? ZERO] : [ZERO, "", 0n, ZERO, 0n, ZERO]);
  };
  function call({ to, data, from }) {
    const sel = data.slice(0, 10);
    if (lc(to) === lc(LOKAL_TAGS)) {
      if (from && sel !== FN.validatePayment) return "0x"; // a transaction simulated from the wallet: the contract says yes
      if (sel === FN.tagInfo) return tagInfo(strOf(data));
      if (sel === FN.tagOf) return "0x" + abiEncode(["string"], [lc(addrArg(data, 0)) === lc(OWNER) ? "ada" : ""]);
      if (sel === FN.availability) return "0x" + abiEncode(["uint8"], [TAGS[strOf(data)] ? 2 : 0]);
      if (sel === FN.tokenLimits) return "0x" + abiEncode(["uint128", "uint128", "uint128", "uint128", "uint128"], [usd(1), usd(25), usd(25), usd(25), usd(100)]);
      if (sel === FN.remainingToday) return "0x" + abiEncode(["uint256", "uint256", "uint256"], [usd(roomUsd), usd(25), usd(100)]);
      if (sel === FN.validatePayment) return "0x" + abiEncode(["address", "uint256"], [AGENT, 0n]);
      return "0x" + w64(0);
    }
    if (lc(to) === lc(USDT_ADDRESS) && sel === FN.DOMAIN_SEPARATOR) return USDT_DOMAIN_SEPARATOR;
    if (sel === FN.balanceOf) return "0x" + w64(usd(balUsd));
    if (sel === FN.allowance || sel === FN.nonces) return "0x" + w64(0);
    if (sel === "0x313ce567") return "0x" + w64(CURRENCIES.find((c) => lc(c.address) === lc(to))?.decimals ?? 6);
    return "0x" + w64(0);
  }
  function rpc({ id, method, params }) {
    let result = null;
    if (method === "eth_chainId") result = "0xa4ec";
    else if (method === "eth_blockNumber") result = "0x" + HEAD.toString(16);
    else if (method === "eth_getBalance") result = "0xde0b6b3a7640000"; // 1 CELO for the fee
    else if (method === "eth_call") result = call(params[0]);
    else if (method === "eth_getBlockByNumber") { const n = params[0] === "latest" ? HEAD : parseInt(params[0], 16); result = { number: "0x" + n.toString(16), timestamp: "0x" + timeOf(n).toString(16) }; }
    else if (method === "eth_getLogs") {
      const f = params[0];
      result = Object.values(TAGS).flatMap((t) => t.logs).filter((l) => lc(l.address) === lc(f.address) && (!f.topics?.[0] || l.topics[0] === f.topics[0]) && (!f.topics?.[1] || l.topics[1] === f.topics[1]));
    } else if (method === "eth_getTransactionReceipt") {
      st.sent = params[0];
      result = { status: "0x1", logs: [], blockNumber: "0x" + HEAD.toString(16), transactionHash: params[0] };
    } else if (method === "eth_getTransactionByHash") result = null;
    return { jsonrpc: "2.0", id, result };
  }
  const regTime = NOW - 3600;
  const regs = [{ hash: hash(0xa11ce5), from: { hash: me }, to: { hash: AGENT }, status: "ok", block_number: blockAt(regTime), position: 1, timestamp: new Date(regTime * 1000).toISOString(),
    raw_input: encodeRegistration({ a: "12.00", d: "usdt-cngn", e: regTime + 47 * 3600, n: "Ada", m: "School fees" }) }];
  const received = [
    { transaction_hash: hash(0xa11ce1), timestamp: day(15), token: { address_hash: CURRENCIES[0].address }, total: { value: "14407670000", decimals: "6" }, from: { hash: AGENT }, to: { hash: OWNER } },
    { transaction_hash: hash(0xa11ce2), timestamp: day(12), token: { address_hash: CURRENCIES[0].address }, total: { value: "7203830000", decimals: "6" }, from: { hash: AGENT }, to: { hash: OWNER } },
    { transaction_hash: hash(0xa11ce3), timestamp: day(10), token: { address_hash: USDT_ADDRESS }, total: { value: "5000000", decimals: "6" }, from: { hash: OWNER }, to: { hash: AGENT } },
  ];
  const sentTx = [
    { hash: hash(0xa11ce3), to: { hash: LOKAL_TAGS }, raw_input: payTagData({ tag: "tunde", token: USDT_ADDRESS, amount: 5_000_000n, ref: currencyRef("cngn") }), status: "ok", timestamp: day(10) },
  ];
  function explorer(url) {
    const u = new URL(url);
    if (u.pathname === "/api" && u.searchParams.get("module") === "logs") return { status: "0", message: "No logs found", result: [] };
    if (u.pathname.includes(`/addresses/${OWNER}/token-transfers`) && me === OWNER) return { items: received, next_page_params: null };
    if (u.pathname.includes(`/addresses/${OWNER}/transactions`) && me === OWNER) return { items: sentTx, next_page_params: null };
    if (u.pathname.includes(`/addresses/${AGENT}/transactions`) && u.searchParams.get("filter") === "to") return { items: me === OWNER ? regs : [], next_page_params: null };
    // a payment-link deposit shows up once its transaction "confirmed"
    if (u.pathname.includes(`/addresses/${AGENT}/token-transfers`) && u.searchParams.get("filter") === "to" && st.sent && st.link) {
      return { items: [{ transaction_hash: st.sent, timestamp: new Date().toISOString(), block_number: HEAD, log_index: 3, method: "transfer",
        token: { address_hash: USDT_ADDRESS }, total: { value: st.link, decimals: "6" }, from: { hash: PAYER }, to: { hash: AGENT } }], next_page_params: null };
    }
    return { items: [], next_page_params: null };
  }
  return { st, rpc, explorer };
}

const browser = await pw.chromium.launch({ executablePath: CHROME });
const errors = [];
async function context({ width, mock, consent = "declined", paid = null, session = null, wallet = null }) {
  const ctx = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 900 }, deviceScaleFactor: width < 500 ? 2 : 1 });
  await ctx.route("**/*", async (route) => {
    const req = route.request();
    const url = req.url();
    if (url.startsWith(ORIGIN)) return route.continue();
    if (url.startsWith("https://forno.celo.org") || url.startsWith("https://celo.blockscout.com/api/eth-rpc")) {
      const body = JSON.parse(req.postData() ?? "{}");
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(Array.isArray(body) ? body.map(mock.rpc) : mock.rpc(body)) });
    }
    if (url.startsWith("https://celo.blockscout.com")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mock.explorer(url)) });
    return route.abort();
  });
  const exp = NOW + 6 * 86400;
  const sess = session ? JSON.stringify({ address: session, signature: "0x" + "11".repeat(65), exp,
    message: buildSignInMessage({ host: HOST, origin: ORIGIN, address: session, nonce: "0123456789abcdef", issuedAt: new Date().toISOString(), expiresAt: new Date(exp * 1000).toISOString() }) }) : null;
  await ctx.addInitScript(({ consent, paid, sess, key, wallet }) => {
    try {
      localStorage.setItem("np-consent", JSON.stringify({ v: 2, choice: consent, at: "2026-11-21T00:00:00.000Z" }));
      if (paid) localStorage.setItem("np-paid-tags", JSON.stringify(paid));
      if (sess) localStorage.setItem(key, sess);
    } catch {}
    if (!wallet) return;
    let accs = [wallet];
    window.ethereum = {
      isMetaMask: true, on() {}, removeListener() {},
      async request({ method }) {
        if (method === "eth_accounts") return accs;
        if (method === "eth_requestAccounts") { accs = [wallet]; return accs; }
        if (method === "eth_chainId") return "0xa4ec";
        if (method === "eth_signTypedData_v4") return "0x" + "22".repeat(64) + "1b";
        if (method === "eth_sendTransaction") return "0x" + "ab".repeat(32); // never broadcast: a made-up hash
        if (method === "wallet_switchEthereumChain") return null;
        throw Object.assign(new Error("unsupported in the screenshot wallet"), { code: 4200 });
      },
    };
  }, { consent, paid, sess, key: SESSION_KEY, wallet });
  ctx.on("page", (p) => p.on("pageerror", (e) => errors.push(`${p.url()}: ${e.message}`)));
  return ctx;
}
const shots = [];
const settle = (page, ms = 700) => page.waitForTimeout(ms);
const hideConsent = (page) => page.addStyleTag({ content: ".consent { display: none !important; }" });
async function tall(page, name) {
  const vp = page.viewportSize();
  await page.evaluate(() => scrollTo(0, 0));
  const h = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width: vp.width, height: h });
  await settle(page, 500);
  await page.screenshot({ path: path.join(OUT, name + ".png") });
  shots.push(name + ".png");
  await page.setViewportSize(vp);
}
const waitText = (page, re, timeout = 30000) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector("main")?.innerText ?? ""), re.source, { timeout });

for (const width of [390, 1440]) {
  // ---------- the tag pay page ----------
  if (want("tag"))
  for (const s of [
    { name: "tag-no-warnings", tag: "ada", paid: ["ada", "tunde"], pay: true },
    { name: "tag-with-warnings", tag: "bola", paid: ["ada", "tunde"] },
    { name: "tag-refused-over-room", tag: "ada", paid: ["ada", "tunde"], roomUsd: 5 },
  ]) {
    const mock = mockChain({ roomUsd: s.roomUsd ?? 25, me: PAYER });
    const ctx = await context({ width, mock, consent: "accepted", paid: s.paid, wallet: PAYER });
    const page = await ctx.newPage();
    await page.goto(`${ORIGIN}/tag.html?t=${s.tag}`);
    await hideConsent(page);
    await page.waitForFunction(() => document.querySelector(".trust-line") && !document.querySelector(".trust-line .skel"), null, { timeout: 30000 });
    await page.waitForSelector("button:has-text('Pay')", { timeout: 30000 });
    await settle(page, 1500);
    await tall(page, `${s.name}-${width}`);
    if (s.pay) {
      await page.click("button:has-text('Pay 10')");
      await waitText(page, /Payment confirmed|on its way/);
      await settle(page, 1200);
      await tall(page, `success-tag-${width}`);
    }
    await ctx.close();
  }

  // ---------- "Max" in the amount field ----------
  if (want("max"))
  for (const s of [
    { name: "tag-max-visible", balUsd: 48.5 },
    { name: "tag-max-by-balance", balUsd: 13.379, tap: true },
    { name: "tag-max-by-25-limit", balUsd: 48.5, tap: true },
    { name: "tag-max-by-today", balUsd: 48.5, roomUsd: 12, tap: true },
  ]) {
    const mock = mockChain({ roomUsd: s.roomUsd ?? 25, me: PAYER, balUsd: s.balUsd });
    const ctx = await context({ width, mock, consent: "accepted", paid: ["ada", "tunde"], wallet: PAYER });
    const page = await ctx.newPage();
    await page.goto(`${ORIGIN}/tag.html?t=ada`);
    await hideConsent(page);
    await page.waitForSelector(".money-max:not([disabled])", { timeout: 30000 });
    await page.waitForFunction(() => !/Checking the contract/.test(document.querySelector("#pay-contract-room")?.textContent ?? ""), null, { timeout: 30000 });
    await settle(page, 1200);
    if (s.tap) { await page.click(".money-max"); await settle(page, 700); }
    await page.locator("section.card:has(#pay-amount)").screenshot({ path: path.join(OUT, `${s.name}-${width}.png`) });
    shots.push(`${s.name}-${width}.png`);
    await ctx.close();
  }

  // ---------- a payment link (#r=), then paying it ----------
  if (want("link"))
  {
    const mock = mockChain({ me: PAYER });
    mock.st.link = "12370000";
    const ctx = await context({ width, mock, wallet: PAYER });
    const page = await ctx.newPage();
    const token = encodeRequest({ v: 1, id: "r_k3x9q2", name: "Tunde", amount: "12.37", dir: "usdt-cngn", created: Date.now() - 3600_000, exp: Date.now() + 47 * 3600_000, note: "March rent" });
    await page.goto(`${ORIGIN}/pay.html#r=${token}`);
    await hideConsent(page);
    await page.waitForSelector("button:has-text('Pay 12.37')", { timeout: 30000 });
    await waitText(page, /Waiting for payment/);
    await settle(page, 1200);
    await tall(page, `pay-link-${width}`);
    await page.click("button:has-text('Pay 12.37')");
    await waitText(page, /Confirmed on Celo|on its way/);
    await settle(page, 2500);
    await tall(page, `success-link-${width}`);
    await ctx.close();
  }

  // ---------- Get paid: create a link ----------
  if (want("getpaid"))
  {
    const mock = mockChain({ me: PAYER });
    const ctx = await context({ width, mock, wallet: PAYER });
    const page = await ctx.newPage();
    await page.goto(`${ORIGIN}/get-paid.html`);
    await hideConsent(page);
    await page.waitForSelector("#create", { timeout: 30000 });
    await page.fill("#name", "Ada Obi");
    await page.fill("#note", "March design work");
    await page.check("#agree");
    await settle(page, 600);
    await page.click("#create");
    await page.waitForSelector("#done-card:not([hidden])", { timeout: 30000 });
    await settle(page, 900);
    await tall(page, `get-paid-created-qr-collapsed-${width}`);
    const toggle = page.locator("#done-card button:has-text('Show QR code'), #done-card summary:has-text('Show QR code')");
    if (await toggle.count()) { await toggle.first().click(); await settle(page, 900); }
    await tall(page, `get-paid-created-qr-expanded-${width}`);
    await ctx.close();
  }

  // ---------- the dashboard ----------
  if (want("dash"))
  {
    const mock = mockChain({ me: OWNER });
    const ctx = await context({ width, mock, session: OWNER, wallet: OWNER });
    const page = await ctx.newPage();
    await page.goto(`${ORIGIN}/app.html`);
    await hideConsent(page);
    await page.waitForSelector(".dash-totals", { timeout: 30000 });
    await page.waitForSelector("#links .dash-list, #links .dash-empty", { timeout: 30000 });
    await settle(page, 1500);
    await tall(page, `dashboard-${width}`);
    await ctx.close();
  }
}

await browser.close();
server.close();
if (errors.length) console.error("Page errors:\n" + errors.map((e) => "  " + e).join("\n"));
console.log(`${shots.length} screenshots in ${OUT}:\n` + shots.map((s) => "  " + s).join("\n"));
