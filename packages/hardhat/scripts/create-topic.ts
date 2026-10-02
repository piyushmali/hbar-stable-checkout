/**
 * Creates the HCS topic that stores payment receipts. Run once per deployment:
 *
 *   yarn hardhat:create-topic
 *
 * Reads HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY (ECDSA) from packages/hardhat/.env. The operator key becomes
 * the topic's submit key, so only the server holding it (the /api/receipts route) can write receipts.
 * There is no admin key: nobody can update or delete the topic, which keeps the receipt log append-only.
 */
import * as dotenv from "dotenv";
dotenv.config();
import { AccountId, Client, PrivateKey, TopicCreateTransaction } from "@hiero-ledger/sdk";

async function main() {
  const operatorId = process.env.HEDERA_OPERATOR_ID;
  const operatorKey = process.env.HEDERA_OPERATOR_KEY;
  if (!operatorId || !operatorKey) {
    throw new Error("Set HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY in packages/hardhat/.env");
  }
  const network = process.env.HEDERA_NETWORK === "mainnet" ? "mainnet" : "testnet";
  const key = PrivateKey.fromStringECDSA(operatorKey);
  const client = Client.forName(network).setOperator(AccountId.fromString(operatorId), key);

  try {
    const response = await new TopicCreateTransaction()
      .setTopicMemo("hbar-stable-checkout receipts v1")
      .setSubmitKey(key.publicKey)
      .execute(client);
    const { topicId } = await response.getReceipt(client);
    console.log(`Created topic ${topicId} on ${network}: https://hashscan.io/${network}/topic/${topicId}`);
    console.log(`\nAdd to packages/nextjs/.env.local:\nHCS_TOPIC_ID=${topicId}`);
  } finally {
    client.close();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
