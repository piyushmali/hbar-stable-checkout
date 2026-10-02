/**
 * Pays a real invoice on Hedera testnet through SaucerSwap with the Chainlink floor, using the deployer
 * account as merchant, payout and customer:
 *
 *   yarn hardhat:demo-pay
 *
 * Steps: make sure the deployer can receive USDC, register it as a merchant, create a $0.10 invoice, pay it
 * with HBAR, then print the HashScan and mirror node links plus the command that records the HCS receipt.
 * Needs DEPLOYER_PRIVATE_KEY (ECDSA, funded) in packages/hardhat/.env and a prior `yarn hardhat:deploy --network hederaTestnet`.
 */
import { deployments, ethers } from "hardhat";
import { HEDERA_TESTNET } from "../config/hedera-testnet";

const INVOICE_USD6 = 100_000n; // $0.10
const MERCHANT_SLIPPAGE_BPS = 100;
// Pay 1% over the oracle quote so a price update between quote and execution cannot underpay the invoice.
const QUOTE_BUFFER_BPS = 100n;
// The JSON-RPC relay takes `value` in weibars (18 decimals); the contract sees tinybars (8 decimals).
const WEIBARS_PER_TINYBAR = 10n ** 10n;

// HIP-719: every HTS token address answers associate() and isAssociated() for the calling account.
const HRC719_ABI = ["function associate() returns (uint256)", "function isAssociated() view returns (bool)"];

const formatUsd6 = (amount: bigint) => `$${ethers.formatUnits(amount, 6)}`;
// Hedera bills at least 80% of the gas limit, so size limits from the relay's simulation plus 20% headroom.
// The simulation also surfaces a revert reason before any HBAR is spent.
const withHeadroom = (estimate: bigint) => (estimate * 120n) / 100n;

async function hasFreeAutoAssociation(address: string): Promise<boolean> {
  const response = await fetch(`${HEDERA_TESTNET.mirrorNodeUrl}/api/v1/accounts/${address}`);
  if (!response.ok) return false;
  const { max_automatic_token_associations: slots } = (await response.json()) as {
    max_automatic_token_associations: number;
  };
  // -1 means unlimited, the default for accounts auto-created from an EVM address (HIP-904).
  return slots === -1;
}

async function main() {
  const [signer] = await ethers.getSigners();
  const { address } = await deployments.get("StableCheckout");
  const checkout = await ethers.getContractAt("StableCheckout", address, signer);
  const usdc = new ethers.Contract(HEDERA_TESTNET.usdcToken, HRC719_ABI, signer);
  console.log(`StableCheckout ${address}\nMerchant, payout and payer ${signer.address}`);

  if (await usdc.isAssociated()) {
    console.log(`Payout already associated with USDC ${HEDERA_TESTNET.usdcTokenId}`);
  } else if (await hasFreeAutoAssociation(signer.address)) {
    console.log(`Payout has unlimited auto-association: HTS associates USDC on the first payout`);
  } else {
    console.log(`Associating with USDC ${HEDERA_TESTNET.usdcTokenId}…`);
    const gasLimit = withHeadroom(await usdc.associate.estimateGas());
    await (await usdc.associate({ gasLimit })).wait();
  }

  const merchant = await checkout.merchants(signer.address);
  if (!merchant.registered) {
    console.log("Registering merchant…");
    await (await checkout.registerMerchant(signer.address, MERCHANT_SLIPPAGE_BPS)).wait();
  }

  const invoiceId = ethers.hexlify(ethers.randomBytes(32));
  const expiry = Math.floor(Date.now() / 1000) + 60 * 60;
  console.log(`Creating invoice ${invoiceId} for ${formatUsd6(INVOICE_USD6)}…`);
  await (await checkout.createInvoice(invoiceId, INVOICE_USD6, expiry)).wait();

  const quote = await checkout.quoteTinybars(INVOICE_USD6);
  const tinybars = quote + (quote * QUOTE_BUFFER_BPS) / 10_000n;
  const value = tinybars * WEIBARS_PER_TINYBAR;
  const [price] = await checkout.latestPrice();
  const [oracleUsdc, minUsdcOut, poolUsdc] = await checkout.previewPay(invoiceId, tinybars);
  console.log(
    [
      `Chainlink HBAR/USD ${ethers.formatUnits(price, 8)}`,
      `Paying ${ethers.formatUnits(tinybars, 8)} HBAR (${tinybars} tinybars, sent as ${value} weibars)`,
      `Oracle value ${formatUsd6(oracleUsdc)}, floor ${formatUsd6(minUsdcOut)}, pool quote ${formatUsd6(poolUsdc)}`,
    ].join("\n"),
  );

  const gasLimit = withHeadroom(await checkout.pay.estimateGas(invoiceId, { value }));
  const tx = await checkout.pay(invoiceId, { value, gasLimit });
  const receipt = await tx.wait();
  if (receipt?.status !== 1) throw new Error(`pay() failed: ${tx.hash}`);

  const paid = receipt.logs.map(log => checkout.interface.parseLog(log)).find(event => event?.name === "InvoicePaid");
  console.log(
    [
      "",
      `✅ Paid. Merchant received ${formatUsd6(paid?.args.usdcOut ?? 0n)} USDC (gas used ${receipt.gasUsed} of ${gasLimit})`,
      `HashScan:    ${HEDERA_TESTNET.hashscanUrl}/transaction/${tx.hash}`,
      `Mirror node: ${HEDERA_TESTNET.mirrorNodeUrl}/api/v1/contracts/results/${tx.hash}`,
      `Checkout:    http://localhost:3000/pay/${invoiceId}`,
      "",
      "Record the HCS receipt (with `yarn next:dev` running):",
      `curl -X POST http://localhost:3000/api/receipts -H 'content-type: application/json' -d '{"txHash":"${tx.hash}"}'`,
    ].join("\n"),
  );
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
