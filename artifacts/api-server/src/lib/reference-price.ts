import type { Address } from "viem";
import type { BinaryMarket } from "@somnia-chain/markets-sdk";

const MARKET_CREATOR_SERIES_ABI = [
  {
    type: "function",
    name: "seriesById",
    stateMutability: "view",
    inputs: [{ name: "seriesId", type: "uint32" }],
    outputs: [
      { name: "collateral", type: "address" },
      { name: "asset", type: "string" },
      { name: "numericDecimals", type: "uint64" },
      { name: "intervalSec", type: "uint64" },
      { name: "settlementWindow", type: "uint64" },
    ],
  },
] as const;

type ReferenceMarket = Pick<
  BinaryMarket,
  "marketId" | "asset" | "strike" | "intervalSec"
> & {
  creator?: string | null;
};

type MarketResolution = {
  reference: { oracleQuestionId: string } | null;
  openingAnswer: {
    oracleQuestionId: string;
    numericValue: string | null;
    voidReason: number | null;
    resolvedAt: string | null;
  } | null;
};

type IndexedSeries = {
  seriesId: number;
  asset: string;
  intervalSec: string;
};

type ReferenceClient = {
  getMarketResolution(marketId: string): Promise<MarketResolution>;
  getMarketCreator(
    creator: string,
  ): Promise<{ series?: IndexedSeries[] } | null>;
  getViemClient(): {
    readContract(input: {
      address: Address;
      abi: typeof MARKET_CREATOR_SERIES_ABI;
      functionName: "seriesById";
      args: readonly [number];
    }): Promise<readonly [Address, string, bigint, bigint, bigint]>;
  };
};

type SeriesOnchain = {
  seriesId: number;
  asset: string;
  intervalSec: number;
  numericDecimals: number;
};

const discoveredSeriesCache = new WeakMap<
  object,
  Map<string, Promise<SeriesOnchain[]>>
>();

export type MarketReference = {
  referenceType: "strike" | "opening";
  referencePrice: number;
  referenceDecimals: number | null;
};

