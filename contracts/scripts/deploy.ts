/**
 * Deploys LokalTags and LokalPots from the agent's wallet. NOT run by CI or tests.
 *
 *   cd contracts && npm run deploy:sepolia     rehearsal on Celo Sepolia (chain 11142220): deploys mock tokens first
 *   cd contracts && npm run deploy:celo        Celo mainnet (chain 42220)
 *
 * What it does, in order:
 *  1. Checks the chain (42220, or 11142220 for a rehearsal) and that the reserved list about to be deployed is exactly
 *     the live NTAG_RESERVED in src/ntags.mjs and site/assets/core.js. Any difference: it refuses.
 *  2. On mainnet, checks every token has code and the decimals in config/celo.ts.
 *  3. Shows the full plan (payout wallet, new owner, reserved list, every token's limits and pot rate in its own units,
 *     pot maxima, gas and cost), estimated from the expected deployer address. DRY_RUN=1 stops here, before the key.
 *  4. Only then reads the agent key file (%USERPROFILE%\.celo-naira-agent\agent.json, or CELO_AGENT_KEY_FILE). The key
 *     is never printed, logged or written anywhere. Asks you to type "deploy" (or DEPLOY_CONFIRM=yes).
 *  5. Sends, one step at a time, checking every receipt and writing the deployments record after EACH step:
 *     [rehearsal: mock tokens] -> LokalTags -> LokalPots -> transferOwnership(NEW_OWNER). Every transaction carries
 *     the ERC-8021 attribution suffix. If anything fails, rerun with TAGS_ADDRESS=<LokalTags> to resume after it.
 *  6. Writes the constructor-argument files and prints how to verify (Sourcify and Blockscout need no API key).
 *
 * Options (environment variables):
 *   NEW_OWNER=0x...                admin wallet that takes over both contracts (default: ADMIN_WALLET in config/celo.ts,
 *                                  the owner's 0xc280...A070). It must call acceptOwnership() on LokalTags.
 *   ALLOW_SAME_OWNER=1             keep the deployer (the agent's hot key) as admin. Refused otherwise.
 *   PAYOUT_WALLET=0x...            payout wallet (default: the agent, 0x8a69...7a1e)
 *   DEPLOYER=0x...                 the address the key file must hold (default: the agent); used for the dry run
 *   DEPLOY_TOKENS=USDT,cNGN        subset of tokens to allow at deploy (default: all five)
 *   RATE_<SYMBOL>=<n>              local units per US dollar for the defaults and pot rates, e.g. RATE_cNGN=1450
 *   LIMITS_<SYMBOL>=min,max,perRecipientDay,perPayerDay,perDay   explicit payTag limits in whole tokens
 *   POT_MAX_CAP_USD=100  POT_MAX_PER_PAYER_USD=5  POT_MAX_PER_HOST_DAY_USD=100  POT_MAX_DAILY_USD=250
 *   TAGS_ADDRESS=0x...             resume: use this already-deployed LokalTags and continue with LokalPots
 *   ATTRIBUTION=off                deploy without the ERC-8021 suffix
 *   DRY_RUN=1                      plan and estimate only; the key file is not read
 *
 * ERC-8021 on a deployment: the suffix is appended after the ABI-encoded constructor arguments. Solidity's constructor
 * decoder ignores trailing bytes (tests/LokalTags.spec.ts deploys this way and checks every setting), and suffix parsers
 * read it from the end of the transaction input, so creation is attributed like every other agent transaction.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { ethers, network } from "hardhat";
import type { TransactionReceipt, TransactionResponse } from "ethers";
import {
  ADMIN_WALLET, AGENT_ADDRESS, AGENT_KEY_FILE_PARTS, ATTRIBUTION_CODE, CELO_CHAIN_ID, CELO_SEPOLIA_CHAIN_ID,
  POT_DEFAULTS, RESERVED_TAGS, TOKENS, attributionSuffix, defaultLimits, toUnits, unitsPerUsd, type Limits,
  type TokenConfig,
} from "../config/celo";
import { liveReservedLists } from "../config/repo-rules";

const ERC20_META = ["function decimals() view returns (uint8)"];
/** Rough LokalPots creation gas, for the up-front cost check (estimated exactly once LokalTags exists). */
const POTS_GAS_BUDGET = 3_500_000n;
/** Rough gas per mock token on a rehearsal. */
const MOCK_GAS_BUDGET = 1_500_000n;

