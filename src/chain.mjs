// Wallet + clients. The attribution tag is attached ONCE here, where the wallet client is built,
// so every transaction this agent sends (approval, swap, payout, registration) carries it.
import fs from "node:fs";
import path from "node:path";
import { createPublicClient, createWalletClient, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { withAttribution } from "@celo/attribution-tags";
import { ATTRIBUTION_CODE, CHAIN, KEY_FILE } from "./config.mjs";

/** Creates a fresh agent key file. The private key is never printed. */
export function keygen() {
  if (fs.existsSync(KEY_FILE)) {
    return { created: false, address: JSON.parse(fs.readFileSync(KEY_FILE, "utf8")).address };
  }
  fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
  const privateKey = generatePrivateKey();
  const { address } = privateKeyToAccount(privateKey);
  fs.writeFileSync(KEY_FILE, JSON.stringify({ address, privateKey }, null, 2), { mode: 0o600 });
  return { created: true, address };
}

export function loadAccount({ required = true } = {}) {
  if (!fs.existsSync(KEY_FILE)) {
    if (required) throw new Error(`No agent key at ${KEY_FILE}. Run: node src/agent.mjs keygen`);
    return null;
  }
  const { privateKey } = JSON.parse(fs.readFileSync(KEY_FILE, "utf8"));
  return privateKeyToAccount(privateKey);
}

/** `transport`: viem's default Celo RPC (Forno); tests pass a fake one so nothing reaches the network. */
export function makeClients(account, transport = http()) {
  const pub = createPublicClient({ chain: CHAIN, transport });
  const wallet = createWalletClient({ account, chain: CHAIN, transport }).extend(
    withAttribution(ATTRIBUTION_CODE),
  );
  return { pub, wallet };
}
