# Dream Event Bot

Telegram bot for DreamDEX binary Event Contracts on **Somnia Shannon testnet** (chain ID `50312`).

Users get a dedicated wallet, faucet tUSDC, scan live BTC/ETH markets, take trades, reconstruct settlement PnL, and redeem winning outcome tokens.

## What works now

- Wallet onboarding, STT gas sponsor, daily tUSDC faucet (UTC day)
- Live market discovery via `@somnia-chain/markets-sdk` `0.28.1`
- `/trade` multi-slot execution (independent trades, per-trade stake, isolated IOC failures)
- **1m markets:** Binance public spot ±0.05% strategy in the final window
- **5m / 15m+ markets:** Groq (`openai/gpt-oss-20b`) ranks eligible markets; deterministic validation + risk still decide what executes
- `/positions`, `/history` (reconstructed win/loss PnL), `/status` (today + all-time PnL, unclaimed, wins/losses)
- `/claim` redeem of finalized winning (or void) ERC-6909 balances via `trader.redeem`
- `/leaderboard` all-time top 10 + your all-time and UTC-today ranks
- `/auto on|off` opt-in 6-minute loop (same `/trade` pipeline + auto-claim). Stops at UTC midnight until `/trade` or `/auto on`
- Shannon testnet only. Live chain submit still gated by `ENABLE_LIVE_EXECUTION`

## Technology

- Node.js + TypeScript, pnpm workspace
- grammY (Telegram), Express 5 (health + diagnostics)
- Supabase persistence
- viem + `@somnia-chain/markets-sdk`
- Groq OpenAI-compatible API for 5m/15m+ decisions
- Binance public ticker for 1m only (no API key)

## Telegram app

Primary UX is buttons, not commands.

`/start` → GET TEST TOKENS (default 100 tUSDC, skip if you already have a balance) → guided numeric setup (default stake, max stake, max daily loss, max open positions, daily profit target) → persistent keyboard:

- TRADE NOW
- AUTONOMOUS ON/OFF
- POSITIONS / PERFORMANCE
- WALLET / HELP

Help → Settings changes limits by tapping a field and typing one number.

Legacy commands (`/trade`, `/auto`, `/settings`, `/faucet`, `/status`, `/positions`, `/history`, `/claim`, `/leaderboard`, `/fund`, `/privatekey`) still work. `/stop` only pauses autonomous trading; TRADE NOW stays available.

There is no paper mode and no `/timezone`. Daily PnL, faucet, daily loss, daily leaderboard, and autonomous cutoff all use **UTC midnight**.

## How `/trade` decides

```text
market discovery
  → 1m final window → Binance public price → ±0.05% rule
  → otherwise eligible 5m/15m+ markets → Groq
  → deterministic AI validation
  → risk (user + system)
  → persist one intent per selected market
  → independent IOC execution
```

Groq cannot bypass stake limits, slot caps, daily loss/profit stops, or `ENABLE_LIVE_EXECUTION`. Missing `GROQ_API_KEY` fails closed (`ai_not_configured`). There is no hardcoded strategy fallback when AI fails.

Settlement PnL is reconstructed from on-chain `winningOutcome` + filled contracts. Claiming converts a 6909 balance into tUSDC; it does **not** add extra PnL.

## Network

- RPC: `https://dream-rpc.somnia.network`
- Explorer: `https://shannon-explorer.somnia.network`
- tUSDC: `0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E`
- Shared OutcomeToken6909: `0xB52c5934113Af5c0Bb20eb3C72290C8215f755b9`

## Setup

Apply Supabase migrations in order, including:

```text
0009_user_timezone_autonomous.sql   # autonomous columns
0010_utc_day_drop_user_timezone.sql # drop per-user timezone; faucet UTC
```

```bash
pnpm --filter @workspace/api-server run dev
pnpm run typecheck
pnpm run build
pnpm --filter @workspace/api-server run test
```

Default API port is `5000`.

## Environment

Required:

```text
TELEGRAM_BOT_TOKEN
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
TREASURY_PRIVATE_KEY
WALLET_ENCRYPTION_KEY
```

Trading / AI:

```text
ENABLE_LIVE_EXECUTION=true   # required for real Shannon orders
GROQ_API_KEY
GROQ_MODEL=openai/gpt-oss-20b   # optional
```

Optional system ceilings (defaults: min stake 1, max stake 200, max open **10**, max daily loss **300** tUSDC):

```text
SYSTEM_MIN_STAKE_TUSDC
SYSTEM_MAX_STAKE_TUSDC
SYSTEM_MAX_OPEN_POSITIONS
SYSTEM_MAX_DAILY_LOSS_TUSDC
```

No Binance API key. Do not commit secrets.

## Diagnostics HTTP

```text
GET /api/dreamdex/markets
GET /api/dreamdex/decisions
```

Read-only. Telegram trading does not go through these routes.
