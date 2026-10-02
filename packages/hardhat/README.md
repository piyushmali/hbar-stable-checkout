# Hardhat package

`StableCheckout`, its deploy script, the hermetic tests, the mainnet fork test and the testnet scripts. Run the
commands from the repo root; the root `README.md` has the full walkthrough.

| Command (repo root) | What it does |
| --- | --- |
| `yarn hardhat:test` | Hermetic tests with `MockHTS` at `0x167`, `MockRouter`, `MockAggregator` and `MockUSDC` |
| `yarn fork:test` | Read-only checks against live Hedera mainnet state (`test-fork/`) |
| `yarn hardhat:deploy --network hederaTestnet` | Deploy with `config/hedera-testnet.ts`, then regenerate `../nextjs/contracts/deployedContracts.ts` |
| `yarn hardhat:create-topic` | Create the HCS receipt topic |
| `yarn hardhat:demo-pay` | Pay a $0.10 invoice on testnet through SaucerSwap |
| `yarn hardhat:verify -- StableCheckout testnet` | Verify the deployed contract on Sourcify (shown as verified on HashScan) |

## Keys

Put an ECDSA key in `.env` (see `.env.example`): `DEPLOYER_PRIVATE_KEY=0x…`, or run `yarn hardhat:account:generate`
for a password-encrypted key that the deploy command decrypts. Live networks get no account without one.

## Networks

`hederaTestnet` (296) and `hederaMainnet` (295) go through the Hashio JSON-RPC relay. The in-process `hardhat` network
does not fork unless `HEDERA_FORKING=true`; `yarn fork:test` and `yarn hardhat:fork` set it with
`MAINNET_FORKING_ENABLED=true`. A local testnet fork (`yarn hardhat:chain`) cannot run `StableCheckout` end to end,
because the HTS emulator cannot associate new contracts or mint WHBAR; use testnet or the tests instead.
