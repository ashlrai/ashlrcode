import { describe, test, expect } from "bun:test";
import {
  generateAwaySummary,
  formatAwaySummaryForNotification,
  formatAwaySummaryForTerminal,
} from "../agent/away-summary.ts";
import type { Message } from "../providers/types.ts";

describe("Away Summary", () => {
  describe("generateAwaySummary", () => {
    test("returns idle for empty messages", () => {
      const summary = generateAwaySummary([]);
      expect(summary.status).toBe("idle");
      expect(summary.toolCalls).toBe(0);
      expect(summary.filesModified).toHaveLength(0);
    });

    test("extracts tool calls from content blocks", () => {
      const messages: Message[] = [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "1", name: "Read", input: { file_path: "/src/a.ts" } },
            { type: "tool_use", id: "2", name: "Edit", input: { file_path: "/src/b.ts" } },
          ],
        },
      ];
      const summary = generateAwaySummary(messages);
      expect(summary.toolCalls).toBe(2);
      expect(summary.filesModified).toContain("/src/b.ts");
      expect(summary.status).toBe("working");
    });

    test("tracks file modifications for write tools only", () => {
      const messages: Message[] = [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "1", name: "Read", input: { file_path: "/src/read.ts" } },
            { type: "tool_use", id: "2", name: "Write", input: { file_path: "/src/written.ts" } },
            { type: "tool_use", id: "3", name: "Edit", input: { file_path: "/src/edited.ts" } },
          ],
        },
      ];
      const summary = generateAwaySummary(messages);
      expect(summary.filesModified).toContain("/src/written.ts");
      expect(summary.filesModified).toContain("/src/edited.ts");
      expect(summary.filesModified).not.toContain("/src/read.ts");
    });

    test("detects commit actions", () => {
      const messages: Message[] = [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "1", name: "Bash", input: { command: "git commit -m 'fix'" } },
          ],
        },
      ];
      const summary = generateAwaySummary(messages);
      expect(summary.keyActions).toContain("Committed changes");
      expect(summary.status).toBe("complete");
    });

    test("detects test runs", () => {
      const messages: Message[] = [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "1", name: "Bash", input: { command: "bun test" } },
          ],
        },
      ];
      const summary = generateAwaySummary(messages);
      expect(summary.keyActions).toContain("Ran tests");
    });

    test("detects failures", () => {
      const messages: Message[] = [
        {
          role: "assistant",
          content: [{ type: "text", text: "Verification failed — 2 errors found" }],
        },
      ];
      const summary = generateAwaySummary(messages);
      expect(summary.status).toBe("blocked");
    });
  });

  describe("formatAwaySummaryForNotification", () => {
    test("formats working summary", () => {
      const text = formatAwaySummaryForNotification({
        duration: "5m",
        toolCalls: 12,
        filesModified: ["/a.ts", "/b.ts"],
        keyActions: ["Ran tests"],
        status: "working",
      });
      expect(text).toContain("working");
      expect(text).toContain("12 tool calls");
      expect(text).toContain("2 files modified");
    });

    test("formats idle summary", () => {
      const text = formatAwaySummaryForNotification({
        duration: "2m",
        toolCalls: 0,
        filesModified: [],
        keyActions: [],
        status: "idle",
      });
      expect(text).toContain("idle");
    });
  });

  describe("formatAwaySummaryForTerminal", () => {
    test("includes file list", () => {
      const text = formatAwaySummaryForTerminal({
        duration: "3m",
        toolCalls: 5,
        filesModified: ["/a.ts", "/b.ts"],
        keyActions: ["Committed changes"],
        status: "complete",
      });
      expect(text).toContain("/a.ts");
      expect(text).toContain("/b.ts");
      expect(text).toContain("Committed changes");
    });

    test("truncates long file lists", () => {
      const files = Array.from({ length: 8 }, (_, i) => `/file${i}.ts`);
      const text = formatAwaySummaryForTerminal({
        duration: "10m",
        toolCalls: 20,
        filesModified: files,
        keyActions: [],
        status: "working",
      });
      expect(text).toContain("and 3 more");
    });
  });
});
