/**
 * Deterministic 1-minute strategy (±0.05% underlying move in final 30s).
 * Pure — underlying prices injected by caller. Does not use order-book fair value.
 */

export const ONE_MIN_STRATEGY_NAME = "one-min-underlying-0.05pct-v1";
export const ONE_MIN_FINAL_WINDOW_SEC = 30;
export const ONE_MIN_MOVE_FRACTION = 0.0005;

export type OneMinDirection = "UP" | "DOWN";

export type OneMinDecision =
  | {
      action: "enter";
      direction: OneMinDirection;
      referencePrice: number;
      currentPrice: number;
      upperTrigger: number;
      lowerTrigger: number;
      secondsToExpiry: number;
      reason: string;
    }
  | {
      action: "skip";
      reason: string;
      code: string;
      referencePrice?: number;
      currentPrice?: number;
      secondsToExpiry?: number;
    };

export function computeTriggers(referencePrice: number): {
  upperTrigger: number;
  lowerTrigger: number;
} {
  return {
    upperTrigger: referencePrice * (1 + ONE_MIN_MOVE_FRACTION),
    lowerTrigger: referencePrice * (1 - ONE_MIN_MOVE_FRACTION),
  };
}

export function evaluateOneMinuteUnderlying(input: {
  secondsToExpiry: number | null;
  referencePrice: number | null | undefined;
  currentPrice: number | null | undefined;
}): OneMinDecision {
  const left = input.secondsToExpiry;
  if (left === null || !Number.isFinite(left)) {
    return { action: "skip", code: "bad_expiry", reason: "Could not parse seconds to expiry." };
  }
  if (left <= 0) {
    return {
      action: "skip",
      code: "expired",
      reason: "Market already expired.",
      secondsToExpiry: left,
    };
  }
  if (left > ONE_MIN_FINAL_WINDOW_SEC) {
    return {
      action: "skip",
      code: "not_final_window",
      reason: `Only evaluate in final ${ONE_MIN_FINAL_WINDOW_SEC}s (have ${Math.floor(left)}s left).`,
      secondsToExpiry: left,
    };
  }

  const ref = input.referencePrice;
  const cur = input.currentPrice;
  if (ref === null || ref === undefined || !Number.isFinite(ref) || ref <= 0) {
    return {
      action: "skip",
      code: "missing_reference_price",
      reason: "Reference underlying price is missing or invalid.",
      secondsToExpiry: left,
    };
  }
  if (cur === null || cur === undefined || !Number.isFinite(cur) || cur <= 0) {
    return {
      action: "skip",
      code: "missing_current_price",
      reason: "Current underlying price is missing or invalid.",
      referencePrice: ref,
      secondsToExpiry: left,
    };
  }

  const { upperTrigger, lowerTrigger } = computeTriggers(ref);
  const hitUp = cur >= upperTrigger;
  const hitDown = cur <= lowerTrigger;
  if (hitUp && !hitDown) {
    return {
      action: "enter",
      direction: "UP",
      referencePrice: ref,
      currentPrice: cur,
      upperTrigger,
      lowerTrigger,
      secondsToExpiry: left,
      reason: `Underlying ${cur} reached +0.05% trigger ${upperTrigger} from ref ${ref}.`,
    };
  }
  if (hitDown && !hitUp) {
    return {
      action: "enter",
      direction: "DOWN",
      referencePrice: ref,
      currentPrice: cur,
      upperTrigger,
      lowerTrigger,
      secondsToExpiry: left,
      reason: `Underlying ${cur} reached -0.05% trigger ${lowerTrigger} from ref ${ref}.`,
    };
  }
  if (hitUp && hitDown) {
    const upMove = Math.abs(cur / ref - 1);
    const downMove = Math.abs(1 - cur / ref);
    const direction: OneMinDirection = upMove >= downMove ? "UP" : "DOWN";
    return {
      action: "enter",
      direction,
      referencePrice: ref,
      currentPrice: cur,
      upperTrigger,
      lowerTrigger,
      secondsToExpiry: left,
      reason: `Both triggers crossed; chose ${direction} by larger move from ref ${ref}.`,
    };
  }

  return {
    action: "skip",
    code: "no_trigger",
    reason: `Neither ±0.05% trigger hit (ref=${ref}, current=${cur}, up=${upperTrigger}, down=${lowerTrigger}).`,
    referencePrice: ref,
    currentPrice: cur,
    secondsToExpiry: left,
  };
}
