// Screenshots of Pots at 390 px and 1440 px: opening a pot from the dashboard, the pot it made (link and QR code),
// the public pot page with its Spray Wall, a guest spraying, and the host's "Your pots" card.
//
//   node scripts/screenshots-pots.mjs [out-folder]          (default: ./screenshots/pots)
//   node scripts/screenshots-pots.mjs <out-folder> delete   only "Delete pot": the buttons, the confirm dialog, a refused
//                                                           close (the pot stays) and "Show deleted pots" (390, 1440; 360 checked)
//
// Needs Google Chrome and playwright-core (not a dependency of this repo); point at them with PLAYWRIGHT_CORE and CHROME
// exactly as for scripts/screenshots.mjs. Serves site/ locally; the rate is the live one from lokalpay.vercel.app.
//
// MOCKED, in this script's browser only: a wallet (window.ethereum that signs nothing real and sends nothing), a
// sign-in session for the example host "@ada", and every chain answer (LokalTags, LokalPots, the tokens, the explorer's
// log API). Nothing is broadcast: eth_sendTransaction returns a made-up hash and the "receipt" is invented here.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { encodeAbiParameters, encodeEventTopics, decodeFunctionData, encodeErrorResult } from "viem";
import { buildSignInMessage, SESSION_KEY } from "../site/assets/session.js";
import { abiEncode, CURRENCIES, USDT_ADDRESS, tagSuffix } from "../site/assets/core.js";
import { LOKAL_TAGS, LOKAL_POTS, FN, TOPIC, currencyRef, potUsdValue } from "../site/assets/lokal-contracts.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const SITE = path.join(ROOT, "site");
const OUT = path.resolve(process.argv[2] ?? "screenshots/pots");
const ONLY = process.argv[3] ?? null; // "delete": only the Delete pot shots
fs.mkdirSync(OUT, { recursive: true });
const CHROME = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const pw = createRequire(path.join(process.env.PLAYWRIGHT_CORE ?? ROOT, "x.js"))("playwright-core");
const potsAbi = JSON.parse(fs.readFileSync(path.join(ROOT, "contracts/deployments/LokalPots.json"), "utf8")).abi;
const EV = (name) => potsAbi.find((x) => x.type === "event" && x.name === name);

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
const HOST_NAME = new URL(ORIGIN).host;

// ---------- the example host @ada, her pots and their guests (all invented) ----------
const ME = "0x5ad4e1b2c3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8";
const GUEST = "0x9c1e7a3b5d2f4c6e8a0b1d3f5e7c9a2b4d6e8f01";
const CNGN = CURRENCIES[0].address;
const lc = (s) => String(s ?? "").toLowerCase();
const word = (n) => BigInt(n).toString(16).padStart(64, "0");
const usd = (n) => BigInt(Math.round(n * 1e6));
const hashOf = (n) => "0x" + n.toString(16).padStart(8, "0").repeat(8);
const HEAD = 84_000_000;
const NOW = () => Math.floor(Date.now() / 1000);

