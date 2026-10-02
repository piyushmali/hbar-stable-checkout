/**
 * Fallback when Hedera testnet is down or its pools are unusable: check StableCheckout against the live
 * mainnet Chainlink HBAR/USD feed and SaucerSwap V1 WHBAR/USDC pool on a local Hardhat fork. Read-only:
 * nothing is sent to Hedera, and no swap is executed (see the note on WHBAR below).
 *
 *   yarn fork:test
 *
 * Two workarounds for @hashgraph/system-contracts-forking 0.1.2, which emulates HTS at 0x167:
 * - It serves every long-zero address (0x000…0N) as an HTS token, so long-zero *contracts* such as the
 *   SaucerSwap router and factory load without code. Their mainnet bytecode is copied onto the fork.
 * - It only associates accounts that exist on mainnet. Fork-local addresses get an unused account number.
 * The emulator cannot mint WHBAR (the WHBAR contract reverts with "Safe mint failed!"), so pay() itself is
 * covered by the hermetic tests and by the real testnet payment from `yarn hardhat:demo-pay`.
 */
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { HEDERA_MAINNET } from "../config/hedera-mainnet";
import type { StableCheckout } from "../typechain-types";

const HTS = "0x0000000000000000000000000000000000000167";
const MAINNET_RPC = process.env.HEDERA_MAINNET_RPC_URL || "https://mainnet.hashio.io/api";
const INVOICE_USD6 = 5_000_000n; // $5.00
const SLIPPAGE_BPS = 300; // the contract's maximum; the V1 LP fee alone is 0.3%
const ROUTER_ABI = [
  "function factory() view returns (address)",
  "function WHBAR() view returns (address)",
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)",
];

async function loadLongZeroContracts(router: string) {
  const mainnet = new ethers.JsonRpcProvider(MAINNET_RPC, undefined, { batchMaxCount: 1 });
  const live = new ethers.Contract(router, ROUTER_ABI, mainnet);
  for (const address of [router, await live.factory(), await live.WHBAR()]) {
    await network.provider.send("hardhat_setCode", [address, await mainnet.getCode(address)]);
  }
}

async function registerWithHtsEmulator(address: string, accountNum: number) {
  // Slot layout of HtsSystemContract.getAccountId(address): selector, 8 zero bytes, address. Value: exists flag + id.
  const slot = `0xe0b490f7${"0".repeat(16)}${address.slice(2).toLowerCase()}`;
  const value = `0x01${accountNum.toString(16).padStart(62, "0")}`;
  await network.provider.send("hardhat_setStorageAt", [HTS, slot, value]);
}

describe("StableCheckout on a Hedera mainnet fork (read-only)", function () {
  // Every cold storage slot is fetched from the mainnet relay or mirror node.
  this.timeout(10 * 60 * 1000);

  let checkout: StableCheckout;
  let invoiceId: string;

  before(async function () {
    const [deployer] = await ethers.getSigners();
    await loadLongZeroContracts(HEDERA_MAINNET.saucerSwapRouter);
    const nonce = await ethers.provider.getTransactionCount(deployer.address);
    await registerWithHtsEmulator(ethers.getCreateAddress({ from: deployer.address, nonce }), 0x7f000001);

    checkout = await ethers.deployContract("StableCheckout", [
      HEDERA_MAINNET.saucerSwapRouter,
      HEDERA_MAINNET.hbarUsdFeed,
      HEDERA_MAINNET.whbarToken,
      HEDERA_MAINNET.usdcToken,
      HEDERA_MAINNET.maxPriceAge,
    ]);
    await checkout.registerMerchant(deployer.address, SLIPPAGE_BPS);
    invoiceId = ethers.id("fork-invoice");
    await checkout.createInvoice(invoiceId, INVOICE_USD6, (await time.latest()) + 3600);
  });

  it("reads a fresh, positive HBAR/USD answer from the live Chainlink feed", async function () {
    const [price, updatedAt] = await checkout.latestPrice();
    expect(price).to.be.greaterThan(0n);
    expect(BigInt(await time.latest()) - updatedAt).to.be.lessThanOrEqual(BigInt(HEDERA_MAINNET.maxPriceAge));

    const tinybars = await checkout.quoteTinybars(INVOICE_USD6);
    expect(await checkout.quoteUsdc(tinybars)).to.be.greaterThanOrEqual(INVOICE_USD6);
    expect(await checkout.quoteUsdc(tinybars - 1n)).to.be.lessThan(INVOICE_USD6);
  });

  it("quotes the live SaucerSwap pool through the configured path and clears the oracle floor", async function () {
    const tinybars = await checkout.quoteTinybars(INVOICE_USD6);
    const [oracleUsdc, minUsdcOut, poolUsdc] = await checkout.previewPay(invoiceId, tinybars);
    const router = new ethers.Contract(HEDERA_MAINNET.saucerSwapRouter, ROUTER_ABI, ethers.provider);
    const [, routerUsdc] = await router.getAmountsOut(tinybars, [HEDERA_MAINNET.whbarToken, HEDERA_MAINNET.usdcToken]);

    console.log(
      `      $5.00 = ${ethers.formatUnits(tinybars, 8)} HBAR. Oracle value ${ethers.formatUnits(oracleUsdc, 6)}, ` +
        `floor ${ethers.formatUnits(minUsdcOut, 6)}, pool pays ${ethers.formatUnits(poolUsdc, 6)} USDC`,
    );
    expect(poolUsdc).to.equal(routerUsdc);
    expect(poolUsdc, "mainnet pool is more than 3% under Chainlink right now").to.be.greaterThanOrEqual(minUsdcOut);
  });
});
