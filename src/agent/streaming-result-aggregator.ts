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
 * Semantic Pause-Points (v2):
 *   The aggregator can be configured to detect "pause points" — moments in the
 *   stream where enough structured data has been seen to produce a useful inline
 *   summary instead of forwarding raw bytes to the LLM.  This reduces token
 *   waste on large, repetitive tool outputs (e.g. "JSON parsed: 45 results, 3
 *   errors" instead of the full JSON).
 *
 *   Key additions:
 *     - AggregatorChunk now carries `type` ('json'|'diff'|'error'|'text') and
 *       `isComplete` boolean.
 *     - detectSemanticBoundaryType() maps detected patterns to boundary types
 *       and emits richer metadata.
 *     - pauseAndSummarize() can be called at any pause point to interrupt the
 *       stream and inject a compact LLM-facing summary annotation.
 *     - SemanticPausePointDetector is a state machine that tracks multi-line
 *       boundaries (JSON depth, diff hunks, error blocks) incrementally.
 *
 * Semantic Tool Result Chunking (v3):
 *   The OutputClassifier + SemanticsAwareChunker from output-classifier.ts are
 *   re-exported here so callers have a single import surface for all chunking
 *   primitives.  The aggregator can also be constructed with an OutputClassifier
 *   to override its pattern-detection with domain-specific rules.
 *
 * Usage:
 *   const agg = new StreamingResultAggregator({ onChunk: (chunk) => render(chunk) });
 *   agg.push(partialText);       // feed incremental output
 *   const result = agg.finalize(); // flush remainder, returns full aggregated text
 */

// Re-export the semantic classifier + chunker so callers can import from a
// single surface (streaming-result-aggregator or output-classifier directly).
export {
  OutputClassifier,
  SemanticsAwareChunker,
  classifyFromMeta,
  classifyFromContent,
  findPausePoint,
  createSemanticChunkCollector,
  type SemanticType,
  type PausePoint,
  type SemanticChunk,
} from "./output-classifier.ts";

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

/**
 * Coarse type for a semantic boundary, used by the pause-point system.
 *   - 'json'  : JSON object or array boundary
 *   - 'diff'  : git/unified-diff hunk or file boundary
 *   - 'error' : shell stderr or exception block
 *   - 'text'  : plain text / fallback
 */
export type BoundaryType = "json" | "diff" | "error" | "text";

/** A semantic chunk emitted by the aggregator to the UI. */
export interface AggregatorChunk {
  /** Detected pattern for this chunk. */
  pattern: OutputPattern;
  /**
   * Coarse boundary type — a higher-level classification used by the pause-point
   * system so callers can decide whether to request the full output or a summary.
   */
  type: BoundaryType;
  /** The text content of the chunk. */
  text: string;
  /** Whether this chunk was flushed due to a timeout rather than a semantic boundary. */
  timedOut: boolean;
  /** Monotonically increasing chunk index within this aggregation session. */
  index: number;
  /**
   * Whether the boundary that triggered this chunk is "complete" — i.e. the
   * aggregator detected a proper closing marker (balanced JSON, diff EOF, blank
   * line after error block) rather than a forced/timeout flush.
   */
  isComplete: boolean;
}

// ---------------------------------------------------------------------------
// Boundary type mapping
// ---------------------------------------------------------------------------

/**
 * Map an OutputPattern to a coarse BoundaryType used by the pause-point system.
 */
export function patternToBoundaryType(pattern: OutputPattern): BoundaryType {
  switch (pattern) {
    case "json":
      return "json";
    case "stack-trace":
    case "log-lines":
      return "error";
    case "code-block":
    case "table":
    case "grep-results":
    case "file-listing":
    case "plain-text":
    default:
      return "text";
  }
}

// ---------------------------------------------------------------------------
// SemanticPausePointDetector — incremental state machine
// ---------------------------------------------------------------------------

/**
 * State machine that tracks multi-line semantic boundaries incrementally as
 * text is pushed character-by-character (or chunk-by-chunk).
 *
 * Supported boundary types:
 *   - JSON: tracks brace/bracket depth; fires at depth 0 after a root open.
 *   - Diff: fires at each "@@" hunk header or "diff --git" file header.
 *   - Error: fires at blank lines that follow stderr-like content.
 *
 * The detector is intentionally stateful so it can be reused across multiple
 * push() calls without re-scanning the entire buffer each time.
 */
export class SemanticPausePointDetector {
  // JSON depth tracking
  private _jsonDepth = 0;
  private _jsonInString = false;
  private _jsonEscaped = false;
  private _jsonStarted = false;

  // Diff tracking
  private _lastLineStart = "";
  private _diffActive = false;

  // Error/stderr tracking
  private _errorLineCount = 0;
  private _lastLineWasError = false;

  /** Whether the most-recently pushed text ended at a detectable boundary. */
  paused = false;
  /** The boundary type that caused the last pause, or null if not paused. */
  pauseType: BoundaryType | null = null;

  /**
   * Process a text fragment and update internal state.
   * After calling push(), check `paused` to see if a boundary was reached.
   */
  push(text: string): void {
    this.paused = false;
    this.pauseType = null;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!;

      // ---- JSON state machine ----
      if (!this._jsonEscaped && !this._jsonInString && (ch === "{" || ch === "[")) {
        this._jsonDepth++;
        this._jsonStarted = true;
      } else if (!this._jsonEscaped && !this._jsonInString && (ch === "}" || ch === "]")) {
        if (this._jsonDepth > 0) this._jsonDepth--;
        if (this._jsonStarted && this._jsonDepth === 0) {
          this.paused = true;
          this.pauseType = "json";
          // Reset for the next JSON value
          this._jsonStarted = false;
        }
      } else if (!this._jsonEscaped && ch === '"') {
        this._jsonInString = !this._jsonInString;
      } else if (this._jsonInString && ch === "\\") {
        this._jsonEscaped = true;
        continue;
      }
      this._jsonEscaped = false;

      // ---- Diff state machine ----
      if (ch === "\n") {
        const line = this._lastLineStart;
        this._lastLineStart = "";
        // Detect diff hunk header or file header
        if (/^@@\s+-\d+/.test(line) || /^diff --git /.test(line)) {
          this._diffActive = true;
          this.paused = true;
          this.pauseType = "diff";
        } else if (this._diffActive && line === "") {
          // Blank line after diff content = end of hunk
          this.paused = true;
          this.pauseType = "diff";
          this._diffActive = false;
        }
        // ---- Error/stderr state machine ----
        const isErrorLine = /\b(Error|Exception|Traceback|stderr|FAILED|fatal:|panic:)\b/i.test(line)
          || /^\s+(at |in )\S/.test(line);
        if (isErrorLine) {
          this._errorLineCount++;
          this._lastLineWasError = true;
        } else if (this._lastLineWasError && line === "" && this._errorLineCount >= 1) {
          // Blank line after error block
          this.paused = true;
          this.pauseType = "error";
          this._errorLineCount = 0;
          this._lastLineWasError = false;
        } else if (!isErrorLine) {
          this._lastLineWasError = false;
        }
      } else {
        this._lastLineStart += ch;
      }
    }
  }

  /** Reset all state (e.g. after a flush). */
  reset(): void {
    this._jsonDepth = 0;
    this._jsonInString = false;
    this._jsonEscaped = false;
    this._jsonStarted = false;
    this._lastLineStart = "";
    this._diffActive = false;
    this._errorLineCount = 0;
    this._lastLineWasError = false;
    this.paused = false;
    this.pauseType = null;
  }
}

