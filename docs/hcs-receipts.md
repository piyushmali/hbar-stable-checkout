# HCS receipts

## Message format

One HCS message per paid invoice, compact JSON under 1 KB (a single chunk):

```json
{
  "v": 1,
  "invoiceId": "0x27664e2d01232e51b14dee787faee7f72a46a720edc76bedeca4dccf14802452",
  "merchant": "0x52094C170Cf2AE0c5C8b1cB77Cb1eF01D1e00b49",
  "payer": "0x52094C170Cf2AE0c5C8b1cB77Cb1eF01D1e00b49",
  "hbarIn": "101378720",
  "usdcOut": "2280068",
  "oraclePrice": "9962643",
  "txHash": "0xe7931756760ed9eff11e3987d735987f207a49a385b3ac7c0a0cb940d64e4e31",
  "consensusTs": "1790972664.342116104"
}
```

`hbarIn` is in tinybars, `usdcOut` in USDC's 6 decimals and `oraclePrice` in the feed's 8 decimals, all as integer
strings. `consensusTs` is the payment's consensus timestamp. This exact message is
[#1 on topic 0.0.10831142](https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10831142/messages/1). The zod
schema is `receiptSchema` in `packages/nextjs/utils/checkout.ts`.

## Writing: `POST /api/receipts`

Body `{ "txHash": "0x…" }`. The route never takes receipt fields from the client.

| Step | Mirror node call | Failure |
| --- | --- | --- |
| Resolve our contract ID (cached) | `GET /api/v1/contracts/{deployedAddress}` | `503 not_deployed` |
| Load the payment | `GET /api/v1/contracts/results/{txHash}` | `404 not_indexed` (retry), `422 payment_failed`, `422 wrong_contract` |
| Find and decode `InvoicePaid` from our `contract_id` | (same response) | `422 not_a_payment` |
| Look for an existing receipt | `GET /api/v1/topics/{id}/messages?order=asc&timestamp=gte:{consensusTs}` | `503 topic_not_found` |
| Submit | `TopicMessageSubmitTransaction` signed by the operator (the submit key) | `502 hcs_submit_failed` |

Responses: `201 { status: "recorded", topicId, receipt, sequenceNumber }` when this call wrote the message, `200` with
`status: "exists"` when it was already there. Errors are `{ error: { code, message } }` without stack traces; mirror
node requests time out after 8 seconds (`504 mirror_unavailable`).

### Idempotency

A receipt can only be written after its payment reached consensus, so the existence check scans the topic from the
payment's consensus timestamp onwards. That keeps the scan to the messages written since the payment, however long
the topic gets.

The mirror node indexes a new message a few seconds after consensus. To cover that window, each server process keeps
the in-flight or recent result per transaction hash for five minutes: concurrent and repeated POSTs share one
submission. Separate server instances rely on the mirror scan alone, so two instances receiving the same hash within
those seconds could both write. The reader drops such duplicates (first message wins). A production deployment that
runs several instances should record hashes in a shared store before submitting.

## Reading: `GET /api/receipts?merchant=0x…`

Pages through `/api/v1/topics/{id}/messages?order=desc` (100 per page, up to 10 pages), base64-decodes each message,
validates it with zod, skips anything that is not a v1 receipt, drops duplicate transaction hashes, and filters by
merchant (case-insensitive). The 1,000-message cap is a deliberate simplification; past that, index receipts in a
database keyed by transaction hash.

## Auditing without this app

Everything is public:

1. List the topic: `https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10831142/messages`.
2. Base64-decode a message's `message` field to get the receipt JSON.
3. Check the payment it names: `https://testnet.mirrornode.hedera.com/api/v1/contracts/results/{txHash}` must be
   `SUCCESS` and carry an `InvoicePaid` log from contract `0.0.10831121` with the same values.
4. The topic's submit key shows who can write: `https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10831142`.
