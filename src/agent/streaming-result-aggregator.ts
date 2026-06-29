/**
 * StreamingResultAggregator — semantic chunking and progressive UI emission.
 *
 * For long-running tools (Grep on large files, WebSearch with multiple results,
 * BulkEdit manifests), this aggregator provides live feedback by:
 *
 *   1. Detecting output patterns (JSON, tables, stack traces, log lines, code blocks)
 *   2. Flushing complete semantic chunks to a UI callback as they arrive
 *   3. Timing out after 50ms and flushing whatever has accumulated
 *
 * Usage:
 *   const agg = new StreamingResultAggregator({ onChunk: (chunk) => render(chunk) });
 *   agg.push(partialText);       // feed incremental output
 *   const result = agg.finalize(); // flush remainder, returns full aggregated text
 */

// ---------------------------------------------------------------------------
// Pattern detection
// ---------------------------------------------------------------------------

export type OutputPattern =
  | "json"
  | "table"
  | "code-block"
  | "stack-trace"
  | "log-lines"
  | "grep-results"
  | "file-listing"
  | "plain-text";

/**
 * Detect the dominant semantic pattern in a text fragment.
 *
 * Uses lightweight heuristics — no LLM call.  Checks are ordered from most
 * specific to most general so the first match wins.
 */
