import { test, expect, describe, beforeEach } from "bun:test";
import {
  checkRules,
  setRules,
  getRules,
  resetPermissionsForTests,
  type PermissionRule,
} from "../config/permissions.ts";

beforeEach(() => {
  resetPermissionsForTests();
});

describe("matchesToolPattern (via checkRules)", () => {
  // matchesToolPattern is internal, so we test it through checkRules.

  test("exact match", () => {
    setRules([{ tool: "Bash", action: "deny" }]);
    expect(checkRules("Bash")).toBe("deny");
    expect(checkRules("Read")).toBeNull();
  });

  test("prefix glob (e.g. 'File*')", () => {
    setRules([{ tool: "File*", action: "allow" }]);
    expect(checkRules("FileRead")).toBe("allow");
    expect(checkRules("FileWrite")).toBe("allow");
    expect(checkRules("Bash")).toBeNull();
  });

  test("suffix glob (e.g. '*Bash')", () => {
    setRules([{ tool: "*Bash", action: "deny" }]);
    expect(checkRules("DangerousBash")).toBe("deny");
    expect(checkRules("Bash")).toBe("deny");
    expect(checkRules("Read")).toBeNull();
  });

  test("wildcard '*' matches everything", () => {
    setRules([{ tool: "*", action: "ask" }]);
    expect(checkRules("Bash")).toBe("ask");
    expect(checkRules("Read")).toBe("ask");
    expect(checkRules("AnythingAtAll")).toBe("ask");
  });
});

describe("checkRules", () => {
  test("matches tool name + inputPattern", () => {
    setRules([
      { tool: "Bash", inputPattern: "rm\\s+-rf", action: "deny" },
    ]);
    expect(checkRules("Bash", { command: "rm -rf /" })).toBe("deny");
  });

  test("returns null when no rule matches", () => {
    setRules([{ tool: "Bash", action: "deny" }]);
    expect(checkRules("Write")).toBeNull();
  });

  test("returns null when tool matches but inputPattern does not", () => {
    setRules([
      { tool: "Bash", inputPattern: "sudo", action: "deny" },
    ]);
    expect(checkRules("Bash", { command: "ls -la" })).toBeNull();
  });

  test("matches with regex inputPattern", () => {
    setRules([
      { tool: "Bash", inputPattern: "\\bsudo\\b", action: "deny" },
    ]);
    expect(checkRules("Bash", { command: "sudo apt install" })).toBe("deny");
    expect(checkRules("Bash", { command: "pseudocode" })).toBeNull();
  });

  test("first matching rule wins", () => {
    setRules([
      { tool: "Bash", inputPattern: "sudo", action: "deny" },
      { tool: "Bash", action: "allow" },
    ]);
    // The first rule matches sudo commands
    expect(checkRules("Bash", { command: "sudo rm" })).toBe("deny");
    // The second rule catches all other Bash
    expect(checkRules("Bash", { command: "ls" })).toBe("allow");
  });

  test("invalid regex in inputPattern is skipped", () => {
    setRules([
      { tool: "Bash", inputPattern: "[invalid", action: "deny" },
      { tool: "Bash", action: "allow" },
    ]);
    // First rule has bad regex and is skipped; second rule matches
    expect(checkRules("Bash", { command: "anything" })).toBe("allow");
  });

  test("no input provided — rules without inputPattern still match", () => {
    setRules([{ tool: "Bash", action: "deny" }]);
    expect(checkRules("Bash")).toBe("deny");
  });
});

describe("setRules and getRules", () => {
  test("setRules replaces rules and getRules returns them", () => {
    const rules: PermissionRule[] = [
      { tool: "Bash", action: "deny" },
      { tool: "Read", action: "allow" },
    ];
    setRules(rules);
    expect(getRules()).toBe(rules);
  });

  test("getRules returns empty array initially", () => {
    expect(getRules()).toEqual([]);
  });
});

describe("resetPermissionsForTests", () => {
  test("clears all rules", () => {
    setRules([{ tool: "Bash", action: "deny" }]);
    expect(getRules().length).toBe(1);
    resetPermissionsForTests();
    expect(getRules()).toEqual([]);
  });
});
