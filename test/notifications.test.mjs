// The notification bell (site/assets/notifications.js, site/assets/bell.js): which incoming events become items, the
// words and the link of each kind, that no item carries anyone's address, the unread count from the one "last seen"
// marker (with and without storage, 9+), the polling rhythm (paused while the tab is hidden), the shared one-minute
// read, and that nothing is rendered or read while signed out. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as N from "../site/assets/notifications.js";
import { activityRows, sharedActivity, clearSharedActivity } from "../site/assets/my-activity.js";
import { bellVisible } from "../site/assets/front-door.js";
import { buildSignInMessage, SESSION_KEY } from "../site/assets/session.js";
import { AGENT, CURRENCIES, USDT_ADDRESS, abiEncode, receiptNo } from "../site/assets/core.js";
import { TOPIC, topicOf, LOKAL_TAGS, LOKAL_POTS, payTagData, currencyRef } from "../site/assets/lokal-contracts.js";

const ME = "0x5ad4e1b2c3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8";
const PAYER = "0x4444444444444444444444444444444444444444";
const OTHER = "0x9999999999999999999999999999999999999999";
const CNGN = CURRENCIES[0].address;
const NOW = 1_795_000_000; // seconds
const iso = (sec) => new Date(sec * 1000).toISOString();
const h = (n) => "0x" + n.toString(16).padStart(64, "0");
const ADDRESS_RE = /0x[0-9a-f]{40}(?![0-9a-f])/i;

const transfer = (n, { from, to, token, value, decimals = 6, time }) => ({
  transaction_hash: h(n), timestamp: iso(time), token: { address_hash: token }, total: { value: String(value), decimals: String(decimals) }, from: { hash: from }, to: { hash: to },
});
const tagLog = ({ n, tag = "ada", recipient = ME, token = USDT_ADDRESS, amount = 10_000_000n, time }) => ({
  topics: [TOPIC.TagPaid, h(0xbeef), topicOf(recipient), topicOf(PAYER)],
  data: "0x" + abiEncode(["string", "address", "uint256", "bytes32", "uint256"], [tag, token, amount, currencyRef("cngn"), 20_775n]),
  transactionHash: h(n), logIndex: 3, blockNumber: 83_500_000, timeStamp: time,
});
const potLog = ({ n, potId = 7n, host = ME, usd6 = 5_000_000n, time }) => ({
  topics: [TOPIC.PotPaid, topicOf(potId), topicOf(host), topicOf(PAYER)],
  data: "0x" + abiEncode(["address", "uint256", "bytes32", "uint256", "uint256"], [USDT_ADDRESS, usd6, currencyRef("cngn"), 25_000_000n, usd6]),
  transactionHash: h(n), logIndex: 1, blockNumber: 83_500_100, timeStamp: time,
});

/** The example wallet: a naira payout, a $5 tag payment it made that came back (a refund), a payment to its tag, a spray into its pot. */
function example() {
  const transfers = [
    transfer(1, { from: AGENT, to: ME, token: CNGN, value: 14_407_670_000, time: NOW - 120 }), // payout
    transfer(2, { from: ME, to: AGENT, token: USDT_ADDRESS, value: 5_000_000, time: NOW - 7200 }), // it paid @tunde $5
    transfer(3, { from: AGENT, to: ME, token: USDT_ADDRESS, value: 5_000_000, time: NOW - 3600 }), // the same $5 back: a refund
  ];
  const sent = [{ hash: h(2), to: { hash: LOKAL_TAGS }, raw_input: payTagData({ tag: "tunde", token: USDT_ADDRESS, amount: 5_000_000n, ref: currencyRef("cngn") }), status: "ok", timestamp: iso(NOW - 7200) }];
  return {
    rows: activityRows(ME, transfers, sent),
    tagLogs: [tagLog({ n: 4, time: NOW - 600 }), tagLog({ n: 5, recipient: OTHER, tag: "someone", time: NOW - 60 })],
    potLogs: [potLog({ n: 6, time: NOW - 1800 }), potLog({ n: 8, host: OTHER, time: NOW - 30 })],
    potTitles: new Map([["7", "Ada & Tunde's wedding"]]),
  };
}