function mockChain({ closedPot = false } = {}) {
  const now = NOW();
  const st = {
    pots: new Map([
      [3n, { host: ME, title: "Bisi's 30th", closesAt: now - 2 * 86_400, open: false, cap: usd(80), each: usd(4), payers: new Set(), sprays: [] }],
      [7n, { host: ME, title: "Ada & Tunde's wedding", closesAt: now + 2 * 86_400 + 5 * 3600, open: true, cap: usd(100), each: usd(5), payers: new Set(), sprays: [] }],
    ]),
    count: 7n, lastPay: null, lastCreate: null, lastClose: null, refuseClose: false, sent: 0, block: HEAD,
  };
  if (closedPot) st.pots.set(5n, { host: ME, title: "Office kitty for Chidi", closesAt: now + 4 * 86_400, open: false, cap: usd(60), each: usd(5), payers: new Set(), sprays: [] });
  // guests' sprays: [minutes ago, token, units, receive]
  const seed = [[3, "usdt", 5, "cngn"], [7, "cngn", 7205, "cngn"], [12, "usdt", 2, "cngn"], [18, "usdt", 5, "usdt"], [26, "cngn", 2882, "cngn"],
    [41, "usdt", 1, "cngn"], [55, "usdt", 3, "idrx"], [80, "cngn", 4323, "usdt"], [96, "usdt", 5, "cngn"], [130, "usdt", 2.5, "cngn"], [150, "usdt", 4, "cngn"]];
  seed.reverse().forEach(([ago, pay, n, recv], i) => addSpray(7n, `0x${(i + 1).toString(16).padStart(40, "a")}`, pay === "usdt" ? USDT_ADDRESS : CNGN, usd(n), recv, HEAD - ago * 60, i));
  for (let i = 0; i < 16; i++) addSpray(3n, `0x${(i + 1).toString(16).padStart(40, "b")}`, USDT_ADDRESS, usd(4), "cngn", HEAD - 3 * 86_400 + i * 400, i);

  function addSpray(id, payer, token, amount, recv, block, logIndex) {
    const p = st.pots.get(id);
    const rate = lc(token) === lc(CNGN) ? 1_441_000_000n : 1_000_000n;
    const v = potUsdValue(amount, rate);
    p.payers.add(lc(payer));
    const total = p.sprays.reduce((s, x) => s + x.usd6, 0n) + v;
    p.sprays.push({ id, payer, token, amount, recv, usd6: v, total, block, logIndex, hash: hashOf(0x5000 + Number(id) * 100 + p.sprays.length) });
  }
  const totalOf = (p) => p.sprays.reduce((s, x) => s + x.usd6, 0n);
  const paidLog = (s) => ({
    address: LOKAL_POTS, topics: encodeEventTopics({ abi: [EV("PotPaid")], eventName: "PotPaid", args: { potId: s.id, host: ME, payer: s.payer } }),
    data: encodeAbiParameters(EV("PotPaid").inputs.filter((i) => !i.indexed), [s.token, s.amount, currencyRef(s.recv), s.total, s.usd6]),
    blockNumber: "0x" + s.block.toString(16), logIndex: "0x" + s.logIndex.toString(16), transactionHash: s.hash,
  });
  const createdLog = (id, p) => ({
    address: LOKAL_POTS, topics: encodeEventTopics({ abi: [EV("PotCreated")], eventName: "PotCreated", args: { potId: id, host: p.host } }),
    data: encodeAbiParameters(EV("PotCreated").inputs.filter((i) => !i.indexed), [p.title, BigInt(p.closesAt), p.cap, p.each]),
    blockNumber: "0x" + (HEAD - 100_000 + Number(id)).toString(16), logIndex: "0x0", transactionHash: hashOf(0x7000 + Number(id)),
  });
  const potInfo = (id) => {
    const p = st.pots.get(id);
    if (!p) return null;
    return abiEncode(["address", "string", "uint256", "bool", "uint256", "uint256", "uint256", "uint256"],
      [p.host, p.title, BigInt(p.closesAt), p.open && NOW() < p.closesAt, p.cap, p.each, totalOf(p), BigInt(p.payers.size)]);
  };
  const potArg = (data) => BigInt("0x" + data.slice(10, 74));
  const addrArg = (data, i) => "0x" + data.slice(10 + 64 * i + 24, 10 + 64 * (i + 1));
  const revert = (sel) => ({ error: { code: 3, message: "execution reverted", data: sel } });
  const err = (name) => encodeErrorResult({ abi: potsAbi, errorName: name, args: [] });

  function call({ to, data, from }) {
    const sel = data.slice(0, 10);
    if (lc(to) === lc(LOKAL_POTS)) {
      if (from) { // a transaction simulated from the wallet: the contract says yes, and the call is remembered for its receipt
        const sfx = tagSuffix().length; // the attribution suffix the site appends (trimmed for viem)
        if (sel === FN.createPot) st.lastCreate = decodeFunctionData({ abi: potsAbi, data: data.slice(0, -sfx) }).args;
        if (sel === FN.payPot) st.lastPay = { ...decodeFunctionData({ abi: potsAbi, data: data.slice(0, -sfx) }), from };
        if (sel === FN.closePot) {
          const id = potArg(data);
          if (st.refuseClose || lc(st.pots.get(id)?.host) !== lc(from)) return revert(err("NotHost"));
          st.lastClose = id;
        }
        return { result: "0x" };
      }
      if (sel === FN.potInfo) { const r = potInfo(potArg(data)); return r ? { result: r } : revert("0x30e4a782" + word(potArg(data))); }
      if (sel === FN.potCount) return { result: "0x" + word(st.count) };
      if (sel === FN.maxPotCapUsd6) return { result: "0x" + word(usd(100)) };
      if (sel === FN.maxPerPayerCapUsd6) return { result: "0x" + word(usd(5)) };
      if (sel === FN.maxPerHostDailyUsd6) return { result: "0x" + word(usd(100)) };
      if (sel === FN.maxDailyUsd6) return { result: "0x" + word(usd(250)) };
      if (sel === FN.unitsPerUsd) return { result: "0x" + word(lc(addrArg(data, 0)) === lc(CNGN) ? 1_441_000_000n : 1_000_000n) };
      if (sel === FN.remaining) {
        const p = st.pots.get(potArg(data)), payer = lc(addrArg(data, 1));
        const paid = p.sprays.filter((s) => lc(s.payer) === payer).reduce((s, x) => s + x.usd6, 0n);
        return { result: abiEncode(["uint256", "uint256", "uint256", "uint256"], [p.each - paid, p.cap - totalOf(p), usd(100) - totalOf(p), usd(250) - totalOf(p)]) };
      }
      if (sel === FN.validatePotPayment) {
        const amount = BigInt("0x" + data.slice(138, 202)), token = addrArg(data, 1);
        return { result: "0x" + word(potUsdValue(amount, lc(token) === lc(CNGN) ? 1_441_000_000n : 1_000_000n)) };
      }
      return { result: "0x" + word(0) };
    }
    if (lc(to) === lc(LOKAL_TAGS)) {
      if (sel === FN.tagOf) return { result: abiEncode(["string"], [lc(addrArg(data, 0)) === lc(ME) ? "ada" : ""]) };
      if (sel === FN.tagInfo) return { result: abiEncode(["address", "string", "uint256", "address", "uint256", "address"], [ME, "Ada Obi", 1795300000n, "0x" + "0".repeat(40), 0n, CNGN]) };
      if (sel === FN.tokenLimits) {
        const n = lc(addrArg(data, 0)) === lc(CNGN);
        return { result: abiEncode(["uint128", "uint128", "uint128", "uint128", "uint128"], n ? [1_441_000_000n, 34_944_000_000n, 34_944_000_000n, 34_944_000_000n, 349_440_000_000n] : [usd(1), usd(25), usd(25), usd(25), usd(250)]) };
      }
      return { result: "0x" + word(0) };
    }
    if (sel === FN.balanceOf) return { result: "0x" + word(lc(to) === lc(CNGN) ? 25_000_000_000n : usd(48.5)) };
    if (sel === FN.allowance) return { result: "0x" + word(0) };
    if (sel === "0x313ce567") return { result: "0x" + word(6) };
    return { result: "0x" + word(0) };
  }
  function receipt(hash) {
    const kind = hash.slice(2, 10);
    st.block += 3;
    if (kind === FN.createPot.slice(2) && st.lastCreate) {
      const [title, closesAt, cap, each] = st.lastCreate;
      const id = ++st.count;
      st.pots.set(id, { host: ME, title, closesAt: Number(closesAt), open: true, cap, each, payers: new Set(), sprays: [] });
      st.lastCreate = null;
      return { status: "0x1", blockNumber: "0x" + st.block.toString(16), logs: [createdLog(id, st.pots.get(id))] };
    }
    if (kind === FN.closePot.slice(2) && st.lastClose != null) {
      st.pots.get(st.lastClose).open = false;
      st.lastClose = null;
      return { status: "0x1", blockNumber: "0x" + st.block.toString(16), logs: [] };
    }
    if (kind === FN.payPot.slice(2) && st.lastPay) {
      const [id, token, amount, ref] = st.lastPay.args;
      const recv = Buffer.from(ref.slice(2), "hex").toString("utf8").replace(/\0+$/, "").replace(/^cur:/, "") || "usdt";
      addSpray(id, st.lastPay.from, token, amount, recv, st.block, 0);
      const s = st.pots.get(id).sprays.at(-1);
      s.hash = hash;
      st.lastPay = null;
      return { status: "0x1", blockNumber: "0x" + st.block.toString(16), logs: [paidLog(s)] };
    }
    return { status: "0x1", blockNumber: "0x" + st.block.toString(16), logs: [] };
  }
  function rpc(body) {
    const { id, method, params } = body;
    const out = (r) => ({ jsonrpc: "2.0", id, ...r });
    if (method === "eth_chainId") return out({ result: "0xa4ec" });
    if (method === "eth_blockNumber") return out({ result: "0x" + st.block.toString(16) });
    if (method === "eth_getBalance") return out({ result: "0xde0b6b3a7640000" });
    if (method === "eth_call") return out(call(params[0]));
    if (method === "eth_getBlockByNumber") {
      const n = params[0] === "latest" ? st.block : parseInt(params[0], 16);
      return out({ result: { number: "0x" + n.toString(16), timestamp: "0x" + (NOW() - (st.block - n)).toString(16) } });
    }
    if (method === "eth_getLogs") {
      const f = params[0], from = parseInt(f.fromBlock, 16), to = parseInt(f.toBlock, 16);
      const id = f.topics?.[1] ? BigInt(f.topics[1]) : null;
      const logs = [...st.pots.entries()].filter(([pid]) => id == null || pid === id).flatMap(([, p]) => p.sprays).filter((s) => s.block >= from && s.block <= to).map(paidLog);
      return out({ result: logs });
    }
    if (method === "eth_getTransactionReceipt") return out({ result: receipt(params[0]) });
    return out({ result: null });
  }
  function explorer(url) {
    const u = new URL(url);
    if (u.pathname === "/api" && u.searchParams.get("module") === "logs") {
      const t0 = u.searchParams.get("topic0");
      const asRow = (l, ts) => ({ ...l, timeStamp: "0x" + ts.toString(16) });
      if (t0 === TOPIC.PotPaid) {
        const t1 = u.searchParams.get("topic1"); // none: the bell asks for every spray to this host
        const sprays = t1 ? st.pots.get(BigInt(t1))?.sprays ?? [] : [...st.pots.values()].flatMap((p) => p.sprays);
        const rows = sprays.map((s) => asRow(paidLog(s), NOW() - (st.block - s.block)));
        return rows.length ? { status: "1", message: "OK", result: rows } : { status: "0", message: "No logs found", result: [] };
      }
      if (t0 === TOPIC.PotCreated) {
        const rows = [...st.pots.entries()].filter(([, p]) => lc(p.host) === lc(ME)).map(([id, p]) => asRow(createdLog(id, p), NOW() - 86_400));
        return { status: "1", message: "OK", result: rows };
      }
    }
    return { items: [], next_page_params: null };
  }
  return { st, rpc, explorer };
}

