# Sentry — Hackathon submission

Telegram bot that trades DreamDEX BTC/ETH Up/Down event contracts on Somnia Shannon testnet.

Live bot: [@dreamsentrybot](https://t.me/dreamsentrybot)

## One-line pitch

Deterministic, per-user Telegram trading on DreamDEX: live WebSocket wakes, a 6-minute fallback, adaptive sizing, and fail-closed execution. No LLM on the trade path.

## What is implemented

- **Wallet:** one Shannon wallet per Telegram user. User signs every order. Treasury sponsors STT **only at wallet creation**. Later STT is claimed with [@somnia_helper_bot](https://t.me/somnia_helper_bot).
- **Discovery:** live BTC/ETH binaries via `@somnia-chain/markets-sdk` 0.29.0.
- **Strategy:** 1m Binance XOR vote; 5m/15m+ edge-taker vs 0.50. Unchanged ranking and eligibility.
- **Sizing:** autonomous adaptive bands from entry vs 0.50 (defaults 25/30/40/60/80% of max stake). Users can customize those existing bands in Settings.
- **Execution:** TAKE/IOC when the fresh book is executable; otherwise POST_ONLY at the snapped limit if it would not cross. Integer-tick preflight plus a book re-read before sign. `PostOnlyWouldCross` fails closed as “Not filled”.
- **Autonomy:** DreamDEX WS → existing engine (`trading` mode). 6-minute loop → full tick (early-exit, claims, day halt). Process-level in-flight guard. Shared read client; per-user write sessions.
- **Risk:** UTC-day PnL, daily loss, daily profit target, expiry-aware open-position cap (`min(user, system)`).
- **Lifecycle:** settlement, claims, early-loss exit on autonomous ticks (50% time elapsed and 50% unrealized loss).
- **UX:** buttons + slash commands, full copyable wallet address, clickable “View transaction” links, sanitized Telegram errors.

## Architecture

```text
Telegram (grammY)
  → strategy / risk / persistence
  → shared Somnia read client (WS)
  → per-user write session (sign + submit + close)

DreamDEX subscribeLive
  → coalesce scans (250ms)
  → debounce engine wake (8s)
  → autonomous trading tick (no claims / no early-exit / no empty notifies)

6-minute timer
  → full autonomous tick (trading + early-exit + claims + UTC day report)
```

## What we are not claiming

- Not mainnet / not real-money production.
- Not an LLM trader.
- Not a second WebSocket strategy. WS only wakes the existing pipeline.
- Not automatic STT top-ups after wallet creation.
- Not per-user timezone days. PnL, halt, and reports share UTC midnight.

## Run

```bash
pnpm --filter @workspace/api-server run test
pnpm run typecheck
```

See [README.md](README.md) for env, network addresses, and the full pipeline.

Development challenges and SDK/protocol bugs we hit: [feedback.md](feedback.md).
