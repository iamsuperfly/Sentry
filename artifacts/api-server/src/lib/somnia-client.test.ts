import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { signerAddressFromPrivateKey } from "./somnia-client.ts";

describe("per-user signer isolation", () => {
  it("derives distinct addresses for two wallets and never cross-binds keys", () => {
    const keyA = generatePrivateKey();
    const keyB = generatePrivateKey();
    const addrA = signerAddressFromPrivateKey(keyA);
    const addrB = signerAddressFromPrivateKey(keyB);
    assert.notEqual(keyA, keyB);
    assert.notEqual(addrA, addrB);
    assert.equal(addrA, privateKeyToAccount(keyA).address);
    assert.equal(addrB, privateKeyToAccount(keyB).address);
    assert.notEqual(signerAddressFromPrivateKey(keyA), addrB);
  });
});
