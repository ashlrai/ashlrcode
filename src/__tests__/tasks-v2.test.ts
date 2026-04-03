import { describe, test, expect, beforeEach } from "bun:test";
import {
  taskCreateTool,
  taskUpdateTool,
  taskListTool,
  taskGetTool,
  resetTasks,
} from "../tools/tasks.ts";
import type { ToolContext } from "../tools/types.ts";

const ctx: ToolContext = {
  cwd: "/tmp",
  requestPermission: async () => true,
};

describe("TaskCreate", () => {
  beforeEach(() => {
    resetTasks();
  });

  test("creates task with string ID using source prefix", async () => {
    const result = await taskCreateTool.call(
      { subject: "Write tests", description: "Unit tests for tasks" },
      ctx,
    );
    expect(result).toContain("u-001");
    expect(result).toContain("Write tests");
  });

  test("creates task with agent source prefix", async () => {
    const result = await taskCreateTool.call(
      { subject: "Agent task", description: "From agent", source: "a" },
      ctx,
    );
    expect(result).toContain("a-001");
  });

  test("increments ID counter across creates", async () => {
    await taskCreateTool.call({ subject: "First", description: "" }, ctx);
    const result = await taskCreateTool.call({ subject: "Second", description: "" }, ctx);
    expect(result).toContain("u-002");
  });

  test("creates task with blockedBy dependency", async () => {
    await taskCreateTool.call({ subject: "First", description: "" }, ctx);
    await taskCreateTool.call(
      { subject: "Second", description: "", blockedBy: ["u-001"] },
      ctx,
    );

    // Check that the blocker has blocks[] wired
    const firstJson = await taskGetTool.call({ taskId: "u-001" }, ctx);
    const first = JSON.parse(firstJson);
    expect(first.blocks).toContain("u-002");

    // Check the blocked task has blockedBy[]
    const secondJson = await taskGetTool.call({ taskId: "u-002" }, ctx);
    const second = JSON.parse(secondJson);
    expect(second.blockedBy).toContain("u-001");
  });

  test("creates task with owner field", async () => {
    await taskCreateTool.call(
      { subject: "Owned task", description: "", owner: "agent-1" },
      ctx,
    );

    const json = await taskGetTool.call({ taskId: "u-001" }, ctx);
    const task = JSON.parse(json);
    expect(task.owner).toBe("agent-1");
  });
});

describe("TaskUpdate", () => {
  beforeEach(() => {
    resetTasks();
  });

  test("updates task status to in_progress", async () => {
    await taskCreateTool.call({ subject: "Do stuff", description: "" }, ctx);
    await taskUpdateTool.call({ taskId: "u-001", status: "in_progress" }, ctx);

    const json = await taskGetTool.call({ taskId: "u-001" }, ctx);
    const task = JSON.parse(json);
    expect(task.status).toBe("in_progress");
  });

  test("updates task status to completed with timestamp", async () => {
    await taskCreateTool.call({ subject: "Do stuff", description: "" }, ctx);
    await taskUpdateTool.call({ taskId: "u-001", status: "completed" }, ctx);

    const json = await taskGetTool.call({ taskId: "u-001" }, ctx);
    const task = JSON.parse(json);
    expect(task.status).toBe("completed");
    expect(task.completedAt).toBeDefined();
  });

  test("returns not found for invalid taskId", async () => {
    const result = await taskUpdateTool.call({ taskId: "u-999" }, ctx);
    expect(result).toContain("not found");
  });

  test("addBlocks wires both directions", async () => {
    await taskCreateTool.call({ subject: "Task A", description: "" }, ctx);
    await taskCreateTool.call({ subject: "Task B", description: "" }, ctx);

    await taskUpdateTool.call(
      { taskId: "u-001", addBlocks: ["u-002"] },
      ctx,
    );

    const aJson = await taskGetTool.call({ taskId: "u-001" }, ctx);
    const a = JSON.parse(aJson);
    expect(a.blocks).toContain("u-002");

    const bJson = await taskGetTool.call({ taskId: "u-002" }, ctx);
    const b = JSON.parse(bJson);
    expect(b.blockedBy).toContain("u-001");
  });

  test("addBlockedBy wires both directions", async () => {
    await taskCreateTool.call({ subject: "Task A", description: "" }, ctx);
    await taskCreateTool.call({ subject: "Task B", description: "" }, ctx);

    await taskUpdateTool.call(
      { taskId: "u-002", addBlockedBy: ["u-001"] },
      ctx,
    );

    const aJson = await taskGetTool.call({ taskId: "u-001" }, ctx);
    const a = JSON.parse(aJson);
    expect(a.blocks).toContain("u-002");

    const bJson = await taskGetTool.call({ taskId: "u-002" }, ctx);
    const b = JSON.parse(bJson);
    expect(b.blockedBy).toContain("u-001");
  });

  test("addBlocks does not duplicate entries", async () => {
    await taskCreateTool.call({ subject: "Task A", description: "" }, ctx);
    await taskCreateTool.call({ subject: "Task B", description: "" }, ctx);

    await taskUpdateTool.call({ taskId: "u-001", addBlocks: ["u-002"] }, ctx);
    await taskUpdateTool.call({ taskId: "u-001", addBlocks: ["u-002"] }, ctx);

    const json = await taskGetTool.call({ taskId: "u-001" }, ctx);
    const task = JSON.parse(json);
    expect(task.blocks.filter((id: string) => id === "u-002")).toHaveLength(1);
  });

  test("updates owner field", async () => {
    await taskCreateTool.call({ subject: "Task", description: "" }, ctx);
    await taskUpdateTool.call({ taskId: "u-001", owner: "explorer" }, ctx);

    const json = await taskGetTool.call({ taskId: "u-001" }, ctx);
    const task = JSON.parse(json);
    expect(task.owner).toBe("explorer");
  });
});

