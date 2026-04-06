import { test, expect, describe } from "bun:test";
import { validateSkill, validateSkillFile } from "../skills/validator.ts";

describe("validateSkill", () => {
  test("passes for valid skill with all fields", () => {
    const result = validateSkill({
      name: "my-skill",
      description: "A useful skill",
      trigger: "/my-skill",
      prompt: "Do the thing. Use {{args}} for context.",
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  test("errors on missing name", () => {
    const result = validateSkill({
      trigger: "/test",
      prompt: "Do something",
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("name"))).toBe(true);
  });

  test("errors on invalid name format (uppercase)", () => {
    const result = validateSkill({
      name: "MySkill",
      trigger: "/my-skill",
      prompt: "Do something",
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("lowercase"))).toBe(true);
  });

  test("errors on invalid name format (spaces)", () => {
    const result = validateSkill({
      name: "my skill",
      trigger: "/my-skill",
      prompt: "Do something",
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("lowercase"))).toBe(true);
  });

  test("errors on trigger without /", () => {
    const result = validateSkill({
      name: "test",
      trigger: "test",
      prompt: "Do something",
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("start with /"))).toBe(true);
  });

  test("errors on missing prompt", () => {
    const result = validateSkill({
      name: "test",
      trigger: "/test",
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("prompt"))).toBe(true);
  });

  test("warns on trigger conflict", () => {
    const existing = new Set(["/deploy"]);
    const result = validateSkill(
      {
        name: "deploy",
        trigger: "/deploy",
        prompt: "Deploy it",
        description: "Deploy",
      },
      existing,
    );
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes("conflicts"))).toBe(true);
  });

  test("warns on unknown template variables", () => {
    const result = validateSkill({
      name: "test",
      description: "Test",
      trigger: "/test",
      prompt: "Hello {{name}}, welcome to {{place}}. Use {{args}} for more.",
    });
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes("unknown template variables"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("{{name}}"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("{{place}}"))).toBe(true);
  });

  test("errors on oversized prompt (>50K)", () => {
    const result = validateSkill({
      name: "big",
      description: "Big skill",
      trigger: "/big",
      prompt: "x".repeat(50_001),
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("too large"))).toBe(true);
  });

  test("warns on large prompt (>10K)", () => {
    const result = validateSkill({
      name: "large",
      description: "Large skill",
      trigger: "/large",
      prompt: "x".repeat(10_001),
    });
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes("large"))).toBe(true);
  });

  test("warns on missing description", () => {
    const result = validateSkill({
      name: "test",
      trigger: "/test",
      prompt: "Do it",
    });
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes("description"))).toBe(true);
  });
});

describe("validateSkillFile", () => {
  test("errors on missing frontmatter", () => {
    const result = validateSkillFile("Just some markdown content");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("frontmatter"))).toBe(true);
  });

  test("errors on unclosed frontmatter", () => {
    const result = validateSkillFile("---\nname: test\ntrigger: /test\n");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("not closed"))).toBe(true);
  });

  test("errors on missing name field", () => {
    const result = validateSkillFile("---\ntrigger: /test\ndescription: Test\n---\nDo the thing.");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("name"))).toBe(true);
  });

  test("errors on missing trigger field", () => {
    const result = validateSkillFile("---\nname: test\ndescription: Test\n---\nDo the thing.");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("trigger"))).toBe(true);
  });

  test("warns on missing description", () => {
    const result = validateSkillFile("---\nname: test\ntrigger: /test\n---\nDo the thing.");
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes("description"))).toBe(true);
  });

  test("passes valid file with all fields", () => {
    const content = "---\nname: deploy\ntrigger: /deploy\ndescription: Deploy to production\n---\nRun the deploy pipeline.";
    const result = validateSkillFile(content);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});
