import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { AppConfig } from "../config";

function key(config: AppConfig): Buffer {
  const decoded = /^[0-9a-f]{64}$/i.test(config.walletEncryptionKey)
    ? Buffer.from(config.walletEncryptionKey, "hex")
    : Buffer.from(config.walletEncryptionKey, "base64");
  if (decoded.length !== 32) throw new Error("WALLET_ENCRYPTION_KEY must decode to 32 bytes.");
  return decoded;
}

export function encryptPrivateKey(config: AppConfig, privateKey: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(config), iv);
  const ciphertext = Buffer.concat([cipher.update(privateKey, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext]
    .map((part) => part.toString("base64"))
    .join(".");
}

export function decryptPrivateKey(config: AppConfig, value: string) {
  try {
    const [iv, tag, ciphertext] = value.split(".");
    if (!iv || !tag || !ciphertext) throw new Error("Malformed wallet data.");
    const decipher = createDecipheriv("aes-256-gcm", key(config), Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("Unable to decrypt wallet credentials.");
  }
}