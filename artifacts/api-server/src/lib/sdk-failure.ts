/**
 * Classify Somnia/DreamDEX SDK and transport failures for logs + broadcast
 * state. Never include private keys or seeds in the returned message.
 */

import type { BroadcastState } from "./live-execution.ts";

const SECRET_HEX = /0x[0-9a-fA-F]{64}/g;
const PRIVATE_KEY_FIELD = /private[-_ ]?key[=: ]+\S+/gi;

export type SdkFailureClassification = {
  operation: string;
  name: string;
  message: string;
  hash?: string;
  broadcastState: BroadcastState;
};

export function redactSensitive(text: string): string {
  return text
    .replace(SECRET_HEX, "0x[redacted]")
    .replace(PRIVATE_KEY_FIELD, "privateKey=[redacted]")
    .slice(0, 240);
}

export function errorName(error: unknown): string {
  if (error && typeof error === "object" && "name" in error) {
    return String((error as { name: unknown }).name);
  }
  return "";
}

export function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return redactSensitive(error.message);
  }
  if (typeof error === "string" && error.trim()) {
    return redactSensitive(error);
  }
  return fallback;
}

export function errorHash(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as Record<string, unknown>;
  for (const key of ["hash", "transactionHash", "txHash"]) {
    if (typeof record[key] === "string" && record[key].startsWith("0x")) {
      const value = String(record[key]);
      if (value.length >= 66) return value;
    }
  }
  return undefined;
}

export function looksLikeSdkInvariant(name: string, message: string): boolean {
  const blob = `${name} ${message}`;
  return (
    /invarianterror/i.test(blob) ||
    /invariant violated/i.test(blob) ||
    /unreachable/i.test(blob) ||
    /no external wallet/i.test(blob)
  );
}

export function looksLikeTransportFailure(name: string, message: string): boolean {
  const blob = `${name} ${message}`;
  return (
    /websocket/i.test(blob) ||
    /ws_request/i.test(blob) ||
    /socket/i.test(blob) ||
    /econnreset/i.test(blob) ||
    /econnrefused/i.test(blob) ||
    /etimedout/i.test(blob) ||
    /timed out/i.test(blob) ||
    /timeout/i.test(blob) ||
    /not connected/i.test(blob) ||
    /fetch failed/i.test(blob)
  );
}

/**
 * No hash + client/SDK/transport failure is a confirmed miss: nothing was
 * proven broadcast. A hash with no revert stays uncertain.
 */
export function classifySdkFailure(
  error: unknown,
  operation: string,
): SdkFailureClassification {
  const name = errorName(error);
  const message = errorMessage(error, `${operation} failed`);
  const hash = errorHash(error);
  const blob = `${name} ${message}`;
  const confirmedRevert = /revert|contractrevert|execution reverted/i.test(blob);
  const clientMiss =
    looksLikeSdkInvariant(name, message) || looksLikeTransportFailure(name, message);

  let broadcastState: BroadcastState;
  if (confirmedRevert || clientMiss) {
    broadcastState = "confirmed_failure";
  } else if (hash) {
    broadcastState = "uncertain";
  } else {
    broadcastState = "confirmed_failure";
  }

  return { operation, name, message, hash, broadcastState };
}
