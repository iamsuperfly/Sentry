# Sentry

Telegram trading assistant for **DreamDEX Event Contracts** on **Somnia Shannon testnet** (chain ID `50312`).

Sentry creates a per-user testnet wallet, discovers live BTC/ETH Up/Down markets, and places IOC trades either on demand or on a 6-minute autonomous loop. Every live decision is deterministic. There is no LLM on the trading path.

**[@dreamsentrybot](https://t.me/dreamsentrybot)** — Shannon testnet only. Not intended for real funds.

## What it does

1. Onboard a dedicated wallet (STT gas sponsor + daily tUSDC faucet).
2. Discover tradable BTC/ETH Event Contracts via `@somnia-chain/markets-sdk` `0.29.0`.
3. Apply timing gates, then pick **one** market (nearest expiry among ENTERs). Each autonomous scan reports `Trades: 1` because it executes that single selected ENTER — not because discovery only found one market.
4. Decide YES/NO from the book (5m/15m+) or a Binance five-print vote (1m).
5. Size the stake, run risk checks, submit an IOC order.
6. Manage, settle, and claim.

## Trading pipeline

```text
DreamDEX listing (live binaries, limit 100)
  → BTC/ETH + tradable + timing eligibility
  → rank ENTER candidates by least time remaining
  → direction
       ├─ 1m: five Binance sampler prints, four adjacent moves
       └─ 5m / 15m+: edge-taker-v1 (fair 0.50, edge 0.08)
  → entry/limit price from the book
  → stake
       ├─ manual /trade: user defaultStake
       └─ autonomous: adaptive fraction of maxTradeStake from entry vs 0.50
  → evaluateRisk (min/max, daily loss, open slots, collateral)
  → IOC execution
  → positions / early-loss exit / settlement / claim
```

### Timing
- **1m:** `left >= 30s`
- **5m:** `left >= 120s`
- **15m+:** `left >= 300s`

### 1m Binance vote
Sampler (~15s REST, no API key) keeps rolling prints. Five usable prices → four UP/DOWN moves. 3–1 follows; 2–2 skips; 4–0 fades. A flat tick or fewer than five prints skips. Fail closed.

### 5m / 15m+
Order-book edge-taker: YES ask ≤ 0.42 → YES; else NO ask ≤ 0.42 → NO; else YES ask ≥ 0.58 → NO; else skip.

### Stake
- **Manual** TRADE NOW / `/trade`: `defaultStake` (e.g. 30 tUSDC).
- **Autonomous:** after the entry price is known, `edge = 0.50 − entryPrice`, band `0.50 + edge` into 25/30/40/60/80% of `maxTradeStake`, then clip through `evaluateRisk`. Example with max 50: 12.5 / 15 / 20 / 30 / 40 tUSDC.

Risk always applies: min/max stake, daily loss, max open positions, collateral, book preflight. `ENABLE_LIVE_EXECUTION` must be true for chain writes.

## Features

- Telegram buttons: TRADE NOW, AUTONOMOUS, POSITIONS, PERFORMANCE, WALLET, HELP
- Commands: `/trade`, `/auto`, `/settings`, `/faucet`, `/status`, `/positions`, `/history`, `/claim`, `/leaderboard`, `/fund`, `/privatekey`. `/stop` pauses autonomous only
- Autonomous 6-minute scan (one ENTER per scan) + early-loss management + claim sweep. Pauses at UTC midnight until TRADE NOW or `/auto on`
- IOC execution, partial fills, zero-fill quieting
- Settlement PnL from on-chain `winningOutcome` + filled contracts; `/claim` redeems win/void ERC-6909 balances as tUSDC

## Setup

Shannon only. Apply `supabase/migrations/` in order. Copy `.env.example` — never commit a real `.env`.

```bash
pnpm --filter @workspace/api-server run dev
pnpm run typecheck
pnpm run build
pnpm --filter @workspace/api-server run test
```

Default API port is `5000`. Deploy is Railway (`railway.json`).

### Environment

Required: `TELEGRAM_BOT_TOKEN`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `TREASURY_PRIVATE_KEY`, `WALLET_ENCRYPTION_KEY`.

Network defaults point at Shannon (`SOMNIA_RPC_URL`, `SOMNIA_WS_RPC_URL`, `DREAMDEX_INDEXER_URL`, `EXPLORER_TX_BASE_URL`, `INITIAL_GAS_SPONSOR_AMOUNT`, `PORT`).

Trading: `ENABLE_LIVE_EXECUTION=true` for real orders (default false).

Optional ceilings: `SYSTEM_MIN_STAKE_TUSDC`, `SYSTEM_MAX_STAKE_TUSDC`, `SYSTEM_MAX_OPEN_POSITIONS`, `SYSTEM_MAX_DAILY_LOSS_TUSDC` (code defaults 1 / 200 / 10 / 300).

No Binance API key. No Groq/LLM key.

## Diagnostics HTTP

Read-only: `GET /api/healthz`, `/api/readyz`, `/api/dreamdex/markets`, `/api/dreamdex/decisions`. Telegram trading does not use these.

## Network

- RPC: `https://dream-rpc.somnia.network`
- Explorer: `https://shannon-explorer.somnia.network`
- tUSDC: `0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E`
- OutcomeToken6909: `0xB52c5934113Af5c0Bb20eb3C72290C8215f755b9`

Event contracts can go to zero. IOC orders may not fill. Autonomous mode keeps scanning until a daily halt, a position cap, or you pause it.

## Stack

Node 24, TypeScript 5.9, pnpm, grammY, Express, Supabase, viem, `@somnia-chain/markets-sdk` `0.29.0`, Zod, pino.

## License

MIT — Copyright (c) 2026 Superfly
