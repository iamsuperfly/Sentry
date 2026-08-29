/**
 * Fresh order-book gate immediately before IOC submit.
 * Does not change order type or size math.
 */

export type PreflightAsk = {
  price: number;
  quantity: number;
};

export type PreflightBook = {
  yesAsk: PreflightAsk | null;
  noAsk: PreflightAsk | null;
};

export type PreflightInput = {
  outcome: "YES" | "NO";
  limitPrice: number;
  contracts: number;
  book: PreflightBook;
  priceEpsilon?: number;
};

export type PreflightResult =
  | {
      ok: true;
      askPrice: number;
      askQuantity: number;
    }
  | {
      ok: false;
      code: "no_usable_ask" | "book_stale" | "insufficient_liquidity";
      reason: string;
      askPrice: number | null;
      askQuantity: number | null;
    };

function rawToHuman(raw: string | bigint | number, decimals: number): number | null {
  const n = typeof raw === "bigint" ? Number(raw) : Number(raw);
  if (!Number.isFinite(n)) return null;
  const scale = 10 ** decimals;
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const human = n / scale;
  return Number.isFinite(human) ? human : null;
}

export function levelFromBookSide(
  levels: Array<{ price: string; quantity: string }> | undefined,
  decimals: number,
): PreflightAsk | null {
  const top = levels?.[0];
  if (!top) return null;
  const price = rawToHuman(top.price, decimals);
  const quantity = rawToHuman(top.quantity, decimals);
  if (price === null || quantity === null || price <= 0 || price >= 1) return null;
  if (quantity <= 0) return null;
  return { price, quantity };
}

export function evaluatePreflightBook(input: PreflightInput): PreflightResult {
  const eps = input.priceEpsilon ?? 1e-9;
  const ask = input.outcome === "YES" ? input.book.yesAsk : input.book.noAsk;
  if (!ask) {
    return {
      ok: false,
      code: "no_usable_ask",
      reason: `No live ${input.outcome} ask on the book.`,
      askPrice: null,
      askQuantity: null,
    };
  }
  if (ask.price > input.limitPrice + eps) {
    return {
      ok: false,
      code: "book_stale",
      reason: `Live ${input.outcome} ask ${ask.price} is above intended limit ${input.limitPrice}.`,
      askPrice: ask.price,
      askQuantity: ask.quantity,
    };
  }
  if (ask.quantity + eps < input.contracts) {
    return {
      ok: false,
      code: "insufficient_liquidity",
      reason: `Live ${input.outcome} ask size ${ask.quantity} is below contracts ${input.contracts}.`,
      askPrice: ask.price,
      askQuantity: ask.quantity,
    };
  }
  return { ok: true, askPrice: ask.price, askQuantity: ask.quantity };
}