export function normalizeOracleNumericValue(
  raw: string | bigint | null | undefined,
  numericDecimals: number | null | undefined,
): number | null {
  if (raw === null || raw === undefined) return null;
  if (
    numericDecimals === null ||
    numericDecimals === undefined ||
    !Number.isInteger(numericDecimals) ||
    numericDecimals < 0 ||
    numericDecimals > 30
  ) {
    return null;
  }

  let integer: bigint;
  try {
    integer = typeof raw === "bigint" ? raw : BigInt(raw);
  } catch {
    return null;
  }
  if (integer <= 0n) return null;

  const value = Number(integer) / 10 ** numericDecimals;
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function parseFixedStrike(
  raw: string | number | null | undefined,
): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function calculateReferenceGapBps(
  spot: number | null | undefined,
  referencePrice: number | null | undefined,
): number | null {
  if (
    spot === null ||
    spot === undefined ||
    referencePrice === null ||
    referencePrice === undefined ||
    !Number.isFinite(spot) ||
    !Number.isFinite(referencePrice) ||
    spot <= 0 ||
    referencePrice <= 0
  ) {
    return null;
  }
  return (
    Math.round(((spot / referencePrice - 1) * 10_000 + Number.EPSILON) * 100) /
    100
  );
}

export async function resolveMarketReferencePrice(
  market: ReferenceMarket,
  client: ReferenceClient,
): Promise<MarketReference | null> {
  const fixedStrike = parseFixedStrike(market.strike);
  if (fixedStrike !== null) {
    return {
      referenceType: "strike",
      referencePrice: fixedStrike,
      referenceDecimals: null,
    };
  }

  if (String(market.strike).trim() !== "0" || !market.creator) return null;

  let numericDecimals: number;
  let numericValue: string;
  try {
    const resolution = await client.getMarketResolution(market.marketId);
    const reference = resolution.reference;
    const answer = resolution.openingAnswer;
    if (
      !reference ||
      !answer ||
      reference.oracleQuestionId !== answer.oracleQuestionId ||
      answer.numericValue === null ||
      (answer.voidReason !== null && Number(answer.voidReason) !== 0) ||
      answer.resolvedAt === null
    ) {
      return null;
    }

    const creator = market.creator.toLowerCase();
    const creatorRecord = await client.getMarketCreator(creator);
    const indexedMatches = (creatorRecord?.series ?? []).filter(
      (series) =>
        series.asset.trim().toUpperCase() === market.asset.trim().toUpperCase() &&
        Number(series.intervalSec) === Number(market.intervalSec),
    );
    let matchingSeriesId: number | null =
      indexedMatches.length === 1 ? indexedMatches[0].seriesId : null;
    if (indexedMatches.length > 1) return null;

    const creatorSeries =
      indexedMatches.length === 1
        ? await readSeriesOnchain(
            client,
            creator,
            indexedMatches[0].seriesId,
          )
        : null;
    const onchainMatches = (creatorSeries
      ? [creatorSeries]
      : await discoverCreatorSeries(client, creator)
    ).filter(
      (series) =>
        series.asset.trim().toUpperCase() === market.asset.trim().toUpperCase() &&
        series.intervalSec === Number(market.intervalSec),
    );
    if (onchainMatches.length !== 1) return null;
    if (matchingSeriesId !== null && matchingSeriesId !== onchainMatches[0].seriesId) {
      return null;
    }
    matchingSeriesId = onchainMatches[0].seriesId;
    numericDecimals = onchainMatches[0].numericDecimals;
    numericValue = answer.numericValue;
  } catch {
    return null;
  }

  const referencePrice = normalizeOracleNumericValue(
    numericValue,
    numericDecimals,
  );
  if (referencePrice === null) return null;

  return {
    referenceType: "opening",
    referencePrice,
    referenceDecimals: numericDecimals,
  };
}

async function discoverCreatorSeries(
  client: ReferenceClient,
  creator: string,
): Promise<SeriesOnchain[]> {
  let byCreator = discoveredSeriesCache.get(client as object);
  if (!byCreator) {
    byCreator = new Map();
    discoveredSeriesCache.set(client as object, byCreator);
  }
  const cached = byCreator.get(creator);
  if (cached) return cached;

  const discovery = (async () => {
    const series: SeriesOnchain[] = [];
    for (let seriesId = 1; seriesId <= 256; seriesId += 1) {
      const discovered = await readSeriesOnchain(client, creator, seriesId);
      if (!discovered) break;
      series.push(discovered);
    }
    return series;
  })();
  byCreator.set(creator, discovery);
  return discovery;
}

async function readSeriesOnchain(
  client: ReferenceClient,
  creator: string,
  seriesId: number,
): Promise<SeriesOnchain | null> {
  const raw = await client.getViemClient().readContract({
    address: creator as Address,
    abi: MARKET_CREATOR_SERIES_ABI,
    functionName: "seriesById",
    args: [seriesId],
  });
  const asset = raw[1].trim();
  const intervalSec = Number(raw[3]);
  const numericDecimals = Number(raw[2]);
  if (
    raw[0].toLowerCase() === "0x0000000000000000000000000000000000000000" ||
    asset === "" ||
    !Number.isFinite(intervalSec) ||
    intervalSec <= 0 ||
    !Number.isInteger(numericDecimals) ||
    numericDecimals < 0
  ) {
    return null;
  }
  return { seriesId, asset, intervalSec, numericDecimals };
}

export function referencePriceForMarket(
  market: Pick<ReferenceMarket, "strike"> & {
    referencePrice?: number | null;
  },
): number | null {
  if (
    market.referencePrice !== null &&
    market.referencePrice !== undefined &&
    Number.isFinite(market.referencePrice) &&
    market.referencePrice > 0
  ) {
    return market.referencePrice;
  }
  return parseFixedStrike(market.strike);
}