// Shared fakes for the refund, lock, alert and invariant tests: the same fake world as test/watch-autopilot.test.mjs
// (a fake chain, in-memory state files, a fake pay()), extended with what refunds need: raw Transfer logs and receipts,
// balances, a fake attribution-tagged wallet, refunds.json in memory and receipts.jsonl read back from the log.
// Nothing here touches the network or the real state files. (node --test loads this file too; it has no tests.)
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, erc20Abi, getAddress, parseUnits } from "viem";
import { AGENT_ADDRESS, ATTRIBUTION_CODE, TOKENS } from "../src/config.mjs";

export const USDT = TOKENS.USDT.address;
export const ADA = "0x2222222222222222222222222222222222222222";
export const EVE = "0x5555555555555555555555555555555555555555";
export const PAYER = "0x4444444444444444444444444444444444444444";
export const OWN = "0x7777777777777777777777777777777777777777";
export const T0 = 1_700_000_000;
export const h = (n) => "0x" + n.toString(16).padStart(64, "0");
export const transferData = (units) => encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [AGENT_ADDRESS, units] });
export const ADA_CLAIM = { hash: h(1), from: ADA, block: 10, position: 0, time: T0 + 10, value: "0", op: { t: "ada" } };
export const REG = { hash: h(2), from: EVE, block: 5, position: 0, time: T0 + 5, req: { a: "5.03", d: "usdt-cngn", e: T0 + 5 + 86400, n: "Eve" } };
export const REG_UNITS = 5_030_000n;
/** The deposit key autopilot uses for fake deposit n. */
export const key = (n) => `${h(1000 + n)}:3`;

/** A raw ERC-20 Transfer log, as an RPC returns it (topics + data), so parseEventLogs reads it like the real thing. */
export function rawTransfer({ token = USDT, from, to, value, logIndex = 3, blockNumber = 901n, transactionHash }) {
  return {
    address: token, topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from, to } }),
    data: encodeAbiParameters([{ type: "uint256" }], [BigInt(value)]), logIndex, blockNumber: BigInt(blockNumber), transactionHash,
    transactionIndex: 1, args: { from, to, value: BigInt(value) },
  };
}

/**
 * A fake world. deposits: [{ n, block, units, input, from?, to?, token? }] (one Transfer log each, to the agent).
 * opts.chain: { celo (wei), balances: { [token]: units }, failSend, revert, sendThrowsAfterBroadcast } for refunds.
 * Returns { io, mem, calls, out, wallet, sent } for watch({ io }) and refundDeps(w).
 */
