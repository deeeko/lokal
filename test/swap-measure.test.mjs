// The payout is measured at the swap's own block, so a lagging RPC node ("latest" still before the swap) can't make a
// delivered swap look like nothing arrived (seen on mainnet, 23 Nov 2026, swap 0x3569…4a5f).
import test from "node:test";
import assert from "node:assert/strict";
import { balanceDeltaAtBlock } from "../src/pay.mjs";

const TOKEN = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e";
const ME = "0x8a695cf54CB44753c8b784EB36d266f748617a1e";

test("the delta is read at the swap block and the block before, not at 'latest'", async () => {
  const asked = [];
  const history = { 99n: 1_000_000n, 100n: 8_993_821n }; // the swap at block 100 delivered 7.993821 USD₮
  const pub = { readContract: async ({ blockNumber }) => { asked.push(blockNumber); if (blockNumber == null) return history[99n]; return history[blockNumber]; } };
  assert.equal(await balanceDeltaAtBlock(pub, TOKEN, ME, 100n), 7_993_821n);
  assert.deepEqual(new Set(asked), new Set([99n, 100n]));
});

test("a node that hasn't reached the block yet is asked again, then the read succeeds", async () => {
  let calls = 0;
  const pub = { readContract: async ({ blockNumber }) => { calls++; if (calls <= 2) throw new Error("header not found"); return blockNumber === 100n ? 5n : 2n; } };
  assert.equal(await balanceDeltaAtBlock(pub, TOKEN, ME, 100n, { sleep: async () => {} }), 3n);
});

test("a node that never catches up stops the payout loudly (never a silent 0)", async () => {
  const pub = { readContract: async () => { throw new Error("header not found"); } };
  await assert.rejects(balanceDeltaAtBlock(pub, TOKEN, ME, 100n, { tries: 3, sleep: async () => {} }), /Couldn't read the balance at the swap's block 100/);
});

test("settle: only a swapped, unpaid contract payment can be settled", async () => {
  const { settleBlocker } = await import("../src/settle.mjs");
  assert.match(settleBlocker(undefined), /no contract payment/);
  assert.match(settleBlocker({ paidAt: "x", hashes: { payout: "0x1" } }), /already paid/);
  assert.match(settleBlocker({ status: "refused" }), /refund/);
  assert.match(settleBlocker({ hashes: {} , owner: "0x1", dir: "cngn-usdt" }), /restart autopilot/);
  assert.equal(settleBlocker({ hashes: { swap: "0x1" }, owner: "0x2", dir: "cngn-usdt" }), null);
});