// ---------------------------------------------------------------------------
// Pause-point summary generators
// ---------------------------------------------------------------------------

/**
 * Generate a concise LLM-facing summary annotation for a chunk at a pause point.
 *
 * The summary is injected into the output in place of (or alongside) the raw
 * content when `pauseAndSummarize()` is called.  The goal is to reduce token
 * waste while preserving the information the LLM needs to decide whether to
 * request the full output.
 *
 * @param chunk     - The chunk at the pause point.
 * @param fullSoFar - The full text accumulated so far in the stream.
 */
export function generatePauseSummary(chunk: AggregatorChunk, fullSoFar: string): string {
  const lines = chunk.text.split("\n").filter((l) => l.trim().length > 0);
  const totalLines = fullSoFar.split("\n").length;

  switch (chunk.type) {
    case "json": {
      // Count top-level array elements or object keys
      try {
        const parsed = JSON.parse(chunk.text);
        if (Array.isArray(parsed)) {
          const errorItems = parsed.filter(
            (item) =>
              typeof item === "object" &&
              item !== null &&
              ("error" in item || "err" in item || "status" in item && item.status >= 400)
          ).length;
          return `[JSON parsed: ${parsed.length} results${errorItems > 0 ? `, ${errorItems} errors` : ""}]`;
        }
        const keys = Object.keys(parsed);
        return `[JSON parsed: object with ${keys.length} keys (${keys.slice(0, 3).join(", ")}${keys.length > 3 ? "…" : ""})]`;
      } catch {
        // Partial / invalid JSON
        const arrayMatches = (chunk.text.match(/^\s*\{/gm) ?? []).length;
        return `[JSON (partial): ~${arrayMatches} objects, ${lines.length} lines]`;
      }
    }

    case "diff": {
      const addedLines = (chunk.text.match(/^\+[^+]/gm) ?? []).length;
      const removedLines = (chunk.text.match(/^-[^-]/gm) ?? []).length;
      const fileHeaders = (chunk.text.match(/^diff --git /gm) ?? []).length;
      const hunks = (chunk.text.match(/^@@/gm) ?? []).length;
      if (fileHeaders > 0) {
        return `[Diff: ${fileHeaders} file(s), +${addedLines}/-${removedLines} lines]`;
      }
      return `[Diff hunk: +${addedLines}/-${removedLines} lines (${hunks} hunk${hunks !== 1 ? "s" : ""})]`;
    }

    case "error": {
      const errorLines = lines.filter((l) =>
        /\b(Error|Exception|Traceback|fatal:|panic:)\b/i.test(l)
      );
      const atLines = lines.filter((l) => /^\s+(at |in )\S/.test(l)).length;
      const errorMsg = errorLines[0]?.slice(0, 80) ?? "unknown error";
      return `[Error block: "${errorMsg}"${atLines > 0 ? `, ${atLines} stack frame(s)` : ""}]`;
    }

    case "text":
    default: {
      return `[Text: ${lines.length} lines (${totalLines} total so far)]`;
    }
  }
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

  /**
   * Enable semantic pause-point detection via SemanticPausePointDetector.
   * When true, the aggregator tracks JSON depth, diff hunks, and error blocks
   * incrementally and emits pause-point chunks with richer metadata.
   * Default: false (preserves backward compatibility).
   */
  enablePausePoints?: boolean;

  /**
   * Called when a semantic pause point is detected (requires enablePausePoints).
   * Receives the chunk at the pause point so the caller can decide whether to
   * inject a summary via pauseAndSummarize().
   */
  onPausePoint?: (chunk: AggregatorChunk, summary: string) => void;
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
  private readonly _enablePausePoints: boolean;
  private readonly _onPausePoint: ((chunk: AggregatorChunk, summary: string) => void) | undefined;
  private readonly _pauseDetector: SemanticPausePointDetector | null;

  /** Summaries injected via pauseAndSummarize() — appended to the stream. */
  private _injectedSummaries: string[] = [];

  constructor(opts: StreamingResultAggregatorOptions) {
    this._onChunk = opts.onChunk;
    this._flushIntervalMs = opts.flushIntervalMs ?? 50;
    this._minFlushSize = opts.minFlushSize ?? 10;
    this._maxBufferSize = opts.maxBufferSize ?? 4096;
    this._enablePausePoints = opts.enablePausePoints ?? false;
    this._onPausePoint = opts.onPausePoint;
    this._pauseDetector = this._enablePausePoints ? new SemanticPausePointDetector() : null;
  }

  /**
   * Feed incremental output into the aggregator.
   *
   * After each push(), the aggregator checks:
   *   1. Has a semantic boundary been reached? → flush immediately
   *   2. Has flushIntervalMs elapsed since last flush AND buffer >= minFlushSize? → timed flush
   *   3. Has buffer exceeded maxBufferSize? → forced flush
   *
   * When enablePausePoints is true, the SemanticPausePointDetector is updated
   * incrementally and fires onPausePoint callbacks at detected boundaries.
   *
   * @param text - Incremental text to append to the buffer.
   */
  push(text: string): void {
    if (this._finalized) {
      throw new Error("StreamingResultAggregator: push() called after finalize()");
    }

    this._buffer += text;
    this._full += text;

    // Update incremental pause-point detector (when enabled)
    if (this._pauseDetector) {
      this._pauseDetector.push(text);
    }

    this._maybeFlush();
  }

  /**
   * Interrupt the current stream at a pause point and inject an LLM-facing
   * summary annotation in place of (or alongside) the accumulated buffer.
   *
   * This method:
   *   1. Flushes any pending buffer content as a chunk with isComplete=false.
   *   2. Generates a compact summary via generatePauseSummary().
   *   3. Emits a synthetic summary chunk with type matching the pause type.
   *   4. Resets the pause detector state for the next segment.
   *
   * The caller (typically the agent loop) should invoke this when the model
   * signals it does not need the full output of a tool, or when the aggregator
   * fires onPausePoint and the caller decides to summarise.
   *
   * @returns The generated summary string so the caller can forward it to the LLM.
   */
  pauseAndSummarize(): string {
    if (this._finalized) {
      throw new Error("StreamingResultAggregator: pauseAndSummarize() called after finalize()");
    }

    // Flush whatever is in the buffer as a partial (isComplete=false) chunk
    if (this._buffer.length > 0) {
      this._emitChunk(false, false);
    }

    // Determine type from detector state or fall back to text
    const pauseType: BoundaryType =
      this._pauseDetector?.pauseType ?? "text";

    // Build a synthetic chunk representing the accumulated content so far
    const syntheticChunk: AggregatorChunk = {
      pattern: "plain-text",
      type: pauseType,
      text: this._full,
      timedOut: false,
      index: this._chunkIndex,
      isComplete: false,
    };

    const summary = generatePauseSummary(syntheticChunk, this._full);
    this._injectedSummaries.push(summary);

    // Emit the summary as a chunk the UI can display
    const summaryChunk: AggregatorChunk = {
      pattern: "plain-text",
      type: pauseType,
      text: summary,
      timedOut: false,
      index: this._chunkIndex++,
      isComplete: true,
    };
    this._onChunk(summaryChunk);

    // Reset detector state for next segment
    this._pauseDetector?.reset();

    return summary;
  }

  /**
   * Flush any remaining buffered content and mark the aggregator as done.
   *
   * Must be called exactly once after all push() calls. Returns the full
   * concatenated text of all pushed content (including any injected summaries).
   */
  finalize(): string {
    if (this._finalized) {
      throw new Error("StreamingResultAggregator: finalize() called more than once");
    }
    this._finalized = true;

    if (this._buffer.length > 0) {
      this._emitChunk(false, true);
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

  /**
   * Returns the list of summaries injected via pauseAndSummarize().
   */
  get injectedSummaries(): readonly string[] {
    return this._injectedSummaries;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _maybeFlush(): void {
    const pattern = detectOutputPattern(this._buffer);

    // 1. Max buffer size exceeded → forced flush
    if (this._buffer.length >= this._maxBufferSize) {
      this._emitChunk(false, false);
      return;
    }

    // 2. Pause-point detector fired → immediate flush with pause metadata
    if (this._pauseDetector?.paused) {
      const isComplete = true;
      const chunk = this._emitChunkWithType(
        false,
        isComplete,
        this._pauseDetector.pauseType ?? "text",
        pattern
      );
      // Fire the onPausePoint callback if registered
      if (chunk && this._onPausePoint) {
        const summary = generatePauseSummary(chunk, this._full);
        this._onPausePoint(chunk, summary);
      }
      this._pauseDetector.reset();
      return;
    }

    // 3. Semantic boundary reached → immediate flush
    if (isAtSemanticBoundary(this._buffer, pattern)) {
      this._emitChunk(false, true);
      return;
    }

    // 4. Timeout flush — only if minimum buffer size is met
    const now = Date.now();
    if (
      now - this._lastFlushTime >= this._flushIntervalMs &&
      this._buffer.length >= this._minFlushSize
    ) {
      this._emitChunk(true, false);
      return;
    }
  }

  private _emitChunk(timedOut: boolean, isComplete: boolean): void {
    if (this._buffer.length === 0) return;
    const pattern = detectOutputPattern(this._buffer);
    this._emitChunkWithType(timedOut, isComplete, patternToBoundaryType(pattern), pattern);
  }

  private _emitChunkWithType(
    timedOut: boolean,
    isComplete: boolean,
    type: BoundaryType,
    pattern: OutputPattern
  ): AggregatorChunk | null {
    if (this._buffer.length === 0) return null;

    const chunk: AggregatorChunk = {
      pattern,
      type,
      text: this._buffer,
      timedOut,
      index: this._chunkIndex++,
      isComplete,
    };

    this._buffer = "";
    this._lastFlushTime = Date.now();
    this._onChunk(chunk);
    return chunk;
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
 * Create a StreamingResultAggregator with pause-point detection enabled,
 * collecting all chunks and pause-point summaries.
 */
export function createPausePointAggregator(
  opts?: Partial<Omit<StreamingResultAggregatorOptions, "onChunk" | "enablePausePoints">>
): {
  aggregator: StreamingResultAggregator;
  chunks: AggregatorChunk[];
  pausePointSummaries: Array<{ chunk: AggregatorChunk; summary: string }>;
} {
  const chunks: AggregatorChunk[] = [];
  const pausePointSummaries: Array<{ chunk: AggregatorChunk; summary: string }> = [];
  const aggregator = new StreamingResultAggregator({
    ...opts,
    enablePausePoints: true,
    onChunk: (chunk) => chunks.push(chunk),
    onPausePoint: (chunk, summary) => pausePointSummaries.push({ chunk, summary }),
  });
  return { aggregator, chunks, pausePointSummaries };
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
