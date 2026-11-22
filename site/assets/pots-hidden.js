// "Delete pot" on the dashboard. LokalPots has no onchain delete (only closePot), so deleting a pot hides it from
// this browser's "Your pots" list, per wallet, and an open pot is closed first. Pure (no DOM), tested in Node
// (test/pots-delete.test.mjs). The list itself is drawn in site/js/app.js.
//
// Stored in localStorage under "np-pots-hidden" as { "<address, lowercase>": [potId, ...] }. Only pot ids (public
// numbers) are kept, never a title, an amount or anyone else's address. If storage is blocked or full, an in-memory
// copy keeps the choice for this page, and the pots come back on the next visit.

export const HIDDEN_KEY = "np-pots-hidden";
/** At most this many pots per wallet and this many wallets (the newest choices are kept). */
export const MAX_HIDDEN_PER_WALLET = 200;
export const MAX_HIDDEN_WALLETS = 20;

const ADDR = /^0x[0-9a-f]{40}$/;
const lc = (s) => String(s ?? "").toLowerCase();
/** A pot id as a decimal string ("7"), or null when it isn't one. Accepts numbers, bigints and strings. */
export function potIdKey(id) {
  if (typeof id === "bigint") return id >= 0n ? id.toString() : null;
  if (typeof id === "number") return Number.isSafeInteger(id) && id >= 0 ? String(id) : null;
  if (typeof id === "string" && /^\d{1,30}$/.test(id.trim())) return BigInt(id.trim()).toString();
  return null;
}
/** Stored as a JSON number when it fits exactly, otherwise as a string. */
const stored = (key) => (Number.isSafeInteger(Number(key)) ? Number(key) : key);

const memory = new Map(); // address -> Set of id strings, this page's copy (the only copy when storage is blocked)
/** Forgets the in-memory copy (tests, and a fresh page). */
export const clearHiddenMemory = () => memory.clear();

/** The whole stored map, cleaned: { address: [ids] }, or {} when storage is blocked, empty or malformed. */
function readMap(storage) {
  try {
    const v = JSON.parse(storage?.getItem(HIDDEN_KEY) ?? "null");
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out = {};
    for (const [k, ids] of Object.entries(v)) {
      if (!ADDR.test(k) || !Array.isArray(ids)) continue;
      out[k] = [...new Set(ids.map(potIdKey).filter(Boolean))];
    }
    return out;
  } catch { return {}; }
}

/** The pot ids this wallet hid, as a Set of decimal strings. Never throws. */
export function readHidden(storage, address) {
  const key = lc(address);
  if (!ADDR.test(key)) return new Set();
  if (memory.has(key)) return new Set(memory.get(key));
  const ids = new Set(readMap(storage)[key] ?? []);
  memory.set(key, ids);
  return new Set(ids);
}

/** Saves the wallet's set (memory first, then storage if it can). Returns true when storage took it. */
function writeHidden(storage, address, ids) {
  const key = lc(address);
  const list = [...ids].slice(-MAX_HIDDEN_PER_WALLET);
  memory.set(key, new Set(list));
  try {
    const map = readMap(storage);
    delete map[key];
    if (list.length) map[key] = list; // the wallet just changed goes last (newest); the oldest drop off past the limit
    const kept = Object.entries(map).slice(-MAX_HIDDEN_WALLETS).map(([k, v]) => [k, v.map(stored)]);
    if (kept.length) storage.setItem(HIDDEN_KEY, JSON.stringify(Object.fromEntries(kept)));
    else storage.removeItem(HIDDEN_KEY);
    return true;
  } catch { return false; /* blocked or full: the in-memory copy covers this page */ }
}

/** Hides a pot for this wallet. Returns { ok, saved } (saved: false when only this page remembers it). */
export function hidePot(storage, address, potId) {
  const id = potIdKey(potId);
  if (!id || !ADDR.test(lc(address))) return { ok: false, saved: false };
  const ids = readHidden(storage, address);
  ids.delete(id);
  ids.add(id);
  return { ok: true, saved: writeHidden(storage, address, ids) };
}
/** Shows a hidden pot again. Returns { ok, saved }. */
export function restorePot(storage, address, potId) {
  const id = potIdKey(potId);
  if (!id || !ADDR.test(lc(address))) return { ok: false, saved: false };
  const ids = readHidden(storage, address);
  ids.delete(id);
  return { ok: true, saved: writeHidden(storage, address, ids) };
}
/**
 * Splits pots ({ potId, ... }) into the ones the list shows and the ones this wallet hid, keeping their order.
 * stateOf(pot), when given, is the pot's state now: a pot that still takes sprays ("open" | "full") is always shown,
 * whatever storage says, so an open pot can never be hidden without a confirmed close.
 */
export function splitHidden(pots = [], hidden = new Set(), stateOf = null) {
  const shown = [], gone = [];
  for (const p of pots) {
    const live = stateOf ? !["closed", "ended"].includes(stateOf(p)) : false;
    (hidden.has(potIdKey(p.potId)) && !live ? gone : shown).push(p);
  }
  return { shown, hidden: gone };
}

/**
 * What "delete" means for a pot in this state (potState: "open" | "full" | "closed" | "ended"):
 *   "delete"       closed or ended: hide it, no transaction;
 *   "close-delete" open or full, and the signed-in wallet is its host: close it onchain first, then hide it;
 *   null           open or full but not this wallet's to close (or an unknown state): no delete at all.
 */
export function deleteAction(state, canClose) {
  if (state === "closed" || state === "ended") return "delete";
  if ((state === "open" || state === "full") && canClose === true) return "close-delete";
  return null;
}
/** Only "delete" may hide a pot straight away; "close-delete" hides it only after closePot is confirmed on Celo. */
export const hidesWithoutTransaction = (action) => action === "delete";

/** The confirm dialog's words. title: the pot's title; action: from deleteAction. */
export function deleteConfirmCopy(title, action) {
  const name = String(title ?? "").trim() || "this pot";
  const open = action === "close-delete";
  return {
    heading: `Delete '${name}'?`,
    body: [
      "It disappears from your dashboard. Money already sprayed is paid out to you as usual, and the pot's history stays on Celo, like every payment.",
      open ? "It will be closed first, so no one can spray into it." : null,
    ].filter(Boolean),
    note: open
      ? "Closing is one transaction from your wallet, checked before your wallet opens, and it can't be undone. Deleting only hides the pot in this browser: you can restore it under “Show deleted pots”."
      : "No transaction. It's only hidden in this browser: you can restore it under “Show deleted pots”.",
    confirm: open ? "Close & delete" : "Delete",
    cancel: "Keep it",
  };
}
/** The link under the list: "Show deleted pots (2)" / "Hide deleted pots (2)". */
export const deletedToggleText = (n, open) => `${open ? "Hide" : "Show"} deleted pots (${n})`;
