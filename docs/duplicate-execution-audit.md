# Duplicate execution audit (CASE 4)

This is an investigation record. Sentry does **not** implement duplicate-trade
prevention, a one-trade-per-market rule, or a cooldown keyed by market/window.

## Observed symptom

The same BTC/ETH 5m market can receive more than one live order during one
autonomous cycle or across closely timed cycles.

## Path

`discovery → candidates → ranking → slots → persist → execute → retries/reconciliation`

1. `listLiveBinaryMarkets` (limit 100) + per-market `getMarketOnchain` / book.
2. 1m Binance vote XOR 5m/15m+ edge-taker. Ranking: nearest expiry, then `marketId`.
3. Autonomous fills `availableSlots` independently; each persist+execute consumes a slot.
4. Persist uses `userId:marketId:strategy:version:direction`. On unique-key collision,
   a non-terminal row is reused; a terminal row mints `:reentry:<tradeId>` and inserts again.
5. `submitLiveOrder` claims `pending` then places `ORDER_TYPE.MARKET` (IOC).
6. Reconciliation exists but is **not started**. Failed IOC is terminal, so the next
   scan (or a duplicate ranked row) can place a new order.

## Causes (not mutually exclusive)

| Cause | Verdict |
|---|---|
| Expected retry after terminal IOC miss | Yes. Failed/cancelled rows get a new reentry key. |
| Concurrent scans | **Bug-class.** Autonomous had no in-flight guard; `markAutonomousScan` runs after the cycle. A tick that lasts ≥6 minutes (or `/trade` overlapping autonomous) starts a second scan. A process-level in-flight guard was added with the WebSocket bus so WS + the 6-minute fallback cannot run the engine twice at once. This is **not** a one-trade-per-market rule. |
| Duplicate `marketId` in the live listing | Possible. Discovery does not dedupe. If the first attempt is already terminal, the second ranked copy re-enters in the **same** loop. |
| Stale slot snapshot | Slots are snapshotted once; persist re-reads open count. Neither unique-by-market. |
| Persistence timing | Intent is inserted before broadcast. Crash recovery is good; it does not stop a later reentry. |
| SDK 0.29.0 | Not the cause. Identity is still bytes32 `marketId`; live submit re-reads `getMarketOnchain`. |
| WebSocket + reconciliation | Previously unused. Reconciliation still does not place new orders. WS now triggers the **existing** engine (strategy/risk/execution), with the 6-minute loop as fallback. |
| Open inventory not excluded | `excludeMarketIds` only covers markets sold this tick. An open same-key market is only blocked if the unique idempotency key still points at a non-terminal row. |

## Genuine underlying issue

Overlapping autonomous ticks (missing in-flight guard + post-cycle scan mark)
is a real race. Proposed remaining fixes, **not implemented** here because they
would be product-policy / duplicate-prevention:

1. Pass the latest non-terminal row into `buildTradeIntent` so `duplicate_intent` is live.
2. Deduplicate `listLiveBinaryMarkets` by `marketId` before ranking.
3. Exclude currently open `(user, marketId, direction)` from the ranked ENTER list.

Do not add a "one trade per market" rule unless product asks for it.

## What was intentionally left alone

- Ranking, 1m XOR edge-taker, adaptive stake math, multi-slot fill, IOC/TAKE.
- Reentry after a terminal failed IOC (existing retry behavior).
