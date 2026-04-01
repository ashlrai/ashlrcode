/**
 * WebFetch tool — HTTP requests for research and exploration.
 */

import type { Tool, ToolContext } from "./types.ts";

const MAX_RESPONSE_SIZE = 50_000; // chars

export const webFetchTool: Tool = {
  name: "WebFetch",

  prompt() {
    return "Fetch a URL and return its content. Useful for reading documentation, APIs, or web pages. Returns text content, truncated if too large.";
  },

  inputSchema() {
    return {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The URL to fetch",
        },
        method: {
          type: "string",
          enum: ["GET", "POST", "PUT", "DELETE"],
          description: "HTTP method (default: GET)",
        },
        headers: {
          type: "object",
          description: "Additional HTTP headers",
        },
        body: {
          type: "string",
          description: "Request body (for POST/PUT)",
        },
      },
      required: ["url"],
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
    if (!input.url || typeof input.url !== "string") {
      return "url is required";
    }
    try {
      new URL(input.url as string);
    } catch {
      return "Invalid URL";
    }
    return null;
  },

  async call(input, _context) {
    const url = input.url as string;
    const method = (input.method as string) ?? "GET";
    const headers = (input.headers as Record<string, string>) ?? {};
    const body = input.body as string | undefined;

    try {
      const response = await fetch(url, {
        method,
        headers: {
          "User-Agent": "AshlrCode/0.1.0",
          ...headers,
        },
        body: method !== "GET" ? body : undefined,
        signal: AbortSignal.timeout(30_000),
      });

      const contentType = response.headers.get("content-type") ?? "";
      const status = response.status;

      let text = await response.text();

      // Truncate if too large
      if (text.length > MAX_RESPONSE_SIZE) {
        text =
          text.slice(0, MAX_RESPONSE_SIZE) +
          `\n\n[... truncated at ${MAX_RESPONSE_SIZE} chars, total: ${text.length} chars]`;
      }

      // Strip HTML tags for readability if it's HTML
      if (contentType.includes("text/html")) {
        text = stripHtml(text);
      }

      return `HTTP ${status} ${response.statusText}\nContent-Type: ${contentType}\n\n${text}`;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `Fetch error: ${message}`;
    }
  },
};

function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .trim();
}
