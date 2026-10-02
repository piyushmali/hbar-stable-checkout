import { NextResponse } from "next/server";
import { checkoutAddress, receiptTopicId, serverNetwork } from "~~/services/hedera/receipts";

/** Liveness plus the configuration the app runs with. `contract` and `topicId` are null until set up. */
export async function GET() {
  const network = serverNetwork();
  return NextResponse.json({ ok: true, network, contract: checkoutAddress(network), topicId: receiptTopicId() });
}
