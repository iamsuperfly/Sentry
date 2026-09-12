# Sentry — hackathon development postmortem

Solo Telegram bot trading DreamDEX BTC/ETH Up/Down event contracts on Somnia Shannon, using `@somnia-chain/markets-sdk` `0.29.0`.

Live bot: [@dreamsentrybot](https://t.me/dreamsentrybot) · repo: [iamsuperfly/Sentry](https://github.com/iamsuperfly/Sentry)

This is what I actually hit. Not a pitch.

---

## Observed

### `subscribeLive` is a store-commit callback, not a trading-event API

I treated `client.subscribeLive(cb)` as “market listed / book moved.” In 0.29.0 it is `store.subscribe`. From SDK source, the store commits on every MaterializerStore mutation, including `onHead` / `setStatus`. Shannon block time is ~100ms; `onHead` commits twice per block. The callback therefore runs on head cadence (~10–20/s), synchronously, on the same Node event loop as grammY.

Related, also from SDK source and my wiring:

- `watchMarkets({ discover: true })` hydrates **all** indexer markets and grows the watch set on `MarketCreated`. More pools → larger `eth_subscribe` set → more commits → slower scans.
- Books re-derive on every head (expiry uses `Date.now()` in a version-keyed select). A quiet book still changes when a resting level expires.
- I fingerprinted top-of-book **quantity** as well as price, so any size tick emitted `book_change`.
- I discarded the `WatchHandle` (`void handle`) and never called `stop()`. The all-markets tail never tore down.
- Store listeners persist across reconnect; reconnect still does `setStatus` + `getLogs` backfill on the same socket.

### WebSocket wake ran the full engine

Intended shape: WS event → existing engine; 6-minute loop → fallback (claims, early-exit).

What I shipped first: every store commit → scan all live rows → 1s `book_change` debounce → `requestTick(minIntervalMs = 0)`. Interval `0` bypassed the 5-minute per-user skip. The in-flight guard only serializes. Result: a continuous full tick for every autonomous user — early-exit write session, cold indexer listing, per-market `getMarketOnchain` + `getBinaryOrderBook`, strategy/risk, Telegram (including `no_enter`), then claims.

Discovery did not read the live store. WS was only a poke. Listing `eth_call`s ran on the **same** shared viem WebSocket as `watchBlocks({ emitMissed: true })`. That starved the tail, tripped reconnect/backfill, and matched the Railway CPU/network spikes.

`/help` and `/settings` do almost no I/O. They got slow because they share the event loop and `bot.api`. grammY honors `retry_after`; empty-scan Telegram 429s delayed command replies.

### Shared read client vs per-user writes

One process-level `SomniaMarkets` for reads is correct. Writes sharing that client (or extra clients in dead paths) produced:

- Other Telegram users appearing not to trade (`unreachable`, `invariant violated: expected a value to be present`, `no external wallet client`).
- Write-session `close()` raced against a 2s timer; hung closes can linger while ticks create/close sockets per user per phase.
- SDK failures with **no transaction hash** left the trade row `submitted` and consumed an open slot until finalization.

### `ORDER_TYPE` and `POST_ONLY`

Values I had to pin from the SDK and keep in tests:

| Name | Value | Use |
|---|---|---|
| `LIMIT` | 0 | unused for entry |
| `FOK` | 1 | unused |
| `MARKET` | 2 | IOC-style take |
| `POST_ONLY` | 3 | rest, must not take |

`PostOnlyWouldCross()` is a **pool revert**, not a gas error. I initially classified some of those reverts as insufficient STT and tried treasury sponsor → retry. That spends gas budget and still reverts.

Local would-cross used human floats (`ask.price <= limit + 1e-9`). Placement used `parseUnits(String(limitPrice), decimals)`, not the snapped raw tick. A reconstructed human can round one tick up and cross on-chain after a “safe” preflight. That is the verified path to `PostOnlyWouldCross()` after local checks.

Also true in my code: three book reads (preflight → adapter → chain) so TOCTOU remains; an invalid `levels[0]` was treated as “no ask,” which allowed a maker that could still cross a deeper valid level.

### Error classification

Reverts and client failures I actually saw:

- `ImmediateOrCancelNoFill()` — common; user-facing “Not filled”
- `PostOnlyWouldCross()` — same user outcome, different selector
- `unreachable: no external wallet client`
- `invariant violated: expected a value to be present`
- `execution reverted` + 4-byte selectors
- JSON-RPC / WebSocket / `ws_request` / `not connected`
- allowance / `readContract` / `fetch failed`

Interpolating `error.message` or `result.code` into Telegram shows Solidity names. My autonomous fallback was `Autonomous scan\n\n${result.code}`. Slicing unknown strings to 180 chars still leaks.

Gas vs revert is a separate trap. `PostOnlyWouldCross` is not insufficient STT. `insufficient funds for gas * price + value` is.

### Book freshness

`listLiveBinaryMarkets` (indexer HTTP), `getLiveBinaryOrderBook` (WS store), and `getBinaryOrderBook` / `getMarketOnchain` (RPC) disagree under load. I listed from the indexer, read books on the shared WS, then the matcher executed against a third view. IOC no-fill and `PostOnlyWouldCross` both happen in that gap. 1m windows make it obvious.

The SDK has no “is this store book fresh enough to TAKE?” helper. I invented `book_stale` / `no_usable_ask` / `insufficient_liquidity` in app code; those names then leaked into Telegram until I mapped them.

### STT

Shannon needs STT. I sponsor once at wallet creation (`INITIAL_STT_SPONSOR`). I also added automatic replenish on later submits (sponsor → retry): uncapped treasury spend, retries of non-gas failures, and copy that promised Sentry would top up STT. That fought `@somnia_helper_bot`.

### Position lifecycle

On-chain `Locked` / `Resolved` does not update my `trades` rows. Display used an expiry-aware count; persist/risk counted every `pending | submitted | partially_filled | filled` row. Users saw Active (4) of max 10, then `/trade` returned “Position limit reached” because stale submitted/filled rows on expired markets still occupied slots.

No-hash SDK failures left `submitted` and hogged a slot. Stale-pending cleanup only expired `pending` with no hash and no fill.

Copy trap: system max is 10, user default is 1. Help quoting “max positions 10” looks like the user’s cap.

---

## What I fixed

- Coalesced `subscribeLive` scans (250ms) and debounced engine wakes to 8s for every opportunity kind, including `book_change`.
- Split ticks: WS → `trading` (discovery → strategy → risk → execution). 6-minute loop → `full` (plus early-exit, claims, UTC-day pause). WS ticks do not `markAutonomousScan`, so the fallback still runs.
- Stopped Telegram on `no_enter` / book-miss / empty success.
- Kept the `WatchHandle` and stop it with the bus.
- One shared read `SomniaMarkets`; per-user write sessions opened and closed around sign/submit.
- No-hash SDK failures now fail the row closed so the slot is released.
- Integer-tick would-cross when decimals are known; adapter re-reads before sign; on-chain `PostOnlyWouldCross` maps to “Not filled,” not gas.
- Removed later STT replenish. Creation sponsor stays. Copy points at `@somnia_helper_bot`.
- Open-position count for risk/persist is the same expiry-aware helper as `/positions`.
- Autonomous fallback no longer interpolates `result.code`. Unknown SDK notes are dropped, not sliced into Telegram.
- Network/allowance Telegram copy is only the short stable message plus `@iamsuperflly`.

---

## What remains

- Residual TOCTOU: the matcher can still move between the last local book read and inclusion. I fail closed; I cannot promise the store book is the matcher book.
- WS trading ticks still cold-list rather than reading `getLiveMarkets` + `getLiveBinaryOrderBook` as the source of truth. Amplification is reduced, not eliminated.
- `close()` hanging past the 2s timer can still leave internals around under load.
- Early-exit sell still uses `ORDER_TYPE.MARKET` (comment historically said IOC). I did not change that mid-hackathon.
- `user_settings.timezone` and helpers named `calendarDateInZone` / `isInstantInLocalDay` remain; application code ignores them. PnL, halt, faucet, and the daily report are UTC midnight. I almost “fixed” a local/UTC split that did not exist.
- Invalid top-of-book (`levels[0]` unusable) still needs a walk to the first valid `(0,1)` ask. Integer-tick compare is in; deeper-level walk is not fully closed.

---

## Recommendations to the SDK team

1. Document `subscribeLive` as head-cadence store commits, not market/book events. A filtered or coalesced callback (Trading binaries, or log-batch only) would match how bots actually use it.
2. Make `watchMarket` on the current live BTC/ETH set the documented default. Warn that `watchMarkets({ discover: true })` is the entire indexer.
3. Document one long-lived read client, short-lived write sessions with an explicit signer, and `close()` that completes. A public “is this client bound to a wallet?” check would have saved a day. `unreachable` / InvariantError are too vague to persist or show users.
4. Expose raw tick prices on live book levels (`bigint`) and a `wouldCross(side, limitRaw)` helper. Document `PostOnlyWouldCross` as a pool invariant, not “maker if possible.” One sentence that `MARKET` (2) is the IOC-style take would have avoided reverse-engineering `ORDER_TYPE`.
5. Stable `placeOrder` error codes (`NO_FILL`, `WOULD_CROSS`, `NO_GAS`, `NOT_CONNECTED`, `NO_WALLET`) in addition to revert selectors. A `classifyPlaceOrderError(err)` would stop every bot from writing the same regexes.
6. A freshness timestamp on live books, and a rule for when the store is authoritative vs when you must `eth_call`. The hot path should not re-RPC the tail socket to “confirm” a WS event.
7. One STT story in the hackathon docs: sponsor once **or** `@somnia_helper_bot`, not both by accident. A cheap STT `balanceOf` on the session beats discovering gas from the revert.
8. Lifecycle note: on-chain `Locked` / `Resolved` does not update the caller’s database. If the platform day is UTC, say so and do not ship unused timezone columns in example schemas.

The live path is chatty. The error path is a string. Those two facts caused most of the production bugs.
