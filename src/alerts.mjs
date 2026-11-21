// Alerts for the operator: Telegram (ALERT_TELEGRAM_TOKEN + ALERT_TELEGRAM_CHAT_ID) and/or any webhook (ALERT_WEBHOOK_URL,
// a JSON POST { text, content, level, kind, at }, which Slack and Discord both read). Both optional; without them alerts
// are off and autopilot only prints.
//
// Safety: an alert can never stop, delay or change a payout.
//   - alert() only appends a line to a local outbox (alerts-outbox.jsonl, git-ignored) and returns; sending happens in
//     the background, each request with a 5 s timeout, retried with backoff, dropped after 8 tries or 24 hours.
//   - Nothing here throws. A failing channel is noted once per streak, without its URL or token.
//   - Texts are built by autopilot from public facts (addresses, tx hashes, amounts, reasons, commands). Any configured
//     secret (bot token, webhook URL, status secret) that somehow ends up in a text is replaced by [redacted].
//
// Levels: urgent (autopilot stopped, payout failed, refund failed), warning (daily cap reached, CELO low, status server
// unreachable 10+ minutes), info (deposit refused, payout paid). Info alerts can be muted with ALERT_MUTE.
import crypto from "node:crypto";
import { ALERTS_OUTBOX_FILE } from "./config.mjs";
import { outboxFiles } from "./status-report.mjs";

export const ALERT_KINDS = {
  autopilot_stopped: "urgent",
  payout_failed: "urgent",
  refund_failed: "urgent",
  daily_cap: "warning",
  celo_low: "warning",
  status_unreachable: "warning",
  deposit_refused: "info",
  payout_paid: "info",
  test: "info",
};
/** Only info alerts can be muted (ALERT_MUTE=payout_paid,deposit_refused). */
export const MUTABLE = ["payout_paid", "deposit_refused"];
export const ALERT_TIMEOUT_MS = 5_000;
export const MAX_TRIES = 8;
const MAX_AGE_MS = 24 * 3600_000;
const MAX_TEXT = 1500;
const LABEL = { urgent: "URGENT", warning: "WARNING", info: "INFO" };

/** https:// anywhere, http:// only on this computer (tests, a local relay). */
const urlOk = (u) => /^https:\/\/[^/\s]+/.test(String(u)) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(String(u));

/**
 * The channels configured in `env`: { telegram: { token, chatId } | null, webhook: url | null, mute: Set, problems: [] }.
 * A half-configured or non-https channel is left out and named in `problems` (never with its value).
 */
export function alertChannels(env = process.env) {
  const token = String(env.ALERT_TELEGRAM_TOKEN ?? "").trim();
  const chatId = String(env.ALERT_TELEGRAM_CHAT_ID ?? "").trim();
  const hook = String(env.ALERT_WEBHOOK_URL ?? "").trim();
  const problems = [];
  let telegram = null;
  if (token || chatId) {
    if (!/^\d{3,20}:[A-Za-z0-9_-]{20,100}$/.test(token)) problems.push("ALERT_TELEGRAM_TOKEN does not look like a bot token");
    else if (!/^-?\d{1,20}$|^@[A-Za-z0-9_]{4,64}$/.test(chatId)) problems.push("ALERT_TELEGRAM_CHAT_ID must be a chat id (a number) or @channel");
    else telegram = { token, chatId };
  }
  let webhook = null;
  if (hook) {
    if (!urlOk(hook)) problems.push("ALERT_WEBHOOK_URL must start with https://");
    else webhook = hook;
  }
  const mute = new Set(String(env.ALERT_MUTE ?? "").split(",").map((s) => s.trim()).filter((k) => MUTABLE.includes(k)));
  return { telegram, webhook, mute, problems };
}

/** Replaces every secret in `text` by [redacted] (strings shorter than 8 characters are left alone). */
export function scrub(text, secrets = []) {
  let t = String(text ?? "");
  for (const s of secrets) if (typeof s === "string" && s.length >= 8) t = t.split(s).join("[redacted]");
  return t;
}

/** "[URGENT] Lokal agent: <text>", at most MAX_TEXT characters. */
export function alertText(kind, text) {
  const level = ALERT_KINDS[kind] ?? "info";
  const t = `[${LABEL[level]}] Lokal agent: ${String(text ?? "").replace(/\s+/g, " ").trim()}`;
  return t.length > MAX_TEXT ? t.slice(0, MAX_TEXT - 1) + "…" : t;
}