function fail(msg: string): never {
  console.error(`\nStopped: ${msg}`);
  process.exit(1);
}

/** The token with RATE_<SYM> applied, if set. */
function withRate(t: TokenConfig): TokenConfig {
  const rate = process.env[`RATE_${t.symbol}`];
  if (!rate) return t;
  if (!(Number(rate) > 0)) fail(`RATE_${t.symbol} must be a positive number`);
  return { ...t, perUsd: Number(rate), rateSource: `RATE_${t.symbol}` };
}

/** payTag limits for one token: LIMITS_<SYM> (whole tokens) wins, then the rate-based defaults. */
function limitsFor(t: TokenConfig): Limits {
  const explicit = process.env[`LIMITS_${t.symbol}`];
  if (explicit) {
    const parts = explicit.split(",").map((s) => s.trim());
    if (parts.length !== 5) fail(`LIMITS_${t.symbol} must be min,max,perRecipientDay,perPayerDay,perDay`);
    const [a, b, c, d, e] = parts.map((p) => toUnits(p, t.decimals));
    return { minPerPayment: a, maxPerPayment: b, maxPerRecipientPerDay: c, maxPerPayerPerDay: d, maxPerDay: e };
  }
  return defaultLimits(t);
}

const dollarsEnv = (name: string, fallback: bigint): bigint => (process.env[name] ? toUnits(process.env[name]!, 6) : fallback);
const stringify = (l: Limits) => Object.fromEntries(Object.entries(l).map(([k, v]) => [k, String(v)]));

/** Loads the agent wallet from its key file. Never prints or returns the key itself. */
function loadAgentWallet(provider: typeof ethers.provider) {
  const file = process.env.CELO_AGENT_KEY_FILE || path.join(os.homedir(), ...AGENT_KEY_FILE_PARTS);
  if (!fs.existsSync(file)) fail(`no agent key file at ${file}`);
  let parsed: { address?: string; privateKey?: string };
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    fail(`the agent key file at ${file} is not valid JSON`);
  }
  if (!parsed.privateKey || !/^0x[0-9a-fA-F]{64}$/.test(parsed.privateKey)) fail("the agent key file has no valid privateKey");
  const wallet = new ethers.Wallet(parsed.privateKey, provider);
  parsed.privateKey = undefined;
  if (parsed.address && ethers.getAddress(parsed.address) !== wallet.address) fail("the key file's address does not match its key");
  return { wallet, file };
}

async function confirm(what: string): Promise<boolean> {
  if (process.env.DEPLOY_CONFIRM === "yes") return true;
  if (!process.stdin.isTTY) fail("not a terminal: set DEPLOY_CONFIRM=yes to deploy non-interactively");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`\nType "deploy" to send these transactions to ${what}: `);
  rl.close();
  return answer.trim() === "deploy";
}

/** Waits for a transaction and refuses anything but a successful receipt. */
async function mined(label: string, tx: TransactionResponse): Promise<TransactionReceipt> {
  console.log(`  ${label}: sent ${tx.hash}`);
  const rc = await tx.wait();
  if (!rc || rc.status !== 1) fail(`${label} failed (tx ${tx.hash})`);
  return rc;
}

