// Screenshots of the notification bell at 390 px and 1440 px: the bell with its count in the top bar, the small
// dropdown open with mixed items (a payout, a payment to your tag, a spray into your pot, a refund), and the empty state.
//
//   node scripts/screenshots-bell.mjs [out-folder]          (default: ./screenshots/bell)
//
// Needs Google Chrome and playwright-core (not a dependency of this repo); point at them with PLAYWRIGHT_CORE and CHROME
// exactly as for scripts/screenshots.mjs. Serves site/ locally; the rate is the live one from lokalpay.vercel.app.
//
// MOCKED, in this script's browser only: a sign-in session for the example account "@ada" and every chain answer
// (LokalTags, LokalPots, the explorer's lists and log API). Nothing is signed and nothing is sent.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { encodeAbiParameters, encodeEventTopics } from "viem";
import { buildSignInMessage, SESSION_KEY } from "../site/assets/session.js";
import { abiEncode, AGENT, CURRENCIES, USDT_ADDRESS } from "../site/assets/core.js";
import { LOKAL_TAGS, LOKAL_POTS, FN, TOPIC, currencyRef, payTagData } from "../site/assets/lokal-contracts.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const SITE = path.join(ROOT, "site");
const OUT = path.resolve(process.argv[2] ?? "screenshots/bell");
fs.mkdirSync(OUT, { recursive: true });
const CHROME = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const pw = createRequire(path.join(process.env.PLAYWRIGHT_CORE ?? ROOT, "x.js"))("playwright-core");
const abiOf = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, `contracts/deployments/${name}.json`), "utf8")).abi;
const EV = (abi, name) => abi.find((x) => x.type === "event" && x.name === name);
const tagsAbi = abiOf("LokalTags"), potsAbi = abiOf("LokalPots");

let rateJson = null;
try { const r = await fetch("https://lokalpay.vercel.app/api/rate", { signal: AbortSignal.timeout(15000) }); if (r.ok) rateJson = await r.text(); } catch { /* none */ }
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

// ---------- the example account @ada and what came in (all invented) ----------
const ME = "0x5ad4e1b2c3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8";
const GUEST = "0x9c1e7a3b5d2f4c6e8a0b1d3f5e7c9a2b4d6e8f01";
const CNGN = CURRENCIES[0].address, IDRX = CURRENCIES[1].address;
const lc = (s) => String(s ?? "").toLowerCase();
const word = (n) => BigInt(n).toString(16).padStart(64, "0");
const hash = (n) => { let h = "", x = n >>> 0; for (let i = 0; i < 8; i++) { x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d) >>> 0; x = (x + 0x9e3779b9) >>> 0; h += x.toString(16).padStart(8, "0"); } return "0x" + h; };
const NOW = () => Math.floor(Date.now() / 1000);
const ago = (min) => new Date((NOW() - min * 60) * 1000).toISOString();
const HEAD = 84_000_000;

