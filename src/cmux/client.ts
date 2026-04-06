/**
 * cmux Socket Client — JSON-RPC over Unix domain socket.
 *
 * Connects to cmux terminal app at $CMUX_SOCKET_PATH (default: /tmp/cmux.sock).
 * All methods are no-ops when not running inside cmux, so callers don't need
 * to check availability before calling.
 *
 * Protocol: newline-delimited JSON
 *   Request:  { id: "req-1", method: "set_status", params: { ... } }
 *   Response: { id: "req-1", ok: true, result: { ... } }
 */

import { connect, type Socket } from "net";
import { existsSync } from "fs";

// ── Types ────────────────────────────────────────────────────────────

interface CmuxRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

interface CmuxResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface CmuxStatus {
  icon?: string;
  label: string;
  color?: "blue" | "green" | "yellow" | "red" | "gray";
}

export interface CmuxNotification {
  title: string;
  body: string;
}

export interface SplitOptions {
  direction: "left" | "right" | "up" | "down";
  command?: string;
}

// ── Client ───────────────────────────────────────────────────────────

let _socketPath: string | null = null;
let _requestId = 0;
let _available: boolean | null = null;

/**
 * Check if we're running inside cmux.
 * Caches the result after first call.
 */
export function isCmuxAvailable(): boolean {
  if (_available !== null) return _available;

  const envPath = process.env.CMUX_SOCKET_PATH;
  if (envPath && existsSync(envPath)) {
    _socketPath = envPath;
    _available = true;
    return true;
  }

  // Fallback: check default path
  if (existsSync("/tmp/cmux.sock")) {
    _socketPath = "/tmp/cmux.sock";
    _available = true;
    return true;
  }

  _available = false;
  return false;
}

/**
 * Send a JSON-RPC request to cmux and wait for response.
 * Returns null if cmux is not available or request fails.
 */
async function send(method: string, params: Record<string, unknown> = {}): Promise<CmuxResponse | null> {
  if (!isCmuxAvailable() || !_socketPath) return null;

  const id = `ac-${++_requestId}`;
  const request: CmuxRequest = { id, method, params };

  return new Promise<CmuxResponse | null>((resolve) => {
    let buffer = "";
    let resolved = false;

    const socket: Socket = connect(_socketPath!, () => {
      socket.write(JSON.stringify(request) + "\n");
    });

    socket.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const response = JSON.parse(line) as CmuxResponse;
          if (response.id === id) {
            resolved = true;
            socket.end();
            resolve(response);
          }
        } catch {
          // Ignore malformed responses
        }
      }
    });

    socket.on("error", () => {
      if (!resolved) {
        resolved = true;
        // cmux socket went away — allow re-check on next call
        _available = null;
        resolve(null);
      }
    });

    socket.on("close", () => {
      if (!resolved) {
        resolved = true;
        resolve(null);
      }
    });

    // 3-second timeout
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        socket.removeAllListeners();
        socket.destroy();
        resolve(null);
      }
    }, 3000);
  });
}

/**
 * Fire-and-forget: send without waiting for response.
 * Used for non-critical status updates where latency matters.
 */
function sendAsync(method: string, params: Record<string, unknown> = {}): void {
  if (!isCmuxAvailable() || !_socketPath) return;

  const id = `ac-${++_requestId}`;
  const request: CmuxRequest = { id, method, params };

  try {
    const socket: Socket = connect(_socketPath!, () => {
      socket.write(JSON.stringify(request) + "\n");
      socket.end();
    });
    socket.on("error", () => {
      // Silently ignore — cmux may have closed, allow re-check
      socket.destroy();
      _available = null;
    });
    // Auto-cleanup after 2s
    setTimeout(() => socket.destroy(), 2000);
  } catch {
    _available = null;
  }
}

// ── Public API ───────────────────────────────────────────────────────

/** Set agent status in cmux sidebar. */
export function setStatus(status: CmuxStatus): void {
  sendAsync("set_status", {
    source: "ashlrcode",
    pid: process.pid,
    ...status,
  });
}

/** Clear agent status from cmux sidebar. */
export function clearStatus(): void {
  sendAsync("clear_status", {
    source: "ashlrcode",
    pid: process.pid,
  });
}

/** Set progress indicator (shown during tool execution). */
export function setProgress(label: string, percent?: number): void {
  sendAsync("set_progress", {
    source: "ashlrcode",
    pid: process.pid,
    label,
    ...(percent !== undefined ? { percent } : {}),
  });
}

/** Clear progress indicator. */
export function clearProgress(): void {
  sendAsync("clear_progress", {
    source: "ashlrcode",
    pid: process.pid,
  });
}

/** Send a notification to cmux (appears in sidebar + macOS notification center). */
export function notify(notification: CmuxNotification): void {
  sendAsync("notification.create", {
    source: "ashlrcode",
    ...notification,
  });
}

/** Create a new split pane in the current workspace. Returns the surface ID. */
export async function createSplit(options: SplitOptions): Promise<string | null> {
  const response = await send("surface.split", {
    direction: options.direction,
  });
  if (!response?.ok) return null;
  const surfaceId = (response.result as any)?.surfaceId ?? null;

  // If a command was specified, send it to the new pane
  if (surfaceId && options.command) {
    await sendText(surfaceId, options.command + "\n");
  }

  return surfaceId;
}

/** Send text to a specific surface/pane. */
export async function sendText(surfaceId: string, text: string): Promise<boolean> {
  const response = await send("surface.send_text", {
    surfaceId,
    text,
  });
  return response?.ok ?? false;
}

/** List workspaces. */
export async function listWorkspaces(): Promise<unknown[]> {
  const response = await send("workspace.list");
  if (!response?.ok) return [];
  return (response.result as any)?.workspaces ?? [];
}

/** Ping cmux to check connectivity. */
export async function ping(): Promise<boolean> {
  const response = await send("system.ping");
  return response?.ok ?? false;
}

/** Reset cached availability (useful after reconnect). */
export function resetAvailability(): void {
  _available = null;
}