export function detectOutputPattern(text: string): OutputPattern {
  const trimmed = text.trim();

  // JSON: starts with { or [ and ends with } or ]
  if (/^[\[{]/.test(trimmed) && /[\]}]$/.test(trimmed)) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {
      // Not valid JSON — fall through
    }
  }

  // Partial JSON (streaming in progress): starts with { or [ but not closed yet
  if (/^[\[{]/.test(trimmed) && trimmed.length > 0) {
    // Heuristic: if > 30% of lines look like key:value pairs, call it json
    const lines = trimmed.split("\n");
    const jsonLike = lines.filter((l) => /^\s*"[^"]+"\s*:/.test(l)).length;
    if (jsonLike / lines.length > 0.3) return "json";
  }

  const lines = trimmed.split("\n");
  const lineCount = lines.length;

  // Code block: delimited by ``` fences
  if (/^```/.test(trimmed) || trimmed.includes("\n```")) return "code-block";

  // Stack trace: Error keyword + lines starting with "    at "
  const atLines = lines.filter((l) => /^\s{2,}at\s/.test(l)).length;
  const errorLines = lines.filter((l) =>
    /\b(Error|Exception|Traceback|panic:|fatal:)\b/.test(l)
  ).length;
  if (atLines > 0 && errorLines > 0) return "stack-trace";
  if (atLines / lineCount > 0.35) return "stack-trace";

  // Log lines: starts with timestamp or log-level prefix (checked before grep
  // because "2024-01-15 10:30:00 INFO ..." would otherwise false-match grep's
  // "file:digit:" pattern on the "10:30:00" segment).
  const logLines = lines.filter((l) =>
    /^(\d{4}-\d{2}-\d{2}|\d{2}:\d{2}:\d{2}|\[(INFO|WARN|ERROR|DEBUG|TRACE)\])/.test(l)
  ).length;
  if (logLines / lineCount > 0.4) return "log-lines";

  // Grep results: majority of lines look like "file:line:content"
  // Require the "file" segment to contain at least one non-digit char so pure
  // timestamp-style "HH:MM:SS" lines don't accidentally match.
  const grepLines = lines.filter((l) => /^[^:\d][^:]*:\d+:/.test(l)).length;
  if (grepLines / lineCount > 0.5) return "grep-results";

  // File listing: majority of lines are absolute or relative paths
  const pathLines = lines.filter((l) =>
    /^(\/|\.\/|\.\.\/|[A-Za-z]:\\)/.test(l.trim())
  ).length;
  if (pathLines / lineCount > 0.5) return "file-listing";

  // Table: majority of lines contain pipe characters or consistent spacing
  const tableLines = lines.filter((l) => /\|/.test(l) && l.trim().length > 0).length;
  if (tableLines / lineCount > 0.5) return "table";

  return "plain-text";
}

// ---------------------------------------------------------------------------
// Semantic boundary detection
// ---------------------------------------------------------------------------

/**
 * Determine whether `buffer` currently ends on a semantic boundary.
 *
 * Semantic boundaries are detected by pattern:
 *   - json        : complete JSON value (balanced braces/brackets)
 *   - code-block  : closing ``` fence
 *   - stack-trace : blank line after a run of "at " lines
 *   - table       : blank line after a run of pipe-containing lines
 *   - log-lines   : every newline is a boundary (each line is self-contained)
 *   - grep-results: every newline is a boundary
 *   - file-listing: every newline is a boundary
 *   - plain-text  : paragraph boundary (double newline)
 */
export function isAtSemanticBoundary(buffer: string, pattern: OutputPattern): boolean {
  if (buffer.length === 0) return false;

  switch (pattern) {
    case "json": {
      // Check if braces/brackets are balanced
      let depth = 0;
      let inString = false;
      let escaped = false;
      for (const ch of buffer) {
        if (escaped) { escaped = false; continue; }
        if (ch === "\\" && inString) { escaped = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === "{" || ch === "[") depth++;
        else if (ch === "}" || ch === "]") depth--;
      }
      return depth === 0 && (buffer.trim().startsWith("{") || buffer.trim().startsWith("["));
    }

    case "code-block":
      // Complete when buffer ends with closing ``` (on its own line)
      return /```\s*$/.test(buffer);

    case "stack-trace":
    case "table":
      // Paragraph boundary: two consecutive newlines
      return /\n\n/.test(buffer);

    case "log-lines":
    case "grep-results":
    case "file-listing":
      // Each complete line is a boundary
      return buffer.endsWith("\n");

    case "plain-text":
    default:
      // Paragraph boundary
      return /\n\n/.test(buffer);
  }
}

// ---------------------------------------------------------------------------
// Chunk events
// ---------------------------------------------------------------------------

/** A semantic chunk emitted by the aggregator to the UI. */
export interface AggregatorChunk {
  /** Detected pattern for this chunk. */
  pattern: OutputPattern;
  /** The text content of the chunk. */
  text: string;
  /** Whether this chunk was flushed due to a timeout rather than a semantic boundary. */
  timedOut: boolean;
  /** Monotonically increasing chunk index within this aggregation session. */
  index: number;
}

// ---------------------------------------------------------------------------
// Aggregator options
// ---------------------------------------------------------------------------

export interface StreamingResultAggregatorOptions {
  /**
   * Called synchronously whenever a semantic chunk is ready for display.
   * The UI layer should render or buffer these chunks immediately.
   */
  onChunk: (chunk: AggregatorChunk) => void;

  /**
   * Maximum milliseconds to wait before force-flushing the current buffer,
   * even if no semantic boundary has been detected.
   * Default: 50ms.
   */
  flushIntervalMs?: number;

  /**
   * Minimum buffer size (in characters) before a timeout flush is allowed.
   * Prevents emitting single-character micro-chunks.
   * Default: 10 characters.
   */
  minFlushSize?: number;

  /**
   * Maximum buffer size (in characters) before forcing a flush regardless of
   * semantic boundaries or timers.
   * Default: 4096 characters.
   */
  maxBufferSize?: number;
}

// ---------------------------------------------------------------------------
// StreamingResultAggregator
// ---------------------------------------------------------------------------

export class StreamingResultAggregator {
  private _buffer = "";
  private _chunkIndex = 0;
  private _lastFlushTime = Date.now();
  private _finalized = false;
  private _full = "";

  private readonly _onChunk: (chunk: AggregatorChunk) => void;
  private readonly _flushIntervalMs: number;
  private readonly _minFlushSize: number;
  private readonly _maxBufferSize: number;

  constructor(opts: StreamingResultAggregatorOptions) {
    this._onChunk = opts.onChunk;
    this._flushIntervalMs = opts.flushIntervalMs ?? 50;
    this._minFlushSize = opts.minFlushSize ?? 10;
    this._maxBufferSize = opts.maxBufferSize ?? 4096;
  }

  /**
   * Feed incremental output into the aggregator.
   *
   * After each push(), the aggregator checks:
   *   1. Has a semantic boundary been reached? → flush immediately
   *   2. Has flushIntervalMs elapsed since last flush AND buffer >= minFlushSize? → timed flush
   *   3. Has buffer exceeded maxBufferSize? → forced flush
   *
   * @param text - Incremental text to append to the buffer.
   */
  push(text: string): void {
    if (this._finalized) {
      throw new Error("StreamingResultAggregator: push() called after finalize()");
    }

    this._buffer += text;
    this._full += text;

    this._maybeFlush();
  }

  /**
   * Flush any remaining buffered content and mark the aggregator as done.
   *
   * Must be called exactly once after all push() calls. Returns the full
   * concatenated text of all pushed content.
   */
  finalize(): string {
    if (this._finalized) {
      throw new Error("StreamingResultAggregator: finalize() called more than once");
    }
    this._finalized = true;

    if (this._buffer.length > 0) {
      this._emitChunk(false);
    }

    return this._full;
  }

  /**
   * Returns the current number of chunks emitted so far (not counting any
   * unflushed buffer content).
   */
  get chunkCount(): number {
    return this._chunkIndex;
  }

  /**
   * Returns a copy of the current (unflushed) buffer content.
   */
  get pendingBuffer(): string {
    return this._buffer;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _maybeFlush(): void {
    const pattern = detectOutputPattern(this._buffer);

    // 1. Max buffer size exceeded → forced flush
    if (this._buffer.length >= this._maxBufferSize) {
      this._emitChunk(false);
      return;
    }

    // 2. Semantic boundary reached → immediate flush
    if (isAtSemanticBoundary(this._buffer, pattern)) {
      this._emitChunk(false);
      return;
    }

    // 3. Timeout flush — only if minimum buffer size is met
    const now = Date.now();
    if (
      now - this._lastFlushTime >= this._flushIntervalMs &&
      this._buffer.length >= this._minFlushSize
    ) {
      this._emitChunk(true);
      return;
    }
  }

  private _emitChunk(timedOut: boolean): void {
    if (this._buffer.length === 0) return;

    const pattern = detectOutputPattern(this._buffer);
    const chunk: AggregatorChunk = {
      pattern,
      text: this._buffer,
      timedOut,
      index: this._chunkIndex++,
    };

    this._buffer = "";
    this._lastFlushTime = Date.now();
    this._onChunk(chunk);
  }
}

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

/**
 * Create a StreamingResultAggregator that collects all chunks into an array
 * (useful for testing and logging).
 */
export function createCollectingAggregator(
  opts?: Partial<Omit<StreamingResultAggregatorOptions, "onChunk">>
): { aggregator: StreamingResultAggregator; chunks: AggregatorChunk[] } {
  const chunks: AggregatorChunk[] = [];
  const aggregator = new StreamingResultAggregator({
    ...opts,
    onChunk: (chunk) => chunks.push(chunk),
  });
  return { aggregator, chunks };
}

/**
 * Run a mock tool-like async generator through the aggregator and return all
 * emitted chunks plus the final text.
 *
 * @param generator - Async iterable of text deltas (mirrors CompressorEvent.text).
 * @param opts      - Aggregator options (minus onChunk).
 */
export async function aggregateStream(
  generator: AsyncIterable<string>,
  opts?: Partial<Omit<StreamingResultAggregatorOptions, "onChunk">>
): Promise<{ chunks: AggregatorChunk[]; fullText: string }> {
  const { aggregator, chunks } = createCollectingAggregator(opts);

  for await (const delta of generator) {
    aggregator.push(delta);
  }

  const fullText = aggregator.finalize();
  return { chunks, fullText };
}