describe("TaskGet", () => {
  beforeEach(() => {
    resetTasks();
  });

  test("returns full JSON detail for existing task", async () => {
    await taskCreateTool.call(
      { subject: "Build feature", description: "Details here", owner: "me" },
      ctx,
    );

    const json = await taskGetTool.call({ taskId: "u-001" }, ctx);
    const task = JSON.parse(json);
    expect(task.id).toBe("u-001");
    expect(task.subject).toBe("Build feature");
    expect(task.description).toBe("Details here");
    expect(task.status).toBe("pending");
    expect(task.owner).toBe("me");
    expect(task.createdAt).toBeDefined();
  });

  test("returns not found for missing task", async () => {
    const result = await taskGetTool.call({ taskId: "u-999" }, ctx);
    expect(result).toContain("not found");
  });
});

describe("TaskList", () => {
  beforeEach(() => {
    resetTasks();
  });

  test("returns 'No tasks.' when empty", async () => {
    const result = await taskListTool.call({}, ctx);
    expect(result).toBe("No tasks.");
  });

  test("lists tasks with status icons", async () => {
    await taskCreateTool.call({ subject: "Pending task", description: "" }, ctx);
    await taskCreateTool.call({ subject: "Active task", description: "" }, ctx);
    await taskUpdateTool.call({ taskId: "u-002", status: "in_progress" }, ctx);

    const result = await taskListTool.call({}, ctx);
    expect(result).toContain("○"); // pending
    expect(result).toContain("●"); // in_progress
  });

  test("shows dependency annotations", async () => {
    await taskCreateTool.call({ subject: "First", description: "" }, ctx);
    await taskCreateTool.call(
      { subject: "Second", description: "", blockedBy: ["u-001"] },
      ctx,
    );

    const result = await taskListTool.call({}, ctx);
    expect(result).toContain("→ blocks #u-002");
    expect(result).toContain("← blocked by #u-001");
  });

  test("shows (blocked) when blockers are incomplete", async () => {
    await taskCreateTool.call({ subject: "Blocker", description: "" }, ctx);
    await taskCreateTool.call(
      { subject: "Blocked", description: "", blockedBy: ["u-001"] },
      ctx,
    );

    const result = await taskListTool.call({}, ctx);
    expect(result).toContain("(blocked)");
  });

  test("completing a blocker removes (blocked) annotation", async () => {
    await taskCreateTool.call({ subject: "Blocker", description: "" }, ctx);
    await taskCreateTool.call(
      { subject: "Blocked", description: "", blockedBy: ["u-001"] },
      ctx,
    );

    // Complete the blocker
    await taskUpdateTool.call({ taskId: "u-001", status: "completed" }, ctx);

    const result = await taskListTool.call({}, ctx);
    expect(result).not.toContain("(blocked)");
  });

  test("shows owner with @ prefix", async () => {
    await taskCreateTool.call(
      { subject: "Task", description: "", owner: "agent-1" },
      ctx,
    );

    const result = await taskListTool.call({}, ctx);
    expect(result).toContain("@agent-1");
  });

  test("shows progress summary", async () => {
    await taskCreateTool.call({ subject: "A", description: "" }, ctx);
    await taskCreateTool.call({ subject: "B", description: "" }, ctx);
    await taskCreateTool.call({ subject: "C", description: "" }, ctx);
    await taskUpdateTool.call({ taskId: "u-001", status: "completed" }, ctx);
    await taskUpdateTool.call({ taskId: "u-002", status: "in_progress" }, ctx);

    const result = await taskListTool.call({}, ctx);
    expect(result).toContain("1/3 completed");
    expect(result).toContain("1 in progress");
    expect(result).toContain("1 pending");
  });
});
