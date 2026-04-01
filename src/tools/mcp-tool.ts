/**
 * MCP Tool wrapper — wraps an MCP server tool as an AshlrCode Tool.
 *
 * Tool naming: mcp__<server>__<tool>
 */

import type { Tool, ToolContext } from "./types.ts";
import type { MCPManager } from "../mcp/manager.ts";
import type { MCPToolInfo } from "../mcp/types.ts";

export function createMCPTool(
  serverName: string,
  toolInfo: MCPToolInfo,
  manager: MCPManager
): Tool {
  const fullName = `mcp__${serverName}__${toolInfo.name}`;

  return {
    name: fullName,

    prompt() {
      return toolInfo.description ?? `MCP tool: ${toolInfo.name} from ${serverName}`;
    },

    inputSchema() {
      return toolInfo.inputSchema;
    },

    isReadOnly() {
      return false; // Can't know, default to cautious
    },
    isDestructive() {
      return false;
    },
    isConcurrencySafe() {
      return true; // MCP tools are independent
    },

    validateInput() {
      return null; // Schema validation happens on the MCP server
    },

    async call(input, _context) {
      return await manager.callTool(serverName, toolInfo.name, input);
    },
  };
}
