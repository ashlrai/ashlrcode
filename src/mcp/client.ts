/**
 * MCP Client — connects to an MCP server via stdio, SSE, or WebSocket transport.
 *
 * stdio: Spawns a child process and communicates via JSON-RPC over stdin/stdout.
 * SSE: Connects to HTTP endpoint for server→client events, POST for client→server.
 * WebSocket: Bidirectional JSON-RPC over ws:// or wss:// connection.
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
    if (!this.config.command) throw new Error("MCP stdio client requires 'command' in config");
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
      }, 5_000); // 5s timeout (was 30s — don't block startup)

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

/**
 * MCP SSE Client — connects to an MCP server via HTTP/SSE transport.
 *
 * Server→client: SSE stream at {url}/sse
 * Client→server: POST to {url}/message
 */
export class MCPSSEClient {
  private nextId = 1;
  private pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private serverInfo: MCPInitializeResult | null = null;
  private _tools: MCPToolInfo[] = [];
  private abortController: AbortController | null = null;
  private sessionId: string | null = null;
  private baseUrl: string;

  constructor(
    readonly name: string,
    private config: MCPServerConfig
  ) {
    this.baseUrl = (config.url ?? "").replace(/\/$/, "");
  }

  get tools(): MCPToolInfo[] {
    return this._tools;
  }

  get isConnected(): boolean {
    return this.abortController !== null;
  }

  async connect(): Promise<void> {
    this.abortController = new AbortController();

    // Start SSE connection in background to get session ID and receive responses
    const ssePromise = this.startSSE();

    // Wait for session ID or SSE failure, whichever comes first
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        clearInterval(check);
        reject(new Error("SSE connection timeout"));
      }, 10_000);
      const check = setInterval(() => {
        if (this.sessionId) {
          clearTimeout(timeout);
          clearInterval(check);
          resolve();
        }
      }, 50);
      this.abortController!.signal.addEventListener("abort", () => {
        clearTimeout(timeout);
        clearInterval(check);
        reject(new Error("SSE connection aborted"));
      });
      // If SSE fetch fails immediately (server not running), reject early
      ssePromise.catch((err) => {
        clearTimeout(timeout);
        clearInterval(check);
        reject(err);
      });
    });

    // Initialize
    this.serverInfo = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "ashlrcode", version: "1.0.1" },
    }) as MCPInitializeResult;

    // Send initialized notification
    this.notify("notifications/initialized", {});

    // List tools
    const result = await this.request("tools/list", {}) as { tools: MCPToolInfo[] };
    this._tools = result.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<MCPToolResult> {
    const result = await this.request("tools/call", { name, arguments: args });
    return result as MCPToolResult;
  }

  async disconnect(): Promise<void> {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.sessionId = null;
    for (const [, pending] of this.pending) {
      pending.reject(new Error("MCP SSE client disconnected"));
    }
    this.pending.clear();
  }

  private async startSSE(): Promise<void> {
    try {
      const response = await fetch(`${this.baseUrl}/sse`, {
        signal: this.abortController!.signal,
        headers: { Accept: "text/event-stream" },
      });

      if (!response.ok || !response.body) {
        throw new Error(`SSE connection failed: ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        let eventType = "";
        let eventData = "";

        for (const line of lines) {
          if (line.startsWith("event: ")) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            eventData = line.slice(6).trim();
          } else if (line === "" && eventData) {
            // End of event
            this.handleSSEEvent(eventType, eventData);
            eventType = "";
            eventData = "";
          }
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") return;
      // SSE stream ended or errored
      for (const [, pending] of this.pending) {
        pending.reject(new Error("MCP SSE stream ended"));
      }
      this.pending.clear();
    }
  }

  private handleSSEEvent(type: string, data: string): void {
    if (type === "endpoint") {
      // Server sends the session endpoint URL
      this.sessionId = data;
      return;
    }

    if (type === "message") {
      try {
        const message = JSON.parse(data) as JsonRpcResponse;
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
      } catch {
        // Malformed JSON
      }
    }
  }

  private getEndpoint(): string {
    if (this.sessionId?.startsWith("http")) return this.sessionId;
    return `${this.baseUrl}${this.sessionId ?? "/message"}`;
  }

  private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const message: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP SSE request timeout: ${method}`));
      }, 10_000);

      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timeout); resolve(value); },
        reject: (err) => { clearTimeout(timeout); reject(err); },
      });

      fetch(this.getEndpoint(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(message),
        signal: this.abortController?.signal,
      }).catch(err => {
        this.pending.delete(id);
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    fetch(this.getEndpoint(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method, params }),
      signal: this.abortController?.signal,
    }).catch(() => {});
  }
}

