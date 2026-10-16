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
import {
  OutputClassifier,
  SemanticsAwareChunker,
  findPausePoint,
  type SemanticType,
  type SemanticChunk,
} from "./output-classifier.ts";

// Re-export so callers can use semantic primitives from this module too
export {
  OutputClassifier,
  SemanticsAwareChunker,
  findPausePoint,
  type SemanticType,
  type SemanticChunk,
} from "./output-classifier.ts";

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
  /** Semantic classifier — drives domain-specific pause-point selection. */
  private _classifier: OutputClassifier;

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

    // Pre-warm semantic classifier from tool metadata
    this._classifier = new OutputClassifier(this._toolName, this._toolInput);
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
      // Also refine the semantic classifier from content
      this._classifier.refine(this._buffer);
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

  /** The semantic output classifier (for inspection/testing). */
  get classifier(): OutputClassifier {
    return this._classifier;
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
      // Prefer semantic pause-point from OutputClassifier when classifier is
      // refined (has seen real content) — these boundaries are domain-aware
      // (e.g. grep file sections, diff hunks, test-case lines, JSON depth-0).
      // Fall back to computeChunkBoundary() for pre-refinement phase.
      let boundary: { end: number; reason: ChunkBoundaryReason } | null = null;

      if (this._classifier.isRefined) {
        const pp = findPausePoint(this._buffer, this._classifier.semanticType, maxSize);
        if (pp) {
          boundary = {
            end: pp.end,
            reason: _pausePointReasonToChunkBoundary(pp.reason),
          };
        }
      }

      if (!boundary) {
        boundary = computeChunkBoundary(this._buffer, outputType, maxSize);
      }

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
// Pause-point reason → ChunkBoundaryReason mapper
// ---------------------------------------------------------------------------

/**
 * Map a semantic pause-point reason string (from findPausePoint) to the
 * existing ChunkBoundaryReason enum so ToolResultChunk.boundaryReason
 * stays typed consistently.
 */
function _pausePointReasonToChunkBoundary(reason: string): ChunkBoundaryReason {
  switch (reason) {
    case "json_close":           return "block_break";
    case "test_case":            return "line_break";
    case "grep_file_section":    return "block_break";
    case "diff_hunk":            return "block_break";
    case "line_break":           return "line_break";
    case "paragraph":            return "paragraph";
    case "max_size":             return "max_size";
    case "finalize":             return "finalize";
    case "function_boundary":    return "function_boundary";
    default:                     return "line_break";
  }
}

// ---------------------------------------------------------------------------
// Output type auto-detection from tool metadata
// ---------------------------------------------------------------------------

/**
 * Auto-detect the expected StreamOutputType from tool name and input metadata,
 * before any content is available.  Used by the UI to pick the right renderer
 * before the first chunk arrives.
 */
export function detectOutputTypeFromMeta(
  toolName: string,
  toolInput: Record<string, unknown>
): StreamOutputType {
  const name = toolName.toLowerCase();
  if (name === "grep" || name === "search") return "grep_results";
  if (name === "bash" || name === "shell") {
    const cmd = String(toolInput.command ?? "");
    if (/^\s*(cat|head|tail|less)\s/.test(cmd)) return "file_contents";
    if (/^\s*(ls|find|fd)\s/.test(cmd)) return "file_listing";
    if (/^\s*(curl|wget|http)\s/.test(cmd)) return "json_object";
    if (/^\s*(git diff|git show)\s/.test(cmd)) return "diff";
    if (/^\s*(git log|npm|bun|yarn|pip)\s/.test(cmd)) return "log_lines";
    return "generic_text";
  }
  if (name === "read" || name === "fileread") return "file_contents";
  if (name === "glob" || name === "ls" || name === "listfiles") return "file_listing";
  if (name === "webfetch" || name === "fetch") return "json_object";
  if (name === "websearch") return "generic_text";
  if (name === "diff") return "diff";
  return "generic_text";
}

// ---------------------------------------------------------------------------
// JSON tree rendering
// ---------------------------------------------------------------------------

export interface JsonTreeNode {
  key: string;
  value: unknown;
  depth: number;
  isLeaf: boolean;
  /** Pre-formatted display string for this node */
  displayLine: string;
  /** Child nodes (only populated when !isLeaf) */
  children: JsonTreeNode[];
}

/**
 * Build a flat list of JsonTreeNodes from a parsed JSON value.
 * Each node carries its depth and a pre-formatted display line.
 *
 * @param value   - Parsed JSON value (any type)
 * @param key     - Key name for this node ("root" at top level)
 * @param depth   - Current nesting depth
 * @param maxDepth - Stop expanding beyond this depth (default: 4)
 */
export function buildJsonTree(
  value: unknown,
  key = "root",
  depth = 0,
  maxDepth = 4
): JsonTreeNode {
  const indent = "  ".repeat(depth);

  if (value === null) {
    return { key, value, depth, isLeaf: true, displayLine: `${indent}${key}: null`, children: [] };
  }

  if (Array.isArray(value)) {
    if (depth >= maxDepth || value.length === 0) {
      return {
        key,
        value,
        depth,
        isLeaf: true,
        displayLine: `${indent}${key}: [${value.length} item${value.length !== 1 ? "s" : ""}]`,
        children: [],
      };
    }
    const children = value.slice(0, 50).map((item, i) =>
      buildJsonTree(item, `[${i}]`, depth + 1, maxDepth)
    );
    const truncated = value.length > 50;
    return {
      key,
      value,
      depth,
      isLeaf: false,
      displayLine: `${indent}${key}: [ (${value.length} item${value.length !== 1 ? "s" : ""})`,
      children: truncated
        ? [
            ...children,
            {
              key: "...",
              value: null,
              depth: depth + 1,
              isLeaf: true,
              displayLine: `${"  ".repeat(depth + 1)}... ${value.length - 50} more items`,
              children: [],
            },
          ]
        : children,
    };
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (depth >= maxDepth || entries.length === 0) {
      return {
        key,
        value,
        depth,
        isLeaf: true,
        displayLine: `${indent}${key}: {${entries.length} key${entries.length !== 1 ? "s" : ""}}`,
        children: [],
      };
    }
    const children = entries.slice(0, 50).map(([k, v]) =>
      buildJsonTree(v, k, depth + 1, maxDepth)
    );
    const truncated = entries.length > 50;
    return {
      key,
      value,
      depth,
      isLeaf: false,
      displayLine: `${indent}${key}: {`,
      children: truncated
        ? [
            ...children,
            {
              key: "...",
              value: null,
              depth: depth + 1,
              isLeaf: true,
              displayLine: `${"  ".repeat(depth + 1)}... ${entries.length - 50} more keys`,
              children: [],
            },
          ]
        : children,
    };
  }

  // Primitive value
  let displayValue: string;
  if (typeof value === "string") {
    displayValue = value.length > 120 ? `"${value.slice(0, 120)}…"` : `"${value}"`;
  } else {
    displayValue = String(value);
  }
  return {
    key,
    value,
    depth,
    isLeaf: true,
    displayLine: `${indent}${key}: ${displayValue}`,
    children: [],
  };
}

/**
 * Flatten a JsonTreeNode tree into an ordered array of display lines.
 * Respects collapsed state — collapsed nodes emit only their own line.
 *
 * @param node        - Root node
 * @param collapsed   - Set of node paths (key@depth) that are collapsed
 * @param path        - Internal recursion path accumulator
 */
export function flattenJsonTree(
  node: JsonTreeNode,
  collapsed: Set<string> = new Set(),
  path = ""
): string[] {
  const nodePath = path ? `${path}.${node.key}` : node.key;
  const lines: string[] = [node.displayLine];

  if (!node.isLeaf && !collapsed.has(nodePath)) {
    for (const child of node.children) {
      lines.push(...flattenJsonTree(child, collapsed, nodePath));
    }
    // Closing brace/bracket
    const indent = "  ".repeat(node.depth);
    const firstChar = node.displayLine.trimEnd().slice(-1);
    if (firstChar === "{") lines.push(`${indent}}`);
    else if (firstChar === "(") lines.push(`${indent}]`);
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Tabular data rendering
// ---------------------------------------------------------------------------

export interface TableRow {
  cells: string[];
}

export interface ParsedTable {
  headers: string[];
  rows: TableRow[];
  /** Column widths (max content width per column) */
  columnWidths: number[];
}

/**
 * Parse tabular text into a structured ParsedTable.
 *
 * Handles two common formats:
 *   1. Pipe-delimited: "col1 | col2 | col3"
 *   2. CSV-style: "col1,col2,col3" (only when no pipes found)
 *   3. JSON array-of-objects: [{k:v}, ...] — each object becomes a row
 */
export function parseTableData(text: string): ParsedTable | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // JSON array-of-objects
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === "object" && parsed[0] !== null) {
        const headers = Object.keys(parsed[0] as Record<string, unknown>);
        const rows: TableRow[] = parsed.map((item: unknown) => ({
          cells: headers.map((h) => {
            const val = (item as Record<string, unknown>)[h];
            return val === null || val === undefined ? "" : String(val);
          }),
        }));
        const columnWidths = headers.map((h, i) =>
          Math.max(h.length, ...rows.map((r) => r.cells[i]?.length ?? 0))
        );
        return { headers, rows, columnWidths };
      }
    } catch {
      // fall through to text parsing
    }
  }

  const lines = trimmed.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length < 2) return null;

  // Pipe-delimited
  const hasPipes = lines.filter((l) => l.includes("|")).length / lines.length > 0.5;
  if (hasPipes) {
    const parseLine = (l: string): string[] =>
      l.split("|").map((c) => c.trim()).filter((_, i, arr) =>
        // Drop empty leading/trailing cells from "| a | b |" format
        !(i === 0 && arr[0] === "") && !(i === arr.length - 1 && arr[arr.length - 1] === "")
      );

    const [headerLine, ...rest] = lines;
    const headers = parseLine(headerLine!);

    // Skip separator line (e.g. "---|---|---")
    const dataLines = rest.filter((l) => !/^[-| :]+$/.test(l.trim()));
    const rows: TableRow[] = dataLines.map((l) => ({
      cells: parseLine(l),
    }));

    if (headers.length === 0) return null;
    const columnWidths = headers.map((h, i) =>
      Math.max(h.length, ...rows.map((r) => r.cells[i]?.length ?? 0))
    );
    return { headers, rows, columnWidths };
  }

  // CSV-style (comma-separated)
  const hasCommas = lines.filter((l) => l.includes(",")).length / lines.length > 0.5;
  if (hasCommas) {
    const parseCsvLine = (l: string): string[] => l.split(",").map((c) => c.trim());
    const [headerLine, ...rest] = lines;
    const headers = parseCsvLine(headerLine!);
    const rows: TableRow[] = rest.map((l) => ({ cells: parseCsvLine(l) }));
    if (headers.length < 2) return null;
    const columnWidths = headers.map((h, i) =>
      Math.max(h.length, ...rows.map((r) => r.cells[i]?.length ?? 0))
    );
    return { headers, rows, columnWidths };
  }

  return null;
}

