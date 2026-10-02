import { AccountId, Client, PrivateKey, TopicId, TopicMessageSubmitTransaction } from "@hiero-ledger/sdk";
import { type Address, type Hex, decodeEventLog, isAddressEqual, toEventSelector } from "viem";
import { z } from "zod";
import deployedContracts from "~~/contracts/deployedContracts";
import {
  HEDERA_NETWORKS,
  INVOICE_PAID_EVENT,
  type Receipt,
  type RecordResult,
  type TopicReceipt,
  accountIdSchema,
  receiptSchema,
} from "~~/utils/checkout";
import type { HederaNetwork } from "~~/utils/scaffold-hbar";

// Server-only: reads the operator key. Imported by app/api routes, never by client components.

const MIRROR_TIMEOUT_MS = 8_000;
const PAGE_SIZE = 100;
// ponytail: receipts are found by paging through the topic, capped at MAX_PAGES * PAGE_SIZE messages per read.
// Past a few thousand receipts, index them by txHash in a database instead.
const MAX_PAGES = 10;
const RECENT_TTL_MS = 5 * 60_000;
const INVOICE_PAID_TOPIC = toEventSelector(INVOICE_PAID_EVENT);

export class ReceiptError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function serverNetwork(): HederaNetwork {
  return process.env.HEDERA_NETWORK === "mainnet" ? "mainnet" : "testnet";
}

export function receiptTopicId(): string | null {
  const parsed = accountIdSchema.safeParse(process.env.HCS_TOPIC_ID?.trim());
  return parsed.success ? parsed.data : null;
}

/** StableCheckout address for `network` from the generated deployedContracts.ts, or null before the first deploy. */
export function checkoutAddress(network: HederaNetwork): Address | null {
  const byChain = deployedContracts as Partial<Record<number, Partial<Record<string, { address: Address }>>>>;
  return byChain[HEDERA_NETWORKS[network].chainId]?.StableCheckout?.address ?? null;
}