async function main() {
  const provider = ethers.provider;
  const { chainId } = await provider.getNetwork();
  const rehearsal = chainId === BigInt(CELO_SEPOLIA_CHAIN_ID);
  if (chainId !== BigInt(CELO_CHAIN_ID) && !rehearsal) {
    fail(`connected to chain ${chainId}: use --network celo (${CELO_CHAIN_ID}) or --network celoSepolia (${CELO_SEPOLIA_CHAIN_ID})`);
  }
  const chainName = rehearsal ? "Celo Sepolia (rehearsal)" : "Celo mainnet";
  const recordFile = path.join(__dirname, "..", "deployments", `${network.name}-${chainId}.json`);

  // 1. The reserved list must be exactly what the site and the agent run.
  const reserved = [...RESERVED_TAGS];
  for (const live of liveReservedLists()) {
    const a = [...live.tags].sort().join(",");
    const b = [...reserved].sort().join(",");
    if (a !== b) {
      const missing = live.tags.filter((t) => !reserved.includes(t));
      const extra = reserved.filter((t) => !live.tags.includes(t));
      fail(`the reserved list differs from ${live.file} (missing here: ${missing.join(", ") || "none"}; extra here: ${extra.join(", ") || "none"})`);
    }
  }

  const payoutWallet = ethers.getAddress(process.env.PAYOUT_WALLET || AGENT_ADDRESS);
  const deployer = ethers.getAddress(process.env.DEPLOYER || AGENT_ADDRESS);
  const allowSameOwner = process.env.ALLOW_SAME_OWNER === "1";
  const newOwner = process.env.NEW_OWNER === "none" ? null : ethers.getAddress(process.env.NEW_OWNER || ADMIN_WALLET);
  if (!newOwner && !allowSameOwner) fail("NEW_OWNER=none keeps the agent's hot key as admin; set ALLOW_SAME_OWNER=1 if you really mean it");
  if (newOwner === deployer && !allowSameOwner) fail("NEW_OWNER is the deployer (the agent's hot key); set ALLOW_SAME_OWNER=1 if you really mean it");
  if (newOwner === payoutWallet && !allowSameOwner) fail("NEW_OWNER is the payout wallet; the admin should be a separate wallet");

  const wanted = (process.env.DEPLOY_TOKENS || TOKENS.map((t) => t.symbol).join(",")).split(",").map((s) => s.trim()).filter(Boolean);
  const chosen = wanted.map((sym) => ({ ...withRate(TOKENS.find((t) => t.symbol === sym) ?? fail(`unknown token ${sym}`)) }));
  const potMax = {
    cap: dollarsEnv("POT_MAX_CAP_USD", POT_DEFAULTS.maxPotCapUsd6),
    perPayer: dollarsEnv("POT_MAX_PER_PAYER_USD", POT_DEFAULTS.maxPerPayerCapUsd6),
    perHostDaily: dollarsEnv("POT_MAX_PER_HOST_DAY_USD", POT_DEFAULTS.maxPerHostDailyUsd6),
    daily: dollarsEnv("POT_MAX_DAILY_USD", POT_DEFAULTS.maxDailyUsd6),
  };
  if (!(potMax.perPayer > 0n && potMax.perPayer <= potMax.cap && potMax.cap <= potMax.perHostDaily && potMax.perHostDaily <= potMax.daily)) {
    fail("pot maxima must satisfy 0 < per payer <= pot cap <= per host per day <= all pots per day");
  }

  // 2. Tokens (mainnet: check them; rehearsal: mocks are deployed in step 5).
  console.log(`Lokal deployment plan (${chainName}, chain ${chainId}, via ${network.name})\n`);
  console.log(`  deployer        ${deployer} (the agent; key read only after this plan)`);
  console.log(`  new admin       ${newOwner ?? "none: the deployer stays admin (ALLOW_SAME_OWNER=1)"}`);
  console.log(`  payout wallet   ${payoutWallet}`);
  console.log(`  reserved tags   ${reserved.length} (identical to src/ntags.mjs and site/assets/core.js)`);
  console.log(`  pots            pot cap up to $${ethers.formatUnits(potMax.cap, 6)}, per payer up to $${ethers.formatUnits(potMax.perPayer, 6)}, per host per day $${ethers.formatUnits(potMax.perHostDaily, 6)}, all pots per day $${ethers.formatUnits(potMax.daily, 6)}`);
  console.log(`  tokens          ${chosen.length}${rehearsal ? " (rehearsal: mock tokens with the same decimals are deployed first)" : ""}`);
  for (const t of chosen) {
    if (!rehearsal) {
      if ((await provider.getCode(t.address)) === "0x") fail(`${t.symbol} at ${t.address} has no code`);
      const dec = Number(await new ethers.Contract(t.address, ERC20_META, provider).decimals());
      if (dec !== t.decimals) fail(`${t.symbol} reports ${dec} decimals, config says ${t.decimals}`);
    }
    const l = limitsFor(t);
    const f = (v: bigint) => Number(ethers.formatUnits(v, t.decimals)).toLocaleString("en-US");
    console.log(`    ${t.symbol.padEnd(5)} ${rehearsal ? "(mock)".padEnd(42) : t.address}  ${t.decimals} dp  min ${f(l.minPerPayment)}  max ${f(l.maxPerPayment)}  per recipient/day ${f(l.maxPerRecipientPerDay)}  per payer/day ${f(l.maxPerPayerPerDay)}  per day ${f(l.maxPerDay)}  $1 = ${f(unitsPerUsd(t))}  (${t.rateSource})`);
  }

  // 3. Estimate from the expected deployer, without the key.
  const attribution = process.env.ATTRIBUTION !== "off";
  const tag = (data: string) => (attribution ? data + attributionSuffix(ATTRIBUTION_CODE) : data);
  const tagsFactory = await ethers.getContractFactory("LokalTags");
  const potsFactory = await ethers.getContractFactory("LokalPots");
  const resumeTags = process.env.TAGS_ADDRESS ? ethers.getAddress(process.env.TAGS_ADDRESS) : null;
  const plannedSetup = chosen.map((t) => ({ token: t.address, limits: limitsFor(t) }));
  let tagsGas = 0n;
  if (!resumeTags && !rehearsal) {
    tagsGas = await provider.estimateGas({ from: deployer, data: tag((await tagsFactory.getDeployTransaction(payoutWallet, reserved, plannedSetup)).data) });
  } else if (!resumeTags) {
    tagsGas = 7_500_000n; // mock token addresses don't exist yet on a rehearsal; budget instead of estimating
  }
  const fee = await provider.getFeeData();
  const price = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
  const balance = await provider.getBalance(deployer);
  const mockGas = rehearsal ? MOCK_GAS_BUDGET * BigInt(chosen.length) : 0n;
  const cost = ((tagsGas * 12n) / 10n + POTS_GAS_BUDGET + mockGas + 100_000n) * price;
  console.log(`  attribution     ${attribution ? `ERC-8021 suffix for ${ATTRIBUTION_CODE} on every transaction` : "off"}`);
  console.log(`  resume          ${resumeTags ? `use LokalTags at ${resumeTags}` : "no (fresh deployment)"}`);
  console.log(`  gas             ${rehearsal ? `mocks ~${mockGas.toLocaleString("en-US")} + ` : ""}LokalTags ${tagsGas.toLocaleString("en-US")} + LokalPots ~${POTS_GAS_BUDGET.toLocaleString("en-US")}`);
  console.log(`  max cost        ${ethers.formatEther(cost)} CELO (deployer balance ${ethers.formatEther(balance)} CELO)`);
  console.log(`  record          ${path.relative(process.cwd(), recordFile)} (written after every step)`);
  if (balance < cost) fail("not enough CELO for gas");

  if (process.env.DRY_RUN) {
    console.log("\nDRY_RUN set: nothing sent, and the key file was not read.");
    return;
  }

  // 4. The key, only now.
  const { wallet, file } = loadAgentWallet(provider);
  if (wallet.address !== deployer) fail(`the key file at ${file} holds ${wallet.address}, not the expected deployer ${deployer} (set DEPLOYER)`);
  console.log(`\nKey loaded for ${wallet.address} (the key is not shown).`);
  if (!(await confirm(chainName))) fail("not confirmed; nothing sent");

  // 5. One step at a time; the record is rewritten after each.
  fs.mkdirSync(path.dirname(recordFile), { recursive: true });
  const record: Record<string, any> = fs.existsSync(recordFile) ? JSON.parse(fs.readFileSync(recordFile, "utf8")) : {};
  Object.assign(record, {
    chainId: Number(chainId), network: network.name, rehearsal, deployer: wallet.address, payoutWallet, newOwner,
    attribution: attribution ? ATTRIBUTION_CODE : null, reservedTags: reserved,
  });
  const save = (stepName: string) => {
    record.lastStep = stepName;
    record.updatedAt = new Date().toISOString();
    fs.writeFileSync(recordFile, JSON.stringify(record, null, 2) + "\n");
  };
  save("plan");

  // 5a. Rehearsal: mock tokens with the real decimals (USD₮ with permit, like mainnet).
  if (rehearsal) {
    record.mockTokens = record.mockTokens ?? {};
    for (const t of chosen) {
      if (record.mockTokens[t.symbol]) {
        t.address = record.mockTokens[t.symbol];
        continue;
      }
      const data = t.symbol === "USDT"
        ? tag((await (await ethers.getContractFactory("MockPermitERC20", wallet)).getDeployTransaction()).data)
        : tag((await (await ethers.getContractFactory("MockERC20", wallet)).getDeployTransaction(`Test ${t.symbol}`, `t${t.symbol}`, t.decimals)).data);
      const rc = await mined(`mock ${t.symbol}`, await wallet.sendTransaction({ data }));
      t.address = rc.contractAddress!;
      record.mockTokens[t.symbol] = t.address;
      save(`mock ${t.symbol}`);
    }
  }
  const setup = chosen.map((t) => ({ token: t.address, limits: limitsFor(t) }));
  const rates = chosen.map((t) => ({ token: t.address, unitsPerUsd: unitsPerUsd(t) }));

  // 5b. LokalTags (or resume with an existing one).
  let tagsAddress: string;
  if (resumeTags) {
    if ((await provider.getCode(resumeTags)) === "0x") fail(`TAGS_ADDRESS ${resumeTags} has no code`);
    const existing = await ethers.getContractAt("LokalTags", resumeTags, wallet);
    if ((await existing.payoutWallet()) !== payoutWallet) fail("TAGS_ADDRESS has a different payout wallet");
    if ((await existing.owner()) !== wallet.address) fail("TAGS_ADDRESS is not owned by the deployer; nothing to resume");
    tagsAddress = resumeTags;
    console.log(`  LokalTags: resuming with ${tagsAddress}`);
    record.LokalTags = record.LokalTags ?? { address: tagsAddress };
  } else {
    const data = tag((await tagsFactory.getDeployTransaction(payoutWallet, reserved, setup)).data);
    const gas = await provider.estimateGas({ from: wallet.address, data });
    const rc = await mined("LokalTags", await wallet.sendTransaction({ data, gasLimit: (gas * 12n) / 10n }));
    tagsAddress = rc.contractAddress!;
    record.LokalTags = { address: tagsAddress, txHash: rc.hash, blockNumber: rc.blockNumber };
  }
  const tags = await ethers.getContractAt("LokalTags", tagsAddress, wallet);
  if ((await tags.payoutWallet()) !== payoutWallet) fail("LokalTags deployed, but payoutWallet reads back wrong");
  record.tokens = chosen.map((t, i) => ({ symbol: t.symbol, address: t.address, decimals: t.decimals, limits: stringify(setup[i].limits), unitsPerUsd: String(rates[i].unitsPerUsd) }));
  save("LokalTags");

  // 5c. LokalPots, pointing at it.
  const potsArgs = [tagsAddress, potMax.cap, potMax.perPayer, potMax.perHostDaily, potMax.daily, rates] as const;
  const potsData = tag((await potsFactory.getDeployTransaction(...potsArgs)).data);
  const potsGas = await provider.estimateGas({ from: wallet.address, data: potsData });
  const rc2 = await mined("LokalPots", await wallet.sendTransaction({ data: potsData, gasLimit: (potsGas * 12n) / 10n }));
  const potsAddress = rc2.contractAddress!;
  record.LokalPots = { address: potsAddress, txHash: rc2.hash, blockNumber: rc2.blockNumber };
  record.pots = { maxPotCapUsd6: String(potMax.cap), maxPerPayerCapUsd6: String(potMax.perPayer), maxPerHostDailyUsd6: String(potMax.perHostDaily), maxDailyUsd6: String(potMax.daily) };
  save("LokalPots");

  // 5d. Hand the admin to the owner's wallet (two-step: they accept).
  if (newOwner) {
    const data = tag(tags.interface.encodeFunctionData("transferOwnership", [newOwner]));
    const rc3 = await mined("transferOwnership", await wallet.sendTransaction({ to: tagsAddress, data }));
    record.ownerTransfer = { to: newOwner, txHash: rc3.hash, accepted: false };
    save("transferOwnership");
    if ((await tags.pendingOwner()) !== newOwner) fail("transferOwnership mined, but pendingOwner reads back wrong");
  }

  // 6. Constructor arguments for verification.
  const dir = path.dirname(recordFile);
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const tagsArgs = [payoutWallet, reserved, setup.map((s) => ({ token: s.token, limits: stringify(s.limits) }))];
  const potsArgsJson = [tagsAddress, String(potMax.cap), String(potMax.perPayer), String(potMax.perHostDaily), String(potMax.daily), rates.map((r) => ({ token: r.token, unitsPerUsd: String(r.unitsPerUsd) }))];
  const writeArgs = (name: string, address: string, args: unknown, hex: string) => {
    fs.writeFileSync(path.join(dir, `${name}.args.js`), `// Constructor arguments of ${name} at ${address} (for hardhat verify).\nmodule.exports = ${JSON.stringify(args, null, 2)};\n`);
    fs.writeFileSync(path.join(dir, `${name}.args.hex`), hex + "\n");
  };
  const tagsCtor = tagsFactory.interface.deploy;
  const potsCtor = potsFactory.interface.deploy;
  writeArgs("LokalTags", tagsAddress, tagsArgs, coder.encode(tagsCtor.inputs, [payoutWallet, reserved, setup]).slice(2));
  writeArgs("LokalPots", potsAddress, potsArgsJson, coder.encode(potsCtor.inputs, [...potsArgs]).slice(2));
  save("done");

  const explorer = rehearsal ? "https://celo-sepolia.blockscout.com" : "https://celo.blockscout.com";
  console.log(`\nLokalTags  ${tagsAddress}`);
  console.log(`LokalPots  ${potsAddress}`);
  console.log(`  ${explorer}/address/${tagsAddress}\n  ${explorer}/address/${potsAddress}`);
  if (newOwner) console.log(`\nNext: ${newOwner} calls acceptOwnership() on LokalTags (it then administers LokalPots too).`);
  console.log("\nVerify the source (no API key needed: Sourcify and Blockscout; Celoscan too if ETHERSCAN_API_KEY is set):");
  console.log(`  npx hardhat verify --network ${network.name} ${tagsAddress} --constructor-args ${path.relative(process.cwd(), dir)}/LokalTags.args.js`);
  console.log(`  npx hardhat verify --network ${network.name} ${potsAddress} --constructor-args ${path.relative(process.cwd(), dir)}/LokalPots.args.js`);
  console.log("  If a verifier asks for ABI-encoded constructor arguments, paste the matching .args.hex file. If it derives them");
  console.log("  from the creation transaction instead, they end with the 50-byte ERC-8021 suffix");
  console.log(`  ${attribution ? attributionSuffix(ATTRIBUTION_CODE) : "(none: ATTRIBUTION=off)"}; strip it, or paste the raw input with it if asked for the full hex.`);
  console.log(`\nThen run \`npx hardhat run scripts/export-abi.ts --network ${network.name}\` to write deployments/LokalTags.json and LokalPots.json.`);
}

main().catch((e) => {
  // Never echo objects that might carry a signer; print the message only.
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
