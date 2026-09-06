import assert from "node:assert/strict";
import test from "node:test";
import type { SomniaMarkets } from "@somnia-chain/markets-sdk";
import { closeExchange } from "./exchange-lifecycle.ts";
import { createInFlightGuard } from "./finalization-guard.ts";

test("finalization guard skips an overlapping tick", async () => {
  const runIfIdle = createInFlightGuard();
  let releases!: () => void;
  const firstTask = new Promise<void>((resolve) => {
    releases = resolve;
  });
  let runs = 0;

  const first = runIfIdle(async () => {
    runs += 1;
    await firstTask;
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(await runIfIdle(async () => {
    runs += 1;
  }), false);
  assert.equal(runs, 1);

  releases();
  assert.equal(await first, true);
  assert.equal(await runIfIdle(async () => {
    runs += 1;
  }), true);
  assert.equal(runs, 2);
});

test("exchange cleanup closes the underlying RPC client after chain reads", async () => {
  let rpcRequests = 0;
  let rpcClosed = 0;
  let sdkClosed = 0;
  const exchange = {
    close: async () => {
      sdkClosed += 1;
    },
    client: {
      getViemClient: () => ({
        transport: {
          getRpcClient: async () => {
            rpcRequests += 1;
            return { close: () => { rpcClosed += 1; } };
          },
        },
      }),
    },
  } as unknown as SomniaMarkets;

  await closeExchange(exchange, { chainTouched: true });

  assert.equal(sdkClosed, 1);
  assert.equal(rpcRequests, 1);
  assert.equal(rpcClosed, 1);
});

test("exchange cleanup does not create a socket for indexer-only reads", async () => {
  let rpcRequests = 0;
  const exchange = {
    close: async () => {},
    client: {
      getViemClient: () => ({
        transport: {
          getRpcClient: async () => {
            rpcRequests += 1;
            return { close: () => {} };
          },
        },
      }),
    },
  } as unknown as SomniaMarkets;

  await closeExchange(exchange, { chainTouched: false });

  assert.equal(rpcRequests, 0);
});