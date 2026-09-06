import type { SomniaMarkets } from "@somnia-chain/markets-sdk";

type RpcClient = {
  close?: () => void;
};

type RpcTransport = {
  getRpcClient?: () => Promise<RpcClient>;
};

/**
 * Stop SDK live machinery and close the underlying viem WebSocket when a chain
 * read opened it. The SDK's close() stops watches but does not destroy viem's
 * transport, which otherwise leaves one socket per short-lived exchange alive.
 */
export async function closeExchange(
  exchange: SomniaMarkets,
  options: { chainTouched: boolean },
): Promise<void> {
  await Promise.race([
    exchange.close(),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ]).catch(() => undefined);

  if (!options.chainTouched) return;

  try {
    const transport = exchange.client.getViemClient()
      .transport as unknown as RpcTransport;
    const rpcClient = await transport.getRpcClient?.();
    rpcClient?.close?.();
  } catch {
    // Cleanup must never replace the original read/finalization result.
  }
}