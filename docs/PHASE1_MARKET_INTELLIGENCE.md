# Market intelligence notes

## Current production path

- **1m markets:** deterministic Binance public spot ±0.05% in the final window. Independent REST sampler (~15s) feeds a rolling in-memory cache; the scan reads the cache and does not block on live polls.
- **5m / 15m+ markets:** Groq (`GROQ_API_KEY`, optional `GROQ_MODEL`, default `openai/gpt-oss-20b`) ranks eligible markets. Missing key fails closed. Deterministic validation, adaptive stake, and risk still decide what executes.

SDK 0.28.1 listing APIs (verified in package types):

- `client.listBinaryMarkets(opts?)`
- `client.listLiveBinaryMarkets(filter?)` — currently live (`expiry > now`)
- Past/finalized discovery via past-binary list helpers for claim phase

## Historical (Gemini)

Phase 1 originally used Google Gemini (`GEMINI_API_KEY` + optional `GEMINI_MODEL`). That provider is no longer on the production trading path and has been replaced by Groq. Git history still contains the Gemini client for reference.
