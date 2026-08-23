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
4. Calls the verified tUSDC faucet from the user wallet.
5. Tracks both blockchain transactions and reports their status with explorer links.
6. Shows the resulting live balances.

If onboarding is interrupted, `/start` reuses the existing wallet and resumes
the missing funding step. `/fund` provides the same manual recovery path.
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
- Default initial funding of `0.1 STT` and `20 tUSDC`

The tUSDC contract address is:

```text
0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E
```

## Telegram commands

- `/start` — create a wallet or resume onboarding
- `/fund` — manually resume missing wallet funding
- `/status` — view the wallet address and live STT/tUSDC balances
- `/privatekey` — retrieve the encrypted wallet's private key; the Telegram message is protected and scheduled for deletion
- `/help` — show available commands

## Setup

Install dependencies with pnpm, then apply the Supabase migrations manually in
this order:

```text
supabase/migrations/0001_initial_schema.sql
supabase/migrations/0002_wallet_funding.sql
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
INITIAL_TUSDC_FAUCET_AMOUNT=20
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
