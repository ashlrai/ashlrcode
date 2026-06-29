/**
 * Multi-Provider Tool Capability Registry
 *
 * Maps tool signatures to per-provider support levels, tracks cost multipliers,
 * and exposes query APIs for capability checks and best-provider selection.
 *
 * Support levels:
 *   'native'      — provider handles this tool natively, no extra overhead
 *   'via-mcp'     — tool works but is routed through MCP, may add latency
 *   'emulated'    — tool is synthesised from primitives, quality may vary
 *   'unsupported' — provider cannot execute this tool at all
 */

export type SupportLevel = "native" | "via-mcp" | "emulated" | "unsupported";

export type ProviderId =
  | "anthropic"
  | "xai"
  | "openai"
  | "ollama"
  | "groq"
  | "deepseek";

export const ALL_PROVIDERS: ProviderId[] = [
  "anthropic",
  "xai",
  "openai",
  "ollama",
  "groq",
  "deepseek",
];

/** Per-provider support map for a single tool. */
export type ProviderSupportMap = Partial<Record<ProviderId, SupportLevel>>;

/**
 * Full capability entry for one tool.
 * - `support`               — per-provider support level (missing entry → 'native' default)
 * - `costMultipliers`       — per-provider multiplier applied to base token cost (1.0 = no change)
 * - `fallbackScores`        — per-provider priority score for fallback chain ordering (higher = preferred)
 * - `emulationCostMultipliers` — per-provider overhead multiplier when running via emulation (≥1.0)
 * - `substitutes`           — ordered list of tool names to try when this tool is unavailable
 * - `category`              — logical grouping used for batch-query helpers
 */
export interface ToolCapability {
  toolName: string;
  support: ProviderSupportMap;
  costMultipliers: Partial<Record<ProviderId, number>>;
  /**
   * Per-provider fallback priority score (0–100, higher = more preferred in chain).
   * When absent, score defaults to rank-derived value (native=100, via-mcp=60, emulated=30).
   * Allows manual tuning: e.g. prefer xAI over Anthropic for a specific tool even at equal support.
   */
  fallbackScores?: Partial<Record<ProviderId, number>>;
  /**
   * Per-provider emulation cost multiplier — additional overhead when the tool is emulated
   * via prompt engineering rather than native API support.
   * Values >1.0 indicate emulation overhead (e.g. 1.2 = 20% more tokens/cost vs. native).
   * Missing entry → 1.0 (no overhead, or not emulated).
   */
  emulationCostMultipliers?: Partial<Record<ProviderId, number>>;
  substitutes: string[];
  category: ToolCategory;
}

export type ToolCategory =
  | "filesystem"
  | "execution"
  | "search"
  | "web"
  | "vision"
  | "reasoning"
  | "collaboration"
  | "editor"
  | "agent"
  | "utility";

/** Result returned by canExecute() / getBestProvider(). */
export interface CapabilityCheckResult {
  canExecute: boolean;
  supportLevel: SupportLevel;
  costMultiplier: number;
  reason: string;
  alternatives: string[];
}

export interface BestProviderOptions {
  /** Prefer lowest cost (default: prefer best support level). */
  preferLowestCost?: boolean;
  /** Exclude these providers from consideration. */
  exclude?: ProviderId[];
  /** Only consider these providers (whitelist). */
  include?: ProviderId[];
}

export interface BestProviderResult {
  provider: ProviderId | null;
  supportLevel: SupportLevel;
  costMultiplier: number;
  reason: string;
}

// ---------------------------------------------------------------------------
// Support-level ranking (higher = better)
// ---------------------------------------------------------------------------

const SUPPORT_RANK: Record<SupportLevel, number> = {
  native: 3,
  "via-mcp": 2,
  emulated: 1,
  unsupported: 0,
};

// ---------------------------------------------------------------------------
// Registry class
// ---------------------------------------------------------------------------

export class CapabilityRegistry {
  private readonly capabilities = new Map<string, ToolCapability>();

  /** Register or overwrite a tool capability entry. */
  register(entry: ToolCapability): void {
    this.capabilities.set(entry.toolName, entry);
  }

  /** Return the capability entry for a tool, or undefined if unknown. */
  get(toolName: string): ToolCapability | undefined {
    return this.capabilities.get(toolName);
  }

  /** Return all registered tool names. */
  allToolNames(): string[] {
    return Array.from(this.capabilities.keys());
  }

