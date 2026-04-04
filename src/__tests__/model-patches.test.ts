import { test, expect, describe } from "bun:test";
import { getModelPatches, listPatches } from "../agent/model-patches.ts";

describe("Model Patches", () => {
  describe("getModelPatches", () => {
    test("matches grok models (not grok-4-1-fast)", () => {
      const result = getModelPatches("grok-4");
      expect(result.names).toContain("Grok verbosity control");
      expect(result.names).not.toContain("Grok fast mode");
      expect(result.combinedSuffix).toContain("Be concise");
    });

    test("matches grok-4-1-fast specifically", () => {
      const result = getModelPatches("grok-4-1-fast");
      expect(result.names).toContain("Grok fast mode");
      // The generic grok pattern uses negative lookahead to exclude grok-4-1-fast
      expect(result.names).not.toContain("Grok verbosity control");
      expect(result.combinedSuffix).toContain("fast mode");
    });

    test("matches claude sonnet", () => {
      const result = getModelPatches("claude-3.5-sonnet");
      expect(result.names).toContain("Sonnet conciseness");
      expect(result.combinedSuffix).toContain("concise");
    });

    test("matches claude opus", () => {
      const result = getModelPatches("claude-opus-4");
      expect(result.names).toContain("Opus thoroughness");
      expect(result.combinedSuffix).toContain("thorough");
    });

    test("returns empty for unknown model", () => {
      const result = getModelPatches("some-random-model-v1");
      expect(result.names).toEqual([]);
      expect(result.combinedSuffix).toBe("");
    });

    test("anchored patterns don't match substrings incorrectly", () => {
      // "grok" pattern is anchored with ^, so "my-grok" shouldn't match
      const result = getModelPatches("my-grok-variant");
      expect(result.names).not.toContain("Grok verbosity control");
      expect(result.names).not.toContain("Grok fast mode");

      // "claude" pattern is anchored with ^, so "not-claude-sonnet" shouldn't match
      const result2 = getModelPatches("not-claude-sonnet");
      expect(result2.names).not.toContain("Sonnet conciseness");

      // "deepseek" anchored
      const result3 = getModelPatches("my-deepseek");
      expect(result3.names).not.toContain("DeepSeek format control");
    });

    test("matches case-insensitively", () => {
      const result = getModelPatches("Claude-3.5-Sonnet");
      expect(result.names).toContain("Sonnet conciseness");
    });
  });

  describe("listPatches", () => {
    test("returns all patches", () => {
      const patches = listPatches();
      expect(patches.length).toBeGreaterThanOrEqual(12);

      const names = patches.map((p) => p.name);
      expect(names).toContain("Grok verbosity control");
      expect(names).toContain("Grok fast mode");
      expect(names).toContain("Sonnet conciseness");
      expect(names).toContain("Opus thoroughness");
      expect(names).toContain("OpenAI reasoning");
      expect(names).toContain("DeepSeek format control");
      expect(names).toContain("Llama 3 optimization");
      expect(names).toContain("CodeLlama specialization");
      expect(names).toContain("Mistral optimization");
      expect(names).toContain("Small model constraints");
    });

    test("returns a copy (not the internal array)", () => {
      const a = listPatches();
      const b = listPatches();
      expect(a).not.toBe(b);
      expect(a).toEqual(b);
    });
  });
});
