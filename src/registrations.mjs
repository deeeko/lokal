// "Get paid": a recipient registers their own payment request onchain, from their own wallet (site/get-paid.html).
// A registration is a zero-value tx FROM the recipient TO the agent whose input is hex(utf8("NP1:" + JSON)) + tag.
// JSON { a: "5.03", d: "usdt-cngn"|"usdt-idrx"|"usdt-wars"|"usdt-wcop"|"cngn-usdt", e: <expiry unix seconds>, n: <name 1-40>,
// m?: <note <=80> }. d = the corridor: usdt-<currency> is what the recipient receives (naira, rupiah, pesos), USD₮ in.
// The recipient is the tx sender (proven by its signature). Request id = the registration tx hash.
//
// registrationError / decodeRegistration / registrationStatuses are ports of site/assets/core.js and MUST stay
// identical to it (test/registrations.test.mjs cross-checks them). The site and the agent then agree on which
// registration is "active" for an amount, so a payer is never shown one recipient while the agent pays another.
import fs from "node:fs";
import path from "node:path";
import { getAddress, parseUnits } from "viem";
import { CORRIDORS, EXPLORER_API, REGISTRATIONS_STATE_FILE, SITE_URL } from "./config.mjs";
import { getCorridor, refusal } from "./guards.mjs";

export const REG_PREFIX = "NP1:";
export const MAX_REG_HOURS = 168;
const MARKER = "80218021802180218021802180218021"; // ERC-8021 suffix marker
const utf8Hex = (s) => [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, "0")).join("");
const hexBytes = (h) => new Uint8Array((h.match(/../g) ?? []).map((b) => parseInt(b, 16)));

// ---------- ported from site/assets/core.js (keep byte-for-byte equivalent) ----------

/** Validate the JSON body. `blockTimeSec` = registration block time (for the expiry window). Returns an error string or null. */
export function registrationError(r, blockTimeSec) {
  if (!r || typeof r !== "object") return "not a registration";
  const corridor = typeof r.d === "string" && Object.prototype.hasOwnProperty.call(CORRIDORS, r.d) ? CORRIDORS[r.d] : null;
  if (!corridor) return "unknown corridor";
  if (typeof r.a !== "string" || !/^\d+(\.\d{1,2})?$/.test(r.a) || Number(r.a) <= 0) return "invalid amount";
  if (corridor.sell === "USDT" && (Number(r.a) < 1 || Number(r.a) > 24.99)) return "amount must be $1 to $24.99";
  if (typeof r.n !== "string" || !r.n.trim() || r.n.length > 40) return "invalid name";
  if (r.m != null && (typeof r.m !== "string" || r.m.length > 80)) return "invalid note";
  if (!Number.isInteger(r.e)) return "invalid expiry";
  if (blockTimeSec != null && (r.e <= blockTimeSec || r.e > blockTimeSec + MAX_REG_HOURS * 3600)) return "expiry must be 1 to 168 hours after registration";
  return null;
}

/** Parse a registration tx input (any trailing ERC-8021 tag is stripped first). Returns the JSON body or null. */
export function decodeRegistration(input) {
  let h = String(input ?? "").toLowerCase().replace(/^0x/, "");
  if (h.endsWith(MARKER)) {
    const len = parseInt(h.slice(-MARKER.length - 4, -MARKER.length - 2), 16);
    h = h.slice(0, -(MARKER.length + 4 + len * 2));
  }
  if (!h.startsWith(utf8Hex(REG_PREFIX))) return null;
  try { return JSON.parse(new TextDecoder().decode(hexBytes(h.slice(utf8Hex(REG_PREFIX).length)))); } catch { return null; }
}

/**
 * The same-amount rule: among VALID, UNEXPIRED registrations paid in the same token (USD₮ for every usdt-* link) with the same exact amount, the
 * earliest (block, then position) is active; later ones are "amount in use" and are never paid.
 * Items: { hash, from, block, position, time (sec), req }. Returns Map hash -> "active" | "in-use" | "expired" | "invalid".
 */
