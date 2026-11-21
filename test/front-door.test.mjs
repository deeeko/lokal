// The front door: who sees what (landing redirect, Activity and dashboard gating, the gateway's first step), the
// "Add <token> to my wallet" request, and the "Yours" rows the dashboard and Activity share.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { buildSignInMessage, SESSION_KEY } from "../site/assets/session.js";
import { activityVisible, dashboardView, gatewayStep, PUBLIC_PAGES, SIGNED_IN_PAGES, GATEWAY_STEPS } from "../site/assets/front-door.js";
import { WALLET_TOKENS, watchAssetParams, addTokenToWallet, addTokenError } from "../site/assets/wallet-assets.js";
import { activityRows, receivedTotals, decodeTagsCall } from "../site/assets/my-activity.js";
import { CURRENCIES, USDT_ADDRESS, AGENT, abiEncode } from "../site/assets/core.js";
import { LOKAL_TAGS, FN, claimData, payTagData, currencyRef } from "../site/assets/lokal-contracts.js";

const ADDR = "0x1111111111111111111111111111111111111111";
const NOW = 1_795_000_000; // seconds
const iso = (sec) => new Date(sec * 1000).toISOString();
/** A stored session exactly as session.js signIn() writes it. */
function stored({ address = ADDR, exp = NOW + 3600, issued = NOW - 60 } = {}) {
  const message = buildSignInMessage({ host: "lokalpay.vercel.app", origin: "https://lokalpay.vercel.app", address, nonce: "0123456789abcdef", issuedAt: iso(issued), expiresAt: iso(exp) });
  return JSON.stringify({ address, message, signature: "0x" + "ab".repeat(65), exp });
}

/** Runs site/assets/gate.js in a sandbox with this storage and URL; returns { gate, replaced }. */
function runGate({ session = null, walletOff = null, search = "", now = NOW } = {}) {
  let replaced = null;
  const store = (v) => ({ getItem: (k) => v[k] ?? null });
  const sandbox = {
    window: undefined,
    document: {},
    location: { search, replace: (to) => { replaced = to; } },
    localStorage: store(session ? { [SESSION_KEY]: session } : {}),
    sessionStorage: store(walletOff ? { "np-wallet-off": walletOff } : {}),
    Date: class extends Date { static now() { return now * 1000; } },
    JSON, Math, String, Boolean, isFinite,
  };
  sandbox.window = sandbox;
  vm.runInNewContext(fs.readFileSync(new URL("../site/assets/gate.js", import.meta.url), "utf8"), sandbox);
  return { gate: sandbox.LokalGate, replaced };
}

test("landing gate: a signed-in visitor goes straight to the dashboard", () => {
  assert.equal(runGate({ session: stored() }).replaced, "app.html");
});

test("landing gate: visitors, About Lokal, expired, disconnected or malformed sessions stay on the landing", () => {
  assert.equal(runGate().replaced, null, "no session");
  assert.equal(runGate({ session: stored(), search: "?about" }).replaced, null, "?about");
  assert.equal(runGate({ session: stored(), search: "?x=1&about" }).replaced, null, "&about");
  assert.equal(runGate({ session: stored(), search: "?about=1" }).replaced, null, "?about=1");
  assert.equal(runGate({ session: stored(), search: "?aboutx" }).replaced, "app.html", "only the exact word counts");
  assert.equal(runGate({ session: stored({ exp: NOW - 1 }) }).replaced, null, "expired");
  assert.equal(runGate({ session: stored(), walletOff: "1" }).replaced, null, "disconnected in this tab");
  assert.equal(runGate({ session: "{not json" }).replaced, null, "malformed JSON");
  const s = JSON.parse(stored());
  assert.equal(runGate({ session: JSON.stringify({ ...s, address: "0x2222222222222222222222222222222222222222" }) }).replaced, null, "message names another address");
  assert.equal(runGate({ session: JSON.stringify({ ...s, exp: s.exp + 60 }) }).replaced, null, "exp doesn't match the signed message");
  assert.equal(runGate({ session: JSON.stringify({ ...s, signature: 7 }) }).replaced, null, "no signature");
});