const browser = await pw.chromium.launch({ executablePath: CHROME });
const consent = JSON.stringify({ v: 2, choice: "declined", at: "2026-11-21T00:00:00.000Z" });
const errors = [];
async function context({ width, mock, session = false, wallet = null, reduced = false }) {
  const ctx = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 900 }, deviceScaleFactor: width < 500 ? 2 : 1, reducedMotion: reduced ? "reduce" : "no-preference" });
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
  const exp = Math.floor(Date.now() / 1000) + 6 * 86400;
  const sess = session ? JSON.stringify({ address: ME, signature: "0x" + "11".repeat(65), exp,
    message: buildSignInMessage({ host: HOST_NAME, origin: ORIGIN, address: ME, nonce: "0123456789abcdef", issuedAt: new Date().toISOString(), expiresAt: new Date(exp * 1000).toISOString() }) }) : null;
  await ctx.addInitScript(({ consent, sess, key, wallet }) => {
    try { localStorage.setItem("np-consent", consent); if (sess) localStorage.setItem(key, sess); } catch {}
    if (!wallet) return;
    let accs = wallet.connected ? [wallet.account] : [];
    let n = 0;
    window.ethereum = {
      isMetaMask: true, on() {}, removeListener() {},
      async request({ method, params }) {
        if (method === "eth_accounts") return accs;
        if (method === "eth_requestAccounts") { accs = [wallet.account]; return accs; }
        if (method === "eth_chainId") return "0xa4ec";
        // never broadcast: a made-up hash that starts with the call's selector, so the mocked receipt knows what it was
        if (method === "eth_sendTransaction") { n++; window.__sentTx = n; return "0x" + params[0].data.slice(2, 10) + n.toString(16).padStart(56, "0"); }
        if (method === "wallet_switchEthereumChain") return null;
        throw Object.assign(new Error("unsupported in the screenshot wallet"), { code: 4200 });
      },
    };
  }, { consent, sess, key: SESSION_KEY, wallet });
  ctx.on("page", (p) => p.on("pageerror", (e) => errors.push(`${p.url()}: ${e.message}`)));
  return ctx;
}
const shots = [];
const overflow = [];
const save = async (target, name, opts = {}) => {
  const page = typeof target.page === "function" ? target.page() : target;
  // nothing may stick out sideways (a phone would scroll); then line the page up before an element shot, with the
  // fixed app bar out of the way (it would otherwise be stitched into the middle of a tall element)
  const o = await page.evaluate((el) => {
    document.documentElement.classList.toggle("shot-el", el);
    const W = document.documentElement.clientWidth;
    const wide = [...document.querySelectorAll("main *")].filter((n) => n.getBoundingClientRect().right > W + 1 && !n.closest("[hidden]")).slice(0, 4).map((n) => `${n.tagName.toLowerCase()}.${String(n.className).split(" ")[0]}`);
    scrollTo(0, scrollY);
    return wide.length ? wide.join(", ") : null;
  }, page !== target);
  if (o) overflow.push(`${name}: ${o}`);
  if (page === target) await page.screenshot({ path: path.join(OUT, name + ".png"), ...opts });
  else {
    // an element: the viewport made as tall as the page (like tall()), then clipped, so nothing scrolls to take it
    const vp = page.viewportSize();
    await page.evaluate(() => scrollTo(0, 0));
    await page.setViewportSize({ width: vp.width, height: await page.evaluate(() => document.documentElement.scrollHeight) });
    await settle(page, 400);
    const box = await target.evaluate((n) => { const r = n.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; });
    await page.screenshot({ path: path.join(OUT, name + ".png"), clip: box });
    await page.setViewportSize(vp);
  }
  shots.push(name + ".png");
};
const settle = (page, ms = 700) => page.waitForTimeout(ms);
async function tall(page, name) {
  const vp = page.viewportSize();
  await page.evaluate(() => scrollTo(0, 0));
  const h = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width: vp.width, height: h });
  await settle(page, 500);
  await save(page, name);
  await page.setViewportSize(vp);
}
const hideConsent = (page) => page.addStyleTag({ content: ".consent { display: none !important; } .shot-el .nav-wrap { visibility: hidden; }" });

