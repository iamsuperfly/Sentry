import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyFinalization,
  explorerTxUrl,
  formatExecutionModeLabel,
  formatFinalizationMessage,
  formatRemaining,
  formatTimeframe,
  formatUserFacingTradeFailure,
  marketDurationSeconds,
  secondsUntilExpiry,
} from "./telegram-trade-format.ts";
import {
  classifyOpenTradeFinalization,
  isMarketResolved,
  shouldShowInPositions,
} from "./position-lifecycle.ts";

describe("timeframe formatting", () => {
  it("formats 5 and 30 minute windows", () => {
    assert.equal(formatTimeframe(5 * 60), "5m");
    assert.equal(formatTimeframe(30 * 60), "30m");
    assert.equal(formatTimeframe(60 * 60), "1h");
  });

  it("derives duration from tradingStart and expiry", () => {
    const start = 1_700_000_000;
    const expiry = start + 300;
    assert.equal(marketDurationSeconds(String(start), String(expiry)), 300);
    assert.equal(formatTimeframe(marketDurationSeconds(start, expiry)), "5m");
  });
});

describe("remaining time", () => {
  it("formats countdown", () => {
    assert.equal(formatRemaining(4 * 60 + 37), "4m 37s");
    assert.equal(formatRemaining(27 * 60 + 8), "27m 08s");
  });

  it("marks non-positive as resolved", () => {
    assert.equal(formatRemaining(0), "resolved");
    assert.equal(formatRemaining(-10), "resolved");
  });

  it("computes seconds until expiry", () => {
    const now = 1_700_000_000;
    assert.equal(secondsUntilExpiry(now + 120, now), 120);
    assert.equal(secondsUntilExpiry(now - 1, now), -1);
  });
});

describe("explorer URL", () => {
  it("joins base and hash without double slash", () => {
    assert.equal(
      explorerTxUrl("https://shannon-explorer.somnia.network/tx", "0xabc"),
      "https://shannon-explorer.somnia.network/tx/0xabc",
    );
    assert.equal(
      explorerTxUrl("https://shannon-explorer.somnia.network/tx/", "0xabc"),
      "https://shannon-explorer.somnia.network/tx/0xabc",
    );
  });
});

describe("position visibility", () => {
  it("hides open trades when market expiry has passed", () => {
    const now = 1_700_000_500;
    assert.equal(
      shouldShowInPositions({
        status: "filled",
        marketExpiry: 1_700_000_000,
        nowSec: now,
      }),
      false,
    );
  });

  it("keeps genuinely active filled positions", () => {
    const now = 1_700_000_000;
    assert.equal(
      shouldShowInPositions({
        status: "filled",
        marketExpiry: now + 600,
        nowSec: now,
      }),
      true,
    );
  });

  it("hides when market is finalized", () => {
    assert.equal(
      shouldShowInPositions({
        status: "filled",
        market: {
          marketId: "m1",
          expiry: String(1_800_000_000),
          finalized: true,
        },
        nowSec: 1_700_000_000,
      }),
      false,
    );
  });
});

describe("finalization classification", () => {
  it("expires pure pending after market resolve", () => {
    const decision = classifyOpenTradeFinalization({
      trade: {
        id: "t1",
        status: "pending",
        marketId: "m1",
        transactionHash: null,
        filledContracts: null,
        marketExpiry: 1_700_000_000,
      },
      nowSec: 1_700_000_100,
    });
    assert.equal(decision.action, "expire_pending");
  });

  it("settles filled after market resolve", () => {
    const decision = classifyOpenTradeFinalization({
      trade: {
        id: "t1",
        status: "filled",
        marketId: "m1",
        transactionHash: "0x1",
        filledContracts: 10,
        marketExpiry: 1_700_000_000,
      },
      nowSec: 1_700_000_100,
    });
    assert.equal(decision.action, "settle_filled");
  });

  it("does not finalize active markets", () => {
    const decision = classifyOpenTradeFinalization({
      trade: {
        id: "t1",
        status: "filled",
        marketId: "m1",
        transactionHash: "0x1",
        filledContracts: 10,
        marketExpiry: 1_700_001_000,
      },
      nowSec: 1_700_000_000,
    });
    assert.equal(decision.action, "none");
  });

  it("detects resolved market", () => {
    assert.equal(
      isMarketResolved({ expiry: "1700000000", finalized: false }, 1_700_000_001),
      true,
    );
  });
});

describe("finalization messages", () => {
  it("formats win with payout", () => {
    const text = formatFinalizationMessage({
      symbol: "BTC",
      direction: "up",
      status: "settled",
      stake: 10,
      pnl: 9.4,
      tradingStart: 1_700_000_000,
      marketExpiry: 1_700_000_300,
      explorerTxBaseUrl: "https://shannon-explorer.somnia.network/tx",
      transactionHash: "0xabc",
    });
    assert.match(text, /Trade finalized/);
    assert.match(text, /WIN/);
    assert.match(text, /Payout: 19\.4/);
    assert.match(text, /\+9\.4/);
    assert.match(text, /5m/);
    assert.match(text, /shannon-explorer/);
  });

  it("formats loss", () => {
    const text = formatFinalizationMessage({
      symbol: "BTC",
      direction: "up",
      status: "settled",
      stake: 10,
      pnl: -10,
      tradingStart: 1_700_000_000,
      marketExpiry: 1_700_000_300,
      explorerTxBaseUrl: "https://shannon-explorer.somnia.network/tx",
    });
    assert.match(text, /LOSS/);
    assert.match(text, /-10/);
  });

  it("formats failed/cancelled", () => {
    assert.equal(classifyFinalization({ status: "failed" }), "failed");
    assert.equal(classifyFinalization({ status: "cancelled" }), "cancelled");
  });
});

describe("formatUserFacingTradeFailure", () => {
  it("maps no_enter_decision without exposing stage or code", () => {
    const text = formatUserFacingTradeFailure({
      code: "no_enter_decision",
      reason: "Stage 2 produced no enter decision for the current markets.",
    });
    assert.match(text, /No trade placed/);
    assert.match(text, /No funds were used/);
    assert.doesNotMatch(text, /Stage/);
    assert.doesNotMatch(text, /no_enter_decision/);
    assert.doesNotMatch(text, /Code:/);
  });

  it("maps position and stake limits without internal field names", () => {
    const pos = formatUserFacingTradeFailure({
      code: "user_max_open_positions",
      reason: "user max open positions",
    });
    assert.match(pos, /Position limit/);
    assert.doesNotMatch(pos, /user_max_open_positions/);

    const stake = formatUserFacingTradeFailure({
      code: "stake_exceeds_user_max",
    });
    assert.match(stake, /Stake not allowed/);
    assert.doesNotMatch(stake, /stake_exceeds/);
  });

  it("maps live_execution_disabled without env jargon", () => {
    const text = formatUserFacingTradeFailure({
      code: "live_execution_disabled",
      reason: "ENABLE_LIVE_EXECUTION is false",
    });
    assert.match(text, /not submitted on-chain/i);
    assert.doesNotMatch(text, /ENABLE_LIVE/);
    assert.doesNotMatch(text, /live_execution_disabled/);
  });

  it("formats execution mode labels for users", () => {
    assert.match(formatExecutionModeLabel("paper"), /paper/);
    assert.match(formatExecutionModeLabel("paper"), /no on-chain/);
    assert.equal(formatExecutionModeLabel("testnet"), "testnet");
  });
});