  /** Return all entries for a given category. */
  byCategory(category: ToolCategory): ToolCapability[] {
    return Array.from(this.capabilities.values()).filter(
      (e) => e.category === category
    );
  }

  /**
   * Check whether a specific provider can execute a tool.
   *
   * Rules:
   * 1. Unknown tool → canExecute: false (fail-safe).
   * 2. Missing entry in support map → treated as 'native' (optimistic default).
   * 3. 'unsupported' → canExecute: false, alternatives populated.
   */
  canExecute(toolName: string, provider: ProviderId): CapabilityCheckResult {
    const cap = this.capabilities.get(toolName);
    if (!cap) {
      return {
        canExecute: false,
        supportLevel: "unsupported",
        costMultiplier: 1.0,
        reason: `Tool "${toolName}" is not registered in the capability registry.`,
        alternatives: [],
      };
    }

    const level: SupportLevel = cap.support[provider] ?? "native";
    const multiplier = cap.costMultipliers[provider] ?? 1.0;
    const canRun = level !== "unsupported";

    let reason: string;
    if (canRun) {
      reason = `${provider} supports "${toolName}" at level "${level}" (cost ×${multiplier.toFixed(2)}).`;
    } else {
      reason = `${provider} does not support "${toolName}".`;
    }

    return {
      canExecute: canRun,
      supportLevel: level,
      costMultiplier: multiplier,
      reason,
      alternatives: canRun ? [] : cap.substitutes,
    };
  }

  /**
   * Return the best provider for executing a tool.
   *
   * "Best" defaults to highest support rank; when `preferLowestCost` is set,
   * ties in rank are broken by lowest cost multiplier.
   */
  getBestProvider(
    toolName: string,
    options: BestProviderOptions = {}
  ): BestProviderResult {
    const cap = this.capabilities.get(toolName);
    if (!cap) {
      return {
        provider: null,
        supportLevel: "unsupported",
        costMultiplier: 1.0,
        reason: `Tool "${toolName}" is not registered in the capability registry.`,
      };
    }

    let candidates = ALL_PROVIDERS.filter((p) => {
      if (options.exclude?.includes(p)) return false;
      if (options.include && !options.include.includes(p)) return false;
      return true;
    });

    if (candidates.length === 0) {
      return {
        provider: null,
        supportLevel: "unsupported",
        costMultiplier: 1.0,
        reason: "No candidate providers after applying include/exclude filters.",
      };
    }

    // Score each candidate
    const scored = candidates.map((p) => {
      const level: SupportLevel = cap.support[p] ?? "native";
      const cost = cap.costMultipliers[p] ?? 1.0;
      return { provider: p, level, cost, rank: SUPPORT_RANK[level] };
    });

    // Filter out unsupported
    const viable = scored.filter((s) => s.rank > 0);
    if (viable.length === 0) {
      return {
        provider: null,
        supportLevel: "unsupported",
        costMultiplier: 1.0,
        reason: `No available provider supports "${toolName}".`,
      };
    }

    // Sort: rank DESC, then cost ASC (when preferLowestCost) or cost DESC
    viable.sort((a, b) => {
      if (b.rank !== a.rank) return b.rank - a.rank;
      return options.preferLowestCost ? a.cost - b.cost : b.cost - a.cost;
    });

    const best = viable[0]!;
    return {
      provider: best.provider,
      supportLevel: best.level,
      costMultiplier: best.cost,
      reason: `${best.provider} is best for "${toolName}" (level: ${best.level}, cost ×${best.cost.toFixed(2)}).`,
    };
  }

  /** Suggest substitute tools when a tool is unavailable on a provider. */
  getSubstitutes(toolName: string, provider: ProviderId): string[] {
    const check = this.canExecute(toolName, provider);
    if (check.canExecute) return [];
    return check.alternatives;
  }

  /**
   * Return the emulation cost multiplier for a tool on a provider.
   *
   * This is the *additional* overhead when running via emulation compared to
   * native execution. Values >1.0 indicate emulation overhead.
   * Returns 1.0 when:
   *   - No emulationCostMultipliers entry exists for the provider, OR
   *   - The tool is native on this provider (overhead = none).
   */
  getEmulationCostMultiplier(toolName: string, provider: ProviderId): number {
    const cap = this.capabilities.get(toolName);
    if (!cap) return 1.0;
    const level: SupportLevel = cap.support[provider] ?? "native";
    if (level === "native") return 1.0;
    return cap.emulationCostMultipliers?.[provider] ?? 1.0;
  }

