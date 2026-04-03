/**
 * LSP Tool — Language Server Protocol integration.
 *
 * Provides go-to-definition, find-references, and hover info by
 * communicating with language servers (TypeScript, Python, etc.)
 */

import { resolve } from "path";
import { readFile } from "fs/promises";
import type { Tool, ToolContext } from "./types.ts";

// LSP server configs per language
interface LSPServerConfig {
  command: string[];
  initOptions?: Record<string, unknown>;
}

const SERVER_CONFIGS: Record<string, LSPServerConfig> = {
  typescript: { command: ["npx", "typescript-language-server", "--stdio"] },
  javascript: { command: ["npx", "typescript-language-server", "--stdio"] },
  python: { command: ["pylsp"] },
  rust: { command: ["rust-analyzer"] },
  go: { command: ["gopls", "serve"] },
};

// Detect language from file extension
function detectLanguage(filePath: string): string | null {
  const ext = filePath.split(".").pop()?.toLowerCase();
  const langMap: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    py: "python",
    rs: "rust",
    go: "go",
  };
  return langMap[ext ?? ""] ?? null;
}

/**
 * Simple LSP client — sends requests via JSON-RPC over stdio.
 * This is a lightweight implementation for basic operations.
 */
class SimpleLSPClient {
  // Use `any` for the subprocess — Bun's Subprocess type has complex
  // conditional generics that don't resolve cleanly for stdin/stdout.
  private proc: any = null;
  private requestId = 0;
  private pendingRequests = new Map<
    number,
    { resolve: (r: unknown) => void; reject: (e: Error) => void }
  >();
  private buffer = "";

  async start(config: LSPServerConfig, cwd: string): Promise<void> {
    this.proc = Bun.spawn(config.command, {
      cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    // Read responses in background
    this.readLoop();

    // Initialize the language server
    await this.request("initialize", {
      processId: process.pid,
      rootUri: `file://${cwd}`,
      capabilities: {},
      ...config.initOptions,
    });

    this.notify("initialized", {});
  }

  private async readLoop(): Promise<void> {
    if (!this.proc) return;
    const reader = this.proc.stdout.getReader();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this.buffer += Buffer.from(value).toString("utf-8");
        this.processBuffer();
      }
    } catch {
      // Stream closed — expected on shutdown
    }
  }

  private processBuffer(): void {
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;

      const header = this.buffer.slice(0, headerEnd);
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(match[1]!, 10);
      const bodyStart = headerEnd + 4;

      if (this.buffer.length < bodyStart + contentLength) break;

      const body = this.buffer.slice(bodyStart, bodyStart + contentLength);
      this.buffer = this.buffer.slice(bodyStart + contentLength);

      try {
        const msg = JSON.parse(body) as {
          id?: number;
          error?: { message: string };
          result?: unknown;
        };
        if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
          const pending = this.pendingRequests.get(msg.id)!;
          this.pendingRequests.delete(msg.id);
          if (msg.error) pending.reject(new Error(msg.error.message));
          else pending.resolve(msg.result);
        }
      } catch {
        // Malformed JSON — skip
      }
    }
  }

  async request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });

      // Timeout after 10s
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`LSP request timed out: ${method}`));
        }
      }, 10_000);
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private send(msg: Record<string, unknown>): void {
    if (!this.proc) return;
    const json = JSON.stringify(msg);
    const header = `Content-Length: ${Buffer.byteLength(json, "utf-8")}\r\n\r\n`;
    const buf = Buffer.concat([Buffer.from(header), Buffer.from(json, "utf-8")]);
    this.proc.stdin.write(buf);
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    // Reject all pending requests before shutting down
    for (const [id, pending] of this.pendingRequests) {
      pending.reject(new Error("LSP client stopped"));
    }
    this.pendingRequests.clear();
    try {
      await this.request("shutdown", null);
      this.notify("exit", null);
      this.proc.stdin.end();
    } catch {
      // Best-effort shutdown
    }
    try { this.proc.kill(); } catch {}
    this.proc = null;
  }
}

// Cache active LSP clients by language:cwd
const clients = new Map<string, SimpleLSPClient>();
const inFlight = new Map<string, Promise<SimpleLSPClient>>();

