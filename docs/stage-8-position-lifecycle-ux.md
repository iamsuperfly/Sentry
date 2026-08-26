# Stage 8 — Position lifecycle + Telegram UX

## Goals
- `/positions` must not show markets past expiry/finalization
- Show market timeframe and time remaining from real market metadata
- Clickable Shannon explorer links
- Richer `/trade` and `/positions` messages
- Idempotent finalization notifications (one per trade)
- Human-friendly `/settings` multi-word commands

## Safety
- No second Telegram polling process
- Does not enable live execution
- Railway remains the production bot runtime