test("each incoming kind becomes one line with the right link, newest first", () => {
  const items = N.toNotifications({ address: ME, ...example() });
  assert.deepEqual(items.map((i) => [i.kind, i.text, i.href]), [
    ["payout", "You received ₦14,407.67", `receipt.html#${receiptNo(h(1))}`],
    ["tag", "@ada was paid $10, payout on its way", "transactions.html"],
    ["pot", "$5 sprayed into Ada & Tunde's wedding", "pot.html?id=7"],
    ["refund", `Refunded $5 · RF-0000-0000`, `https://celoscan.io/tx/${h(3)}`],
  ]);
  assert.deepEqual(items.map((i) => i.time), [NOW - 120, NOW - 600, NOW - 1800, NOW - 3600]);
  assert.equal(items.find((i) => i.kind === "refund").external, true);
  assert.equal(items.find((i) => i.kind === "payout").external, false);
  // payments the wallet SENT are not notifications
  assert.ok(!items.some((i) => /tunde/.test(i.text)));
});

test("no item carries an address: payers are never named, and other wallets' events are ignored", () => {
  const items = N.toNotifications({ address: ME, ...example() });
  const json = JSON.stringify(items);
  assert.doesNotMatch(json, ADDRESS_RE);
  assert.ok(!json.toLowerCase().includes(PAYER.slice(2)));
  assert.ok(!json.includes("someone"), "a TagPaid to another wallet is not shown");
  assert.equal(items.filter((i) => i.kind === "pot").length, 1, "a spray into someone else's pot is not shown");
  // the address in different case is still the same wallet
  assert.equal(N.toNotifications({ address: ME.toUpperCase().replace("0X", "0x"), ...example() }).length, 4);
});

test("other amounts and fallbacks: dollars with cents, naira paid to a tag, an untitled pot, a broken log", () => {
  const rows = activityRows(ME, [transfer(9, { from: AGENT, to: ME, token: USDT_ADDRESS, value: 9_700_000, time: NOW })], []);
  assert.equal(N.toNotifications({ address: ME, rows })[0].text, "You received $9.70");
  const naira = N.toNotifications({ address: ME, tagLogs: [tagLog({ n: 10, token: CNGN, amount: 15_000_000_000n, time: NOW })] });
  assert.equal(naira[0].text, "@ada was paid ₦15,000.00, payout on its way");
  const untitled = N.toNotifications({ address: ME, potLogs: [potLog({ n: 11, potId: 12n, usd6: 2_500_000n, time: NOW })] });
  assert.deepEqual([untitled[0].text, untitled[0].href], ["$2.50 sprayed into your pot #12", "pot.html?id=12"]);
  assert.deepEqual(N.toNotifications({ address: ME, tagLogs: [{ topics: [TOPIC.TagPaid, h(1), topicOf(ME), topicOf(PAYER)], data: "0xzz" }], potLogs: [{ topics: [] }] }), []);
  assert.equal(N.moneyText("USD₮", 10), "$10");
  assert.equal(N.moneyText("USD₮", 1250.5), "$1,250.50");
  assert.equal(N.moneyText("IDRX", 91_967.9), "Rp 91,967");
});

test("refunds: an agent transfer returning exactly what the wallet sent, later and within 30 days, one per payment", () => {
  const row = (kind, n, token, amount, time) => ({ kind, hash: h(n), token, amount, time: iso(time) });
  const rows = [
    row("sent", 1, "USD₮", 5, NOW - 1000),
    row("payout", 2, "USD₮", 5, NOW - 500), // refund of #1
    row("payout", 3, "USD₮", 5, NOW - 400), // same amount again, but #1 is already refunded: a payout
    row("payout", 4, "USD₮", 4.85, NOW - 300), // converted with the margin: a payout
    row("payout", 5, "cNGN", 5, NOW - 200), // another token: a payout
    row("sent", 6, "USD₮", 7, NOW - 100),
    row("payout", 7, "USD₮", 7, NOW - 150), // EARLIER than the payment: not its refund
    row("sent", 8, "USD₮", 3, NOW - 40 * 86_400),
    row("payout", 9, "USD₮", 3, NOW), // 40 days later: outside the window
  ];
  assert.deepEqual([...N.refundHashes(rows)], [h(2)]);
  assert.equal(N.refundNo("0xabcdef12" + "0".repeat(56)), "RF-ABCD-EF12");
});