async function getClient(
  language: string,
  cwd: string,
): Promise<SimpleLSPClient> {
  const key = `${language}:${cwd}`;
  if (clients.has(key)) return clients.get(key)!;
  if (inFlight.has(key)) return inFlight.get(key)!;

  const config = SERVER_CONFIGS[language];
  if (!config) throw new Error(`No LSP server configured for ${language}`);

  const p = (async () => {
    const client = new SimpleLSPClient();
    await client.start(config, cwd);
    clients.set(key, client);
    inFlight.delete(key);
    return client;
  })();
  inFlight.set(key, p);
  return p;
}

// LSP location result shapes
interface LSPLocation {
  uri?: string;
  targetUri?: string;
  range?: { start?: { line?: number } };
  targetRange?: { start?: { line?: number } };
}

interface LSPHoverResult {
  contents?:
    | string
    | { value?: string }
    | Array<string | { value?: string }>;
}

function formatLocations(result: unknown): string {
  if (!result) return "No results found";
  const locations = (
    Array.isArray(result) ? result : [result]
  ) as LSPLocation[];
  return locations
    .map((loc) => {
      const path =
        (loc.uri ?? loc.targetUri)?.replace("file://", "") ?? "unknown";
      const range = loc.range ?? loc.targetRange;
      const line = (range?.start?.line ?? 0) + 1;
      return `${path}:${line}`;
    })
    .join("\n");
}

function formatHover(result: unknown): string {
  const hover = result as LSPHoverResult | null;
  if (!hover?.contents) return "No hover info available";
  const contents = hover.contents;
  if (typeof contents === "string") return contents;
  if ("value" in contents && contents.value) return contents.value;
  if (Array.isArray(contents))
    return contents
      .map((c) => (typeof c === "string" ? c : c.value ?? ""))
      .join("\n");
  return JSON.stringify(contents);
}

export const lspTool: Tool = {
  name: "LSP",

  prompt() {
    return `Language Server Protocol integration. Use for:
- go-to-definition: Find where a symbol is defined
- find-references: Find all usages of a symbol
- hover: Get type info and documentation for a symbol

Supported languages: TypeScript, JavaScript, Python, Rust, Go.
Requires the language server to be installed (e.g., typescript-language-server for TS).`;
  },

  inputSchema() {
    return {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["definition", "references", "hover"],
          description: "LSP operation to perform",
        },
        file: {
          type: "string",
          description: "File path containing the symbol",
        },
        line: {
          type: "number",
          description: "Line number (1-indexed)",
        },
        column: {
          type: "number",
          description: "Column number (1-indexed)",
        },
      },
      required: ["action", "file", "line", "column"],
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
    if (!input.action) return "action is required";
    if (!["definition", "references", "hover"].includes(input.action as string))
      return "action must be one of: definition, references, hover";
    if (!input.file) return "file is required";
    if (!input.line || !input.column) return "line and column are required";
    return null;
  },

  async call(input, context) {
    const file = input.file as string;
    const line = (input.line as number) - 1; // LSP uses 0-indexed positions
    const column = (input.column as number) - 1;
    const action = input.action as string;

    const fullPath = resolve(context.cwd, file);
    const language = detectLanguage(fullPath);
    if (!language)
      return `Unsupported file type: ${file}. Supported: .ts, .tsx, .js, .jsx, .py, .rs, .go`;

    try {
      const client = await getClient(language, context.cwd);
      const uri = `file://${fullPath}`;
      const position = { line, character: column };

      // Open the document so the server knows about it
      const content = await readFile(fullPath, "utf-8");
      client.notify("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId: language,
          version: 1,
          text: content,
        },
      });

      switch (action) {
        case "definition": {
          const result = await client.request("textDocument/definition", {
            textDocument: { uri },
            position,
          });
          return formatLocations(result);
        }

        case "references": {
          const result = await client.request("textDocument/references", {
            textDocument: { uri },
            position,
            context: { includeDeclaration: true },
          });
          return formatLocations(result);
        }

        case "hover": {
          const result = await client.request("textDocument/hover", {
            textDocument: { uri },
            position,
          });
          return formatHover(result);
        }

        default:
          return `Unknown action: ${action}`;
      }
    } catch (err) {
      return `LSP error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

/** Shut down all cached LSP clients. Call on process exit. */
export async function shutdownLSP(): Promise<void> {
  for (const client of clients.values()) {
    await client.stop().catch(() => {});
  }
  clients.clear();
}
