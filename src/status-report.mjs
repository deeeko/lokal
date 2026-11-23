// Reports what autopilot did with each deposit to the site's status server (api/status.js), so the site can show exact
// facts: paid (receipt number, payout tx), refused (a reason code), failed (the payout hit an error; the owner retries
// it), or received (recorded, paying now), plus direct owner payouts for today's totals.
//
// Safety: reporting NEVER blocks, delays or changes a payout. Every call here is wrapped and never throws.
//   - Events are appended to a local outbox (status-outbox.jsonl, JSON lines, git-ignored) and sent later in the
//     background, in batches, with retries and backoff; a failing server is logged once per streak.
//   - The outbox is shared by autopilot and CLI commands, so every change to it takes a small lock file (stale after
//     30 s). Queuing never waits for the lock: if it is busy, the events wait in memory and are appended a moment later.
//     CLI commands send directly and only fall back to the queue.
//   - A failed write (a full disk) rolls back its partial line or temp file; the events are simply not queued.
// Without a secret (NP_STATUS_SECRET, or the status-secret file next to the agent key) reporting is off and the site keeps
// estimating from the chain. Only public facts are sent (addresses, hashes, amounts, the tag, the receipt number), plus
// the status and a reason code.
import fs from "node:fs";
import path from "node:path";
import { formatUnits, parseUnits } from "viem";
import { AGENT_ADDRESS, CORRIDORS, STATUS_OUTBOX_FILE, STATUS_SECRET_FILE, STATUS_URL, TOKENS } from "./config.mjs";
import { receiptNo as receiptNoOf } from "./requests.mjs";
import { MAX_BODY, MAX_EVENTS, RANK, STATUS_VERSION, refundNo as refundNoOf, signReport, validateEvent, validateHeartbeat } from "../lib/status.mjs";

export const MIN_SECRET_LENGTH = 32;
export const OUTBOX_MAX = 5000; // queued events kept at most (oldest dropped first)
const SENT_MAX = 5000; // event ids remembered as sent, with their status (so a restart doesn't resend them)
export const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 5_000;
export const RECENT_MS = 48 * 3600_000; // autopilot re-checks this much of its saved records on start
const BACKOFF_MIN_MS = 5_000;
const BACKOFF_MAX_MS = 10 * 60_000;
const BATCH_BYTES = MAX_BODY - 2048;

/** Corridor id -> the token symbol sold / paid out, as the status server names them (USDT, cNGN, IDRX, wARS, wCOP). */
const SELL = Object.fromEntries(Object.values(CORRIDORS).map((c) => [c.id, TOKENS[c.sell].symbol]));
const BUY = Object.fromEntries(Object.values(CORRIDORS).map((c) => [c.id, TOKENS[c.buy].symbol]));
const lc = (s) => String(s ?? "").toLowerCase();
const num = (v) => (v == null || v === "" ? undefined : Number(v));
const rankOf = (s) => (Object.prototype.hasOwnProperty.call(RANK, s) ? RANK[s] : -1);
/**
 * "USDT" | "cNGN" | "IDRX" | "wARS" | "wCOP" | "CELO" from a symbol as autopilot and pay() write it (CNGN, cngn,
 * USD₮, WARS ...), or undefined.
 */
export function tokenSymbol(t) {
  const s = lc(t).replace("₮", "t");
  if (s === "celo") return "CELO";
  return Object.values(TOKENS).find((x) => lc(x.symbol) === s)?.symbol;
}
const addUnits = (a, b) => formatUnits(parseUnits(String(a), 6) + parseUnits(String(b), 6), 6);
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && !(typeof v === "number" && !Number.isFinite(v))));

/** A refusal message (guards, pay, watch) -> the reason code the site explains in plain words. */
export function reasonCode(message) {
  const m = String(message ?? "");
  if (/currency_unavailable/.test(m)) return "currency_unavailable";
  if (/self-payment/i.test(m)) return "self_payment";
  if (/per-wallet cap/i.test(m)) return "over_wallet_cap";
  if (/per-payout cap/i.test(m)) return "over_payment_cap";
  if (/unknown (?:nTag|Lokal(?:Pay)? tag)|(?:nTag|Lokal(?:Pay)? tag) claim not found/i.test(m)) return "unknown_tag"; // nTag, Lokal tag: records written before the renames
  if (/(?:nTag|Lokal(?:Pay)? tag) claim .* does not check out/i.test(m)) return "claim_invalid";
  if (/Registration .* does not check out/i.test(m)) return "registration_invalid";
  if (/memo/i.test(m)) return "bad_memo";
  if (/token not accepted/i.test(m)) return "token_not_accepted";
  if (/minimum/i.test(m)) return "below_minimum";
  if (/Recipient is blocked|not a valid address/i.test(m)) return "recipient_blocked";
  return "other";
}

