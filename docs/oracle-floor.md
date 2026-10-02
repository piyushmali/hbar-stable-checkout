# The oracle floor

## Units

| Quantity | Decimals | Where |
| --- | --- | --- |
| HBAR in the EVM (`msg.value`, balances) | 8 (tinybars) | Every HBAR amount in `StableCheckout` |
| HBAR in a JSON-RPC transaction `value` | 18 (weibars) | What wallets and viem send; the relay divides by 10^10 |
| WHBAR token | 8 | SaucerSwap path[0], 1 WHBAR = 1 HBAR |
| Chainlink HBAR/USD answer | 8 (`feed.decimals()`) | `latestRoundData().answer` |
| USD amounts and USDC | 6 | Invoices, `quoteUsdc`, swap output |

`StableCheckout` derives `priceScale = 10^(8 + feedDecimals - 6)` once in the constructor, so a feed with other
decimals still works. With Hedera's 8-decimal feed, `priceScale = 10^10`.

```solidity
usd6     = Math.mulDiv(tinybars, answer, priceScale);                       // quoteUsdc: rounds down
tinybars = Math.mulDiv(usd6, priceScale, answer, Math.Rounding.Ceil);       // quoteTinybars: rounds up
```

Rounding is in the merchant's favour on both sides: the customer's HBAR is valued down, and the HBAR needed for an
invoice is rounded up. `quoteTinybars(x)` is the smallest amount for which `quoteUsdc(...) >= x`; one tinybar less is
`Underpaid`. The hermetic tests pin this (`converts between tinybars and 6-decimal USD at the oracle price`).

## The checks in `pay`

1. `latestRoundData()` must be complete (`updatedAt != 0`, `answeredInRound >= roundId`), positive, and no older than
   `maxPriceAge`. Errors: `IncompleteRound`, `InvalidPrice(answer)`, `StalePrice(updatedAt, maxPriceAge)`.
2. `oracleUsdc = quoteUsdc(msg.value)` must be at least the invoice amount, else `Underpaid(oracleUsdc, invoice)`.
3. `minUsdcOut = oracleUsdc * (10_000 - maxSlippageBps) / 10_000`, with `maxSlippageBps <= 300`.
4. `router.getAmountsOut(msg.value, [WHBAR, USDC])[1]` must be at least `minUsdcOut`, else
   `PoolBelowFloor(poolUsdc, minUsdcOut)`. The router enforces the same bound as `amountOutMin`; the pre-check exists
   so the failure is a decodable custom error instead of the router's revert string.
5. After the swap, the USDC balance delta must also clear `minUsdcOut`, in case a router ever reports more than it
   delivers.

## Floor on what was sent, not on the invoice

The pay page sends the oracle quote plus 1%, so a price tick between quote and execution cannot underpay. If the
floor were `invoice × (1 − slippage)`, that 1% (or any larger overpayment) would be unprotected: a sandwich could move
the pool until the swap returned just the invoice minus slippage and keep the difference. Basing the floor on the
oracle value of `msg.value` protects every tinybar the customer sends. The test
`floors the swap at the oracle value of everything sent, not just the invoice` sends twice the price and checks that a
pool paying more than the invoice, but less than that floor, is still rejected.

## Choosing `maxPriceAge` and slippage

Chainlink updates Hedera's HBAR/USD feed when the price moves 0.5% or every 24 hours. Between updates the answer is
within 0.5% of the market, so an answer up to the heartbeat old is still accurate to that band. The default
`maxPriceAge` is 25 hours; the owner can tighten it with `setMaxPriceAge` (1 second to 2 days).

A fair SaucerSwap V1 swap returns the oracle value minus the 0.3% LP fee, minus price impact, plus or minus up to 0.5%
of oracle lag. A merchant slippage of 1% (the default) clears that for small payments; 3% is the cap.

## Testnet behaviour

The testnet WHBAR/USDC pool prices HBAR around $2.25 against Chainlink's ~$0.10, so swaps return about 22 times the
oracle value and always clear the floor. The real run in the README shows the numbers: $0.10 invoice, 1.0137872 HBAR
sent, floor $0.099989, 2.280068 USDC delivered. To see the floor reject a pool, run the hermetic tests, which move the
mock pool under the floor, or `yarn fork:test` against mainnet prices.
