import { NextResponse } from "next/server";
import { type Address, type Hex, isAddress } from "viem";
import { z } from "zod";
import { ReceiptError, listReceipts, receiptTopicId, recordReceipt, serverNetwork } from "~~/services/hedera/receipts";
import type { ApiError, ReceiptsResponse } from "~~/utils/checkout";
import { txHashSchema } from "~~/utils/checkout";

const postBodySchema = z.object({ txHash: txHashSchema });

function errorResponse(error: unknown) {
  if (error instanceof ReceiptError) {
    return NextResponse.json<ApiError>(
      { error: { code: error.code, message: error.message } },
      { status: error.status },
    );
  }
  console.error("[api/receipts]", error);
  return NextResponse.json<ApiError>(
    { error: { code: "internal", message: "Unexpected server error." } },
    { status: 500 },
  );
}

/** Record the HCS receipt for a paid invoice. Body: { txHash }. Idempotent per txHash. */
export async function POST(request: Request) {
  const body = postBodySchema.safeParse(await request.json().catch(() => undefined));
  if (!body.success) {
    return NextResponse.json<ApiError>(
      { error: { code: "bad_request", message: 'Send JSON like { "txHash": "0x…" } with a 32-byte hash.' } },
      { status: 400 },
    );
  }
  try {
    const result = await recordReceipt(body.data.txHash as Hex);
    return NextResponse.json(result, { status: result.status === "recorded" ? 201 : 200 });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Receipts from the HCS topic via the mirror node, newest first. Optional ?merchant=0x… filter. */
export async function GET(request: Request) {
  const merchant = new URL(request.url).searchParams.get("merchant")?.trim() || undefined;
  if (merchant && !isAddress(merchant, { strict: false })) {
    return NextResponse.json<ApiError>(
      { error: { code: "bad_request", message: "merchant must be an EVM address." } },
      { status: 400 },
    );
  }
  const topicId = receiptTopicId();
  if (!topicId) {
    return NextResponse.json<ApiError>(
      { error: { code: "not_configured", message: "HCS_TOPIC_ID is not set on the server." } },
      { status: 503 },
    );
  }
  try {
    const network = serverNetwork();
    const receipts = await listReceipts(network, topicId, merchant as Address | undefined);
    return NextResponse.json<ReceiptsResponse>({ network, topicId, receipts });
  } catch (error) {
    return errorResponse(error);
  }
}
