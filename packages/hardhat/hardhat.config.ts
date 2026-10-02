import * as dotenv from "dotenv";
dotenv.config();
import { HardhatUserConfig, task } from "hardhat/config";
import "@nomicfoundation/hardhat-ethers";
import "@nomicfoundation/hardhat-chai-matchers";
import "@typechain/hardhat";
import "hardhat-gas-reporter";
import "solidity-coverage";

// Forking is opt-in. `yarn hardhat:chain` forks testnet, `yarn hardhat:fork` and `yarn fork:test` fork mainnet.
// Plain `yarn hardhat:test` stays hermetic: no RPC calls, HTS/SaucerSwap/Chainlink are the mocks in contracts/mocks.
const hederaForking = process.env.HEDERA_FORKING === "true";
if (hederaForking) {
  // Emulates the HTS system contract at 0x167 on the fork, reading token state from the mirror node.
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- conditional plugin load
  require("@hashgraph/system-contracts-forking/plugin");
}
import "hardhat-deploy";
import "hardhat-deploy-ethers";
import generateTsAbis from "./scripts/generateTsAbis";

const fork =
  process.env.MAINNET_FORKING_ENABLED === "true"
    ? { url: process.env.HEDERA_MAINNET_RPC_URL || "https://mainnet.hashio.io/api", chainId: 295 }
    : { url: process.env.HEDERA_RPC_URL || "https://testnet.hashio.io/api", chainId: 296 };

// Deployer key: DEPLOYER_PRIVATE_KEY in .env (ECDSA, 0x-prefixed), or the encrypted key from `yarn account:generate`,
// decrypted at deploy time into __RUNTIME_DEPLOYER_PRIVATE_KEY. Live networks get no account without one.
const deployerKey = process.env.__RUNTIME_DEPLOYER_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;
const liveAccounts = deployerKey ? [deployerKey] : [];

const config: HardhatUserConfig = {
  solidity: {
    compilers: [
      {
        version: "0.8.28",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
    ],
  },
  defaultNetwork: "hardhat",
  namedAccounts: {
    deployer: {
      default: 0,
    },
  },
  networks: {
    hardhat: hederaForking
      ? {
          forking: {
            url: fork.url,
            // @ts-expect-error - custom properties read by the hedera-forking plugin
            chainId: fork.chainId,
            workerPort: 10001,
          },
        }
      : {},
    hederaTestnet: {
      url: process.env.HEDERA_RPC_URL || "https://testnet.hashio.io/api",
      accounts: liveAccounts,
      chainId: 296,
    },
    hederaMainnet: {
      url: process.env.HEDERA_MAINNET_RPC_URL || "https://mainnet.hashio.io/api",
      accounts: liveAccounts,
      chainId: 295,
    },
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
  },
  // Contract verification: use `yarn verify:contract` (scripts/verifySourcify.ts), which talks
  // directly to the Sourcify API v2. @nomicfoundation/hardhat-verify is intentionally not used:
  // its Hardhat 2-compatible line only speaks the Sourcify API v1, which Sourcify removed in
  // July 2026. See: https://docs.sourcify.dev/blog/api-v1-brownouts/
  typechain: {
    outDir: "typechain-types",
    target: "ethers-v6",
  },
};

// Extend the deploy task to also generate TypeScript ABIs after deployment.
task("deploy").setAction(async (args, hre, runSuper) => {
  await runSuper(args);
  await generateTsAbis(hre);
});

export default config;
