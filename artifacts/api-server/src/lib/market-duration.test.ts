import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyDurationBucket,
  classifyMarketDuration,
  resolveWindowSeconds,
} from "./market-duration.ts";

describe("market duration classification", () => {
  it("classifies standard windows", () => {
    assert.equal(classifyDurationBucket(60), "1m");
    assert.equal(classifyDurationBucket(300), "5m");
    assert.equal(classifyDurationBucket(900), "15m");
    assert.equal(classifyDurationBucket(1800), "30m");
    assert.equal(classifyDurationBucket(3600), "1h");
    assert.equal(classifyDurationBucket(14400), "4h");
    assert.equal(classifyDurationBucket(86400), "1d");
  });

  it("unknown for non-standard", () => {
    assert.equal(classifyDurationBucket(6), "unknown");
    assert.equal(classifyDurationBucket(176), "unknown");
    assert.equal(classifyDurationBucket(null), "unknown");
  });

  it("prefers window when intervalSec is odd", () => {
    const start = 1_700_000_000;
    const r = classifyMarketDuration({
      intervalSec: 6,
      tradingStart: start,
      expiry: start + 300,
    });
    assert.equal(r.bucket, "5m");
    assert.equal(r.windowSec, 300);
    assert.equal(r.source, "window");
  });

  it("both_agree when interval matches window", () => {
    const start = 1_700_000_000;
    const r = resolveWindowSeconds({
      intervalSec: 900,
      tradingStart: start,
      expiry: start + 900,
    });
    assert.equal(r.source, "both_agree");
    assert.equal(r.windowSec, 900);
  });
});
