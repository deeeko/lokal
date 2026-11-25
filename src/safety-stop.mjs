// A deliberate safety stop, on record. When autopilot (watch --execute) stops on purpose (a StopError: a payout failed,
// a swap brought no USD₮, a save failed, a cap was reached, an attribution tag is missing, ...) it exits with
// EXIT_SAFETY_STOP (3) and writes SAFETY_STOP_FILE: { at, host, pid, reason }. The reason is autopilot's own first
// sentence (no keys, no secrets). Nothing in the agent reads the file back: it is for the server's service manager
// (scripts/server/prestart.mjs refuses to start autopilot while it exists), so a reboot can never quietly resume
// autopilot after a safety stop. The owner removes it after fixing the cause (scripts/server/resume.sh).
import fs from "node:fs";
import os from "node:os";
import { SAFETY_STOP_FILE } from "./config.mjs";

/** Records a safety stop. Never throws (the stop itself is already printed and alerted); returns true when written. */
export function recordSafetyStop(reason, { file = SAFETY_STOP_FILE, now = () => Date.now(), host = os.hostname(), pid = process.pid } = {}) {
  const rec = { at: new Date(now()).toISOString(), host, pid, reason: String(reason ?? "").slice(0, 500) };
  try {
    fs.writeFileSync(file, JSON.stringify(rec, null, 2) + "\n");
    return true;
  } catch {
    return false;
  }
}

/** The recorded safety stop, null when there is none, or { unreadable: true } when the file exists but can't be parsed. */
export function readSafetyStop(file = SAFETY_STOP_FILE) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) { return e?.code === "ENOENT" ? null : { unreadable: true }; }
  try {
    const j = JSON.parse(text);
    return j && typeof j === "object" && !Array.isArray(j) ? j : { unreadable: true };
  } catch { return { unreadable: true }; }
}
