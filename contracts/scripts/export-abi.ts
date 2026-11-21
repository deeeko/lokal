/**
 * Writes the files the site and the agent read, into contracts/deployments/:
 *   LokalTags.abi.json, LokalPots.abi.json   the ABIs only (events, errors, functions)
 *   LokalTags.json, LokalPots.json           { contractName, chainId, address, deployment, abi } (+ tokens, pots)
 *                                            address is null until deployed
 *
 *   cd contracts && npm run abi
 *
 * Addresses come from deployments/celo-42220.json, which `npm run deploy:celo` writes. Read-only otherwise.
 * With `--network celoSepolia` it reads the rehearsal record and writes LokalTags.celoSepolia.json instead.
 */
import fs from "node:fs";
import path from "node:path";
import { artifacts, network } from "hardhat";
import { CELO_CHAIN_ID, CELO_SEPOLIA_CHAIN_ID, POT_DEFAULTS, TOKENS, defaultLimits, unitsPerUsd } from "../config/celo";

async function main() {
  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  const sepolia = network.name === "celoSepolia";
  const chainId = sepolia ? CELO_SEPOLIA_CHAIN_ID : CELO_CHAIN_ID;
  const recordFile = path.join(dir, sepolia ? `celoSepolia-${chainId}.json` : `celo-${chainId}.json`);
  const suffix = sepolia ? ".celoSepolia" : "";
  const record = fs.existsSync(recordFile) ? JSON.parse(fs.readFileSync(recordFile, "utf8")) : null;

  const tokens = record?.tokens ?? TOKENS.map((t) => ({
    symbol: t.symbol, address: t.address, decimals: t.decimals,
    limits: Object.fromEntries(Object.entries(defaultLimits(t)).map(([k, v]) => [k, String(v)])),
    unitsPerUsd: String(unitsPerUsd(t)),
  }));
  const pots = record?.pots ?? Object.fromEntries(Object.entries(POT_DEFAULTS).map(([k, v]) => [k, String(v)]));

  const write = (name: string, value: unknown) => {
    fs.writeFileSync(path.join(dir, name), JSON.stringify(value, null, 2) + "\n");
    console.log(`wrote deployments/${name}`);
  };
  for (const name of ["LokalTags", "LokalPots"] as const) {
    const artifact = await artifacts.readArtifact(name);
    const d = record?.[name] ?? null;
    write(`${name}.abi.json`, artifact.abi);
    write(`${name}${suffix}.json`, {
      contractName: name,
      chainId,
      address: d?.address ?? null,
      deployment: d ? { txHash: d.txHash, blockNumber: d.blockNumber, deployer: record.deployer, payoutWallet: record.payoutWallet } : null,
      ...(name === "LokalTags" ? { tokens } : { pots, tokens: tokens.map((t: any) => ({ symbol: t.symbol, address: t.address, decimals: t.decimals, unitsPerUsd: t.unitsPerUsd })) }),
      abi: artifact.abi,
    });
  }
  if (!record) console.log("Not deployed yet: addresses are null. Run `npm run deploy:celo` first, then `npm run abi` again.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
