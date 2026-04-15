/**
 * Tests for provider-aware context limit lookup.
 *
 * Added as part of the Phase-A prep refactors that de-risk extracting
 * provider-aware budgeting into @ashlr/core-efficiency.
 */

import { describe, expect, test } from "bun:test";
import { getProviderContextLimit } from "../agent/context.ts";

describe("getProviderContextLimit", () => {
  test("xai → 2M tokens", () => {
    expect(getProviderContextLimit("xai")).toBe(2_000_000);
  });

  test("anthropic → 200K tokens", () => {
    expect(getProviderContextLimit("anthropic")).toBe(200_000);
  });

  test("openai → 128K tokens", () => {
    expect(getProviderContextLimit("openai")).toBe(128_000);
  });

  test("ollama → 32K tokens (conservative default)", () => {
    expect(getProviderContextLimit("ollama")).toBe(32_000);
  });

  test("groq → 128K tokens", () => {
    expect(getProviderContextLimit("groq")).toBe(128_000);
  });

  test("deepseek → 128K tokens", () => {
    expect(getProviderContextLimit("deepseek")).toBe(128_000);
  });

  test("case insensitive — Anthropic, ANTHROPIC", () => {
    expect(getProviderContextLimit("Anthropic")).toBe(200_000);
    expect(getProviderContextLimit("ANTHROPIC")).toBe(200_000);
  });

  test("substring match — 'xai-grok-4' contains 'xai'", () => {
    expect(getProviderContextLimit("xai-grok-4")).toBe(2_000_000);
  });

  test("unknown provider falls back to DEFAULT 100K", () => {
    expect(getProviderContextLimit("made-up-provider")).toBe(100_000);
  });

  test("empty string falls back to DEFAULT 100K", () => {
    expect(getProviderContextLimit("")).toBe(100_000);
  });

  test("returns positive finite number for all inputs", () => {
    for (const input of ["xai", "anthropic", "openai", "ollama", "groq", "deepseek", "??", ""]) {
      const result = getProviderContextLimit(input);
      expect(Number.isFinite(result)).toBe(true);
      expect(result).toBeGreaterThan(0);
    }
  });
});