/** A localStorage stand-in; `broken` throws on every call (blocked storage). */
function memoryStorage({ broken = false } = {}) {
  const m = new Map();
  const guard = () => { if (broken) throw new Error("SecurityError"); };
  return { getItem: (k) => (guard(), m.has(k) ? m.get(k) : null), setItem: (k, v) => (guard(), m.set(k, String(v))), removeItem: (k) => (guard(), m.delete(k)), raw: m };
}
const items = (times) => times.map((t, i) => ({ id: String(i), time: t }));

test("unread: everything is new until the dropdown is opened, then only what is newer than the marker", () => {
  N.clearMemorySeen();
  const store = memoryStorage();
  const list = items([NOW - 10, NOW - 20, NOW - 30]);
  assert.equal(N.readSeen(store, ME), null);
  assert.equal(N.unreadCount(list, N.readSeen(store, ME)), 3);
  N.markSeen(store, ME, N.newestTime(list));
  assert.equal(N.unreadCount(list, N.readSeen(store, ME)), 0);
  assert.equal(N.unreadCount([{ time: NOW + 5 }, ...list], N.readSeen(store, ME)), 1);
  // the marker never goes back
  N.markSeen(store, ME, NOW - 1000);
  assert.equal(N.readSeen(store, ME), NOW - 10);
  // only the marker is stored: the wallet's address -> a number. No amounts, no items, no one else.
  assert.deepEqual(JSON.parse(store.raw.get(N.SEEN_KEY)), { [ME]: NOW - 10 });
  assert.deepEqual([...store.raw.keys()], [N.SEEN_KEY]);
  // case doesn't matter; another wallet has its own marker; at most 5 wallets are kept
  assert.equal(N.readSeen(store, ME.toUpperCase().replace("0X", "0x")), NOW - 10);
  for (let i = 1; i <= 6; i++) N.markSeen(store, "0x" + String(i).repeat(40), NOW - i);
  const kept = JSON.parse(store.raw.get(N.SEEN_KEY));
  assert.equal(Object.keys(kept).length, 5);
  assert.ok(Object.values(kept).every((v) => Number.isInteger(v)));
});

test("unread without storage: new on every visit, cleared on the page once opened; a malformed value is ignored", () => {
  N.clearMemorySeen();
  const blocked = memoryStorage({ broken: true });
  const list = items([NOW - 10, NOW - 20]);
  assert.equal(N.readSeen(blocked, ME), null);
  assert.equal(N.readSeen(null, ME), null);
  assert.equal(N.unreadCount(list, N.readSeen(blocked, ME)), 2);
  assert.doesNotThrow(() => N.markSeen(blocked, ME, NOW - 10));
  assert.equal(N.unreadCount(list, N.readSeen(blocked, ME)), 0, "this page remembers it in memory");
  N.clearMemorySeen(); // the next visit
  assert.equal(N.unreadCount(list, N.readSeen(blocked, ME)), 2);
  const junk = memoryStorage();
  junk.setItem(N.SEEN_KEY, "not json");
  assert.equal(N.readSeen(junk, ME), null);
  junk.setItem(N.SEEN_KEY, JSON.stringify({ [ME]: "yesterday" }));
  assert.equal(N.readSeen(junk, ME), null);
});

test("the badge: nothing at 0, 1–9, then 9+; the button says how many are new", () => {
  assert.deepEqual([0, 1, 5, 9, 10, 37, 1000, -1, NaN].map(N.badgeText), ["", "1", "5", "9", "9+", "9+", "9+", "", ""]);
  assert.equal(N.bellLabel(0), "Notifications");
  assert.equal(N.bellLabel(3), "Notifications, 3 new");
  assert.equal(N.bellLabel(12), "Notifications, 12 new");
  const many = items(Array.from({ length: 40 }, (_, i) => NOW - i));
  assert.equal(N.badgeText(N.unreadCount(many, null)), "9+");
  assert.equal(N.newestTime([]), null);
  assert.equal(N.newestTime([{ time: null }, { time: 5 }, { time: 9 }]), 9);
});

