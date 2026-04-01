/**
 * MCP (Model Context Protocol) types — JSON-RPC over stdio.
 */

export interface MCPServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

// JSON-RPC 2.0 message types
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

// MCP-specific types
export interface MCPToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface MCPToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

export interface MCPServerCapabilities {
  tools?: Record<string, unknown>;
  resources?: Record<string, unknown>;
  prompts?: Record<string, unknown>;
}

export interface MCPInitializeResult {
  protocolVersion: string;
  capabilities: MCPServerCapabilities;
  serverInfo: { name: string; version?: string };
}