export function registrationStatuses(regs, nowSec) {
  const out = new Map();
  const live = [];
  for (const r of regs) {
    if (registrationError(r.req, r.time)) out.set(r.hash, "invalid");
    else if (r.req.e <= nowSec) out.set(r.hash, "expired");
    else live.push(r);
  }
  live.sort((x, y) => x.block - y.block || x.position - y.position);
  const taken = new Set();
  for (const r of live) {
    // keyed by the token the payer sends: every usdt-<currency> link is paid in USD₮, so a USD₮ amount can only be in use once
    const key = CORRIDORS[r.req.d].sell + ":" + Number(r.req.a).toFixed(2);
    out.set(r.hash, taken.has(key) ? "in-use" : "active");
    taken.add(key);
  }
  return out;
}

/** Turns one Blockscout transaction item into a registration item, or null (same filter as core.js loadRegistrations). */
export function registrationFromItem(t, agent) {
  if (t?.status !== "ok" || t.to?.hash?.toLowerCase() !== String(agent).toLowerCase()) return null;
  const req = decodeRegistration(t.raw_input);
  if (!req) return null;
  return { hash: t.hash, from: t.from?.hash, block: Number(t.block_number ?? t.block), position: Number(t.position ?? 0), time: Math.floor(Date.parse(t.timestamp) / 1000), req };
}

// ---------- discovery (Blockscout) ----------