/** The paid fields of an event from a pay() result (or a saved record with the same fields). */
function paidFields(res, corridor) {
  const payoutTx = res?.hashes?.payout;
  return clean({
    payoutTx, receiptNo: res?.receiptNo ?? (payoutTx ? receiptNoOf(payoutTx) : undefined),
    paidAmount: typeof res?.paid === "string" ? res.paid : res?.paid?.amount, paidToken: tokenSymbol(res?.paidToken) ?? BUY[corridor],
  });
}

/**
 * One deposit event as autopilot reports it right after handling the deposit.
 *   kind: "ntag" | "registration" | "request"; key: "<tx>:<logIndex>"; token: "USDT" | "cNGN"; amount: the deposit;
 *   status: "received" | "failed" | "refused" | "paid"; reason: the refusal message (turned into a code); res: pay()'s result.
 */
export function depositEvent({ kind, key, tag, registration, recipient, token, amount, corridor, payer, status, reason, res, at }) {
  const sym = tokenSymbol(token);
  return clean({
    id: lc(key), kind, tag: tag ?? undefined, registration: registration ? lc(registration) : undefined,
    recipient: recipient ? lc(recipient) : undefined, token: sym, amount: amount == null ? undefined : String(amount),
    usd: status === "paid" ? num(res?.usd) : sym === "USDT" && amount != null ? Number(amount) : undefined,
    status, reason: status === "refused" ? reasonCode(reason) : status === "failed" ? "payout_error" : undefined,
    ...(status === "paid" ? paidFields(res, corridor) : {}),
    depositTx: lc(String(key).split(":")[0]), payer: payer ? lc(payer) : undefined,
    at: at ?? new Date().toISOString(),
  });
}

/** A receipts.jsonl payout the owner made directly (not for a deposit): counts toward the daily totals. */
export function isDirectReceipt(e, agent = AGENT_ADDRESS) {
  if (!e?.hashes?.payout || e.requestId || e.registrationId) return false;
  return !e.ntag || !e.payer || lc(e.payer) === lc(agent);
}
export function directEvent(e) {
  const payout = lc(e.hashes.payout);
  return clean({
    id: `${payout}:direct`, kind: "direct", tag: e.ntag || undefined, recipient: e.recipient ? lc(e.recipient) : undefined,
    token: tokenSymbol(e.sold?.token), amount: e.sold?.amount, usd: num(e.usd ?? e.usdtSpent), status: "paid",
    payoutTx: payout, receiptNo: e.receiptNo ?? receiptNoOf(payout), paidAmount: e.paid?.amount, paidToken: tokenSymbol(e.paid?.token),
    at: e.at,
  });
}
const receiptFor = (receipts, payoutTx) => (payoutTx ? (receipts ?? []).find((r) => lc(r?.hashes?.payout) === lc(payoutTx)) : undefined);

/**
 * Every event autopilot's saved records describe: owner requests (requests.json), "Get paid" registrations incl.
 * refused deposits (registrations-state.json), nTag payments (ntag-payments.json) and direct owner payouts
 * (receipts.jsonl), from `sinceMs` on. A record with a saved payout error is "failed". USD values of paid deposits and
 * missing recipients come from receipts.jsonl. Invalid ones are left out.
 */
