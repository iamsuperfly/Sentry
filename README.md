# Sentry

Telegram trading assistant for **DreamDEX Event Contracts** on **Somnia Shannon testnet** (chain ID `50312`).

Sentry creates a per-user testnet wallet, discovers live BTC/ETH Up/Down markets, and places live orders either on demand or autonomously. Every live decision is deterministic. There is no LLM on the trading path.

**[@dreamsentrybot](https://t.me/dreamsentrybot)** — Shannon testnet only. Not intended for real funds.

[Demo video](https://youtube.com/shorts/X74ST7o10tE?feature=share)

## What it does

1. Onboard a dedicated wallet. Sentry sponsors STT **once** at wallet creation. Later STT is claimed manually via [@somnia_helper_bot](https://t.me/somnia_helper_bot). Daily tUSDC comes from the faucet.
2. Discover tradable BTC/ETH Event Contracts via `@somnia-chain/markets-sdk` `0.29.0`.
3. Apply timing gates, then rank ENTER candidates. Autonomous scans fill available slots (`min(userMax, systemMax) − openCount`) with independently sized trades. Manual TRADE NOW places one trade.
4. Decide YES/NO from the book (5m/15m+) or a Binance five-print vote (1m).
5. Size the stake, run risk checks, then TAKE/IOC when the fresh book is executable. Otherwise rest POST_ONLY at the intended snapped limit when that would not cross. Fail closed if it would.
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
  → TAKE/IOC, or POST_ONLY if the fresh book is not executable and would not cross
  → positions / early-loss exit / settlement / claim
```

Live DreamDEX WebSocket events wake the **same** engine (discovery → strategy → risk → execution). A 6-minute loop is the fallback for claims, early-exit, and reconciliation. WebSocket ticks do not create a second strategy.

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
- **Autonomous:** after the entry price is known, `edge = 0.50 − entryPrice`, band `0.50 + edge` into 25/30/40/60/80% of `maxTradeStake`, then clip through `evaluateRisk`. Users can customize those existing bands from Settings; unconfigured users keep the system defaults.

Risk always applies: min/max stake, daily loss, max open positions, collateral, book preflight. `ENABLE_LIVE_EXECUTION` must be true for chain writes.

Open-position counting is expiry-aware: stale submitted/filled rows on expired markets do not consume live slots. Display, `/trade`, and autonomous scans share that count. The user cap is independent of the system cap (default user max 1, system max 10); enforcement is `min(user, system)`.

## Features

- Telegram buttons: TRADE NOW, AUTONOMOUS, POSITIONS, PERFORMANCE, WALLET, HELP
- Commands: `/trade`, `/auto`, `/settings`, `/faucet`, `/status`, `/positions`, `/history`, `/claim`, `/leaderboard`, `/fund`, `/privatekey`. `/stop` pauses autonomous only
- Autonomous trading: live WebSocket wakes plus a 6-minute fallback. Pauses at UTC midnight until TRADE NOW or `/auto on`
- IOC TAKE when the book is executable; POST_ONLY rest when it is not, never crossing
- Settlement PnL from on-chain `winningOutcome` + filled contracts; `/claim` redeems win/void ERC-6909 balances as tUSDC
- Shared process-level Somnia read client (one WebSocket). Per-user write sessions are opened and closed per submit
- Trading day is UTC (00:00) for PnL, halt, counters, and the end-of-day report

## Wallet and gas

- One wallet per Telegram user. The user signs; treasury never trades.
- Initial STT sponsorship happens only during wallet creation.
- Additional STT is claimed with [@somnia_helper_bot](https://t.me/somnia_helper_bot). Sentry does not auto-replenish gas after that.
- WALLET shows the full copyable address.

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

Event contracts can go to zero. IOC orders may not fill. POST_ONLY may rest unfilled until lock. Autonomous mode keeps scanning until a daily halt, a position cap, or you pause it.

## Stack

Node 24, TypeScript 5.9, pnpm, grammY, Express, Supabase, viem, `@somnia-chain/markets-sdk` `0.29.0`, Zod, pino.

## License

MIT — Copyright (c) 2026 Superfly
