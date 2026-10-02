/**
 * Hedera mainnet addresses. Used by the mainnet fork test (`yarn fork:test`) and by
 * `yarn hardhat:deploy --network hederaMainnet`. Same 0.0.N to long-zero mapping as hedera-testnet.ts.
 */
export const HEDERA_MAINNET = {
  chainId: 295,

  // SaucerSwapV1RouterV3, 0.0.3045981.
  // https://docs.saucerswap.finance/developers/contracts (Hedera mainnet, V1 table)
  saucerSwapRouter: "0x00000000000000000000000000000000002e7a5d",

  // WHBAR token 0.0.1456986 (the WHBAR contract is 0.0.1456985).
  // https://docs.saucerswap.finance/developers/contracts (WHBAR and wrappers table)
  whbarToken: "0x0000000000000000000000000000000000163b5a",

  // Circle USDC 0.0.456858 (6 decimals). https://developers.circle.com/stablecoins/usdc-contract-addresses
  // V1 pool: SaucerSwapV1Factory 0.0.1062784 getPair(WHBAR, USDC) = 0.0.1462797.
  usdcToken: "0x000000000000000000000000000000000006f89a",
  usdcTokenId: "0.0.456858",

  // Chainlink HBAR / USD proxy on Hedera mainnet: 8 decimals, 24 h heartbeat, 0.5% deviation threshold.
  // https://docs.chain.link/data-feeds/price-feeds/addresses?network=hedera
  hbarUsdFeed: "0xAF685FB45C12b92b5054ccb9313e135525F9b5d5",

  maxPriceAge: 25 * 60 * 60,

  mirrorNodeUrl: "https://mainnet-public.mirrornode.hedera.com",
  hashscanUrl: "https://hashscan.io/mainnet",
} as const;
