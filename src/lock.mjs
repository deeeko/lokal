// One agent at a time. Autopilot (watch --execute) and every command that can move money (pay, ask, retry, register and
// refund, each with --execute) take the same lock file, agent.lock next to the watch state, so two of them can never
// race on one deposit or one balance. Dry runs never take it.
//   - Created with the "wx" flag (fails if it exists), holding { pid, host, startedAt, command }.
//   - A live holder on this computer: refused ("Autopilot is already running (pid N, started T).").
//   - A dead holder (same host, the pid is gone): NOT removed automatically. The command says a stale lock was found and
//     asks for --clear-stale-lock, so the operator looks before anything runs.
//   - Another computer's lock (a shared folder): refused; it can't be checked from here. --clear-stale-lock clears it.
//   - Released on normal exit, Ctrl+C (SIGINT), SIGTERM and uncaught exceptions (Node runs "exit" listeners for those).
//     Release removes the file only if it is still ours.
import fs from "node:fs";
import os from "node:os";
import { AGENT_LOCK_FILE } from "./config.mjs";

/** Thrown when the lock can't be taken. `stale` is true when --clear-stale-lock would help. */
export class LockError extends Error {}

/** True when a process with this pid exists on this computer (EPERM: it exists but belongs to someone else). */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === "EPERM"; }
}

/** The lock file's content, or null when it is missing; { unreadable: true } when it can't be parsed. */
export function readLock(file = AGENT_LOCK_FILE) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) { if (e?.code === "ENOENT") return null; return { unreadable: true }; }
  try {
    const j = JSON.parse(text);
    return j && typeof j === "object" ? j : { unreadable: true };
  } catch { return { unreadable: true }; }
}

const who = (h) => (h.command === "watch --execute" || !h.command ? "Autopilot is already running" : `Another Lokal command is running (${h.command})`);

/**
 * Why `holder` blocks us: "live" | "stale" | "foreign" | "unreadable". Pure apart from isAlive.
 */
export function lockState(holder, { host = os.hostname(), isAlive = pidAlive } = {}) {
  if (!holder || holder.unreadable || !Number.isInteger(holder.pid)) return "unreadable";
  if (holder.host !== host) return "foreign";
  return isAlive(holder.pid) ? "live" : "stale";
}

/**
 * Takes the agent lock or throws a LockError with what to do. Returns { release, file, info }.
 * opts: { file, command, clearStale, host, pid, now, isAlive, onExit (default true: release on process exit),
 *         signals (default false: also release + exit on SIGINT / SIGTERM; autopilot handles those itself) }.
 */
export function acquireLock({
  file = AGENT_LOCK_FILE, command = "", clearStale = false, host = os.hostname(), pid = process.pid, now = () => Date.now(),
  isAlive = pidAlive, onExit = true, signals = false,
} = {}) {
  const info = { pid, host, startedAt: new Date(now()).toISOString(), command };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, "wx");
      try { fs.writeSync(fd, JSON.stringify(info) + "\n"); } finally { fs.closeSync(fd); }
      return holdLock(file, info, { onExit, signals });
    } catch (e) {
      if (e?.code !== "EEXIST") throw e;
    }
    const holder = readLock(file);
    if (holder == null) continue; // it went away meanwhile: try once more
    const state = lockState(holder, { host, isAlive });
    const since = holder.startedAt ? `, started ${holder.startedAt}` : "";
    if (state === "live") {
      throw new LockError(`${who(holder)} (pid ${holder.pid}${since}). Only one Lokal agent may run at a time; nothing was done. Stop it first (Ctrl+C in its window).`);
    }
    if (!clearStale || attempt > 0) {
      const what = state === "stale"
        ? `A stale lock was found: ${file} names pid ${holder.pid}${since} on this computer, and that process is gone (probably a crash).`
        : state === "foreign"
          ? `The lock ${file} belongs to another computer (${holder.host}, pid ${holder.pid}${since}); it can't be checked from here.`
          : `The lock file ${file} exists but can't be read.`;
      throw Object.assign(new LockError(
        `${what} Nothing was done. If no Lokal agent is running, check its last payout on Celoscan, then run the same command again with --clear-stale-lock.`,
      ), { stale: true });
    }
    fs.rmSync(file, { force: true });
  }
  throw new LockError(`Could not take the lock ${file}; another Lokal command took it at the same moment. Nothing was done.`);
}

/** Registers the release hooks for a lock we hold. */
function holdLock(file, info, { onExit, signals }) {
  let held = true;
  const listeners = [];
  const release = () => {
    if (!held) return;
    held = false;
    for (const [ev, fn] of listeners) process.off(ev, fn);
    const cur = readLock(file);
    // only ever remove our own lock
    if (cur && cur.pid === info.pid && cur.startedAt === info.startedAt && cur.host === info.host) {
      try { fs.rmSync(file, { force: true }); } catch { /* nothing more to do */ }
    }
  };
  const on = (ev, fn) => { process.on(ev, fn); listeners.push([ev, fn]); };
  if (onExit) on("exit", release); // also runs after an uncaught exception
  if (signals) {
    on("SIGINT", () => { release(); process.exit(130); });
    on("SIGTERM", () => { release(); process.exit(143); });
  }
  return { release, file, info };
}

/** Releases a lock acquireLock returned (safe to call twice, or with null). */
export function releaseLock(lock) {
  try { lock?.release?.(); } catch { /* the exit hook tries again */ }
}

/** A lock that does nothing (tests, dry runs). */
export const noLock = () => ({ release() {}, file: null, info: null });
