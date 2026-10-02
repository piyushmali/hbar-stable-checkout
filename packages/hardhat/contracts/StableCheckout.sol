// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { AggregatorV3Interface } from "./interfaces/AggregatorV3Interface.sol";
import { IHederaTokenService } from "./interfaces/IHederaTokenService.sol";
import { ISaucerSwapRouter } from "./interfaces/ISaucerSwapRouter.sol";

/// @title StableCheckout
/// @notice Accept HBAR, settle in USDC. `pay` swaps the customer's HBAR to USDC on SaucerSwap in the same
/// transaction and forwards the USDC to the merchant. A Chainlink HBAR/USD feed sets the minimum USDC the
/// swap must return, so a thin or manipulated pool reverts the payment instead of short-changing the merchant.
/// @dev Units. Inside the Hedera EVM, msg.value and every HBAR amount here are tinybars (8 decimals), even though
/// the JSON-RPC relay takes the transaction `value` in weibars (18 decimals) and divides it by 10^10.
/// USD amounts use 6 decimals, the same as USDC, so an invoice amount is also its USDC amount.
contract StableCheckout is Ownable, ReentrancyGuard {
    enum InvoiceStatus {
        None,
        Open,
        Paid,
        Expired
    }

    struct Merchant {
        address payout;
        uint16 maxSlippageBps;
        bool registered;
    }

    /// @dev `status` is only ever None, Open or Paid in storage. Expired is derived from `expiry` in invoiceOf.
    struct Invoice {
        address merchant;
        uint64 expiry;
        InvoiceStatus status;
        uint256 usdAmount6;
    }

    /// @notice Hedera Token Service system contract.
    address public constant HTS = address(0x167);
    uint16 public constant MAX_SLIPPAGE_BPS = 300;
    /// @notice Upper bound for maxPriceAge. Chainlink's Hedera HBAR/USD heartbeat is 24 hours.
    uint32 public constant MAX_PRICE_AGE_LIMIT = 2 days;

    // Hedera response codes: https://github.com/hashgraph/hedera-protobufs/blob/main/services/response_code.proto
    int64 private constant SUCCESS = 22;
    int64 private constant TOKEN_NOT_ASSOCIATED_TO_ACCOUNT = 184;
    int64 private constant TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT = 194;

    uint256 private constant BPS = 10_000;
    uint8 private constant TINYBAR_DECIMALS = 8;
    uint8 private constant USD_DECIMALS = 6;

    ISaucerSwapRouter public immutable router;
    AggregatorV3Interface public immutable priceFeed;
    /// @notice WHBAR HTS token, the first hop of the swap path.
    address public immutable whbar;
    /// @notice USDC HTS token merchants are paid in.
    IERC20 public immutable usdc;
    /// @dev 10^(tinybar decimals + feed decimals - USD decimals): usd6 = tinybars * answer / priceScale.
    uint256 private immutable priceScale;

    /// @notice Oldest Chainlink answer (seconds) `pay` accepts.
    uint32 public maxPriceAge;

    mapping(address merchant => Merchant) public merchants;
    mapping(bytes32 invoiceId => Invoice) private _invoices;

    event SettlementTokenAssociated(address indexed token);
    event MaxPriceAgeUpdated(uint32 maxPriceAge);
    event MerchantRegistered(address indexed merchant, address payout, uint16 maxSlippageBps);
    event MerchantUpdated(address indexed merchant, address payout, uint16 maxSlippageBps);
    event InvoiceCreated(bytes32 indexed invoiceId, address indexed merchant, uint256 usdAmount6, uint64 expiry);
    /// @param hbarIn Tinybars swapped.
    /// @param usdcOut USDC (6 decimals) sent to the merchant's payout account.
    /// @param oraclePrice Chainlink HBAR/USD answer used for the floor, in the feed's decimals (8 on Hedera).
    event InvoicePaid(
        bytes32 indexed invoiceId,
        address indexed merchant,
        address indexed payer,
        uint256 hbarIn,
        uint256 usdcOut,
        uint256 oraclePrice,
        uint256 timestamp
    );

    error ZeroAddress();
    error InvalidPayout();
    error UnsupportedTokenDecimals(uint8 decimals);
    error AssociationFailed(int64 responseCode);
    error InvalidMaxPriceAge(uint32 maxPriceAge);
    error AlreadyRegistered();
    error NotMerchant();
    error SlippageTooHigh(uint16 maxSlippageBps);
    error InvalidAmount();
    error InvalidExpiry();
    error InvoiceExists(bytes32 invoiceId);
    error InvoiceNotFound(bytes32 invoiceId);
    error InvoiceNotOpen(bytes32 invoiceId);
    error InvoiceExpired(bytes32 invoiceId, uint64 expiry);
    error IncompleteRound();
    error InvalidPrice(int256 answer);
    error StalePrice(uint256 updatedAt, uint32 maxPriceAge);
    error Underpaid(uint256 oracleUsdc, uint256 invoiceUsdc);
    error PoolBelowFloor(uint256 poolUsdc, uint256 minUsdcOut);
    error PayoutNotAssociated(address payout);
    error SettlementFailed(int64 responseCode);

    constructor(
        address router_,
        address priceFeed_,
        address whbar_,
        address usdc_,
        uint32 maxPriceAge_
    ) Ownable(msg.sender) {
        if (router_ == address(0) || priceFeed_ == address(0) || whbar_ == address(0) || usdc_ == address(0)) {
            revert ZeroAddress();
        }
        uint8 tokenDecimals = IERC20Metadata(usdc_).decimals();
        if (tokenDecimals != USD_DECIMALS) revert UnsupportedTokenDecimals(tokenDecimals);

        router = ISaucerSwapRouter(router_);
        priceFeed = AggregatorV3Interface(priceFeed_);
        whbar = whbar_;
        usdc = IERC20(usdc_);
        priceScale = uint256(10) ** (TINYBAR_DECIMALS + AggregatorV3Interface(priceFeed_).decimals() - USD_DECIMALS);
        _setMaxPriceAge(maxPriceAge_);

        // The router delivers the swap output to this contract, and HTS refuses tokens for unassociated accounts.
        int64 responseCode = IHederaTokenService(HTS).associateToken(address(this), usdc_);
        if (responseCode != SUCCESS && responseCode != TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT) {
            revert AssociationFailed(responseCode);
        }
        emit SettlementTokenAssociated(usdc_);
    }

    // ------------------------------------------------------------------ merchants

    /// @notice Register msg.sender as a merchant. `payout` must be associated with USDC before it can be paid.
    function registerMerchant(address payout, uint16 maxSlippageBps) external {
        if (merchants[msg.sender].registered) revert AlreadyRegistered();
        _writeMerchant(payout, maxSlippageBps);
        emit MerchantRegistered(msg.sender, payout, maxSlippageBps);
    }

    function updateMerchant(address payout, uint16 maxSlippageBps) external {
        if (!merchants[msg.sender].registered) revert NotMerchant();
        _writeMerchant(payout, maxSlippageBps);
        emit MerchantUpdated(msg.sender, payout, maxSlippageBps);
    }

    // ------------------------------------------------------------------ invoices

    /// @param usdAmount6 Amount due in USD with 6 decimals (1_000_000 = $1.00).
    /// @param expiry Unix time after which the invoice can no longer be paid.
    function createInvoice(bytes32 invoiceId, uint256 usdAmount6, uint64 expiry) external {
        if (!merchants[msg.sender].registered) revert NotMerchant();
        if (_invoices[invoiceId].status != InvoiceStatus.None) revert InvoiceExists(invoiceId);
        if (usdAmount6 == 0) revert InvalidAmount();
        if (expiry <= block.timestamp) revert InvalidExpiry();

        _invoices[invoiceId] = Invoice(msg.sender, expiry, InvoiceStatus.Open, usdAmount6);
        emit InvoiceCreated(invoiceId, msg.sender, usdAmount6, expiry);
    }

    /// @notice Pay an invoice with HBAR. All of msg.value is swapped; the merchant receives the whole USDC output.
    /// @dev The floor is the oracle value of msg.value minus the merchant's slippage, not of the invoice amount,
    /// so an overpayment buffer cannot be sandwiched away. msg.value must be worth at least the invoice.
    function pay(bytes32 invoiceId) external payable nonReentrant returns (uint256 usdcOut) {
        Invoice storage invoice = _invoices[invoiceId];
        if (invoice.status == InvoiceStatus.None) revert InvoiceNotFound(invoiceId);
        if (invoice.status != InvoiceStatus.Open) revert InvoiceNotOpen(invoiceId);
        if (block.timestamp > invoice.expiry) revert InvoiceExpired(invoiceId, invoice.expiry);

        Merchant memory merchant = merchants[invoice.merchant];
        (uint256 oracleUsdc, uint256 price) = _quoteUsdc(msg.value);
        if (oracleUsdc < invoice.usdAmount6) revert Underpaid(oracleUsdc, invoice.usdAmount6);

        invoice.status = InvoiceStatus.Paid;
        usdcOut = _swapHbarForUsdc(_applySlippage(oracleUsdc, merchant.maxSlippageBps));
        _sendUsdc(merchant.payout, usdcOut);

        emit InvoicePaid(invoiceId, invoice.merchant, msg.sender, msg.value, usdcOut, price, block.timestamp);
    }

    // ------------------------------------------------------------------ admin

    function setMaxPriceAge(uint32 maxPriceAge_) external onlyOwner {
        _setMaxPriceAge(maxPriceAge_);
    }

    // ------------------------------------------------------------------ views

    /// @notice Invoice details. `status` reads Expired when the invoice is still unpaid past its expiry.
    function invoiceOf(
        bytes32 invoiceId
    ) external view returns (address merchant, uint256 usdAmount6, uint64 expiry, InvoiceStatus status) {
        Invoice storage invoice = _invoices[invoiceId];
        status = invoice.status;
        if (status == InvoiceStatus.Open && block.timestamp > invoice.expiry) status = InvoiceStatus.Expired;
        return (invoice.merchant, invoice.usdAmount6, invoice.expiry, status);
    }

    /// @notice Chainlink HBAR/USD answer (feed decimals) after the completeness, sign and staleness checks.
    function latestPrice() public view returns (uint256 price, uint256 updatedAt) {
        (uint80 roundId, int256 answer, , uint256 answerUpdatedAt, uint80 answeredInRound) = priceFeed
            .latestRoundData();
        if (answerUpdatedAt == 0 || answeredInRound < roundId) revert IncompleteRound();
        if (answer <= 0) revert InvalidPrice(answer);
        if (block.timestamp - answerUpdatedAt > maxPriceAge) revert StalePrice(answerUpdatedAt, maxPriceAge);
        return (uint256(answer), answerUpdatedAt);
    }

    /// @notice Oracle value of `tinybars` in USD (6 decimals), rounded down.
    function quoteUsdc(uint256 tinybars) external view returns (uint256 usdAmount6) {
        (usdAmount6, ) = _quoteUsdc(tinybars);
    }

    /// @notice Fewest tinybars whose oracle value covers `usdAmount6`, rounded up.
    function quoteTinybars(uint256 usdAmount6) external view returns (uint256 tinybars) {
        (uint256 price, ) = latestPrice();
        tinybars = Math.mulDiv(usdAmount6, priceScale, price, Math.Rounding.Ceil);
    }

    /// @notice What `pay(invoiceId)` with `tinybars` would see. It reverts with PoolBelowFloor when
    /// poolUsdc < minUsdcOut, and with Underpaid when oracleUsdc is below the invoice amount.
    function previewPay(
        bytes32 invoiceId,
        uint256 tinybars
    ) external view returns (uint256 oracleUsdc, uint256 minUsdcOut, uint256 poolUsdc) {
        Invoice storage invoice = _invoices[invoiceId];
        if (invoice.status == InvoiceStatus.None) revert InvoiceNotFound(invoiceId);
        (oracleUsdc, ) = _quoteUsdc(tinybars);
        minUsdcOut = _applySlippage(oracleUsdc, merchants[invoice.merchant].maxSlippageBps);
        poolUsdc = router.getAmountsOut(tinybars, _swapPath())[1];
    }

    // ------------------------------------------------------------------ internals

    function _writeMerchant(address payout, uint16 maxSlippageBps) private {
        if (payout == address(0) || payout == address(this)) revert InvalidPayout();
        if (maxSlippageBps > MAX_SLIPPAGE_BPS) revert SlippageTooHigh(maxSlippageBps);
        merchants[msg.sender] = Merchant(payout, maxSlippageBps, true);
    }

    function _setMaxPriceAge(uint32 maxPriceAge_) private {
        if (maxPriceAge_ == 0 || maxPriceAge_ > MAX_PRICE_AGE_LIMIT) revert InvalidMaxPriceAge(maxPriceAge_);
        maxPriceAge = maxPriceAge_;
        emit MaxPriceAgeUpdated(maxPriceAge_);
    }

    /// @dev Swaps all of msg.value into this contract and returns the USDC actually received.
    function _swapHbarForUsdc(uint256 minUsdcOut) private returns (uint256 usdcOut) {
        address[] memory path = _swapPath();
        // Checked up front so a thin or skewed pool fails with a readable error instead of the router's string.
        uint256 poolUsdc = router.getAmountsOut(msg.value, path)[1];
        if (poolUsdc < minUsdcOut) revert PoolBelowFloor(poolUsdc, minUsdcOut);

        uint256 balanceBefore = usdc.balanceOf(address(this));
        router.swapExactETHForTokens{ value: msg.value }(minUsdcOut, path, address(this), block.timestamp);
        usdcOut = usdc.balanceOf(address(this)) - balanceBefore;
        if (usdcOut < minUsdcOut) revert PoolBelowFloor(usdcOut, minUsdcOut);
    }

    /// @dev HTS returns a response code instead of reverting, so an unassociated payout surfaces as its own error.
    function _sendUsdc(address payout, uint256 amount) private {
        int64 responseCode = IHederaTokenService(HTS).transferToken(
            address(usdc),
            address(this),
            payout,
            SafeCast.toInt64(SafeCast.toInt256(amount))
        );
        if (responseCode == TOKEN_NOT_ASSOCIATED_TO_ACCOUNT) revert PayoutNotAssociated(payout);
        if (responseCode != SUCCESS) revert SettlementFailed(responseCode);
    }

    function _quoteUsdc(uint256 tinybars) private view returns (uint256 usdAmount6, uint256 price) {
        (price, ) = latestPrice();
        usdAmount6 = Math.mulDiv(tinybars, price, priceScale);
    }

    function _applySlippage(uint256 amount, uint16 slippageBps) private pure returns (uint256) {
        return (amount * (BPS - slippageBps)) / BPS;
    }

    function _swapPath() private view returns (address[] memory path) {
        path = new address[](2);
        path[0] = whbar;
        path[1] = address(usdc);
    }
}
