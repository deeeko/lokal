// "Agent online / offline" on the pay pages (site/assets/ntag-ui.js): the pure decision from GET /api/status?agent=1,
// the wording, and that anything unreadable shows nothing (no false alarms). The pages warn, never block.
import test from "node:test";
import assert from "node:assert/strict";
import { AGENT_OFFLINE_MS, agentAgeText, agentOfflineText, agentOnline, readAgentOnline } from "../site/assets/ntag-ui.js";

const answer = (agent) => ({ ok: true, source: "agent", agent });
const NOW = Date.parse("2026-11-25T12:00:00Z");

test("offline means the last heartbeat is older than 15 minutes", () => {
  assert.equal(AGENT_OFFLINE_MS, 15 * 60_000);
  assert.deepEqual(agentOnline(answer({ lastSeen: "2026-11-25T11:58:00Z", ageSec: 120 }), NOW), { online: true, ageSec: 120 });
  assert.deepEqual(agentOnline(answer({ ageSec: 900 }), NOW), { online: true, ageSec: 900 }); // exactly 15 min: still online
  assert.deepEqual(agentOnline(answer({ ageSec: 901 }), NOW), { online: false, ageSec: 901 });
  assert.deepEqual(agentOnline(answer({ ageSec: 7200 }), NOW), { online: false, ageSec: 7200 });
});

test("without ageSec, lastSeen and the page's clock decide; a negative age counts as zero", () => {
  assert.deepEqual(agentOnline(answer({ lastSeen: "2026-11-25T11:30:00Z" }), NOW), { online: false, ageSec: 1800 });
  assert.deepEqual(agentOnline(answer({ lastSeen: "2026-11-25T11:55:00Z" }), NOW), { online: true, ageSec: 300 });
  assert.deepEqual(agentOnline(answer({ ageSec: -5 }), NOW), { online: true, ageSec: 0 });
});

test("anything unreadable is unknown (null): no notice at all", () => {
  for (const bad of [null, undefined, "x", {}, { ok: false }, { ok: true, source: "chain", agent: { ageSec: 9999 } },
    answer(null), answer("x"), answer({}), answer({ lastSeen: "not a date" }), answer({ ageSec: "9999" }), answer({ ageSec: Infinity })]) {
    assert.equal(agentOnline(bad, NOW), null, JSON.stringify(bad));
  }
  assert.equal(agentOfflineText(null), null);
});

test("the wording: quiet when online, one calm sentence when offline", () => {
  assert.equal(agentOfflineText({ online: true, ageSec: 60 }), null);
  assert.equal(agentOfflineText({ online: false, ageSec: 23 * 60 }),
    "The agent is offline right now (last seen 23 min ago). Your payment is safe and will be paid when it's back, or it can be refunded.");
  assert.equal(agentAgeText(10), "1 min ago");
  assert.equal(agentAgeText(119 * 60), "119 min ago");
  assert.equal(agentAgeText(3 * 3600), "3 h ago");
  assert.equal(agentAgeText(3 * 86400), "3 days ago");
});

test("readAgentOnline asks ?agent=1 and gives up quietly on any error", async () => {
  let asked = null;
  const ok = async (url) => { asked = url; return { status: 200, json: async () => answer({ lastSeen: "x", ageSec: 1800 }) }; };
  assert.deepEqual(await readAgentOnline({ fetchImpl: ok, force: true }), { online: false, ageSec: 1800 });
  assert.equal(asked, "/api/status?agent=1");
  assert.equal(await readAgentOnline({ fetchImpl: async () => ({ status: 503, json: async () => ({}) }), force: true }), null);
  assert.equal(await readAgentOnline({ fetchImpl: async () => { throw new Error("offline"); }, force: true }), null);
  assert.equal(await readAgentOnline({ fetchImpl: async () => ({ status: 200, json: async () => { throw new SyntaxError("bad"); } }), force: true }), null);
  assert.equal(await readAgentOnline({ fetchImpl: ok }), null); // not on the Vercel site (no /api): never asks
});
