// The agent lock (src/lock.mjs): one agent at a time. Acquire, refuse a live holder, never auto-remove a stale one
// (only --clear-stale-lock), refuse another computer's lock, release only our own, and autopilot holding it for its
// whole run. Temp files only.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LockError, acquireLock, lockState, pidAlive, readLock, releaseLock } from "../src/lock.mjs";
import { watch } from "../src/watch.mjs";
import { world } from "./fakes.mjs";

const tmpLock = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "np-lock-")), "agent.lock");
const HOST = "pc-1";

test("acquire: an exclusive file with pid, host, start time and command; release removes it", () => {
  const file = tmpLock();
  const lock = acquireLock({ file, command: "watch --execute", host: HOST, pid: 4242, isAlive: () => true, onExit: false });
  const held = readLock(file);
  assert.deepEqual(Object.keys(held).sort(), ["command", "host", "pid", "startedAt"]);
  assert.equal(held.pid, 4242);
  assert.equal(held.host, HOST);
  assert.equal(held.command, "watch --execute");
  assert.ok(Date.parse(held.startedAt));
  lock.release();
  assert.equal(fs.existsSync(file), false);
  lock.release(); // twice is fine
  releaseLock(null);
});

test("a live holder on this computer is refused with who holds it and since when", () => {
  const file = tmpLock();
  const a = acquireLock({ file, command: "watch --execute", host: HOST, pid: 100, isAlive: () => true, onExit: false });
  assert.throws(
    () => acquireLock({ file, command: "pay --execute", host: HOST, pid: 200, isAlive: () => true, onExit: false }),
    (e) => e instanceof LockError && /^Autopilot is already running \(pid 100, started \d{4}-/.test(e.message) && !e.stale,
  );
  // --clear-stale-lock never removes a LIVE lock
  assert.throws(() => acquireLock({ file, host: HOST, pid: 200, isAlive: () => true, clearStale: true, onExit: false }), /already running/);
  assert.equal(readLock(file).pid, 100);
  a.release();
  const b = acquireLock({ file, command: "pay --execute", host: HOST, pid: 200, isAlive: () => true, onExit: false });
  assert.throws(() => acquireLock({ file, host: HOST, pid: 300, isAlive: () => true, onExit: false }), /Another LokalPay command is running \(pay --execute/);
  b.release();
});

test("a stale lock (dead pid) is NOT removed automatically; --clear-stale-lock takes it over", () => {
  const file = tmpLock();
  fs.writeFileSync(file, JSON.stringify({ pid: 999999, host: HOST, startedAt: "2026-11-20T10:00:00.000Z", command: "watch --execute" }));
  assert.throws(
    () => acquireLock({ file, host: HOST, pid: 1, isAlive: () => false, onExit: false }),
    (e) => e instanceof LockError && e.stale && /stale lock was found/.test(e.message) && /--clear-stale-lock/.test(e.message),
  );
  assert.equal(readLock(file).pid, 999999, "left exactly as it was");
  const lock = acquireLock({ file, host: HOST, pid: 1, isAlive: () => false, clearStale: true, onExit: false });
  assert.equal(readLock(file).pid, 1);
  lock.release();
});

test("another computer's lock and an unreadable lock are refused; they can only be cleared on purpose", () => {
  const file = tmpLock();
  fs.writeFileSync(file, JSON.stringify({ pid: 5, host: "other-pc", startedAt: "2026-11-20T10:00:00.000Z" }));
  assert.throws(() => acquireLock({ file, host: HOST, pid: 1, isAlive: () => false, onExit: false }), /another computer \(other-pc/);
  fs.writeFileSync(file, "{half");
  assert.throws(() => acquireLock({ file, host: HOST, pid: 1, onExit: false }), /can't be read/);
  acquireLock({ file, host: HOST, pid: 1, clearStale: true, onExit: false }).release();
  assert.equal(lockState(null), "unreadable");
  assert.equal(lockState({ pid: 3, host: HOST }, { host: HOST, isAlive: () => true }), "live");
});

test("release only removes our own lock, and the exit hook is registered and removed", () => {
  const file = tmpLock();
  const before = process.listenerCount("exit");
  const lock = acquireLock({ file, host: HOST, pid: 7, isAlive: () => true });
  assert.equal(process.listenerCount("exit"), before + 1, "released on exit (also after an uncaught exception)");
  // someone cleared it and started again: our release must not delete their lock
  fs.writeFileSync(file, JSON.stringify({ pid: 8, host: HOST, startedAt: "2026-11-21T00:00:00.000Z" }));
  lock.release();
  assert.equal(readLock(file).pid, 8);
  assert.equal(process.listenerCount("exit"), before);
  const sig = acquireLock({ file: tmpLock(), host: HOST, pid: 9, signals: true });
  assert.ok(process.listenerCount("SIGTERM") >= 1);
  sig.release();
});

test("pidAlive: this process is alive, a nonsense pid is not", () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(0), false);
  assert.equal(pidAlive(-5), false);
  assert.equal(pidAlive(2 ** 22 + 12345), false);
});

test("autopilot with --execute holds the real lock for its whole run and releases it; a second one is refused", async () => {
  const file = tmpLock();
  const w = world({ deposits: [{ n: 1, block: 901, units: 7_000_000n }] });
  let seenDuringRun = null;
  w.io.acquireLock = (opts) => acquireLock({ ...opts, file, onExit: false });
  const realPrint = w.io.print;
  w.io.print = (s) => { seenDuringRun ??= readLock(file); realPrint(s); };
  await watch({ execute: true, polls: 1, io: w.io });
  assert.equal(seenDuringRun.command, "watch --execute");
  assert.equal(fs.existsSync(file), false, "released when autopilot stopped");

  // a live holder: the second autopilot never starts (nothing scanned, paid or saved)
  const holder = acquireLock({ file, host: os.hostname(), pid: process.pid, onExit: false });
  const w2 = world({ deposits: [{ n: 1, block: 901, units: 7_000_000n }] });
  w2.io.acquireLock = (opts) => acquireLock({ ...opts, file, onExit: false });
  await assert.rejects(watch({ execute: true, polls: 1, io: w2.io }), /already running/);
  assert.equal(w2.out.length, 0);
  assert.deepEqual(w2.mem.saved, []);
  holder.release();

  // a dry run never takes it
  let taken = 0;
  const w3 = world();
  w3.io.acquireLock = () => { taken++; return { release() {} }; };
  await watch({ execute: false, polls: 1, io: w3.io });
  assert.equal(taken, 0);
});

test("autopilot releases the lock even when it stops on an error", async () => {
  const file = tmpLock();
  const w = world({ deposits: [{ n: 1, block: 901, units: 5_030_000n }], regs: [] });
  w.mem.requests = [{ v: 1, id: "r_aaaaaaaa", name: "ada", amount: "5.03", dir: "usdt-cngn", created: (1_700_000_000 - 100) * 1000, exp: (1_700_000_000 + 99_999) * 1000 }];
  w.io.acquireLock = (opts) => acquireLock({ ...opts, file, onExit: false });
  w.io.pay = async () => { throw new Error("Textile is down"); };
  await assert.rejects(watch({ execute: true, polls: 1, io: w.io }), /Payout for r_aaaaaaaa failed/);
  assert.equal(fs.existsSync(file), false);
});
