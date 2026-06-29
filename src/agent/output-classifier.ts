/**
 * OutputClassifier — map (toolName, toolInput) → SemanticType
 *
 * Provides a unified semantic taxonomy for tool outputs that drives
 * SemanticsAwareChunker's pause-point rules.  The classifier combines
 * two signals:
 *
 *   1. Pre-execution hint — derived from tool name + input metadata only
 *      (available before the tool runs, mirrors tool-result-predictor.ts).
 *   2. Content-based refinement — inspects actual bytes to upgrade/correct
 *      the pre-execution hint once ≥ 128 chars of output are available.
 *
 * SemanticType → chunk boundary strategy:
 *   json_struct   : pause after each balanced `}` or `]` at depth 0
 *   test_output   : pause after each test-case result line (ok/FAIL/✓/✗)
 *   grep_matches  : pause after each file-section boundary (file change)
 *   diff_output   : pause after each hunk (`@@ … @@`) or file header
 *   log_stream    : pause after every complete line (line-granularity)
 *   generic       : paragraph boundary (double newline), fallback
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Domain-specific semantic type for a tool's output.
 * Drives SemanticsAwareChunker's pause-point strategy.
 */
export type SemanticType =
  | "json_struct"    // JSON object or array — chunk at depth-0 close
  | "test_output"    // test runner output — chunk after each test case line
  | "grep_matches"   // grep/ripgrep results — chunk at each file-section boundary
  | "diff_output"    // unified diff — chunk after each hunk or file header
  | "log_stream"     // timestamped / log-level lines — line granularity
  | "generic";       // fallback — paragraph boundary

// ---------------------------------------------------------------------------
// Pre-execution classifier (tool name + input → SemanticType)
// ---------------------------------------------------------------------------

/**
 * Classify the expected SemanticType from tool name and input metadata,
 * before any output is available.  Used to pre-configure the chunker.
 *
 * Checked top-to-bottom; first match wins.
 */
export function classifyFromMeta(
  toolName: string,
  input: Record<string, unknown>
): SemanticType {
  const name = toolName.toLowerCase();
  const inputText = Object.values(input)
    .map((v) => (typeof v === "string" ? v : JSON.stringify(v)))
    .join(" ");

  // Dedicated grep / search tools
  if (/^(grep|rg|ripgrep|search|find_in_files)/i.test(name)) {
    return "grep_matches";
  }

  // Dedicated diff tool
  if (/^diff$/i.test(name)) return "diff_output";

  // Dedicated test runner tools
  if (/^(test|spec|run_tests?|check)$/i.test(name)) return "test_output";

  // Bash / shell — inspect the command
  if (/^(bash|shell|run|exec)$/i.test(name)) {
    // Diff commands
    if (/\bgit\s+(diff|show|blame)\b/i.test(inputText)) return "diff_output";
    // Test runners
    if (/\b(jest|vitest|bun\s+test|pytest|go\s+test|cargo\s+test|mocha|jasmine|ava)\b/i.test(inputText)) {
      return "test_output";
    }
    // Grep commands
    if (/\b(grep|rg|ripgrep)\b/i.test(inputText)) return "grep_matches";
    // Structured output commands (curl, http, jq)
    if (/\b(curl|wget|http|jq)\b/i.test(inputText)) return "json_struct";
    // Log tailing
    if (/\b(tail|journalctl|logcat|dmesg)\b/i.test(inputText)) return "log_stream";
    return "generic";
  }

  // Read / view / open tools — classify by file extension
  if (/^(read|view|open|file_read|cat)$/i.test(name)) {
    const path = String(input.file_path ?? input.path ?? "");
    if (/\.(json|jsonl|ndjson|yaml|yml|toml)\b/i.test(path)) return "json_struct";
    if (/\.(patch|diff)\b/i.test(path)) return "diff_output";
    if (/\.(log|out|err)\b/i.test(path)) return "log_stream";
    return "generic";
  }

  // WebFetch / HTTP tools often return JSON
  if (/^(webfetch|fetch|http_get|http_post)$/i.test(name)) return "json_struct";

  return "generic";
}

// ---------------------------------------------------------------------------
// Content-based classifier (actual bytes → SemanticType)
// ---------------------------------------------------------------------------

/**
 * Classify SemanticType from actual output content.
 * More accurate than classifyFromMeta() because it inspects bytes.
 * Should only be called once ≥ 128 chars are available.
 *
 * Checked top-to-bottom; first match wins.
 */
