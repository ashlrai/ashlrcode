/**
 * Work queue — stores and manages discovered work items.
 * Persisted to ~/.ashlrcode/autopilot/<project-hash>.json
 */

import { existsSync } from "fs";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { createHash } from "crypto";
import { getConfigDir } from "../config/settings.ts";
import type { WorkItem, WorkItemStatus } from "./types.ts";

function getQueueDir(): string {
  return join(getConfigDir(), "autopilot");
}

function getQueuePath(cwd: string): string {
  const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 12);
  return join(getQueueDir(), `${hash}.json`);
}

export class WorkQueue {
  private items: WorkItem[] = [];
  private path: string;

  constructor(cwd: string) {
    this.path = getQueuePath(cwd);
  }

  async load(): Promise<void> {
    if (!existsSync(this.path)) return;
    try {
      const raw = await readFile(this.path, "utf-8");
      this.items = JSON.parse(raw) as WorkItem[];
    } catch {
      this.items = [];
    }
  }

  async save(): Promise<void> {
    await mkdir(getQueueDir(), { recursive: true });
    await writeFile(this.path, JSON.stringify(this.items, null, 2), "utf-8");
  }

  /**
   * Add new items, deduplicating by file + line + type.
   */
  addItems(newItems: WorkItem[]): number {
    let added = 0;
    for (const item of newItems) {
      const exists = this.items.some(
        (i) => i.file === item.file && i.line === item.line && i.type === item.type && i.status !== "completed" && i.status !== "rejected"
      );
      if (!exists) {
        this.items.push(item);
        added++;
      }
    }
    return added;
  }

  /**
   * Get items by status, sorted by priority.
   */
  getByStatus(status: WorkItemStatus): WorkItem[] {
    const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    return this.items
      .filter((i) => i.status === status)
      .sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);
  }

  /**
   * Get all pending items (discovered + approved).
   */
  getPending(): WorkItem[] {
    return [...this.getByStatus("discovered"), ...this.getByStatus("approved")];
  }

  /**
   * Approve an item for execution.
   */
  approve(id: string): boolean {
    const item = this.items.find((i) => i.id === id);
    if (item && item.status === "discovered") {
      item.status = "approved";
      return true;
    }
    return false;
  }

  /**
   * Approve all discovered items.
   */
  approveAll(): number {
    let count = 0;
    for (const item of this.items) {
      if (item.status === "discovered") {
        item.status = "approved";
        count++;
      }
    }
    return count;
  }

  /**
   * Reject an item.
   */
  reject(id: string): boolean {
    const item = this.items.find((i) => i.id === id);
    if (item && item.status === "discovered") {
      item.status = "rejected";
      return true;
    }
    return false;
  }

  /**
   * Mark item as in progress.
   */
  startItem(id: string): WorkItem | null {
    const item = this.items.find((i) => i.id === id);
    if (item && item.status === "approved") {
      item.status = "in_progress";
      return item;
    }
    return null;
  }

  /**
   * Mark item as completed.
   */
  completeItem(id: string): void {
    const item = this.items.find((i) => i.id === id);
    if (item) {
      item.status = "completed";
      item.completedAt = new Date().toISOString();
    }
  }

  /**
   * Mark item as failed.
   */
  failItem(id: string, error: string): void {
    const item = this.items.find((i) => i.id === id);
    if (item) {
      item.status = "failed";
      item.error = error;
    }
  }

  /**
   * Get summary stats.
   */
  getStats(): Record<string, number> {
    const stats: Record<string, number> = {};
    for (const item of this.items) {
      stats[item.status] = (stats[item.status] ?? 0) + 1;
    }
    return stats;
  }

  /**
   * Get the next approved item to work on.
   */
  getNextApproved(): WorkItem | null {
    return this.getByStatus("approved")[0] ?? null;
  }

  /**
   * Total items.
   */
  get length(): number {
    return this.items.length;
  }

  /**
   * Clean old completed/rejected items (keep last 100).
   */
  cleanup(): void {
    const active = this.items.filter((i) => !["completed", "rejected", "failed"].includes(i.status));
    const archived = this.items
      .filter((i) => ["completed", "rejected", "failed"].includes(i.status))
      .slice(-100);
    this.items = [...active, ...archived];
  }
}
