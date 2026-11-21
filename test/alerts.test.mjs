// Alerts (src/alerts.mjs) and autopilot's operator signals (src/watch.mjs): channels, muting, the outbox, failure and
// timeout tolerance, no secrets in texts, low-gas throttling, the stop line, the heartbeat and the status-down warning.
// A fake fetch and temp files only: nothing reaches Telegram, a webhook or the status server.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseUnits } from "viem";
import { AGENT_ADDRESS } from "../src/config.mjs";
import { refusal } from "../src/guards.mjs";
import { encodeNtagTransfer } from "../src/ntags.mjs";
import { GAS_REWARN_MS, alertChannels, alertText, gasAlert, makeAlerter, scrub } from "../src/alerts.mjs";
import { outboxFiles } from "../src/status-report.mjs";
import { HEARTBEAT_MS, STATUS_DOWN_ALERT_MS, firstSentence, stopLine, watch } from "../src/watch.mjs";
import { validateHeartbeat } from "../lib/status.mjs";
import { key, world } from "./fakes.mjs";

const TOKEN = "123456789:AAH_fake-token-for-tests-only-0123456";
const HOOK = "https://hooks.example.test/T000/B000/secretpart";
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "np-alerts-")), "alerts-outbox.jsonl");
const env = (o = {}) => ({ ALERT_TELEGRAM_TOKEN: TOKEN, ALERT_TELEGRAM_CHAT_ID: "424242", ALERT_WEBHOOK_URL: HOOK, ...o });
const ok = (status = 200) => ({ status, json: async () => ({ ok: true }) });

test("channels: Telegram needs a token and a chat id, the webhook https; problems are named without the values", () => {
  const c = alertChannels(env({ ALERT_MUTE: "payout_paid, deposit_refused, autopilot_stopped" }));
  assert.deepEqual(c.telegram, { token: TOKEN, chatId: "424242" });
  assert.equal(c.webhook, HOOK);
  assert.deepEqual([...c.mute].sort(), ["deposit_refused", "payout_paid"], "urgent alerts can't be muted");
  const bad = alertChannels({ ALERT_TELEGRAM_TOKEN: "nope", ALERT_TELEGRAM_CHAT_ID: "1", ALERT_WEBHOOK_URL: "http://example.com/x" });
  assert.equal(bad.telegram, null);
  assert.equal(bad.webhook, null);
  assert.equal(bad.problems.length, 2);
  for (const p of bad.problems) assert.ok(!p.includes("nope") && !p.includes("example.com"));
  assert.deepEqual(alertChannels({}).problems, []);
});

test("texts: level label, one line, length-capped, secrets redacted", () => {
  assert.match(alertText("autopilot_stopped", "a\nb"), /^\[URGENT\] Lokal agent: a b$/);
  assert.match(alertText("celo_low", "x"), /^\[WARNING\]/);
  assert.ok(alertText("payout_paid", "y".repeat(5000)).length <= 1500);
  assert.equal(scrub(`token ${TOKEN} and ${HOOK}`, [TOKEN, HOOK]), "token [redacted] and [redacted]");
});

test("alerts are queued to the outbox and sent to Telegram and the webhook; nothing secret is printed", async () => {
  const sent = [];
  const said = [];
  const fetchImpl = async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return ok(); };
  const file = tmp();
  const a = makeAlerter({ env: env(), outboxFile: file, fetchImpl, say: (m) => said.push(m), debounceMs: 60_000 });
  assert.equal(a.enabled, true);
  assert.deepEqual(a.channels, ["telegram", "webhook"]);
  assert.equal(a.alert("autopilot_stopped", `Autopilot stopped. secret was ${TOKEN}`), true);
  assert.equal(outboxFiles(file).readQueue().events.length, 1, "queued locally first");
  const r = await a.flush();
  assert.deepEqual([r.sent, r.left], [1, 0]);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
  assert.equal(sent[0].body.chat_id, "424242");
  assert.match(sent[0].body.text, /^\[URGENT\]/);
  assert.equal(sent[1].url, HOOK);
  assert.deepEqual(Object.keys(sent[1].body).sort(), ["at", "content", "kind", "level", "text"]);
  for (const s of sent) assert.ok(!JSON.stringify(s.body).includes(TOKEN), "the token never appears in a text");
  assert.equal(outboxFiles(file).readQueue().events.length, 0);
  assert.equal(a.alert("payout_paid", "x"), true);
  const muted = makeAlerter({ env: env({ ALERT_MUTE: "payout_paid" }), outboxFile: tmp(), fetchImpl });
  assert.equal(muted.alert("payout_paid", "x"), false);
  assert.equal(muted.alert("nonsense", "x"), false);
  for (const m of said) assert.ok(!m.includes(TOKEN) && !m.includes("secretpart"));
  await a.close({ waitMs: 0 });
});

