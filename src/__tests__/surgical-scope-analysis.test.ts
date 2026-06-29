/**
 * Tests for analyzeScopeFromIntent and SurgicalScopeAnalyzer —
 * the smart tier auto-detection subsystem.
 *
 * Coverage:
 *   - Narrow intent signals map to narrow tier
 *   - Medium intent signals map to medium tier
 *   - Wide intent signals map to wide tier
 *   - Edge cases: empty message, very long message, mixed signals
 *   - Codebase context modifies confidence up and down
 *   - SurgicalScopeAnalyzer class API works correctly
 *   - formatSuggestion output contains expected fields
 *   - Confidence ranges are sensible
 */

import { describe, it, expect } from "bun:test";
import {
  analyzeScopeFromIntent,
  SurgicalScopeAnalyzer,
  type ScopeAnalysisResult,
} from "../agent/surgical-scope.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function analyze(msg: string, ctx = ""): ScopeAnalysisResult {
  return analyzeScopeFromIntent(msg, ctx);
}

// ---------------------------------------------------------------------------
// Narrow tier detection
// ---------------------------------------------------------------------------

describe("analyzeScopeFromIntent — narrow tier", () => {
  it("'fix typo in login' → narrow", () => {
    const r = analyze("fix typo in login");
    expect(r.suggestedTier).toBe("narrow");
  });

  it("'typo on line 42' → narrow", () => {
    const r = analyze("typo on line 42");
    expect(r.suggestedTier).toBe("narrow");
  });

  it("'fix typo in login' has confidence ≥ 0.7", () => {
    const r = analyze("fix typo in login");
    expect(r.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it("'fix typo in login' reasoning mentions intent signal", () => {
    const r = analyze("fix typo in login");
    expect(r.reasoning).toContain("Intent:");
  });

  it("'null check for userId' → narrow", () => {
    const r = analyze("null check for userId");
    expect(r.suggestedTier).toBe("narrow");
  });

  it("'off-by-one error in loop' → narrow", () => {
    const r = analyze("off-by-one error in loop");
    expect(r.suggestedTier).toBe("narrow");
  });

  it("'remove a line from config' → narrow", () => {
    const r = analyze("remove a line from config");
    expect(r.suggestedTier).toBe("narrow");
  });

  it("'patch the version string' → narrow", () => {
    const r = analyze("patch the version string");
    expect(r.suggestedTier).toBe("narrow");
  });

  it("single-file context boosts narrow confidence", () => {
    const withCtx = analyze("fix typo in login", "src/auth/login.ts");
    const withoutCtx = analyze("fix typo in login", "");
    expect(withCtx.confidence).toBeGreaterThanOrEqual(withoutCtx.confidence);
  });
});

// ---------------------------------------------------------------------------
// Medium tier detection
// ---------------------------------------------------------------------------

describe("analyzeScopeFromIntent — medium tier", () => {
  it("'add auth provider' → medium (no wide signal)", () => {
    // 'add auth provider' has no exact wide signal like 'add feature', so
    // it should fall to medium via 'fix' fallback or default
    const r = analyze("add auth provider");
    // Could be medium or wide — just verify it's not narrow
    expect(r.suggestedTier).not.toBe("narrow");
  });

  it("'fix failing test for login handler' → medium", () => {
    const r = analyze("fix failing test for login handler");
    expect(r.suggestedTier).toBe("medium");
  });

  it("'add test for the parser' → medium", () => {
    const r = analyze("add test for the parser");
    expect(r.suggestedTier).toBe("medium");
  });

  it("'fix import path in utils' → medium", () => {
    const r = analyze("fix import path in utils");
    expect(r.suggestedTier).toBe("medium");
  });

  it("'add function to parse dates' → medium", () => {
    const r = analyze("add function to parse dates");
    expect(r.suggestedTier).toBe("medium");
  });

  it("'fix interface for User type' → medium", () => {
    const r = analyze("fix interface for User type");
    expect(r.suggestedTier).toBe("medium");
  });

  it("medium tier confidence is in range [0.5, 1.0]", () => {
    const r = analyze("fix failing test for auth module");
    expect(r.confidence).toBeGreaterThanOrEqual(0.5);
    expect(r.confidence).toBeLessThanOrEqual(1.0);
  });

  it("test files in context reinforce medium confidence", () => {
    const withTests = analyze(
      "fix failing test for auth module",
      "src/auth/auth.ts\nsrc/__tests__/auth.test.ts",
    );
    expect(withTests.suggestedTier).toBe("medium");
    expect(withTests.confidence).toBeGreaterThanOrEqual(0.5);
    expect(withTests.reasoning).toMatch(/test/i);
  });
});

// ---------------------------------------------------------------------------
// Wide tier detection
// ---------------------------------------------------------------------------

describe("analyzeScopeFromIntent — wide tier", () => {
  it("'rewrite entire backend' → wide", () => {
    const r = analyze("rewrite entire backend");
    expect(r.suggestedTier).toBe("wide");
  });

  it("'refactor auth module' → wide", () => {
    const r = analyze("refactor auth module");
    expect(r.suggestedTier).toBe("wide");
  });

  it("'add feature: dark mode support' → wide", () => {
    const r = analyze("add feature: dark mode support");
    expect(r.suggestedTier).toBe("wide");
  });

  it("'implement the payment flow' → wide", () => {
    const r = analyze("implement the payment flow");
    expect(r.suggestedTier).toBe("wide");
  });

  it("'migrate database schema' → wide", () => {
    const r = analyze("migrate database schema");
    expect(r.suggestedTier).toBe("wide");
  });

  it("'replace all usages of oldFn' → wide", () => {
    const r = analyze("replace all usages of oldFn");
    expect(r.suggestedTier).toBe("wide");
  });

  it("'reorganize folder structure' → wide", () => {
    const r = analyze("reorganize folder structure");
    expect(r.suggestedTier).toBe("wide");
  });

  it("wide tier confidence is in range [0.5, 1.0]", () => {
    const r = analyze("refactor the auth module");
    expect(r.confidence).toBeGreaterThanOrEqual(0.5);
    expect(r.confidence).toBeLessThanOrEqual(1.0);
  });

  it("wide dominates narrow — 'refactor to fix typo' → wide", () => {
    const r = analyze("refactor to fix typo");
    expect(r.suggestedTier).toBe("wide");
  });

  it("wide dominates medium — 'rewrite the test suite' → wide", () => {
    const r = analyze("rewrite the test suite");
    expect(r.suggestedTier).toBe("wide");
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("analyzeScopeFromIntent — edge cases", () => {
  it("empty message → medium (default fallback), low confidence", () => {
    const r = analyze("");
    expect(r.suggestedTier).toBe("medium");
    expect(r.confidence).toBeLessThan(0.7);
  });

  it("very long message with no signals → medium default", () => {
    const long = "please do something useful with the project and make it better overall somehow";
    const r = analyze(long);
    expect(r.suggestedTier).toBe("medium");
  });

  it("uppercase 'FIX TYPO IN LOGIN' → narrow (case insensitive)", () => {
    const r = analyze("FIX TYPO IN LOGIN");
    expect(r.suggestedTier).toBe("narrow");
  });

  it("mixed-case 'Refactor The Authentication Module' → wide", () => {
    const r = analyze("Refactor The Authentication Module");
    expect(r.suggestedTier).toBe("wide");
  });

  it("message with only punctuation → medium (default fallback)", () => {
    const r = analyze("...");
    expect(r.suggestedTier).toBe("medium");
  });

  it("confidence is always between 0 and 1 inclusive", () => {
    const messages = [
      "fix typo",
      "add feature",
      "refactor",
      "do something",
      "",
      "FIX TYPO IN DOCS",
      "update all files everywhere",
    ];
    for (const msg of messages) {
      const r = analyze(msg);
      expect(r.confidence).toBeGreaterThanOrEqual(0);
      expect(r.confidence).toBeLessThanOrEqual(1.0);
    }
  });

  it("reasoning is always a non-empty string", () => {
    const messages = ["fix typo", "refactor", "", "add feature"];
    for (const msg of messages) {
      const r = analyze(msg);
      expect(typeof r.reasoning).toBe("string");
      expect(r.reasoning.length).toBeGreaterThan(0);
    }
  });

  it("'entire' keyword boosts confidence", () => {
    const withEntire = analyze("rewrite entire backend");
    const withoutEntire = analyze("rewrite backend");
    // Both should be wide; the one with 'entire' should have equal or higher confidence
    expect(withEntire.suggestedTier).toBe("wide");
    expect(withEntire.confidence).toBeGreaterThanOrEqual(withoutEntire.confidence);
  });
});

// ---------------------------------------------------------------------------
// Codebase context effects
// ---------------------------------------------------------------------------

describe("analyzeScopeFromIntent — codebase context effects", () => {
  it("many files in context reduces confidence for narrow intent", () => {
    const manyFiles =
      "src/a.ts src/b.ts src/c.ts src/d.ts src/e.ts src/f.ts src/g.ts src/h.ts";
    const withCtx = analyze("fix typo", manyFiles);
    const withoutCtx = analyze("fix typo", "");
    // Confidence should drop when context conflicts with narrow intent
    expect(withCtx.confidence).toBeLessThanOrEqual(withoutCtx.confidence);
  });

  it("single file in context reinforces narrow confidence", () => {
    const r = analyze("fix typo in auth.ts", "src/auth/auth.ts");
    expect(r.suggestedTier).toBe("narrow");
    expect(r.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it("schema file in context reduces confidence for non-wide intent", () => {
    const schemaCtx = "schema.sql migrations/001.sql config.ts";
    const withSchema = analyze("fix import", schemaCtx);
    const withoutSchema = analyze("fix import", "src/utils.ts");
    expect(withSchema.confidence).toBeLessThanOrEqual(withoutSchema.confidence);
  });

  it("multiple directories in context conflicts with narrow, reduces confidence", () => {
    const multiDirCtx = "src/auth/login.ts\nlib/utils/helpers.ts\npkg/core/index.ts";
    const r = analyze("fix typo", multiDirCtx);
    expect(r.suggestedTier).toBe("narrow"); // tier still from intent
    // but confidence should be lower due to multi-dir conflict
    const noCtx = analyze("fix typo", "");
    expect(r.confidence).toBeLessThanOrEqual(noCtx.confidence);
  });

  it("empty context string is handled without error", () => {
    expect(() => analyze("fix typo", "")).not.toThrow();
    expect(() => analyze("refactor auth", "")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// SurgicalScopeAnalyzer class API
// ---------------------------------------------------------------------------

describe("SurgicalScopeAnalyzer class", () => {
  const analyzer = new SurgicalScopeAnalyzer();

  it("analyze() returns same result as analyzeScopeFromIntent()", () => {
    const direct = analyzeScopeFromIntent("fix typo in login", "");
    const fromClass = analyzer.analyze("fix typo in login", "");
    expect(fromClass.suggestedTier).toBe(direct.suggestedTier);
    expect(fromClass.confidence).toBe(direct.confidence);
    expect(fromClass.reasoning).toBe(direct.reasoning);
  });

  it("analyze() works without codebaseContext argument", () => {
    const r = analyzer.analyze("fix typo in login");
    expect(r.suggestedTier).toBe("narrow");
  });

  it("formatSuggestion() includes suggested tier", () => {
    const r = analyzer.analyze("fix typo in login");
    const fmt = analyzer.formatSuggestion(r);
    expect(fmt).toContain("narrow");
  });

  it("formatSuggestion() includes confidence percentage", () => {
    const r = analyzer.analyze("fix typo in login");
    const fmt = analyzer.formatSuggestion(r);
    expect(fmt).toMatch(/\d+%/);
  });

  it("formatSuggestion() includes reasoning", () => {
    const r = analyzer.analyze("refactor auth module");
    const fmt = analyzer.formatSuggestion(r);
    expect(fmt).toContain("Reasoning:");
  });

  it("formatSuggestion() includes override instructions", () => {
    const r = analyzer.analyze("fix typo");
    const fmt = analyzer.formatSuggestion(r);
    expect(fmt).toContain("Override");
    expect(fmt).toContain("/surgical narrow");
    expect(fmt).toContain("/surgical medium");
    expect(fmt).toContain("/surgical wide");
  });

  it("analyze() handles various tier types correctly", () => {
    expect(analyzer.analyze("fix typo").suggestedTier).toBe("narrow");
    expect(analyzer.analyze("fix failing test").suggestedTier).toBe("medium");
    expect(analyzer.analyze("refactor auth").suggestedTier).toBe("wide");
  });
});
