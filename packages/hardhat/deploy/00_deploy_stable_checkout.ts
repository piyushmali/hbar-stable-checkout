import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { HEDERA_MAINNET } from "../config/hedera-mainnet";
import { HEDERA_TESTNET } from "../config/hedera-testnet";
import { getDeployGasPrice } from "../utils/getDeployGasPrice";

/**
 * Deploys StableCheckout wired to the SaucerSwap V1 router, the Chainlink HBAR/USD feed and USDC.
 * The constructor associates the contract with USDC through HTS (0x167) and reverts if that fails,
 * so a successful deploy is ready to receive swap output.
 *
 * hederaMainnet reads config/hedera-mainnet.ts. Every other network (hederaTestnet, or the local
 * testnet fork from `yarn hardhat:chain`) reads config/hedera-testnet.ts.
 */
const deployStableCheckout: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const addresses = hre.network.name === "hederaMainnet" ? HEDERA_MAINNET : HEDERA_TESTNET;

  const deployment = await hre.deployments.deploy("StableCheckout", {
    from: deployer,
    args: [
      addresses.saucerSwapRouter,
      addresses.hbarUsdFeed,
      addresses.whbarToken,
      addresses.usdcToken,
      addresses.maxPriceAge,
    ],
    log: true,
    autoMine: true,
    // The relay's estimate does not cover the HTS association in the constructor.
    gasLimit: 4_000_000,
    gasPrice: await getDeployGasPrice(hre),
  });

  if (hre.network.name.startsWith("hedera")) {
    console.log(`🔎 ${addresses.hashscanUrl}/contract/${deployment.address}`);
  }
};

export default deployStableCheckout;

deployStableCheckout.tags = ["StableCheckout"];