test("a failing or hanging channel never throws: the alert stays queued, only the failed channel is retried", async () => {
  const said = [];
  let hookUp = false;
  const calls = { telegram: 0, webhook: 0 };
  const fetchImpl = async (url, init) => {
    if (url.startsWith("https://api.telegram.org")) { calls.telegram++; return ok(); }
    calls.webhook++;
    if (!hookUp) return new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    return ok();
  };
  const file = tmp();
  const a = makeAlerter({ env: env(), outboxFile: file, fetchImpl, say: (m) => said.push(m), timeoutMs: 30, debounceMs: 60_000 });
  a.alert("refund_failed", "refund failed");
  const r1 = await a.flush();
  assert.equal(r1.left, 1);
  assert.match(r1.error, /webhook: timed out/);
  assert.equal(said.filter((m) => /couldn't send/.test(m)).length, 1);
  assert.ok(!said.join(" ").includes("secretpart"), "the webhook URL is never printed");
  const q = outboxFiles(file).readQueue().events[0];
  assert.deepEqual(q.done, ["telegram"]);
  assert.equal(q.tries, 1);
  hookUp = true;
  const r2 = await a.flush();
  assert.deepEqual([r2.sent, r2.left], [1, 0]);
  assert.deepEqual(calls, { telegram: 1, webhook: 2 }, "Telegram was not sent twice");

  // a fetch that throws, a 500 and a broken outbox: still nothing throws
  const b = makeAlerter({ env: env({ ALERT_TELEGRAM_TOKEN: "" , ALERT_TELEGRAM_CHAT_ID: "" }), outboxFile: tmp(), fetchImpl: async () => { throw new TypeError("fetch failed"); }, debounceMs: 60_000 });
  b.alert("celo_low", "low");
  assert.equal((await b.flush()).left, 1);
  const c = makeAlerter({ env: env({ ALERT_TELEGRAM_TOKEN: "", ALERT_TELEGRAM_CHAT_ID: "" }), outboxFile: path.join(tmp(), "missing-dir", "x.jsonl"), fetchImpl: async () => ok(500), debounceMs: 60_000 });
  assert.doesNotThrow(() => c.alert("celo_low", "low"));
  await c.flush();
  await Promise.all([a.close({ waitMs: 0 }), b.close({ waitMs: 0 }), c.close({ waitMs: 0 })]);
});

test("alerts are off without channels and under the test runner unless a test passes its own outbox", () => {
  assert.equal(makeAlerter({ env: {} }).enabled, false);
  assert.equal(makeAlerter({ env: { ...env(), NODE_TEST_CONTEXT: "child" } }).enabled, false);
});

test("low gas: warn once, then at most hourly; at once when it falls below the hard reserve; once when fine again", () => {
  const warnUnits = parseUnits("3", 18), reserveUnits = parseUnits("2", 18);
  const at = (celo, state, now) => gasAlert(state, { balance: parseUnits(celo, 18), warnUnits, reserveUnits, now });
  let r = at("5", {}, 0);
  assert.equal(r.warn, null);
  r = at("2.5", r.state, 1000);
  assert.equal(r.warn, "low");
  r = at("2.4", r.state, 1000 + 60_000);
  assert.equal(r.warn, null, "not again within the hour");
  r = at("1.9", r.state, 1000 + 120_000);
  assert.equal(r.warn, "reserve", "worse: right away");
  r = at("1.9", r.state, 1000 + 120_000 + GAS_REWARN_MS - 1);
  assert.equal(r.warn, null);
  r = at("1.9", r.state, 1000 + 120_000 + GAS_REWARN_MS);
  assert.equal(r.warn, "reserve", "hourly while it stays low");
  r = at("4", r.state, 1000 + 2 * GAS_REWARN_MS);
  assert.deepEqual([r.warn, r.recovered], [null, true]);
  assert.equal(at("4", r.state, 0).recovered, false);
});

test("autopilot reads the CELO balance at most once a minute and re-warns at most hourly", async () => {
  let clock = 1_000_000;
  let reads = 0;
  const w = world({ chain: { celo: parseUnits("2.5", 18) } });
  const real = w.pub.getBalance;
  w.pub.getBalance = async (a) => { reads++; return real(a); };
  w.io.now = () => clock;
  w.io.sleep = async () => { clock += 20_000; };
  await watch({ execute: true, polls: 9, io: w.io }); // 9 polls over ~3 minutes
  assert.ok(reads >= 3 && reads <= 4, `balance read ${reads} times`);
  assert.equal(w.out.filter((l) => /WARNING: LOW GAS/.test(l)).length, 1);
  assert.equal(w.mem.alerts.filter((a) => a.kind === "celo_low").length, 1);
  clock += GAS_REWARN_MS;
  await watch({ execute: true, polls: 1, io: w.io });
  assert.equal(w.mem.alerts.filter((a) => a.kind === "celo_low").length, 2, "a new run warns again once (fresh state)");
  // a balance that can't be read never stops autopilot
  const down = world({ chain: { noBalance: true }, deposits: [{ n: 1, block: 901, units: 7_000_000n }] });
  await watch({ execute: true, polls: 1, io: down.io });
  assert.equal(down.mem.state.cursor, "1000");
});

test("autopilot stopped on an error: the last line says what and how to restart; urgent alerts with the commands", async () => {
  assert.equal(firstSentence("Payout for r_1 failed: boom. The deposit is recorded."), "Payout for r_1 failed: boom.");
  assert.match(stopLine("X failed. More."), /^AUTOPILOT STOPPED: X failed\. .*node src\/agent\.mjs watch --execute$/);
  assert.match(stopLine("X.", { autoRefund: true }), /watch --execute --auto-refund$/);
  const w = world({ deposits: [{ n: 1, block: 901, units: 5_000_000n, input: encodeNtagTransfer(AGENT_ADDRESS, 5_000_000n, "ada") }] });
  w.io.pay = async () => { throw new Error("Textile is down"); };
  await assert.rejects(watch({ execute: true, polls: 1, io: w.io }), (e) => e.printed === true);
  assert.match(w.out.at(-1), /AUTOPILOT STOPPED: Payout to @ada failed: Textile is down\. .*node src\/agent\.mjs watch --execute$/);
  const kinds = w.mem.alerts.map((a) => a.kind);
  assert.deepEqual(kinds, ["payout_failed", "autopilot_stopped"]);
  assert.match(w.mem.alerts[0].text, new RegExp(`retry --ntag ${key(1)}`));
  assert.match(w.mem.alerts[1].text, /Resume after fixing it: node src\/agent\.mjs watch --execute/);
});

test("alerts for a refused deposit (info), a paid one (info) and the daily cap (warning)", async () => {
  const deposits = [
    { n: 1, block: 901, units: 3_000_000n, input: encodeNtagTransfer(AGENT_ADDRESS, 3_000_000n, "nobody") },
    { n: 2, block: 902, units: 5_000_000n, input: encodeNtagTransfer(AGENT_ADDRESS, 5_000_000n, "ada") },
  ];
  const w = world({ deposits });
  await watch({ execute: true, polls: 1, io: w.io });
  assert.deepEqual(w.mem.alerts.map((a) => a.kind), ["deposit_refused", "payout_paid"]);
  assert.match(w.mem.alerts[0].text, new RegExp(`refund --deposit ${key(1)}`));
  const cap = world({ deposits: deposits.slice(1) });
  cap.io.preflight = async () => { throw new Error("This payout (5 USD) would take the last 24 h total to 101 USD, over the daily cap of 100 USD (MAX_DAILY_USD). Nothing was sent."); };
  await assert.rejects(watch({ execute: true, polls: 1, io: cap.io }));
  assert.deepEqual(cap.mem.alerts.map((a) => a.kind), ["daily_cap", "autopilot_stopped"]);
  // a dry run sends no alerts at all
  const dry = world({ deposits });
  await watch({ execute: false, polls: 1, io: dry.io });
  assert.deepEqual(dry.mem.alerts, []);
});

test("heartbeat: about once a minute, valid fields, never awaited by a payout; status down 10+ minutes is a warning", async () => {
  let clock = 2_000_000_000_000;
  let failingSince = null;
  const beats = [];
  const status = {
    enabled: true, report() {}, syncRecords() { return 0; }, flush: async () => ({}), close: async () => {},
    heartbeat: (hb) => { beats.push(hb); return new Promise(() => {}); }, // never answers: must not block anything
    health: () => ({ failingSince }),
  };
  const w = world({ deposits: [{ n: 1, block: 901, units: 5_000_000n, input: encodeNtagTransfer(AGENT_ADDRESS, 5_000_000n, "ada") }] });
  w.io.makeStatus = () => status;
  w.io.now = () => clock;
  w.io.sleep = async () => { clock += 30_000; };
  await watch({ execute: true, polls: 5, io: w.io, autoRefund: true });
  assert.equal(w.calls.length, 1, "the payout went through while the heartbeat hung");
  assert.equal(beats.length, 1, "a hanging heartbeat is not sent again on top of itself");
  const hb = beats[0];
  const ts = Math.floor(Date.parse(hb.at) / 1000);
  assert.equal(validateHeartbeat({ v: 1, ts, heartbeat: hb }, ts).error, undefined);
  assert.equal(hb.autoRefund, true);
  assert.equal(hb.version, "0.1.0+test");
  assert.equal(hb.celoBalance, "10");
  assert.equal(hb.lowGas, false);

  // answering heartbeats: one per HEARTBEAT_MS
  const beats2 = [];
  const st2 = { ...status, heartbeat: async (b) => { beats2.push(b); return { ok: true }; } };
  const w2 = world();
  w2.io.makeStatus = () => st2;
  w2.io.now = () => clock;
  w2.io.sleep = async () => { clock += HEARTBEAT_MS / 2; };
  await watch({ execute: true, polls: 6, io: w2.io });
  assert.equal(beats2.length, 3);
  assert.equal(beats2[1].cursorBlock, "1000");
  assert.equal(beats2[1].lagBlocks, 0);

  // the status server failing for 10+ minutes: one warning
  failingSince = clock;
  const w3 = world();
  w3.io.makeStatus = () => ({ ...st2 });
  w3.io.now = () => clock;
  w3.io.sleep = async () => { clock += 4 * 60_000; };
  await watch({ execute: true, polls: 5, io: w3.io });
  assert.equal(w3.mem.alerts.filter((a) => a.kind === "status_unreachable").length, 1);
  assert.ok(STATUS_DOWN_ALERT_MS === 10 * 60_000);
});

test("watchdog (GitHub Actions): alert when the heartbeat is 10+ minutes old, re-alert hourly, one 'back online'", async () => {
  const { REALERT_MS, readAgentStatus, watchdogDecision } = await import("../scripts/agent-watchdog.mjs");
  const up = { ok: true, agent: { ageSec: 70, lastSeen: "2026-11-21T12:00:00.000Z" } };
  const stale = { ok: true, agent: { ageSec: 11 * 60, lastSeen: "2026-11-21T11:49:00.000Z" } };
  let s = {};
  let d = watchdogDecision(s, up, 0);
  assert.equal(d.message, null);
  d = watchdogDecision(d.state, stale, 1000);
  assert.match(d.message, /looks offline: its last heartbeat was 11 minutes ago.*watch --execute/);
  d = watchdogDecision(d.state, stale, 1000 + 15 * 60_000);
  assert.equal(d.message, null, "not again within the hour");
  d = watchdogDecision(d.state, { error: "HTTP 503" }, 1000 + REALERT_MS);
  assert.match(d.message, /could not be read \(HTTP 503\).*still down/);
  d = watchdogDecision(d.state, up, 1000 + REALERT_MS + 60_000);
  assert.match(d.message, /back online/);
  d = watchdogDecision(d.state, up, 1000 + REALERT_MS + 120_000);
  assert.equal(d.message, null, "only one back-online message");
  s = watchdogDecision({}, { ok: true, agent: null }, 0);
  assert.match(s.message, /no heartbeat has been stored yet/);
  assert.deepEqual(await readAgentStatus("https://x.test/api/status", async (u) => { assert.equal(u, "https://x.test/api/status?agent=1"); return { status: 503 }; }), { error: "HTTP 503" });
  assert.deepEqual(await readAgentStatus("https://x.test/api/status", async () => { throw new TypeError("fetch failed"); }), { error: "network error" });
});

test("a firm-quote refusal is still a refusal alert; a reporter or alerter that throws never stops a payout", async () => {
  const w = world({ deposits: [{ n: 1, block: 901, units: 5_000_000n, input: encodeNtagTransfer(AGENT_ADDRESS, 5_000_000n, "ada") }] });
  w.io.pay = async () => { throw refusal("Amount 25.3 exceeds the per-payout cap of 25 USD (MAX_USD). Not paid automatically; review it manually."); };
  w.io.makeAlerter = () => ({ enabled: true, channels: ["x"], alert: () => { throw new Error("boom"); }, close: async () => { throw new Error("boom"); } });
  await watch({ execute: true, polls: 1, io: w.io });
  assert.equal(w.mem.ntag[key(1)].status, "refused");
  assert.equal(w.mem.state.cursor, "1000");
});
