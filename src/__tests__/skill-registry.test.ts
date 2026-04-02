import { test, expect, describe, beforeEach } from "bun:test";
import { SkillRegistry } from "../skills/registry.ts";
import type { SkillDefinition } from "../skills/types.ts";

function makeSkill(overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    name: overrides.name ?? "commit",
    description: overrides.description ?? "Create a git commit",
    trigger: overrides.trigger ?? "/commit",
    prompt: overrides.prompt ?? "Create a well-crafted git commit.",
  };
}

describe("SkillRegistry", () => {
  let registry: SkillRegistry;

  beforeEach(() => {
    registry = new SkillRegistry();
  });

  describe("register and get", () => {
    test("registers and retrieves a skill by trigger", () => {
      const skill = makeSkill();
      registry.register(skill);
      expect(registry.get("/commit")).toBe(skill);
    });

    test("registers by /name if trigger does not start with /", () => {
      const skill = makeSkill({ name: "deploy", trigger: "deploy-prod" });
      registry.register(skill);
      expect(registry.get("deploy-prod")).toBe(skill);
      expect(registry.get("/deploy")).toBe(skill);
    });

    test("does not double-register if trigger already starts with /", () => {
      const skill = makeSkill({ name: "review", trigger: "/review" });
      registry.register(skill);
      // Only one entry with trigger /review
      expect(registry.get("/review")).toBe(skill);
    });

    test("registerAll registers multiple skills", () => {
      registry.registerAll([
        makeSkill({ name: "a", trigger: "/a" }),
        makeSkill({ name: "b", trigger: "/b" }),
      ]);
      expect(registry.get("/a")).toBeDefined();
      expect(registry.get("/b")).toBeDefined();
    });
  });

  describe("isSkill", () => {
    test("returns true for registered trigger", () => {
      registry.register(makeSkill({ trigger: "/commit" }));
      expect(registry.isSkill("/commit")).toBe(true);
    });

    test("returns true when trigger has trailing args", () => {
      registry.register(makeSkill({ trigger: "/commit" }));
      expect(registry.isSkill("/commit fix typo")).toBe(true);
    });

    test("returns false for unregistered trigger", () => {
      expect(registry.isSkill("/unknown")).toBe(false);
    });
  });

  describe("expand", () => {
    test("returns prompt for valid trigger", () => {
      registry.register(makeSkill({ trigger: "/commit", prompt: "Do a commit." }));
      expect(registry.expand("/commit")).toBe("Do a commit.");
    });

    test("replaces {{args}} with user arguments", () => {
      registry.register(
        makeSkill({
          trigger: "/review",
          prompt: "Review this: {{args}}",
        })
      );
      expect(registry.expand("/review PR #42")).toBe("Review this: PR #42");
    });

    test("appends args as additional context when no template variable", () => {
      registry.register(
        makeSkill({ trigger: "/fix", prompt: "Fix the bug." })
      );
      const result = registry.expand("/fix memory leak");
      expect(result).toContain("Fix the bug.");
      expect(result).toContain("Additional context: memory leak");
    });

    test("returns null for unknown trigger", () => {
      expect(registry.expand("/nope")).toBeNull();
    });

    test("does not append extra context when args are empty", () => {
      registry.register(
        makeSkill({ trigger: "/test", prompt: "Run tests." })
      );
      const result = registry.expand("/test");
      expect(result).toBe("Run tests.");
    });

    test("replaces all occurrences of {{args}}", () => {
      registry.register(
        makeSkill({
          trigger: "/search",
          prompt: "Search for {{args}} and display {{args}} results.",
        })
      );
      const result = registry.expand("/search foo");
      expect(result).toBe("Search for foo and display foo results.");
    });
  });

  describe("getAll", () => {
    test("returns deduplicated skills", () => {
      // A skill with trigger not starting with / gets registered twice
      registry.register(makeSkill({ name: "deploy", trigger: "deploy-prod" }));
      const all = registry.getAll();
      expect(all).toHaveLength(1);
      expect(all[0]!.name).toBe("deploy");
    });

    test("returns empty array when no skills registered", () => {
      expect(registry.getAll()).toEqual([]);
    });
  });
});
