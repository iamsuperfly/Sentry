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
    .text(BTN.tradingHelp, "app:help_trading")
    .text(BTN.settings, "app:settings")
    .row()
    .text(BTN.wallet, "app:wallet")
    .text(BTN.autoHelp, "app:auto")
    .row()
    .text(BTN.howItWorks, "app:how")
    .row()
    .text(BTN.claim, "app:claim")
    .row()
    .text(BTN.backMenu, "app:menu");
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
