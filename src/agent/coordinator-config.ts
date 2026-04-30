/**
 * Coordinator static-DAG config loader.
 *
 * The coordinator normally plans subtasks via the LLM (`planSubTasks` in
 * `coordinator.ts`). For well-known multi-phase pipelines (e.g. the
 * artist-encyclopedia-factory's `build-artist` DAG), planning is deterministic
 * and baked into a JSON config under `ashlrcode-config/coordinator/<name>.json`.
 *
 * This module reads that JSON, validates its shape against the `SubTask` type
 * exported from `coordinator.ts`, runs a minimal `{{var}}` substitution pass,
 * and returns a `SubTask[]` ready to hand to `dispatchTasks()`.
 *
 * We do NOT pull in a schema library (zod isn't in deps); validation is a
 * small hand-rolled checker. If the repo later adopts zod we should swap
 * `validateCoordinatorConfig` for a zod schema.
 */

import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { resolve } from "path";
import type { SubTask } from "./coordinator.ts";

export interface CoordinatorConfigFile {
  name: string;
  description?: string;
  skill?: string;
  maxParallel?: number;
  autoVerify?: boolean;
  argSchema?: Record<string, { type: string; description?: string; required?: boolean }>;
  tasks: SubTask[];
  notes?: string[];
}

export class CoordinatorConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoordinatorConfigError";
  }
}

/**
 * Default location of coordinator configs, relative to the current working
 * directory. `loadCoordinatorConfig` can be given an explicit `baseDir` (used
 * by tests) but production callers rely on this default.
 */
export function defaultCoordinatorConfigDir(cwd: string = process.cwd()): string {
  return resolve(cwd, "ashlrcode-config", "coordinator");
}

/**
 * Validate a parsed config object. Throws `CoordinatorConfigError` on any
 * structural issue. Returns the (narrowed) config on success.
 */
export function validateCoordinatorConfig(raw: unknown): CoordinatorConfigFile {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new CoordinatorConfigError("config must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj.name !== "string" || obj.name.length === 0) {
    throw new CoordinatorConfigError("config.name must be a non-empty string");
  }
  if (!Array.isArray(obj.tasks) || obj.tasks.length === 0) {
    throw new CoordinatorConfigError("config.tasks must be a non-empty array");
  }

  const validRoles = new Set(["explorer", "implementer", "test-writer", "code-reviewer"]);
  const seenIds = new Set<string>();
  const tasks: SubTask[] = [];

  for (let i = 0; i < obj.tasks.length; i++) {
    const t = obj.tasks[i] as Record<string, unknown> | undefined;
    if (!t || typeof t !== "object") {
      throw new CoordinatorConfigError(`config.tasks[${i}] must be an object`);
    }
    if (typeof t.id !== "string" || t.id.length === 0) {
      throw new CoordinatorConfigError(`config.tasks[${i}].id must be a non-empty string`);
    }
    if (seenIds.has(t.id)) {
      throw new CoordinatorConfigError(`duplicate task id: ${t.id}`);
    }
    seenIds.add(t.id);
    if (typeof t.description !== "string" || t.description.length === 0) {
      throw new CoordinatorConfigError(`config.tasks[${t.id}].description must be a non-empty string`);
    }
    if (typeof t.role !== "string" || !validRoles.has(t.role)) {
      throw new CoordinatorConfigError(
        `config.tasks[${t.id}].role must be one of ${[...validRoles].join(", ")}`,
      );
    }
    if (t.readOnly !== undefined && typeof t.readOnly !== "boolean") {
      throw new CoordinatorConfigError(`config.tasks[${t.id}].readOnly must be boolean`);
    }
    if (t.files !== undefined) {
      if (!Array.isArray(t.files) || t.files.some((f) => typeof f !== "string")) {
        throw new CoordinatorConfigError(`config.tasks[${t.id}].files must be string[]`);
      }
    }
    if (t.dependsOn !== undefined) {
      if (!Array.isArray(t.dependsOn) || t.dependsOn.some((d) => typeof d !== "string")) {
        throw new CoordinatorConfigError(`config.tasks[${t.id}].dependsOn must be string[]`);
      }
    }
    if (t.type !== undefined && typeof t.type !== "string") {
      throw new CoordinatorConfigError(`config.tasks[${t.id}].type must be a string`);
    }

    tasks.push({
      id: t.id,
      description: t.description,
      role: t.role as SubTask["role"],
      readOnly: t.readOnly as boolean | undefined,
      files: t.files as string[] | undefined,
      dependsOn: (t.dependsOn as string[] | undefined) ?? [],
      type: t.type as SubTask["type"],
    });
  }

  // Second pass: verify every dependsOn points at a known task id.
  for (const task of tasks) {
    for (const dep of task.dependsOn ?? []) {
      if (!seenIds.has(dep)) {
        throw new CoordinatorConfigError(
          `task ${task.id} depends on unknown task id "${dep}"`,
        );
      }
    }
  }

  return {
    name: obj.name,
    description: typeof obj.description === "string" ? obj.description : undefined,
    skill: typeof obj.skill === "string" ? obj.skill : undefined,
    maxParallel: typeof obj.maxParallel === "number" ? obj.maxParallel : undefined,
    autoVerify: typeof obj.autoVerify === "boolean" ? obj.autoVerify : undefined,
    argSchema: (obj.argSchema as CoordinatorConfigFile["argSchema"]) ?? undefined,
    tasks,
    notes: Array.isArray(obj.notes) ? (obj.notes as string[]) : undefined,
  };
}

