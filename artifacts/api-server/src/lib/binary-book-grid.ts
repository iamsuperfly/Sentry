/**
 * Snap binary prices/sizes to the venue grid using raw tick/lot units.
 * Matches SDK snapToGrid (price clamped into (0,1); amount floors strictly).
 * Does not guess a grid when protocol params are missing.
 */

export type BinaryBookGrid = {
  tickSizeRaw: bigint;
  lotSizeRaw: bigint;
  minQuantityRaw: bigint;
  decimals: number;
};

export type SnapResult =
  | { ok: true; human: number; raw: bigint }
  | { ok: false; code: string; reason: string };

function pow10(decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new RangeError(`Invalid decimals ${decimals}`);
  }
  return 10n ** BigInt(decimals);
}

function floorToRaw(human: number, decimals: number): bigint | null {
  if (!Number.isFinite(human) || human < 0) return null;
  const scale = Number(pow10(decimals));
  const raw = Math.floor(human * scale + 1e-12);
  if (!Number.isFinite(raw) || raw < 0) return null;
  return BigInt(raw);
}

function toHuman(raw: bigint, decimals: number): number {
  const one = pow10(decimals);
  const whole = raw / one;
  const frac = raw % one;
  const fracStr = frac.toString().padStart(decimals, "0");
  return Number(`${whole.toString()}.${fracStr}`);
}

export function parseBinaryBookGrid(input: {
  tickSizeRaw?: bigint | string | number | null;
  lotSizeRaw?: bigint | string | number | null;
  minQuantityRaw?: bigint | string | number | null;
  decimals: number;
}): { ok: true; grid: BinaryBookGrid } | { ok: false; code: string; reason: string } {
  if (!Number.isInteger(input.decimals) || input.decimals < 0) {
    return {
      ok: false,
      code: "book_params_unavailable",
      reason: "Market decimals are required to snap the binary book grid.",
    };
  }
  const toBig = (value: bigint | string | number | null | undefined): bigint | null => {
    if (value === null || value === undefined || value === "") return null;
    try {
      const n = typeof value === "bigint" ? value : BigInt(value);
      return n > 0n ? n : null;
    } catch {
      return null;
    }
  };
  const tickSizeRaw = toBig(input.tickSizeRaw);
  const lotSizeRaw = toBig(input.lotSizeRaw);
  const minQuantityRaw = toBig(input.minQuantityRaw);
  if (tickSizeRaw === null || lotSizeRaw === null || minQuantityRaw === null) {
    return {
      ok: false,
      code: "book_params_unavailable",
      reason: "Pool tickSize, lotSize, and minQuantity are required.",
    };
  }
  return {
    ok: true,
    grid: {
      tickSizeRaw,
      lotSizeRaw,
      minQuantityRaw,
      decimals: input.decimals,
    },
  };
}

function snapDown(raw: bigint, step: bigint): bigint {
  return raw - (raw % step);
}

export function snapBinaryPrice(price: number, grid: BinaryBookGrid): SnapResult {
  const raw = floorToRaw(price, grid.decimals);
  if (raw === null) {
    return { ok: false, code: "invalid_tick", reason: `Limit price ${price} is not finite.` };
  }
  let aligned = snapDown(raw, grid.tickSizeRaw);
  const one = pow10(grid.decimals);
  if (aligned < grid.tickSizeRaw) aligned = grid.tickSizeRaw;
  const highest = ((one - grid.tickSizeRaw) / grid.tickSizeRaw) * grid.tickSizeRaw;
  if (aligned > highest) aligned = highest;
  const human = toHuman(aligned, grid.decimals);
  if (!(human > 0) || !(human < 1)) {
    return {
      ok: false,
      code: "invalid_tick",
      reason: `Limit price ${price} snaps to invalid tick ${human}.`,
    };
  }
  return { ok: true, human, raw: aligned };
}

export function snapBinaryAmount(amount: number, grid: BinaryBookGrid): SnapResult {
  const raw = floorToRaw(amount, grid.decimals);
  if (raw === null) {
    return {
      ok: false,
      code: "invalid_lot",
      reason: `Contract size ${amount} is not finite.`,
    };
  }
  const aligned = snapDown(raw, grid.lotSizeRaw);
  if (aligned <= 0n) {
    return {
      ok: false,
      code: "invalid_lot",
      reason: `Contract size ${amount} snaps to zero on lot ${grid.lotSizeRaw}.`,
    };
  }
  if (aligned < grid.minQuantityRaw) {
    return {
      ok: false,
      code: "invalid_lot",
      reason: `Contract size ${amount} is below minQuantity ${grid.minQuantityRaw}.`,
    };
  }
  return { ok: true, human: toHuman(aligned, grid.decimals), raw: aligned };
}

export function humanFromRaw(raw: bigint, decimals: number): number {
  return toHuman(raw, decimals);
}
