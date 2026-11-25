// Running the agent on a Linux server (docs/SERVER.md, scripts/server/): the prestart decision (when a stale lock may
// be cleared without a human, and never after a safety stop), the safety-stop record, the systemd unit's restart policy,
// the file lists the scripts share, and a bash -n syntax check of every shell script when bash is available.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { EXIT_SAFETY_STOP, SAFETY_STOP_FILE, AGENT_LOCK_FILE, CONTACTS_FILE, LOG_FILE, REQUESTS_FILE, WATCH_STATE_FILE,
  REGISTRATIONS_STATE_FILE, NTAG_PAYMENTS_FILE, CONTRACT_PAYMENTS_FILE, REFUNDS_FILE, STATUS_OUTBOX_FILE, ALERTS_OUTBOX_FILE } from "../src/config.mjs";
import { outboxFiles } from "../src/status-report.mjs";
import { readSafetyStop, recordSafetyStop } from "../src/safety-stop.mjs";
import { bootTimeMs, prestartDecision } from "../scripts/server/prestart.mjs";

const DIR = path.join(import.meta.dirname, "..", "scripts", "server");
const read = (f) => fs.readFileSync(path.join(DIR, f), "utf8");
const HOST = "lokal-server";
const lockAt = (iso, extra = {}) => ({ pid: 4242, host: HOST, startedAt: iso, command: "watch --execute", ...extra });
const BOOT = Date.parse("2026-11-25T08:00:00Z");
const decide = (o) => prestartDecision({ host: HOST, bootMs: BOOT, isAlive: () => false, ...o });

test("exit code 3 is the safety stop; the record sits next to the lock", () => {
  assert.equal(EXIT_SAFETY_STOP, 3);
  assert.equal(path.dirname(SAFETY_STOP_FILE), path.dirname(AGENT_LOCK_FILE));
  assert.equal(path.basename(SAFETY_STOP_FILE), "safety-stop.json");
});

test("prestart: free lock starts; a safety stop on record never starts, whatever the lock says", () => {
  assert.equal(decide({ lock: null, stop: null }).action, "start");
  const stop = { at: "2026-11-25T09:00:00Z", reason: "Swap succeeded but no USDT was received." };
  for (const lock of [null, lockAt("2026-11-25T09:00:00Z"), lockAt("2026-11-24T09:00:00Z")]) {
    const d = decide({ lock, stop });
    assert.equal(d.action, "refuse");
    assert.match(d.reason, /safety stop/);
    assert.match(d.reason, /no USDT was received/);
    assert.match(d.reason, /resume\.sh/);
  }
  assert.equal(decide({ lock: null, stop: { unreadable: true } }).action, "refuse");
});

test("prestart: a stale lock from this host is cleared only when its process is gone or from before this boot", () => {
  // crashed in this boot, pid gone
  assert.equal(decide({ lock: lockAt("2026-11-25T09:00:00Z"), stop: null }).action, "clear");
  // still running in this boot: another agent; refuse
  const live = decide({ lock: lockAt("2026-11-25T09:00:00Z"), stop: null, isAlive: () => true });
  assert.equal(live.action, "refuse");
  assert.match(live.reason, /still running/);
  // from before the reboot: its pid may be reused by an unrelated process now, it is stale anyway
  assert.equal(decide({ lock: lockAt("2026-11-24T23:00:00Z"), stop: null, isAlive: () => true }).action, "clear");
  // boot time unknown: only the pid decides
  assert.equal(decide({ lock: lockAt("2026-11-24T23:00:00Z"), stop: null, isAlive: () => true, bootMs: null }).action, "refuse");
});

test("prestart: another computer's lock or an unreadable one is never cleared", () => {
  const foreign = decide({ lock: lockAt("2026-11-24T23:00:00Z", { host: "moved-to-server", pid: 1 }), stop: null });
  assert.equal(foreign.action, "refuse");
  assert.match(foreign.reason, /another computer/);
  assert.equal(decide({ lock: { unreadable: true }, stop: null }).action, "refuse");
  assert.equal(decide({ lock: { host: HOST, startedAt: "x" }, stop: null }).action, "refuse"); // no pid
});

test("bootTimeMs reads btime from /proc/stat, null otherwise", () => {
  assert.equal(bootTimeMs(() => "cpu  1 2 3\nbtime 1795593600\nprocesses 9\n"), 1795593600 * 1000);
  assert.equal(bootTimeMs(() => "cpu 1\n"), null);
  assert.equal(bootTimeMs(() => { throw new Error("ENOENT"); }), null);
});

