// Screenshots of the two trust features at 390 px and 1440 px:
//   - the tag page's "Who am I paying?" with no warnings, and with the first-time + new-tag warnings;
//   - the Proof page empty, and populated from a fixture (with one named user who matches and one who doesn't).
//
//   node scripts/screenshots-trust.mjs [out-folder]          (default: ./screenshots/trust)
//
// Needs Google Chrome and playwright-core, exactly like scripts/screenshots.mjs (PLAYWRIGHT_CORE, CHROME).
// MOCKED, in this script's browser only: every Celo read (Forno and Blockscout), the visitor's privacy choice and the
// tags "this browser" has paid. Nothing is served by the site, nothing is signed and nothing is sent.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { abiEncode, AGENT, CURRENCIES, USDT_ADDRESS, tagSuffix } from "../site/assets/core.js";
import { LOKAL_TAGS, LOKAL_POTS, FN, TOPIC } from "../site/assets/lokal-contracts.js";
import { tagHashOf } from "../site/assets/trust.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const SITE = path.join(ROOT, "site");
const OUT = path.resolve(process.argv[2] ?? path.join("screenshots", "trust"));
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

// ---------- the mocked chain ----------
const OWNER = "0x7b3D1e9a0C2f4E5d6A7b8C9d0E1f2A3b4C5d6E7f";
const PAYERS = ["0x1111111111111111111111111111111111111111", "0x3333333333333333333333333333333333333333"];
const RECIPIENTS = [OWNER, "0x9c8B7a6F5e4D3c2B1a0F9e8D7c6B5a4F3e2D1c0B", "0x5e5E5e5E5E5e5e5E5e5E5e5e5e5E5e5E5e5E5E5e"];
const NOW = Math.floor(Date.now() / 1000);
const HEAD = 83_460_000; // Celo: one block a second
const blockAt = (sec) => HEAD - (NOW - sec);
const timeOf = (block) => NOW - (HEAD - block);
const lc = (s) => String(s ?? "").toLowerCase();
const word = (a) => "0x" + lc(a).slice(2).padStart(64, "0");
const hash = (n) => { let h = "", x = n >>> 0; for (let i = 0; i < 8; i++) { x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d) >>> 0; x = (x + 0x9e3779b9) >>> 0; h += x.toString(16).padStart(8, "0"); } return "0x" + h; };
const ZERO = "0x" + "0".repeat(40);
const strOf = (data) => { const h = data.slice(10); const off = parseInt(h.slice(0, 64), 16) * 2; const len = parseInt(h.slice(off, off + 64), 16); return Buffer.from(h.slice(off + 64, off + 64 + len * 2), "hex").toString("utf8"); };
let li = 0;
const log = (address, topics, data, block) => ({ address, topics, data, blockNumber: "0x" + block.toString(16), logIndex: "0x" + (li++ % 9).toString(16), transactionHash: hash(block) });
const claimedLog = (tag, who, name, sec) => log(LOKAL_TAGS, [TOPIC.TagClaimed, tagHashOf(tag), word(who)], "0x" + abiEncode(["string", "string"], [tag, name]), blockAt(sec));
const paidLog = (tag, who, payer, token, amount, sec) => log(LOKAL_TAGS, [TOPIC.TagPaid, tagHashOf(tag), word(who), word(payer)],
  "0x" + abiEncode(["string", "address", "uint256", "bytes32", "uint256"], [tag, token, BigInt(amount), "0x" + "0".repeat(64), BigInt(Math.floor(sec / 86400))]), blockAt(sec));
const potLog = (potId, host, payer, token, amount, sec) => log(LOKAL_POTS, [TOPIC.PotPaid, "0x" + BigInt(potId).toString(16).padStart(64, "0"), word(host), word(payer)],
  "0x" + abiEncode(["address", "uint256", "bytes32", "uint256", "uint256"], [token, BigInt(amount), "0x" + "0".repeat(64), BigInt(amount), 10_000_000n]), blockAt(sec));

/**
 * tags: { [tag]: { owner, name, since, logs } }; payouts: Blockscout agent transactions; deposits: TagPaid/PotPaid logs.
 */
