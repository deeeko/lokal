// `node src/agent.mjs doctor`: PASS / WARN / FAIL for everything autopilot depends on. It reads only public data and
// local state files: it never opens the agent key file (the agent's address comes from AGENT_ADDRESS), and it never
// prints the status secret, only whether one is set up. Every outside call is injectable, so tests use fakes.
import fs from "node:fs";
import { createPublicClient, erc20Abi, formatUnits, http, parseUnits } from "viem";
import {
  AGENT_ADDRESS, AGENT_LOCK_FILE, CHAIN, CONTACTS_FILE, LOG_FILE, LOW_CELO_WARN, MIN_CELO_RESERVE, NTAG_PAYMENTS_FILE, REFUNDS_FILE,
  REGISTRATIONS_STATE_FILE, REQUESTS_FILE, TOKENS, WATCH_STATE_FILE,
} from "./config.mjs";
import { lockState, readLock } from "./lock.mjs";
import { indexedHeight } from "./registrations.mjs";
import { preview } from "./textile.mjs";
import { readStatusSecret } from "./status-report.mjs";
import { refundRows } from "./refund.mjs";

/** Blockscout this many blocks behind the chain is a warning (about 10 minutes at ~1 s per block). */
export const BLOCKSCOUT_WARN_LAG = 600n;
const JSON_FILES = [
  ["contacts.json", CONTACTS_FILE, true], ["requests.json", REQUESTS_FILE], ["watch-state.json", WATCH_STATE_FILE],
  ["registrations-state.json", REGISTRATIONS_STATE_FILE], ["ntag-payments.json", NTAG_PAYMENTS_FILE], ["refunds.json", REFUNDS_FILE],
];

const DEFAULTS = {
  agent: AGENT_ADDRESS,
  makePub: () => createPublicClient({ chain: CHAIN, transport: http(process.env.CELO_RPC_URL || undefined, { timeout: 15_000, retryCount: 1 }) }),
  indexedHeight, preview, readStatusSecret: () => readStatusSecret(), readLock: () => readLock(AGENT_LOCK_FILE), lockState,
  lockFile: AGENT_LOCK_FILE, jsonFiles: JSON_FILES, receiptsFile: LOG_FILE, readFile: (f) => fs.readFileSync(f, "utf8"), now: () => Date.now(),
};

const pass = (name, detail) => ({ level: "PASS", name, detail });
const warn = (name, detail) => ({ level: "WARN", name, detail });
const fail = (name, detail) => ({ level: "FAIL", name, detail });
const msg = (e) => e?.shortMessage ?? e?.message ?? String(e);