function mockChain({ empty = false } = {}) {
  const transfers = empty ? [] : [
    { transaction_hash: hash(1), timestamp: ago(2), token: { address_hash: CNGN }, total: { value: "14407670000", decimals: "6" }, from: { hash: AGENT }, to: { hash: ME } },
    { transaction_hash: hash(3), timestamp: ago(62), token: { address_hash: USDT_ADDRESS }, total: { value: "5000000", decimals: "6" }, from: { hash: AGENT }, to: { hash: ME } }, // the $5 back: a refund
    { transaction_hash: hash(2), timestamp: ago(130), token: { address_hash: USDT_ADDRESS }, total: { value: "5000000", decimals: "6" }, from: { hash: ME }, to: { hash: AGENT } },
    { transaction_hash: hash(4), timestamp: ago(300), token: { address_hash: IDRX }, total: { value: "9196700", decimals: "2" }, from: { hash: AGENT }, to: { hash: ME } },
    { transaction_hash: hash(5), timestamp: ago(60 * 26), token: { address_hash: CNGN }, total: { value: "7203830000", decimals: "6" }, from: { hash: AGENT }, to: { hash: ME } },
  ];
  const sent = empty ? [] : [{ hash: hash(2), to: { hash: LOKAL_TAGS }, raw_input: payTagData({ tag: "tunde", token: USDT_ADDRESS, amount: 5_000_000n, ref: currencyRef("cngn") }), status: "ok", timestamp: ago(130) }];
  const row = (l, min, n) => ({ ...l, blockNumber: "0x" + (HEAD - min * 60).toString(16), logIndex: "0x1", transactionHash: hash(n), timeStamp: "0x" + (NOW() - min * 60).toString(16) });
  const tagPaid = (min, n, usd) => row({ address: LOKAL_TAGS,
    topics: encodeEventTopics({ abi: [EV(tagsAbi, "TagPaid")], eventName: "TagPaid", args: { tagHash: "0x" + "ab".repeat(32), recipient: ME, payer: GUEST } }),
    data: encodeAbiParameters(EV(tagsAbi, "TagPaid").inputs.filter((i) => !i.indexed), ["ada", USDT_ADDRESS, BigInt(usd * 1e6), currencyRef("cngn"), 20_779n]) }, min, n);
  const potPaid = (min, n, usd) => row({ address: LOKAL_POTS,
    topics: encodeEventTopics({ abi: [EV(potsAbi, "PotPaid")], eventName: "PotPaid", args: { potId: 7n, host: ME, payer: GUEST } }),
    data: encodeAbiParameters(EV(potsAbi, "PotPaid").inputs.filter((i) => !i.indexed), [USDT_ADDRESS, BigInt(usd * 1e6), currencyRef("cngn"), 45_000_000n, BigInt(usd * 1e6)]) }, min, n);
  const potCreated = row({ address: LOKAL_POTS,
    topics: encodeEventTopics({ abi: [EV(potsAbi, "PotCreated")], eventName: "PotCreated", args: { potId: 7n, host: ME } }),
    data: encodeAbiParameters(EV(potsAbi, "PotCreated").inputs.filter((i) => !i.indexed), ["Ada & Tunde's wedding", BigInt(NOW() + 3 * 86_400), 100_000_000n, 5_000_000n]) }, 3000, 9);
  const tagLogs = empty ? [] : [tagPaid(9, 6, 10), tagPaid(60 * 30, 7, 4)];
  const potLogs = empty ? [] : [potPaid(34, 8, 5)];

  function call({ to, data }) {
    const sel = data.slice(0, 10);
    if (lc(to) === lc(LOKAL_TAGS)) {
      if (sel === FN.tagOf) return abiEncode(["string"], ["ada"]);
      if (sel === FN.tagInfo) return abiEncode(["address", "string", "uint256", "address", "uint256", "address"], [ME, "Ada Obi", 1795300000n, "0x" + "0".repeat(40), 0n, CNGN]);
    }
    if (lc(to) === lc(LOKAL_POTS) && sel === FN.potInfo) {
      return abiEncode(["address", "string", "uint256", "bool", "uint256", "uint256", "uint256", "uint256"], [ME, "Ada & Tunde's wedding", BigInt(NOW() + 3 * 86_400), true, 100_000_000n, 5_000_000n, 45_000_000n, 9n]);
    }
    if (sel === "0x313ce567") return "0x" + word(6);
    return "0x" + word(0);
  }
  function rpc({ id, method, params }) {
    let result = null;
    if (method === "eth_chainId") result = "0xa4ec";
    else if (method === "eth_blockNumber") result = "0x" + HEAD.toString(16);
    else if (method === "eth_getBalance") result = "0xde0b6b3a7640000";
    else if (method === "eth_call") result = call(params[0]);
    else if (method === "eth_getBlockByNumber") result = { number: "0x" + HEAD.toString(16), timestamp: "0x" + NOW().toString(16) };
    else if (method === "eth_getLogs") result = [];
    return { jsonrpc: "2.0", id, result };
  }
  function explorer(url) {
    const u = new URL(url);
    if (u.pathname === "/api" && u.searchParams.get("module") === "logs") {
      const t0 = u.searchParams.get("topic0");
      const result = t0 === TOPIC.TagPaid ? tagLogs : t0 === TOPIC.PotPaid ? potLogs : t0 === TOPIC.PotCreated && !empty ? [potCreated] : [];
      return result.length ? { status: "1", message: "OK", result } : { status: "0", message: "No logs found", result: [] };
    }
    if (u.pathname.includes(`/addresses/${ME}/token-transfers`)) return { items: transfers, next_page_params: null };
    if (u.pathname.includes(`/addresses/${ME}/transactions`)) return { items: sent, next_page_params: null };
    return { items: [], next_page_params: null };
  }
  return { rpc, explorer };
}