const DISABLED = Object.freeze({
  enabled: false, channels: [], alert() { return false; }, async flush() { return { sent: 0, left: 0 }; }, async close() {},
  async sendNow() { return { ok: false, error: "alerts are off" }; },
});

/**
 * The alerter. opts: { env, outboxFile, fetchImpl, now, say, timeoutMs, debounceMs, setTimer, clearTimer, secrets }.
 *   alert(kind, text): queue one alert (false when muted, off or unknown). flush(): send what is queued.
 *   sendNow(kind, text): queue it and send right away (alert-test). close({ waitMs }): last chance, then stop.
 * Off (DISABLED) when no channel is configured, and under the test runner unless the test passes its own outboxFile.
 */
export function makeAlerter({
  env = process.env, outboxFile, fetchImpl = globalThis.fetch, now = () => Date.now(), say = () => {},
  timeoutMs = ALERT_TIMEOUT_MS, debounceMs = 1_000, setTimer = setTimeout, clearTimer = clearTimeout, secrets = [],
} = {}) {
  try {
    if (env.NODE_TEST_CONTEXT && !outboxFile) return DISABLED;
    const ch = alertChannels(env);
    for (const p of ch.problems) say(`Alerts: ${p}; that channel is off.`);
    if (!ch.telegram && !ch.webhook) return DISABLED;
    const hidden = [ch.telegram?.token, ch.webhook, env.NP_STATUS_SECRET, ...secrets].filter(Boolean);
    return createAlerter({ ch, hidden, box: outboxFiles(outboxFile ?? ALERTS_OUTBOX_FILE), fetchImpl, now, say, timeoutMs, debounceMs, setTimer, clearTimer });
  } catch {
    return DISABLED;
  }
}

