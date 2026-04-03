import { test, expect, describe, beforeEach } from "bun:test";
import {
  isUndercoverMode,
  setUndercoverMode,
  maskCodenames,
  sanitizeCommitMessage,
  getUndercoverPrompt,
} from "../config/undercover.ts";

describe("Undercover Mode", () => {
  beforeEach(() => {
    // Reset to disabled before each test
    setUndercoverMode(false);
  });

  describe("maskCodenames", () => {
    test("replaces codenames when enabled", () => {
      setUndercoverMode(true);
      expect(maskCodenames("Running claude model")).toContain("cla***");
      expect(maskCodenames("Using opus for analysis")).toContain("opu*");
      expect(maskCodenames("capybara-v8 is fast")).toContain("cap*****");
      expect(maskCodenames("ashlrcode agent")).toContain("ash******");
    });

    test("is no-op when disabled", () => {
      setUndercoverMode(false);
      const text = "Running claude opus model via ashlrcode";
      expect(maskCodenames(text)).toBe(text);
    });

    test("is case-insensitive", () => {
      setUndercoverMode(true);
      const result = maskCodenames("CLAUDE and Claude and claude");
      expect(result).not.toContain("CLAUDE");
      expect(result).not.toContain("Claude");
      expect(result).not.toContain("claude");
    });
  });

  describe("sanitizeCommitMessage", () => {
    test("strips Co-Authored-By when enabled", () => {
      setUndercoverMode(true);
      const msg = `feat: add feature

Co-Authored-By: Claude <noreply@anthropic.com>`;
      const result = sanitizeCommitMessage(msg);
      expect(result).not.toContain("Co-Authored-By");
      expect(result).toContain("feat: add feature");
    });

    test("is no-op when disabled", () => {
      setUndercoverMode(false);
      const msg = `feat: stuff\n\nCo-Authored-By: Claude <noreply@anthropic.com>`;
      expect(sanitizeCommitMessage(msg)).toBe(msg);
    });

    test("handles multiple Co-Authored-By lines", () => {
      setUndercoverMode(true);
      const msg = `fix: bug

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: GPT <noreply@openai.com>`;
      const result = sanitizeCommitMessage(msg);
      expect(result).not.toContain("Co-Authored-By");
    });
  });

  describe("getUndercoverPrompt", () => {
    test("returns empty string when disabled", () => {
      setUndercoverMode(false);
      expect(getUndercoverPrompt()).toBe("");
    });

    test("returns undercover instructions when enabled", () => {
      setUndercoverMode(true);
      const prompt = getUndercoverPrompt();
      expect(prompt).toContain("UNDERCOVER MODE ACTIVE");
      expect(prompt).toContain("Do NOT reveal");
    });
  });

  describe("toggle", () => {
    test("on/off works correctly", () => {
      expect(isUndercoverMode()).toBe(false);

      setUndercoverMode(true);
      expect(isUndercoverMode()).toBe(true);

      setUndercoverMode(false);
      expect(isUndercoverMode()).toBe(false);
    });
  });
});
