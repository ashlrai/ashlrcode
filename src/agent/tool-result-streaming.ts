/**
 * Tool Result Streaming with Semantic Pause-Points
 *
 * Extends the result-predictor with semantic chunking so callers receive
 * natural chunk boundaries rather than arbitrary byte splits.
 *
 * Key capabilities:
 *   1. Classify output types (bash_error, grep_results, file_contents,
 *      json_array, log_lines, code_block, diff, generic_text).
 *   2. Emit natural chunk boundaries: line breaks for logs/grep, block breaks
 *      for JSON, function boundaries for code, diff hunks for patches.
 *   3. Adaptive chunking: measures how fast the caller drains chunks and
 *      adjusts chunk size to keep UI responsive without micro-flushing.
 *   4. onToolResultChunk callback — integrates with tool-executor post-exec.
 *
 * Pipeline:
 *   classifyStreamOutputType()  — fine-grained output taxonomy
 *   computeChunkBoundary()      — find natural break in a buffer
 *   ToolResultStreamer           — stateful stream processor
 *   adaptiveChunkSize()         — speed-based chunk sizing
 */

import { classifyOutputPattern, type OutputPattern } from "./tool-result-predictor.ts";

// ---------------------------------------------------------------------------
// Fine-grained output type taxonomy (superset of OutputPattern)
// ---------------------------------------------------------------------------

/**
 * Fine-grained stream output type.  More specific than the predictor's
 * OutputPattern because we have the actual bytes to inspect.
 */
export type StreamOutputType =
  | "bash_error"       // stderr / shell error with optional stack frames
  | "grep_results"     // file:line:content lines
  | "file_contents"    // source file with line-number prefix
  | "json_array"       // top-level JSON array
  | "json_object"      // top-level JSON object
  | "log_lines"        // timestamped / log-level prefixed lines
  | "code_block"       // ``` fenced block
  | "diff"             // unified diff / git diff
  | "file_listing"     // one path per line
  | "table"            // pipe-delimited table
  | "generic_text";    // fallback

// ---------------------------------------------------------------------------
// Chunk boundary types (what caused this chunk to be emitted)
// ---------------------------------------------------------------------------

export type ChunkBoundaryReason =
  | "line_break"       // individual log/grep line completed
  | "block_break"      // JSON/code/diff block closed
  | "function_boundary"// blank line after a function definition in code
  | "paragraph"        // double newline in plain text
  | "max_size"         // forced flush: buffer hit size limit
  | "finalize";        // stream ended

// ---------------------------------------------------------------------------
// Streamed chunk
// ---------------------------------------------------------------------------

export interface ToolResultChunk {
  /** Chunk text content. */
  text: string;
  /** Fine-grained output type detected for this chunk. */
  outputType: StreamOutputType;
  /** What triggered this chunk boundary. */
  boundaryReason: ChunkBoundaryReason;
  /** Monotonically increasing chunk index within this stream. */
  index: number;
  /** Whether this is the final chunk for the tool result. */
  isFinal: boolean;
  /** Total bytes emitted including this chunk. */
  cumulativeBytes: number;
  /**
   * Lazy-load indicator: when true the UI should render a "loading…"
   * placeholder until more chunks arrive.  Set on chunks that end mid-block
   * (e.g. JSON array not yet closed, diff hunk not yet complete).
   */
  pendingMore: boolean;
  /**
   * Optional compact summary for this chunk — generated when the chunk is
   * large enough to warrant a visual separator in the UI.
   */
  summary?: string;
}

// ---------------------------------------------------------------------------
// Classify stream output type from actual content
// ---------------------------------------------------------------------------

/**
 * Classify the fine-grained stream output type from the accumulated buffer.
 *
 * Inspects actual content, so it is more accurate than the pre-execution
 * classifyOutputPattern() which only uses tool name + input metadata.
 *
 * Checked top-to-bottom; first match wins.
 */