/**
 * MCP WebSocket Client — connects to an MCP server via WebSocket transport.
 *
 * Bidirectional JSON-RPC 2.0 messages over a single WebSocket connection.
 * Detected when the server URL starts with ws:// or wss://.
 */
export class MCPWebSocketClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private serverInfo: MCPInitializeResult | null = null;
  private _tools: MCPToolInfo[] = [];
  private _connected = false;

  constructor(
    readonly name: string,
    private config: MCPServerConfig
  ) {}

  get tools(): MCPToolInfo[] {
    return this._tools;
  }

  get isConnected(): boolean {
    return this._connected && this.ws !== null;
  }

  async connect(): Promise<void> {
    const url = this.config.url;
    if (!url) throw new Error("MCP WebSocket client requires 'url' in config");

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("WebSocket connection timeout"));
      }, 10_000);

      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        clearTimeout(timeout);
        this._connected = true;
        resolve();
      };

      this.ws.onerror = (event: Event) => {
        clearTimeout(timeout);
        reject(new Error("WebSocket connection failed"));
      };

      this.ws.onmessage = (event: MessageEvent) => {
        this.handleMessage(event.data as string);
      };

      this.ws.onclose = () => {
        this._connected = false;
        // Reject all pending requests on close
        for (const [, pending] of this.pending) {
          pending.reject(new Error("MCP WebSocket connection closed"));
        }
        this.pending.clear();
      };
    });

    // Initialize
    this.serverInfo = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "ashlrcode", version: "2.0.0" },
    }) as MCPInitializeResult;

    // Send initialized notification
    this.notify("notifications/initialized", {});

    // List tools
    const result = await this.request("tools/list", {}) as { tools: MCPToolInfo[] };
    this._tools = result.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<MCPToolResult> {
    const result = await this.request("tools/call", { name, arguments: args });
    return result as MCPToolResult;
  }

  async disconnect(): Promise<void> {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // WebSocket may already be closed
      }
      this.ws = null;
      this._connected = false;
    }
    for (const [, pending] of this.pending) {
      pending.reject(new Error("MCP WebSocket client disconnected"));
    }
    this.pending.clear();
  }

  private handleMessage(data: string): void {
    try {
      const message = JSON.parse(data) as JsonRpcResponse;
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

  private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const message: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP WebSocket request timeout: ${method}`));
      }, 10_000);

      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timeout); resolve(value); },
        reject: (err) => { clearTimeout(timeout); reject(err); },
      });

      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        this.pending.delete(id);
        clearTimeout(timeout);
        reject(new Error("MCP WebSocket not connected"));
        return;
      }

      this.ws.send(JSON.stringify(message));
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
    }
  }
}

/** Factory: create the right client based on config */
export function createMCPClient(name: string, config: MCPServerConfig): MCPClient | MCPSSEClient | MCPWebSocketClient {
  if (config.url) {
    const url = config.url.toLowerCase();
    if (url.startsWith("ws://") || url.startsWith("wss://")) {
      return new MCPWebSocketClient(name, config);
    }
    return new MCPSSEClient(name, config);
  }
  return new MCPClient(name, config);
}