/** Manual timers and visibility for the poller. */
function fakeEnv() {
  let t = 0, seq = 0, visible = true, listener = null;
  const pending = new Map();
  return {
    timers: { set: (fn, ms) => { const id = ++seq; pending.set(id, { fn, at: t + ms }); return id; }, clear: (id) => pending.delete(id) },
    now: () => t,
    isVisible: () => visible,
    onVisibility: (cb) => { listener = cb; return () => { listener = null; }; },
    setVisible(v) { visible = v; listener?.(); },
    get pending() { return [...pending.values()].map((p) => p.at - t); },
    get subscribed() { return Boolean(listener); },
    /** Moves the clock forward, running due timers in order (and letting their promises settle). */
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, p]) => p.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        t = due[1].at;
        due[1].fn();
        for (let i = 0; i < 5; i++) await Promise.resolve();
      }
      t = end;
    },
  };
}

test("polling: on load, then every 60 s while visible; paused while hidden; resumes on time when visible again", async () => {
  const env = fakeEnv();
  let runs = 0;
  const p = N.createPoller({ run: async () => { runs++; }, interval: 60_000, firstDelay: 1800, ...env });
  p.start();
  assert.equal(runs, 0);
  await env.advance(1800);
  assert.equal(runs, 1, "the first check after the short delay");
  await env.advance(59_999);
  assert.equal(runs, 1);
  await env.advance(1);
  assert.equal(runs, 2, "then every minute");
  // hidden: no timer at all, however long it stays hidden
  await env.advance(10_000);
  env.setVisible(false);
  assert.deepEqual(env.pending, []);
  await env.advance(10 * 60_000);
  assert.equal(runs, 2);
  // visible again after more than a minute: checks at once
  env.setVisible(true);
  await env.advance(0);
  assert.equal(runs, 3);
  // hidden and back within the minute: waits only for the rest of it
  await env.advance(20_000);
  env.setVisible(false);
  env.setVisible(true);
  assert.deepEqual(env.pending, [40_000]);
  await env.advance(40_000);
  assert.equal(runs, 4);
  p.stop();
  assert.deepEqual(env.pending, []);
  assert.equal(env.subscribed, false);
  await env.advance(5 * 60_000);
  assert.equal(runs, 4, "stopped means stopped");
});

test("polling: hidden at start waits; runs never overlap; a failed run keeps the rhythm; refresh() checks now", async () => {
  const env = fakeEnv();
  env.setVisible(false);
  let runs = 0, release;
  const p = N.createPoller({ run: () => { runs++; return new Promise((r) => { release = r; }); }, interval: 60_000, ...env });
  p.start();
  await env.advance(120_000);
  assert.equal(runs, 0, "nothing is read while the tab is hidden");
  env.setVisible(true);
  await env.advance(0);
  assert.equal(runs, 1);
  p.refresh(); // still running: no second, overlapping read
  env.setVisible(false); env.setVisible(true);
  assert.equal(runs, 1);
  release();
  await env.advance(0);
  assert.deepEqual(env.pending, [60_000]);
  p.refresh();
  await env.advance(0);
  assert.equal(runs, 2, "refresh() reads at once");
  release();
  await env.advance(0);
  p.stop();

  const env2 = fakeEnv();
  let calls = 0;
  const q = N.createPoller({ run: async () => { calls++; throw new Error("explorer down"); }, interval: 60_000, ...env2 });
  q.start();
  await env2.advance(0);
  await env2.advance(60_000);
  assert.equal(calls, 2, "an error never stops the polling");
  q.stop();
});