export function eventsFromRecords({ requests = [], registrations = {}, ntagPayments = {}, receipts = [], refunds = {}, agent = AGENT_ADDRESS, sinceMs = 0 } = {}) {
  const byPayout = new Map((receipts ?? []).filter((r) => r?.hashes?.payout).map((r) => [lc(r.hashes.payout), r]));
  const out = [];
  const paidRes = (rec) => {
    const r = byPayout.get(lc(rec.hashes?.payout));
    return { hashes: rec.hashes, receiptNo: rec.receiptNo, paid: rec.paid, usd: rec.usd ?? r?.usd ?? r?.usdtSpent };
  };
  const keyOf = (d) => (d?.tx != null && d?.logIndex != null ? `${d.tx}:${d.logIndex}` : null);
  const statusOf = (rec) => (rec.paidAt ? "paid" : rec.error ? "failed" : "received");
  for (const r of requests ?? []) {
    const key = keyOf(r.deposit);
    if (!key) continue;
    const status = statusOf(r);
    const recipient = r.recipient ?? byPayout.get(lc(r.hashes?.payout))?.recipient;
    out.push(depositEvent({
      kind: "request", key, recipient, token: SELL[r.dir], amount: r.amount, corridor: r.dir, payer: r.deposit.payer,
      status, res: status === "paid" ? paidRes(r) : null, at: r.paidAt ?? r.deposit.at,
    }));
  }
  for (const g of Object.values(registrations ?? {})) {
    const base = { kind: "registration", registration: g.hash, recipient: g.from, token: SELL[g.dir], amount: g.amount, corridor: g.dir };
    const key = keyOf(g.deposit);
    if (key) {
      const status = statusOf(g);
      out.push(depositEvent({ ...base, key, payer: g.deposit.payer, status, res: status === "paid" ? paidRes(g) : null, at: g.paidAt ?? g.deposit.at }));
    }
    for (const [k, x] of Object.entries(g.refused ?? {})) {
      out.push(depositEvent({ ...base, key: k, payer: x.payer, status: "refused", reason: x.reason, at: x.refusedAt ?? x.at }));
    }
  }
  for (const [k, p] of Object.entries(ntagPayments ?? {})) {
    const status = p.paidAt ? "paid" : p.status === "refused" ? "refused" : p.error && p.deposit ? "failed" : p.deposit ? "received" : null;
    if (!status) continue;
    let amount = p.amount;
    try { if (p.dust && amount != null) amount = addUnits(amount, p.dust); } catch { /* keep the paid amount */ }
    out.push(depositEvent({
      kind: "ntag", key: k, tag: p.tag ?? undefined, recipient: p.from ?? p.owner, token: p.token ?? SELL[p.dir], amount, corridor: p.dir,
      payer: p.deposit?.payer, status, reason: p.reason, res: status === "paid" ? paidRes(p) : null,
      at: p.paidAt ?? (status === "refused" ? p.refusedAt : p.deposit?.at) ?? p.refusedAt,
    }));
  }
  for (const e of receipts ?? []) if (isDirectReceipt(e, agent)) out.push(directEvent(e));
  // a refunded deposit replaces whatever was said about it before (refused, unmatched): "refunded" ranks above those
  for (const r of Object.values(refunds ?? {})) {
    if (r?.status === "refunded") { const e = refundEvent(r); if (e) out.push(e); }
  }
  const now = Date.now();
  return out.filter((e) => !validateEvent(e, now).error && Date.parse(e.at) >= sinceMs);
}

/**
 * The "paid" event for a record that `agent.mjs retry` just paid. kind: "request" | "registration" | "ntag"; r: the
 * saved record; res: pay()'s result; receipts: receipts.jsonl (the payout's entry names the recipient when the record
 * doesn't, e.g. owner requests saved before recipients were stored).
 */
export function retryPaidEvent(kind, r, res, receipts = []) {
  const corridor = r.dir;
  let amount = r.amount;
  try { if (kind === "ntag" && r.dust) amount = addUnits(r.amount, r.dust); } catch { /* keep the paid amount */ }
  const fromReceipt = receiptFor(receipts, res?.hashes?.payout)?.recipient;
  return depositEvent({
    kind, key: `${r.deposit.tx}:${r.deposit.logIndex}`, tag: kind === "ntag" ? r.tag : undefined,
    registration: kind === "registration" ? r.hash : undefined,
    recipient: kind === "request" ? (r.recipient ?? fromReceipt ?? res?.recipient) : (r.from ?? fromReceipt),
    token: SELL[corridor], amount, corridor, payer: r.deposit.payer, status: "paid", res, at: new Date().toISOString(),
  });
}

/**
 * The "refunded" event for a refunds.json record (status "refunded"): the deposit went back to its sender. The kind is the
 * record autopilot kept for the deposit ("ntag" with its tag, "registration" with its hash), else "deposit" (unmatched or
 * ambiguous). Returns null when the record lacks what the server requires.
 */
