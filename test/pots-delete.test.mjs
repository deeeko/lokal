// "Delete pot" on the dashboard (site/assets/pots-hidden.js): which pots get Delete or Close & delete, the hidden set
// per wallet in localStorage ("np-pots-hidden"), what happens when storage fails, the confirm copy, and the wiring in
// site/js/app.js (an open pot is hidden only after closePot is confirmed). No network, no DOM.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as H from "../site/assets/pots-hidden.js";
import { canClosePot } from "../site/assets/front-door.js";
import { potState } from "../site/assets/pots.js";

const HOST = "0x2222222222222222222222222222222222222222";
const OTHER = "0x4444444444444444444444444444444444444444";
const NOW = 1_795_000_000;

/** A localStorage stand-in; `fail` makes getItem/setItem throw (blocked) or setItem throw (full). */
function memStore({ fail = null, init = {} } = {}) {
  const m = new Map(Object.entries(init));
  return {
    m,
    getItem(k) { if (fail === "blocked") throw new Error("SecurityError"); return m.has(k) ? m.get(k) : null; },
    setItem(k, v) { if (fail) throw new Error(fail === "full" ? "QuotaExceededError" : "SecurityError"); m.set(k, String(v)); },
    removeItem(k) { if (fail) throw new Error("SecurityError"); m.delete(k); },
  };
}
const raw = (st) => JSON.parse(st.m.get(H.HIDDEN_KEY));

test("deleteAction: closed and ended pots get Delete; open and full get Close & delete only for the host", () => {
  assert.equal(H.deleteAction("closed", false), "delete");
  assert.equal(H.deleteAction("ended", true), "delete");
  assert.equal(H.deleteAction("open", true), "close-delete");
  assert.equal(H.deleteAction("full", true), "close-delete");
  for (const st of ["open", "full"]) {
    assert.equal(H.deleteAction(st, false), null, `${st}: a non-host gets nothing`);
    assert.equal(H.deleteAction(st, undefined), null);
    assert.equal(H.deleteAction(st, "yes"), null, "only a real true counts");
  }
  assert.equal(H.deleteAction(null, true), null);
  assert.equal(H.deleteAction("weird", true), null);
  assert.equal(H.hidesWithoutTransaction("delete"), true);
  assert.equal(H.hidesWithoutTransaction("close-delete"), false);
});

test("deleteAction with canClosePot: a signed-in non-host can never close, a signed-out visitor neither", () => {
  const pot = { host: HOST, open: true, closesAt: NOW + 3600, totalUsd6: 0n, capUsd6: 100_000_000n };
  const st = potState(pot, NOW);
  assert.equal(st, "open");
  assert.equal(H.deleteAction(st, canClosePot({ address: HOST.toUpperCase().replace("0X", "0x") }, pot)), "close-delete");
  assert.equal(H.deleteAction(st, canClosePot({ address: OTHER }, pot)), null);
  assert.equal(H.deleteAction(st, canClosePot(null, pot)), null);
  assert.equal(H.deleteAction(st, canClosePot({ address: "nope" }, pot)), null);
});

test("hide and restore: per wallet, lowercase keys, ids as numbers, survives a reload (fresh memory)", () => {
  H.clearHiddenMemory();
  const st = memStore();
  assert.deepEqual([...H.readHidden(st, HOST)], []);
  assert.deepEqual(H.hidePot(st, HOST.toUpperCase().replace("0X", "0x"), 3n), { ok: true, saved: true });
  H.hidePot(st, HOST, 7);
  H.hidePot(st, HOST, "7"); // twice is once
  H.hidePot(st, OTHER, 9n);
  assert.deepEqual(raw(st), { [HOST]: [3, 7], [OTHER]: [9] });
  assert.deepEqual([...H.readHidden(st, HOST)].sort(), ["3", "7"]);
  assert.deepEqual([...H.readHidden(st, OTHER)], ["9"], "another wallet sees only its own");
  // a reload: memory gone, storage remembers
  H.clearHiddenMemory();
  assert.deepEqual([...H.readHidden(st, HOST)].sort(), ["3", "7"]);
  assert.deepEqual(H.restorePot(st, HOST, 3n), { ok: true, saved: true });
  H.clearHiddenMemory();
  assert.deepEqual([...H.readHidden(st, HOST)], ["7"]);
  H.restorePot(st, HOST, 7n);
  assert.deepEqual(raw(st), { [OTHER]: [9] }, "an empty wallet entry is dropped");
  H.restorePot(st, OTHER, 9n);
  assert.equal(st.m.has(H.HIDDEN_KEY), false, "nothing left: the key is removed");
});

