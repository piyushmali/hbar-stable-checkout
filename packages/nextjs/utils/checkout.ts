import {
  BaseError,
  ContractFunctionRevertedError,
  UserRejectedRequestError,
  formatUnits,
  isAddress,
  isHex,
  parseAbiItem,
} from "viem";
import { z } from "zod";
import type { HederaNetwork } from "~~/utils/scaffold-hbar";

export const HEDERA_NETWORKS = {
  testnet: {
    chainId: 296,
    mirrorNodeUrl: "https://testnet.mirrornode.hedera.com",
    hashscanUrl: "https://hashscan.io/testnet",
  },
  mainnet: {
    chainId: 295,
    mirrorNodeUrl: "https://mainnet-public.mirrornode.hedera.com",
    hashscanUrl: "https://hashscan.io/mainnet",
  },
} as const satisfies Record<HederaNetwork, { chainId: number; mirrorNodeUrl: string; hashscanUrl: string }>;

/** The JSON-RPC relay takes `value` in weibars (18 decimals); contracts see tinybars (8 decimals). */
export const WEIBARS_PER_TINYBAR = 10n ** 10n;
/** The pay page sends 1% over the oracle quote so a price update before execution cannot underpay the invoice. */
export const QUOTE_BUFFER_BPS = 100n;
/** Default merchant slippage. It has to cover SaucerSwap V1's 0.3% LP fee plus oracle drift (up to 0.5%). */
export const DEFAULT_SLIPPAGE_BPS = 100;
export const MAX_SLIPPAGE_BPS = 300;
/**
 * Hedera bills at least 80% of a transaction's gas limit, so limits come from the relay's estimate plus 20%.
 * On testnet a payment costs about 225k gas, or about 930k when HTS auto-associates USDC on the first payout.
 */
export const withGasHeadroom = (estimate: bigint) => (estimate * 120n) / 100n;

export const INVOICE_PAID_EVENT = parseAbiItem(
  "event InvoicePaid(bytes32 indexed invoiceId, address indexed merchant, address indexed payer, uint256 hbarIn, uint256 usdcOut, uint256 oraclePrice, uint256 timestamp)",
);

export const hashscanTransactionUrl = (network: HederaNetwork, transaction: string) =>
  `${HEDERA_NETWORKS[network].hashscanUrl}/transaction/${transaction}`;
export const hashscanTopicUrl = (network: HederaNetwork, topicId: string) =>
  `${HEDERA_NETWORKS[network].hashscanUrl}/topic/${topicId}`;
export const mirrorContractResultUrl = (network: HederaNetwork, txHash: string) =>
  `${HEDERA_NETWORKS[network].mirrorNodeUrl}/api/v1/contracts/results/${txHash}`;
export const mirrorTopicMessageUrl = (network: HederaNetwork, topicId: string, sequenceNumber: number) =>
  `${HEDERA_NETWORKS[network].mirrorNodeUrl}/api/v1/topics/${topicId}/messages/${sequenceNumber}`;

const bytes32 = z.string().refine(value => isHex(value) && value.length === 66, "expected 0x-prefixed 32 bytes");
const evmAddress = z.string().refine(value => isAddress(value, { strict: false }), "expected an EVM address");
const unsigned = z.string().regex(/^\d+$/, "expected an unsigned integer string");

export const txHashSchema = bytes32;
export const accountIdSchema = z.string().regex(/^0\.0\.\d+$/, "expected a Hedera entity ID like 0.0.1234");

/** One HCS message per paid invoice. Amounts are base-unit integers as strings. */
export const receiptSchema = z.object({
  v: z.literal(1),
  invoiceId: bytes32,
  merchant: evmAddress,
  payer: evmAddress,
  /** Tinybars swapped. */
  hbarIn: unsigned,
  /** USDC sent to the merchant, 6 decimals. */
  usdcOut: unsigned,
  /** Chainlink HBAR/USD answer used for the floor, 8 decimals. */
  oraclePrice: unsigned,
  txHash: bytes32,
  /** Consensus timestamp of the payment transaction. */
  consensusTs: z.string().regex(/^\d+\.\d+$/),
});
export type Receipt = z.infer<typeof receiptSchema>;

/** A receipt as read back from the topic. */
export type TopicReceipt = Receipt & { sequenceNumber: number; messageTimestamp: string };

export type ReceiptsResponse = { network: HederaNetwork; topicId: string; receipts: TopicReceipt[] };
/** POST /api/receipts result: "recorded" (201) when this call wrote the message, "exists" (200) otherwise. */
export type RecordResult = {
  status: "recorded" | "exists";
  topicId: string;
  receipt: Receipt;
  sequenceNumber: number;
};
export type ApiError = { error: { code: string; message: string } };
/** GET /api/health. `contract` and `topicId` are null until deployed and configured. */
export type Health = { ok: true; network: HederaNetwork; contract: string | null; topicId: string | null };

export const formatUsd6 = (amount: bigint) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(Number(formatUnits(amount, 6)));
export const formatHbar = (tinybars: bigint) => `${formatUnits(tinybars, 8)} HBAR`;
export const formatOraclePrice = (answer: bigint) => `$${formatUnits(answer, 8)}`;

const CHECKOUT_ERRORS: Record<string, string> = {
  InvoiceNotFound: "This invoice does not exist on this network.",
  InvoiceNotOpen: "This invoice has already been paid.",
  InvoiceExpired: "This invoice has expired. Ask the merchant for a new checkout link.",
  IncompleteRound: "The Chainlink HBAR/USD feed has no complete round right now. Try again shortly.",
  InvalidPrice: "The Chainlink HBAR/USD feed returned an invalid price. Try again shortly.",
  StalePrice: "The Chainlink HBAR/USD price is too old to settle against. Try again after the next feed update.",
  Underpaid: "The HBAR sent is worth less than the invoice at the current Chainlink price. Refresh the quote.",
  PoolBelowFloor:
    "SaucerSwap would return less USDC than the Chainlink floor allows, so the payment was stopped. The pool is thin or skewed right now.",
  PayoutNotAssociated: "The merchant's payout account is not associated with USDC yet.",
  SettlementFailed: "HTS refused the USDC transfer to the merchant.",
  NotMerchant: "Register as a merchant first.",
  AlreadyRegistered: "This account is already registered as a merchant.",
  SlippageTooHigh: "Slippage tolerance can be at most 3%.",
  InvalidPayout: "Enter a valid payout address.",
  InvalidAmount: "Enter an amount above zero.",
  InvalidExpiry: "The expiry must be in the future.",
  InvoiceExists: "An invoice with this ID already exists.",
};

/** Maps contract custom errors and common wallet or relay failures to a sentence a customer can act on. */
export function describeCheckoutError(error: unknown): string {
  if (!(error instanceof BaseError)) {
    return error instanceof Error ? error.message : "Something went wrong.";
  }
  const reverted = error.walk(cause => cause instanceof ContractFunctionRevertedError);
  if (reverted instanceof ContractFunctionRevertedError && reverted.data?.errorName) {
    return CHECKOUT_ERRORS[reverted.data.errorName] ?? `The contract reverted with ${reverted.data.errorName}.`;
  }
  if (error.walk(cause => cause instanceof UserRejectedRequestError)) {
    return "The transaction was rejected in the wallet.";
  }
  const text = `${error.shortMessage} ${error.details ?? ""}`;
  if (/INSUFFICIENT_PAYER_BALANCE|insufficient funds/i.test(text)) {
    return "This account does not have enough HBAR for the payment plus network fees.";
  }
  return error.shortMessage;
}
