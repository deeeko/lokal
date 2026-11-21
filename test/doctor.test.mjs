// `doctor` (src/doctor.mjs): PASS / WARN / FAIL for each check, with fakes for the chain, Blockscout, Textile, the
// lock and the state files. It never reads the agent key and never prints the status secret.
import test from "node:test";
import assert from "node:assert/strict";
import { parseUnits } from "viem";
import { TOKENS } from "../src/config.mjs";
import { runDoctor } from "../src/doctor.mjs";

const SECRET = "z".repeat(64);
const NOW = 2_000_000_000_000;
function fakes(o = {}) {
  const files = {
    "/c.json": JSON.stringify({ contacts: {}, own_wallets: [] }), "/req.json": JSON.stringify({ requests: [] }),
    "/receipts.jsonl": "", ...(o.files ?? {}),
  };
  return {
    makePub: () => ({
      getBlockNumber: async () => 1000n,
      getBlock: async () => ({ timestamp: BigInt(Math.floor(NOW / 1000) - 3) }),
      getBalance: async () => o.celo ?? parseUnits("10", 18),
      readContract: async ({ address }) => (o.badDecimals && address === TOKENS.CNGN.address ? 18 : Object.values(TOKENS).find((t) => t.address === address).decimals),
    }),
    indexedHeight: async () => o.indexed ?? 990n,
    preview: async () => o.preview ?? { status: "preview", buyAmount: "1500000000" },
    readStatusSecret: () => (o.noSecret ? { reason: "no NP_STATUS_SECRET" } : { secret: SECRET, source: "NP_STATUS_SECRET" }),
    readLock: () => o.lock ?? null,
    lockState: () => o.lockState ?? "live",
    jsonFiles: [["contacts.json", "/c.json", true], ["requests.json", "/req.json"], ["refunds.json", "/refunds.json"]],
    receiptsFile: "/receipts.jsonl",
    readFile: (f) => { if (!(f in files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); return files[f]; },
    now: () => NOW,
  };
}
const levels = (r) => Object.fromEntries(r.map((x) => [x.name, x.level]));

test("doctor: a healthy setup passes every check, and the secret is never printed", async () => {
  const r = await runDoctor(fakes());
  assert.deepEqual(Object.values(levels(r)), Array(9).fill("PASS"), JSON.stringify(r));
  assert.ok(!JSON.stringify(r).includes(SECRET));
});

test("doctor: warnings and failures say what to do", async () => {
  const r = await runDoctor(fakes({
    lock: { pid: 5, host: "pc", startedAt: "x" }, lockState: "stale", indexed: 100n, preview: { status: "no_quote" }, celo: parseUnits("2.5", 18),
    noSecret: true, files: { "/req.json": "{nope", "/receipts.jsonl": JSON.stringify({ type: "unmatched_deposit", tx: "0x" + "1".repeat(64), logIndex: 1, token: "USDT", amount: "7", from: "0x" + "4".repeat(40) }) + "\n" },
    badDecimals: true,
  }));
  const l = levels(r);
  assert.equal(l.lock, "WARN");
  assert.match(r.find((x) => x.name === "lock").detail, /--clear-stale-lock/);
  assert.equal(l["Blockscout lag"], "WARN");
  assert.equal(l["Textile preview ($1)"], "WARN");
  assert.equal(l["CELO gas"], "WARN");
  assert.equal(l["status secret"], "WARN");
  assert.equal(l["state files"], "FAIL");
  assert.equal(l["refundable deposits"], "WARN");
  assert.equal(l["token decimals"], "FAIL");
  const low = await runDoctor(fakes({ celo: parseUnits("1", 18) }));
  assert.equal(levels(low)["CELO gas"], "FAIL");
  const down = await runDoctor({ ...fakes(), makePub: () => ({ getBlockNumber: async () => { throw new Error("fetch failed"); } }) });
  assert.deepEqual([levels(down)["Forno (Celo RPC)"], levels(down)["CELO gas"], levels(down)["token decimals"]], ["FAIL", "FAIL", "FAIL"]);
});
