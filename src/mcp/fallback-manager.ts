/**
 * MCP Fallback Manager — graceful degradation when MCP tools fail.
 *
 * Maintains a registry mapping each MCP tool to a built-in alternative.
 * On repeated failure it marks the server as degraded and silently
 * substitutes the built-in equivalent so the agent never stalls.
 *
 * Retry policy: 2 attempts with exponential backoff (3 s base → 6 s).
 */

/** A built-in tool name known to the ToolRegistry. */
export type ToolName = string;

export interface FallbackEntry {
  mcpTool: string;
  fallback: ToolName;
}

export interface FailureRecord {
  count: number;
  lastError: Error;
  lastFailedAt: number;
  /** Exponential-backoff retry attempt index (0-based). */
  attempt: number;
}

export interface ServerHealthEntry {
  /** true = server is considered healthy; false = degraded */
  healthy: boolean;
  /** ISO string of when the server was last marked degraded. */
  degradedSince?: string;
  /** Total tool-call failures seen on this server. */
  totalFailures: number;
}

/** How many consecutive failures before a server is marked degraded. */
const DEGRADED_THRESHOLD = 2;
/** Base backoff in ms (doubles on each retry). */
const BASE_BACKOFF_MS = 3_000;

/**
 * Extracts the MCP server name from a fully-qualified tool name.
 * e.g. "mcp__claude-in-chrome__read_page" → "claude-in-chrome"
 * Plain tool names (no "__") map to the empty string.
 */
export function serverNameFromTool(mcpTool: string): string {
  const parts = mcpTool.split("__");
  // Format: mcp__<server>__<tool>
  if (parts.length >= 3 && parts[0] === "mcp") return parts[1] ?? "";
  return "";
}

export class MCPFallbackManager {
  /** mcpTool → built-in ToolName */
  private readonly fallbacks = new Map<string, ToolName>();
  /** mcpTool → failure tracking */
  private readonly failures = new Map<string, FailureRecord>();
  /** serverName → health */
  private readonly serverHealth = new Map<string, ServerHealthEntry>();

  // ---------------------------------------------------------------------------
  // Public API (required by spec)
  // ---------------------------------------------------------------------------

  /**
   * Register a fallback mapping: when `mcpTool` fails, use `fallback`.
   */
  register(mcpTool: string, fallback: ToolName): void {
    this.fallbacks.set(mcpTool, fallback);
  }

  /**
   * Return the registered built-in fallback for `mcpTool`, or null if none.
   */
  resolveFallback(mcpTool: string): ToolName | null {
    return this.fallbacks.get(mcpTool) ?? null;
  }

  /**
   * Record a failure for `mcpTool`.  Updates failure count and, once the
   * threshold is reached, marks the owning server as degraded.
   */
  recordFailure(mcpTool: string, error: Error): void {
    const existing = this.failures.get(mcpTool);
    const record: FailureRecord = existing
      ? {
          count: existing.count + 1,
          lastError: error,
          lastFailedAt: Date.now(),
          attempt: existing.attempt + 1,
        }
      : {
          count: 1,
          lastError: error,
          lastFailedAt: Date.now(),
          attempt: 0,
        };
    this.failures.set(mcpTool, record);

    // Mark server degraded once threshold is exceeded
    const server = serverNameFromTool(mcpTool);
    if (server) {
      const health = this.serverHealth.get(server) ?? {
        healthy: true,
        totalFailures: 0,
      };
      const updated: ServerHealthEntry = {
        healthy: health.healthy,
        degradedSince: health.degradedSince,
        totalFailures: health.totalFailures + 1,
      };
      if (record.count >= DEGRADED_THRESHOLD && health.healthy) {
        updated.healthy = false;
        updated.degradedSince = new Date().toISOString();
        this.log(`MCP server "${server}" marked degraded after ${record.count} failures on "${mcpTool}"`);
      }
      this.serverHealth.set(server, updated);
    }
  }

  /**
   * Return true if the server owning `mcpTool` is currently marked degraded.
   */
  isServerDegraded(mcpTool: string): boolean {
    const server = serverNameFromTool(mcpTool);
    if (!server) return false;
    return !(this.serverHealth.get(server)?.healthy ?? true);
  }

  /**
   * Return the failure record for `mcpTool`, or null if no failures recorded.
   */
  getFailureRecord(mcpTool: string): FailureRecord | null {
    return this.failures.get(mcpTool) ?? null;
  }

  /**
   * Compute the next retry delay for `mcpTool` based on exponential backoff.
   * Returns 0 for the first attempt.
   */
  retryDelayMs(mcpTool: string): number {
    const record = this.failures.get(mcpTool);
    if (!record) return 0;
    return BASE_BACKOFF_MS * Math.pow(2, record.attempt);
  }

  /**
   * Mark a server as healthy again (e.g. after a successful reconnect).
   */
  markServerHealthy(serverName: string): void {
    const existing = this.serverHealth.get(serverName);
    if (existing) {
      this.serverHealth.set(serverName, {
        healthy: true,
        totalFailures: existing.totalFailures,
      });
    }
  }