  /**
   * Return the fallback priority score for a provider/tool combination.
   *
   * Higher score = more preferred in the fallback chain.
   * Default scores by support level: native=100, via-mcp=60, emulated=30.
   * A registered `fallbackScores` entry overrides the default for fine-grained control.
   */
  getFallbackScore(toolName: string, provider: ProviderId): number {
    const cap = this.capabilities.get(toolName);
    if (!cap) return 0;
    if (cap.fallbackScores?.[provider] !== undefined) {
      return cap.fallbackScores[provider]!;
    }
    // Default score derived from support level
    const level: SupportLevel = cap.support[provider] ?? "native";
    const defaults: Record<SupportLevel, number> = {
      native: 100,
      "via-mcp": 60,
      emulated: 30,
      unsupported: 0,
    };
    return defaults[level];
  }

  /**
   * Return an ordered fallback chain of providers for a tool, starting from
   * the best (highest fallback score, then lowest effective cost) down to the worst.
   *
   * Providers with 'unsupported' level are excluded.
   * The chain uses `fallbackScores` for ordering when registered, otherwise
   * falls back to support-rank + cost-multiplier ordering.
   * The chain is used by the router to attempt per-tool promotion without
   * committing to a full session provider switch.
   */
  getProviderFallbackChain(
    toolName: string,
    options: BestProviderOptions = {}
  ): Array<{
    provider: ProviderId;
    supportLevel: SupportLevel;
    costMultiplier: number;
    fallbackScore: number;
    emulationCostMultiplier: number;
  }> {
    const cap = this.capabilities.get(toolName);
    if (!cap) return [];

    const candidates = ALL_PROVIDERS.filter((p) => {
      if (options.exclude?.includes(p)) return false;
      if (options.include && !options.include.includes(p)) return false;
      return true;
    });

    const scored = candidates.map((p) => {
      const level: SupportLevel = cap.support[p] ?? "native";
      const cost = cap.costMultipliers[p] ?? 1.0;
      const emulationCost = this.getEmulationCostMultiplier(toolName, p);
      const fbScore = this.getFallbackScore(toolName, p);
      return {
        provider: p,
        supportLevel: level,
        costMultiplier: cost,
        fallbackScore: fbScore,
        emulationCostMultiplier: emulationCost,
        rank: SUPPORT_RANK[level],
      };
    });

    return scored
      .filter((s) => s.rank > 0)
      .sort((a, b) => {
        // Primary: fallback score descending (higher = more preferred)
        if (b.fallbackScore !== a.fallbackScore) return b.fallbackScore - a.fallbackScore;
        // Secondary: support rank descending
        if (b.rank !== a.rank) return b.rank - a.rank;
        // Tertiary: prefer lower effective cost (costMultiplier * emulationCostMultiplier)
        const aCost = a.costMultiplier * a.emulationCostMultiplier;
        const bCost = b.costMultiplier * b.emulationCostMultiplier;
        return aCost - bCost;
      })
      .map(({ provider, supportLevel, costMultiplier, fallbackScore, emulationCostMultiplier }) => ({
        provider,
        supportLevel,
        costMultiplier,
        fallbackScore,
        emulationCostMultiplier,
      }));
  }
}

// ---------------------------------------------------------------------------
// Default registry — populated with all 42 known tools × 6 providers
// ---------------------------------------------------------------------------

export const globalCapabilityRegistry = new CapabilityRegistry();

function reg(entry: ToolCapability): void {
  globalCapabilityRegistry.register(entry);
}

// ── Filesystem tools ────────────────────────────────────────────────────────

reg({
  toolName: "Read",
  category: "filesystem",
  support: {
    anthropic: "native",
    xai: "native",
    openai: "native",
    ollama: "native",
    groq: "native",
    deepseek: "native",
  },
  costMultipliers: {},
  substitutes: ["WebFetch"],
});

reg({
  toolName: "Write",
  category: "filesystem",
  support: {
    anthropic: "native",
    xai: "native",
    openai: "native",
    ollama: "native",
    groq: "native",
    deepseek: "native",
  },
  costMultipliers: {},
  substitutes: [],
});

