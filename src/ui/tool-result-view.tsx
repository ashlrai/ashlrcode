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
import { theme } from "./theme.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum lines shown in a collapsed block before "show more" appears. */
const COLLAPSE_LINE_THRESHOLD = 12;

/** Minimum cumulative bytes before the savings line is shown. */
const MIN_BYTES_FOR_SAVINGS = 512;

// ---------------------------------------------------------------------------
// ChunkBlock — a single semantic chunk rendered as a collapsible block
// ---------------------------------------------------------------------------

interface ChunkBlockProps {
  chunk: ToolResultChunk;
  /** Whether this block starts collapsed (true when line count > threshold). */
  initiallyCollapsed: boolean;
}

function ChunkBlock({ chunk, initiallyCollapsed }: ChunkBlockProps) {
  const [expanded, setExpanded] = useState(!initiallyCollapsed);

  const rendered = useMemo(() => formatToolResultChunk(chunk), [chunk]);
  const separator = useMemo(() => formatChunkSeparator(chunk), [chunk]);

  const lineCount = rendered.length;
  const isLarge = lineCount > COLLAPSE_LINE_THRESHOLD;
  const visibleLines = expanded ? rendered : rendered.slice(0, COLLAPSE_LINE_THRESHOLD);
  const hiddenCount = lineCount - COLLAPSE_LINE_THRESHOLD;

  return (
    <Box flexDirection="column">
      {/* Separator between chunks */}
      {separator ? <Text>{separator}</Text> : null}

      {/* Chunk content lines */}
      {visibleLines.map((line, i) => (
        // React key uses chunk index + line position for stability across re-renders
        <Text key={`chunk-${chunk.index}-line-${i}`}>{line}</Text>
      ))}

      {/* Progressive expand control — never summarises, only hides/shows */}
      {isLarge && !expanded && (
        <Text dimColor>
          {"  ┄ "}
          <Text
            color="cyan"
            underline
            // Ink Text onClick isn't supported on all terminals; use a static hint instead
          >
            {`[+${hiddenCount} more lines — press 'x' to expand]`}
          </Text>
        </Text>
      )}

      {/* Collapse control when expanded */}
      {isLarge && expanded && (
        <Text dimColor>{"  ┄ [block complete]"}</Text>
      )}

      {/* Lazy-load indicator when more chunks expected */}
      {chunk.pendingMore && !chunk.isFinal && (
        <Text dimColor>{"  ┄ loading…"}</Text>
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
    // Savings exist when multiple chunks were emitted (boundary-based truncation)
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

  // Only show headers for non-text boundaries to reduce noise
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
 * Each ToolResultChunk is rendered immediately into a ChunkBlock as it arrives
 * (the parent feeds `chunks` as a growing array via useState).  The component
 * is intentionally simple — it delegates all formatting to formatToolResultChunk()
 * in message-renderer.ts and only adds:
 *   - Collapse/expand state per block.
 *   - Aggregator boundary headers at JSON/diff/error transitions.
 *   - A live savings status line at the bottom.
 */
export function ToolResultRenderer({
  toolName,
  chunks,
  aggChunks = [],
  isComplete,
  showSavingsLine = true,
}: ToolResultRendererProps) {
  // Build a map from chunk index → aggregator boundary chunk that fires
  // just before this tool result chunk, for interleaved boundary headers.
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
            {/* Inject aggregator boundary header when available */}
            {aggChunk && <BoundaryHeader aggChunk={aggChunk} />}

            {/* Render the chunk as a collapsible block */}
            <ChunkBlock
              chunk={chunk}
              initiallyCollapsed={isLarge && chunk.index > 0}
            />
          </Box>
        );
      })}

      {/* Live token savings status line */}
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
  /**
   * Map of toolName → { chunks, isComplete, aggChunks? }.
   * The parent (App.tsx) maintains this map and updates it as chunks arrive.
   */
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