test("one read per minute: the bell and the dashboard share the wallet's activity read on a page", async () => {
  clearSharedActivity();
  let t = 0, loads = [];
  const load = async (address, { maxPages }) => { loads.push(maxPages); return { rows: [], more: false }; };
  const opts = (o = {}) => ({ now: () => t, load, ...o });
  await Promise.all([sharedActivity(ME, opts({ maxPages: 3 })), sharedActivity(ME, opts({ maxPages: 1 }))]);
  assert.deepEqual(loads, [3], "the dashboard's bigger read answers the bell's");
  t = 30_000;
  await sharedActivity(ME, opts({ maxPages: 1 }));
  assert.deepEqual(loads, [3]);
  t = 61_000;
  await sharedActivity(ME, opts({ maxPages: 1 }));
  assert.deepEqual(loads, [3, 1], "a minute later it reads again");
  await sharedActivity(ME, opts({ maxPages: 3 }));
  assert.deepEqual(loads, [3, 1, 3], "a one-page read can't answer a three-page one");
  await sharedActivity(ME, opts({ maxPages: 1, force: true }));
  assert.deepEqual(loads, [3, 1, 3, 1], "force (Try again, Refresh) reads again");
  // a failed read is not kept
  let fail = true;
  const flaky = async () => { if (fail) throw new Error("down"); return { rows: [1], more: false }; };
  await assert.rejects(sharedActivity(OTHER, { now: () => t, load: flaky }));
  fail = false;
  assert.deepEqual((await sharedActivity(OTHER, { now: () => t, load: flaky })).rows, [1]);
  clearSharedActivity();
});

test("loadNotifications: one explorer request per contract (topic2 = this wallet), titles only when there is a spray, quiet partial failures", async () => {
  N.clearNotificationCache();
  const ex = example();
  const urls = [];
  let hostPotsCalls = 0;
  const fetchJson = async (url) => {
    urls.push(url);
    const u = new URL(url);
    const addr = u.searchParams.get("address").toLowerCase();
    const logs = addr === LOKAL_TAGS.toLowerCase() ? ex.tagLogs : ex.potLogs;
    return { status: "1", result: logs.map((l) => ({ ...l, blockNumber: "0x" + l.blockNumber.toString(16), logIndex: "0x" + l.logIndex.toString(16), timeStamp: "0x" + l.timeStamp.toString(16) })) };
  };
  const deps = { fetchJson, now: () => NOW * 1000, activity: async () => ({ rows: ex.rows }), hostPots: async () => { hostPotsCalls++; return [{ potId: 7n, title: "Ada & Tunde's wedding" }]; } };
  const { items, partial } = await N.loadNotifications(ME, deps);
  assert.equal(partial, false);
  assert.deepEqual(items.map((i) => i.kind), ["payout", "tag", "pot", "refund"]);
  assert.equal(urls.length, 2);
  for (const url of urls) {
    const q = new URL(url).searchParams;
    assert.equal(q.get("topic2"), topicOf(ME));
    assert.equal(q.get("topic0_2_opr"), "and");
  }
  assert.deepEqual(urls.map((u) => new URL(u).searchParams.get("topic0")).sort(), [TOPIC.PotPaid, TOPIC.TagPaid].sort());
  assert.ok(urls.some((u) => new URL(u).searchParams.get("address") === LOKAL_POTS));
  // within the minute: cached (no new requests), titles kept
  await N.loadNotifications(ME, deps);
  assert.equal(urls.length, 2);
  assert.equal(hostPotsCalls, 1);
  // the explorer is down: the activity rows still make items; all down: it throws (the bell says "Couldn't check right now.")
  N.clearNotificationCache();
  const down = async () => { throw new Error("down"); };
  const part = await N.loadNotifications(ME, { ...deps, fetchJson: down });
  assert.equal(part.partial, true);
  assert.deepEqual(part.items.map((i) => i.kind), ["payout", "refund"]);
  N.clearNotificationCache();
  await assert.rejects(N.loadNotifications(ME, { ...deps, fetchJson: down, activity: down }));
  N.clearNotificationCache();
});

