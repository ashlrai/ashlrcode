/**
 * ToolSearch — find tools by keyword.
 * Useful when 30+ tools are registered (including MCP tools).
 */

import type { Tool, ToolContext } from "./types.ts";
import type { ToolRegistry } from "./registry.ts";

// Injected at registration time
let _registry: ToolRegistry | null = null;

export function initToolSearch(registry: ToolRegistry): void {
  _registry = registry;
}

export const toolSearchTool: Tool = {
  name: "ToolSearch",

  prompt() {
    return "Search for available tools by keyword. Returns matching tool names and descriptions. Useful when many tools are registered (including MCP tools).";
  },

  inputSchema() {
    return {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Keyword to search for in tool names and descriptions",
        },
        maxResults: {
          type: "number",
          description: "Maximum results to return (default: 10)",
        },
      },
      required: ["query"],
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

  validateInput(input) {
    if (!input.query || typeof input.query !== "string") {
      return "query is required";
    }
    return null;
  },

  async call(input, _context) {
    if (!_registry) return "ToolSearch not initialized";

    const query = (input.query as string).toLowerCase();
    const max = (input.maxResults as number) ?? 10;

    const allTools = _registry.getAll();
    const matches = allTools
      .filter((t) => {
        const name = t.name.toLowerCase();
        const desc = t.prompt().toLowerCase();
        return name.includes(query) || desc.includes(query);
      })
      .slice(0, max);

    if (matches.length === 0) {
      return `No tools matching "${query}". Total tools: ${allTools.length}`;
    }

    const lines = matches.map((t) => {
      const readOnly = t.isReadOnly() ? " [read-only]" : "";
      return `- **${t.name}**${readOnly}: ${t.prompt().slice(0, 100)}`;
    });

    return `${matches.length} tool(s) matching "${query}":\n\n${lines.join("\n")}`;
  },
};