export function refundEvent(r) {
  if (!r?.refundTx || !r?.id) return null;
  const kind = r.source?.kind === "ntag" || r.source?.kind === "registration" ? r.source.kind : "deposit";
  const sym = tokenSymbol(r.token);
  return clean({
    id: lc(r.id), kind, tag: kind === "ntag" && r.source?.tag ? r.source.tag : undefined,
    registration: kind === "registration" ? lc(r.source.registration) : undefined,
    recipient: kind !== "deposit" && r.source?.recipient ? lc(r.source.recipient) : undefined,
    token: sym, amount: r.amount == null ? undefined : String(r.amount),
    usd: r.usd != null && Number.isFinite(Number(r.usd)) ? Number(r.usd) : sym === "USDT" && r.amount != null ? Number(r.amount) : undefined,
    status: "refunded", refundTx: lc(r.refundTx), refundNo: refundNoOf(lc(r.refundTx)),
    depositTx: lc(String(r.id).split(":")[0]), payer: r.payer ? lc(r.payer) : undefined, at: r.refundedAt ?? new Date().toISOString(),
  });
}

/**
 * "0.1.0+abc1234": the package version and, when it is cheap to read (.git/HEAD and the ref, no git process), the short
 * commit hash. Used in heartbeats. Never throws.
 */
export function agentVersion(root = path.join(import.meta.dirname, "..")) {
  let v = "0.0.0";
  try { v = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version || v; } catch { /* keep the default */ }
  try {
    let git = path.join(root, ".git");
    if (fs.statSync(git).isFile()) git = path.resolve(root, fs.readFileSync(git, "utf8").replace(/^gitdir:\s*/, "").trim()); // a worktree
    let head = fs.readFileSync(path.join(git, "HEAD"), "utf8").trim();
    const ref = /^ref:\s*(.+)$/.exec(head)?.[1];
    if (ref) {
      const common = fs.existsSync(path.join(git, "commondir")) ? path.resolve(git, fs.readFileSync(path.join(git, "commondir"), "utf8").trim()) : git;
      try { head = fs.readFileSync(path.join(common, ref), "utf8").trim(); } catch {
        head = fs.readFileSync(path.join(common, "packed-refs"), "utf8").split("\n").find((l) => l.endsWith(` ${ref}`))?.split(" ")[0] ?? "";
      }
    }
    if (/^[0-9a-f]{40}$/.test(head)) v += `+${head.slice(0, 7)}`;
  } catch { /* no git: the package version alone */ }
  return v.replace(/[^0-9A-Za-z._+-]/g, "").slice(0, 40) || "0.0.0";
}

// ---------- secret ----------
/**
 * The signing secret: NP_STATUS_SECRET, else the status-secret file. Returns { secret, source } or { reason } when
 * reporting must stay off. The secret itself is never printed.
 */
export function readStatusSecret({ env = process.env, file = STATUS_SECRET_FILE, readFile = fs.readFileSync } = {}) {
  let secret = String(env.NP_STATUS_SECRET ?? "").trim();
  let source = "NP_STATUS_SECRET";
  if (!secret) {
    try { secret = String(readFile(file, "utf8")).trim(); source = "status-secret file"; } catch { secret = ""; }
  }
  if (!secret) return { reason: `no NP_STATUS_SECRET and no ${file}` };
  if (secret.length < MIN_SECRET_LENGTH) return { reason: `the secret from ${source} is shorter than ${MIN_SECRET_LENGTH} characters` };
  return { secret, source };
}

/** https:// anywhere, http:// only on this computer (tests, a local server). */
export const statusUrlOk = (u) => /^https:\/\/[^/\s]+\//.test(String(u)) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(String(u));

// ---------- the outbox files ----------
/**
 * The outbox: <file> (JSON lines, one event per line), <base>.sent.json ({ id: status } of what the server accepted) and
 * <base>.lock. All sync and tiny, except reading a long queue. Writers hold the lock; temp files are per process.
 */