reg({
  toolName: "Edit",
  category: "filesystem",
  support: {
    anthropic: "native",
    xai: "native",
    openai: "native",
    ollama: "emulated",
    groq: "emulated",
    deepseek: "emulated",
  },
  costMultipliers: {
    ollama: 1.1,
    groq: 1.1,
    deepseek: 1.1,
  },
  // xAI preferred over Anthropic as primary fallback for Edit (lower latency, same quality).
  fallbackScores: {
    xai: 105,
    anthropic: 100,
    openai: 90,
    ollama: 30,
    groq: 25,
    deepseek: 28,
  },
  // Emulation overhead when running Edit via prompt-synthesis on limited providers.
  emulationCostMultipliers: {
    ollama: 1.2,
    groq: 1.2,
    deepseek: 1.15,
  },
  substitutes: ["Write"],
});

reg({
  toolName: "LS",
  category: "filesystem",
  support: {
    anthropic: "native",
    xai: "native",
    openai: "native",
    ollama: "native",
    groq: "native",
    deepseek: "native",
  },
  costMultipliers: {},
  substitutes: ["Glob"],
});

reg({
  toolName: "Glob",
  category: "filesystem",
  support: {
    anthropic: "native",
    xai: "native",
    openai: "native",
    ollama: "native",
    groq: "native",
    deepseek: "native",
  },
  costMultipliers: {},
  substitutes: ["LS"],
});

reg({
  toolName: "Grep",
  category: "filesystem",
  support: {
    anthropic: "native",
    xai: "native",
    openai: "native",
    ollama: "native",
    groq: "native",
    deepseek: "native",
  },
  costMultipliers: {},
  substitutes: [],
});

reg({
  toolName: "Diff",
  category: "filesystem",
  support: {
    anthropic: "native",
    xai: "native",
    openai: "native",
    ollama: "emulated",
    groq: "emulated",
    deepseek: "native",
  },
  costMultipliers: {
    ollama: 1.1,
    groq: 1.1,
  },
  substitutes: ["Bash"],
});

reg({
  toolName: "Snip",
  category: "filesystem",
  support: {
    anthropic: "native",
    xai: "native",
    openai: "native",
    ollama: "emulated",
    groq: "native",
    deepseek: "native",
  },
  costMultipliers: {
    ollama: 1.1,
  },
  substitutes: ["Read"],
});

reg({
  toolName: "BulkEdit",
  category: "filesystem",
  support: {
    anthropic: "native",
    xai: "native",
    openai: "native",
    ollama: "emulated",
    groq: "emulated",
    deepseek: "emulated",
  },
  costMultipliers: {
    ollama: 1.2,
    groq: 1.2,
    deepseek: 1.15,
  },
  fallbackScores: {
    anthropic: 100,
    xai: 98,
    openai: 95,
    deepseek: 28,
    ollama: 20,
    groq: 18,
  },
  emulationCostMultipliers: {
    ollama: 1.25,
    groq: 1.25,
    deepseek: 1.2,
  },
  substitutes: ["Edit"],
});

// ── Execution tools ─────────────────────────────────────────────────────────

reg({
  toolName: "Bash",
  category: "execution",
  support: {
    anthropic: "native",
    xai: "native",
    openai: "native",
    ollama: "native",
    groq: "native",
    deepseek: "native",
  },
  costMultipliers: {},
  substitutes: [],
});

reg({
  toolName: "PowerShell",
  category: "execution",
  support: {
    anthropic: "native",
    xai: "native",
    openai: "native",
    ollama: "native",
    groq: "native",
    deepseek: "native",
  },
  costMultipliers: {},
  substitutes: ["Bash"],
});

reg({
  toolName: "Sleep",
  category: "execution",
  support: {
    anthropic: "native",
    xai: "native",
    openai: "native",
    ollama: "native",
    groq: "native",
    deepseek: "native",
  },
  costMultipliers: {},
  substitutes: [],
});

// ── Search tools ─────────────────────────────────────────────────────────────

reg({
  toolName: "ToolSearch",
  category: "search",
  support: {
    anthropic: "native",
    xai: "native",
    openai: "native",
    ollama: "emulated",
    groq: "emulated",
    deepseek: "native",
  },
  costMultipliers: {
    ollama: 1.15,
    groq: 1.1,
  },
  substitutes: [],
});

// ── Web tools ────────────────────────────────────────────────────────────────

