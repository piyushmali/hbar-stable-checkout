# HBAR Stable Checkout

## Problem

Merchants on Hedera want to accept HBAR without holding HBAR price risk. Converting after the fact adds a
second transaction, a custody window and a pool-price risk the merchant never agreed to.

## Product

A checkout link. The customer pays in HBAR; in the same transaction `StableCheckout` swaps it to USDC (an HTS
token) on SaucerSwap V1 and sends the USDC to the merchant's payout account. A Chainlink HBAR/USD feed sets the
minimum USDC the swap must return, so a thin or manipulated pool reverts the payment instead of short-changing
the merchant. Each settled payment gets a receipt on an HCS topic that anyone can audit through the mirror node.

## Journeys

1. **Merchant onboarding** (`/merchant`): connect an ECDSA wallet, register a payout account and a slippage
   tolerance (at most 3%), see whether the payout account is associated with USDC and associate it in one click.
2. **Invoice** (`/merchant`): enter a USD amount and an expiry, get a shareable `/pay/<invoiceId>` link and a QR code.
3. **Payment** (`/pay/<invoiceId>`): see the live Chainlink price, the HBAR quote with a 1% buffer, the merchant's
   oracle floor and what SaucerSwap pays right now. Pay with HBAR; on success see the HashScan link and the HCS
   receipt. Failures show a human-readable reason (stale price, pool below floor, underpaid, expired, already paid,
   payout not associated).
4. **Audit** (`/receipts`): browse receipts read from the HCS topic via the mirror node, filter by merchant, follow
   links to the payment and to the topic message.

## Constraints

- The oracle floor is enforced on-chain: `pay` reverts if the pool output is under the oracle value of `msg.value`
  minus the merchant's slippage.
- Receipts are written by a server route only after it has fetched the transaction from the mirror node and found
  a successful `InvoicePaid` log from this app's contract. The route is idempotent per transaction hash.
- No secret reaches the client bundle. The HCS operator key is read only by `app/api/receipts`.
- Every page returns 200 before anything is deployed and explains what to deploy or configure.

## Non-goals

Refunds, partial payments, fiat off-ramps, and a production-grade receipt index.