test("recordSafetyStop / readSafetyStop round-trip; a broken file still counts as a stop", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lokal-stop-"));
  const file = path.join(dir, "safety-stop.json");
  try {
    assert.equal(readSafetyStop(file), null);
    assert.equal(recordSafetyStop("Payout failed: x. Stopping.", { file, now: () => Date.parse("2026-11-25T09:00:00Z"), host: "h", pid: 7 }), true);
    assert.deepEqual(readSafetyStop(file), { at: "2026-11-25T09:00:00.000Z", host: "h", pid: 7, reason: "Payout failed: x. Stopping." });
    fs.writeFileSync(file, "{not json");
    assert.deepEqual(readSafetyStop(file), { unreadable: true });
    assert.equal(recordSafetyStop("x", { file: path.join(dir, "missing", "deep", "f.json") }), false); // never throws
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the systemd unit: same agent, restarts on crashes only, never after a safety stop", () => {
  const unit = read("lokalpay-agent.service");
  const val = (k) => [...unit.matchAll(new RegExp(`^${k}=(.*)$`, "gm"))].map((m) => m[1].trim());
  assert.deepEqual(val("ExecStart"), ["/usr/bin/node src/agent.mjs watch --execute"]);
  assert.deepEqual(val("ExecStartPre"), ["/usr/bin/node scripts/server/prestart.mjs"]);
  assert.deepEqual(val("User"), ["ubuntu"]);
  assert.deepEqual(val("WorkingDirectory"), ["/home/ubuntu/lokal"]);
  assert.deepEqual(val("Restart"), ["on-failure"]);
  assert.deepEqual(val("RestartSec"), ["30"]);
  assert.deepEqual(val("RestartPreventExitStatus"), [String(EXIT_SAFETY_STOP)]);
  assert.deepEqual(val("KillSignal"), ["SIGTERM"]); // src/watch.mjs: SIGTERM = the clean Ctrl+C stop
  assert.ok(Number(val("TimeoutStopSec")[0]) >= 60);
  assert.deepEqual(val("Environment"), ["NODE_ENV=production"]);
  assert.deepEqual(val("EnvironmentFile"), ["-/home/ubuntu/.celo-naira-agent/env"]); // optional
  assert.ok(Number(val("StartLimitBurst")[0]) > 0, "a start limit, so nothing can loop");
  assert.deepEqual(val("StandardOutput"), ["journal"]);
  assert.doesNotMatch(unit, /clear-stale-lock/); // prestart.mjs decides, with its own rules
});

test("the scripts' file lists match src/config.mjs, and the PC export lists the same files", () => {
  const lib = read("lib.sh");
  const list = (name) => (new RegExp(`^${name}="([^"]*)"`, "m").exec(lib)?.[1] ?? "").split(/\s+/).filter(Boolean);
  const all = [...list("REQUIRED_STATE"), ...list("RECORD_STATE"), ...list("QUEUE_STATE")];
  const base = (f) => path.basename(f);
  const status = outboxFiles(STATUS_OUTBOX_FILE), alerts = outboxFiles(ALERTS_OUTBOX_FILE);
  const expected = [CONTACTS_FILE, LOG_FILE, WATCH_STATE_FILE, REQUESTS_FILE, REGISTRATIONS_STATE_FILE, NTAG_PAYMENTS_FILE, CONTRACT_PAYMENTS_FILE,
    REFUNDS_FILE, STATUS_OUTBOX_FILE, status.sentFile, ALERTS_OUTBOX_FILE, alerts.sentFile].map(base);
  assert.deepEqual([...all].sort(), [...expected].sort());
  assert.deepEqual(list("REQUIRED_STATE"), ["contacts.json", "receipts.jsonl", "watch-state.json"]);
  const ps = read("pc-export.ps1");
  const psList = (name) => [...(new RegExp(`^\\$${name} = @\\(([^)]*)\\)`, "m").exec(ps)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(psList("required"), list("REQUIRED_STATE"));
  assert.deepEqual(psList("records"), list("RECORD_STATE"));
  assert.deepEqual(psList("queues"), list("QUEUE_STATE"));
  for (const never of ["agent.json", "status-secret", "agent.lock", "safety-stop.json", ".env"]) assert.ok(!all.includes(never), never);
});

test("the shell scripts never print the key or the secret", () => {
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith(".sh") || x.endsWith(".ps1"))) {
    const s = read(f);
    assert.doesNotMatch(s, /\b(cat|less|head|tail|Get-Content)\b[^\n]*(agent\.json|status-secret|\/env\b)/, f);
  }
});

const bash = spawnSync("bash", ["--version"], { encoding: "utf8" });
const hasBash = bash.status === 0 && /GNU bash/.test(bash.stdout ?? "");
test("bash -n: every shell script in scripts/server parses", { skip: hasBash ? false : "bash is not available" }, () => {
  const scripts = fs.readdirSync(DIR).filter((f) => f.endsWith(".sh"));
  assert.ok(scripts.length >= 5, scripts.join(", "));
  for (const f of scripts) {
    const r = spawnSync("bash", ["-n"], { input: read(f), encoding: "utf8" });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
    assert.doesNotMatch(read(f), /\r/, `${f} must use LF line endings`);
  }
});
