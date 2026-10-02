import { expect } from "chai";
import { ethers, network } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

// Hermetic: HTS, SaucerSwap and Chainlink are the mocks in contracts/mocks, no RPC is touched.
// Hedera's EVM denominates msg.value in tinybars, so these tests send tinybar amounts as `value`.
// Over the JSON-RPC relay the same payment is sent as tinybars * 10^10 weibars.
const TINYBARS_PER_HBAR = 10n ** 8n;
const USDC = 10n ** 6n;
const HTS_ADDRESS = "0x0000000000000000000000000000000000000167";
const WHBAR = "0x0000000000000000000000000000000000003ad2";
const PRICE = 10_000_000n; // $0.10 per HBAR with the 8 decimals of Chainlink's Hedera feed
const MAX_PRICE_AGE = 25 * 60 * 60;
const SLIPPAGE_BPS = 100n;
const POOL_USDC_PER_HBAR = 99_700n; // the pool pays 0.3% under the oracle, like the V1 LP fee
const INVOICE_USD = 25n * USDC;

const Status = { None: 0n, Open: 1n, Paid: 2n, Expired: 3n };
const applySlippage = (amount: bigint) => (amount * (10_000n - SLIPPAGE_BPS)) / 10_000n;

async function deployCheckout() {
  const [owner, merchant, payout, payer, stranger] = await ethers.getSigners();

  // Install the HTS mock where Hedera's system contract lives.
  const htsImplementation = await ethers.deployContract("MockHTS");
  await network.provider.send("hardhat_setCode", [HTS_ADDRESS, await ethers.provider.getCode(htsImplementation)]);
  const hts = await ethers.getContractAt("MockHTS", HTS_ADDRESS);

  const usdc = await ethers.deployContract("MockUSDC");
  const router = await ethers.deployContract("MockRouter", [WHBAR, usdc, POOL_USDC_PER_HBAR]);
  await usdc.mint(router, 1_000_000n * USDC);
  const feed = await ethers.deployContract("MockAggregator", [8, PRICE]);
  const checkout = await ethers.deployContract("StableCheckout", [router, feed, WHBAR, usdc, MAX_PRICE_AGE]);

  await hts.connect(payout).associateToken(payout.address, usdc);
  await checkout.connect(merchant).registerMerchant(payout.address, SLIPPAGE_BPS);

  return { owner, merchant, payout, payer, stranger, hts, usdc, router, feed, checkout };
}

async function deployWithInvoice() {
  const context = await deployCheckout();
  const invoiceId = ethers.id("invoice-1");
  const expiry = (await time.latest()) + 3600;
  await context.checkout.connect(context.merchant).createInvoice(invoiceId, INVOICE_USD, expiry);
  return { ...context, invoiceId, expiry };
}

