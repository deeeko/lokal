// The site shows refunds: "refunded" events from the status server rank above "refused" (and below "paid"), are final,
// and read "Refunded · RF-XXXX-XXXX". A refused payment says the money is safe and can be sent back. No network.
import test from "node:test";
import assert from "node:assert/strict";
import { REFUND_NOTE, agentStatus, depositStatus, refundedText, refusedNote, statusFinal } from "../site/assets/ntag-ui.js";
import { RANK, refundNo } from "../lib/status.mjs";

const TX = "0x" + "ab".repeat(32);
const REFUND_TX = "0x7f3a91c2" + "00".repeat(28);
const base = { id: `${TX}:3`, kind: "ntag", tag: "ada", token: "USDT", amount: "5", depositTx: TX, payer: "0x" + "44".repeat(20) };

test("refunded ranks like the server: above refused, below paid; and it is final", () => {
  const answer = {
    events: [
      { ...base, status: "refused", reason: "over_wallet_cap", at: "2026-11-21T10:00:00.000Z" },
      { ...base, status: "refunded", refundTx: REFUND_TX, refundNo: refundNo(REFUND_TX), at: "2026-11-21T10:05:00.000Z" },
      { ...base, status: "received", at: "2026-11-21T09:59:00.000Z" },
    ],
  };
  const ev = depositStatus(answer, TX, { logIndex: 3 });
  assert.equal(ev.status, "refunded");
  assert.ok(statusFinal(ev));
  assert.ok(statusFinal({ status: "refused" }) && statusFinal({ status: "paid" }));
  assert.ok(!statusFinal({ status: "received" }) && !statusFinal({ status: "failed" }));
  const paid = depositStatus({ events: [...answer.events, { ...base, status: "paid", at: "2026-11-21T10:06:00.000Z" }] }, TX, { logIndex: 3 });
  assert.equal(paid.status, "paid");
  for (const [a, b] of [["received", "failed"], ["failed", "refused"], ["refused", "refunded"], ["refunded", "paid"]]) assert.ok(RANK[a] < RANK[b], `${a} < ${b} on the server too`);
});

test("refunded events survive the shape check and read 'Refunded · RF-XXXX-XXXX'", async () => {
  const body = {
    ok: true, source: "agent", updatedAt: new Date().toISOString(), global: { usedUsd: 0, roomUsd: 100, capUsd: 100 },
    events: [{ ...base, status: "refunded", refundTx: REFUND_TX, refundNo: "RF-7F3A-91C2", at: new Date().toISOString() }],
  };
  const fetchImpl = async () => new Response(JSON.stringify(body), { status: 200 });
  const answer = await agentStatus({ tx: TX }, { fetchImpl, force: true });
  assert.ok(answer, "the answer is accepted");
  assert.equal(answer.events.length, 1, "the refunded event is kept, not dropped");
  assert.equal(refundedText(answer.events[0]), "Refunded · RF-7F3A-91C2");
  assert.equal(refundedText({ status: "refunded", refundTx: REFUND_TX }), "Refunded · RF-7F3A-91C2", "number worked out from the refund tx");
  assert.equal(refundedText({ status: "refunded" }), "Refunded");
});

test("a refused payment: 'Not paid: <reason>. Your money is safe with the agent ...'", () => {
  assert.equal(REFUND_NOTE, "Your money is safe with the agent and can be sent back to the wallet you paid from. You'll see 'Refunded' here.");
  assert.equal(refusedNote("over_wallet_cap"), `Not paid: it would have taken this person over $25 in 24 hours. ${REFUND_NOTE}`);
  assert.match(refusedNote("something_new"), /^Not paid: the agent couldn't pay it automatically\. Your money is safe/);
});
