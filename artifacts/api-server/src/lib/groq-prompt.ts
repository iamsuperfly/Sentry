import {
  compactAiMarket,
  rankMarketsForGroq,
  resolveGroqMarketCap,
  type GroqRankMarket,
} from "./groq-market-rank.ts";

export function prepareGroqMarkets<T extends GroqRankMarket>(
  markets: T[],
  availableSlots: number,
  maxMarkets?: number | string | null,
): { selected: T[]; prompt: string; cap: number } {
  const cap = resolveGroqMarketCap(maxMarkets ?? process.env.GROQ_MAX_MARKETS);
  const selected = rankMarketsForGroq(markets, cap);
  const prompt = [
    "Binary BTC/ETH up-down event contracts. Use ONLY this snapshot.",
    `Propose at most ${availableSlots} ENTER rows. Prefer SKIP when edge or book is weak.`,
    "JSON: { decisions: [{ marketId, direction UP|DOWN, confidence 0-1, reason, stake null }] }.",
    "Empty decisions = no trade. confidence is your probability the side wins.",
    "Fields: id=marketId a=asset d=duration left=secondsToExpiry yA/nA=asks spr=spread qty=top ask size k=strike.",
    JSON.stringify(selected.map(compactAiMarket)),
  ].join("\n");
  return { selected, prompt, cap };
}