test("landing gate: the pure decision matches what the page does", () => {
  const { gate } = runGate();
  assert.equal(gate.gateTarget({ search: "", stored: stored(), walletOff: null, nowSec: NOW }), "app.html");
  assert.equal(gate.gateTarget({ search: "?about", stored: stored(), walletOff: null, nowSec: NOW }), null);
  assert.equal(gate.hasSession(null, null, NOW), false);
});

test("Activity and the dashboard: only a signed-in wallet sees its rows; signed out never redirects", () => {
  assert.equal(activityVisible(null), false);
  assert.equal(activityVisible({ address: "nope" }), false);
  assert.equal(activityVisible({ address: ADDR }), true);
  assert.equal(dashboardView(null, "ada"), "signed-out");
  assert.equal(dashboardView({ address: ADDR }, undefined), "loading");
  assert.equal(dashboardView({ address: ADDR }, null), "no-tag");
  assert.equal(dashboardView({ address: ADDR }, "ada"), "tag");
  // payer pages are never gated; the signed-in pages are disjoint from them
  for (const p of ["tag.html", "pay.html", "quote.html", "receipt.html", "verify.html", "cash-out.html", "docs.html", "privacy.html", "terms.html", "agent.html", "proof.html", "features.html"]) assert.ok(PUBLIC_PAGES.includes(p), p);
  for (const p of SIGNED_IN_PAGES) assert.ok(!PUBLIC_PAGES.includes(p), p);
});

test("the gateway starts at the first step that isn't done", () => {
  assert.equal(gatewayStep({}), "connect");
  assert.equal(gatewayStep({ account: ADDR }), "sign");
  assert.equal(gatewayStep({ session: { address: ADDR }, account: "0x2222222222222222222222222222222222222222" }), "sign", "wallet on another account");
  assert.equal(gatewayStep({ session: { address: ADDR }, account: ADDR.toUpperCase().replace("0X", "0x"), tag: null }), "tag");
  assert.equal(gatewayStep({ session: { address: ADDR }, account: null, tag: "ada" }), "welcome");
  assert.deepEqual(GATEWAY_STEPS.map((s) => s.id), ["connect", "sign", "tag", "name"]);
});

test("add to wallet: exact wallet_watchAsset params for every token", () => {
  assert.deepEqual(WALLET_TOKENS.map((t) => t.code), ["cngn", "idrx", "wars", "wcop", "usdt"]);
  for (const c of CURRENCIES) {
    assert.deepEqual(watchAssetParams(c.code), { type: "ERC20", options: { address: c.address, symbol: c.token, decimals: c.decimals } });
  }
  assert.deepEqual(watchAssetParams("usdt"), { type: "ERC20", options: { address: USDT_ADDRESS, symbol: "USD₮", decimals: 6 } });
  // symbols are what each contract's symbol() returns on Celo, decimals as onchain
  assert.deepEqual(WALLET_TOKENS.map((t) => [t.symbol, t.decimals]), [["cNGN", 6], ["IDRX", 2], ["wARS", 18], ["wCOP", 18], ["USD₮", 6]]);
  assert.throws(() => watchAssetParams("ngn"), /unknown token/);
  assert.throws(() => watchAssetParams("toString"), /unknown token/);
});