export function outboxFiles(file = STATUS_OUTBOX_FILE) {
  const base = file.replace(/\.jsonl?$/i, "");
  const lockFile = `${base}.lock`;
  const sentFile = `${base}.sent.json`;
  const tmpOf = (f) => `${f}.${process.pid}.tmp`;

  /** Takes the lock if it is free (or stale). Never waits. */
  function tryLock() {
    for (let i = 0; i < 2; i++) {
      try {
        const fd = fs.openSync(lockFile, "wx");
        try { fs.writeSync(fd, String(process.pid)); } finally { fs.closeSync(fd); }
        return true;
      } catch (e) {
        if (e?.code !== "EEXIST") return false;
        try {
          if (Date.now() - fs.statSync(lockFile).mtimeMs > LOCK_STALE_MS) { fs.rmSync(lockFile, { force: true }); continue; }
        } catch { continue; } // it went away meanwhile
        return false;
      }
    }
    return false;
  }
  const unlock = () => { try { fs.rmSync(lockFile, { force: true }); } catch { /* stale after 30 s anyway */ } };

  /** Writes `text` to `f` atomically (per-process temp + rename); on failure removes the temp file and throws. */
  function writeAtomic(f, text) {
    const tmp = tmpOf(f);
    try {
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, f);
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* nothing more to do */ }
      throw e;
    }
  }

  /** Queued events (corrupt lines skipped). */
  function readQueue() {
    let text;
    try { text = fs.readFileSync(file, "utf8"); } catch (e) { if (e?.code === "ENOENT") return { events: [], bad: 0 }; throw e; }
    const events = [];
    let bad = 0;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try { const e = JSON.parse(line); if (e && typeof e === "object" && typeof e.id === "string") events.push(e); else bad++; } catch { bad++; }
    }
    return { events, bad };
  }
  /** Appends events (caller holds the lock). A failed append is rolled back to the old size, so no half line remains. */
  function append(events) {
    let size = 0;
    try { size = fs.statSync(file).size; } catch { size = 0; }
    try {
      let prefix = "";
      if (size > 0) {
        // never glue a new line onto an unterminated one
        const fd = fs.openSync(file, "r");
        try { const b = Buffer.alloc(1); fs.readSync(fd, b, 0, 1, size - 1); if (b[0] !== 10) prefix = "\n"; } finally { fs.closeSync(fd); }
      }
      fs.appendFileSync(file, prefix + events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    } catch (e) {
      try { if (fs.existsSync(file)) fs.truncateSync(file, size); } catch { /* leave it; corrupt lines are skipped */ }
      throw e;
    }
  }
  /** Rewrites the queue without the given events (caller holds the lock). Keeps at most OUTBOX_MAX. */
  function rewriteQueue(events) {
    writeAtomic(file, events.length ? events.map((e) => JSON.stringify(e)).join("\n") + "\n" : "");
  }
  function readSent() {
    try { const j = JSON.parse(fs.readFileSync(sentFile, "utf8")); return j && typeof j === "object" && !Array.isArray(j) ? j : {}; } catch { return {}; }
  }
  function writeSent(sent) {
    const keys = Object.keys(sent);
    if (keys.length > SENT_MAX) for (const k of keys.slice(0, keys.length - SENT_MAX)) delete sent[k];
    writeAtomic(sentFile, JSON.stringify(sent) + "\n");
  }
  return { file, lockFile, sentFile, tryLock, unlock, readQueue, append, rewriteQueue, readSent, writeSent };
}

// ---------- the reporter ----------
const DISABLED = Object.freeze({
  enabled: false, report() { return 0; }, syncRecords() { return 0; }, async sendNow() { return { sent: 0, queued: 0 }; },
  async flush() { return { sent: 0, left: 0 }; }, async ping() { return { ok: false }; }, async close() {}, pending() { return 0; },
  async heartbeat() { return { ok: false }; }, health() { return { failingSince: null }; },
});

/**
 * Background reporter. opts: { secret, url, outboxFile, fetchImpl, now, say, debounceMs, timeoutMs, setTimer, clearTimer }.
 *   report(events): validate + queue (a tiny append), then send soon. Returns how many were accepted for sending.
 *   sendNow(events): send right away (CLI commands); whatever isn't accepted is queued.
 *   syncRecords(records): queue what the saved records say that the server hasn't confirmed yet.
 *   flush(): send everything queued. ping(): a signed check that stores nothing. close(): last chance, then stop.
 * Nothing here throws.
 */