/**
 * Render a ParsedTable to aligned column strings for terminal display.
 *
 * Returns an array of formatted lines:
 *   - Header row with column names padded to columnWidths
 *   - Separator line
 *   - Data rows, each cell right-padded
 *
 * @param table       - Parsed table structure
 * @param maxRows     - Truncate to this many data rows (default: 50)
 * @param sortCol     - Optional 0-based column index to sort by
 * @param sortAsc     - Sort ascending when true (default: true)
 */
export function renderTable(
  table: ParsedTable,
  maxRows = 50,
  sortCol?: number,
  sortAsc = true
): string[] {
  const lines: string[] = [];
  const { headers, columnWidths } = table;

  let rows = [...table.rows];

  // Sort if requested
  if (sortCol !== undefined && sortCol >= 0 && sortCol < headers.length) {
    rows.sort((a, b) => {
      const av = a.cells[sortCol] ?? "";
      const bv = b.cells[sortCol] ?? "";
      // Numeric sort when both cells are numeric
      const an = Number(av);
      const bn = Number(bv);
      if (!isNaN(an) && !isNaN(bn)) {
        return sortAsc ? an - bn : bn - an;
      }
      return sortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
    });
  }

  const truncated = rows.length > maxRows;
  if (truncated) rows = rows.slice(0, maxRows);

  // Header
  const headerLine = headers.map((h, i) => h.padEnd(columnWidths[i] ?? h.length)).join("  ");
  lines.push(headerLine);

  // Separator
  lines.push(headers.map((_, i) => "-".repeat(columnWidths[i] ?? 1)).join("  "));

  // Rows
  for (const row of rows) {
    const rowLine = headers.map((_, i) => {
      const cell = row.cells[i] ?? "";
      return cell.padEnd(columnWidths[i] ?? cell.length);
    }).join("  ");
    lines.push(rowLine);
  }

  if (truncated) {
    lines.push(`... ${table.rows.length - maxRows} more rows`);
  }

  // Sort/filter hints
  const hints: string[] = [];
  if (sortCol !== undefined) {
    hints.push(`sorted by "${headers[sortCol] ?? sortCol}" ${sortAsc ? "asc" : "desc"}`);
  }
  hints.push(`${table.rows.length} row${table.rows.length !== 1 ? "s" : ""}, ${headers.length} col${headers.length !== 1 ? "s" : ""}`);
  lines.push(`[${hints.join(" · ")}]`);

  return lines;
}

