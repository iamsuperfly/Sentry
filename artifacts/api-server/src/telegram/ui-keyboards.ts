import { InlineKeyboard, Keyboard } from "grammy";
import { BTN } from "../lib/telegram-app-flow.ts";

export function mainReplyKeyboard(autonomousOn: boolean): Keyboard {
  return new Keyboard()
    .text(BTN.trade)
    .row()
    .text(autonomousOn ? BTN.autoOn : BTN.autoOff)
    .row()
    .text(BTN.positions)
    .text(BTN.performance)
    .row()
    .text(BTN.wallet)
    .text(BTN.help)
    .resized()
    .persistent();
}

export function faucetKeyboard(opts?: { skip?: boolean }): InlineKeyboard {
  const kb = new InlineKeyboard().text("Get test tokens", "ux:faucet");
  if (opts?.skip) kb.row().text("Skip", "ux:onboard:config");
  return kb;
}

export function helpKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("Trading", "ux:help:trading")
    .text("Settings", "ux:help:settings")
    .row()
    .text("Wallet", "ux:help:wallet")
    .text("Autonomous", "ux:help:auto")
    .row()
    .text("How it works", "ux:help:how")
    .row()
    .text("Claim settled", "ux:claim")
    .row()
    .text("Main menu", "ux:menu");
}

export function settingsKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("Change default stake", "ux:set:stake")
    .row()
    .text("Change max stake", "ux:set:max_stake")
    .row()
    .text("Change daily loss", "ux:set:daily_loss")
    .row()
    .text("Change max positions", "ux:set:positions")
    .row()
    .text("Change profit target", "ux:set:profit")
    .row()
    .text("Back", "ux:help");
}

export function autoKeyboard(on: boolean): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (on) kb.text("Pause autonomous", "ux:auto:off");
  else kb.text("Start autonomous", "ux:auto:on");
  return kb.row().text("Main menu", "ux:menu");
}

export function backToMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("Main menu", "ux:menu");
}

export function positionsKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("Claim settled", "ux:claim")
    .row()
    .text("Main menu", "ux:menu");
}