reg({
  toolName: "WebFetch",
  category: "web",
  support: {
    anthropic: "native",
    xai: "native",
    openai: "native",
    ollama: "native",
    groq: "native",
    deepseek: "native",
  },
  costMultipliers: {},
  substitutes: [],
});

reg({
  toolName: "WebSearch",
  category: "web",
  support: {
    anthropic: "native",
    xai: "native",
    openai: "native",
    ollama: "via-mcp",
    groq: "via-mcp",
    deepseek: "via-mcp",
  },
  costMultipliers: {
    ollama: 1.2,
    groq: 1.15,
    deepseek: 1.15,
  },
  substitutes: ["WebFetch"],
});

reg({
  toolName: "WebBrowser",
  category: "web",
  support: {
    anthropic: "native",
    xai: "via-mcp",
    openai: "via-mcp",
    ollama: "unsupported",
    groq: "unsupported",
    deepseek: "via-mcp",
  },
  costMultipliers: {
    xai: 1.3,
    openai: 1.3,
    deepseek: 1.25,
  },
  substitutes: ["WebFetch"],
});

// ── Vision tools ─────────────────────────────────────────────────────────────

reg({
  toolName: "Vision",
  category: "vision",
  support: {
    anthropic: "native",
    xai: "native",
    openai: "native",
    ollama: "emulated",
    groq: "unsupported",
    deepseek: "emulated",
  },
  costMultipliers: {
    anthropic: 1.5,
    xai: 1.5,
    openai: 1.5,
    ollama: 1.4,
    deepseek: 1.4,
  },
  substitutes: ["Read"],
});

// ── Reasoning / analysis tools ───────────────────────────────────────────────

reg({
  toolName: "Verify",
  category: "reasoning",
  support: {
    anthropic: "native",
    xai: "native",
    openai: "native",
    ollama: "emulated",
    groq: "emulated",
    deepseek: "emulated",
  },
  costMultipliers: {
    anthropic: 1.2,
    xai: 1.2,
    openai: 1.2,
    ollama: 1.15,
    groq: 1.15,
    deepseek: 1.15,
  },
  substitutes: [],
});

reg({
  toolName: "LSP",
  category: "reasoning",
  support: {
    anthropic: "native",
    xai: "native",
    openai: "native",
    ollama: "emulated",
    groq: "unsupported",
    deepseek: "emulated",
  },
  costMultipliers: {
    ollama: 1.2,
    deepseek: 1.15,
  },
  substitutes: ["Grep", "Read"],
});

// ── Editor / notebook tools ──────────────────────────────────────────────────

reg({
  toolName: "NotebookEdit",
  category: "editor",
  support: {
    anthropic: "native",
    xai: "native",
    openai: "native",
    ollama: "emulated",
    groq: "unsupported",
    deepseek: "emulated",
  },
  costMultipliers: {
    ollama: 1.15,
    deepseek: 1.1,
  },
  substitutes: ["Edit"],
});

reg({
  toolName: "TodoWrite",
  category: "editor",
  support: {
    anthropic: "native",
    xai: "native",
    openai: "native",
    ollama: "native",
    groq: "native",
    deepseek: "native",
  },
  costMultipliers: {},
  substitutes: ["Write"],
});

// ── Agent / collaboration tools ───────────────────────────────────────────────

reg({
  toolName: "Agent",
  category: "agent",
  support: {
    anthropic: "native",
    xai: "native",
    openai: "native",
    ollama: "emulated",
    groq: "unsupported",
    deepseek: "emulated",
  },
  costMultipliers: {
    ollama: 1.3,
    deepseek: 1.2,
  },
  substitutes: [],
});

reg({
  toolName: "Coordinate",
  category: "agent",
  support: {
    anthropic: "native",
    xai: "native",
    openai: "native",
    ollama: "unsupported",
    groq: "unsupported",
    deepseek: "unsupported",
  },
  costMultipliers: {},
  substitutes: ["Agent"],
});

reg({
  toolName: "AskUser",
  category: "collaboration",
  support: {
    anthropic: "native",
    xai: "native",
    openai: "native",
    ollama: "native",
    groq: "native",
    deepseek: "native",
  },
  costMultipliers: {},
  substitutes: [],
});

reg({
  toolName: "SendMessage",
  category: "collaboration",
  support: {
    anthropic: "native",
    xai: "native",
    openai: "native",
    ollama: "emulated",
    groq: "emulated",
    deepseek: "emulated",
  },
  costMultipliers: {
    ollama: 1.1,
    groq: 1.1,
    deepseek: 1.1,
  },
  substitutes: ["AskUser"],
});

