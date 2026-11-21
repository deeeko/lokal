import type { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import { CELO_CHAIN_ID, CELO_RPC_URL, CELO_SEPOLIA_CHAIN_ID, CELO_SEPOLIA_RPC_URL } from "./config/celo";

// No keys are read here. The deploy script loads the agent key itself, only when it is about to send (scripts/deploy.ts).
const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.30",
    settings: {
      // Celo mainnet supports Cancun; pinning it keeps the bytecode independent of the compiler's default.
      evmVersion: "cancun",
      optimizer: { enabled: true, runs: 10_000 },
    },
  },
  paths: {
    // "tests", not "test": the repo root runs `node --test`, which picks up every *.ts file under a folder named test.
    tests: "./tests",
  },
  networks: {
    hardhat: {
      // The local chain the tests and demo run on. Prague (a superset of the Cancun bytecode target) so EIP-7702
      // delegated wallets behave exactly as they do on a Pectra chain.
      hardfork: "prague",
    },
    celo: {
      url: process.env.CELO_RPC_URL || CELO_RPC_URL,
      chainId: CELO_CHAIN_ID,
    },
    // Rehearsal network (testnet): `npm run deploy:sepolia` deploys mock tokens there first, then both contracts.
    celoSepolia: {
      url: process.env.CELO_SEPOLIA_RPC_URL || CELO_SEPOLIA_RPC_URL,
      chainId: CELO_SEPOLIA_CHAIN_ID,
    },
  },
  // Verification. Sourcify and Blockscout need no API key; Celoscan (Etherscan v2) runs only when ETHERSCAN_API_KEY is set.
  etherscan: {
    enabled: Boolean(process.env.ETHERSCAN_API_KEY),
    apiKey: process.env.ETHERSCAN_API_KEY || "",
    customChains: [
      {
        network: "celo",
        chainId: CELO_CHAIN_ID,
        urls: { apiURL: "https://api.etherscan.io/v2/api?chainid=42220", browserURL: "https://celoscan.io" },
      },
      {
        network: "celoSepolia",
        chainId: CELO_SEPOLIA_CHAIN_ID,
        urls: { apiURL: "https://api.etherscan.io/v2/api?chainid=11142220", browserURL: "https://sepolia.celoscan.io" },
      },
    ],
  },
  sourcify: {
    enabled: true,
  },
  blockscout: {
    enabled: true,
    customChains: [
      {
        network: "celo",
        chainId: CELO_CHAIN_ID,
        urls: { apiURL: "https://celo.blockscout.com/api", browserURL: "https://celo.blockscout.com" },
      },
      {
        network: "celoSepolia",
        chainId: CELO_SEPOLIA_CHAIN_ID,
        urls: { apiURL: "https://celo-sepolia.blockscout.com/api", browserURL: "https://celo-sepolia.blockscout.com" },
      },
    ],
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
  },
  typechain: {
    outDir: "typechain-types",
    target: "ethers-v6",
  },
  mocha: {
    timeout: 180_000,
  },
};

export default config;