test("bad input is ignored: bad addresses, bad ids, malformed or foreign stored values", () => {
  H.clearHiddenMemory();
  const st = memStore({ init: { [H.HIDDEN_KEY]: JSON.stringify({ [HOST]: [1, "2", "x", -4, 1.5, null], nope: [5], [OTHER]: "7" }) } });
  assert.deepEqual([...H.readHidden(st, HOST)].sort(), ["1", "2"]);
  assert.deepEqual([...H.readHidden(st, OTHER)], []);
  assert.deepEqual(H.hidePot(st, "nope", 1n), { ok: false, saved: false });
  assert.deepEqual(H.hidePot(st, HOST, -1), { ok: false, saved: false });
  assert.deepEqual(H.hidePot(st, HOST, "abc"), { ok: false, saved: false });
  for (const junk of ["{", "[1,2]", "null", "42"]) {
    H.clearHiddenMemory();
    assert.deepEqual([...H.readHidden(memStore({ init: { [H.HIDDEN_KEY]: junk } }), HOST)], [], junk);
  }
  H.clearHiddenMemory();
  assert.deepEqual([...H.readHidden(null, HOST)], [], "no storage at all");
  assert.equal(H.potIdKey(12345678901234567890n), "12345678901234567890");
  assert.equal(H.potIdKey(" 007 "), "7");
});

test("storage blocked or full: the choice holds for this page (memory), is reported unsaved, and nothing throws", () => {
  for (const fail of ["blocked", "full"]) {
    H.clearHiddenMemory();
    const st = memStore({ fail });
    assert.deepEqual(H.hidePot(st, HOST, 3n), { ok: true, saved: false }, fail);
    assert.deepEqual([...H.readHidden(st, HOST)], ["3"], `${fail}: still hidden on this page`);
    assert.deepEqual(H.restorePot(st, HOST, 3n), { ok: true, saved: false });
    assert.deepEqual([...H.readHidden(st, HOST)], []);
    H.hidePot(st, HOST, 4n);
    H.clearHiddenMemory(); // a reload with storage still failing: the pot is back, never an error
    assert.deepEqual([...H.readHidden(st, HOST)], [], `${fail}: back after a reload`);
  }
  H.clearHiddenMemory();
  assert.deepEqual(H.hidePot(null, HOST, 3n), { ok: true, saved: false });
});

test("limits: the newest wallets and ids are kept", () => {
  H.clearHiddenMemory();
  const st = memStore();
  for (let i = 0; i < H.MAX_HIDDEN_PER_WALLET + 5; i++) H.hidePot(st, HOST, i);
  const ids = raw(st)[HOST];
  assert.equal(ids.length, H.MAX_HIDDEN_PER_WALLET);
  assert.equal(ids.at(-1), H.MAX_HIDDEN_PER_WALLET + 4);
  assert.equal(ids[0], 5);
  H.clearHiddenMemory();
  const st2 = memStore();
  const addr = (i) => "0x" + i.toString(16).padStart(40, "0");
  for (let i = 1; i <= H.MAX_HIDDEN_WALLETS + 3; i++) H.hidePot(st2, addr(i), 1n);
  const keys = Object.keys(raw(st2));
  assert.equal(keys.length, H.MAX_HIDDEN_WALLETS);
  assert.equal(keys.includes(addr(1)), false);
  assert.equal(keys.at(-1), addr(H.MAX_HIDDEN_WALLETS + 3));
});

