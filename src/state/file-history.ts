/**
 * File snapshot/undo system — saves file state before edits.
 *
 * In-memory only (resets on exit). Each file can have multiple snapshots.
 */

import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";

interface Snapshot {
  content: string;
  timestamp: string;
}

class FileHistoryStore {
  private snapshots = new Map<string, Snapshot[]>();

  /**
   * Save a snapshot of a file before modifying it.
   */
  async snapshot(filePath: string): Promise<void> {
    if (!existsSync(filePath)) return;

    const content = await readFile(filePath, "utf-8");
    const history = this.snapshots.get(filePath) ?? [];
    history.push({
      content,
      timestamp: new Date().toISOString(),
    });
    this.snapshots.set(filePath, history);
  }

  /**
   * Restore the most recent snapshot of a file.
   */
  async restore(filePath: string): Promise<boolean> {
    const history = this.snapshots.get(filePath);
    if (!history || history.length === 0) return false;

    const snapshot = history.pop()!;
    await writeFile(filePath, snapshot.content, "utf-8");

    if (history.length === 0) {
      this.snapshots.delete(filePath);
    }

    return true;
  }

  /**
   * Get list of files with snapshots available.
   */
  getSnapshotFiles(): Array<{ path: string; count: number; lastModified: string }> {
    const files: Array<{ path: string; count: number; lastModified: string }> = [];
    for (const [path, history] of this.snapshots) {
      if (history.length > 0) {
        files.push({
          path,
          count: history.length,
          lastModified: history[history.length - 1]!.timestamp,
        });
      }
    }
    return files;
  }

  /**
   * Check if a file has snapshots.
   */
  hasSnapshot(filePath: string): boolean {
    const history = this.snapshots.get(filePath);
    return !!history && history.length > 0;
  }

  /**
   * Clear all snapshots.
   */
  clear(): void {
    this.snapshots.clear();
  }
}

// Global singleton
export const fileHistory = new FileHistoryStore();