async function getJson(url, fetchImpl = fetch, attempt = 0) {
  try {
    const r = await fetchImpl(url, { signal: AbortSignal.timeout(15_000), headers: { accept: "application/json" } });
    if (r.status === 429 || r.status >= 500) throw Object.assign(new Error(`Blockscout HTTP ${r.status}`), { retry: true });
    if (!r.ok) throw new Error(`Blockscout HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    if (attempt === 0 && (e.retry || e.name === "TypeError" || e.name === "TimeoutError" || e.name === "AbortError")) {
      await new Promise((res) => setTimeout(res, 1000));
      return getJson(url, fetchImpl, 1);
    }
    throw e;
  }
}

/**
 * Every registration sent to `agent`, oldest first. Paginates Blockscout /addresses/<agent>/transactions?filter=to
 * (newest first) until there are no more pages, a page reaches back before `sinceSec`, or `maxPages` (then it throws,
 * so a partial list is never mistaken for the whole one). Failed transactions are ignored.
 */
export async function discoverRegistrations({ agent, sinceSec = 0, maxPages = 100, api = EXPLORER_API, fetchImpl = fetch } = {}) {
  const regs = [];
  let next = null;
  for (let p = 0; p < maxPages; p++) {
    const qs = new URLSearchParams({ filter: "to", ...(next ?? {}) });
    const d = await getJson(`${api}/addresses/${agent}/transactions?${qs}`, fetchImpl);
    if (!Array.isArray(d?.items)) throw new Error("Unexpected Blockscout response (no items)");
    let older = false;
    for (const t of d.items) {
      if (Date.parse(t.timestamp) / 1000 < sinceSec) older = true;
      const r = registrationFromItem(t, agent);
      if (r) regs.push(r);
    }
    next = d.next_page_params ?? null;
    if (!next || older) return regs.sort((x, y) => x.block - y.block || x.position - y.position);
  }
  throw new Error(`More than ${maxPages} pages of transactions to the agent; refusing to work from a partial registration list.`);
}

/** Highest block Blockscout has indexed. Autopilot never scans deposits past it, so a registration it has not seen yet can't be missed. */
export async function indexedHeight({ api = EXPLORER_API, fetchImpl = fetch } = {}) {
  const d = await getJson(`${api}/main-page/blocks`, fetchImpl);
  const h = Math.max(...(Array.isArray(d) ? d : []).map((b) => Number(b.height)).filter(Number.isFinite));
  if (!Number.isFinite(h) || h <= 0) throw new Error("Blockscout returned no indexed block height");
  return BigInt(h);
}

// ---------- matching ----------

/**
 * The registration a deposit pays. dep = { token, value (bigint, base units), timeMs }. `state` = registrations-state
 * records by lower-case hash. Statuses are computed at the deposit's own block time, so the answer does not depend on
 * when autopilot runs. A match needs: status "active", token == the corridor's SELL token, value == the exact amount,
 * registration time <= deposit time < expiry. Returns { reg, used } (used = that registration already has a deposit
 * recorded or was paid: one payout per registration) or null.
 */
export function matchRegistration(dep, regs, state = {}) {
  const depSec = Math.floor(Number(dep.timeMs) / 1000);
  const st = registrationStatuses(regs, depSec);
  const hit = regs.find((r) => {
    if (st.get(r.hash) !== "active") return false;
    let c;
    try { c = getCorridor(r.req.d); } catch { return false; }
    if (c.id !== r.req.d) return false;
    if (c.sellToken.address.toLowerCase() !== String(dep.token).toLowerCase()) return false;
    if (parseUnits(r.req.a, 6) !== BigInt(dep.value)) return false;
    return depSec >= r.time && depSec < r.req.e;
  });
  if (!hit) return null;
  const rec = state[String(hit.hash).toLowerCase()];
  return { reg: hit, used: !!(rec?.deposit || rec?.paidAt) };
}

/** Status for the `registrations` list: paid | received (deposit recorded, payout not done) | active | in-use | expired | invalid. */
export function listStatus(reg, statuses, rec) {
  if (rec?.paidAt) return "paid";
  if (rec?.deposit) return "received";
  return statuses.get(reg.hash) ?? "invalid";
}

/**
 * Re-reads a registration from the chain (RPC, not Blockscout) right before it is relied on for a payout: it must be a
 * successful tx to the agent from the same sender, with the same decoded body, block, position and block time, and
 * still valid. Any mismatch is a permanent refusal. Returns { from (checksummed), time }.
 */
export async function verifyRegistrationOnchain(pub, reg, agent) {
  const [tx, rc] = await Promise.all([pub.getTransaction({ hash: reg.hash }), pub.getTransactionReceipt({ hash: reg.hash })]);
  const bad = (why) => refusal(`Registration ${reg.hash} does not check out onchain (${why}). Not paid.`);
  if (rc.status !== "success") throw bad("failed transaction");
  if (String(tx.to ?? "").toLowerCase() !== String(agent).toLowerCase()) throw bad("not sent to the agent");
  if (String(tx.from).toLowerCase() !== String(reg.from ?? "").toLowerCase()) throw bad("different sender");
  if (Number(tx.blockNumber) !== reg.block || Number(tx.transactionIndex) !== reg.position) throw bad("different block or position");
  const req = decodeRegistration(tx.input);
  if (JSON.stringify(req) !== JSON.stringify(reg.req)) throw bad("different content");
  const time = Number((await pub.getBlock({ blockNumber: tx.blockNumber })).timestamp);
  if (time !== reg.time) throw bad("different block time");
  const err = registrationError(req, time);
  if (err) throw bad(err);
  return { from: getAddress(tx.from), time };
}

/** Pseudo-requests ({ created, exp } in ms) for the unexpired, valid registrations: lets watch's first scan reach back far enough. */
export const registrationWindows = (regs) => regs.filter((r) => !registrationError(r.req, r.time)).map((r) => ({ created: r.time * 1000, exp: r.req.e * 1000 }));

export const registrationLink = (hash) => `${SITE_URL}/pay.html#tx=${hash}`;

// ---------- local state (git-ignored) ----------

/** { [lower-case registration hash]: { id, hash, from, name, amount, dir, exp, deposit?, paidAt?, hashes?, receiptNo?, ... } } */
export function loadRegState(file = REGISTRATIONS_STATE_FILE) {
  if (!fs.existsSync(file)) return {};
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  return j && typeof j.registrations === "object" && !Array.isArray(j.registrations) ? j.registrations : {};
}

/** Atomic write (tmp + rename). */
export function saveRegState(state, file = REGISTRATIONS_STATE_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ registrations: state }, null, 2) + "\n");
  fs.renameSync(tmp, file);
}
