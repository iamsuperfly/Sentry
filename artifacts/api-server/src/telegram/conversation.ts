import type { ConversationKind } from "../lib/telegram-app-flow.ts";

const sessions = new Map<number, ConversationKind>();

export function getConversation(telegramUserId: number): ConversationKind {
  return sessions.get(telegramUserId) ?? { kind: "idle" };
}

export function setConversation(
  telegramUserId: number,
  state: ConversationKind,
): void {
  if (state.kind === "idle") sessions.delete(telegramUserId);
  else sessions.set(telegramUserId, state);
}

export function clearConversation(telegramUserId: number): void {
  sessions.delete(telegramUserId);
}