function mockChain({ tags = {}, payouts = [], deposits = [] } = {}) {
  const tagInfo = (t) => {
    const x = tags[t];
    return "0x" + abiEncode(["address", "string", "uint256", "address", "uint256", "address"], x ? [x.owner, x.name, BigInt(x.since), ZERO, 0n, ZERO] : [ZERO, "", 0n, ZERO, 0n, ZERO]);
  };
  function call({ to, data }) {
    const sel = data.slice(0, 10);
    if (lc(to) === lc(LOKAL_TAGS)) {
      if (sel === FN.tagInfo) return tagInfo(strOf(data));
      if (sel === FN.availability) return "0x" + abiEncode(["uint8"], [tags[strOf(data)] ? 2 : 0]);
      if (sel === FN.tokenLimits) return "0x" + abiEncode(["uint128", "uint128", "uint128", "uint128", "uint128"], [1_000_000n, 25_000_000n, 25_000_000n, 25_000_000n, 100_000_000n]);
      if (sel === FN.remainingToday) return "0x" + abiEncode(["uint256", "uint256", "uint256"], [25_000_000n, 25_000_000n, 100_000_000n]);
    }
    return "0x" + "0".repeat(64);
  }
  function rpc({ id, method, params }) {
    let result = null;
    if (method === "eth_chainId") result = "0xa4ec";
    else if (method === "eth_blockNumber") result = "0x" + HEAD.toString(16);
    else if (method === "eth_call") result = call(params[0]);
    else if (method === "eth_getBlockByNumber") result = { number: params[0], timestamp: "0x" + timeOf(parseInt(params[0], 16)).toString(16) };
    else if (method === "eth_getLogs") {
      const f = params[0];
      const all = [...Object.values(tags).flatMap((t) => t.logs ?? []), ...deposits];
      result = all.filter((l) => lc(l.address) === lc(f.address) && (!f.topics?.[0] || l.topics[0] === f.topics[0]) && (!f.topics?.[1] || l.topics[1] === f.topics[1]));
    }
    return { jsonrpc: "2.0", id, result };
  }
  function explorer(url) {
    const u = new URL(url);
    if (u.pathname.includes(`/addresses/${AGENT}/transactions`) && u.searchParams.get("filter") === "from") return { items: payouts, next_page_params: null };
    return { items: [], next_page_params: null };
  }
  return { rpc, explorer };
}

const browser = await pw.chromium.launch({ executablePath: CHROME });
async function context({ width, mock, consent = "declined", paid = null, users = null }) {
  const ctx = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 900 }, deviceScaleFactor: width < 500 ? 2 : 1 });
  await ctx.route("**/*", async (route) => {
    const req = route.request();
    const url = req.url();
    if (users && url === `${ORIGIN}/proof-users.json`) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(users) });
    if (url.startsWith(ORIGIN)) return route.continue();
    if (url.startsWith("https://forno.celo.org") || url.startsWith("https://celo.blockscout.com/api/eth-rpc")) {
      const body = JSON.parse(req.postData() ?? "{}");
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(Array.isArray(body) ? body.map(mock.rpc) : mock.rpc(body)) });
    }
    if (url.startsWith("https://celo.blockscout.com")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mock.explorer(url)) });
    return route.abort();
  });
  await ctx.addInitScript(({ consent, paid }) => {
    try {
      localStorage.setItem("np-consent", JSON.stringify({ v: 2, choice: consent, at: "2026-11-21T00:00:00.000Z" }));
      if (paid) localStorage.setItem("np-paid-tags", JSON.stringify(paid));
    } catch {}
  }, { consent, paid });
  return ctx;
}
const shots = [];
async function tall(page, name) {
  const vp = page.viewportSize();
  await page.evaluate(() => scrollTo(0, 0));
  const h = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width: vp.width, height: h });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, name + ".png") });
  shots.push(name + ".png");
  await page.setViewportSize(vp);
}

