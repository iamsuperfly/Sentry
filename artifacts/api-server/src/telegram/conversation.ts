import type { ConversationState } from "../lib/telegram-app-flow.ts";

const conversations = new Map<number, ConversationState>();

export function getConversation(telegramUserId: number): ConversationState {
  return conversations.get(telegramUserId) ?? { kind: "idle" };
}

export function setConversation(
  telegramUserId: number,
  state: ConversationState,
): void {
  if (state.kind === "idle") {
    conversations.delete(telegramUserId);
    return;
  }
  conversations.set(telegramUserId, state);
}

export function clearConversation(telegramUserId: number): void {
  conversations.delete(telegramUserId);
}
