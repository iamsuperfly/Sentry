# Market intelligence notes

## Current production path

- **1m markets:** five Binance sampler prints → four adjacent UP/DOWN moves (`left >= 30s`). Fail closed on missing/flat data.
- **5m / 15m+ markets:** deterministic `edge-taker-v1` on the DreamDEX book. Timing: 5m `left >= 120s`, 15m+ `left >= 300s`. Rank by nearest expiry.

SDK 0.29.0 listing APIs:

- `client.listLiveBinaryMarkets(filter?)` — currently live (`expiry > now`), paginated (`limit`/`offset`)
- `client.listBinaryMarkets(opts?)` — fallback
- Past/finalized discovery via past-binary list helpers for claim phase

There is no LLM on the live trading path.