reg({
  toolName: "Team",
  category: "collaboration",
  support: {
    anthropic: "native",
    xai: "native",
    openai: "via-mcp",
    ollama: "unsupported",
    groq: "unsupported",
    deepseek: "via-mcp",
  },
  costMultipliers: {
    openai: 1.15,
    deepseek: 1.1,
  },
  substitutes: ["Agent"],
});

reg({
  toolName: "Peers",
  category: "collaboration",
  support: {
    anthropic: "native",
    xai: "native",
    openai: "via-mcp",
    ollama: "unsupported",
    groq: "unsupported",
    deepseek: "via-mcp",
  },
  costMultipliers: {
    openai: 1.15,
    deepseek: 1.1,
  },
  substitutes: ["Team"],
});

// ── Utility / config tools ────────────────────────────────────────────────────

reg({
  toolName: "Config",
  category: "utility",
  support: {
    anthropic: "native",
    xai: "native",
    openai: "native",
    ollama: "native",
    groq: "native",
    deepseek: "native",
  },
  costMultipliers: {},
  substitutes: [],
});

reg({
  toolName: "Memory",
  category: "utility",
  support: {
    anthropic: "native",
    xai: "native",
    openai: "native",
    ollama: "emulated",
    groq: "emulated",
    deepseek: "emulated",
  },
  costMultipliers: {
    ollama: 1.1,
    groq: 1.1,
    deepseek: 1.1,
  },
  substitutes: ["Write"],
});

reg({
  toolName: "Tasks",
  category: "utility",
  support: {
    anthropic: "native",
    xai: "native",
    openai: "native",
    ollama: "native",
    groq: "native",
    deepseek: "native",
  },
  costMultipliers: {},
  substitutes: [],
});

reg({
  toolName: "Workflow",
  category: "utility",
  support: {
    anthropic: "native",
    xai: "native",
    openai: "native",
    ollama: "unsupported",
    groq: "unsupported",
    deepseek: "emulated",
  },
  costMultipliers: {
    deepseek: 1.15,
  },
  substitutes: ["Agent"],
});

reg({
  toolName: "Worktree",
  category: "utility",
  support: {
    anthropic: "native",
    xai: "native",
    openai: "native",
    ollama: "native",
    groq: "native",
    deepseek: "native",
  },
  costMultipliers: {},
  substitutes: [],
});

// ── MCP tools ─────────────────────────────────────────────────────────────────

reg({
  toolName: "MCPTool",
  category: "utility",
  support: {
    anthropic: "native",
    xai: "via-mcp",
    openai: "via-mcp",
    ollama: "via-mcp",
    groq: "unsupported",
    deepseek: "via-mcp",
  },
  costMultipliers: {
    xai: 1.1,
    openai: 1.1,
    ollama: 1.1,
    deepseek: 1.1,
  },
  substitutes: [],
});

reg({
  toolName: "MCPResources",
  category: "utility",
  support: {
    anthropic: "native",
    xai: "via-mcp",
    openai: "via-mcp",
    ollama: "unsupported",
    groq: "unsupported",
    deepseek: "via-mcp",
  },
  costMultipliers: {
    xai: 1.1,
    openai: 1.1,
    deepseek: 1.1,
  },
  substitutes: ["WebFetch"],
});

// ── File utility tools ────────────────────────────────────────────────────────

reg({
  toolName: "FileRead",
  category: "filesystem",
  support: {
    anthropic: "native",
    xai: "native",
    openai: "native",
    ollama: "native",
    groq: "native",
    deepseek: "native",
  },
  costMultipliers: {},
  substitutes: ["WebFetch"],
});

reg({
  toolName: "FileWrite",
  category: "filesystem",
  support: {
    anthropic: "native",
    xai: "native",
    openai: "native",
    ollama: "native",
    groq: "native",
    deepseek: "native",
  },
  costMultipliers: {},
  substitutes: [],
});

reg({
  toolName: "FileEdit",
  category: "filesystem",
  support: {
    anthropic: "native",
    xai: "native",
    openai: "native",
    ollama: "emulated",
    groq: "emulated",
    deepseek: "emulated",
  },
  costMultipliers: {
    ollama: 1.1,
    groq: 1.1,
    deepseek: 1.1,
  },
  substitutes: ["FileWrite", "Write"],
});