function createAlerter({ ch, hidden, box, fetchImpl, now, say, timeoutMs, debounceMs, setTimer, clearTimer }) {
  const channels = [...(ch.telegram ? ["telegram"] : []), ...(ch.webhook ? ["webhook"] : [])];
  let waiting = [];
  let timer = null, inflight = null, failures = 0, failNoted = false, stopped = false;
  const noted = new Set();
  const safeSay = (m) => { try { say(scrub(m, hidden)); } catch { /* never */ } };
  const noteOnce = (k, m) => { if (!noted.has(k)) { noted.add(k); safeSay(m); } };

  /** Appends what is waiting if the outbox lock is free right now; else it stays in memory for the next try. */
  function drain() {
    if (!waiting.length || !box.tryLock()) return;
    const list = waiting;
    waiting = [];
    try { box.append(list); } catch (e) {
      noteOnce("append", `Alerts: could not queue ${list.length} alert(s) (${e.code ?? e.message}); they were skipped. Payouts are not affected.`);
    } finally { box.unlock(); }
  }

  function schedule(ms) {
    if (stopped || timer) return;
    timer = setTimer(() => { timer = null; flush().catch(() => {}); }, ms);
    timer?.unref?.();
  }

  /** Queues one alert. Never waits, never throws. */
  function alert(kind, text) {
    try {
      if (stopped || !ALERT_KINDS[kind] || ch.mute.has(kind)) return false;
      const at = new Date(now()).toISOString();
      waiting.push({ id: `al_${now()}_${crypto.randomBytes(4).toString("hex")}`, kind, level: ALERT_KINDS[kind], text: scrub(alertText(kind, text), hidden), at, tries: 0, done: [] });
      drain();
      schedule(debounceMs);
      return true;
    } catch { return false; }
  }

  /** POSTs one alert to one channel. Resolves true when it was accepted; never rejects. */
  async function sendTo(channel, a) {
    const c = typeof AbortController === "function" ? new AbortController() : null;
    const t = setTimer(() => c?.abort(), timeoutMs);
    t?.unref?.();
    try {
      const [url, body] = channel === "telegram"
        ? [`https://api.telegram.org/bot${ch.telegram.token}/sendMessage`, { chat_id: ch.telegram.chatId, text: a.text, disable_web_page_preview: true }]
        : [ch.webhook, { text: a.text, content: a.text, level: a.level, kind: a.kind, at: a.at }];
      const r = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: c?.signal, redirect: "error" });
      if (r.status >= 200 && r.status < 300) return { ok: true };
      return { ok: false, error: `HTTP ${r.status}` };
    } catch (e) {
      return { ok: false, error: e?.name === "AbortError" ? "timed out" : (e?.cause?.code ?? "network error") };
    } finally {
      clearTimer(t);
    }
  }

  /** Sends everything queued. Resolves { sent, left, error? }; never rejects. */
  function flush() {
    if (inflight) return inflight;
    inflight = (async () => {
      let sent = 0;
      let lastError = null;
      try {
        drain();
        const { events: queue } = box.readQueue();
        const updates = new Map(); // id -> updated entry | null (delivered or dropped)
        for (const a of queue) {
          if (now() - Date.parse(a.at) > MAX_AGE_MS || (a.tries ?? 0) >= MAX_TRIES) {
            updates.set(a.id, null);
            noteOnce(`dropped:${a.kind}`, `Alerts: gave up on a "${a.kind}" alert after ${a.tries ?? 0} tries.`);
            continue;
          }
          const done = new Set(Array.isArray(a.done) ? a.done : []);
          for (const c of channels) {
            if (done.has(c)) continue;
            const r = await sendTo(c, a);
            if (r.ok) done.add(c);
            else lastError = `${c}: ${r.error}`;
          }
          if (channels.every((c) => done.has(c))) { updates.set(a.id, null); sent++; }
          else updates.set(a.id, { ...a, tries: (a.tries ?? 0) + 1, done: [...done] });
        }
        if (updates.size && box.tryLock()) {
          try {
            const keep = [];
            for (const e of box.readQueue().events) {
              if (!updates.has(e.id)) keep.push(e);
              else if (updates.get(e.id)) keep.push(updates.get(e.id));
            }
            box.rewriteQueue(keep);
          } finally { box.unlock(); }
        }
        const left = queue.length - [...updates.values()].filter((v) => v === null).length;
        if (lastError) {
          failures++;
          if (!failNoted) { failNoted = true; safeSay(`Alerts: couldn't send (${lastError}). Payouts are not affected; retrying in the background.`); }
          schedule(Math.min(5_000 * 2 ** Math.min(failures - 1, 8), 10 * 60_000));
        } else {
          if (failNoted) safeSay("Alerts: sending again.");
          failures = 0;
          failNoted = false;
        }
        return { sent, left, ...(lastError ? { error: lastError } : {}) };
      } catch (e) {
        noteOnce("flush", `Alerts: sending failed (${e.message}). Payouts are not affected.`);
        return { sent, left: -1, error: e.message };
      }
    })().finally(() => { inflight = null; });
    return inflight;
  }

  /** Queues one alert and sends right away (alert-test). Resolves { ok, error? }. */
  async function sendNow(kind, text) {
    if (!alert(kind, text)) return { ok: false, error: "muted or unknown alert" };
    const r = await flush();
    return r.error ? { ok: false, error: r.error } : { ok: true };
  }

  /** Stops the timer and gives queued alerts one last chance (at most `waitMs`). */
  async function close({ waitMs = 5_000 } = {}) {
    stopped = true;
    if (timer) { clearTimer(timer); timer = null; }
    try {
      drain();
      if (waitMs <= 0 || !box.readQueue().events.length) return;
      let t;
      await Promise.race([flush(), new Promise((res) => { t = setTimer(res, waitMs); t?.unref?.(); })]);
      clearTimer(t);
    } catch { /* never */ }
  }

  return { enabled: true, channels, alert, flush, sendNow, close };
}

// ---------- low gas (pure) ----------

/** Re-warn about low CELO at most this often while it stays low. */
export const GAS_REWARN_MS = 3600_000;
/** Read the agent's CELO balance at most this often. */
export const GAS_CHECK_MS = 60_000;

/**
 * Decides whether to warn about the agent's CELO. state: { level: "ok"|"low"|"reserve", warnedAt } (start with {}).
 * level "low": under `warnUnits`; "reserve": also under the hard reserve `reserveUnits`. Warns when the level gets worse,
 * then at most every GAS_REWARN_MS while it stays low; says once when it is fine again.
 * Returns { state, warn: "low" | "reserve" | null, recovered: boolean }.
 */
export function gasAlert(state, { balance, warnUnits, reserveUnits, now }) {
  const b = BigInt(balance);
  const level = b < BigInt(reserveUnits) ? "reserve" : b < BigInt(warnUnits) ? "low" : "ok";
  const rank = { ok: 0, low: 1, reserve: 2 };
  const prev = state?.level ?? "ok";
  if (level === "ok") return { state: { level }, warn: null, recovered: prev !== "ok" };
  const worse = rank[level] > rank[prev];
  const due = state?.warnedAt == null || now - state.warnedAt >= GAS_REWARN_MS;
  if (worse || due) return { state: { level, warnedAt: now }, warn: level, recovered: false };
  return { state: { level, warnedAt: state.warnedAt }, warn: null, recovered: false };
}