test("add to wallet: switches to Celo first, then asks once; no wallet or a refusal is explained", async () => {
  const calls = [];
  let chain = "0x1";
  const eth = { request: async ({ method, params }) => {
    calls.push(method);
    if (method === "eth_chainId") return chain;
    if (method === "wallet_switchEthereumChain") { chain = "0xa4ec"; return null; }
    if (method === "wallet_watchAsset") { assert.deepEqual(params, watchAssetParams("idrx")); return true; }
    throw new Error("unexpected " + method);
  } };
  assert.equal(await addTokenToWallet(eth, "idrx"), true);
  assert.deepEqual(calls, ["eth_chainId", "wallet_switchEthereumChain", "eth_chainId", "wallet_watchAsset"]);
  const no = { request: async ({ method }) => (method === "eth_chainId" ? "0xa4ec" : false) };
  assert.equal(await addTokenToWallet(no, "cngn"), false, "the person said no");
  await assert.rejects(addTokenToWallet(null, "cngn"), (e) => e.plain && /No wallet found/.test(e.message));
  assert.match(addTokenError({ code: 4001 }, "wcop"), /cancelled\. wCOP was not added/);
  assert.match(addTokenError({ code: -32601, message: "Method not supported" }, "cngn"), /0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f, 6 decimals/);
});

test("Yours: contract tag payments, payouts and tag calls become plain rows; totals per currency", () => {
  const hash = (n) => "0x" + String(n).padStart(64, "0");
  const usdtAmount = 10_000_000n;
  const payInput = payTagData({ tag: "ada", token: USDT_ADDRESS, amount: usdtAmount, ref: currencyRef("idrx") });
  assert.deepEqual(decodeTagsCall(payInput).receive, "idrx");
  assert.equal(decodeTagsCall(claimData("ada", "Ada Obi")).tag, "ada");
  const transfers = [
    { transaction_hash: hash(1), timestamp: "2026-11-21T10:00:00Z", token: { address_hash: USDT_ADDRESS }, total: { value: "10000000", decimals: "6" }, from: { hash: ADDR }, to: { hash: AGENT } },
    { transaction_hash: hash(2), timestamp: "2026-11-21T11:00:00Z", token: { address_hash: CURRENCIES[0].address }, total: { value: "14400000000", decimals: "6" }, from: { hash: AGENT }, to: { hash: ADDR } },
    { transaction_hash: hash(3), timestamp: "2026-11-21T12:00:00Z", token: { address_hash: CURRENCIES[0].address }, total: { value: "1000000000", decimals: "6" }, from: { hash: AGENT }, to: { hash: ADDR } },
    { transaction_hash: hash(4), timestamp: "2026-11-21T12:00:00Z", token: { address_hash: "0x0000000000000000000000000000000000000bad" }, total: { value: "1", decimals: "0" }, from: { hash: AGENT }, to: { hash: ADDR } },
  ];
  const sent = [
    { hash: hash(1), to: { hash: LOKAL_TAGS }, raw_input: payInput, status: "ok", timestamp: "2026-11-21T10:00:00Z" },
    { hash: hash(5), to: { hash: LOKAL_TAGS }, raw_input: claimData("ada", ""), status: "ok", timestamp: "2026-11-21T09:00:00Z" },
    { hash: hash(6), to: { hash: LOKAL_TAGS }, raw_input: FN.setName + abiEncode(["string"], ["Ada"]), status: "ok", timestamp: "2026-11-21T09:30:00Z" },
    { hash: hash(7), to: { hash: "0x0000000000000000000000000000000000000001" }, raw_input: "0x", status: "ok", timestamp: "2026-11-21T09:30:00Z" },
  ];
  const rows = activityRows(ADDR, transfers, sent);
  assert.deepEqual(rows.map((r) => r.kind), ["payout", "payout", "sent", "tag", "tag"]);
  assert.match(rows.find((r) => r.kind === "sent").label, /^You paid @ada 10\.00 USD₮ \(they get rupiah\)$/);
  assert.match(rows[0].label, /^You received ₦1,000\.00 cNGN$/);
  assert.deepEqual(rows.filter((r) => r.kind === "tag").map((r) => r.label), ["You set your name to Ada", "You claimed @ada"]);
  // no row ever names another address
  for (const r of rows) assert.ok(!/0x[0-9a-f]{40}/i.test(r.label), r.label);
  assert.deepEqual(receivedTotals(rows), [{ token: "cNGN", code: "cngn", amount: 15400, count: 2 }]);
});