describe("StableCheckout", function () {
  describe("deployment", function () {
    it("associates itself with USDC through the HTS system contract", async function () {
      const { hts, usdc, checkout } = await loadFixture(deployCheckout);
      expect(await hts.isAssociated(usdc, checkout)).to.equal(true);
      await expect(checkout.deploymentTransaction())
        .to.emit(checkout, "SettlementTokenAssociated")
        .withArgs(await usdc.getAddress());
    });

    it("accepts TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT from HTS", async function () {
      const { hts, usdc, router, feed } = await loadFixture(deployCheckout);
      await hts.setForcedAssociateCode(194);
      await expect(ethers.deployContract("StableCheckout", [router, feed, WHBAR, usdc, MAX_PRICE_AGE])).to.not.be
        .reverted;
    });

    it("reverts when HTS association returns an error code", async function () {
      const { hts, usdc, router, feed } = await loadFixture(deployCheckout);
      await hts.setForcedAssociateCode(167); // INVALID_TOKEN_ID
      const factory = await ethers.getContractFactory("StableCheckout");
      await expect(factory.deploy(router, feed, WHBAR, usdc, MAX_PRICE_AGE))
        .to.be.revertedWithCustomError(factory, "AssociationFailed")
        .withArgs(167);
    });

    it("rejects a settlement token without 6 decimals", async function () {
      const { router, feed } = await loadFixture(deployCheckout);
      const factory = await ethers.getContractFactory("StableCheckout");
      // The feed reports 8 decimals, which makes it a convenient non-USDC "token".
      await expect(factory.deploy(router, feed, WHBAR, feed, MAX_PRICE_AGE))
        .to.be.revertedWithCustomError(factory, "UnsupportedTokenDecimals")
        .withArgs(8);
    });
  });

  describe("quotes", function () {
    it("converts between tinybars and 6-decimal USD at the oracle price", async function () {
      const { checkout, feed } = await loadFixture(deployCheckout);
      // README worked example: $25.00 at $0.10 is 250 HBAR = 25,000,000,000 tinybars.
      expect(await checkout.quoteTinybars(INVOICE_USD)).to.equal(250n * TINYBARS_PER_HBAR);
      expect(await checkout.quoteUsdc(250n * TINYBARS_PER_HBAR)).to.equal(INVOICE_USD);

      // A real-looking answer: $0.09941264. The tinybar quote rounds up, the USD value rounds down.
      await feed.setAnswer(9_941_264n);
      const tinybars = await checkout.quoteTinybars(INVOICE_USD);
      expect(tinybars).to.equal(25_147_707_576n);
      expect(await checkout.quoteUsdc(tinybars)).to.equal(INVOICE_USD);
      expect(await checkout.quoteUsdc(tinybars - 1n)).to.be.lessThan(INVOICE_USD);
    });

    it("previews the oracle floor and the pool output that pay() will check", async function () {
      const { checkout, invoiceId } = await loadFixture(deployWithInvoice);
      const tinybars = 250n * TINYBARS_PER_HBAR;
      const [oracleUsdc, minUsdcOut, poolUsdc] = await checkout.previewPay(invoiceId, tinybars);
      expect(oracleUsdc).to.equal(INVOICE_USD);
      expect(minUsdcOut).to.equal(applySlippage(INVOICE_USD));
      expect(poolUsdc).to.equal((tinybars * POOL_USDC_PER_HBAR) / TINYBARS_PER_HBAR);
    });
  });

  describe("pay", function () {
    it("swaps the HBAR to USDC and pays the merchant's payout account in one transaction", async function () {
      const { checkout, usdc, router, merchant, payout, payer, invoiceId } = await loadFixture(deployWithInvoice);
      const tinybars = await checkout.quoteTinybars(INVOICE_USD);
      const usdcOut = (tinybars * POOL_USDC_PER_HBAR) / TINYBARS_PER_HBAR; // 24.925 USDC
      const paidAt = (await time.latest()) + 10;
      await time.setNextBlockTimestamp(paidAt);

      const tx = checkout.connect(payer).pay(invoiceId, { value: tinybars });

      await expect(tx)
        .to.emit(checkout, "InvoicePaid")
        .withArgs(invoiceId, merchant.address, payer.address, tinybars, usdcOut, PRICE, paidAt);
      await expect(tx).to.changeTokenBalances(usdc, [payout, checkout, router], [usdcOut, 0n, -usdcOut]);
      await expect(tx).to.changeEtherBalances([payer, checkout, router], [-tinybars, 0n, tinybars]);
      expect((await checkout.invoiceOf(invoiceId)).status).to.equal(Status.Paid);
    });

    it("floors the swap at the oracle value of everything sent, not just the invoice", async function () {
      const { checkout, router, payer, invoiceId } = await loadFixture(deployWithInvoice);
      const tinybars = 2n * (await checkout.quoteTinybars(INVOICE_USD)); // the customer sends twice the price
      await router.setUsdcPerHbar(98_000n); // 2% under the oracle: still more than the invoice, but under the floor

      const minUsdcOut = applySlippage(2n * INVOICE_USD);
      const poolUsdc = (tinybars * 98_000n) / TINYBARS_PER_HBAR;
      expect(poolUsdc).to.be.greaterThan(INVOICE_USD);
      await expect(checkout.connect(payer).pay(invoiceId, { value: tinybars }))
        .to.be.revertedWithCustomError(checkout, "PoolBelowFloor")
        .withArgs(poolUsdc, minUsdcOut);
    });

    it("reverts when a thin or skewed pool pays less than the oracle floor", async function () {
      const { checkout, router, payer, invoiceId } = await loadFixture(deployWithInvoice);
      const tinybars = await checkout.quoteTinybars(INVOICE_USD);
      await router.setUsdcPerHbar(98_000n); // 2% under the oracle, merchant tolerates 1%

      await expect(checkout.connect(payer).pay(invoiceId, { value: tinybars }))
        .to.be.revertedWithCustomError(checkout, "PoolBelowFloor")
        .withArgs(24_500_000n, applySlippage(INVOICE_USD));
    });

    it("reverts on a stale price", async function () {
      const { checkout, feed, payer, invoiceId } = await loadFixture(deployWithInvoice);
      const tinybars = await checkout.quoteTinybars(INVOICE_USD);
      const updatedAt = BigInt(await time.latest()) - BigInt(MAX_PRICE_AGE) - 1n;
      await feed.setRound(2, PRICE, updatedAt, 2);

      await expect(checkout.connect(payer).pay(invoiceId, { value: tinybars }))
        .to.be.revertedWithCustomError(checkout, "StalePrice")
        .withArgs(updatedAt, MAX_PRICE_AGE);
    });

    it("reverts on a zero or negative price", async function () {
      const { checkout, feed, payer, invoiceId } = await loadFixture(deployWithInvoice);
      for (const answer of [0n, -1n]) {
        await feed.setAnswer(answer);
        await expect(checkout.connect(payer).pay(invoiceId, { value: 250n * TINYBARS_PER_HBAR }))
          .to.be.revertedWithCustomError(checkout, "InvalidPrice")
          .withArgs(answer);
      }
    });

    it("reverts on an incomplete round", async function () {
      const { checkout, feed, payer, invoiceId } = await loadFixture(deployWithInvoice);
      await feed.setRound(5, PRICE, await time.latest(), 4);
      await expect(
        checkout.connect(payer).pay(invoiceId, { value: 250n * TINYBARS_PER_HBAR }),
      ).to.be.revertedWithCustomError(checkout, "IncompleteRound");
    });

    it("reverts once the invoice has expired", async function () {
      const { checkout, payer, invoiceId, expiry } = await loadFixture(deployWithInvoice);
      const tinybars = await checkout.quoteTinybars(INVOICE_USD);
      await time.increaseTo(expiry + 1);

      expect((await checkout.invoiceOf(invoiceId)).status).to.equal(Status.Expired);
      await expect(checkout.connect(payer).pay(invoiceId, { value: tinybars }))
        .to.be.revertedWithCustomError(checkout, "InvoiceExpired")
        .withArgs(invoiceId, expiry);
    });

    it("reverts a second payment of the same invoice", async function () {
      const { checkout, payer, invoiceId } = await loadFixture(deployWithInvoice);
      const tinybars = await checkout.quoteTinybars(INVOICE_USD);
      await checkout.connect(payer).pay(invoiceId, { value: tinybars });

      await expect(checkout.connect(payer).pay(invoiceId, { value: tinybars }))
        .to.be.revertedWithCustomError(checkout, "InvoiceNotOpen")
        .withArgs(invoiceId);
    });

    it("reverts when the HBAR sent is worth less than the invoice", async function () {
      const { checkout, payer, invoiceId } = await loadFixture(deployWithInvoice);
      const tinybars = (await checkout.quoteTinybars(INVOICE_USD)) - 1n;

      await expect(checkout.connect(payer).pay(invoiceId, { value: tinybars }))
        .to.be.revertedWithCustomError(checkout, "Underpaid")
        .withArgs(INVOICE_USD - 1n, INVOICE_USD);
    });

    it("reverts when the payout account is not associated with USDC", async function () {
      const { checkout, merchant, stranger, payer, invoiceId } = await loadFixture(deployWithInvoice);
      await checkout.connect(merchant).updateMerchant(stranger.address, SLIPPAGE_BPS);
      const tinybars = await checkout.quoteTinybars(INVOICE_USD);

      await expect(checkout.connect(payer).pay(invoiceId, { value: tinybars }))
        .to.be.revertedWithCustomError(checkout, "PayoutNotAssociated")
        .withArgs(stranger.address);
    });

    it("reverts for an unknown invoice", async function () {
      const { checkout, payer } = await loadFixture(deployWithInvoice);
      const unknown = ethers.id("unknown");
      await expect(checkout.connect(payer).pay(unknown, { value: TINYBARS_PER_HBAR }))
        .to.be.revertedWithCustomError(checkout, "InvoiceNotFound")
        .withArgs(unknown);
    });
  });

  describe("merchants, invoices and access control", function () {
    it("registers and updates a merchant", async function () {
      const { checkout, stranger, payout } = await loadFixture(deployCheckout);
      await expect(checkout.connect(stranger).registerMerchant(stranger.address, 50))
        .to.emit(checkout, "MerchantRegistered")
        .withArgs(stranger.address, stranger.address, 50);
      await expect(checkout.connect(stranger).updateMerchant(payout.address, 300))
        .to.emit(checkout, "MerchantUpdated")
        .withArgs(stranger.address, payout.address, 300);
      expect(await checkout.merchants(stranger.address)).to.deep.equal([payout.address, 300n, true]);
    });

    it("validates merchant settings", async function () {
      const { checkout, merchant, stranger } = await loadFixture(deployCheckout);
      await expect(checkout.connect(merchant).registerMerchant(merchant.address, 100)).to.be.revertedWithCustomError(
        checkout,
        "AlreadyRegistered",
      );
      await expect(checkout.connect(stranger).registerMerchant(stranger.address, 301))
        .to.be.revertedWithCustomError(checkout, "SlippageTooHigh")
        .withArgs(301);
      await expect(checkout.connect(stranger).registerMerchant(ethers.ZeroAddress, 100)).to.be.revertedWithCustomError(
        checkout,
        "InvalidPayout",
      );
    });

    it("only lets registered merchants update settings or create invoices", async function () {
      const { checkout, stranger } = await loadFixture(deployCheckout);
      const expiry = (await time.latest()) + 3600;
      await expect(checkout.connect(stranger).updateMerchant(stranger.address, 100)).to.be.revertedWithCustomError(
        checkout,
        "NotMerchant",
      );
      await expect(
        checkout.connect(stranger).createInvoice(ethers.id("x"), INVOICE_USD, expiry),
      ).to.be.revertedWithCustomError(checkout, "NotMerchant");
    });

    it("validates invoices", async function () {
      const { checkout, merchant, invoiceId, expiry } = await loadFixture(deployWithInvoice);
      const fresh = ethers.id("invoice-2");
      await expect(checkout.connect(merchant).createInvoice(invoiceId, INVOICE_USD, expiry))
        .to.be.revertedWithCustomError(checkout, "InvoiceExists")
        .withArgs(invoiceId);
      await expect(checkout.connect(merchant).createInvoice(fresh, 0, expiry)).to.be.revertedWithCustomError(
        checkout,
        "InvalidAmount",
      );
      await expect(
        checkout.connect(merchant).createInvoice(fresh, INVOICE_USD, await time.latest()),
      ).to.be.revertedWithCustomError(checkout, "InvalidExpiry");
      await expect(checkout.connect(merchant).createInvoice(fresh, INVOICE_USD, expiry))
        .to.emit(checkout, "InvoiceCreated")
        .withArgs(fresh, merchant.address, INVOICE_USD, expiry);
      expect(await checkout.invoiceOf(fresh)).to.deep.equal([
        merchant.address,
        INVOICE_USD,
        BigInt(expiry),
        Status.Open,
      ]);
    });

    it("only lets the owner change the oracle staleness limit", async function () {
      const { checkout, owner, stranger } = await loadFixture(deployCheckout);
      await expect(checkout.connect(stranger).setMaxPriceAge(3600))
        .to.be.revertedWithCustomError(checkout, "OwnableUnauthorizedAccount")
        .withArgs(stranger.address);
      await expect(checkout.connect(owner).setMaxPriceAge(0))
        .to.be.revertedWithCustomError(checkout, "InvalidMaxPriceAge")
        .withArgs(0);
      await expect(checkout.connect(owner).setMaxPriceAge(3600)).to.emit(checkout, "MaxPriceAgeUpdated").withArgs(3600);
      expect(await checkout.maxPriceAge()).to.equal(3600n);
    });
  });
});
