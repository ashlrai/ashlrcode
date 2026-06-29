/**
 * ToolResultRenderer — incremental streaming UI for tool results.
 *
 * Renders ToolResultChunk events as they arrive from the agent's streaming
 * pipeline, providing:
 *   1. Immediate on-screen output as each semantic chunk completes.
 *   2. Collapsible blocks per semantic boundary type (grep, file, log, diff…).
 *   3. Progressive expand ("show more") for large results — not summarisation.
 *   4. Live token-savings status line from truncation metadata.
 *   5. Visual separators injected by the StreamingResultAggregator at boundaries.
 *   6. Auto-detect output type (JSON, table, log, error) via content inspection.
 *   7. JSON rendered as collapsible tree with syntax coloring.
 *   8. Tabular data rendered as aligned columns with sort/filter hints.
 *   9. Large Bash outputs as paginated log view with line wrapping.
 *  10. Semantic pause-points: "[more...]" when buffer fills, resume on signal.
 *
 * Usage (from App.tsx or repl.tsx):
 *   <ToolResultRenderer toolName="Grep" chunks={chunks} isComplete={isFinal} />
 *
 * Integration with tool-executor.ts:
 *   Pass an onToolResultChunk callback to executeToolCalls(); accumulate chunks
 *   per tool name into a Map<string, ToolResultChunk[]> and feed them here.
 */

import chalk from "chalk";
import { Box, Text } from "ink";
import React, { useMemo, useState } from "react";
import type { AggregatorChunk } from "../agent/streaming-result-aggregator.ts";
import {
  formatChunkSeparator,
  formatToolResultChunk,
} from "./message-renderer.ts";
import type { ToolResultChunk } from "../agent/tool-result-streaming.ts";
import {
  buildJsonTree,
  flattenJsonTree,
  parseTableData,
  renderTable,
  getLogPage,
  buildPauseLabel,
  type JsonTreeNode,
  type ParsedTable,
} from "../agent/tool-result-streaming.ts";
import { theme } from "./theme.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum lines shown in a collapsed block before "show more" appears. */
const COLLAPSE_LINE_THRESHOLD = 12;

/** Minimum cumulative bytes before the savings line is shown. */
const MIN_BYTES_FOR_SAVINGS = 512;

/** Lines per page for paginated log view. */
const LOG_PAGE_SIZE = 40;

/** Max column width for table rendering (characters). */
const TABLE_MAX_ROWS = 50;

// ---------------------------------------------------------------------------
// JsonTreeView — collapsible JSON tree with syntax coloring
// ---------------------------------------------------------------------------

interface JsonTreeViewProps {
  /** Parsed JSON value to render */
  value: unknown;
  /** Maximum depth to expand initially */
  initialDepth?: number;
}

/**
 * Renders a parsed JSON value as a collapsible tree with syntax coloring.
 *
 * - Objects and arrays start expanded up to initialDepth.
 * - Clicking (or pressing 'x' on node) collapses/expands that subtree.
 * - Leaf values are colored: strings=green, numbers=cyan, booleans=yellow, null=dim.
 */
