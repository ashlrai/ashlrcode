import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  checkPermission,
  allowForSession,
  getPermissionState,
  recordPermission,
  resetPermissionsForTests,
} from "../config/permissions.ts";
import { setConfigDirForTests } from "../config/settings.ts";

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "ashlrcode-permissions-test-"));
  setConfigDirForTests(configDir);
  resetPermissionsForTests();
});

afterEach(() => {
  resetPermissionsForTests();
  setConfigDirForTests(null);
  if (existsSync(configDir)) rmSync(configDir, { recursive: true, force: true });
});

describe("checkPermission", () => {
  // Note: tests interact with module-level state. The permission module uses
  // a global singleton state. We test the logic as-is.

  test("auto-allows read-only tools", () => {
    expect(checkPermission("Read")).toBe("allow");
    expect(checkPermission("Glob")).toBe("allow");
    expect(checkPermission("Grep")).toBe("allow");
    expect(checkPermission("AskUser")).toBe("allow");
    expect(checkPermission("WebFetch")).toBe("allow");
    expect(checkPermission("Agent")).toBe("allow");
  });

  test("returns 'ask' for unknown non-read-only tools", () => {
    // A tool not in the auto-allow list and not in any permission set
    expect(checkPermission("SomeRandomTool_" + Date.now())).toBe("ask");
  });

  test("allowForSession makes tool return 'allow'", () => {
    const toolName = `SessionTool_${Date.now()}`;
    expect(checkPermission(toolName)).toBe("ask");
    allowForSession(toolName);
    expect(checkPermission(toolName)).toBe("allow");
  });
});

describe("recordPermission", () => {
  test("always_allow persists and changes check result", async () => {
    const toolName = `AlwaysAllowTool_${Date.now()}`;
    expect(checkPermission(toolName)).toBe("ask");
    await recordPermission(toolName, "always_allow");
    expect(checkPermission(toolName)).toBe("allow");
    // Clean up: remove from state
    const state = getPermissionState();
    state.alwaysAllow.delete(toolName);
  });

  test("always_deny persists and changes check result", async () => {
    const toolName = `AlwaysDenyTool_${Date.now()}`;
    await recordPermission(toolName, "always_deny");
    expect(checkPermission(toolName)).toBe("deny");
    // Clean up
    const state = getPermissionState();
    state.alwaysDeny.delete(toolName);
  });

  test("always_allow removes from alwaysDeny", async () => {
    const toolName = `FlipTool_${Date.now()}`;
    await recordPermission(toolName, "always_deny");
    expect(checkPermission(toolName)).toBe("deny");
    await recordPermission(toolName, "always_allow");
    expect(checkPermission(toolName)).toBe("allow");
    // Clean up
    const state = getPermissionState();
    state.alwaysAllow.delete(toolName);
  });

  test("always_deny removes from alwaysAllow", async () => {
    const toolName = `FlipTool2_${Date.now()}`;
    await recordPermission(toolName, "always_allow");
    expect(checkPermission(toolName)).toBe("allow");
    await recordPermission(toolName, "always_deny");
    expect(checkPermission(toolName)).toBe("deny");
    // Clean up
    const state = getPermissionState();
    state.alwaysDeny.delete(toolName);
  });

  test("allow_once does not persist", async () => {
    const toolName = `OnceTool_${Date.now()}`;
    await recordPermission(toolName, "allow_once");
    // Still "ask" because allow_once doesn't persist
    expect(checkPermission(toolName)).toBe("ask");
  });

  test("deny_once does not persist", async () => {
    const toolName = `DenyOnceTool_${Date.now()}`;
    await recordPermission(toolName, "deny_once");
    expect(checkPermission(toolName)).toBe("ask");
  });
});