// ---------- the tag page ----------
const DAY = 86400, HOUR = 3600;
const ada = {
  owner: OWNER, name: "Ada Obi", since: NOW - 41 * DAY,
  logs: [claimedLog("ada", OWNER, "Ada Obi", NOW - 41 * DAY),
    ...[38, 30, 21, 12, 6, 2].map((d, i) => paidLog("ada", OWNER, PAYERS[i % 2], USDT_ADDRESS, (5 + i) * 1_000_000, NOW - d * DAY))],
};
const bola = { owner: RECIPIENTS[1], name: "Bola", since: NOW - 5 * HOUR, logs: [claimedLog("bola", RECIPIENTS[1], "Bola", NOW - 5 * HOUR)] };
const TAG_SCENES = [
  { name: "tag-no-warnings", tag: "ada", consent: "accepted", paid: ["ada", "tunde"] },
  { name: "tag-first-time-and-new-tag", tag: "bola", consent: "accepted", paid: ["ada", "tunde"] },
];
for (const s of TAG_SCENES) {
  for (const width of [390, 1440]) {
    const ctx = await context({ width, mock: mockChain({ tags: { ada, bola } }), consent: s.consent, paid: s.paid });
    const page = await ctx.newPage();
    await page.goto(`${ORIGIN}/tag.html?t=${s.tag}`);
    await page.waitForSelector(".trust-list", { timeout: 30000 });
    await page.waitForTimeout(1200);
    await tall(page, `${s.name}-${width}`);
    await ctx.close();
  }
}

// ---------- the Proof page ----------
const transferInput = (to, units) => "0xa9059cbb" + abiEncode(["address", "uint256"], [to, BigInt(units)]) + tagSuffix();
const payoutTx = (n, token, to, units, sec) => ({ hash: hash(0x9a0000 + n), from: { hash: AGENT }, to: { hash: token }, method: "transfer", status: "ok",
  timestamp: new Date(sec * 1000).toISOString(), block_number: blockAt(sec), raw_input: transferInput(to, units) });
const [cngn, idrx] = CURRENCIES;
const P1 = payoutTx(1, cngn.address, RECIPIENTS[0], 14_407_700_000n, NOW - 3 * DAY + 90);
const P2 = payoutTx(2, idrx.address, RECIPIENTS[1], 8_102_300n, NOW - 2 * DAY + 120);
const P3 = payoutTx(3, USDT_ADDRESS, RECIPIENTS[2], 9_620_000n, NOW - 5 * HOUR + 60);
const deposits = [
  paidLog("ada", RECIPIENTS[0], PAYERS[0], USDT_ADDRESS, 10_000_000n, NOW - 3 * DAY),
  paidLog("bola", RECIPIENTS[1], PAYERS[1], USDT_ADDRESS, 5_000_000n, NOW - 2 * DAY),
  potLog(3, RECIPIENTS[2], PAYERS[0], cngn.address, 14_000_000_000n, NOW - 5 * HOUR),
];
const rcpt = (h) => "NP-" + h.slice(2, 6).toUpperCase() + "-" + h.slice(6, 10).toUpperCase();
const PROOF_SCENES = [
  { name: "proof-empty", mock: mockChain(), users: [] },
  { name: "proof-populated", mock: mockChain({ payouts: [P3, P2, P1], deposits }), users: [
    { receiptNo: rcpt(P1.hash), label: "Ada", city: "Lagos", usedFor: "school fees" },
    { receiptNo: "NP-0000-0000", label: "An entry with no payout", city: "Abuja", usedFor: "a test" },
  ] },
];
for (const s of PROOF_SCENES) {
  for (const width of [390, 1440]) {
    const ctx = await context({ width, mock: s.mock, users: s.users });
    const page = await ctx.newPage();
    await page.goto(`${ORIGIN}/proof.html`);
    await page.waitForFunction(() => !document.querySelector(".pf-reading"), null, { timeout: 30000 });
    await page.waitForTimeout(800);
    await tall(page, `${s.name}-${width}`);
    await ctx.close();
  }
}

await browser.close();
server.close();
console.log(`${shots.length} screenshots in ${OUT}:\n` + shots.map((s) => "  " + s).join("\n"));
