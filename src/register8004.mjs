// ERC-8004 identity registration on Celo mainnet (required by every track).
// register() mints the identity NFT to the sending wallet and publishes it as the agent wallet.
import { parseEventLogs } from "viem";
import { IDENTITY_REGISTRY } from "./config.mjs";
import { loadAccount, makeClients } from "./chain.mjs";

const abi = [
  { type: "function", name: "register", stateMutability: "nonpayable", inputs: [{ name: "agentURI", type: "string" }], outputs: [{ name: "agentId", type: "uint256" }] },
  { type: "function", name: "setAgentURI", stateMutability: "nonpayable", inputs: [{ name: "agentId", type: "uint256" }, { name: "newURI", type: "string" }], outputs: [] },
  { type: "event", name: "Registered", inputs: [{ name: "agentId", type: "uint256", indexed: true }, { name: "agentURI", type: "string" }, { name: "owner", type: "address", indexed: true }] },
];

export function registrationFile({ repoUrl, agentId } = {}) {
  return {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: "Lokal",
    description:
      "Lokal (formerly Naira Payout): pay anyone in their local money. Converts USD₮ to local stablecoins (cNGN for Nigeria today) on Textile FX and pays the recipient's own wallet on Celo. Spending is capped and recipients are checked in code.",
    services: [{ name: "web", endpoint: repoUrl }],
    x402Support: false,
    active: true,
    supportedTrust: ["reputation"],
    ...(agentId ? { registrations: [{ agentId, agentRegistry: `eip155:42220:${IDENTITY_REGISTRY}` }] } : {}),
  };
}

export const toDataUri = (obj) => "data:application/json;base64," + Buffer.from(JSON.stringify(obj)).toString("base64");

export async function register({ repoUrl, execute = false }) {
  const account = loadAccount();
  const uri = toDataUri(registrationFile({ repoUrl }));
  console.log(`Agent wallet (will own the identity): ${account.address}`);
  if (!execute) { console.log("DRY RUN: add --execute to register on Celo mainnet."); return; }

  const { pub, wallet } = makeClients(account);
  const { request } = await pub.simulateContract({ account, address: IDENTITY_REGISTRY, abi, functionName: "register", args: [uri] });
  const hash = await wallet.writeContract(request);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  // Read the id from the Registered event, not the return value (another registration may land first).
  const ev = parseEventLogs({ abi, logs: receipt.logs, eventName: "Registered" }).find((e) => e.args.owner.toLowerCase() === account.address.toLowerCase());
  if (!ev) throw new Error(`Registered event not found in ${hash}`);
  const agentId = ev.args.agentId;
  console.log(`Registered. agentId=${agentId}  tx=https://celoscan.io/tx/${hash}`);

  // Second step: embed the id in the file so callers can cross-check, then point the registry at it.
  const final = toDataUri(registrationFile({ repoUrl, agentId: Number(agentId) }));
  const h2 = await wallet.writeContract({ address: IDENTITY_REGISTRY, abi, functionName: "setAgentURI", args: [agentId, final] });
  await pub.waitForTransactionReceipt({ hash: h2 });
  console.log(`Updated agentURI with registration id. tx=https://celoscan.io/tx/${h2}`);
  return { agentId: Number(agentId), hashes: [hash, h2] };
}
