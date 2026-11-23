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
    name: "LokalPay",
    description:
      "LokalPay (formerly Naira Payout): pay anyone in their local money. Payers send USD₮ on Celo to a LokalPay tag or payment link; the LokalTags and LokalPots contracts check every limit before money moves, and the agent converts on Textile FX and pays the recipient's own wallet in naira (cNGN), rupiah (IDRX), Argentine or Colombian pesos (wARS, wCOP) or dollars. Non-custodial, capped, refundable, and every transaction carries the ERC-8021 tag.",
    services: [
      { name: "web", endpoint: "https://lokalpay.vercel.app" },
      { name: "source", endpoint: repoUrl },
    ],
    x402Support: false,
    active: true,
    supportedTrust: ["reputation"],
    ...(agentId ? { registrations: [{ agentId, agentRegistry: `eip155:42220:${IDENTITY_REGISTRY}` }] } : {}),
  };
}

/**
 * Rewrites the agent card of an existing identity (setAgentURI), e.g. after the rename to LokalPay. Dry run by default:
 * prints the new card and the current one. Only the identity's owner (the agent wallet) can send it.
 */
export async function updateCard({ repoUrl, agentId, execute = false }) {
  const account = loadAccount();
  const { pub, wallet } = makeClients(account);
  const card = registrationFile({ repoUrl, agentId });
  const uri = toDataUri(card);
  console.log(`Identity ${agentId}, owner check by simulation from ${account.address}`);
  console.log(JSON.stringify(card, null, 2));
  const { request } = await pub.simulateContract({ account, address: IDENTITY_REGISTRY, abi, functionName: "setAgentURI", args: [BigInt(agentId), uri] });
  if (!execute) { console.log("DRY RUN: the update simulates cleanly. Add --execute to send it (one transaction, gas only)."); return; }
  const hash = await wallet.writeContract(request);
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw new Error(`setAgentURI failed: ${hash}`);
  console.log(`Agent card updated. tx=https://celoscan.io/tx/${hash}`);
  return { hash };
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
