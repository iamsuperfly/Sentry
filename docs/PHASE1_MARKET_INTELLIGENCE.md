# Phase 1 — Market intelligence notes

## SDK 0.28.1 listing APIs (verified in package types)
- `client.listBinaryMarkets(opts?)`
- `client.listLiveBinaryMarkets(filter?)` — currently live (`expiry > now`)
- Past/finalized discovery via past-binary list helpers for claim phase

## 1m strategy
Pure ±0.05% underlying move in final 30s. Requires injected BTC/ETH spot prices.
No underlying price feed is wired in the repo yet — integration blocked until a verified free source is chosen.

## Gemini
`GEMINI_API_KEY` + optional `GEMINI_MODEL`. Missing key fails closed (no fake AI).
