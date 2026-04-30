/**
 * Autopilot types — autonomous work discovery and execution.
 */

export type WorkItemType =
  | "todo"           // TODO/FIXME/HACK comments
  | "missing_test"   // files without test coverage
  | "lint_error"     // linter issues
  | "type_error"     // TypeScript errors
  | "security"       // dependency vulnerabilities
  | "dead_code"      // unused exports/imports
  | "complexity"     // functions > 50 lines
  | "missing_docs"   // public APIs without docs
  | "stale_dep"      // outdated dependencies
  | "error_handling" // uncaught errors, missing try/catch
  | "artist_build"   // run the artist-encyclopedia-factory build-artist DAG for a slug

export type WorkItemPriority = "critical" | "high" | "medium" | "low";

export type WorkItemStatus =
  | "discovered"    // found by scanner
  | "approved"      // user approved for execution
  | "in_progress"   // being worked on
  | "completed"     // done
  | "rejected"      // user rejected
  | "failed"        // execution failed

export interface WorkItem {
  id: string;
  type: WorkItemType;
  priority: WorkItemPriority;
  title: string;
  description: string;
  file: string;
  line?: number;
  status: WorkItemStatus;
  discoveredAt: string;
  completedAt?: string;
  error?: string;
  /** Artist slug — populated for `artist_build` items so the autopilot
   *  loop can invoke the coordinator with --config build-artist --var slug=<slug>. */
  slug?: string;
  /** Per-item budget in USD. Passed through to the build-artist coordinator
   *  config as `{{budgetUsd}}`. Additive; does nothing if unset. */
  budgetUsd?: number;
}

export type TrustLevel = "propose" | "auto";

export interface AutopilotConfig {
  trustLevel: TrustLevel;
  scanInterval: number;   // ms between scans (default: 60000)
  maxConcurrent: number;  // max items to work on at once
  scanTypes: WorkItemType[];
}

export const DEFAULT_CONFIG: AutopilotConfig = {
  trustLevel: "propose",
  scanInterval: 60_000,
  maxConcurrent: 1,
  scanTypes: [
    "todo", "missing_test", "lint_error", "type_error",
    "security", "dead_code", "complexity",
  ],
};