/**
 * Detect cycles in a task DAG. Copied in spirit from `coordinator.ts`'s
 * private `detectCycles` so we can fail-fast at load time (before any agents
 * are dispatched). Returns the cycle path if one is found, or null.
 */
export function detectConfigCycles(tasks: SubTask[]): string[] | null {
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const visited = new Set<string>();
  const recStack = new Set<string>();

  function dfs(taskId: string, path: string[]): string[] | null {
    visited.add(taskId);
    recStack.add(taskId);
    path.push(taskId);

    const task = taskMap.get(taskId);
    if (task?.dependsOn) {
      for (const dep of task.dependsOn) {
        if (!visited.has(dep)) {
          const cycle = dfs(dep, path);
          if (cycle) return cycle;
        } else if (recStack.has(dep)) {
          return [...path, dep];
        }
      }
    }

    path.pop();
    recStack.delete(taskId);
    return null;
  }

  for (const task of tasks) {
    if (!visited.has(task.id)) {
      const cycle = dfs(task.id, []);
      if (cycle) return cycle;
    }
  }
  return null;
}

/**
 * Replace every `{{key}}` occurrence in a SubTask's description/role/files
 * with its value from `vars`. Missing keys are left intact so it's obvious
 * when a caller forgot to pass something.
 *
 * Dumb string replace — no expressions, no escaping, no conditionals. Intentional.
 */
export function substituteVars(task: SubTask, vars: Record<string, string>): SubTask {
  const sub = (s: string): string => {
    let out = s;
    for (const [k, v] of Object.entries(vars)) {
      out = out.split(`{{${k}}}`).join(v);
    }
    return out;
  };

  return {
    ...task,
    description: sub(task.description),
    role: sub(task.role),
    files: task.files?.map(sub),
  };
}

/**
 * Load and validate a coordinator config by name, apply `{{var}}` substitution,
 * and return a `SubTask[]` ready to feed into `dispatchTasks()`.
 *
 * Throws `CoordinatorConfigError` when:
 *   - the file is missing
 *   - the JSON is malformed
 *   - the shape fails validation
 *   - the DAG contains a cycle
 */
export async function loadCoordinatorConfig(
  name: string,
  vars: Record<string, string> = {},
  opts: { baseDir?: string } = {},
): Promise<{ config: CoordinatorConfigFile; tasks: SubTask[] }> {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new CoordinatorConfigError(
      `invalid config name "${name}" (allowed: alphanumerics, dash, underscore)`,
    );
  }

  const baseDir = opts.baseDir ?? defaultCoordinatorConfigDir();
  const path = resolve(baseDir, `${name}.json`);

  if (!existsSync(path)) {
    throw new CoordinatorConfigError(`coordinator config not found: ${path}`);
  }

  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CoordinatorConfigError(`failed to read ${path}: ${msg}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CoordinatorConfigError(`failed to parse ${path} as JSON: ${msg}`);
  }

  const config = validateCoordinatorConfig(parsed);
  const tasks = config.tasks.map((t) => substituteVars(t, vars));

  const cycle = detectConfigCycles(tasks);
  if (cycle) {
    throw new CoordinatorConfigError(
      `coordinator config "${name}" has a dependency cycle: ${cycle.join(" -> ")}`,
    );
  }

  return { config, tasks };
}
