# DreamDEX Event Contracts Telegram Bot

A Telegram bot for onboarding users to dedicated wallets on the Somnia Shannon
testnet and preparing those wallets for future DreamDEX Event Contracts
trading. Wallet creation and testnet funding are implemented; the trading
engine is still being built.

## Technology

- Node.js 24 and TypeScript
- grammY for Telegram bot interactions
- Express 5 for the backend HTTP server
- Supabase for server-side persistence
- viem for EVM wallet and blockchain operations
- Zod for runtime configuration validation
- esbuild for production builds

## Current onboarding flow

When a user runs `/start`, the bot:

1. Creates one dedicated EVM wallet for the Telegram user.
2. Encrypts the private key with AES-256-GCM before storing it in Supabase.
3. Sends `0.1 STT` from the treasury wallet to the new wallet.
4. Tracks the STT transaction and reports its status with an explorer link.
5. Shows the resulting live balances and explains how to request tUSDC.

If onboarding is interrupted, `/start` reuses the existing wallet and resumes
the missing STT funding step. `/fund` provides the same manual recovery path.
Confirmed transactions are preserved and pending transactions are not
resubmitted.

## Network and tokens

All current wallet activity is restricted to the **Somnia Shannon testnet**:

- Chain ID: `50312`
- RPC: `https://dream-rpc.somnia.network`
- Explorer: `https://shannon-explorer.somnia.network`

The bot uses:

- `STT` for Somnia testnet gas
- `tUSDC` from the configured testnet faucet
- Default initial funding of `0.1 STT`
- A maximum faucet allowance of `500 tUSDC` per Telegram user per UTC day

The tUSDC contract address is:

```text
0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E
```

## Telegram commands

- `/start` — create a wallet or resume onboarding
- `/faucet <amount>` — request tUSDC, up to 500 per UTC day
- `/status` — view wallet address, live balances, and faucet allowance
- `/fund` — manually resume interrupted STT funding
- `/privatekey` — retrieve the encrypted wallet's private key; the Telegram message is protected and scheduled for deletion
- `/help` — show available commands

## Stage 1 read-only DreamDEX diagnostics

The server exposes a read-only market diagnostic at:

```text
GET /api/dreamdex/markets
GET /api/dreamdex/markets?asset=BTC
GET /api/dreamdex/markets?asset=ETH
```

It uses `@somnia-chain/markets-sdk` `0.28.1` with the official Somnia Shannon
configuration (chain ID `50312`) to discover binary markets, keep only BTC and
ETH, read each market by its `marketId`, resolve the current pool/window
binding, read authoritative on-chain status, and read the four-sided order
book. A market is marked `tradable` only when both the indexer status is
`Trading` and the live on-chain status is `1`.

This endpoint performs no approvals, orders, minting, merging, redemption,
funding, or database writes. It is intentionally separate from Telegram
handlers and wallet/funding code.

## Setup

Install dependencies with pnpm, then apply the Supabase migrations manually in
this order:

```text
supabase/migrations/0001_initial_schema.sql
supabase/migrations/0002_wallet_funding.sql
supabase/migrations/0003_faucet_daily_allowance.sql
```

Run the API server with:

```bash
pnpm --filter @workspace/api-server run dev
```

The server listens on port `5000` by default. For checks and production
builds:

```bash
pnpm run typecheck
pnpm run build
```

## Required environment variables

Keep these values in Replit Secrets or another server-side secret manager.
Never commit real values:

```text
TELEGRAM_BOT_TOKEN
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
TREASURY_PRIVATE_KEY
WALLET_ENCRYPTION_KEY
```

`WALLET_ENCRYPTION_KEY` must decode to 32 bytes as either a 64-character hex
value or a base64 value.

Optional configuration variables and their defaults:

```text
PORT=5000
SOMNIA_RPC_URL=https://dream-rpc.somnia.network
INITIAL_GAS_SPONSOR_AMOUNT=0.1
EXPLORER_TX_BASE_URL=https://shannon-explorer.somnia.network/tx
```

The treasury wallet must hold enough Somnia testnet STT to sponsor new user
wallets and pay transaction gas. The Supabase service-role key is used only by
the backend and must not be exposed to clients.

## Roadmap

- Add Somnia/DreamDEX Event Contract market discovery.
- Add rule-based Up/Down trading and order execution.
- Add trade status, settlement, and redemption handling.
- Add user-facing trade history and performance reporting.

Trading and order execution are not currently enabled.
