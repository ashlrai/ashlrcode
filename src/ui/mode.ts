/**
 * Mode management — cycle through Normal / Plan / Accept Edits / YOLO.
 * Shift+Tab (escape sequence \x1b[Z) cycles modes.
 */

import chalk from "chalk";
import {
  setBypassMode,
  setAutoAcceptEdits,
} from "../config/permissions.ts";
import {
  enterPlanMode,
  exitPlanMode,
  isPlanMode,
} from "../planning/plan-mode.ts";

export type Mode = "normal" | "plan" | "accept-edits" | "yolo";

let currentMode: Mode = "normal";

const MODE_ORDER: Mode[] = ["normal", "plan", "accept-edits", "yolo"];

export function getCurrentMode(): Mode {
  return currentMode;
}

export function setMode(mode: Mode): void {
  // Deactivate previous mode
  switch (currentMode) {
    case "plan":
      if (isPlanMode()) exitPlanMode();
      break;
    case "accept-edits":
      setAutoAcceptEdits(false);
      break;
    case "yolo":
      setBypassMode(false);
      break;
  }

  currentMode = mode;

  // Activate new mode
  switch (mode) {
    case "plan":
      enterPlanMode();
      break;
    case "accept-edits":
      setAutoAcceptEdits(true);
      break;
    case "yolo":
      setBypassMode(true);
      break;
  }
}

export function cycleMode(): Mode {
  const currentIndex = MODE_ORDER.indexOf(currentMode);
  const nextIndex = (currentIndex + 1) % MODE_ORDER.length;
  const nextMode = MODE_ORDER[nextIndex]!;
  setMode(nextMode);
  return nextMode;
}

export function getPromptForMode(): string {
  switch (currentMode) {
    case "normal":
      return chalk.green("❯ ");
    case "plan":
      return chalk.magenta("[plan] ❯ ");
    case "accept-edits":
      return chalk.yellow("[edits] ❯ ");
    case "yolo":
      return chalk.red("[YOLO] ❯ ");
  }
}

export function getModeLabel(): string {
  switch (currentMode) {
    case "normal":
      return "";
    case "plan":
      return chalk.magenta("PLAN");
    case "accept-edits":
      return chalk.yellow("EDITS");
    case "yolo":
      return chalk.red("YOLO");
  }
}
