/**
 * Command system types — defines the interface for all slash commands.
 */

import type { Session } from "../persistence/session.ts";
import type { ProviderRouter } from "../providers/router.ts";
import type { Message } from "../providers/types.ts";
import type { SkillRegistry } from "../skills/registry.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { ToolContext } from "../tools/types.ts";
import type { BuddyData } from "../ui/buddy.ts";

export type CommandCategory = "agent" | "workflow" | "session" | "tools" | "files" | "other";

export interface Command {
  /** Primary trigger including slash, e.g. "/help" */
  name: string;
  /** Alternative triggers, e.g. ["/q", "/exit"] */
  aliases?: string[];
  /** Short description for help output */
  description: string;
  /** Category for grouped help display */
  category: CommandCategory;
  /** Sub-commands for tab autocomplete, e.g. ["scan", "queue", "auto"] */
  subcommands?: string[];
  /** Handler — returns true if command was handled */
  handler: (args: string, ctx: CommandContext) => Promise<boolean>;
}

/**
 * Everything a command handler needs from the REPL.
 * The REPL constructs this once and passes it to every command.
 */
export interface CommandContext {
  // Output
  addOutput: (text: string) => void;
  update: () => void;

  // Core state
  state: ReplState;

  // Processing control
  getProcessing: () => boolean;
  setProcessing: (v: boolean) => void;
  getSpinnerText: () => string;
  setSpinnerText: (v: string) => void;

  // Agent execution
  runTurnInk: (input: string, displayText?: string) => Promise<void>;

  // Output history (for /search, /transcript)
  getItems: () => Array<{ text: string }>;

  // Background operations
  backgroundOps: Map<string, { name: string; startedAt: number; cancel: () => void }>;

  // Autopilot state
  getAutopilotLoop: () => AutopilotLoopRef | null;
  setAutopilotLoop: (loop: AutopilotLoopRef | null) => void;
  getAutopilotRunning: () => boolean;
  setAutopilotRunning: (v: boolean) => void;
  getWorkQueue: () => WorkQueueRef;

  // KAIROS state
  getKairos: () => KairosRef | null;
  setKairos: (k: KairosRef | null) => void;

  // ProductAgent state
  getProductAgent: () => ProductAgentRef | null;
  setProductAgent: (p: ProductAgentRef | null) => void;

  // Misc
  getLastFullToolOutput: () => string | null;
  stripAnsi: (s: string) => string;
  buildCompactSummary: () => string;
  formatTimeAgo: (date: Date) => string;
}

/** Subset of REPL state exposed to commands */
export interface ReplState {
  history: Message[];
  router: ProviderRouter;
  registry: ToolRegistry;
  skillRegistry: SkillRegistry;
  toolContext: ToolContext;
  session: Session;
  baseSystemPrompt: string;
  buddy: BuddyData;
}

// Opaque refs to avoid importing heavy types — commands call methods on these
export interface AutopilotLoopRef {
  start: (vision: unknown, config: unknown) => Promise<void>;
  stop: () => void;
  requestWrapUp: () => void;
  queueUserMessage: (msg: string) => void;
  getStatus: () => {
    running: boolean;
    tickNumber: number;
    itemsCompleted: number;
    itemsFailed: number;
    queuePending: number;
    duration: string;
    focusState: string;
    wrapUpRequested: boolean;
  };
}

export interface WorkQueueRef {
  addItems: (items: unknown[]) => number;
  approveAll: () => number;
  approve: (id: string) => boolean;
  getByStatus: (status: string) => Array<{
    id: string;
    title: string;
    type: string;
    file: string;
    line?: number;
    description: string;
    priority: string;
  }>;
  getNextApproved: () => {
    id: string;
    title: string;
    type: string;
    file: string;
    line?: number;
    description: string;
  } | null;
  startItem: (id: string) => void;
  completeItem: (id: string) => void;
  failItem: (id: string, reason: string) => void;
  getStats: () => Record<string, number>;
  cleanup: () => void;
  save: () => Promise<void>;
}

export interface KairosRef {
  isRunning: () => boolean;
  start: (goal: string) => Promise<void>;
  stop: () => Promise<void>;
}

export interface ProductAgentRef {
  isRunning: () => boolean;
  start: () => Promise<unknown>;
  stop: () => void;
}