const checks = [];
const check = (ok, what) => { checks.push(`${ok ? "ok  " : "FAIL"} ${what}`); };
const delBtn = (page, title) => page.locator(`#pots .pot-delete[aria-label$="${title}"]`);
async function deleteShots(width) {
  const mock = mockChain({ closedPot: true });
  const ctx = await context({ width, mock, session: true, wallet: { connected: true, account: ME } });
  const page = await ctx.newPage();
  const w = `${width}`;
  const shoot = width !== 360; // 360: checked for overflow, saved as check-*
  const name = (n) => (shoot ? `pots-delete-${n}-${w}` : `check-${n}-${w}`);
  await page.goto(ORIGIN + "/app.html");
  await hideConsent(page);
  await page.waitForSelector(".pot-rows", { timeout: 20000 });
  await settle(page, 1200);
  const pots = page.locator("#pots");
  const WED = "Ada & Tunde's wedding", BISI = "Bisi's 30th";
  check(await page.locator("#pots .pot-delete").count() === 3, `${w}: three pots, each with a delete button`);
  check((await delBtn(page, WED).textContent()) === "Close & delete", `${w}: the open pot says Close & delete`);
  check((await delBtn(page, BISI).textContent()) === "Delete", `${w}: the ended pot says Delete`);
  await save(pots, name("1-list"));
  // the confirm dialog: focus inside, Esc cancels and focus goes back
  await delBtn(page, WED).click();
  await page.waitForSelector("dialog.pot-dialog[open]");
  await settle(page, 400);
  check(await page.evaluate(() => document.activeElement?.closest("dialog") != null), `${w}: focus moves into the dialog`);
  await save(page, name("2-confirm"));
  await page.keyboard.press("Escape");
  await settle(page, 200);
  check(await page.locator("dialog.pot-dialog").count() === 0, `${w}: Esc closes the dialog`);
  check(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")) === `Close & delete: ${WED}`, `${w}: focus is back on the button`);
  check(await page.locator("#pots .pot-deleted-toggle").count() === 0, `${w}: Esc deleted nothing`);
  // a refused close: the error shows and the pot stays
  mock.st.refuseClose = true;
  await delBtn(page, WED).click();
  await page.locator("dialog.pot-dialog button:has-text('Close & delete')").click();
  await page.waitForSelector("#pots .alert.err", { timeout: 20000 });
  check(await delBtn(page, WED).count() === 1, `${w}: a refused close keeps the pot listed`);
  check(await page.evaluate(() => localStorage.getItem("np-pots-hidden")) == null, `${w}: a refused close stores nothing`);
  if (width === 390) await save(pots, name("3-refused"));
  mock.st.refuseClose = false;
  // Delete the ended pot (no transaction) and Close & delete the open one (closed first)
  const txBefore = await page.evaluate(() => window.__sentTx ?? 0);
  await delBtn(page, BISI).click();
  await page.locator("dialog.pot-dialog button:has-text('Delete')").click();
  await page.waitForSelector("#pots .pot-deleted-toggle");
  check(await page.evaluate(() => window.__sentTx ?? 0) === txBefore, `${w}: Delete sent no transaction`);
  check(await page.evaluate(() => document.activeElement?.classList.contains("pot-deleted-toggle")), `${w}: after a delete, focus lands on Show deleted pots`);
  await delBtn(page, WED).click();
  await page.locator("dialog.pot-dialog button:has-text('Close & delete')").click();
  await page.waitForSelector("#pots .pot-deleted-toggle:has-text('(2)')", { timeout: 30000 });
  check(mock.st.pots.get(7n).open === false, `${w}: the open pot was closed before it was hidden`);
  check(JSON.stringify(await page.evaluate(() => JSON.parse(localStorage.getItem("np-pots-hidden")))) === JSON.stringify({ [ME]: [3, 7] }), `${w}: stored per wallet as { address: [3, 7] }`);
  await page.click("#pots .pot-deleted-toggle");
  await settle(page, 500);
  await save(pots, name("4-deleted-shown"));
  // a reload: still deleted; Restore brings one back
  await page.reload();
  await page.waitForSelector("#pots .pot-deleted-toggle", { timeout: 20000 });
  check((await page.locator("#pots .pot-deleted-toggle").textContent()) === "Show deleted pots (2)", `${w}: still deleted after a reload`);
  await page.click("#pots .pot-deleted-toggle");
  await page.locator(`#pots button[aria-label="Restore ${BISI}"]`).click();
  await settle(page, 300);
  check(await delBtn(page, BISI).count() === 1, `${w}: Restore puts it back`);
  check(await page.evaluate(() => document.activeElement?.textContent) === BISI, `${w}: focus goes to the restored pot`);
  await ctx.close();
}
if (ONLY === "delete") {
  for (const width of [390, 1440, 360]) await deleteShots(width);
  // storage full: Delete still works for this page, and says it won't last
  const mock = mockChain({ closedPot: true });
  const ctx = await context({ width: 390, mock, session: true, wallet: { connected: true, account: ME } });
  await ctx.addInitScript(() => { const set = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (k === "np-pots-hidden") throw new DOMException("full", "QuotaExceededError"); return set.call(this, k, v); }; });
  const page = await ctx.newPage();
  await page.goto(ORIGIN + "/app.html");
  await page.waitForSelector(".pot-rows", { timeout: 20000 });
  await delBtn(page, "Bisi's 30th").click();
  await page.locator("dialog.pot-dialog button:has-text('Delete')").click();
  await page.waitForSelector("#pots .pot-deleted-toggle");
  check((await page.locator("#toast").textContent()).includes("blocks storage"), "storage full: deleted for this page, and it says so");
  await page.reload();
  await page.waitForSelector(".pot-rows", { timeout: 20000 });
  check(await delBtn(page, "Bisi's 30th").count() === 1 && await page.locator("#pots .pot-deleted-toggle").count() === 0, "storage full: back after a reload");
  await ctx.close();
}
for (const width of ONLY ? [] : [390, 1440]) {
  // ---------- the host: create a pot on the dashboard, see it made, the "Your pots" card ----------
  {
    const mock = mockChain();
    const ctx = await context({ width, mock, session: true, wallet: { connected: true, account: ME } });
    const page = await ctx.newPage();
    await page.goto(ORIGIN + "/app.html");
    await hideConsent(page);
    await page.waitForSelector(".pot-rows", { timeout: 20000 });
    await settle(page, 1200);
    await save(page.locator("#pots"), `pots-5-host-card-${width}`);
    await page.click("#pots button:has-text('New pot')");
    await page.fill("#pot-title-in", "Tola & Femi's engagement");
    await page.click("#pots .segmented button:has-text('3 days')");
    await page.fill("#pot-cap-in", "60");
    await page.fill("#pot-each-in", "5");
    await page.locator("#pot-each-in").blur();
    await settle(page);
    await save(page.locator("#pots"), `pots-1-create-${width}`);
    await page.click("#pots button:has-text('Open the pot')");
    await page.waitForSelector(".pot-made", { timeout: 30000 });
    await page.waitForSelector(".pot-rows", { timeout: 20000 });
    await settle(page, 1400);
    await save(page.locator("#pots"), `pots-2-created-qr-${width}`);
    if (width === 1440) await tall(page, `pots-dashboard-full-${width}`);
    await ctx.close();
  }
  // ---------- a guest: the pot page and its Spray Wall, then spraying ----------
  {
    const mock = mockChain();
    const ctx = await context({ width, mock, wallet: { connected: false, account: GUEST } });
    const page = await ctx.newPage();
    await page.goto(ORIGIN + "/pot.html?id=7");
    await hideConsent(page);
    await page.waitForSelector(".pot-notes", { timeout: 20000 });
    await settle(page, 1500);
    await tall(page, `pots-3-pot-page-${width}`);
    await page.click("button:has-text('Connect wallet')");
    await page.waitForSelector("button:has-text('Spray $')", { timeout: 20000 });
    await page.click(".pot-quick-btn:has-text('$2')");
    await settle(page, 600);
    await save(page.locator(".pot-spray"), `pots-4a-spray-form-${width}`);
    await page.click("button:has-text('Spray $')");
    await page.waitForSelector(".pot-spray .ok-panel", { timeout: 30000 });
    await page.locator(".pot-wall").scrollIntoViewIfNeeded();
    await settle(page, 450); // mid-celebration: the new note settling, a few notes still fluttering
    await save(page.locator(".pot-wall"), `pots-4b-spray-landing-${width}`);
    await settle(page, 2400);
    await tall(page, `pots-4c-sprayed-${width}`);
    await ctx.close();
  }
}
// ---------- edge states at phone width: a pot that isn't there, an ended pot, reduced motion ----------
if (!ONLY) {
  const mock = mockChain();
  const ctx = await context({ width: 390, mock, reduced: true });
  const page = await ctx.newPage();
  await page.goto(ORIGIN + "/pot.html?id=3");
  await hideConsent(page);
  await page.waitForSelector(".pot-notes", { timeout: 20000 });
  await settle(page, 1000);
  await tall(page, "pots-6-ended-pot-390");
  await page.goto(ORIGIN + "/pot.html?id=99");
  await page.waitForSelector("text=There's no pot #99", { timeout: 20000 });
  await settle(page, 600);
  await save(page, "pots-7-not-found-390");
  await ctx.close();
}

await browser.close();
server.close();
if (checks.length) console.log(checks.join("\n"));
if (errors.length) console.error("Page errors:\n" + errors.map((e) => "  " + e).join("\n"));
if (overflow.length) console.error("Wider than the screen:\n" + overflow.map((e) => "  " + e).join("\n"));
console.log(`${shots.length} screenshots in ${OUT}:\n` + shots.map((s) => "  " + s).join("\n"));
