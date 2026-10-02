/**
 * Hedera testnet addresses for deploy/00_deploy_stable_checkout.ts and scripts/demo-pay.ts.
 *
 * Hedera entity 0.0.N maps to the EVM "long-zero" address 0x + N as 40 hex digits.
 * Testnet is reset from time to time; re-check these against the sources before a demo.
 */
export const HEDERA_TESTNET = {
  chainId: 296,

  // SaucerSwapV1RouterV3, 0.0.19264.
  // https://docs.saucerswap.finance/developers/contracts (Hedera testnet table)
  saucerSwapRouter: "0x0000000000000000000000000000000000004b40",

  // WHBAR token 0.0.15058 (the WHBAR contract is 0.0.15057). SaucerSwap swap paths start with the token.
  // https://docs.saucerswap.finance/developers/contracts
  // https://docs.saucerswap.finance/developers/v1/swap/swap-quote ("use the wrapped HBAR token ID")
  whbarToken: "0x0000000000000000000000000000000000003ad2",

  // USDC 0.0.5449 (6 decimals), the USDC that SaucerSwap's testnet pools trade. Circle's testnet USDC
  // (0.0.429274, https://developers.circle.com/stablecoins/usdc-contract-addresses) has no SaucerSwap testnet pool.
  // Pool: SaucerSwapV1Factory 0.0.9959 getPair(WHBAR, USDC) = 0.0.2661044, also listed by the SaucerSwap testnet
  // REST API https://test-api.saucerswap.finance/pools (https://docs.saucerswap.finance/api-reference/overview).
  usdcToken: "0x0000000000000000000000000000000000001549",
  usdcTokenId: "0.0.5449",

  // Chainlink HBAR / USD proxy on Hedera testnet: 8 decimals, 24 h heartbeat, 0.5% deviation threshold.
  // https://docs.chain.link/data-feeds/price-feeds/addresses?network=hedera
  hbarUsdFeed: "0x59bC155EB6c6C415fE43255aF66EcF0523c92B4a",

  // Oldest answer pay() accepts: the 24 h heartbeat plus one hour of slack.
  maxPriceAge: 25 * 60 * 60,

  mirrorNodeUrl: "https://testnet.mirrornode.hedera.com",
  hashscanUrl: "https://hashscan.io/testnet",
} as const;
