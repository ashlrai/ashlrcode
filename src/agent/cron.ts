/**
 * Cron Triggers — schedule agent runs on recurring intervals.
 * Stored in ~/.ashlrcode/triggers/ as JSON files.
 */

import { existsSync } from "fs";
import { readFile, writeFile, readdir, mkdir, unlink } from "fs/promises";
import { join } from "path";
import { getConfigDir } from "../config/settings.ts";

export interface CronTrigger {
  id: string;
  name: string;
  schedule: string;      // Simplified duration: "5m", "1h", "30s", "2d"
  prompt: string;        // Agent prompt to execute
  cwd: string;           // Working directory
  enabled: boolean;
  lastRun?: string;
  nextRun?: string;
  runCount: number;
  createdAt: string;
}

function getTriggersDir(): string {
  return join(getConfigDir(), "triggers");
}

function parseDuration(schedule: string): number | null {
  const match = schedule.match(/^(\d+)(s|m|h|d)$/);
  if (!match) return null;
  const value = parseInt(match[1]!, 10);
  const unit = match[2]!;
  const multipliers: Record<string, number> = {
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return value * (multipliers[unit] ?? 60_000);
}

export async function createTrigger(
  name: string,
  schedule: string,
  prompt: string,
  cwd: string,
): Promise<CronTrigger> {
  await mkdir(getTriggersDir(), { recursive: true });

  const intervalMs = parseDuration(schedule);
  if (!intervalMs) {
    throw new Error(
      `Invalid schedule: ${schedule}. Use format like "5m", "1h", "30s", "2d"`,
    );
  }

  const trigger: CronTrigger = {
    id: `trigger-${Date.now()}`,
    name,
    schedule,
    prompt,
    cwd,
    enabled: true,
    runCount: 0,
    createdAt: new Date().toISOString(),
    nextRun: new Date(Date.now() + intervalMs).toISOString(),
  };

  await saveTrigger(trigger);
  return trigger;
}

export async function listTriggers(): Promise<CronTrigger[]> {
  const dir = getTriggersDir();
  if (!existsSync(dir)) return [];

  const files = await readdir(dir);
  const triggers: CronTrigger[] = [];
  for (const file of files.filter((f) => f.endsWith(".json"))) {
    try {
      const raw = await readFile(join(dir, file), "utf-8");
      triggers.push(JSON.parse(raw) as CronTrigger);
    } catch {
      // Skip malformed trigger files
    }
  }
  return triggers.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function deleteTrigger(id: string): Promise<boolean> {
  const path = join(getTriggersDir(), `${id}.json`);
  if (!existsSync(path)) return false;
  await unlink(path);
  return true;
}

export async function toggleTrigger(id: string): Promise<CronTrigger | null> {
  const trigger = await loadTrigger(id);
  if (!trigger) return null;
  trigger.enabled = !trigger.enabled;
  await saveTrigger(trigger);
  return trigger;
}

export async function markRun(id: string): Promise<void> {
  const trigger = await loadTrigger(id);
  if (!trigger) return;
  trigger.lastRun = new Date().toISOString();
  trigger.runCount++;
  const intervalMs = parseDuration(trigger.schedule);
  if (intervalMs) {
    trigger.nextRun = new Date(Date.now() + intervalMs).toISOString();
  }
  await saveTrigger(trigger);
}

export function getDueTriggers(triggers: CronTrigger[]): CronTrigger[] {
  const now = Date.now();
  return triggers.filter(
    (t) => t.enabled && t.nextRun && new Date(t.nextRun).getTime() <= now,
  );
}

async function loadTrigger(id: string): Promise<CronTrigger | null> {
  const path = join(getTriggersDir(), `${id}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch {
    return null;
  }
}

async function saveTrigger(trigger: CronTrigger): Promise<void> {
  await mkdir(getTriggersDir(), { recursive: true });
  await writeFile(
    join(getTriggersDir(), `${trigger.id}.json`),
    JSON.stringify(trigger, null, 2),
    "utf-8",
  );
}

/**
 * Background polling loop that checks for due triggers and executes them.
 */
export class TriggerRunner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private onExecute: (trigger: CronTrigger) => Promise<void>;

  constructor(onExecute: (trigger: CronTrigger) => Promise<void>) {
    this.onExecute = onExecute;
  }

  start(pollIntervalMs: number = 10_000): void {
    if (this.timer) return;
    this.running = true;
    this.timer = setInterval(async () => {
      if (!this.running) return;
      try {
        const triggers = await listTriggers();
        const due = getDueTriggers(triggers);
        for (const trigger of due) {
          try {
            await this.onExecute(trigger);
            await markRun(trigger.id);
          } catch (err) {
            // Don't mark as run if execution failed
            console.error(`Trigger ${trigger.id} failed:`, err);
          }
        }
      } catch {
        // Silently continue on errors — triggers are best-effort
      }
    }, pollIntervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  isActive(): boolean {
    return this.running && this.timer !== null;
  }
}
