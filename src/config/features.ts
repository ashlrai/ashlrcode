/**
 * Feature flags — compile-time dead code elimination via Bun.
 *
 * Usage: if (feature("VOICE_MODE")) { ... }
 * Disabled features are stripped from the bundle at build time.
 */

// Feature flag definitions with defaults
const FLAGS: Record<string, boolean> = {
  VOICE_MODE: false,    // Requires sox/rec installed — opt-in
  KAIROS: true,         // Autonomous mode — production ready
  BROWSER_TOOL: true,   // Puppeteer browser automation — works if puppeteer installed
  LSP: true,            // Language server protocol — production ready
  SPECULATION: true,    // Pre-fetch cache for read-only tools — production ready
  DREAM_TASK: true,     // Background memory consolidation
  TEAM_MODE: true,      // Persistent agent teams
  WORKTREE_AGENTS: true, // Git worktree isolation per agent
  ADVANCED_PERMISSIONS: true,
  EFFORT_LEVELS: true,
};

// Runtime overrides from env vars: AC_FEATURE_VOICE_MODE=true
for (const [key] of Object.entries(FLAGS)) {
  const envKey = `AC_FEATURE_${key}`;
  const envVal = process.env[envKey];
  if (envVal !== undefined) {
    FLAGS[key] = envVal === "true" || envVal === "1";
  }
}

/**
 * Check if a feature is enabled.
 * In production builds, Bun can DCE branches where this returns false.
 */
export function feature(name: string): boolean {
  return FLAGS[name] ?? false;
}

/**
 * List all feature flags and their current state.
 */
export function listFeatures(): Record<string, boolean> {
  return { ...FLAGS };
}

/**
 * Enable/disable a feature at runtime (for testing/debugging).
 */
export function setFeature(name: string, enabled: boolean): void {
  FLAGS[name] = enabled;
}
