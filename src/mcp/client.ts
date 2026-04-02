/**
 * MCP Client — connects to an MCP server via stdio transport.
 *
 * Spawns a child process and communicates via JSON-RPC over stdin/stdout.
 */

import type {
  MCPServerConfig,
  MCPToolInfo,
  MCPToolResult,
  MCPInitializeResult,
  JsonRpcRequest,
  JsonRpcResponse,
} from "./types.ts";

export class MCPClient {
  private proc: any = null;
  private nextId = 1;
  private pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private rawBuffer = Buffer.alloc(0);
  private serverInfo: MCPInitializeResult | null = null;
  private _tools: MCPToolInfo[] = [];

  constructor(
    readonly name: string,
    private config: MCPServerConfig
  ) {}

  get tools(): MCPToolInfo[] {
    return this._tools;
  }

  get isConnected(): boolean {
    return this.proc !== null;
  }

  async connect(): Promise<void> {
    const env = { ...process.env, ...this.config.env };

    this.proc = Bun.spawn([this.config.command, ...(this.config.args ?? [])], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env,
    });

    // Read stdout in background
    this.readLoop();

    // Initialize
    this.serverInfo = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "ashlrcode", version: "0.7.0" },
    }) as MCPInitializeResult;

    // Send initialized notification
    this.notify("notifications/initialized", {});

    // List tools
    const result = await this.request("tools/list", {}) as { tools: MCPToolInfo[] };
    this._tools = result.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<MCPToolResult> {
    const result = await this.request("tools/call", {
      name,
      arguments: args,
    });
    return result as MCPToolResult;
  }

  async disconnect(): Promise<void> {
    if (this.proc) {
      try {
        this.proc.stdin.end();
        this.proc.kill();
      } catch {
        // Process may already be dead
      }
      this.proc = null;
    }
    // Reject pending requests
    for (const [, pending] of this.pending) {
      pending.reject(new Error("MCP client disconnected"));
    }
    this.pending.clear();
  }

  private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const message: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timeout: ${method}`));
      }, 30_000);

      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timeout); resolve(value); },
        reject: (err) => { clearTimeout(timeout); reject(err); },
      });

      this.send(message as unknown as Record<string, unknown>);
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private send(message: Record<string, unknown>): void {
    if (!this.proc) throw new Error("MCP client not connected");
    const json = JSON.stringify(message);
    // Use Buffer.byteLength for spec-correct Content-Length (UTF-8 bytes)
    // Write as Buffer to ensure byte-level consistency with the header
    const header = `Content-Length: ${Buffer.byteLength(json, "utf-8")}\r\n\r\n`;
    const buf = Buffer.concat([Buffer.from(header), Buffer.from(json, "utf-8")]);
    this.proc.stdin.write(buf);
  }

  private async readLoop(): Promise<void> {
    if (!this.proc) return;

    const reader = this.proc.stdout.getReader();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this.rawBuffer = Buffer.concat([this.rawBuffer, Buffer.from(value)]);
        this.processBuffer();
      }
    } catch {
      // Stream ended or errored
    }

    // Reject all pending requests when read loop exits (server crash/EOF)
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.reject(new Error("MCP server connection closed"));
    }
  }

  private processBuffer(): void {
    while (true) {
      // Look for Content-Length header in byte buffer
      const separator = Buffer.from("\r\n\r\n");
      const headerEnd = this.rawBuffer.indexOf(separator);
      if (headerEnd === -1) break;

      const header = this.rawBuffer.subarray(0, headerEnd).toString("utf-8");
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        // Skip malformed header
        this.rawBuffer = this.rawBuffer.subarray(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(match[1]!, 10);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + contentLength;

      if (this.rawBuffer.length < bodyEnd) break; // Need more data

      const body = this.rawBuffer.subarray(bodyStart, bodyEnd).toString("utf-8");
      this.rawBuffer = this.rawBuffer.subarray(bodyEnd);

      try {
        const message = JSON.parse(body) as JsonRpcResponse;
        if ("id" in message && message.id !== undefined) {
          const pending = this.pending.get(message.id);
          if (pending) {
            this.pending.delete(message.id);
            if (message.error) {
              pending.reject(new Error(`MCP error: ${message.error.message}`));
            } else {
              pending.resolve(message.result);
            }
          }
        }
        // Notifications (no id) are ignored for now
      } catch {
        // Malformed JSON, skip
      }
    }
  }
}
