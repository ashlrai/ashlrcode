/**
 * Keybindings — user-customizable keyboard shortcuts.
 * Loaded from ~/.ashlrcode/keybindings.json
 *
 * Users can override any default binding by creating keybindings.json with
 * an array of { key, action, description? } objects. Custom bindings are
 * merged on top of defaults by action name.
 */

import { existsSync } from "fs";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { getConfigDir } from "../config/settings.ts";

export interface Keybinding {
  key: string;        // e.g., "ctrl+c", "ctrl+shift+k", "escape"
  action: string;     // e.g., "submit", "clear", "undo", "mode-switch", "compact"
  description?: string;
}

// Default keybindings — these ship with AshlrCode and can be overridden.
const DEFAULT_BINDINGS: Keybinding[] = [
  { key: "ctrl+c",    action: "exit",          description: "Exit AshlrCode" },
  { key: "shift+tab", action: "mode-switch",   description: "Cycle through modes" },
  { key: "tab",       action: "autocomplete",  description: "Accept autocomplete suggestion" },
  { key: "ctrl+l",    action: "clear-screen",  description: "Clear output" },
  { key: "ctrl+z",    action: "undo",          description: "Undo last file change" },
  { key: "ctrl+e",    action: "effort-cycle",  description: "Cycle effort level" },
  { key: "ctrl+k",    action: "compact",       description: "Compact context" },
  { key: "ctrl+u",    action: "clear-input",   description: "Clear input line" },
  { key: "escape",    action: "clear-input",   description: "Clear input line (Escape)" },
  { key: "up",        action: "history-prev",  description: "Previous input" },
  { key: "down",      action: "history-next",  description: "Next input" },
  { key: "right",     action: "autocomplete",  description: "Accept autocomplete (arrow)" },
  { key: "ctrl+v",    action: "voice-toggle",  description: "Toggle voice recording (push-to-talk)" },
];

let bindings: Keybinding[] = [...DEFAULT_BINDINGS];

function getKeybindingsPath(): string {
  return join(getConfigDir(), "keybindings.json");
}

/** Load keybindings from disk, merging with defaults */
export async function loadKeybindings(): Promise<void> {
  const path = getKeybindingsPath();
  if (!existsSync(path)) return;

  try {
    const raw = await readFile(path, "utf-8");
    const custom = JSON.parse(raw) as Keybinding[];

    // Custom bindings override defaults by action
    const merged = new Map<string, Keybinding>();
    for (const b of DEFAULT_BINDINGS) merged.set(b.action, b);
    for (const b of custom) merged.set(b.action, b);

    bindings = Array.from(merged.values());
  } catch {
    // Silently ignore malformed keybindings — fall back to defaults
  }
}

/** Save current keybindings to disk */
export async function saveKeybindings(): Promise<void> {
  await mkdir(getConfigDir(), { recursive: true });
  await writeFile(getKeybindingsPath(), JSON.stringify(bindings, null, 2), "utf-8");
}

/** Build a normalized combo string from key event parts */
function buildCombo(key: string, ctrl: boolean, shift: boolean, meta: boolean): string {
  const parts: string[] = [];
  if (ctrl) parts.push("ctrl");
  if (shift) parts.push("shift");
  if (meta) parts.push("meta");
  parts.push(key.toLowerCase());
  return parts.join("+");
}

/** Get the action for a key combo, or null if no binding */
export function getAction(key: string, ctrl: boolean, shift: boolean, meta: boolean): string | null {
  const combo = buildCombo(key, ctrl, shift, meta);
  const binding = bindings.find(b => b.key === combo);
  return binding?.action ?? null;
}

/** Get all bindings (for /keybindings command) */
export function getBindings(): readonly Keybinding[] {
  return bindings;
}

/** Update a single binding by action name */
export function setBinding(action: string, key: string): void {
  const existing = bindings.find(b => b.action === action);
  if (existing) {
    existing.key = key;
  } else {
    bindings.push({ key, action });
  }
}

/** Reset all bindings to defaults */
export function resetBindings(): void {
  bindings = [...DEFAULT_BINDINGS];
}

/**
 * Input history — remembers past user inputs for up/down arrow navigation.
 */
export class InputHistory {
  private history: string[] = [];
  private index = -1;

  push(input: string): void {
    if (input && input !== this.history[this.history.length - 1]) {
      this.history.push(input);
    }
    this.index = -1; // Reset to bottom
  }

  prev(_current: string): string | null {
    if (this.history.length === 0) return null;
    if (this.index === -1) {
      this.index = this.history.length - 1;
    } else if (this.index > 0) {
      this.index--;
    }
    return this.history[this.index] ?? null;
  }

  next(): string | null {
    if (this.index === -1) return null;
    this.index++;
    if (this.index >= this.history.length) {
      this.index = -1;
      return ""; // Clear input when going past end
    }
    return this.history[this.index] ?? null;
  }

  reset(): void {
    this.index = -1;
  }
}
