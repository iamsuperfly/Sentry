# Sentry

Telegram trading assistant for **DreamDEX Event Contracts** on **Somnia Shannon testnet** (chain ID `50312`).

Sentry gives a user a dedicated testnet wallet, scans live BTC/ETH Up/Down markets, and can place IOC trades either on demand or on a 6-minute autonomous loop. Groq ranks longer-duration markets; a Binance public-spot sampler feeds rolling features and the 1-minute strategy. Deterministic risk, sizing, and book checks always sit between the model and the order.

Built for the Somnia × DreamDEX Event Contracts hackathon. The product is a testnet trading assistant, not a research notebook.

## Live bot

**[@dreamsentrybot](https://t.me/dreamsentrybot)** — [https://t.me/dreamsentrybot](https://t.me/dreamsentrybot)

Shannon testnet only. Not intended for real funds.

## Overview

DreamDEX Event Contracts are short-dated binary Up/Down markets on BTC and ETH. Traders need a wallet, gas, collateral, a way to read the book, and a way to claim after settlement.

Sentry handles that loop in Telegram:

1. Create and fund a per-user wallet.
2. Scan tradable BTC/ETH markets.
3. Decide Up/Down (1m rule or Groq).
4. Size, risk-check, and submit an IOC order.
5. Notify, manage, settle, and claim.

## Features

- **Telegram onboarding** — dedicated wallet, STT gas sponsor, daily tUSDC faucet (UTC day)
- **BTC / ETH Event Contracts** — Up (YES) / Down (NO) via `@somnia-chain/markets-sdk` `0.28.1`
- **Manual trading** — TRADE NOW or `/trade` runs one scan
- **Autonomous trading** — optional 6-minute loop using the same pipeline, plus auto-claim and early-loss management. Pauses at UTC midnight until TRADE NOW or `/auto on`
- **Groq decision layer** — 5m and 15m+ markets. Groq picks direction + confidence + reason only
- **Binance sampler** — independent ~15s REST ticker for BTC/ETH, bounded rolling cache, heartbeat logs. No Binance API key
- **Rolling features** — duration-aware 1/3/5/10/15/30m moves, trend, volatility, signed gap vs DreamDEX opening/reference
- **1m strategy** — cache-first Binance spot ±0.05% in the final window; live ticker only if the cache is empty or stale. 1m never goes to Groq
- **Deterministic validation** — Groq candidates are filtered against tradability, expiry, book, and slot/budget caps
- **Adaptive stake** — live size from remaining daily-loss budget, book notional, and user/system ceilings. Groq stake is not authoritative
- **Risk controls** — user + system min/max stake, max open positions, daily loss stop, daily profit target
- **Early-loss management** — open positions can be closed early to limit a loss (reported as CLOSED EARLY)
- **Claims / settlement** — reconstruct PnL from on-chain `winningOutcome` + filled contracts; `/claim` redeems winning or void ERC-6909 balances
- **Notifications** — trade updates, finalization, claims, autonomous daily halt. Zero-fill IOC already reported as “Not filled” is not duplicated as “Trade closed”
- **Positions, history, performance, leaderboard** — reconstructed win/loss PnL, UTC-day and all-time stats

Primary UX is buttons (TRADE NOW, AUTONOMOUS, POSITIONS, PERFORMANCE, WALLET, HELP). Legacy commands (`/trade`, `/auto`, `/settings`, `/faucet`, `/status`, `/positions`, `/history`, `/claim`, `/leaderboard`, `/fund`, `/privatekey`) still work. `/stop` only pauses autonomous trading.

## Architecture

```text
Binance public ticker (independent ~15s sampler)
  → rolling in-memory features
  → market discovery (DreamDEX SDK)
       ├─ 1m final window → cache-first spot ±0.05% rule
       └─ 5m / 15m+     → Groq rank + compact features
  → deterministic AI validation
  → adaptive stake + user/system risk
  → DreamDEX order-book preflight
  → independent IOC execution
  → Supabase persistence
  → Telegram notifications
```

**Manual TRADE NOW / `/trade`** runs that pipeline once.

**Autonomous mode** repeats it every 6 minutes for opted-in users, then runs early-loss management and a claim scan. It shares the same execution, risk, and persistence code. It stops at UTC midnight until the user trades again or turns autonomous back on.

Groq cannot bypass stake limits, slot caps, daily loss/profit stops, book preflight, or `ENABLE_LIVE_EXECUTION`. Missing `GROQ_API_KEY` fails closed (`ai_not_configured`). There is no hardcoded strategy fallback when AI fails.

Settlement PnL is reconstructed from on-chain outcome + filled contracts. Claiming converts a 6909 balance into tUSDC; it does not invent extra PnL.

## Technology stack

| Layer | Technology |
| --- | --- |
| Runtime | Node.js 24, TypeScript 5.9, pnpm workspaces |
| Telegram | grammY |
| HTTP diagnostics | Express 5 (`/api/healthz`, `/api/readyz`, read-only DreamDEX routes) |
| Persistence | Supabase (Postgres + SQL migrations in `supabase/migrations`) |
| Chain | viem, `@somnia-chain/markets-sdk` `0.28.1` |
| AI | Groq OpenAI-compatible Chat Completions (`openai/gpt-oss-20b`) |
| Spot data | Binance public ticker (no API key) |
| Validation | Zod |
| Logging | pino |
| Deploy | Railway (`railway.json`); Replit-compatible scripts |

## Setup

Shannon testnet only. Apply Supabase migrations in order under `supabase/migrations/` (through `0010_utc_day_drop_user_timezone.sql`). Copy `.env.example` and fill secrets locally — never commit a real `.env`.

```bash
pnpm --filter @workspace/api-server run dev
pnpm run typecheck
pnpm run build
pnpm --filter @workspace/api-server run test
```

Default API port is `5000`.

### Environment

Required:

```text
TELEGRAM_BOT_TOKEN
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
TREASURY_PRIVATE_KEY
WALLET_ENCRYPTION_KEY
```

Network (defaults point at Shannon):

```text
SOMNIA_RPC_URL              # default https://dream-rpc.somnia.network
SOMNIA_WS_RPC_URL
DREAMDEX_INDEXER_URL
EXPLORER_TX_BASE_URL
INITIAL_GAS_SPONSOR_AMOUNT  # default 0.1 STT
PORT                        # default 5000
```

Trading / AI:

```text
ENABLE_LIVE_EXECUTION=true     # required for real Shannon orders (default false)
GROQ_API_KEY
GROQ_MODEL=openai/gpt-oss-20b  # optional
GROQ_BASE_URL                  # optional, default https://api.groq.com/openai/v1
GROQ_MAX_MARKETS=8             # optional cap on markets sent to Groq
```

Optional system ceilings (code defaults: min stake 1, max stake 200, max open **10**, max daily loss **300** tUSDC):

```text
SYSTEM_MIN_STAKE_TUSDC
SYSTEM_MAX_STAKE_TUSDC
SYSTEM_MAX_OPEN_POSITIONS
SYSTEM_MAX_DAILY_LOSS_TUSDC
```

No Binance API key. Do not commit secrets.

### Diagnostics HTTP

```text
GET /api/healthz
GET /api/readyz
GET /api/dreamdex/markets
GET /api/dreamdex/decisions
```

Read-only. Telegram trading does not go through these routes.

## Project structure

```text
artifacts/api-server/     Telegram bot + trading engine
  src/index.ts            process entry (HTTP + bot)
  src/config.ts           environment
  src/telegram/           grammY bot, keyboards, autonomous/finalization loops
  src/lib/                strategy, Groq, Binance sampler, risk, execution, persistence
  src/routes/             health / readiness / read-only DreamDEX diagnostics
supabase/migrations/      ordered SQL schema
docs/                     architecture notes
LICENSE                   MIT
```

## Network

- RPC: `https://dream-rpc.somnia.network`
- Explorer: `https://shannon-explorer.somnia.network`
- tUSDC: `0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E`
- Shared OutcomeToken6909: `0xB52c5934113Af5c0Bb20eb3C72290C8215f755b9`

## Testnet / safety

Sentry currently operates on **Somnia Shannon testnet only**. It is **not** intended for real funds.

Event contracts can go to zero. IOC orders may not fill. Autonomous mode will keep trading until a daily halt, a position cap, or you pause it. Past results are not a forecast. You are responsible for keys, secrets, and any funds you put on the bot.

Live chain submit stays gated by `ENABLE_LIVE_EXECUTION`.

## License

MIT © 2026 Superfly. See [LICENSE](LICENSE).