test("splitHidden keeps order, and never hides a pot that is still open or full", () => {
  const pots = [{ potId: 9n, s: "open" }, { potId: 7n, s: "closed" }, { potId: 5n, s: "ended" }, { potId: 3n, s: "full" }];
  const hidden = new Set(["9", "7", "5", "3"]);
  const r = H.splitHidden(pots, hidden, (p) => p.s);
  assert.deepEqual(r.shown.map((p) => p.potId), [9n, 3n], "open and full stay listed whatever storage says");
  assert.deepEqual(r.hidden.map((p) => p.potId), [7n, 5n]);
  const ids = H.splitHidden(pots, new Set(["7"]));
  assert.deepEqual(ids.hidden.map((p) => p.potId), [7n]);
  assert.deepEqual(ids.shown.map((p) => p.potId), [9n, 5n, 3n]);
});

test("confirm copy: the title, the honest body, and the open-pot line only for Close & delete", () => {
  const closed = H.deleteConfirmCopy("Bisi's 30th", "delete");
  assert.equal(closed.heading, "Delete 'Bisi's 30th'?");
  assert.equal(closed.body.length, 1);
  assert.match(closed.body[0], /^It disappears from your dashboard\. /);
  assert.match(closed.body[0], /the pot's history stays on Celo, like every payment\.$/);
  assert.match(closed.note, /No transaction/);
  assert.match(closed.note, /only hidden in this browser/);
  assert.equal(closed.confirm, "Delete");
  const open = H.deleteConfirmCopy("  Ada & Tunde's wedding ", "close-delete");
  assert.equal(open.heading, "Delete 'Ada & Tunde's wedding'?");
  assert.equal(open.body[1], "It will be closed first, so no one can spray into it.");
  assert.match(open.note, /one transaction from your wallet/);
  assert.equal(open.confirm, "Close & delete");
  assert.equal(H.deleteConfirmCopy("", "delete").heading, "Delete 'this pot'?");
  for (const c of [closed, open]) assert.doesNotMatch(c.body.join(" ") + c.note, /refund|erase|removed from Celo|gone forever/i, "never promises what can't happen");
  assert.equal(H.deletedToggleText(2, false), "Show deleted pots (2)");
  assert.equal(H.deletedToggleText(1, true), "Hide deleted pots (1)");
});

test("wiring: app.js hides an open pot only after closePot is confirmed, and the dialog handles Esc and focus", () => {
  const app = fs.readFileSync(new URL("../site/js/app.js", import.meta.url), "utf8");
  const fn = app.slice(app.indexOf("function deleteButton("), app.indexOf("function deletedRow("));
  assert.ok(fn.length > 200, "deleteButton exists");
  const send = fn.indexOf("await sendCall(LOKAL_POTS, s.address, closePotData(p.potId)");
  const readBack = fn.indexOf("await readPotInfo(p.potId)");
  const closeHide = fn.lastIndexOf("hide();");
  assert.ok(send > 0 && readBack > send && closeHide > readBack, "close, read back, then hide");
  assert.match(fn, /if \(action === "delete"\) return hide\(\);/, "only a closed or ended pot is hidden without a transaction");
  assert.match(fn, /canClosePot\(s, p\)/, "the host check is repeated right before closing");
  const catchBlock = fn.slice(fn.indexOf("} catch (e) {"));
  assert.doesNotMatch(catchBlock, /hide\(\)/, "a failed close never hides the pot");
  assert.match(app, /deleteAction\(st, canClosePot\(s, p\)\)/);
  const ui = fs.readFileSync(new URL("../site/assets/pot-ui.js", import.meta.url), "utf8");
  const dlg = ui.slice(ui.indexOf("export function confirmDelete("));
  assert.match(dlg, /showModal\(\)/);
  assert.match(dlg, /addEventListener\("cancel"/, "Esc cancels");
  assert.match(dlg, /returnTo\.focus\(\)/, "focus goes back to the button");
  assert.match(dlg, /cancel\.focus\(\)/, "focus starts on the safe choice");
  assert.match(dlg, /aria-labelledby/);
  const css = fs.readFileSync(new URL("../site/assets/pots.css", import.meta.url), "utf8");
  assert.match(css, /prefers-reduced-motion: reduce\) \{ \.pot-dialog \{ animation: none; \}/);
  const privacy = fs.readFileSync(new URL("../site/privacy.html", import.meta.url), "utf8");
  assert.match(privacy, /np-pots-hidden/);
});
