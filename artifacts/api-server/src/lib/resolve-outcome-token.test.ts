import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  OUTCOME_TOKEN_6909,
  outcomeBalanceParams,
  parseOutcomeId,
  resolveOutcomeTokenAddress,
} from "./resolve-outcome-token.ts";

const account = "0x333C45737d453f8F98E2D8976bCFA43AA9610795" as const;

function sdkReadsOutcomeToken(p: unknown): unknown {
  if (p !== null && typeof p === "object" && "outcomeToken" in p) {
    return (p as { outcomeToken: unknown }).outcomeToken;
  }
  return undefined;
}

describe("resolveOutcomeTokenAddress", () => {
  it("uses onchain.outcomeToken when it is a valid address", () => {
    const r = resolveOutcomeTokenAddress({
      outcomeToken: "0xB52c5934113Af5c0Bb20eb3C72290C8215f755b9",
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.source, "onchain");
      assert.equal(r.address.toLowerCase(), OUTCOME_TOKEN_6909.toLowerCase());
    }
  });

  it("falls back when outcomeToken is undefined", () => {
    const r = resolveOutcomeTokenAddress({});
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.source, "protocol_singleton");
      assert.equal(r.address, OUTCOME_TOKEN_6909);
    }
  });

  it("falls back when outcomeToken is the string undefined", () => {
    const r = resolveOutcomeTokenAddress({ outcomeToken: "undefined" });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.source, "protocol_singleton");
  });
});

describe("parseOutcomeId", () => {
  it("parses string and bigint ids", () => {
    assert.equal(parseOutcomeId("12"), 12n);
    assert.equal(parseOutcomeId(7n), 7n);
  });

  it("rejects empty values", () => {
    assert.equal(parseOutcomeId(undefined), null);
    assert.equal(parseOutcomeId(""), null);
  });
});

describe("outcomeBalanceParams", () => {
  it("builds the SDK object so p.outcomeToken is a real address", () => {
    const p = outcomeBalanceParams({
      outcomeToken: OUTCOME_TOKEN_6909,
      account,
      id: 12n,
    });
    assert.equal(p.outcomeToken, OUTCOME_TOKEN_6909);
    assert.equal(p.account, account);
    assert.equal(p.id, 12n);
    assert.equal(sdkReadsOutcomeToken(p), OUTCOME_TOKEN_6909);
  });

  it("positional token string leaves p.outcomeToken undefined (the production bug)", () => {
    assert.equal(sdkReadsOutcomeToken(OUTCOME_TOKEN_6909), undefined);
  });
});