const browser = await pw.chromium.launch({ executablePath: CHROME });
const consent = JSON.stringify({ v: 2, choice: "declined", at: "2026-11-21T00:00:00.000Z" });
const problems = [];
async function context({ width, mock }) {
  const ctx = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 900 }, deviceScaleFactor: width < 500 ? 2 : 1 });
  await ctx.route("**/*", async (route) => {
    const req = route.request();
    const url = req.url();
    if (url.startsWith(ORIGIN)) return route.continue();
    if (url.startsWith("https://forno.celo.org")) {
      const body = JSON.parse(req.postData() ?? "{}");
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(Array.isArray(body) ? body.map(mock.rpc) : mock.rpc(body)) });
    }
    if (url.startsWith("https://celo.blockscout.com")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mock.explorer(url)) });
    return route.abort();
  });
  const exp = NOW() + 6 * 86400;
  const sess = JSON.stringify({ address: ME, signature: "0x" + "11".repeat(65), exp,
    message: buildSignInMessage({ host: HOST, origin: ORIGIN, address: ME, nonce: "0123456789abcdef", issuedAt: new Date().toISOString(), expiresAt: new Date(exp * 1000).toISOString() }) });
  await ctx.addInitScript(({ consent, sess, key }) => {
    try { localStorage.setItem("np-consent", consent); localStorage.setItem(key, sess); } catch {}
  }, { consent, sess, key: SESSION_KEY });
  return ctx;
}
const shots = [];
async function save(page, name, clip) {
  await page.screenshot({ path: path.join(OUT, name + ".png"), ...(clip ? { clip } : {}) });
  shots.push(name + ".png");
}
async function open(width, { empty = false } = {}) {
  const ctx = await context({ width, mock: mockChain({ empty }) });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => problems.push(`${width}px: ${e.message}`));
  await page.goto(ORIGIN + "/app.html");
  await page.waitForSelector(".np-bell", { timeout: 20000 });
  if (!empty) await page.waitForSelector(".np-bell-badge:not([hidden])", { timeout: 20000 });
  else await page.waitForTimeout(3500);
  await page.waitForTimeout(900);
  return { ctx, page };
}
const panelBox = (page) => page.evaluate(() => { const r = document.querySelector(".np-bell-panel").getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), right: Math.round(innerWidth - r.right) }; });

for (const width of [390, 1440]) {
  const { ctx, page } = await open(width);
  console.log(`${width}px badge: "${await page.textContent(".np-bell-badge")}", label: "${await page.getAttribute(".np-bell", "aria-label")}"`);
  await save(page, `bell-badge-${width}`);
  await page.click(".np-bell");
  await page.waitForSelector(".np-bell-item");
  await page.waitForTimeout(400);
  console.log(`${width}px dropdown:`, await panelBox(page), `focus: ${await page.evaluate(() => document.activeElement?.className)}`);
  await save(page, `bell-open-${width}`);
  // after opening, the count is gone; Esc closes and gives the focus back to the bell
  await page.keyboard.press("Escape");
  console.log(`${width}px after Esc: open=${await page.getAttribute(".np-bell", "aria-expanded")}, badge hidden=${await page.evaluate(() => document.querySelector(".np-bell-badge").hidden)}, focus on bell=${await page.evaluate(() => document.activeElement?.classList.contains("np-bell"))}`);
  await ctx.close();
}
// the landing's own top bar ("About Lokal" while signed in): the bell sits before "Dashboard"
for (const width of [390, 1440]) {
  const ctx = await context({ width, mock: mockChain() });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => problems.push(`landing ${width}px: ${e.message}`));
  await page.goto(ORIGIN + "/index.html?about");
  await page.waitForSelector(".np-bell-badge:not([hidden])", { timeout: 20000 });
  await page.click(".np-bell");
  await page.waitForSelector(".np-bell-item");
  await page.waitForTimeout(500);
  console.log(`landing ${width}px dropdown:`, await panelBox(page));
  await save(page, `bell-landing-open-${width}`, { x: 0, y: 0, width, height: 480 });
  await ctx.close();
}
{
  const { ctx, page } = await open(1440, { empty: true });
  await page.click(".np-bell");
  await page.waitForSelector(".np-bell-note");
  await page.waitForTimeout(400);
  console.log("1440px empty:", await panelBox(page), await page.textContent(".np-bell-note"));
  await save(page, "bell-empty-1440");
  await ctx.close();
}

await browser.close();
server.close();
if (problems.length) console.log("Page errors:\n" + problems.map((p) => "  " + p).join("\n"));
console.log(`${shots.length} screenshots in ${OUT}:\n` + shots.map((s) => "  " + s).join("\n"));