export function classifyFromContent(text: string): SemanticType {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "generic";

  const lines = trimmed.split("\n");
  const lineCount = Math.max(1, lines.length);

  // Unified diff: must have diff/--- /+++ /@@ markers
  if (/^(diff --git |--- a\/|\+\+\+ b\/|@@ )/m.test(trimmed)) return "diff_output";

  // JSON: starts with { or [
  if (/^[\[{]/.test(trimmed)) return "json_struct";

  // Test output: test runner result lines (TAP, Jest, Vitest, pytest, Go test)
  const testPassLines = lines.filter((l) =>
    /^(ok\s+|PASS\s+|FAIL\s+|✓|✗|×|●|passing|failing|\s*(PASS|FAIL|ERROR)\s+[\w./-]+|\s*\d+\s+(passed|failed|pending|skipped))/.test(l)
    || /^\s*(✔|✘|√|×)\s/.test(l)
    || /^(TAP version|\d+\.\.\d+|ok \d+|not ok \d+)/.test(l)
    || /^---\s+FAIL:/.test(l)
  ).length;
  if (testPassLines > 0 && testPassLines / lineCount > 0.05) return "test_output";

  // Also catch pytest-style output
  const pytestLines = lines.filter((l) =>
    /^(PASSED|FAILED|ERROR|SKIPPED)\s+/.test(l)
    || /^(test_\w+|Test\w+)\s+\.\.\.\s+(PASSED|FAILED)/.test(l)
    || /^\s*\d+ (passed|failed|error)/.test(l)
  ).length;
  if (pytestLines > 0) return "test_output";

  // Grep results: file:lineno:content format on majority of lines
  const grepLines = lines.filter((l) => /^[^:\d][^:]*:\d+:/.test(l)).length;
  if (grepLines / lineCount > 0.4) return "grep_matches";

  // Log lines: timestamp or log-level prefix on majority of lines
  const logLines = lines.filter((l) =>
    /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}|\d{2}:\d{2}:\d{2}|\[(INFO|WARN|ERROR|DEBUG|TRACE|FATAL)\])/i.test(l)
    || /^(INFO|WARN|ERROR|DEBUG|TRACE|FATAL)\s*[:|\s]/i.test(l)
  ).length;
  if (logLines / lineCount > 0.35) return "log_stream";

  return "generic";
}

// ---------------------------------------------------------------------------
// OutputClassifier — combines pre-execution + content signals
// ---------------------------------------------------------------------------

/**
 * Stateful classifier that starts with a pre-execution hint and refines it
 * once enough content is accumulated.
 *
 * Usage:
 *   const classifier = new OutputClassifier(toolName, toolInput);
 *   // As content arrives:
 *   classifier.refine(accumulatedText);
 *   const type = classifier.semanticType;
 */
export class OutputClassifier {
  private _semanticType: SemanticType;
  private _refined = false;

  /** Minimum content length (chars) before content-based refinement is attempted. */
  static readonly REFINE_THRESHOLD = 128;

  constructor(toolName: string, toolInput: Record<string, unknown>) {
    this._semanticType = classifyFromMeta(toolName, toolInput);
  }

  /**
   * Attempt content-based refinement using accumulated output.
   * Once refined, subsequent calls are no-ops (refinement is stable).
   *
   * @param accumulatedText - Full output accumulated so far.
   */
  refine(accumulatedText: string): void {
    if (this._refined) return;
    if (accumulatedText.length < OutputClassifier.REFINE_THRESHOLD) return;
    this._semanticType = classifyFromContent(accumulatedText);
    this._refined = true;
  }

  /** Current best-guess semantic type. */
  get semanticType(): SemanticType {
    return this._semanticType;
  }

  /** Whether content-based refinement has been applied. */
  get isRefined(): boolean {
    return this._refined;
  }

  /** Force-set the semantic type (for testing / override). */
  override(type: SemanticType): void {
    this._semanticType = type;
    this._refined = true;
  }
}

// ---------------------------------------------------------------------------
// SemanticsAwareChunker — type-specific pause-point rules
// ---------------------------------------------------------------------------

/**
 * Result from findPausePoint() — the position where a chunk should end.
 */
export interface PausePoint {
  /** Character index (exclusive) where the chunk ends. */
  end: number;
  /** Human-readable reason for this pause point. */
  reason: string;
}