// ---------------------------------------------------------------------------
// Log pagination
// ---------------------------------------------------------------------------

export interface LogPage {
  /** Lines visible on this page */
  lines: string[];
  /** 0-based page index */
  pageIndex: number;
  /** Total number of pages */
  totalPages: number;
  /** Total number of lines across all pages */
  totalLines: number;
  /** Whether there are more pages after this one */
  hasMore: boolean;
}

/**
 * Paginate a multi-line log/bash output into fixed-size pages.
 *
 * Lines longer than `wrapWidth` are wrapped at word boundaries.
 *
 * @param text       - Raw output string
 * @param pageSize   - Lines per page (default: 40)
 * @param wrapWidth  - Character width for line wrapping (default: 120)
 */
export function paginateLog(
  text: string,
  pageSize = 40,
  wrapWidth = 120
): LogPage[] {
  // Wrap long lines first
  const rawLines = text.split("\n");
  const wrappedLines: string[] = [];
  for (const line of rawLines) {
    if (line.length <= wrapWidth) {
      wrappedLines.push(line);
    } else {
      // Word-wrap at wrapWidth
      let remaining = line;
      while (remaining.length > wrapWidth) {
        // Find last space before wrapWidth
        const cut = remaining.lastIndexOf(" ", wrapWidth);
        const breakAt = cut > 0 ? cut : wrapWidth;
        wrappedLines.push(remaining.slice(0, breakAt));
        remaining = remaining.slice(breakAt).trimStart();
      }
      if (remaining.length > 0) wrappedLines.push(remaining);
    }
  }

  const totalLines = wrappedLines.length;
  const totalPages = Math.max(1, Math.ceil(totalLines / pageSize));
  const pages: LogPage[] = [];

  for (let i = 0; i < totalPages; i++) {
    const start = i * pageSize;
    const end = Math.min(start + pageSize, totalLines);
    pages.push({
      lines: wrappedLines.slice(start, end),
      pageIndex: i,
      totalPages,
      totalLines,
      hasMore: i < totalPages - 1,
    });
  }

  // Always return at least one (empty) page
  if (pages.length === 0) {
    pages.push({ lines: [], pageIndex: 0, totalPages: 1, totalLines: 0, hasMore: false });
  }

  return pages;
}

