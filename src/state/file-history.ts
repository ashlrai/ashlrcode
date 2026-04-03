/**
 * File snapshot/undo system — saves file state before edits.
 *
 * Supports:
 *  - Per-file snapshots before every Write/Edit operation
 *  - Multi-file undo (undo all changes from a turn)
 *  - Disk persistence at ~/.ashlrcode/file-history/<session-id>/
 *  - Handles newly-created files (undo = delete)
 */

import { readFile, writeFile, mkdir, readdir, unlink } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { getConfigDir } from "../config/settings.ts";

export interface FileSnapshot {
  id: string;
  filePath: string;
  content: string; // Original content before modification ("" means file didn't exist)
  timestamp: string;
  tool: string; // Which tool made the change (Write, Edit, Bash)
  turnNumber: number;
}

export class FileHistoryStore {
  private snapshots: FileSnapshot[] = [];
  private sessionId: string;
  private persistDir: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    this.persistDir = join(getConfigDir(), "file-history", sessionId);
  }

  /**
   * Capture a snapshot before a file is modified.
   * If the file doesn't exist yet, records an empty snapshot so undo can delete it.
   */
  async capture(filePath: string, tool: string, turnNumber: number): Promise<void> {
    if (!existsSync(filePath)) {
      // File doesn't exist yet — undo means delete
      const snapshot: FileSnapshot = {
        id: `snap-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        filePath,
        content: "",
        timestamp: new Date().toISOString(),
        tool,
        turnNumber,
      };
      this.snapshots.push(snapshot);
      this.persistSnapshot(snapshot).catch(() => {});
      return;
    }

    const content = await readFile(filePath, "utf-8");
    const snapshot: FileSnapshot = {
      id: `snap-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      filePath,
      content,
      timestamp: new Date().toISOString(),
      tool,
      turnNumber,
    };

    this.snapshots.push(snapshot);
    this.persistSnapshot(snapshot).catch(() => {});
  }

  /**
   * Undo the last file modification.
   * If the snapshot content is empty, the file was newly created — delete it.
   */
  async undoLast(): Promise<{ filePath: string; restored: boolean } | null> {
    const snapshot = this.snapshots.pop();
    if (!snapshot) return null;

    if (snapshot.content === "") {
      // File was newly created — delete it
      await unlink(snapshot.filePath).catch(() => {});
    } else {
      await writeFile(snapshot.filePath, snapshot.content, "utf-8");
    }

    // Remove persisted snapshot
    this.removePersistedSnapshot(snapshot.id).catch(() => {});

    return { filePath: snapshot.filePath, restored: true };
  }

  /**
   * Undo all changes from a specific turn (in reverse order).
   */
  async undoTurn(turnNumber: number): Promise<string[]> {
    const turnSnapshots = this.snapshots.filter(s => s.turnNumber === turnNumber);
    const restored: string[] = [];

    // Restore in reverse order so multi-edit sequences unwind correctly
    for (const snap of turnSnapshots.reverse()) {
      if (snap.content === "") {
        await unlink(snap.filePath).catch(() => {});
      } else {
        await writeFile(snap.filePath, snap.content, "utf-8");
      }
      restored.push(snap.filePath);
      this.snapshots = this.snapshots.filter(s => s.id !== snap.id);
      this.removePersistedSnapshot(snap.id).catch(() => {});
    }

    return restored;
  }

  /**
   * Restore a specific file to its most recent snapshot.
   */
  async restore(filePath: string): Promise<boolean> {
    // Find the most recent snapshot for this file
    let idx = -1;
    for (let i = this.snapshots.length - 1; i >= 0; i--) {
      if (this.snapshots[i]!.filePath === filePath) {
        idx = i;
        break;
      }
    }
    if (idx === -1) return false;

    const snapshot = this.snapshots[idx]!;
    if (snapshot.content === "") {
      await unlink(snapshot.filePath).catch(() => {});
    } else {
      await writeFile(snapshot.filePath, snapshot.content, "utf-8");
    }

    this.snapshots.splice(idx, 1);
    this.removePersistedSnapshot(snapshot.id).catch(() => {});
    return true;
  }

  /**
   * Get list of files with snapshots available.
   */
  getSnapshotFiles(): Array<{ path: string; count: number; lastModified: string }> {
    const byFile = new Map<string, FileSnapshot[]>();
    for (const snap of this.snapshots) {
      const arr = byFile.get(snap.filePath) ?? [];
      arr.push(snap);
      byFile.set(snap.filePath, arr);
    }
    const files: Array<{ path: string; count: number; lastModified: string }> = [];
    for (const [path, snaps] of byFile) {
      files.push({
        path,
        count: snaps.length,
        lastModified: snaps[snaps.length - 1]!.timestamp,
      });
    }
    return files;
  }

  /**
   * Get undo history (most recent first).
   */
  getHistory(): FileSnapshot[] {
    return [...this.snapshots].reverse();
  }

  /**
   * Check if a file has snapshots.
   */
  hasSnapshot(filePath: string): boolean {
    return this.snapshots.some(s => s.filePath === filePath);
  }

  /**
   * Get number of undoable operations.
   */
  get undoCount(): number {
    return this.snapshots.length;
  }

  /**
   * Clear all snapshots.
   */
  clear(): void {
    this.snapshots = [];
  }

  /** Persist a snapshot to disk. */
  private async persistSnapshot(snap: FileSnapshot): Promise<void> {
    await mkdir(this.persistDir, { recursive: true });
    await writeFile(
      join(this.persistDir, `${snap.id}.json`),
      JSON.stringify(snap),
      "utf-8"
    );
  }

  /** Remove a persisted snapshot from disk. */
  private async removePersistedSnapshot(id: string): Promise<void> {
    const filePath = join(this.persistDir, `${id}.json`);
    if (existsSync(filePath)) {
      await unlink(filePath).catch(() => {});
    }
  }

  /** Load persisted snapshots from disk (for session resume). */
  async loadFromDisk(): Promise<void> {
    if (!existsSync(this.persistDir)) return;
    const files = await readdir(this.persistDir);
    for (const file of files.filter(f => f.endsWith(".json"))) {
      try {
        const raw = await readFile(join(this.persistDir, file), "utf-8");
        this.snapshots.push(JSON.parse(raw) as FileSnapshot);
      } catch {
        // Ignore corrupt snapshot files
      }
    }
    this.snapshots.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  /** Clean up all persisted snapshots for this session. */
  async cleanup(): Promise<void> {
    if (!existsSync(this.persistDir)) return;
    const files = await readdir(this.persistDir);
    for (const file of files) {
      await unlink(join(this.persistDir, file)).catch(() => {});
    }
  }
}

// ── Module-level singleton accessor ─────────────────────────────

let _instance: FileHistoryStore | null = null;

export function setFileHistory(store: FileHistoryStore): void {
  _instance = store;
}

export function getFileHistory(): FileHistoryStore | null {
  return _instance;
}

/**
 * @deprecated Use getFileHistory() instead. Kept for backward compatibility.
 */
export const fileHistory = {
  async snapshot(filePath: string): Promise<void> {
    if (_instance) {
      await _instance.capture(filePath, "unknown", 0);
    }
  },
  async restore(filePath: string): Promise<boolean> {
    if (_instance) {
      return _instance.restore(filePath);
    }
    return false;
  },
  getSnapshotFiles() {
    return _instance?.getSnapshotFiles() ?? [];
  },
  hasSnapshot(filePath: string): boolean {
    return _instance?.hasSnapshot(filePath) ?? false;
  },
  clear(): void {
    _instance?.clear();
  },
};