export function createStatusReporter({
  secret, url = STATUS_URL, outboxFile = STATUS_OUTBOX_FILE, fetchImpl = globalThis.fetch, now = () => Date.now(),
  say = () => {}, debounceMs = 2_000, timeoutMs = 10_000, setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  const box = outboxFiles(outboxFile);
  let timer = null, dueAt = 0, inflight = null, failures = 0, failNoted = false, stopped = false, failingSince = null;
  let waiting = []; // events not appended yet because another process held the lock
  let appendTimer = null;
  const noted = new Set();
  const safeSay = (m) => { try { say(m); } catch { /* never */ } };
  const noteOnce = (k, msg) => { if (!noted.has(k)) { noted.add(k); safeSay(msg); } };
  const evKey = (e) => `${e.id}|${e.status}|${e.at}`;
  const sleep = (ms) => new Promise((res) => { const t = setTimer(res, ms); t?.unref?.(); });

  async function withLock(fn, waitMs = LOCK_WAIT_MS) {
    const until = Date.now() + waitMs;
    while (!box.tryLock()) {
      if (Date.now() >= until) return { busy: true };
      await sleep(50);
    }
    try { return { value: fn() }; } finally { box.unlock(); }
  }

  /** Appends whatever is waiting, if the lock is free right now. Never waits; retries itself shortly when busy. */
  function drainWaiting() {
    if (!waiting.length) return true;
    if (!box.tryLock()) {
      if (!appendTimer && !stopped) { appendTimer = setTimer(() => { appendTimer = null; drainWaiting(); }, 200); appendTimer?.unref?.(); }
      return false;
    }
    const list = waiting;
    waiting = [];
    try {
      box.append(list);
      schedule(debounceMs);
      return true;
    } catch (e) {
      noteOnce("append", `Status server: could not queue ${list.length} report(s) (${e.code ?? e.message}); they were skipped. Payouts are not affected. "node src/agent.mjs status-sync --backfill" can resend them later.`);
      return true;
    } finally {
      box.unlock();
    }
  }

  function schedule(ms) {
    if (stopped) return;
    const at = now() + ms;
    if (timer && dueAt <= at) return;
    if (timer) clearTimer(timer);
    dueAt = at;
    timer = setTimer(() => { timer = null; flush().catch(() => {}); }, ms);
    timer?.unref?.();
  }

  function validOnes(events) {
    const t = now();
    const ok = [];
    for (const e of [].concat(events ?? [])) {
      const r = validateEvent(e, t);
      if (r.error) { noteOnce(`invalid:${r.error}`, `Status server: a report for ${typeof e?.id === "string" ? e.id : "a deposit"} was not sent (${r.error}). Payouts are not affected.`); continue; }
      ok.push(r.event);
    }
    return ok;
  }

  /** Validates and queues events (one or a list). Never waits, never throws. Returns how many were accepted. */
  function report(events) {
    try {
      const ok = validOnes(events);
      if (!ok.length) return 0;
      waiting.push(...ok);
      drainWaiting();
      return ok.length;
    } catch (e) {
      noteOnce("queue", `Status server: could not queue a report (${e.message}). Payouts are not affected.`);
      return 0;
    }
  }

  /**
   * Queues the events the saved records describe since `sinceMs` that the server hasn't confirmed with the same or a
   * later status, and that aren't queued already. records: { requests, registrations, ntagPayments, receipts }.
   */
  function syncRecords(records = {}, { agent = AGENT_ADDRESS, sinceMs = now() - RECENT_MS } = {}) {
    try {
      const sent = box.readSent();
      const queued = new Set([...box.readQueue().events, ...waiting].map((e) => `${e.id}|${e.status}`));
      const fresh = eventsFromRecords({ ...records, agent, sinceMs })
        .filter((e) => rankOf(sent[e.id]) < rankOf(e.status) && !queued.has(`${e.id}|${e.status}`));
      return fresh.length ? report(fresh) : 0;
    } catch { return 0; }
  }

  /** Records whether the server answered, for health(): when the current streak of failures started. */
  function noteHealth(r) {
    if (r.ok) failingSince = null;
    else if (r.status === 0 || r.status >= 500 || r.status === 401) failingSince ??= now();
  }

  const post = (events) => postBody((ts) => ({ v: STATUS_VERSION, ts, events }));

  /** Signs and POSTs make(ts). Resolves { status, ok, rejected, error? }; never rejects. */
  async function postBody(make, ms = timeoutMs) {
    const r = await postRaw(make, ms);
    noteHealth(r);
    return r;
  }

  async function postRaw(make, ms) {
    const ts = Math.floor(now() / 1000);
    const body = JSON.stringify(make(ts));
    const c = typeof AbortController === "function" ? new AbortController() : null;
    const t = setTimer(() => c?.abort(), ms);
    t?.unref?.();
    try {
      const r = await fetchImpl(url, {
        method: "POST", body, signal: c?.signal, redirect: "error",
        headers: { "content-type": "application/json", "x-np-ts": String(ts), "x-np-signature": signReport(secret, ts, body) },
      });
      let j = null;
      try { j = await r.json(); } catch { j = null; }
      // only an explicit, well-formed yes counts: a redirect, a proxy page or an odd 200 is a failure
      const ok = r.status === 200 && j?.ok === true && Number.isFinite(j?.stored);
      return { status: r.status, ok, rejected: ok && Array.isArray(j.rejected) ? j.rejected.map(String) : [], error: r.status === 200 && !ok ? "unexpected answer" : undefined };
    } catch (e) {
      return { status: 0, ok: false, error: e?.name === "AbortError" ? "timed out" : (e?.cause?.code ?? e?.message ?? "network error") };
    } finally {
      clearTimer(t);
    }
  }

  /** The next batch: at most `limit` events and under the body limit. */
  function nextBatch(queue, limit) {
    const batch = [];
    let size = 64;
    for (const e of queue) {
      const n = JSON.stringify(e).length + 1;
      if (batch.length >= limit || (batch.length && size + n > BATCH_BYTES)) break;
      batch.push(e);
      size += n;
    }
    return batch;
  }

  const why = (r) => (r.error ? r.error : r.status === 401 ? "the server did not accept the signature: check that NP_STATUS_SECRET matches the site's and that this PC's clock is right"
    : r.status === 503 ? "the status server is unavailable" : `HTTP ${r.status}`);

  /** Removes `batch` from the queue and records `accepted` as sent, under the lock. False when that couldn't be done. */
  async function settle(batch, accepted) {
    const r = await withLock(() => {
      const done = new Map();
      for (const e of batch) done.set(evKey(e), (done.get(evKey(e)) ?? 0) + 1);
      const keep = box.readQueue().events.filter((e) => {
        const n = done.get(evKey(e));
        if (n) { done.set(evKey(e), n - 1); return false; }
        return true;
      });
      box.rewriteQueue(keep.slice(-OUTBOX_MAX));
      if (accepted.length) {
        const sent = box.readSent();
        for (const e of accepted) if (rankOf(e.status) >= rankOf(sent[e.id])) { delete sent[e.id]; sent[e.id] = e.status; }
        box.writeSent(sent);
      }
      return true;
    });
    return r.value === true;
  }

  /** Sends everything queued, batch by batch. Resolves { sent, left, error? }. Never rejects. */
  function flush() {
    if (inflight) return inflight;
    inflight = (async () => {
      let sent = 0;
      let limit = MAX_EVENTS;
      const fail = (r, left) => {
        failures++;
        if (!failNoted) {
          failNoted = true;
          safeSay(`Status server: couldn't send ${left} report(s) (${why(r)}). Payouts are not affected; retrying in the background.`);
        }
        schedule(Math.min(BACKOFF_MIN_MS * 2 ** Math.min(failures - 1, 10), BACKOFF_MAX_MS));
        return { sent, left, error: why(r) };
      };
      try {
        drainWaiting();
        for (;;) {
          const { events: queue } = box.readQueue();
          if (!queue.length) break;
          const batch = nextBatch(queue, limit);
          const r = await post(batch);
          if (r.ok) {
            const rejected = new Set(r.rejected);
            const accepted = batch.filter((e, i) => !rejected.has(lc(e.id)) && !rejected.has(`#${i}`));
            if (accepted.length < batch.length) {
              noteOnce("rejected", `Status server: it rejected ${batch.length - accepted.length} report(s); they were dropped, the rest were stored. Payouts are not affected.`);
            }
            if (!(await settle(batch, accepted))) return fail({ error: "the outbox is busy or can't be written" }, queue.length);
            sent += accepted.length;
            continue;
          }
          if (r.status === 400 || r.status === 413) {
            // an older server rejects the whole batch for one bad event: halve until the bad ones are alone, drop only those
            if (batch.length > 1) { limit = Math.ceil(batch.length / 2); continue; }
            noteOnce(`dropped:${r.status}`, `Status server: it rejected a report (HTTP ${r.status}); that one was dropped. Payouts are not affected.`);
            if (!(await settle(batch, []))) return fail({ error: "the outbox is busy or can't be written" }, queue.length);
            continue;
          }
          return fail(r, queue.length);
        }
        if (failNoted) safeSay("Status server: reporting again; everything queued was sent.");
        failures = 0;
        failNoted = false;
        return { sent, left: 0 };
      } catch (e) {
        noteOnce("flush", `Status server: sending failed (${e.message}). Payouts are not affected.`);
        return { sent, left: -1, error: e.message };
      }
    })().finally(() => { inflight = null; });
    return inflight;
  }

  /** Sends events now (one or more batches); anything not accepted is queued for later. Resolves { sent, queued }. */
  async function sendNow(events) {
    try {
      const ok = validOnes(events);
      let sent = 0, queued = 0;
      for (let i = 0; i < ok.length; i += MAX_EVENTS) {
        const batch = ok.slice(i, i + MAX_EVENTS);
        const r = await post(batch);
        if (r.ok) {
          const rejected = new Set(r.rejected);
          const accepted = batch.filter((e, j) => !rejected.has(lc(e.id)) && !rejected.has(`#${j}`));
          sent += accepted.length;
          await withLock(() => {
            const s = box.readSent();
            for (const e of accepted) if (rankOf(e.status) >= rankOf(s[e.id])) { delete s[e.id]; s[e.id] = e.status; }
            box.writeSent(s);
          }, 1_000);
        } else {
          queued += report(batch);
        }
      }
      return { sent, queued };
    } catch { return { sent: 0, queued: 0 }; }
  }

  /** A signed request with no events: checks the secret, clock and URL without storing anything. */
  async function ping() {
    const r = await post([]);
    return r.ok ? { ok: true } : { ok: false, error: why(r) };
  }

  /**
   * Sends one signed heartbeat (autopilot is alive) straight away; heartbeats are never queued (an old one is useless).
   * hb: { at, cursorBlock, chainHead, lagBlocks, celoBalance, lowGas, version, autoRefund }. Resolves { ok, error? };
   * never rejects. An older server that doesn't know heartbeats answers 400: noted once.
   */
  async function heartbeat(hb) {
    try {
      if (stopped) return { ok: false, error: "stopped" };
      const ts = Math.floor(now() / 1000);
      const v = validateHeartbeat({ v: STATUS_VERSION, ts, heartbeat: hb }, ts);
      if (v.error) { noteOnce(`hb:${v.error}`, `Status server: a heartbeat was not sent (${v.error}).`); return { ok: false, error: v.error }; }
      const r = await postBody(() => ({ v: STATUS_VERSION, ts, heartbeat: v.heartbeat }), Math.min(timeoutMs, 5_000));
      if (r.ok) return { ok: true };
      if (r.status === 400) noteOnce("hb:400", "Status server: it does not accept heartbeats yet (deploy the latest site). Payouts are not affected.");
      return { ok: false, error: why(r) };
    } catch (e) {
      return { ok: false, error: e?.message ?? "heartbeat failed" };
    }
  }

  /** { failingSince: ms | null }: since when the status server has not answered (network, 5xx or a bad signature). */
  const health = () => ({ failingSince });

  /** Stops the timers and gives waiting / queued reports one last chance (at most `waitMs`). */
  async function close({ waitMs = 5_000 } = {}) {
    stopped = true;
    if (timer) { clearTimer(timer); timer = null; }
    if (appendTimer) { clearTimer(appendTimer); appendTimer = null; }
    try {
      const until = Date.now() + waitMs;
      while (waiting.length && Date.now() < until && !drainWaiting()) await sleep(50);
      if (!box.readQueue().events.length || waitMs <= 0) return;
      let t;
      await Promise.race([flush(), new Promise((res) => { t = setTimer(res, Math.max(0, until - Date.now())); t?.unref?.(); })]);
      clearTimer(t);
    } catch { /* never */ }
  }

  return {
    enabled: true, report, syncRecords, sendNow, flush, ping, close, heartbeat, health,
    pending: () => { try { return box.readQueue().events.length + waiting.length; } catch { return 0; } },
  };
}

/**
 * The reporter autopilot and the CLI use: on when a secret is set up, off (one info line) when not. Off under the test
 * runner unless a test passes its own pieces, so tests never write the real outbox or call the real site.
 */
export function makeStatusReporter({ say = () => {}, env = process.env, url = STATUS_URL, quiet = false, ...rest } = {}) {
  try {
    if (env.NODE_TEST_CONTEXT && !rest.outboxFile) return DISABLED;
    if (!statusUrlOk(url + "/")) {
      if (!quiet) say(`Status server: reporting is off (STATUS_URL must start with https://). The site estimates payout status from Celo.`);
      return DISABLED;
    }
    const s = readStatusSecret({ env, ...(rest.secretFile ? { file: rest.secretFile } : {}) });
    if (!s.secret) {
      if (!quiet) say(`Status server: reporting is off (${s.reason}). The site estimates payout status from Celo.`);
      return DISABLED;
    }
    const { secretFile, ...opts } = rest;
    return createStatusReporter({ secret: s.secret, url, say, ...opts });
  } catch {
    return DISABLED;
  }
}
