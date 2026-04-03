/**
 * ListMcpResources tool — enumerate tools and resources from connected MCP servers.
 */

import type { Tool, ToolContext } from "./types.ts";
import type { MCPManager } from "../mcp/manager.ts";

// Module-level MCP manager reference (set during init)
let _mcpManager: MCPManager | null = null;

export function setMCPManager(manager: MCPManager): void {
  _mcpManager = manager;
}

export const listMcpResourcesTool: Tool = {
  name: "ListMcpResources",

  prompt() {
    return "List available MCP (Model Context Protocol) resources and tools from connected servers.";
  },

  inputSchema() {
    return {
      type: "object" as const,
      properties: {
        server: {
          type: "string",
          description: "Optional: filter by server name",
        },
      },
    };
  },

  isReadOnly() {
    return true;
  },

  isDestructive() {
    return false;
  },

  isConcurrencySafe() {
    return true;
  },

  validateInput() {
    return null;
  },

  async call(input: Record<string, unknown>, _context: ToolContext): Promise<string> {
    if (!_mcpManager) return "No MCP servers connected.";

    try {
      const serverNames = _mcpManager.getServerNames();
      if (serverNames.length === 0) return "No MCP servers connected.";

      const serverFilter = input.server as string | undefined;
      const allTools = _mcpManager.getAllTools();
      const lines: string[] = [];

      for (const name of serverNames) {
        if (serverFilter && !name.includes(serverFilter)) continue;

        const serverTools = allTools.filter(t => t.serverName === name);
        lines.push(`\n  Server: ${name}`);

        if (serverTools.length > 0) {
          lines.push(`  Tools (${serverTools.length}):`);
          for (const { tool } of serverTools.slice(0, 10)) {
            lines.push(`    - ${tool.name}: ${(tool.description ?? "").slice(0, 60)}`);
          }
          if (serverTools.length > 10) {
            lines.push(`    ... and ${serverTools.length - 10} more`);
          }
        }
      }

      return lines.join("\n") || "No resources found.";
    } catch (err) {
      return `Error listing MCP resources: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
