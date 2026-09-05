import { InlineKeyboard, Keyboard } from "grammy";
import { BTN } from "../lib/telegram-app-flow.ts";

export function mainReplyKeyboard(autonomousOn = false): Keyboard {
  const autoLabel = autonomousOn
    ? `${BTN.autonomous}: ON`
    : `${BTN.autonomous}: OFF`;
  return new Keyboard()
    .text(BTN.tradeNow)
    .row()
    .text(autoLabel)
    .row()
    .text(BTN.positions)
    .text(BTN.performance)
    .row()
    .text(BTN.wallet)
    .text(BTN.help)
    .resized()
    .persistent();
}

export function faucetKeyboard(allowSkip: boolean): InlineKeyboard {
  const kb = new InlineKeyboard().text(BTN.getTokens, "app:faucet");
  if (allowSkip) kb.row().text(BTN.skipFaucet, "app:faucet_skip");
  return kb;
}

export function helpKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text(BTN.settings, "app:settings")
    .row()
    .text(BTN.howItWorks, "app:how")
    .row()
    .text(BTN.history, "app:history")
    .row()
    .text(BTN.leaderboard, "app:leaderboard")
    .row()
    .text(BTN.privateKey, "app:pk_warn")
    .row()
    .text(BTN.backMenu, "app:menu");
}

export function privateKeyWarnKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text(BTN.revealKey, "app:pk_reveal")
    .row()
    .text(BTN.backHelp, "app:help");
}

export function privateKeyHideKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text(BTN.hideKey, "app:pk_hide");
}

/** Copy uses Telegram copy_text — never callback_data. */
export function privateKeyRevealKeyboard(privateKey: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  kb.row({
    text: "COPY KEY",
    copy_text: { text: privateKey },
  } as unknown as { text: string; callback_data: string });
  kb.text(BTN.hideKey, "app:pk_hide");
  return kb;
}

export function settingsKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text(BTN.changeStake, "app:set_stake")
    .row()
    .text(BTN.changeMaxStake, "app:set_max")
    .row()
    .text(BTN.changeDailyLoss, "app:set_loss")
    .row()
    .text(BTN.changePositions, "app:set_pos")
    .row()
    .text(BTN.changeProfit, "app:set_profit")
    .row()
    .text(BTN.backHelp, "app:help");
}

export function autoKeyboard(on: boolean): InlineKeyboard {
  return new InlineKeyboard()
    .text(on ? BTN.pauseAuto : BTN.startAuto, on ? "app:auto_off" : "app:auto_on")
    .row()
    .text(BTN.backMenu, "app:menu");
}

export function backToMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text(BTN.backMenu, "app:menu");
}

export function positionsKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text(BTN.claim, "app:claim")
    .row()
    .text(BTN.backMenu, "app:menu");
}
