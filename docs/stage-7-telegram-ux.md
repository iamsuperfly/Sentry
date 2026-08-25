# Stage 7 — Telegram user layer

## Commands
- `/start` `/help` `/status` `/trade` `/positions` `/history` `/stop` `/settings`

## Settings (Supabase `user_settings`)
- default stake, max trade stake, max daily loss, max open positions
- daily profit target (or off)
- trading enabled/disabled
- execution mode: `paper` | `testnet`

Validated against system ceilings. Rejects out-of-range values.

## Safety
- Does not enable `ENABLE_LIVE_EXECUTION`
- Paper mode never requests live submit
- `/stop` disables trading without deleting history
