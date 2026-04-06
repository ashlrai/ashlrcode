/**
 * Command registry — barrel export + factory for creating a fully populated registry.
 */

export { CommandRegistry } from "./registry.ts";
export type { Command, CommandCategory, CommandContext } from "./types.ts";

import { agentCommands } from "./agent.ts";
import { autopilotCommands } from "./autopilot.ts";
import { coreCommands } from "./core.ts";
import { gitCommands } from "./git.ts";
import { CommandRegistry } from "./registry.ts";
import { sessionCommands } from "./session.ts";

/**
 * Create a fully populated command registry with all built-in commands.
 */
export function createCommandRegistry(deps: {
  saveBuddy: (b: unknown) => Promise<void>;
  speculationCache: { getStats: () => { size: number; hits: number; misses: number } };
  VERSION: string;
  getFileHistory: () => any;
  scanCodebase: (ctx: any, types: any) => Promise<any[]>;
  DEFAULT_CONFIG: { scanTypes: any };
  createAutopilotLoop: () => any;
  createVision: (cwd: string, text: string) => Promise<any>;
  loadVision: (cwd: string) => Promise<any>;
}): CommandRegistry {
  const registry = new CommandRegistry();

  // Core commands need a reference to the registry for /help
  registry.registerAll(
    coreCommands({
      registry,
      saveBuddy: deps.saveBuddy,
      speculationCache: deps.speculationCache,
      VERSION: deps.VERSION,
    }),
  );

  registry.registerAll(
    gitCommands({
      getFileHistory: deps.getFileHistory,
    }),
  );

  registry.registerAll(agentCommands());
  registry.registerAll(sessionCommands());

  registry.registerAll(
    autopilotCommands({
      scanCodebase: deps.scanCodebase,
      DEFAULT_CONFIG: deps.DEFAULT_CONFIG,
      createAutopilotLoop: deps.createAutopilotLoop,
      createVision: deps.createVision,
      loadVision: deps.loadVision,
    }),
  );

  return registry;
}