/**
 * Get a single page from a log string.  Convenience wrapper around paginateLog().
 */
export function getLogPage(
  text: string,
  pageIndex: number,
  pageSize = 40,
  wrapWidth = 120
): LogPage {
  const pages = paginateLog(text, pageSize, wrapWidth);
  return pages[Math.max(0, Math.min(pageIndex, pages.length - 1))]!;
}

// ---------------------------------------------------------------------------
// Semantic pause-point / resume signal
// ---------------------------------------------------------------------------

/**
 * A semantic pause point emitted when the buffer fills past a threshold.
 * The UI shows a "[more...]" indicator and waits for a resume signal.
 */
export interface PausePoint {
  /** Cumulative bytes received when this pause occurred */
  bytesReceived: number;
  /** Number of chunks emitted before this pause */
  chunksEmitted: number;
  /** A compact human-readable summary for the "[more...]" indicator */
  label: string;
}

/**
 * Resume signal sent by the UI to the streamer to continue emitting chunks.
 * The UI creates one of these and calls streamer.resume() with it.
 */
export interface ResumeSignal {
  /** Whether to resume streaming (false = cancel) */
  continue: boolean;
  /** Optional max additional chunks to emit before pausing again */
  maxChunks?: number;
}

/** Default buffer fill threshold before a pause point is emitted (bytes). */
export const DEFAULT_PAUSE_THRESHOLD = 4_096;

/**
 * Build the label for a pause point given output type and chunk count.
 */
export function buildPauseLabel(
  outputType: StreamOutputType,
  chunksEmitted: number,
  bytesReceived: number
): string {
  const kb = (bytesReceived / 1024).toFixed(1);
  const typeLabel: Record<StreamOutputType, string> = {
    bash_error: "errors",
    grep_results: "matches",
    file_contents: "lines",
    json_array: "JSON items",
    json_object: "JSON",
    log_lines: "log lines",
    code_block: "code",
    diff: "diff hunks",
    file_listing: "paths",
    table: "table rows",
    generic_text: "text",
  };
  const label = typeLabel[outputType] ?? "output";
  return `[more... ${kb} KB of ${label} — press Enter to continue]`;
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