async function mirrorGet<T>(network: HederaNetwork, path: string, schema: z.ZodType<T>): Promise<T | null> {
  let response: Response;
  try {
    response = await fetch(`${HEDERA_NETWORKS[network].mirrorNodeUrl}${path}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(MIRROR_TIMEOUT_MS),
    });
  } catch {
    throw new ReceiptError(504, "mirror_unavailable", "The mirror node did not answer in time. Try again.");
  }
  if (response.status === 404) return null;
  if (!response.ok) throw new ReceiptError(502, "mirror_error", `The mirror node answered ${response.status}.`);
  const parsed = schema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) throw new ReceiptError(502, "mirror_error", "The mirror node sent an unexpected response.");
  return parsed.data;
}

const contractSchema = z.object({ contract_id: z.string() });
const contractResultSchema = z.object({
  contract_id: z.string().nullable(),
  result: z.string(),
  timestamp: z.string(),
  logs: z.array(z.object({ contract_id: z.string().nullable(), data: z.string(), topics: z.array(z.string()) })),
});
const topicMessagesSchema = z.object({
  messages: z.array(z.object({ consensus_timestamp: z.string(), message: z.string(), sequence_number: z.number() })),
  links: z.object({ next: z.string().nullable() }),
});

const contractIds = new Map<string, string>();

async function contractIdOf(network: HederaNetwork, address: Address): Promise<string> {
  const key = `${network}:${address.toLowerCase()}`;
  const cached = contractIds.get(key);
  if (cached) return cached;
  const contract = await mirrorGet(network, `/api/v1/contracts/${address}`, contractSchema);
  if (!contract) throw new ReceiptError(503, "not_deployed", `StableCheckout ${address} is not on ${network}.`);
  contractIds.set(key, contract.contract_id);
  return contract.contract_id;
}

/**
 * Builds the receipt for `txHash` from the mirror node, never from client input: the transaction must have
 * succeeded, have called our StableCheckout, and carry an InvoicePaid log emitted by it.
 */
export async function verifyPayment(network: HederaNetwork, txHash: Hex): Promise<Receipt> {
  const address = checkoutAddress(network);
  if (!address) throw new ReceiptError(503, "not_deployed", `StableCheckout is not deployed on ${network}.`);
  const contractId = await contractIdOf(network, address);

  const result = await mirrorGet(network, `/api/v1/contracts/results/${txHash}`, contractResultSchema);
  if (!result) {
    throw new ReceiptError(404, "not_indexed", "The mirror node has not indexed this transaction yet. Retry shortly.");
  }
  if (result.result !== "SUCCESS") {
    throw new ReceiptError(422, "payment_failed", `The transaction did not succeed (${result.result}).`);
  }
  if (result.contract_id !== contractId) {
    throw new ReceiptError(422, "wrong_contract", "The transaction did not call this app's StableCheckout contract.");
  }

  const log = result.logs.find(entry => entry.contract_id === contractId && entry.topics[0] === INVOICE_PAID_TOPIC);
  if (!log) throw new ReceiptError(422, "not_a_payment", "The transaction did not emit InvoicePaid.");
  const { args } = decodeEventLog({
    abi: [INVOICE_PAID_EVENT],
    data: log.data as Hex,
    topics: log.topics as [Hex, ...Hex[]],
  });

  return {
    v: 1,
    invoiceId: args.invoiceId,
    merchant: args.merchant,
    payer: args.payer,
    hbarIn: args.hbarIn.toString(),
    usdcOut: args.usdcOut.toString(),
    oraclePrice: args.oraclePrice.toString(),
    txHash: txHash.toLowerCase(),
    consensusTs: result.timestamp,
  };
}

function decodeTopicMessage(message: z.infer<typeof topicMessagesSchema>["messages"][number]): TopicReceipt | null {
  try {
    const parsed = receiptSchema.safeParse(JSON.parse(Buffer.from(message.message, "base64").toString("utf8")));
    if (!parsed.success) return null;
    return { ...parsed.data, sequenceNumber: message.sequence_number, messageTimestamp: message.consensus_timestamp };
  } catch {
    return null;
  }
}

async function* topicReceipts(network: HederaNetwork, topicId: string, query: string) {
  let path: string | null = `/api/v1/topics/${topicId}/messages?limit=${PAGE_SIZE}&${query}`;
  for (let page = 0; path && page < MAX_PAGES; page++) {
    const body: z.infer<typeof topicMessagesSchema> | null = await mirrorGet(network, path, topicMessagesSchema);
    if (!body) throw new ReceiptError(503, "topic_not_found", `HCS topic ${topicId} does not exist on ${network}.`);
    for (const message of body.messages) {
      const receipt = decodeTopicMessage(message);
      if (receipt) yield receipt;
    }
    path = body.links.next;
  }
}

/** Valid receipts on the topic, newest first, one per payment, optionally for a single merchant. */
export async function listReceipts(network: HederaNetwork, topicId: string, merchant?: Address) {
  const byTx = new Map<string, TopicReceipt>();
  for await (const receipt of topicReceipts(network, topicId, "order=desc")) {
    if (merchant && !isAddressEqual(receipt.merchant as Address, merchant)) continue;
    // Walking newest to oldest, so a later write overwrites with the first receipt for a payment.
    byTx.set(receipt.txHash, receipt);
  }
  return [...byTx.values()].sort((a, b) => b.sequenceNumber - a.sequenceNumber);
}

async function submitReceipt(network: HederaNetwork, topicId: string, receipt: Receipt) {
  const operatorId = accountIdSchema.safeParse(process.env.HEDERA_OPERATOR_ID?.trim());
  const operatorKey = process.env.HEDERA_OPERATOR_KEY?.trim();
  if (!operatorId.success || !operatorKey) {
    throw new ReceiptError(503, "not_configured", "HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY are not set.");
  }
  const client = Client.forName(network).setOperator(
    AccountId.fromString(operatorId.data),
    PrivateKey.fromStringECDSA(operatorKey),
  );
  try {
    const response = await new TopicMessageSubmitTransaction()
      .setTopicId(TopicId.fromString(topicId))
      .setMessage(JSON.stringify(receipt))
      .execute(client);
    const { topicSequenceNumber } = await response.getReceipt(client);
    return { sequenceNumber: Number(topicSequenceNumber), transactionId: response.transactionId.toString() };
  } catch (error) {
    console.error("[receipts] HCS submit failed", error instanceof Error ? error.message : error);
    throw new ReceiptError(502, "hcs_submit_failed", "Writing the receipt to the HCS topic failed.");
  } finally {
    client.close();
  }
}

async function record(txHash: Hex): Promise<RecordResult> {
  const network = serverNetwork();
  const topicId = receiptTopicId();
  if (!topicId) throw new ReceiptError(503, "not_configured", "HCS_TOPIC_ID is not set.");

  const receipt = await verifyPayment(network, txHash);
  // A receipt can only have been written after its payment reached consensus.
  for await (const existing of topicReceipts(network, topicId, `order=asc&timestamp=gte:${receipt.consensusTs}`)) {
    if (existing.txHash === receipt.txHash) return { status: "exists", topicId, receipt: existing };
  }
  return { status: "recorded", topicId, receipt, ...(await submitReceipt(network, topicId, receipt)) };
}

// ponytail: per-process guard for the seconds before the mirror node indexes a fresh message. Other server
// instances rely on the topic scan alone, so a near-simultaneous duplicate is possible; listReceipts drops it.
const recent = new Map<string, Promise<RecordResult>>();

/** Verifies `txHash` against the mirror node and writes its receipt to HCS once. */
export function recordReceipt(txHash: Hex): Promise<RecordResult> {
  const key = txHash.toLowerCase();
  const cached = recent.get(key);
  if (cached) return cached;
  const pending = record(key as Hex);
  recent.set(key, pending);
  pending.then(
    () => setTimeout(() => recent.delete(key), RECENT_TTL_MS),
    () => recent.delete(key),
  );
  return pending;
}
