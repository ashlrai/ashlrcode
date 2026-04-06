/**
 * cmux Lifecycle Hooks — report agent state to cmux sidebar.
 *
 * Maps AshlrCode events to cmux status updates:
 *   Session start  → "Running" (green)
 *   Session end    → clear status
 *   Agent idle     → "Idle" (gray)
 *   Needs input    → "Needs input" (yellow)
 *   Tool start     → progress with tool name
 *   Tool end       → clear progress
 *   Notification   → cmux notification
 *
 * All hooks are no-ops when not in cmux. Safe to call unconditionally.
 */

import { clearProgress, clearStatus, isCmuxAvailable, notify, setProgress, setStatus } from "./client.ts";

/** Called when a session starts. */
export function cmuxSessionStart(sessionId: string, _cwd: string): void {
  if (!isCmuxAvailable()) return;

  // Export PID for cmux process tracking
  process.env.CMUX_CLAUDE_PID = String(process.pid);

  setStatus({
    icon: "🟢",
    label: "Running",
    color: "green",
  });
}

/** Called when a session ends (normal exit or Ctrl+C). */
export function cmuxSessionEnd(): void {
  if (!isCmuxAvailable()) return;
  clearStatus();
  clearProgress();
}

/** Called when the agent is idle (waiting for user input at the prompt). */
export function cmuxAgentIdle(): void {
  if (!isCmuxAvailable()) return;
  setStatus({
    icon: "💤",
    label: "Idle",
    color: "gray",
  });
}

/** Called when the AskUser tool fires — agent needs human input. */
export function cmuxNeedsInput(): void {
  if (!isCmuxAvailable()) return;
  setStatus({
    icon: "⏳",
    label: "Needs input",
    color: "yellow",
  });
}

/** Called when a tool starts executing. */
export function cmuxToolStart(toolName: string): void {
  if (!isCmuxAvailable()) return;
  setStatus({
    icon: "⚡",
    label: "Running",
    color: "blue",
  });
  setProgress(toolName);
}

/** Called when a tool finishes executing. */
export function cmuxToolEnd(): void {
  if (!isCmuxAvailable()) return;
  clearProgress();
}

/** Called when processing a new user prompt. */
export function cmuxPromptSubmit(): void {
  if (!isCmuxAvailable()) return;
  setStatus({
    icon: "🧠",
    label: "Thinking",
    color: "blue",
  });
}

/** Send a notification through cmux. */
export function cmuxNotify(title: string, body: string): void {
  if (!isCmuxAvailable()) return;
  notify({ title, body });
}

/** Called when an error occurs. */
export function cmuxError(message: string): void {
  if (!isCmuxAvailable()) return;
  setStatus({
    icon: "❌",
    label: "Error",
    color: "red",
  });
  notify({ title: "AshlrCode Error", body: message });
}