// ---------- gating: signed out, nothing is rendered and nothing is read ----------
/** Just enough DOM for assets/bell.js. */
function fakeDocument() {
  const mk = (tag) => {
    const n = {
      tagName: tag, children: [], attrs: {}, dataset: {}, style: { setProperty() {} }, hidden: false, className: "",
      classList: { add() {}, remove() {}, contains: () => false },
      setAttribute(k, v) { this.attrs[k] = String(v); if (k === "hidden") this.hidden = true; },
      getAttribute(k) { return this.attrs[k] ?? null; }, removeAttribute(k) { delete this.attrs[k]; },
      append(...c) { this.children.push(...c); }, prepend(...c) { this.children.unshift(...c); },
      replaceChildren(...c) { this.children = c; },
      addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], contains: () => false, focus() {},
      set textContent(v) { this.children = [String(v)]; },
    };
    return n;
  };
  const slot = mk("div");
  slot.hidden = true;
  const html = mk("html");
  return {
    slot,
    document: {
      documentElement: html, visibilityState: "visible",
      createElement: mk, createElementNS: (_ns, tag) => mk(tag),
      getElementById: (id) => (id === "nav-bell" ? slot : null), querySelector: () => null,
      addEventListener() {}, removeEventListener() {},
    },
  };
}
function storedSession(address = ME) {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const message = buildSignInMessage({ host: "lokalpay.vercel.app", origin: "https://lokalpay.vercel.app", address, nonce: "0123456789abcdef", issuedAt: new Date().toISOString(), expiresAt: new Date(exp * 1000).toISOString() });
  return JSON.stringify({ address, message, signature: "0x" + "ab".repeat(65), exp });
}

test("gating: the bell is only for a signed-in wallet", () => {
  assert.equal(bellVisible(null), false);
  assert.equal(bellVisible(undefined), false);
  assert.equal(bellVisible({ address: "nope" }), false);
  assert.equal(bellVisible({ address: ME }), true);
});

test("gating: signed out, initBell renders nothing, starts no timer and reads nothing; signed in, it renders the button", async () => {
  const { initBell } = await import("../site/assets/bell.js");
  const saved = { document: globalThis.document, localStorage: globalThis.localStorage, fetch: globalThis.fetch, setTimeout: globalThis.setTimeout };
  const store = memoryStorage();
  const timers = [];
  let fetches = 0;
  try {
    globalThis.localStorage = store;
    globalThis.fetch = async () => { fetches++; throw new Error("no network in tests"); };
    globalThis.setTimeout = (fn, ms) => { timers.push(ms); return 0; };

    const out = fakeDocument();
    globalThis.document = out.document;
    initBell();
    assert.equal(out.slot.hidden, true);
    assert.equal(out.slot.children.length, 0);
    assert.equal(out.document.documentElement.dataset.bell, undefined);
    assert.deepEqual(timers, [], "no polling while signed out");
    assert.equal(fetches, 0);

    store.setItem(SESSION_KEY, storedSession());
    const inn = fakeDocument();
    globalThis.document = inn.document;
    initBell();
    assert.equal(inn.slot.hidden, false);
    assert.equal(inn.slot.children.length, 2, "the button and its (closed) dropdown");
    const [button, panel] = inn.slot.children;
    assert.equal(button.attrs["aria-label"], "Notifications");
    assert.equal(button.attrs["aria-expanded"], "false");
    assert.equal(button.attrs["aria-controls"], "np-bell-panel");
    assert.equal(panel.hidden, true);
    assert.equal(inn.document.documentElement.dataset.bell, "on");
    assert.deepEqual(timers, [1800], "the first check waits for the page's own reads");
    assert.equal(fetches, 0);
  } finally {
    Object.assign(globalThis, saved);
    if (saved.document === undefined) delete globalThis.document;
    if (saved.localStorage === undefined) delete globalThis.localStorage;
  }
});

test("the bell is in the app top bar on every app page, and the privacy policy names its one marker", () => {
  const app = fs.readFileSync(new URL("../site/app.html", import.meta.url), "utf8");
  assert.match(app, /<div class="nav-bell" id="nav-bell" hidden><\/div>\s*<div class="nav-user" id="nav-user">/);
  const privacy = fs.readFileSync(new URL("../site/privacy.html", import.meta.url), "utf8");
  assert.match(privacy, /np-notif-seen/);
  const core = fs.readFileSync(new URL("../site/assets/core.js", import.meta.url), "utf8");
  assert.match(core, /import\("\.\/bell\.js"\)/);
});
