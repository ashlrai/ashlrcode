/**
 * MCP Connection Manager — manages multiple MCP server connections.
 */

import chalk from "chalk";
import { MCPClient, MCPSSEClient, createMCPClient } from "./client.ts";
import type { MCPServerConfig, MCPToolInfo } from "./types.ts";
import { authorizeOAuth } from "./oauth.ts";
import type { OAuthConfig } from "./oauth.ts";

export class MCPManager {
  private clients = new Map<string, MCPClient | MCPSSEClient>();

  /**
   * Connect to all configured MCP servers.
   */
  async connectAll(
    servers: Record<string, MCPServerConfig>
  ): Promise<void> {
    const entries = Object.entries(servers);
    if (entries.length === 0) return;

    const results = await Promise.allSettled(
      entries.map(async ([name, config]) => {
        // If OAuth is configured, authenticate before connecting
        let effectiveConfig = config;
        if (config.oauth) {
          try {
            const oauthConfig: OAuthConfig = {
              ...config.oauth,
              scopes: config.oauth.scopes ?? [],
            };
            const token = await authorizeOAuth(name, oauthConfig);
            // Pass the Bearer token to the MCP server via environment
            effectiveConfig = {
              ...config,
              env: {
                ...config.env,
                MCP_AUTH_TOKEN: token.accessToken,
                MCP_AUTH_TYPE: token.tokenType,
              },
            };
          } catch (err) {
            console.log(
              chalk.dim(
                `  MCP: ${name} OAuth failed — ${err instanceof Error ? err.message : "unknown error"}`
              )
            );
            return;
          }
        }

        const client = createMCPClient(name, effectiveConfig);
        try {
          await client.connect();
          this.clients.set(name, client);
          console.log(
            chalk.dim(
              `  MCP: ${name} connected (${client.tools.length} tools)`
            )
          );
        } catch {
          // Silently skip failed MCP servers — they may not be running
        }
      })
    );
  }

  /**
   * Get all discovered tools across all connected servers.
   */
  getAllTools(): Array<{ serverName: string; tool: MCPToolInfo }> {
    const tools: Array<{ serverName: string; tool: MCPToolInfo }> = [];
    for (const [name, client] of this.clients) {
      for (const tool of client.tools) {
        tools.push({ serverName: name, tool });
      }
    }
    return tools;
  }

  /**
   * Call a tool on a specific server.
   */
  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<string> {
    const client = this.clients.get(serverName);
    if (!client) {
      return `MCP server "${serverName}" not connected`;
    }

    const result = await client.callTool(toolName, args);

    // Extract text from result content blocks
    const text = result.content
      .map((c) => c.text ?? JSON.stringify(c))
      .join("\n");

    if (result.isError) {
      return `MCP Error: ${text}`;
    }

    return text;
  }

  /**
   * Disconnect all servers.
   */
  async disconnectAll(): Promise<void> {
    for (const [, client] of this.clients) {
      await client.disconnect();
    }
    this.clients.clear();
  }

  /**
   * Get connected server names.
   */
  getServerNames(): string[] {
    return Array.from(this.clients.keys());
  }
}
