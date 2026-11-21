// Watchdog for autopilot, run by .github/workflows/agent-watchdog.yml every 15 minutes (GitHub's schedule is best
// effort). It reads GET <site>/api/status?agent=1 and sends a Telegram alert when the agent's last heartbeat is more
// than 10 minutes old (or the status server can't be read). While it stays down it re-alerts only every 60 minutes,
// and it sends one "back online" message when heartbeats return. Its memory between runs is a tiny JSON state file
// that the workflow keeps in the Actions cache. Needs no key and moves no money; the bot token is only ever sent to
// Telegram, never printed.
//   node scripts/agent-watchdog.mjs [--state FILE]      env: STATUS_URL or SITE_URL, ALERT_TELEGRAM_TOKEN, ALERT_TELEGRAM_CHAT_ID
import fs from "node:fs";

export const STALE_SEC = 10 * 60;
export const REALERT_MS = 60 * 60_000;

/**
 * What to do now. state: { down: boolean, alertedAt: ms | null } (from the last run); view: the GET answer
 * ({ ok, agent: { ageSec, lastSeen } | null }) or { error }. Returns { state, message | null }.
 */
export function watchdogDecision(state = {}, view = {}, now = Date.now()) {
  const age = view?.agent?.ageSec;
  const healthy = view?.ok === true && Number.isFinite(age) && age <= STALE_SEC;
  if (healthy) {
    return state.down
      ? { state: { down: false, alertedAt: null }, message: `Lokal agent is back online (last heartbeat ${age} s ago).` }
      : { state: { down: false, alertedAt: null }, message: null };
  }
  const why = view?.error ? `the status server could not be read (${view.error})`
    : view?.agent ? `its last heartbeat was ${Math.round(age / 60)} minutes ago (${view.agent.lastSeen})`
      : "no heartbeat has been stored yet";
  const msg = `[URGENT] Lokal agent looks offline: ${why}. Autopilot pays nothing while it is stopped. On the agent's PC run: node src/agent.mjs watch --execute`;
  if (!state.down) return { state: { down: true, alertedAt: now }, message: msg };
  if (state.alertedAt == null || now - state.alertedAt >= REALERT_MS) return { state: { down: true, alertedAt: now }, message: `${msg} (still down)` };
  return { state, message: null };
}

/** GET ?agent=1 with a 10 s timeout; never throws. */
export async function readAgentStatus(url, fetchImpl = fetch) {
  try {
    const r = await fetchImpl(`${url}?agent=1`, { signal: AbortSignal.timeout(10_000) });
    if (r.status !== 200) return { error: `HTTP ${r.status}` };
    return await r.json();
  } catch (e) {
    return { error: e?.name === "TimeoutError" ? "timed out" : e?.cause?.code ?? "network error" };
  }
}

async function main() {
  const i = process.argv.indexOf("--state");
  const file = i > 0 ? process.argv[i + 1] : "watchdog-state.json";
  const url = (process.env.STATUS_URL || `${(process.env.SITE_URL || "https://lokalpay.vercel.app").replace(/\/+$/, "")}/api/status`).replace(/\/+$/, "");
  let state = {};
  try { state = JSON.parse(fs.readFileSync(file, "utf8")); } catch { state = {}; }
  const view = await readAgentStatus(url);
  const d = watchdogDecision(state, view);
  console.log(view.error ? `Status: ${view.error}` : `Agent: ${view.agent ? `last heartbeat ${view.agent.ageSec} s ago` : "no heartbeat yet"}`);
  if (d.message) {
    console.log(d.message);
    const token = process.env.ALERT_TELEGRAM_TOKEN, chat = process.env.ALERT_TELEGRAM_CHAT_ID;
    if (token && chat) {
      try {
        const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chat, text: d.message }),
          signal: AbortSignal.timeout(5_000),
        });
        console.log(r.ok ? "Telegram alert sent." : `Telegram answered HTTP ${r.status}.`);
      } catch { console.log("Telegram could not be reached."); }
    } else console.log("No Telegram secrets set; alert printed only.");
  }
  fs.writeFileSync(file, JSON.stringify(d.state) + "\n");
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/agent-watchdog.mjs")) await main();
