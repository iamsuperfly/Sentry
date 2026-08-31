# Dream Event Bot

Telegram bot for DreamDEX binary Event Contracts on **Somnia Shannon testnet** (chain ID `50312`).

Users get a dedicated wallet, faucet tUSDC, scan live BTC/ETH markets, take trades, reconstruct settlement PnL, and redeem winning outcome tokens.

## What works now

- Wallet onboarding, STT gas sponsor, daily tUSDC faucet
- Live market discovery via `@somnia-chain/markets-sdk` `0.28.1`
- `/trade` multi-slot execution (independent trades, per-trade stake, isolated IOC failures)
- **1m markets:** Binance public spot ±0.05% strategy in the final window
- **15m+ markets:** Groq (`openai/gpt-oss-20b`) ranks eligible markets; deterministic validation + risk still decide what executes
- `/positions`, `/history` (reconstructed win/loss PnL), `/status` (today + all-time PnL, unclaimed, wins/losses)
- `/claim` redeem of finalized winning (or void) ERC-6909 balances via `trader.redeem`
- Paper vs testnet mode; live chain submit still gated by `ENABLE_LIVE_EXECUTION`

Not built yet: leaderboard, autonomous 15-minute trading loop, automatic claim, 5m AI eligibility.

## Technology

- Node.js + TypeScript, pnpm workspace
- grammY (Telegram), Express 5 (health + diagnostics)
- Supabase persistence
- viem + `@somnia-chain/markets-sdk`
- Groq OpenAI-compatible API for 15m+ decisions
- Binance public ticker for 1m only (no API key)

## Telegram commands

- `/start` — create or resume the dedicated wallet
- `/faucet <amount>` — request tUSDC (500 / UTC day)
- `/status` — wallet, balances, settings, today + all-time PnL
- `/settings` — stake, max stake, daily loss, open positions, paper/testnet, trading on/off
- `/trade` — one scan: 1m Binance if applicable, otherwise Groq 15m+
- `/positions` — open positions on markets that have not expired
- `/history` — latest completed trades with reconstructed PnL
- `/claim` — redeem settled winning outcome tokens into tUSDC
- `/stop` — disable trading (history kept)
- `/fund` — resume interrupted STT funding
- `/privatekey` — export key (message auto-deletes)
- `/help` 

## How `/trade` decides

```text
market discovery
  → 1m final window → Binance public price → ±0.05% rule
  → otherwise 15m+ eligible markets → Groq
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

Apply Supabase migrations in order:

```text
supabase/migrations/0001_initial_schema.sql
supabase/migrations/0002_wallet_funding.sql
supabase/migrations/0003_faucet_daily_allowance.sql
supabase/migrations/0004_trade_execution.sql
supabase/migrations/0005_daily_profit_target.sql
supabase/migrations/0006_trade_reconciliation.sql
supabase/migrations/0007_execution_mode_settings.sql
supabase/migrations/0008_finalization_notified.sql
```

```bash
pnpm --filter @workspace/api-server run dev
pnpm run typecheck
pnm run build
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

Optional system ceilings (defaults: min stake 1, max stake 200, max open 5, max daily loss 70 tUSDC):

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

## Roadmap

- [x] Wallet, faucet, market discovery
- [x] Risk + persistence + gated live IOC execution
- [x] Multi-slot `/trade`, Groq 15m+, Binance 1m
- [x] PnL reconstruction, `/claim`, `/status` dashboard
- [ ] Leaderboard
- [ ] Opt-in autonomous trading + coupled auto-claim
- [ ] 5m markets in the AI pipeline