/** Runs every check; never throws. Returns [{ level: "PASS"|"WARN"|"FAIL", name, detail }]. deps: see DEFAULTS. */
export async function runDoctor(overrides = {}) {
  const d = { ...DEFAULTS, ...overrides };
  const out = [];
  const check = async (name, fn) => { try { out.push(await fn()); } catch (e) { out.push(fail(name, msg(e))); } };
  let pub = null;
  let head = null;

  await check("lock", async () => {
    const h = d.readLock();
    if (!h) return pass("lock", "no agent is running (agent.lock is free)");
    const s = d.lockState(h);
    if (s === "live") return pass("lock", `held by a running agent (pid ${h.pid}, ${h.command || "watch"}, since ${h.startedAt})`);
    if (s === "stale") return warn("lock", `stale lock from pid ${h.pid} (gone). If no agent runs, start with --clear-stale-lock.`);
    if (s === "foreign") return warn("lock", `held by another computer (${h.host}); it can't be checked from here`);
    return warn("lock", `${d.lockFile} exists but can't be read`);
  });

  await check("Forno (Celo RPC)", async () => {
    pub = d.makePub();
    head = await pub.getBlockNumber();
    const b = await pub.getBlock({ blockNumber: head });
    const ageSec = Math.round(d.now() / 1000 - Number(b.timestamp));
    return ageSec > 120 ? warn("Forno (Celo RPC)", `block ${head} is ${ageSec} s old`) : pass("Forno (Celo RPC)", `block ${head}, ${ageSec} s old`);
  });

  await check("Blockscout lag", async () => {
    if (head == null) return fail("Blockscout lag", "needs the chain head (Forno failed)");
    const h = await d.indexedHeight();
    const lag = head > h ? head - h : 0n;
    return lag > BLOCKSCOUT_WARN_LAG
      ? warn("Blockscout lag", `${lag} blocks behind; new registrations and tag claims wait until it catches up`)
      : pass("Blockscout lag", `${lag} blocks behind`);
  });

  await check("Textile preview ($1)", async () => {
    const pv = await d.preview(TOKENS.USDT.address, TOKENS.CNGN.address, parseUnits("1", TOKENS.USDT.decimals).toString());
    return pv?.status === "preview"
      ? pass("Textile preview ($1)", `1 USDT -> ~${formatUnits(BigInt(pv.buyAmount), TOKENS.CNGN.decimals)} cNGN`)
      : warn("Textile preview ($1)", `no price right now (${pv?.status ?? "no answer"})`);
  });

  await check("CELO gas", async () => {
    if (!pub) return fail("CELO gas", "needs Forno");
    const bal = await pub.getBalance({ address: d.agent });
    const s = `${formatUnits(bal, 18)} CELO on ${d.agent}`;
    if (bal < parseUnits(MIN_CELO_RESERVE, 18)) return fail("CELO gas", `${s}, below the reserve of ${MIN_CELO_RESERVE} CELO: top it up`);
    if (bal < parseUnits(LOW_CELO_WARN, 18)) return warn("CELO gas", `${s}, under the warning level of ${LOW_CELO_WARN} CELO`);
    return pass("CELO gas", s);
  });

  await check("status secret", async () => {
    const s = d.readStatusSecret();
    return s?.secret ? pass("status secret", `set up (${s.source}); the value is never printed`) : warn("status secret", `reporting is off (${s?.reason ?? "no secret"})`);
  });

  const parsed = {};
  await check("state files", async () => {
    const bad = [];
    const missing = [];
    for (const [name, file, needed] of d.jsonFiles) {
      let text;
      try { text = d.readFile(file); } catch (e) { if (e?.code === "ENOENT") { if (needed) missing.push(name); continue; } bad.push(`${name} (${e.code ?? e.message})`); continue; }
      try { parsed[name] = JSON.parse(text); } catch { bad.push(`${name} (not valid JSON)`); }
    }
    let receipts = [];
    try {
      const lines = d.readFile(d.receiptsFile).split("\n").filter(Boolean);
      receipts = lines.flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
      if (receipts.length < lines.length) bad.push(`receipts.jsonl (${lines.length - receipts.length} unreadable line(s))`);
    } catch (e) { if (e?.code !== "ENOENT") bad.push(`receipts.jsonl (${e.code ?? e.message})`); }
    parsed.receipts = receipts;
    if (bad.length) return fail("state files", `can't be read: ${bad.join(", ")}`);
    if (missing.length) return warn("state files", `missing: ${missing.join(", ")} (copy contacts.example.json to contacts.json)`);
    return pass("state files", "every state file that exists parses");
  });

  await check("refundable deposits", async () => {
    const records = {
      requests: parsed["requests.json"]?.requests ?? [], registrations: parsed["registrations-state.json"]?.registrations ?? {},
      ntagPayments: parsed["ntag-payments.json"]?.payments ?? {}, receipts: parsed.receipts ?? [],
    };
    const rows = refundRows(records, parsed["refunds.json"]?.refunds ?? {});
    const n = rows.filter((r) => r.status === "refundable").length;
    const failed = rows.filter((r) => r.status === "failed" || r.status === "sending").length;
    if (failed) return warn("refundable deposits", `${failed} refund(s) failed or unfinished; see "node src/agent.mjs refunds"`);
    return n ? warn("refundable deposits", `${n} deposit(s) can be refunded; see "node src/agent.mjs refunds"`) : pass("refundable deposits", "none waiting");
  });

  await check("token decimals", async () => {
    if (!pub) return fail("token decimals", "needs Forno");
    const wrong = [];
    for (const t of Object.values(TOKENS)) {
      const dec = Number(await pub.readContract({ address: t.address, abi: erc20Abi, functionName: "decimals" }));
      if (dec !== t.decimals) wrong.push(`${t.symbol}: chain ${dec}, config ${t.decimals}`);
    }
    return wrong.length ? fail("token decimals", wrong.join("; ")) : pass("token decimals", `${Object.keys(TOKENS).length} tokens match the config`);
  });
  return out;
}