/**
 * Find the next semantic pause point in `buffer` based on `semanticType`.
 *
 * Returns null if no complete semantic unit has been accumulated yet.
 *
 * Pause-point rules by type:
 *   json_struct   : after balanced `}` or `]` at depth 0
 *   test_output   : after each test-case result line
 *   grep_matches  : after each file-section (when file prefix changes)
 *   diff_output   : after each hunk header line or file diff block
 *   log_stream    : after each complete newline-terminated line
 *   generic       : paragraph boundary (double newline)
 */
export function findPausePoint(
  buffer: string,
  semanticType: SemanticType,
  maxSize: number
): PausePoint | null {
  // Hard cap: always flush at maxSize (snap to last newline if possible)
  if (buffer.length >= maxSize) {
    const lastNl = buffer.lastIndexOf("\n");
    const end = lastNl > 0 ? lastNl + 1 : buffer.length;
    return { end, reason: "max_size" };
  }

  switch (semanticType) {
    case "json_struct": {
      // Balanced brace/bracket tracking — pause at depth 0 after first open
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
          if (depth > 0) depth--;
          if (started && depth === 0) {
            return { end: i + 1, reason: "json_close" };
          }
        }
      }
      return null;
    }

    case "test_output": {
      // Pause after each test-case result line
      // Matches: "ok N - description", "PASS/FAIL foo", "✓/✗ description",
      //          "not ok N - description", pytest PASSED/FAILED lines
      const lines = buffer.split("\n");
      let offset = 0;
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i]!;
        offset += line.length + 1; // +1 for \n
        const isTestLine =
          /^(ok\s+\d+|not ok\s+\d+)/.test(line)                   // TAP
          || /^\s*(✓|✗|✔|✘|√|×)\s/.test(line)                    // Unicode tick/cross
          || /^(PASS|FAIL|ERROR|SKIP)\s+\S/.test(line)             // Jest/Go test
          || /^(PASSED|FAILED|ERROR|SKIPPED)\s/.test(line)         // pytest
          || /^\s+\d+\s+(passed|failed|pending|skipped)/.test(line) // summary
          || /^---\s+(PASS|FAIL):/.test(line);                     // Go test detail
        if (isTestLine) {
          return { end: offset, reason: "test_case" };
        }
      }
      // Fallback: line granularity
      const nl = buffer.indexOf("\n");
      if (nl >= 0) return { end: nl + 1, reason: "line_break" };
      return null;
    }

    case "grep_matches": {
      // Pause at each file-section boundary: when the file prefix changes.
      // File prefix = everything before the first ':digit:' separator.
      const lines = buffer.split("\n");
      let offset = 0;
      let currentFile: string | null = null;

      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i]!;
        offset += line.length + 1;
        // Extract file prefix (before first :digit: segment)
        const m = line.match(/^([^:\d][^:]*?):\d+:/);
        const filePrefix = m ? m[1] : null;

        if (currentFile !== null && filePrefix !== null && filePrefix !== currentFile) {
          // File section changed — pause at end of previous line
          return { end: offset - line.length - 1, reason: "grep_file_section" };
        }
        if (filePrefix !== null) {
          currentFile = filePrefix;
        }
      }

      // No file-section boundary found — fall back to line granularity
      const nl = buffer.indexOf("\n");
      if (nl >= 0) return { end: nl + 1, reason: "line_break" };
      return null;
    }

    case "diff_output": {
      // Pause before each hunk header (@@) or file header (diff --git / --- / +++)
      // so each hunk/file becomes its own chunk.
      const lines = buffer.split("\n");
      let offset = 0;
      let pastFirstHeader = false;

      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i]!;
        offset += line.length + 1;
        const isHunkOrFileHeader =
          /^@@ /.test(line)
          || /^diff --git /.test(line)
          || /^--- [ab]\//.test(line)
          || /^\+\+\+ [ab]\//.test(line);

        if (isHunkOrFileHeader) {
          if (pastFirstHeader) {
            // Pause: emit everything *before* this header line
            const pauseEnd = offset - line.length - 1;
            if (pauseEnd > 0) {
              return { end: pauseEnd, reason: "diff_hunk" };
            }
          }
          pastFirstHeader = true;
        }
      }

      // Paragraph fallback
      const doubleNl = buffer.indexOf("\n\n");
      if (doubleNl >= 0) return { end: doubleNl + 2, reason: "paragraph" };
      return null;
    }

    case "log_stream": {
      // Each complete newline-terminated line is its own semantic unit
      const nl = buffer.indexOf("\n");
      if (nl >= 0) return { end: nl + 1, reason: "line_break" };
      return null;
    }

    case "generic":
    default: {
      // Paragraph boundary
      const doubleNl = buffer.indexOf("\n\n");
      if (doubleNl >= 0) return { end: doubleNl + 2, reason: "paragraph" };
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// SemanticsAwareChunker — stateful buffer with adaptive pause points
// ---------------------------------------------------------------------------

/**
 * A chunk emitted by the SemanticsAwareChunker.
 */
export interface SemanticChunk {
  /** Text content of this chunk. */
  text: string;
  /** Semantic type that drove this chunk boundary. */
  semanticType: SemanticType;
  /** What triggered this boundary. */
  reason: string;
  /** Whether this chunk was forced by maxSize rather than a semantic boundary. */
  forced: boolean;
  /** Monotonically increasing index within this session. */
  index: number;
}

/**
 * Stateful chunker that buffers text and emits SemanticChunks at
 * domain-specific pause points.
 *
 * Usage:
 *   const chunker = new SemanticsAwareChunker(classifier, { onChunk, maxSize });
 *   chunker.push(text);        // feed incremental text
 *   chunker.finalize();        // flush remainder
 */
export class SemanticsAwareChunker {
  private _buffer = "";
  private _chunkIndex = 0;
  private _finalized = false;

  private readonly _classifier: OutputClassifier;
  private readonly _onChunk: (chunk: SemanticChunk) => void;
  private readonly _maxSize: number;
  private readonly _minSize: number;

  constructor(
    classifier: OutputClassifier,
    opts: {
      onChunk: (chunk: SemanticChunk) => void;
      /** Hard cap per chunk in chars. Default: 8192 */
      maxSize?: number;
      /** Minimum buffer before emitting (prevents micro-chunks). Default: 64 */
      minSize?: number;
    }
  ) {
    this._classifier = classifier;
    this._onChunk = opts.onChunk;
    this._maxSize = opts.maxSize ?? 8_192;
    this._minSize = opts.minSize ?? 64;
  }

  /**
   * Feed text into the chunker.  Content-based classifier refinement is
   * attempted automatically once enough data is buffered.
   */
  push(text: string): void {
    if (this._finalized) {
      throw new Error("SemanticsAwareChunker: push() after finalize()");
    }
    if (text.length === 0) return;

    this._buffer += text;

    // Attempt content-based refinement
    this._classifier.refine(this._buffer);

    this._drain();
  }

  /**
   * Flush any remaining buffer content and mark the chunker as done.
   */
  finalize(): void {
    if (this._finalized) {
      throw new Error("SemanticsAwareChunker: finalize() called more than once");
    }
    this._finalized = true;

    if (this._buffer.length > 0) {
      this._emit(this._buffer, "finalize", false);
      this._buffer = "";
    }
  }

  /** Current buffer contents (for inspection). */
  get pendingBuffer(): string {
    return this._buffer;
  }

  /** Total chunks emitted so far. */
  get chunkCount(): number {
    return this._chunkIndex;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _drain(): void {
    let iterations = 0;
    while (this._buffer.length > 0 && iterations++ < 2000) {
      const type = this._classifier.semanticType;
      const pp = findPausePoint(this._buffer, type, this._maxSize);
      if (!pp) break;

      // Respect minSize for line-granularity types to prevent micro-chunks
      if (
        pp.reason === "line_break" &&
        pp.end < this._minSize &&
        this._buffer.length < this._maxSize
      ) {
        break;
      }

      const text = this._buffer.slice(0, pp.end);
      this._buffer = this._buffer.slice(pp.end);
      this._emit(text, pp.reason, pp.reason === "max_size");
    }
  }

  private _emit(text: string, reason: string, forced: boolean): void {
    const chunk: SemanticChunk = {
      text,
      semanticType: this._classifier.semanticType,
      reason,
      forced,
      index: this._chunkIndex++,
    };
    this._onChunk(chunk);
  }
}

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

/**
 * Create an OutputClassifier + SemanticsAwareChunker pair and collect all
 * emitted chunks.  Convenience helper for tests and offline processing.
 */
export function createSemanticChunkCollector(
  toolName: string,
  toolInput: Record<string, unknown>,
  opts?: { maxSize?: number; minSize?: number }
): { classifier: OutputClassifier; chunker: SemanticsAwareChunker; chunks: SemanticChunk[] } {
  const chunks: SemanticChunk[] = [];
  const classifier = new OutputClassifier(toolName, toolInput);
  const chunker = new SemanticsAwareChunker(classifier, {
    onChunk: (c) => chunks.push(c),
    ...opts,
  });
  return { classifier, chunker, chunks };
}