export function classifyStreamOutputType(text: string): StreamOutputType {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "generic_text";

  const lines = trimmed.split("\n");
  const lineCount = Math.max(1, lines.length);

  // Bash error / stderr: error keyword + optional stack frames
  const errorKeywords = lines.filter((l) =>
    /\b(Error|Exception|Traceback|panic:|fatal:|FAILED|stderr)\b/i.test(l)
  ).length;
  const stackFrames = lines.filter((l) => /^\s+(at |in )\S/.test(l)).length;
  if (errorKeywords > 0 && (stackFrames > 0 || errorKeywords / lineCount > 0.25)) {
    return "bash_error";
  }

  // Diff: unified diff headers
  if (/^(diff --git |--- a\/|\+\+\+ b\/|@@ )/m.test(trimmed)) return "diff";

  // Code block: ``` fence
  if (/^```/.test(trimmed) || trimmed.includes("\n```")) return "code_block";

  // JSON array
  if (/^\[/.test(trimmed)) {
    return "json_array";
  }

  // JSON object
  if (/^\{/.test(trimmed)) {
    return "json_object";
  }

  // Log lines: timestamp or log-level prefix on majority of lines
  const logLines = lines.filter((l) =>
    /^(\d{4}-\d{2}-\d{2}|\d{2}:\d{2}:\d{2}|\[(INFO|WARN|ERROR|DEBUG|TRACE)\])/i.test(l)
  ).length;
  if (logLines / lineCount > 0.35) return "log_lines";

  // Grep results: file:lineno:content
  const grepLines = lines.filter((l) => /^[^:\d][^:]*:\d+:/.test(l)).length;
  if (grepLines / lineCount > 0.4) return "grep_results";

  // File listing: absolute or relative paths
  const pathLines = lines.filter((l) =>
    /^(\/|\.\/|\.\.\/|[A-Za-z]:\\)/.test(l.trim())
  ).length;
  if (pathLines / lineCount > 0.45) return "file_listing";

  // File contents: line-number + tab/pipe prefix (Read tool output)
  const numberedLines = lines.filter((l) => /^\s*\d+\s*[\t|]/.test(l)).length;
  if (numberedLines / lineCount > 0.5) return "file_contents";

  // Table: pipe characters on majority of lines
  const tableLines = lines.filter((l) => /\|/.test(l) && l.trim().length > 0).length;
  if (tableLines / lineCount > 0.45) return "table";

  return "generic_text";
}

/**
 * Map a predictor OutputPattern to the streaming StreamOutputType.
 * Used when the buffer is too small for content-based classification.
 */
export function outputPatternToStreamType(pattern: OutputPattern): StreamOutputType {
  switch (pattern) {
    case "grep_results":    return "grep_results";
    case "file_listing":    return "file_listing";
    case "code_dump":       return "file_contents";
    case "stack_trace":     return "bash_error";
    case "config_file":     return "json_object";
    case "git_log":         return "diff";
    case "test_output":     return "log_lines";
    case "package_install": return "log_lines";
    case "write_confirm":   return "generic_text";
    case "generic_text":    return "generic_text";
    default:                return "generic_text";
  }
}

// ---------------------------------------------------------------------------
// Natural chunk boundary computation
// ---------------------------------------------------------------------------

/**
 * Find the end position of the next natural semantic chunk in `buffer`.
 *
 * Returns the character index (exclusive) where the chunk ends, or -1 if no
 * complete chunk boundary has been reached yet.
 *
 * Boundary semantics per type:
 *   bash_error / log_lines / grep_results / file_listing / file_contents
 *     → every newline is a complete unit (line-granularity)
 *   json_array / json_object
 *     → balanced braces/brackets (depth 0 after first open)
 *   diff
 *     → each "@@ …" hunk header line, or "diff --git …" file header
 *   code_block
 *     → closing ``` fence on its own line
 *   function_boundary (generic_text / file_contents)
 *     → blank line following a line that ends with "{" or ":"
 *   generic_text / table
 *     → paragraph boundary (double newline)
 */
export function computeChunkBoundary(
  buffer: string,
  outputType: StreamOutputType,
  maxSize: number
): { end: number; reason: ChunkBoundaryReason } | null {
  // Hard cap: always flush at maxSize regardless of semantic boundaries
  if (buffer.length >= maxSize) {
    // Try to snap to the last newline to avoid splitting mid-line
    const lastNl = buffer.lastIndexOf("\n");
    const end = lastNl > 0 ? lastNl + 1 : buffer.length;
    return { end, reason: "max_size" };
  }

  switch (outputType) {
    case "bash_error":
    case "log_lines":
    case "grep_results":
    case "file_listing": {
      // Each complete line is a unit
      const nl = buffer.indexOf("\n");
      if (nl >= 0) return { end: nl + 1, reason: "line_break" };
      return null;
    }

    case "file_contents": {
      // Emit line-by-line for numbered source output, but also detect
      // function boundaries (blank line after a "}" line)
      const lines = buffer.split("\n");
      let offset = 0;
      let prevLineWasClose = false;
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i]!;
        offset += line.length + 1; // +1 for \n
        const stripped = line.replace(/^\s*\d+\s*[\t|]\s*/, ""); // strip line number prefix
        if (prevLineWasClose && stripped.trim() === "") {
          return { end: offset, reason: "function_boundary" };
        }
        prevLineWasClose = /^\s*\}/.test(stripped) || stripped.trim() === "}";
      }
      // Fall back to line-by-line
      const nl = buffer.indexOf("\n");
      if (nl >= 0) return { end: nl + 1, reason: "line_break" };
      return null;
    }

    case "json_array":
    case "json_object": {
      // Balanced bracket/brace tracking
      let depth = 0;
      let inString = false;
      let escaped = false;
      let started = false;
      for (let i = 0; i < buffer.length; i++) {
        const ch = buffer[i]!;
        if (escaped) { escaped = false; continue; }
        if (ch === "\\" && inString) { escaped = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === "{" || ch === "[") { depth++; started = true; }
        else if (ch === "}" || ch === "]") {
          depth--;
          if (started && depth === 0) {
            return { end: i + 1, reason: "block_break" };
          }
        }
      }
      return null;
    }

    case "diff": {
      // Fire at each hunk header or file header line
      const lines = buffer.split("\n");
      let offset = 0;
      let foundBoundary = false;
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i]!;
        offset += line.length + 1;
        if (foundBoundary) {
          // Emit everything up to (but not including) this line as a chunk
          // so the boundary line leads the next chunk
          return { end: offset - line.length - 1, reason: "block_break" };
        }
        if (/^@@ /.test(line) || /^diff --git /.test(line)) {
          foundBoundary = true;
        }
      }
      // Paragraph fallback
      const doubleNl = buffer.indexOf("\n\n");
      if (doubleNl >= 0) return { end: doubleNl + 2, reason: "block_break" };
      return null;
    }

    case "code_block": {
      // Closing ``` on its own line
      const fenceMatch = buffer.match(/```\s*\n/);
      if (fenceMatch?.index !== undefined) {
        // Skip the opening fence, find the closing one
        const openEnd = buffer.indexOf("\n") + 1;
        const closeStart = buffer.indexOf("\n```", openEnd);
        if (closeStart >= 0) {
          const closeEnd = buffer.indexOf("\n", closeStart + 1);
          const end = closeEnd >= 0 ? closeEnd + 1 : buffer.length;
          return { end, reason: "block_break" };
        }
      }
      return null;
    }

    case "table":
    case "generic_text":
    default: {
      // Paragraph boundary: double newline
      const doubleNl = buffer.indexOf("\n\n");
      if (doubleNl >= 0) return { end: doubleNl + 2, reason: "paragraph" };
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Adaptive chunk sizing
// ---------------------------------------------------------------------------

/**
 * Adaptive chunk size controller.
 *
 * Tracks drain speed (bytes-per-millisecond the caller processes chunks) and
 * adjusts the target chunk size to keep the UI responsive:
 *   - Fast drain (high throughput) → larger chunks (less overhead, fewer callbacks)
 *   - Slow drain (UI backpressure) → smaller chunks (more progressive, better UX)
 */
export class AdaptiveChunkSizer {
  /** Minimum chunk size in characters (never go below this). */
  static readonly MIN_CHUNK_SIZE = 256;
  /** Maximum chunk size in characters. */
  static readonly MAX_CHUNK_SIZE = 8_192;
  /** Default starting chunk size. */
  static readonly DEFAULT_CHUNK_SIZE = 1_024;

  private _currentSize: number;
  private _drainTimings: number[] = []; // ms per chunk drain
  private _chunksSent = 0;
  private _lastChunkTime = 0;

  constructor(initialSize = AdaptiveChunkSizer.DEFAULT_CHUNK_SIZE) {
    this._currentSize = Math.max(
      AdaptiveChunkSizer.MIN_CHUNK_SIZE,
      Math.min(AdaptiveChunkSizer.MAX_CHUNK_SIZE, initialSize)
    );
  }

  /** Record that the caller drained a chunk of `bytes` in `durationMs` ms. */
  recordDrain(bytes: number, durationMs: number): void {
    if (durationMs <= 0 || bytes <= 0) return;
    const bytesPerMs = bytes / durationMs;
    this._drainTimings.push(bytesPerMs);
    // Keep the last 10 samples
    if (this._drainTimings.length > 10) this._drainTimings.shift();
    this._adapt();
  }

  /** Call when a chunk is about to be emitted. Records timing. */
  onChunkEmit(bytes: number): void {
    const now = Date.now();
    if (this._lastChunkTime > 0) {
      const durationMs = now - this._lastChunkTime;
      this.recordDrain(bytes, durationMs);
    }
    this._lastChunkTime = now;
    this._chunksSent++;
  }

  /** Current target chunk size in characters. */
  get currentSize(): number {
    return this._currentSize;
  }

  /** Total chunks emitted so far. */
  get chunksSent(): number {
    return this._chunksSent;
  }

  private _adapt(): void {
    if (this._drainTimings.length < 3) return;
    const meanBytesPerMs =
      this._drainTimings.reduce((s, v) => s + v, 0) / this._drainTimings.length;

    // Target: emit chunks at ~60fps (16ms per chunk) → target bytes = rate × 16ms
    const targetBytes = Math.round(meanBytesPerMs * 16);
    const clamped = Math.max(
      AdaptiveChunkSizer.MIN_CHUNK_SIZE,
      Math.min(AdaptiveChunkSizer.MAX_CHUNK_SIZE, targetBytes)
    );
    // Smooth: move 25% toward the target each adaptation
    this._currentSize = Math.round(this._currentSize * 0.75 + clamped * 0.25);
  }

  /** Reset timing history (for testing). */
  reset(): void {
    this._drainTimings = [];
    this._chunksSent = 0;
    this._lastChunkTime = 0;
    this._currentSize = AdaptiveChunkSizer.DEFAULT_CHUNK_SIZE;
  }
}

// ---------------------------------------------------------------------------
// Chunk summary generator
// ---------------------------------------------------------------------------

/**
 * Generate a compact inline summary for a chunk to show as a visual separator
 * in the UI between lazy-loaded sections.
 *
 * Returns undefined when the chunk is too small to warrant a separator.
 */
export function generateChunkSummary(
  chunk: ToolResultChunk,
  minSizeForSummary = 512
): string | undefined {
  if (chunk.text.length < minSizeForSummary) return undefined;

  const lines = chunk.text.split("\n").filter((l) => l.trim().length > 0);
  const byteCount = new TextEncoder().encode(chunk.text).length;
  const kb = (byteCount / 1024).toFixed(1);

  switch (chunk.outputType) {
    case "grep_results": {
      const files = new Set(lines.map((l) => l.split(":")[0] ?? "")).size;
      return `[grep: ${lines.length} match(es) across ${files} file(s), ${kb} KB]`;
    }
    case "file_listing": {
      return `[listing: ${lines.length} path(s), ${kb} KB]`;
    }
    case "file_contents": {
      return `[file: ${lines.length} line(s), ${kb} KB]`;
    }
    case "json_array": {
      try {
        const parsed = JSON.parse(chunk.text);
        if (Array.isArray(parsed)) {
          const errCount = parsed.filter(
            (item: unknown) =>
              typeof item === "object" &&
              item !== null &&
              ("error" in (item as object) || "status" in (item as object) &&
                (item as Record<string, unknown>)["status"] >= 400)
          ).length;
          return `[json array: ${parsed.length} item(s)${errCount > 0 ? `, ${errCount} error(s)` : ""}, ${kb} KB]`;
        }
      } catch { /* partial */ }
      return `[json array: ${lines.length} line(s), ${kb} KB]`;
    }
    case "json_object": {
      try {
        const parsed = JSON.parse(chunk.text) as Record<string, unknown>;
        const keys = Object.keys(parsed);
        return `[json object: ${keys.length} key(s) (${keys.slice(0, 3).join(", ")}${keys.length > 3 ? "…" : ""}), ${kb} KB]`;
      } catch { /* partial */ }
      return `[json object: ${lines.length} line(s), ${kb} KB]`;
    }
    case "diff": {
      const added = (chunk.text.match(/^\+[^+]/gm) ?? []).length;
      const removed = (chunk.text.match(/^-[^-]/gm) ?? []).length;
      const files = (chunk.text.match(/^diff --git /gm) ?? []).length;
      if (files > 0) return `[diff: ${files} file(s), +${added}/-${removed} lines, ${kb} KB]`;
      return `[diff hunk: +${added}/-${removed} lines, ${kb} KB]`;
    }
    case "bash_error": {
      const errorLine = lines.find((l) =>
        /\b(Error|Exception|Traceback|fatal:|panic:)\b/i.test(l)
      );
      const frames = lines.filter((l) => /^\s+(at |in )\S/.test(l)).length;
      const msg = errorLine?.slice(0, 60) ?? "error";
      return `[error: "${msg}"${frames > 0 ? `, ${frames} frame(s)` : ""}, ${kb} KB]`;
    }
    case "log_lines": {
      return `[log: ${lines.length} line(s), ${kb} KB]`;
    }
    default:
      return `[${chunk.outputType}: ${lines.length} line(s), ${kb} KB]`;
  }
}

// ---------------------------------------------------------------------------
// ToolResultStreamer — main class
// ---------------------------------------------------------------------------

export interface ToolResultStreamerOptions {
  /**
   * Tool name used for pre-execution pattern classification when the buffer
   * is not yet large enough for content-based detection.
   */
  toolName: string;

  /**
   * Tool input — passed to classifyOutputPattern() for initial hint.
   */
  toolInput: Record<string, unknown>;

  /**
   * Called synchronously for each emitted chunk.
   * This is the primary integration point for tool-executor.ts.
   */
  onToolResultChunk: (chunk: ToolResultChunk) => void;

  /**
   * Initial chunk size in characters.  Adaptive sizing will adjust from here.
   * Defaults to AdaptiveChunkSizer.DEFAULT_CHUNK_SIZE.
   */
  initialChunkSize?: number;

  /**
   * Minimum chunk size in characters below which line-boundary chunks are
   * held until the buffer reaches this threshold (prevents micro-flushing
   * for log/grep types).
   * Default: 64 characters.
   */
  minChunkSize?: number;

  /**
   * When true, generate a compact summary for chunks ≥ summaryThreshold bytes.
   * Default: true.
   */
  enableSummaries?: boolean;

  /**
   * Minimum chunk byte size to trigger summary generation.
   * Default: 512 bytes.
   */
  summaryThreshold?: number;
}

/**
 * Stateful stream processor that chunks a tool result into semantic units.
 *
 * Usage:
 *   const streamer = new ToolResultStreamer({ toolName, toolInput, onToolResultChunk });
 *   streamer.push(rawResult);   // or push incrementally
 *   streamer.finalize();
 */
export class ToolResultStreamer {
  private _buffer = "";
  private _chunkIndex = 0;
  private _cumulativeBytes = 0;
  private _finalized = false;
  private _outputType: StreamOutputType | null = null;
  private _sizer: AdaptiveChunkSizer;
  private _encoder = new TextEncoder();

  private readonly _toolName: string;
  private readonly _toolInput: Record<string, unknown>;
  private readonly _onChunk: (chunk: ToolResultChunk) => void;
  private readonly _minChunkSize: number;
  private readonly _enableSummaries: boolean;
  private readonly _summaryThreshold: number;

  constructor(opts: ToolResultStreamerOptions) {
    this._toolName = opts.toolName;
    this._toolInput = opts.toolInput;
    this._onChunk = opts.onToolResultChunk;
    this._minChunkSize = opts.minChunkSize ?? 64;
    this._enableSummaries = opts.enableSummaries ?? true;
    this._summaryThreshold = opts.summaryThreshold ?? 512;
    this._sizer = new AdaptiveChunkSizer(opts.initialChunkSize);

    // Pre-warm output type from predictor hint (may be overridden once we have content)
    const pattern = classifyOutputPattern(this._toolName, this._toolInput);
    this._outputType = outputPatternToStreamType(pattern);
  }

  /**
   * Feed text into the streamer.  Can be called once (for complete results)
   * or incrementally (for true streaming).
   */
  push(text: string): void {
    if (this._finalized) {
      throw new Error("ToolResultStreamer: push() after finalize()");
    }
    if (text.length === 0) return;

    this._buffer += text;

    // Re-classify output type from actual content once we have enough
    if (this._buffer.length >= 128) {
      this._outputType = classifyStreamOutputType(this._buffer);
    }

    this._drain();
  }

  /**
   * Flush remaining buffer and mark the stream complete.
   * Must be called exactly once after all push() calls.
   */
  finalize(): void {
    if (this._finalized) {
      throw new Error("ToolResultStreamer: finalize() called more than once");
    }
    this._finalized = true;

    if (this._buffer.length > 0) {
      this._emitChunk(this._buffer, "finalize", true);
      this._buffer = "";
    }
  }

  /** Current detected output type (may be null before enough data is buffered). */
  get outputType(): StreamOutputType | null {
    return this._outputType;
  }

  /** Number of chunks emitted so far. */
  get chunkCount(): number {
    return this._chunkIndex;
  }

  /** Total bytes emitted (across all chunks). */
  get cumulativeBytes(): number {
    return this._cumulativeBytes;
  }

  /** The adaptive chunk sizer (for inspection/testing). */
  get sizer(): AdaptiveChunkSizer {
    return this._sizer;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _drain(): void {
    const outputType = this._outputType ?? "generic_text";
    const maxSize = this._sizer.currentSize;

    // Keep draining until no more complete semantic boundaries
    let iterations = 0;
    while (this._buffer.length > 0 && iterations++ < 1000) {
      const boundary = computeChunkBoundary(this._buffer, outputType, maxSize);
      if (!boundary) break;

      // Respect minChunkSize for line-granularity types to prevent micro-flushes
      if (
        boundary.reason === "line_break" &&
        boundary.end < this._minChunkSize &&
        this._buffer.length < maxSize
      ) {
        break;
      }

      const text = this._buffer.slice(0, boundary.end);
      this._buffer = this._buffer.slice(boundary.end);
      this._emitChunk(text, boundary.reason, false);
    }
  }

  private _emitChunk(
    text: string,
    reason: ChunkBoundaryReason,
    isFinal: boolean
  ): void {
    const bytes = this._encoder.encode(text).length;
    this._cumulativeBytes += bytes;
    this._sizer.onChunkEmit(bytes);

    const outputType = this._outputType ?? "generic_text";

    const chunk: ToolResultChunk = {
      text,
      outputType,
      boundaryReason: reason,
      index: this._chunkIndex++,
      isFinal,
      cumulativeBytes: this._cumulativeBytes,
      pendingMore: !isFinal && this._buffer.length > 0,
      summary: undefined,
    };

    // Attach summary if enabled and chunk is large enough
    if (this._enableSummaries) {
      chunk.summary = generateChunkSummary(chunk, this._summaryThreshold);
    }

    this._onChunk(chunk);
  }
}

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

/**
 * Create a ToolResultStreamer that collects all chunks into an array.
 * Useful for tests and offline processing.
 */
export function createCollectingStreamer(
  toolName: string,
  toolInput: Record<string, unknown>,
  opts?: Partial<Omit<ToolResultStreamerOptions, "toolName" | "toolInput" | "onToolResultChunk">>
): { streamer: ToolResultStreamer; chunks: ToolResultChunk[] } {
  const chunks: ToolResultChunk[] = [];
  const streamer = new ToolResultStreamer({
    toolName,
    toolInput,
    onToolResultChunk: (chunk) => chunks.push(chunk),
    ...opts,
  });
  return { streamer, chunks };
}

/**
 * Process a complete tool result string through the streamer and return all
 * emitted chunks.  Convenience wrapper for single-pass use.
 */
export function streamToolResult(
  toolName: string,
  toolInput: Record<string, unknown>,
  result: string,
  onChunk: (chunk: ToolResultChunk) => void,
  opts?: Partial<Omit<ToolResultStreamerOptions, "toolName" | "toolInput" | "onToolResultChunk">>
): ToolResultChunk[] {
  const chunks: ToolResultChunk[] = [];
  const streamer = new ToolResultStreamer({
    toolName,
    toolInput,
    onToolResultChunk: (chunk) => {
      chunks.push(chunk);
      onChunk(chunk);
    },
    ...opts,
  });
  streamer.push(result);
  streamer.finalize();
  return chunks;
}