// ── Extended agent tools ──────────────────────────────────────────────────────

reg({
  toolName: "Autopilot",
  category: "agent",
  support: {
    anthropic: "native",
    xai: "native",
    openai: "native",
    ollama: "unsupported",
    groq: "unsupported",
    deepseek: "unsupported",
  },
  costMultipliers: {},
  substitutes: ["Agent"],
});

reg({
  toolName: "Plan",
  category: "agent",
  support: {
    anthropic: "native",
    xai: "native",
    openai: "native",
    ollama: "emulated",
    groq: "emulated",
    deepseek: "native",
  },
  costMultipliers: {
    anthropic: 1.2,
    xai: 1.2,
    openai: 1.2,
    ollama: 1.15,
    groq: 1.15,
    deepseek: 1.1,
  },
  substitutes: [],
});

reg({
  toolName: "Skills",
  category: "agent",
  support: {
    anthropic: "native",
    xai: "native",
    openai: "native",
    ollama: "unsupported",
    groq: "unsupported",
    deepseek: "emulated",
  },
  costMultipliers: {
    deepseek: 1.15,
  },
  substitutes: ["Agent"],
});

reg({
  toolName: "Genome",
  category: "agent",
  support: {
    anthropic: "native",
    xai: "native",
    openai: "via-mcp",
    ollama: "unsupported",
    groq: "unsupported",
    deepseek: "unsupported",
  },
  costMultipliers: {
    openai: 1.2,
  },
  substitutes: ["Memory"],
});

reg({
  toolName: "Telemetry",
  category: "utility",
  support: {
    anthropic: "native",
    xai: "native",
    openai: "native",
    ollama: "native",
    groq: "native",
    deepseek: "native",
  },
  costMultipliers: {},
  substitutes: [],
});

reg({
  toolName: "Checkpoint",
  category: "utility",
  support: {
    anthropic: "native",
    xai: "native",
    openai: "native",
    ollama: "native",
    groq: "native",
    deepseek: "native",
  },
  costMultipliers: {},
  substitutes: [],
});

reg({
  toolName: "TimeTravel",
  category: "utility",
  support: {
    anthropic: "native",
    xai: "native",
    openai: "emulated",
    ollama: "unsupported",
    groq: "unsupported",
    deepseek: "unsupported",
  },
  costMultipliers: {
    openai: 1.25,
  },
  substitutes: ["Checkpoint"],
});

reg({
  toolName: "SurgicalGate",
  category: "utility",
  support: {
    anthropic: "native",
    xai: "native",
    openai: "native",
    ollama: "emulated",
    groq: "unsupported",
    deepseek: "emulated",
  },
  costMultipliers: {
    ollama: 1.1,
    deepseek: 1.1,
  },
  substitutes: [],
});

reg({
  toolName: "ProviderRouter",
  category: "utility",
  support: {
    anthropic: "native",
    xai: "native",
    openai: "native",
    ollama: "native",
    groq: "native",
    deepseek: "native",
  },
  costMultipliers: {},
  substitutes: [],
});

reg({
  toolName: "BudgetAllocator",
  category: "utility",
  support: {
    anthropic: "native",
    xai: "native",
    openai: "native",
    ollama: "emulated",
    groq: "emulated",
    deepseek: "emulated",
  },
  costMultipliers: {
    ollama: 1.05,
    groq: 1.05,
    deepseek: 1.05,
  },
  substitutes: [],
});

reg({
  toolName: "ContextCompact",
  category: "utility",
  support: {
    anthropic: "native",
    xai: "native",
    openai: "native",
    ollama: "emulated",
    groq: "emulated",
    deepseek: "native",
  },
  costMultipliers: {
    ollama: 1.1,
    groq: 1.1,
  },
  substitutes: [],
});

reg({
  toolName: "StreamAggregator",
  category: "utility",
  support: {
    anthropic: "native",
    xai: "native",
    openai: "native",
    ollama: "native",
    groq: "native",
    deepseek: "native",
  },
  costMultipliers: {},
  substitutes: [],
});

reg({
  toolName: "Speculation",
  category: "utility",
  support: {
    anthropic: "native",
    xai: "native",
    openai: "native",
    ollama: "unsupported",
    groq: "unsupported",
    deepseek: "emulated",
  },
  costMultipliers: {
    deepseek: 1.15,
  },
  substitutes: [],
});
