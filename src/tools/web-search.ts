/**
 * WebSearch tool — search the web using DuckDuckGo HTML API.
 */

import type { Tool, ToolContext } from "./types.ts";

export const webSearchTool: Tool = {
  name: "WebSearch",

  prompt() {
    return "Search the web and return top results with titles, URLs, and snippets. Uses DuckDuckGo.";
  },

  inputSchema() {
    return {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query",
        },
        maxResults: {
          type: "number",
          description: "Maximum number of results (default: 5)",
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
    const query = input.query as string;
    const maxResults = (input.maxResults as number) ?? 5;

    try {
      // Use DuckDuckGo HTML search (no API key needed)
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const response = await fetch(url, {
        headers: {
          "User-Agent": "AshlrCode/1.0",
        },
        signal: AbortSignal.timeout(15_000),
      });

      const html = await response.text();

      // Extract results from DDG HTML
      const results = extractDDGResults(html, maxResults);

      if (results.length === 0) {
        return `No results found for: "${query}"`;
      }

      return results
        .map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`)
        .join("\n\n");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `Search error: ${message}`;
    }
  },
};

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function extractDDGResults(html: string, max: number): SearchResult[] {
  const results: SearchResult[] = [];

  // Match result blocks in DDG HTML
  const resultRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

  let match;
  while ((match = resultRegex.exec(html)) !== null && results.length < max) {
    const url = decodeURIComponent(
      match[1]!.replace(/.*uddg=/, "").replace(/&.*/, "")
    );
    const title = match[2]!.replace(/<[^>]+>/g, "").trim();
    const snippet = match[3]!.replace(/<[^>]+>/g, "").trim();

    if (title && url) {
      results.push({ title, url, snippet });
    }
  }

  return results;
}
