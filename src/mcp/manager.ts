/**
 * MCP Connection Manager — manages multiple MCP server connections.
 */

import chalk from "chalk";
import { MCPClient, MCPSSEClient, MCPWebSocketClient, createMCPClient } from "./client.ts";
import type { MCPServerConfig, MCPToolInfo } from "./types.ts";
import { authorizeOAuth } from "./oauth.ts";
import type { OAuthConfig } from "./oauth.ts";

type MCPClientType = MCPClient | MCPSSEClient | MCPWebSocketClient;

export type MCPConnectionState = "connected" | "disconnected" | "reconnecting";

export class MCPManager {
  private clients = new Map<string, MCPClientType>();
  private configs = new Map<string, MCPServerConfig>();
  private connectionStates = new Map<string, MCPConnectionState>();

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

        this.configs.set(name, effectiveConfig);
        const client = createMCPClient(name, effectiveConfig);
        try {
          await client.connect();
          this.clients.set(name, client);
          this.connectionStates.set(name, "connected");
          console.log(
            chalk.dim(
              `  MCP: ${name} connected (${client.tools.length} tools)`
            )
          );
        } catch (err) {
          this.connectionStates.set(name, "disconnected");
          const msg = err instanceof Error ? err.message : String(err);
          console.log(chalk.yellow(`  MCP: ${name} failed to connect — ${msg.slice(0, 100)}`));
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
   * On connection error, attempts one reconnect before failing.
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

    try {
      const result = await client.callTool(toolName, args);

      // Extract text from result content blocks
      const text = result.content
        .map((c) => c.text ?? JSON.stringify(c))
        .join("\n");

      if (result.isError) {
        return `MCP Error: ${text}`;
      }

      return text;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isConnectionError =
        msg.includes("connection closed") ||
        msg.includes("not connected") ||
        msg.includes("disconnected") ||
        msg.includes("stream ended") ||
        msg.includes("WebSocket connection closed") ||
        msg.includes("WebSocket not connected");

      if (!isConnectionError) {
        return `MCP Error: ${msg}`;
      }

      // Attempt one reconnect
      console.log(chalk.dim(`  MCP: ${serverName} connection lost, attempting reconnect...`));
      const reconnected = await this.reconnect(serverName);
      if (!reconnected) {
        return `MCP server "${serverName}" disconnected and reconnect failed`;
      }

      // Retry the tool call after successful reconnect
      try {
        const retryClient = this.clients.get(serverName);
        if (!retryClient) return `MCP server "${serverName}" not connected after reconnect`;
        const result = await retryClient.callTool(toolName, args);
        const text = result.content
          .map((c) => c.text ?? JSON.stringify(c))
          .join("\n");
        if (result.isError) return `MCP Error: ${text}`;
        return text;
      } catch (retryErr) {
        const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
        return `MCP Error (after reconnect): ${retryMsg}`;
      }
    }
  }

  /**
   * Reconnect to a specific MCP server.
   * Returns true if reconnection succeeded, false otherwise.
   */
  async reconnect(serverName: string): Promise<boolean> {
    const config = this.configs.get(serverName);
    if (!config) {
      console.log(chalk.yellow(`  MCP: ${serverName} — no config found for reconnect`));
      return false;
    }

    this.connectionStates.set(serverName, "reconnecting");

    // Disconnect existing client if any
    const existing = this.clients.get(serverName);
    if (existing) {
      try { await existing.disconnect(); } catch { /* ignore */ }
      this.clients.delete(serverName);
    }

    try {
      const client = createMCPClient(serverName, config);
      await client.connect();
      this.clients.set(serverName, client);
      this.connectionStates.set(serverName, "connected");
      console.log(chalk.dim(`  MCP: ${serverName} reconnected (${client.tools.length} tools)`));
      return true;
    } catch (err) {
      this.connectionStates.set(serverName, "disconnected");
      const msg = err instanceof Error ? err.message : String(err);
      console.log(chalk.yellow(`  MCP: ${serverName} reconnect failed — ${msg.slice(0, 100)}`));
      return false;
    }
  }

  /**
   * Get the connection state for a server.
   */
  getConnectionState(serverName: string): MCPConnectionState {
    return this.connectionStates.get(serverName) ?? "disconnected";
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
