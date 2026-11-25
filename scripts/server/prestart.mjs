#!/usr/bin/env node
// Runs before every start of the lokalpay-agent service (ExecStartPre in lokalpay-agent.service). It decides whether
// autopilot may start without a human, and clears a stale lock only in the one case where that is safe:
//   1. A recorded safety stop (safety-stop.json, written when autopilot stopped ON PURPOSE) -> REFUSE. Nothing starts
//      until the owner has fixed the cause and run scripts/server/resume.sh. This holds across reboots.
//   2. No agent.lock -> START.
//   3. agent.lock from ANOTHER computer, or unreadable -> REFUSE (it can't be checked from here).
//   4. agent.lock from this computer:
//        - written before this boot (the machine restarted, so its process is certainly gone) -> CLEAR it, START;
//        - its pid is still running -> REFUSE (another agent or --execute command is running on this server);
//        - its pid is gone (a crash, an OOM kill, SIGKILL) -> CLEAR it, START.
// Clearing is safe there because the agent records every deposit BEFORE paying it (exactly-once lives in the state
// files, not in the lock); the lock only keeps two live processes apart, and none is alive.
// It never reads the key or the status secret. Exit 0 = start; exit 3 (EXIT_SAFETY_STOP) = refuse.
import fs from "node:fs";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { AGENT_LOCK_FILE, EXIT_SAFETY_STOP, SAFETY_STOP_FILE } from "../../src/config.mjs";
import { lockState, pidAlive, readLock } from "../../src/lock.mjs";
import { readSafetyStop } from "../../src/safety-stop.mjs";

/**
 * Pure decision. lock: readLock()'s value; stop: readSafetyStop()'s value; bootMs: when this machine booted (ms, or
 * null when unknown). Returns { action: "start" | "clear" | "refuse", reason }.
 */
export function prestartDecision({ lock, stop, host = os.hostname(), bootMs = null, isAlive = pidAlive }) {
  if (stop) {
    const what = stop.unreadable ? "safety-stop.json exists but can't be read" : `${stop.at ?? "?"}: ${stop.reason ?? "no reason recorded"}`;
    return { action: "refuse", reason: `Autopilot stopped on purpose (a safety stop) and is not restarted automatically (${what}). Fix the cause, then run scripts/server/resume.sh.` };
  }
  if (!lock) return { action: "start", reason: "agent.lock is free" };
  const state = lockState(lock, { host, isAlive });
  if (state === "foreign") return { action: "refuse", reason: `agent.lock belongs to another computer (${lock.host}, pid ${lock.pid}). Only one agent may ever run. Check, then remove it by hand.` };
  if (state === "unreadable") return { action: "refuse", reason: "agent.lock exists but can't be read. Check that no agent runs, then remove it by hand." };
  const started = Date.parse(lock.startedAt ?? "");
  if (bootMs != null && Number.isFinite(started) && started < bootMs) {
    return { action: "clear", reason: `stale lock from before this boot (pid ${lock.pid}, started ${lock.startedAt}); the machine restarted` };
  }
  if (state === "live") return { action: "refuse", reason: `pid ${lock.pid} holds agent.lock and is still running (${lock.command || "watch"}, since ${lock.startedAt}). Only one agent may run; stop it first.` };
  return { action: "clear", reason: `stale lock from pid ${lock.pid} (started ${lock.startedAt}); that process is gone (a crash)` };
}

/** When this machine booted (Linux /proc/stat btime), in ms, or null. */
export function bootTimeMs(read = (f) => fs.readFileSync(f, "utf8")) {
  try {
    const m = /^btime (\d+)$/m.exec(read("/proc/stat"));
    return m ? Number(m[1]) * 1000 : null;
  } catch { return null; }
}

function main() {
  const lock = readLock(AGENT_LOCK_FILE);
  const d = prestartDecision({ lock, stop: readSafetyStop(SAFETY_STOP_FILE), bootMs: bootTimeMs() });
  if (d.action === "clear" && JSON.stringify(readLock(AGENT_LOCK_FILE)) !== JSON.stringify(lock)) {
    // remove only the lock that was judged: if it changed meanwhile, something else is starting
    d.action = "refuse";
    d.reason = "agent.lock changed while it was being checked.";
  }
  if (d.action === "refuse") {
    console.error(`lokalpay prestart: NOT STARTING. ${d.reason}`);
    process.exitCode = EXIT_SAFETY_STOP;
    return;
  }
  if (d.action === "clear") {
    fs.rmSync(AGENT_LOCK_FILE, { force: true });
    console.log(`lokalpay prestart: cleared a ${d.reason}. Starting autopilot.`);
    return;
  }
  console.log(`lokalpay prestart: ${d.reason}. Starting autopilot.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
