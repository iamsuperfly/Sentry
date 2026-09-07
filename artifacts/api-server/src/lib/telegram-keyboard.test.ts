import assert from "node:assert/strict";
import test from "node:test";
import {
  mainReplyKeyboard,
  mainReplyKeyboardIsPersistent,
} from "../telegram/ui-keyboards.ts";

test("dashboard keyboard is not persistent", () => {
  assert.equal(mainReplyKeyboardIsPersistent(), false);
  const keyboard = mainReplyKeyboard(false);
  const json = JSON.stringify(keyboard);
  assert.equal(/is_persistent["']?\s*:\s*true/.test(json), false);
});