  /**
   * Reset failure counters for a specific MCP tool (e.g. after recovery).
   */
  clearFailures(mcpTool: string): void {
    this.failures.delete(mcpTool);
  }

  // ---------------------------------------------------------------------------
  // Status / diagnostics
  // ---------------------------------------------------------------------------

  /**
   * Return a formatted status table for /mcp-status command.
   *
   * @param knownServers - server names that the MCPManager currently knows
   *   about (connected or not).  Servers not in this list but tracked due to
   *   fallback failures are also included.
   */
  formatStatus(knownServers: string[]): string {
    const allServers = new Set<string>([
      ...knownServers,
      ...Array.from(this.serverHealth.keys()),
    ]);

    const lines: string[] = [
      "",
      "  MCP Fallback Status",
      "  " + "─".repeat(50),
    ];

    if (allServers.size === 0) {
      lines.push("  No MCP servers configured.");
    } else {
      for (const server of allServers) {
        const health = this.serverHealth.get(server);
        const status = !health || health.healthy ? "✓ healthy  " : "✗ degraded ";
        const since = health?.degradedSince
          ? ` (since ${health.degradedSince})`
          : "";
        lines.push(`  ${status} ${server}${since}`);
      }
    }

    lines.push("");
    lines.push("  Fallback Capability Matrix");
    lines.push("  " + "─".repeat(50));

    if (this.fallbacks.size === 0) {
      lines.push("  No fallbacks registered.");
    } else {
      for (const [mcpTool, fallback] of this.fallbacks) {
        const rec = this.failures.get(mcpTool);
        const failInfo = rec ? ` [${rec.count} fail${rec.count !== 1 ? "s" : ""}]` : "";
        const degraded = this.isServerDegraded(mcpTool);
        const active = degraded ? " ← ACTIVE" : "";
        lines.push(`  ${mcpTool}${failInfo}`);
        lines.push(`    → ${fallback}${active}`);
      }
    }

    lines.push("");
    return lines.join("\n");
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private log(message: string): void {
    // Intentionally uses console.error so it surfaces as a diagnostic without
    // polluting stdout (which carries JSON-RPC traffic in some transports).
    console.error(`[MCPFallback] ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Singleton — shared across the process
// ---------------------------------------------------------------------------

let _instance: MCPFallbackManager | null = null;

export function getMCPFallbackManager(): MCPFallbackManager {
  if (!_instance) {
    _instance = new MCPFallbackManager();
    _registerDefaults(_instance);
  }
  return _instance;
}

/** Reset the singleton (for testing). */
export function resetMCPFallbackManager(): void {
  _instance = null;
}

/**
 * Pre-populate well-known MCP→built-in fallbacks.
 * These cover the most common external tool servers.
 */
function _registerDefaults(m: MCPFallbackManager): void {
  // claude-in-chrome
  m.register("mcp__claude-in-chrome__read_page", "WebFetch");
  m.register("mcp__claude-in-chrome__get_page_text", "WebFetch");
  m.register("mcp__claude-in-chrome__navigate", "WebFetch");
  m.register("mcp__claude-in-chrome__find", "Grep");
  m.register("mcp__claude-in-chrome__javascript_tool", "Bash");
  m.register("mcp__claude-in-chrome__read_console_messages", "Bash");
  m.register("mcp__claude-in-chrome__read_network_requests", "WebFetch");

  // cursor / editor search
  m.register("mcp__cursor__search", "Grep");
  m.register("mcp__cursor__read_file", "Read");
  m.register("mcp__cursor__write_file", "Write");

  // generic browser
  m.register("mcp__browser__fetch", "WebFetch");
  m.register("mcp__browser__screenshot", "Bash");

  // ashlr plugin tools (fallback to native equivalents)
  m.register("mcp__plugin_ashlr_ashlr__ashlr__grep", "Grep");
  m.register("mcp__plugin_ashlr_ashlr__ashlr__read", "Read");
  m.register("mcp__plugin_ashlr_ashlr__ashlr__bash", "Bash");
  m.register("mcp__plugin_ashlr_ashlr__ashlr__webfetch", "WebFetch");
  m.register("mcp__plugin_ashlr_ashlr__ashlr__write", "Write");
}

// ---------------------------------------------------------------------------
// Retry helper — exponential backoff with max 2 attempts
// ---------------------------------------------------------------------------

export const MAX_RETRIES = 2;

/**
 * Execute `fn` with exponential-backoff retry.
 * On each failure `onFailure` is called so the manager can track errors.
 * After MAX_RETRIES consecutive failures the final error is re-thrown.
 */
export async function withMCPRetry<T>(
  mcpTool: string,
  fn: () => Promise<T>,
  onFailure: (tool: string, err: Error, attempt: number) => void
): Promise<T> {
  let lastErr: Error = new Error("unknown");
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = BASE_BACKOFF_MS * Math.pow(2, attempt - 1);
      await new Promise<void>((r) => setTimeout(r, delay));
    }
    try {
      return await fn();
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      onFailure(mcpTool, lastErr, attempt);
    }
  }
  throw lastErr;
}
