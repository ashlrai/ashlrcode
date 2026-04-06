import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { setConfigDirForTests } from "../config/settings.ts";
import {
  saveCheckpoint,
  loadCheckpoint,
  listCheckpoints,
  listPendingCheckpoints,
  markCheckpointResumed,
  deleteCheckpoint,
  buildResumePrompt,
  type Checkpoint,
} from "../agent/checkpoint.ts";

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "ashlrcode-checkpoint-test-"));
  setConfigDirForTests(configDir);
});

afterEach(() => {
  setConfigDirForTests(null);
  if (existsSync(configDir)) rmSync(configDir, { recursive: true, force: true });
});

/** Helper to create a checkpoint with sensible defaults. */
function makeCheckpointInput(overrides: Partial<Omit<Checkpoint, "id" | "createdAt" | "resumed">> = {}) {
  return {
    coordinatorId: overrides.coordinatorId ?? "coord-1",
    type: overrides.type ?? ("user_decision" as const),
    reason: overrides.reason ?? "Need user input",
    prompt: overrides.prompt ?? "What should we do?",
    completedTasks: overrides.completedTasks ?? [],
    completedResults: overrides.completedResults ?? [],
    pendingTasks: overrides.pendingTasks ?? [],
    context: overrides.context ?? {},
    goal: overrides.goal ?? "Build the feature",
    cwd: overrides.cwd ?? "/tmp/project",
  };
}

describe("checkpoint", () => {
  describe("saveCheckpoint", () => {
    test("creates a file in checkpoints dir", async () => {
      const checkpoint = await saveCheckpoint(makeCheckpointInput());
      const path = join(configDir, "checkpoints", `${checkpoint.id}.json`);
      expect(existsSync(path)).toBe(true);
    });

    test("returns a checkpoint with id, createdAt, and resumed=false", async () => {
      const checkpoint = await saveCheckpoint(makeCheckpointInput());
      expect(checkpoint.id).toBeDefined();
      expect(checkpoint.id.length).toBe(12);
      expect(checkpoint.createdAt).toBeDefined();
      expect(checkpoint.resumed).toBe(false);
    });
  });

  describe("loadCheckpoint", () => {
    test("returns the saved checkpoint", async () => {
      const saved = await saveCheckpoint(makeCheckpointInput({ goal: "Test goal" }));
      const loaded = await loadCheckpoint(saved.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.id).toBe(saved.id);
      expect(loaded!.goal).toBe("Test goal");
    });

    test("returns null for non-existent ID", async () => {
      const result = await loadCheckpoint("nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("listCheckpoints", () => {
    test("returns checkpoints sorted newest first", async () => {
      const c1 = await saveCheckpoint(makeCheckpointInput({ goal: "First" }));
      // Small delay to ensure different timestamps
      await new Promise((r) => setTimeout(r, 10));
      const c2 = await saveCheckpoint(makeCheckpointInput({ goal: "Second" }));

      const list = await listCheckpoints();
      expect(list.length).toBe(2);
      // Newest first
      expect(list[0]!.goal).toBe("Second");
      expect(list[1]!.goal).toBe("First");
    });

    test("returns empty array when no checkpoints exist", async () => {
      const list = await listCheckpoints();
      expect(list).toEqual([]);
    });
  });

  describe("listPendingCheckpoints", () => {
    test("excludes resumed checkpoints", async () => {
      const c1 = await saveCheckpoint(makeCheckpointInput({ goal: "Pending" }));
      const c2 = await saveCheckpoint(makeCheckpointInput({ goal: "Resumed" }));
      await markCheckpointResumed(c2.id, "Proceed");

      const pending = await listPendingCheckpoints();
      expect(pending.length).toBe(1);
      expect(pending[0]!.goal).toBe("Pending");
    });
  });

  describe("markCheckpointResumed", () => {
    test("sets resumed=true and userResponse", async () => {
      const saved = await saveCheckpoint(makeCheckpointInput());
      const resumed = await markCheckpointResumed(saved.id, "Yes, go ahead");

      expect(resumed).not.toBeNull();
      expect(resumed!.resumed).toBe(true);
      expect(resumed!.userResponse).toBe("Yes, go ahead");

      // Verify persisted
      const loaded = await loadCheckpoint(saved.id);
      expect(loaded!.resumed).toBe(true);
      expect(loaded!.userResponse).toBe("Yes, go ahead");
    });

    test("returns null for non-existent checkpoint", async () => {
      const result = await markCheckpointResumed("nope", "test");
      expect(result).toBeNull();
    });
  });

  describe("deleteCheckpoint", () => {
    test("removes the file", async () => {
      const saved = await saveCheckpoint(makeCheckpointInput());
      const path = join(configDir, "checkpoints", `${saved.id}.json`);
      expect(existsSync(path)).toBe(true);

      const result = await deleteCheckpoint(saved.id);
      expect(result).toBe(true);
      expect(existsSync(path)).toBe(false);
    });

    test("returns false for non-existent checkpoint", async () => {
      const result = await deleteCheckpoint("nope");
      expect(result).toBe(false);
    });
  });

  describe("buildResumePrompt", () => {
    test("includes goal, reason, completed tasks, pending tasks, user response", () => {
      const checkpoint: Checkpoint = {
        id: "abc12345",
        coordinatorId: "coord-1",
        type: "user_decision",
        reason: "Need credentials",
        prompt: "Please provide API key",
        completedTasks: [
          { id: "t1", description: "Set up project", role: "coder" },
        ],
        completedResults: [
          { taskId: "t1", agentName: "coder-1", success: true, summary: "Project initialized" },
        ],
        pendingTasks: [
          { id: "t2", description: "Deploy to staging", role: "devops" },
        ],
        context: {},
        goal: "Deploy the application",
        cwd: "/tmp/project",
        createdAt: new Date().toISOString(),
        resumed: true,
        userResponse: "Here is the key: abc123",
      };

      const prompt = buildResumePrompt(checkpoint);
      expect(prompt).toContain("Deploy the application");
      expect(prompt).toContain("Need credentials");
      expect(prompt).toContain("Project initialized");
      expect(prompt).toContain("Deploy to staging");
      expect(prompt).toContain("Here is the key: abc123");
    });

    test("handles missing user response", () => {
      const checkpoint: Checkpoint = {
        id: "abc12345",
        coordinatorId: "coord-1",
        type: "review",
        reason: "Review needed",
        prompt: "Please review",
        completedTasks: [],
        completedResults: [],
        pendingTasks: [],
        context: {},
        goal: "Review code",
        cwd: "/tmp",
        createdAt: new Date().toISOString(),
        resumed: false,
      };

      const prompt = buildResumePrompt(checkpoint);
      expect(prompt).toContain("(no response yet)");
    });
  });
});
