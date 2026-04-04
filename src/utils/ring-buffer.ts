/**
 * Ring buffer — bounded circular buffer for error/debug logging.
 *
 * Prevents unbounded memory growth in long sessions by keeping only
 * the most recent N entries. Follows Claude Code's ring buffer pattern.
 */

export class RingBuffer<T> {
  private buffer: (T | undefined)[];
  private head = 0;
  private count = 0;

  constructor(readonly capacity: number) {
    this.buffer = new Array(capacity);
  }

  /** Add an entry, overwriting the oldest if full. */
  push(item: T): void {
    this.buffer[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  /** Get all entries in insertion order (oldest first). */
  toArray(): T[] {
    if (this.count === 0) return [];
    const result: T[] = [];
    const start = this.count < this.capacity ? 0 : this.head;
    for (let i = 0; i < this.count; i++) {
      result.push(this.buffer[(start + i) % this.capacity] as T);
    }
    return result;
  }

  /** Get the N most recent entries. */
  recent(n: number): T[] {
    const all = this.toArray();
    return n >= all.length ? all : all.slice(-n);
  }

  /** Get the most recent entry, or undefined if empty. */
  last(): T | undefined {
    if (this.count === 0) return undefined;
    const idx = (this.head - 1 + this.capacity) % this.capacity;
    return this.buffer[idx];
  }

  /** Current number of entries (up to capacity). */
  get size(): number {
    return this.count;
  }

  /** Whether the buffer has reached capacity. */
  get isFull(): boolean {
    return this.count === this.capacity;
  }

  /** Clear all entries. */
  clear(): void {
    this.buffer = new Array(this.capacity);
    this.head = 0;
    this.count = 0;
  }
}

// ── Error log singleton ────────────────────────────────────────

export interface ErrorLogEntry {
  timestamp: string;
  category: string;
  message: string;
  context?: string;
}

const ERROR_LOG_CAPACITY = 1000;
const _errorLog = new RingBuffer<ErrorLogEntry>(ERROR_LOG_CAPACITY);

/** Log an error to the bounded ring buffer. */
export function logError(category: string, message: string, context?: string): void {
  _errorLog.push({
    timestamp: new Date().toISOString(),
    category,
    message,
    context,
  });
}

/** Get recent error log entries. */
export function getRecentErrors(n = 50): ErrorLogEntry[] {
  return _errorLog.recent(n);
}

/** Get the full error log (up to capacity). */
export function getErrorLog(): ErrorLogEntry[] {
  return _errorLog.toArray();
}

/** Clear the error log. */
export function clearErrorLog(): void {
  _errorLog.clear();
}
