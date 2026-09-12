# Sentry — hackathon development feedback

Project: [Sentry](https://github.com/iamsuperfly/Sentry) — Telegram bot trading DreamDEX BTC/ETH Up/Down event contracts on Somnia Shannon testnet.

Live bot: [@dreamsentrybot](https://t.me/dreamsentrybot)

This is not a pitch. It is the list of things that actually burned time, broke users, or were easy to get wrong while wiring `@somnia-chain/markets-sdk` `0.29.0` into a real multi-user bot.

---

## 1. `subscribeLive` is not a trading-event API

This was the most expensive misunderstanding of the hackathon.

We treated `client.subscribeLive(cb)` as “tell me when a market lists or the book moves.” In 0.29.0 it is `store.subscribe`. The store commits on **every MaterializerStore mutation**, including `onHead` / `setStatus`. Shannon block time is ~100ms. `onHead` commits **twice per block**. That is ~10–20 callbacks per second, synchronously, on the Node event loop that also runs grammY.

What made it worse:

- `watchMarkets({ discover: true })` hydrates **all** indexer markets, then grows the watch set on every `MarketCreated`. More pools → larger `eth_subscribe` address list → more logs → more commits → slower `scan()`.
- Books re-derive on every head because expiry uses `Date.now()` inside a version-keyed select. A quiet book still “changes” when a resting level expires.
- Our first scan fingerprinted top-of-book **quantity** as well as price. Any fill or size tick emitted `book_change`.
- We discarded the `WatchHandle` (`void handle`) and never called `handle.stop()`. The all-markets tail never tore down.
- Reconnects did not multiply `subscribeLive` listeners (store listeners persist), but they did `setStatus` + `getLogs` backfill for the full watch set on the **same** socket. That is a CPU/network spike, not a clean resume.

**Ask:** document `subscribeLive` as “store commit, including every head,” not “market/book event.” Provide a filtered callback (Trading binary pools only, or log-batch only) and a first-class `WatchHandle.stop()` example. `watchMarket` for a small live set should be the documented default; `watchMarkets({ discover: true })` should warn that it is the entire indexer.

---

## 2. WebSocket as a wake-up became a second full engine

Architecture we wanted:

```text
DreamDEX WS event  →  existing engine
6-minute loop      →  fallback / claims / early-exit
```

Architecture we accidentally shipped first:

```text
every store.commit
  → scan all live rows
  → debounce book_change at 1s
  → requestTick(minIntervalMs = 0)   // bypasses the 5-minute skip
  → for EVERY autonomous user:
        early-exit write session
        cold indexer listing + per-market getMarketOnchain + getBinaryOrderBook
        strategy + risk + possibly sign
        Telegram notify (including no_enter)
        claim scan + another write session
```

`minIntervalMs = 0` is the smoking gun. The in-flight guard only **serializes**. As soon as a tick finished, the next 1s debounce started another. Effective rate: one full multi-user engine run, continuously.

Discovery did **not** read the live store. WS was only a poke. Then every user paid `listLiveBinaryMarkets` (limit 100) plus ~2 chain reads per market on the **same** shared viem WebSocket as `watchBlocks({ emitMissed: true })`. Listing `eth_call`s starved the tail → stall → `onWsError` → reconnect/backfill → Railway CPU/network spike. That matched production.

`/help` and `/settings` do almost no I/O. They felt slow because they share the event loop **and** `bot.api` with that storm. grammY honors Telegram `retry_after`. A 1 Hz no-op scan × N users → 429s → command replies wait on retry-after.

**What we changed:** 250ms scan coalesce, 8s engine debounce for every opportunity kind, `trading` vs `full` tick modes, no `markAutonomousScan` on WS ticks so the 6-minute fallback still does claims, no Telegram on `no_enter` / book-miss.

**Ask:** an official “WS feeds the engine, do not re-list” pattern. `getLiveMarkets` + `getLiveBinaryOrderBook` should be enough for the hot path. Re-RPC on every wake is the load amplifier.

---

## 3. Shared read client vs per-user writes

One process-level `SomniaMarkets` for reads is correct. We originally let writes share it, or constructed extra clients in dead paths (`exchangeFromConfig` in resolved-market). Effects we hit:

- Other Telegram users appeared never to trade. Writes were colliding / waiting on one wallet context, or failing with `unreachable` / `invariant violated: expected a value to be present` / `no external wallet client`.
- Closing a write session races SDK `close()` against a 2s timer. If `close()` hangs, internals can linger. Continuous ticks ⇒ create/close WS per user per phase (manage, place, claim).
- SDK errors with **no transaction hash** used to leave the trade row `submitted`. That consumed an open slot forever. We now fail those closed.

**Ask:** a documented recipe: one long-lived read client, short-lived write sessions with an explicit wallet, and `close()` that actually finishes. A public “is this client currently bound to a signer?” invariant would have saved a day. `unreachable` / InvariantError are too vague to show users and too easy to mis-handle in persistence.

---

## 4. ORDER_TYPE and POST_ONLY

SDK mapping we had to reverse-engineer and pin in tests:

| Name      | Value | How we use it      |
|-----------|-------|--------------------|
| LIMIT     | 0     | not used for entry |
| FOK       | 1     | not used           |
| MARKET    | 2     | IOC-style take     |
| POST_ONLY | 3     | rest, never take   |

`PostOnlyWouldCross()` is a **pool revert**, not a gas error. We originally classified some reverts as insufficient gas and tried to sponsor STT. That burns treasury and still reverts.

Local would-cross was `ask.price <= limit + 1e-9` in human floats. Placement used `parseUnits(String(order.limitPrice), decimals)`, not the snapped raw tick. A reconstructed human can round **one tick up** and land on/through the ask. That is how POST_ONLY still hit `PostOnlyWouldCross()` on-chain after a “safe” preflight.

Other holes:

- Three book reads (preflight → adapter re-read → chain). Book can move. Residual TOCTOU is real; we fail closed and map the revert to “Not filled,” but we cannot promise the matcher sees the same book we did.
- `levelFromBookSide` used `levels[0]` and treated an invalid top (`price <= 0` or `>= 1`) as “no ask,” which allowed POST_ONLY that would still cross a deeper valid ask.
- `selectEntryExecution` did not call `postOnlyWouldCross`. Stale/no-ask → POST_ONLY, and only later did submit check cross. Same tick, same book, still signed a crossing maker.
- Strategy stays TAKE/IOC. POST_ONLY is an execution fallback, not a user setting. That split is easy to get wrong in docs and Telegram copy.

**Ask:** expose raw tick prices on live book levels (bigint), a `wouldCross(side, limitRaw)` helper, and document that POST_ONLY is a pool invariant, not “maker if possible.” Mapping MARKET=2 to IOC behaviour also deserves a sentence in the SDK README. We kept MARKET for early-exit sells because changing it mid-hackathon was a product change, not a bugfix — the comment said IOC, the code said MARKET.

---

## 5. SDK errors leak or get misclassified

The contract reverts we actually saw in Telegram and logs:

- `ImmediateOrCancelNoFill()` — common, should be quiet “Not filled”
- `PostOnlyWouldCross()` — same user-facing outcome, different selector
- `unreachable: no external wallet client`
- `invariant violated: expected a value to be present`
- `execution reverted` + 4-byte selectors
- JSON-RPC / WebSocket / `ws_request` / `not connected`
- allowance / `readContract` / `fetch failed`

If you interpolate `error.message` or `result.code` into Telegram, users see Solidity names. Our autonomous fallback was literally:

```text
Autonomous scan

${result.code}
```

That is a footgun. Sanitizing “unknown” by `raw.slice(0, 180)` is also a footgun — it still leaks.

Gas vs revert is another trap. `PostOnlyWouldCross` is not insufficient STT. `insufficient funds for gas * price + value` is. Mixing them produced sponsor→retry on a revert that will never succeed.

**Ask:** stable error codes from the SDK (`NO_FILL`, `WOULD_CROSS`, `NOT_CONNECTED`, `NO_WALLET`) instead of (or in addition to) revert selectors. A `classifyPlaceOrderError(err)` in the SDK would stop every bot from writing the same regexes.

---

## 6. Indexer / live store / on-chain book are three clocks

`listLiveBinaryMarkets` (indexer HTTP), `getLiveBinaryOrderBook` (WS store), `getBinaryOrderBook` / `getMarketOnchain` (RPC) disagree under load.

We listed from the indexer, then read books on the shared WS, then the matcher executed against a third view. IOC no-fill and PostOnlyWouldCross both happen in that gap. 1m windows (30s eligibility, 90s skip for early-exit) make the gap visible.

There is no SDK helper for “is this store book fresh enough to TAKE?” We invented `book_stale` / `no_usable_ask` / `insufficient_liquidity` in app code. Those names then leaked into Telegram until we mapped them.

**Ask:** a freshness timestamp on live books, and a documented rule for when the store is authoritative vs when you must `eth_call`.

---

## 7. Gas: treasury sponsor vs `@somnia_helper_bot`

Shannon needs STT. We sponsored once at wallet creation (`INITIAL_STT_SPONSOR`). That is the right onboarding UX.

We also added automatic replenish on later submits (sponsor → retry). That:

- spends treasury with no cap
- retries a tx that may not be a gas failure
- taught users that Sentry magically tops up STT
- fought the intended helper-bot flow

Removing replenish without updating copy was its own bug: Telegram still said “Sentry sponsors STT gas when the wallet is short.”

**Ask:** one recommended pattern in the hackathon docs. Either “bots may sponsor gas” with a faucet/treasury recipe, or “users must use `@somnia_helper_bot`” with a copy-paste snippet. Mixing both in the same weekend created support load. Also: a cheap `balanceOf(STT)` helper on the session so we do not find out from the revert.

---

## 8. Position lifecycle vs “open slots”

Event contracts expire. Trade rows do not, until a finalization worker settles them.

We had two counters:

- Display (`/positions`, dashboard): expiry-aware, hide resolved/expired
- Risk / persist: `count(*)` where status in `pending | submitted | partially_filled | filled`

Users saw **Active (4)** with max 10, then `/trade` returned “Position limit reached.” The extra six were stale submitted/filled on expired markets waiting on a global finalization `limit: 40`.

Stale-pending cleanup only expired `pending` with **no hash and no fill**. A no-hash SDK failure left `submitted` and hogged a slot until we changed that path to fail closed.

**Ask:** this is app-level, but it is the default trap for anyone persisting CLOB fills. A note in the lifecycle docs — “Trading status ending does not close your off-chain order row” — would have been enough.

Related product copy trap: system max open positions is 10, **user default is 1**, DB check allows ≤ 20. Help quoting “max positions 10” makes users think they are capped at the system number.

---

## 9. UTC day vs leftover timezone

We added per-user timezone, then tore it out. PnL, daily halt, autonomous pause, faucet `date_trunc`, and the end-of-day report are all **UTC midnight**. That is consistent.

What remained and caused a second investigation:

- column `timezone` still on `user_settings`
- helpers named `calendarDateInZone`, `getZonedDayBounds`, `isInstantInLocalDay`, `last_autonomous_local_date`
- `/status` printing `Timezone: ${settings.timezone}` while the code `void`s the zone argument
- tests that **assert** `Africa/Lagos` is ignored

The names lied. We almost “fixed” a UTC/local split that did not exist.

**Ask:** if the platform day is UTC, say so in the starter and do not ship timezone columns in example schemas.

---

## 10. Telegram as a trading UI

Things that sound small and were not:

- Explorer links as raw `Tx: https://shannon-explorer…/0x…` in private chats. Users need **View transaction**, not a 80-character URL. HTML `<a>` requires `parse_mode: HTML` on every reply that includes one; mixing `<` from adaptive-band copy (`<0.55→25%`) with HTML parse mode breaks messages.
- WALLET truncated `0x1234…abcd`. There is no `/wallet` command. Users could not copy the address without `/status`. Telegram `copy_text` exists; we already used it for private keys and forgot it for the address.
- Autonomous notify on every empty scan trains users to mute the bot, then they miss fills.
- Network/allowance copy grew extra sentences. Organizers (and users) wanted a short, stable message and a human to ping. SDK strings must never be the body.
- Button Settings vs slash `/settings adaptive`. Features that only exist as slash commands are invisible.

grammY itself was fine. The constraint is: the bot process **is** the trading engine. Any WS amplification is a UX outage.

---

## 11. Early-exit and settlement races

Early-exit is autonomous-only: 50% of (expiry − fill) elapsed **and** 50% unrealized loss vs entry, then a live sell.

Bugs we found in our own code, not the SDK:

- List was status-only. Expired inventory was still “managed” if finalization had not run.
- Formatter inferred side from `symbol.includes("down")`. ETH UP rendered wrong. A second unused formatter already had `direction`.
- Failed sells put `error.message` on the row. Positions then showed raw SDK text unless sanitization matched.
- Comment said IOC-sell; code used `ORDER_TYPE.MARKET`.
- POST_ONLY resting stays `submitted` with a `post_only_resting` note, so it is correctly **not** in the early-exit list until it fills. Easy to miss when debugging “why didn’t it exit.”

Settlement PnL from `winningOutcome` + filled contracts is the right model. Reconstructing it off-chain when `settled_at` and `created_at` straddle UTC midnight made daily win rate easy to define two different ways. We scoped the report to `settled_at` in the UTC day.

---

## 12. Docs, examples, and versioning

- SDK 0.29.0 is what we targeted. Examples and types around watch/live/orderType needed more than a changelog bump. ORDER_TYPE numeric values, `subscribeLive` semantics, and POST_ONLY reverts were learned from source and mainnet-shaped testnet reverts.
- Node engine: local/CI Node 22 vs `engines.node: 24.x` warning. Not blocking, noisy, easy to ignore until something native fails.
- Railway: long-lived WS + `watchBlocks({ emitMissed: true })` + listing RPCs on one socket is a bad neighbor. Horizontal replicas would duplicate watchers; we stayed single-process and serialized ticks. That should be in a “bots in production” note.
- Shannon explorer, tUSDC, OutcomeToken6909, RPC/WS URLs were findable. Collateral decimals and tick/lot/minQuantity per market were not obvious until we snapped in app code (`snapBinaryPrice` / `snapBinaryAmount`).
- Event contracts can go to zero. IOC often does not fill. That is correct protocol behaviour. User copy has to treat no-fill as success-shaped (“nothing taken”), not as a crash.

---

## 13. What went well

- Per-user wallets (user signs, treasury never trades) is the right security model once write sessions are isolated.
- Deterministic strategy (1m Binance XOR + edge-taker vs 0.50) is testable. Dropping the LLM from the trade path removed a class of “AI said skip” bugs.
- Injectable live-execution deps meant POST_ONLY, gas, and no-hash failures could be unit-tested without Shannon.
- grammY + a persistent reply keyboard is a workable trading UI if you keep autonomous notifies quiet.
- `@somnia_helper_bot` is the right long-term STT story if onboarding still sponsors the first fill.

---

## 14. Concrete asks for the next cohort

1. Document `subscribeLive` as head-cadence store commits. Give a coalesced / filtered API.
2. Recommend `watchMarket` on the current BTC/ETH Trading set, not `watchMarkets({ discover: true })` of the whole indexer.
3. One read client, explicit per-user write sessions, `close()` that completes, hashed vs no-hash error classification.
4. Raw tick book levels + `wouldCross` + stable placeOrder error codes (`NO_FILL`, `WOULD_CROSS`, `NO_GAS`, `NOT_CONNECTED`).
5. Book freshness on the live store so bots do not re-RPC the tail socket to “confirm” a WS event.
6. One STT story in the hackathon README (sponsor once vs helper bot), not both by accident.
7. A short lifecycle note: on-chain `Locked`/`Resolved` does not update your database.
8. Say the trading day is UTC if that is what faucets and examples use.

Happy to walk through any of the above against the Sentry repo. The painful parts were almost all “the live path is chatty and the error path is a string.”