export function world({ deposits = [], requests = [], regs = [], ops = [ADA_CLAIM], cursor = "900", over = {}, chain = {} } = {}) {
  const mem = {
    requests: structuredClone(requests), reg: {}, ntag: {}, refunds: {}, state: { cursor }, log: [], saved: [], alerts: [], beats: [],
    celo: chain.celo ?? parseUnits("10", 18), balances: { [USDT.toLowerCase()]: parseUnits("1000", 6), ...(chain.balances ?? {}) }, block: 1000n,
  };
  const calls = [];
  const out = [];
  const sent = []; // refund transfers the fake wallet broadcast: { hash, token, to, value, log }
  const txs = new Map();
  const receipts = new Map();
  const logs = deposits.map((d) => {
    const hash = h(1000 + d.n);
    const from = d.from ?? PAYER;
    const token = d.token ?? USDT;
    txs.set(hash, { from: d.txFrom ?? from, to: d.to ?? token, input: d.input ?? transferData(d.units), transactionIndex: 1 });
    const log = rawTransfer({ token, from, to: AGENT_ADDRESS, value: d.units, blockNumber: BigInt(d.block), transactionHash: hash });
    receipts.set(hash, { status: "success", from: d.txFrom ?? from, blockNumber: BigInt(d.block), logs: [log] });
    return log;
  });
  const clone = (x) => structuredClone(x);
  const pub = {
    getBlockNumber: async () => mem.block,
    getLogs: async ({ fromBlock, toBlock, args, address }) => {
      if (args?.from) {
        // findRefundOnchain: transfers FROM the agent
        return sent.filter((s) => s.mined && s.token.toLowerCase() === String(address).toLowerCase() && s.to.toLowerCase() === String(args.to).toLowerCase()
          && s.log.blockNumber >= fromBlock && s.log.blockNumber <= toBlock).map((s) => s.log);
      }
      return logs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
    },
    getTransaction: async ({ hash }) => txs.get(hash),
    getTransactionReceipt: async ({ hash }) => receipts.get(hash) ?? null,
    waitForTransactionReceipt: async ({ hash }) => {
      if (chain.noReceipt) throw new Error("timed out waiting for the receipt");
      return receipts.get(hash);
    },
    getBlock: async ({ blockNumber }) => ({ timestamp: BigInt(T0) + BigInt(blockNumber ?? 1000n) }),
    getBalance: async () => { if (chain.noBalance) throw new Error("rpc down"); return mem.celo; },
    readContract: async ({ address, functionName }) => {
      if (functionName === "balanceOf") return mem.balances[String(address).toLowerCase()] ?? 0n;
      if (functionName === "decimals") return Object.values(TOKENS).find((t) => t.address.toLowerCase() === String(address).toLowerCase())?.decimals ?? 18;
      throw new Error(`fake chain: no ${functionName}`);
    },
    estimateContractGas: async () => 50_000n,
    getGasPrice: async () => 25_000_000_000n,
  };
  const wallet = {
    writeContract: async ({ address, functionName, args }) => {
      if (functionName !== "transfer") throw new Error("fake wallet: only transfer");
      if (wallet.onSend) wallet.onSend({ address, args });
      if (chain.failSend) throw new Error("insufficient funds for gas");
      const hash = h(5000 + sent.length + 1);
      mem.block += 1n; // mined in the next block
      const log = rawTransfer({ token: address, from: AGENT_ADDRESS, to: args[0], value: args[1], logIndex: 0, blockNumber: mem.block, transactionHash: hash });
      const s = { hash, token: address, to: args[0], value: args[1], log, mined: !chain.revert };
      sent.push(s);
      receipts.set(hash, { status: chain.revert ? "reverted" : "success", from: AGENT_ADDRESS, blockNumber: mem.block, logs: chain.revert ? [] : [log] });
      return hash;
    },
    onSend: null,
  };
  const io = {
    makePub: () => pub,
    loadAccount: () => ({ address: AGENT_ADDRESS }),
    loadState: () => clone(mem.state),
    saveState: (s) => { mem.state = clone(s); mem.saved.push(s.cursor); },
    loadRequests: () => clone(mem.requests),
    saveRequests: (l) => { mem.requests = clone(l); },
    loadRegState: () => clone(mem.reg),
    saveRegState: (s) => { mem.reg = clone(s); },
    loadNtagPayments: () => clone(mem.ntag),
    saveNtagPayments: (s) => { mem.ntag = clone(s); },
    loadRefunds: () => clone(mem.refunds),
    saveRefunds: (s) => { mem.refunds = clone(s); },
    readReceipts: () => clone(mem.log),
    log: (e) => mem.log.push({ at: new Date().toISOString(), ...e }),
    pay: async (args) => {
      calls.push(args);
      return { hashes: { swap: h(7000 + calls.length), payout: h(8000 + calls.length) }, receiptNo: `NP-${calls.length}`, receiptUrl: "u", paid: "1" };
    },
    preflight: async () => ({}),
    discoverRegistrations: async () => regs,
    indexedHeight: async () => 1000n,
    loadNtagOpsCache: async () => ({ ops, head: { block: 999, position: 0 } }),
    refreshNtagOpsCache: async (c) => c,
    verifyRegistrationOnchain: async (_pub, reg) => ({ from: getAddress(reg.from) }),
    verifyNtagOpOnchain: async (_pub, op) => ({ from: getAddress(op.from) }),
    ntagUsdFloor: async () => {},
    print: (s) => out.push(s),
    sleep: async () => {},
    makeStatus: () => null,
    makeAlerter: () => ({ enabled: true, channels: ["fake"], alert: (kind, text) => { mem.alerts.push({ kind, text }); return true; }, close: async () => {} }),
    refundChain: () => ({ wallet, verifyTx: async () => ({ codes: [ATTRIBUTION_CODE] }), preview: fakePreview, own: [OWN] }),
    version: () => "0.1.0+test",
    ...over,
  };
  return { io, mem, calls, out, wallet, sent, pub };
}

/** A fake Textile preview: 1 USD₮ = 1,500 cNGN; IDRX, wARS and wCOP only quoted as USD₮ -> token (the fallback path). */
export async function fakePreview(sell, buy, amount) {
  const s = String(sell).toLowerCase(), b = String(buy).toLowerCase();
  const usdt = TOKENS.USDT.address.toLowerCase(), cngn = TOKENS.CNGN.address.toLowerCase();
  if (s === cngn && b === usdt) return { status: "preview", buyAmount: String(BigInt(amount) / 1500n) };
  if (s === usdt && b === cngn) return { status: "preview", buyAmount: String(BigInt(amount) * 1500n) };
  if (s === usdt && TOKENS.IDRX && b === TOKENS.IDRX.address.toLowerCase()) return { status: "preview", buyAmount: String((BigInt(amount) * 16_000n * 100n) / 1_000_000n) };
  return { status: "no_quote" };
}

/** The deps refundDeposit takes, built on a fake world (what the CLI builds from the real files and chain). */
export function refundDeps(w, extra = {}) {
  const events = { confirms: 0, locks: 0, releases: 0, reports: [] };
  const deps = {
    pub: w.pub, agent: AGENT_ADDRESS, own: [OWN], contracts: [TOKENS.USDT.address, TOKENS.CNGN.address], wallet: w.wallet,
    verifyTx: async () => ({ codes: [ATTRIBUTION_CODE] }), attributionCode: ATTRIBUTION_CODE, preview: fakePreview, now: () => Date.now(),
    loadRecords: () => ({
      requests: w.io.loadRequests(), registrations: w.io.loadRegState(), ntagPayments: w.io.loadNtagPayments(), receipts: w.io.readReceipts(), refunds: w.io.loadRefunds(),
    }),
    loadRefunds: w.io.loadRefunds, saveRefunds: w.io.saveRefunds, log: w.io.log, say: (m) => w.out.push(m),
    confirm: async () => { events.confirms++; return true; },
    lock: () => { events.locks++; return { release: () => { events.releases++; } }; },
    report: async (rec) => { events.reports.push(rec); },
    alert: (kind, text) => w.mem.alerts.push({ kind, text }),
    ...extra,
  };
  return { deps, events };
}