export function JsonTreeView({ value, initialDepth = 2 }: JsonTreeViewProps) {
  const tree = useMemo(() => buildJsonTree(value, "root", 0, initialDepth + 2), [value, initialDepth]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const lines = useMemo(() => flattenJsonTree(tree, collapsed), [tree, collapsed]);

  // Color a display line by its content
  const colorLine = (line: string): string => {
    // Key-value pattern: "  key: value"
    const kvMatch = line.match(/^(\s*)(\S+): (.*)$/);
    if (kvMatch) {
      const [, indent, key, val] = kvMatch;
      const coloredKey = chalk.cyan(key);
      let coloredVal = val;
      if (val === "null") coloredVal = chalk.dim("null");
      else if (val === "true" || val === "false") coloredVal = chalk.yellow(val);
      else if (/^-?\d+(\.\d+)?$/.test(val ?? "")) coloredVal = chalk.blue(val ?? "");
      else if ((val ?? "").startsWith('"')) coloredVal = chalk.green(val ?? "");
      else if ((val ?? "").startsWith("[") || (val ?? "").startsWith("{")) coloredVal = chalk.white(val ?? "");
      return `${indent}${coloredKey}: ${coloredVal}`;
    }
    // Closing brace/bracket
    if (/^\s*[}\]]/.test(line)) return chalk.white(line);
    // Truncation hint
    if (line.includes("...")) return chalk.dim(line);
    return line;
  };

  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Text key={`json-line-${i}`}>{colorLine(line)}</Text>
      ))}
      {lines.length > COLLAPSE_LINE_THRESHOLD && (
        <Text dimColor>{"  ┄ [json tree — collapse subtrees to reduce noise]"}</Text>
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// TableView — aligned columns with sort/filter hints
// ---------------------------------------------------------------------------

interface TableViewProps {
  /** Raw text that may be a pipe-delimited, CSV, or JSON-array-of-objects table */
  text: string;
  /** Optional column index to sort by */
  sortCol?: number;
  /** Sort ascending (default: true) */
  sortAsc?: boolean;
}

/**
 * Renders tabular data as aligned columns.
 *
 * Auto-detects format (pipe-delimited, CSV, JSON array of objects).
 * Falls back to plain text when no tabular structure is found.
 */
export function TableView({ text, sortCol, sortAsc = true }: TableViewProps) {
  const table = useMemo(() => parseTableData(text), [text]);

  if (!table) {
    // Fall back to plain text
    return (
      <Box flexDirection="column">
        {text.split("\n").map((line, i) => (
          <Text key={`table-fallback-${i}`}>{line}</Text>
        ))}
      </Box>
    );
  }

  const lines = useMemo(
    () => renderTable(table, TABLE_MAX_ROWS, sortCol, sortAsc),
    [table, sortCol, sortAsc]
  );

  return (
    <Box flexDirection="column">
      {lines.map((line, i) => {
        // Header row: bold
        if (i === 0) return <Text key={`table-header`} bold>{line}</Text>;
        // Separator row: dim
        if (i === 1) return <Text key={`table-sep`} dimColor>{line}</Text>;
        // Hint line at end: dim
        if (line.startsWith("[")) return <Text key={`table-hint-${i}`} dimColor>{line}</Text>;
        // Truncation hint
        if (line.startsWith("...")) return <Text key={`table-trunc-${i}`} dimColor>{line}</Text>;
        return <Text key={`table-row-${i}`}>{line}</Text>;
      })}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// PaginatedLogView — large Bash outputs as paginated log with line wrapping
// ---------------------------------------------------------------------------

interface PaginatedLogViewProps {
  /** Full log text */
  text: string;
  /** Lines per page */
  pageSize?: number;
  /** Whether the stream is still receiving data */
  isStreaming?: boolean;
}

/**
 * Renders a large log output as a paginated view.
 *
 * Shows the current page with navigation hints.
 * The caller controls page navigation; this component manages display.
 */
export function PaginatedLogView({ text, pageSize = LOG_PAGE_SIZE, isStreaming = false }: PaginatedLogViewProps) {
  const [pageIndex, setPageIndex] = useState(0);

  const page = useMemo(() => getLogPage(text, pageIndex, pageSize), [text, pageIndex, pageSize]);

  // Auto-advance to last page while streaming
  const lastPage = useMemo(() => Math.max(0, page.totalPages - 1), [page.totalPages]);

  return (
    <Box flexDirection="column">
      {/* Page content */}
      {page.lines.map((line, i) => (
        <Text key={`log-${pageIndex}-${i}`}>{line}</Text>
      ))}

      {/* Pagination footer */}
      <Text dimColor>
        {`  ┄ page ${page.pageIndex + 1}/${page.totalPages} · ${page.totalLines} lines total`}
        {isStreaming ? " · streaming…" : ""}
      </Text>

      {/* Navigation hints */}
      {page.hasMore && (
        <Text dimColor color="cyan">
          {`  ┄ [more... ${page.totalPages - page.pageIndex - 1} page(s) remaining]`}
        </Text>
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// SemanticPauseIndicator — shows [more...] at buffer fill points
// ---------------------------------------------------------------------------

interface SemanticPauseIndicatorProps {
  /** The chunk that triggered the pause */
  chunk: ToolResultChunk;
  /** Whether we are waiting for resume (true = show indicator) */
  isPaused: boolean;
}

/**
 * Shows a "[more...]" indicator at semantic pause points when the buffer fills.
 * The pause occurs when pendingMore=true and buffer is at a natural boundary.
 */
export function SemanticPauseIndicator({ chunk, isPaused }: SemanticPauseIndicatorProps) {
  if (!isPaused || !chunk.pendingMore) return null;

  const label = buildPauseLabel(chunk.outputType, chunk.index, chunk.cumulativeBytes);

  return (
    <Box flexDirection="column">
      <Text color="cyan" dimColor>
        {`  ┄ ${label}`}
      </Text>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// ChunkBlock — a single semantic chunk rendered as a collapsible block
// ---------------------------------------------------------------------------

interface ChunkBlockProps {
  chunk: ToolResultChunk;
  /** Whether this block starts collapsed (true when line count > threshold). */
  initiallyCollapsed: boolean;
}

/**
 * Renders a single ToolResultChunk, choosing the best renderer based on outputType.
 *
 * Routing:
 *   json_array / json_object → JsonTreeView (collapsible tree)
 *   table                   → TableView (aligned columns)
 *   log_lines / bash_error  → PaginatedLogView (when >LOG_PAGE_SIZE lines)
 *   everything else         → formatToolResultChunk (message-renderer)
 */
function ChunkBlock({ chunk, initiallyCollapsed }: ChunkBlockProps) {
  const [expanded, setExpanded] = useState(!initiallyCollapsed);

  // Choose renderer based on outputType
  const useJsonTree = chunk.outputType === "json_array" || chunk.outputType === "json_object";
  const useTable = chunk.outputType === "table";
  const useLogPager = (chunk.outputType === "log_lines" || chunk.outputType === "generic_text") &&
    chunk.text.split("\n").length > LOG_PAGE_SIZE;

  const rendered = useMemo(() => {
    if (useJsonTree || useTable || useLogPager) return null;
    return formatToolResultChunk(chunk);
  }, [chunk, useJsonTree, useTable, useLogPager]);

  const separator = useMemo(() => formatChunkSeparator(chunk), [chunk]);

  const parsedJson = useMemo(() => {
    if (!useJsonTree) return null;
    try {
      return JSON.parse(chunk.text);
    } catch {
      return null;
    }
  }, [chunk.text, useJsonTree]);

  // For non-special renderers: line count and collapse logic
  const lineCount = rendered?.length ?? 0;
  const isLarge = lineCount > COLLAPSE_LINE_THRESHOLD;
  const visibleLines = expanded ? rendered ?? [] : (rendered ?? []).slice(0, COLLAPSE_LINE_THRESHOLD);
  const hiddenCount = lineCount - COLLAPSE_LINE_THRESHOLD;

  // --- JSON tree renderer ---
  if (useJsonTree && parsedJson !== null) {
    return (
      <Box flexDirection="column">
        {separator ? <Text>{separator}</Text> : null}
        <JsonTreeView value={parsedJson} initialDepth={2} />
        {chunk.pendingMore && !chunk.isFinal && (
          <SemanticPauseIndicator chunk={chunk} isPaused={true} />
        )}
      </Box>
    );
  }

  // --- Table renderer ---
  if (useTable) {
    return (
      <Box flexDirection="column">
        {separator ? <Text>{separator}</Text> : null}
        <TableView text={chunk.text} />
        {chunk.pendingMore && !chunk.isFinal && (
          <SemanticPauseIndicator chunk={chunk} isPaused={true} />
        )}
      </Box>
    );
  }

  // --- Paginated log renderer ---
  if (useLogPager) {
    return (
      <Box flexDirection="column">
        {separator ? <Text>{separator}</Text> : null}
        <PaginatedLogView text={chunk.text} isStreaming={chunk.pendingMore && !chunk.isFinal} />
      </Box>
    );
  }

  // --- Default: collapsible formatted lines ---
  return (
    <Box flexDirection="column">
      {/* Separator between chunks */}
      {separator ? <Text>{separator}</Text> : null}

      {/* Chunk content lines */}
      {visibleLines.map((line, i) => (
        <Text key={`chunk-${chunk.index}-line-${i}`}>{line}</Text>
      ))}

      {/* Progressive expand control */}
      {isLarge && !expanded && (
        <Text dimColor>
          {"  ┄ "}
          <Text color="cyan" underline>
            {`[+${hiddenCount} more lines — press 'x' to expand]`}
          </Text>
        </Text>
      )}

      {/* Collapse control when expanded */}
      {isLarge && expanded && (
        <Text dimColor>{"  ┄ [block complete]"}</Text>
      )}

      {/* Lazy-load / semantic pause indicator */}
      {chunk.pendingMore && !chunk.isFinal && (
        <SemanticPauseIndicator chunk={chunk} isPaused={true} />
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// TokenSavingsLine — live savings from truncation metadata
// ---------------------------------------------------------------------------

interface TokenSavingsLineProps {
  chunks: ToolResultChunk[];
  isComplete: boolean;
}

function TokenSavingsLine({ chunks, isComplete }: TokenSavingsLineProps) {
  const { totalBytes, chunkCount, hasSavings } = useMemo(() => {
    if (chunks.length === 0) return { totalBytes: 0, chunkCount: 0, hasSavings: false };
    const last = chunks[chunks.length - 1]!;
    const total = last.cumulativeBytes;
    const savings = chunks.length > 1;
    return { totalBytes: total, chunkCount: chunks.length, hasSavings: savings };
  }, [chunks]);

  if (totalBytes < MIN_BYTES_FOR_SAVINGS) return null;

  const kb = (totalBytes / 1024).toFixed(1);
  const status = isComplete ? "complete" : "streaming";

  return (
    <Text dimColor>
      {`  ┄ ${kb} KB · ${chunkCount} chunk${chunkCount !== 1 ? "s" : ""} · ${status}${hasSavings ? " · progressive" : ""}`}
    </Text>
  );
}

// ---------------------------------------------------------------------------
// BoundaryHeader — visual separator injected per aggregator boundary type
// ---------------------------------------------------------------------------

interface BoundaryHeaderProps {
  aggChunk: AggregatorChunk;
}

function BoundaryHeader({ aggChunk }: BoundaryHeaderProps) {
  const label = useMemo(() => {
    switch (aggChunk.type) {
      case "json":
        return chalk.cyan("  ┬ json boundary");
      case "diff":
        return chalk.yellow("  ┬ diff boundary");
      case "error":
        return chalk.red("  ┬ error block");
      default:
        return theme.muted("  ┬ section");
    }
  }, [aggChunk.type]);

  if (aggChunk.type === "text" && aggChunk.isComplete) return null;

  return <Text>{label}</Text>;
}

// ---------------------------------------------------------------------------
// ToolResultRenderer — main exported component
// ---------------------------------------------------------------------------

export interface ToolResultRendererProps {
  /** Tool name for display context. */
  toolName: string;
  /** Streaming chunks as they arrive from the tool-executor pipeline. */
  chunks: ToolResultChunk[];
  /** Aggregator-level boundary chunks (optional, from onResult callback). */
  aggChunks?: AggregatorChunk[];
  /** Whether the tool has finished executing. */
  isComplete: boolean;
  /** Whether to show the live token savings status line. */
  showSavingsLine?: boolean;
}

/**
 * Renders tool result chunks incrementally as they arrive.
 *
 * Each ToolResultChunk is rendered immediately into a ChunkBlock as it arrives.
 * The component routes each chunk to the best renderer:
 *   - json_array/json_object → JsonTreeView
 *   - table                 → TableView
 *   - log_lines (large)     → PaginatedLogView
 *   - everything else       → collapsible formatted lines
 *
 * Semantic pause-points are shown as "[more...]" indicators when pendingMore=true.
 */
export function ToolResultRenderer({
  toolName,
  chunks,
  aggChunks = [],
  isComplete,
  showSavingsLine = true,
}: ToolResultRendererProps) {
  const aggChunksByIndex = useMemo(() => {
    const map = new Map<number, AggregatorChunk>();
    for (const ac of aggChunks) {
      map.set(ac.index, ac);
    }
    return map;
  }, [aggChunks]);

  if (chunks.length === 0) {
    return isComplete ? null : (
      <Text dimColor>{`  ┄ ${toolName} streaming…`}</Text>
    );
  }

  return (
    <Box flexDirection="column">
      {chunks.map((chunk) => {
        const aggChunk = aggChunksByIndex.get(chunk.index);
        const isLarge = chunk.text.split("\n").length > COLLAPSE_LINE_THRESHOLD;

        return (
          <Box key={`tool-result-${toolName}-${chunk.index}`} flexDirection="column">
            {aggChunk && <BoundaryHeader aggChunk={aggChunk} />}
            <ChunkBlock
              chunk={chunk}
              initiallyCollapsed={isLarge && chunk.index > 0}
            />
          </Box>
        );
      })}

      {showSavingsLine && (
        <TokenSavingsLine chunks={chunks} isComplete={isComplete} />
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// ActiveStreamingTools — renders all currently streaming tools in one panel
// ---------------------------------------------------------------------------

export interface ActiveStreamingToolsProps {
  activeTools: Map<
    string,
    {
      chunks: ToolResultChunk[];
      isComplete: boolean;
      aggChunks?: AggregatorChunk[];
    }
  >;
}

/**
 * Renders all active tool streams in sequence.
 *
 * Intended to be placed between the Static output history and the spinner
 * in App.tsx so live tool results appear just above the spinner line.
 */
export function ActiveStreamingTools({ activeTools }: ActiveStreamingToolsProps) {
  if (activeTools.size === 0) return null;

  return (
    <Box flexDirection="column">
      {Array.from(activeTools.entries()).map(([toolName, state]) => (
        <ToolResultRenderer
          key={`stream-${toolName}`}
          toolName={toolName}
          chunks={state.chunks}
          aggChunks={state.aggChunks}
          isComplete={state.isComplete}
          showSavingsLine={state.isComplete}
        />
      ))}
    </Box>
  );
}
