/**
 * Trace Navigator — programmatic traversal and visualization of intent-trace decision trees.
 *
 * Provides three public classes / types:
 *
 *   DecisionTreeBuilder — parses a JSONL trace and constructs a structured
 *                         DecisionTree with rich metadata per node.
 *
 *   TraceNavigator      — high-level API consumed by REPL commands:
 *                           getDecisionTree(sessionId)  → DecisionTree
 *                           getDrillDown(eventId)       → DecisionDetail
 *                           exportAsJSON(sessionId)     → plain object
 *
 * The ASCII visualization produced by renderDecisionTreeViz() is richer than
 * the existing renderDecisionTree() in intent-trace.ts: it annotates each node
 * with confidence, token-budget, and speculation state so users can understand
 * exactly why the agent made each decision.
 *
 * Design contract:
 *   - Never throws.  All public methods return graceful fallbacks on error.
 *   - Pure functions where possible — DecisionTreeBuilder is stateless after
 *     construction.
 *   - Session loading is delegated to loadTrace() from intent-trace.ts so the
 *     storage layer stays in one place.
 */

import {
  loadTrace,
  type TraceEvent,
  type GoalNormalizationEvent,
  type ToolSelectionEvent,
  type SpeculationHitEvent,
  type SpeculationMissEvent,
  type ContextCompressionEvent,
  type TurnBoundaryEvent,
  type TraceEventKind,
} from "./intent-trace.ts";

// ── Public types ───────────────────────────────────────────────────────────────

/**
 * A single node in the decision tree.  Leaf nodes have an empty `children`
 * array.  Each node carries the original event (if any) so callers can drill
 * down without losing information.
 */
export interface DecisionTreeNode {
  /** Unique node id — "<sessionId>:<seq>" or synthetic for turn/root nodes. */
  id: string;
  /** Human-readable label suitable for ASCII rendering. */
  label: string;
  /** Event kind this node represents.  "root" for the session root node. */
  kind: TraceEventKind | "root" | "turn";
  /** Turn index within the session (-1 for root). */
  turn: number;
  /** Original event sequence number (-1 for synthetic nodes). */
  seq: number;
  /** Nested children. */
  children: DecisionTreeNode[];
  /** Metadata extracted from the underlying event for programmatic use. */
  meta: DecisionNodeMeta;
}

/** Typed metadata attached to a DecisionTreeNode. */
export interface DecisionNodeMeta {
  /** For tool_selection: name of the tool that was selected. */
  toolName?: string;
  /** For tool_selection: approximate confidence [0-1] derived from context length. */
  confidence?: number;
  /** For tool_selection: the step index within the timeline. */
  stepIndex?: number;
  /** For tool_selection: truncated reasoning context. */
  reasoningContext?: string;
  /** For speculation_hit/miss: whether the result came from cache. */
  cacheHit?: boolean;
  /** For speculation_hit: which cache type was hit. */
  cacheType?: "memory" | "persistent";
  /** For speculation_hit/miss: latency saved or actual execution ms. */
  latencyMs?: number;
  /** For context_compression: token counts before/after. */
  tokensBefore?: number;
  tokensAfter?: number;
  blocksDropped?: number;
  /** For goal_normalization: approximate input token count. */
  approxTokens?: number;
  /** For turn_boundary end: tool call count this turn. */
  toolCallCount?: number;
}

/**
 * Top-level decision tree for an entire session.
 */
export interface DecisionTree {
  /** Session identifier. */
  sessionId: string;
  /** Total number of raw trace events loaded. */
  totalEvents: number;
  /** Number of turns in the session. */
  turnCount: number;
  /** Root node of the tree — children are per-turn subtrees. */
  root: DecisionTreeNode;
  /** Aggregated statistics across the whole tree. */
  stats: DecisionTreeStats;
}

/** Aggregate stats for a full decision tree. */
export interface DecisionTreeStats {
  totalToolCalls: number;
  speculationHits: number;
  speculationMisses: number;
  contextCompressions: number;
  totalTokensBefore: number;
  totalTokensAfter: number;
  /** Approximate ms saved from speculation cache hits. */
  msSavedFromCache: number;
}

/**
 * Detailed drill-down for a single event identified by its id
 * ("<sessionId>:<seq>").
 */
export interface DecisionDetail {
  /** Node being drilled into. */
  node: DecisionTreeNode;
  /** Sibling nodes in the same turn (for context). */
  siblings: DecisionTreeNode[];
  /** Human-readable explanation of this decision point. */
  explanation: string;
  /** Speculation cache state at this moment (preceding events in same turn). */
  speculationState: {
    hitsSoFar: number;
    missesSoFar: number;
    lastCacheType?: "memory" | "persistent";
  };
  /** Token budget snapshot at this event (from most recent turn_boundary or compression). */
  tokenBudgetSnapshot: {
    approxTokens: number;
    compressionCount: number;
  };
}

// ── DecisionTreeBuilder ────────────────────────────────────────────────────────

/**
 * Constructs a DecisionTree from an ordered array of TraceEvents.
 *
 * Usage:
 *   const builder = new DecisionTreeBuilder("session-abc", events);
 *   const tree = builder.build();
 */
export class DecisionTreeBuilder {
  constructor(
    private readonly sessionId: string,
    private readonly events: TraceEvent[]
  ) {}

  build(): DecisionTree {
    try {
      return this._build();
    } catch {
      // Graceful fallback — return an empty tree
      return this._emptyTree();
    }
  }

  private _emptyTree(): DecisionTree {
    const root: DecisionTreeNode = {
      id: `${this.sessionId}:root`,
      label: `Session ${this.sessionId} (no events)`,
      kind: "root",
      turn: -1,
      seq: -1,
      children: [],
      meta: {},
    };
    return {
      sessionId: this.sessionId,
      totalEvents: 0,
      turnCount: 0,
      root,
      stats: {
        totalToolCalls: 0,
        speculationHits: 0,
        speculationMisses: 0,
        contextCompressions: 0,
        totalTokensBefore: 0,
        totalTokensAfter: 0,
        msSavedFromCache: 0,
      },
    };
  }

  private _build(): DecisionTree {
    const events = [...this.events].sort((a, b) => a.seq - b.seq);
    const stats: DecisionTreeStats = {
      totalToolCalls: 0,
      speculationHits: 0,
      speculationMisses: 0,
      contextCompressions: 0,
      totalTokensBefore: 0,
      totalTokensAfter: 0,
      msSavedFromCache: 0,
    };

    const root: DecisionTreeNode = {
      id: `${this.sessionId}:root`,
      label: `Session ${this.sessionId} (${events.length} events)`,
      kind: "root",
      turn: -1,
      seq: -1,
      children: [],
      meta: {},
    };

    // Group events by turn, preserving order
    const turnMap = new Map<number, TraceEvent[]>();
    for (const ev of events) {
      const bucket = turnMap.get(ev.turn) ?? [];
      bucket.push(ev);
      turnMap.set(ev.turn, bucket);
    }

    const sortedTurns = [...turnMap.entries()].sort((a, b) => a[0] - b[0]);

    for (const [turnIdx, turnEvents] of sortedTurns) {
      const turnNode = this._buildTurnNode(turnIdx, turnEvents, stats);
      root.children.push(turnNode);
    }

    return {
      sessionId: this.sessionId,
      totalEvents: events.length,
      turnCount: sortedTurns.length,
      root,
      stats,
    };
  }

  private _buildTurnNode(
    turnIdx: number,
    events: TraceEvent[],
    stats: DecisionTreeStats
  ): DecisionTreeNode {
    const turnNode: DecisionTreeNode = {
      id: `${this.sessionId}:turn:${turnIdx}`,
      label: `Turn ${turnIdx}`,
      kind: "turn",
      turn: turnIdx,
      seq: -1,
      children: [],
      meta: {},
    };

    // Track the last tool_selection node so we can attach speculation events as children
    let lastToolNode: DecisionTreeNode | null = null;

    for (const ev of events) {
      switch (ev.kind) {
        case "goal_normalization": {
          const gev = ev as GoalNormalizationEvent;
          const node: DecisionTreeNode = {
            id: `${this.sessionId}:${ev.seq}`,
            label: `Goal: "${_truncate(gev.normalizedGoal, 60)}" (~${gev.approxTokens} tokens)`,
            kind: ev.kind,
            turn: ev.turn,
            seq: ev.seq,
            children: [],
            meta: { approxTokens: gev.approxTokens },
          };
          turnNode.children.push(node);
          break;
        }

        case "tool_selection": {
          const tev = ev as ToolSelectionEvent;
          stats.totalToolCalls++;
          // Derive a confidence proxy: shorter reasoning context → lower confidence.
          // We scale: 0 chars = 0.3 (low), MAX_FIELD_CHARS = 1.0 (high).
          const confidence = tev.reasoningContext
            ? Math.min(1, 0.3 + (tev.reasoningContext.length / 1_500) * 0.7)
            : 0.3;
          const confStr = `conf=${(confidence * 100).toFixed(0)}%`;
          const node: DecisionTreeNode = {
            id: `${this.sessionId}:${ev.seq}`,
            label: `Tool: ${tev.toolName} (step ${tev.stepIndex}, ${confStr})`,
            kind: ev.kind,
            turn: ev.turn,
            seq: ev.seq,
            children: [],
            meta: {
              toolName: tev.toolName,
              confidence,
              stepIndex: tev.stepIndex,
              reasoningContext: tev.reasoningContext,
            },
          };
          if (tev.reasoningContext) {
            node.children.push({
              id: `${this.sessionId}:${ev.seq}:reason`,
              label: `Reason: "${_truncate(tev.reasoningContext, 80)}"`,
              kind: ev.kind,
              turn: ev.turn,
              seq: ev.seq,
              children: [],
              meta: {},
            });
          }
          turnNode.children.push(node);
          lastToolNode = node;
          break;
        }

        case "speculation_hit": {
          const sev = ev as SpeculationHitEvent;
          stats.speculationHits++;
          if (sev.savedMs !== undefined) stats.msSavedFromCache += sev.savedMs;
          const label = `Cache HIT (${sev.cacheType}${sev.savedMs !== undefined ? `, saved ${sev.savedMs}ms` : ""})`;
          const node: DecisionTreeNode = {
            id: `${this.sessionId}:${ev.seq}`,
            label,
            kind: ev.kind,
            turn: ev.turn,
            seq: ev.seq,
            children: [],
            meta: { cacheHit: true, cacheType: sev.cacheType, latencyMs: sev.savedMs },
          };
          (lastToolNode ?? turnNode).children.push(node);
          break;
        }

        case "speculation_miss": {
          const mev = ev as SpeculationMissEvent;
          stats.speculationMisses++;
          const node: DecisionTreeNode = {
            id: `${this.sessionId}:${ev.seq}`,
            label: `Cache MISS (${mev.executionMs}ms actual)`,
            kind: ev.kind,
            turn: ev.turn,
            seq: ev.seq,
            children: [],
            meta: { cacheHit: false, latencyMs: mev.executionMs },
          };
          (lastToolNode ?? turnNode).children.push(node);
          break;
        }

        case "context_compression": {
          const cev = ev as ContextCompressionEvent;
          stats.contextCompressions++;
          stats.totalTokensBefore += cev.tokensBefore;
          stats.totalTokensAfter += cev.tokensAfter;
          const reduction = cev.tokensBefore > 0
            ? Math.round((1 - cev.tokensAfter / cev.tokensBefore) * 100)
            : 0;
          const node: DecisionTreeNode = {
            id: `${this.sessionId}:${ev.seq}`,
            label: `Context compressed: ${cev.tokensBefore} → ${cev.tokensAfter} tokens (${reduction}% reduction, dropped ${cev.blocksDropped})`,
            kind: ev.kind,
            turn: ev.turn,
            seq: ev.seq,
            children: [],
            meta: {
              tokensBefore: cev.tokensBefore,
              tokensAfter: cev.tokensAfter,
              blocksDropped: cev.blocksDropped,
            },
          };
          turnNode.children.push(node);
          lastToolNode = null; // compression breaks tool-attachment chain
          break;
        }

        case "turn_boundary": {
          const bev = ev as TurnBoundaryEvent;
          if (bev.phase === "end") {
            const snippet = bev.finalTextSnippet ? `: "${_truncate(bev.finalTextSnippet, 50)}"` : "";
            const node: DecisionTreeNode = {
              id: `${this.sessionId}:${ev.seq}`,
              label: `Turn end (${bev.toolCallCount ?? 0} tool calls)${snippet}`,
              kind: ev.kind,
              turn: ev.turn,
              seq: ev.seq,
              children: [],
              meta: { toolCallCount: bev.toolCallCount },
            };
            turnNode.children.push(node);
          }
          break;
        }

        // replay_start / replay_step / dedup_hit — attach as plain info nodes
        default: {
          const node: DecisionTreeNode = {
            id: `${this.sessionId}:${ev.seq}`,
            label: `[${ev.kind}]`,
            kind: ev.kind,
            turn: ev.turn,
            seq: ev.seq,
            children: [],
            meta: {},
          };
          turnNode.children.push(node);
          break;
        }
      }
    }

    return turnNode;
  }
}

// ── ASCII visualization ────────────────────────────────────────────────────────

/**
 * Render a DecisionTree to an ASCII string with box-drawing characters.
 * Richer than the basic renderDecisionTree() in intent-trace.ts — adds stats
 * header and per-node kind badges.
 */
export function renderDecisionTreeViz(tree: DecisionTree): string {
  const lines: string[] = [];

  // Header
  lines.push(`Session: ${tree.sessionId}`);
  lines.push(`Events: ${tree.totalEvents}  Turns: ${tree.turnCount}  Tools: ${tree.stats.totalToolCalls}`);
  lines.push(
    `Cache: ${tree.stats.speculationHits} hits / ${tree.stats.speculationMisses} misses` +
      (tree.stats.msSavedFromCache > 0 ? ` (${tree.stats.msSavedFromCache}ms saved)` : "")
  );
  if (tree.stats.contextCompressions > 0) {
    lines.push(
      `Compressions: ${tree.stats.contextCompressions}  ` +
        `${tree.stats.totalTokensBefore} → ${tree.stats.totalTokensAfter} tokens total`
    );
  }
  lines.push("");

  function visit(node: DecisionTreeNode, prefix: string): void {
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i]!;
      const isLast = i === node.children.length - 1;
      const connector = isLast ? "└── " : "├── ";
      const badge = _kindBadge(child.kind);
      lines.push(`${prefix}${connector}${badge}${child.label}`);
      const childPrefix = prefix + (isLast ? "    " : "│   ");
      visit(child, childPrefix);
    }
  }

  visit(tree.root, "");
  return lines.join("\n");
}

function _kindBadge(kind: string): string {
  switch (kind) {
    case "turn": return "[T] ";
    case "goal_normalization": return "[G] ";
    case "tool_selection": return "[►] ";
    case "speculation_hit": return "[✓] ";
    case "speculation_miss": return "[✗] ";
    case "context_compression": return "[~] ";
    case "turn_boundary": return "[|] ";
    default: return "";
  }
}

// ── TraceNavigator ─────────────────────────────────────────────────────────────

/**
 * High-level navigator.  Loads traces from disk and exposes structured APIs
 * consumed by the `/trace replay --viz` and `/trace drill` REPL commands.
 *
 * Results are memoized per session for the lifetime of the navigator instance.
 */
export class TraceNavigator {
  private _treeCache = new Map<string, DecisionTree>();

  /**
   * Load the trace for `sessionId` and return a full DecisionTree.
   * Returns an empty tree (with a `totalEvents: 0`) if no trace exists.
   * Never throws.
   */
  async getDecisionTree(sessionId: string): Promise<DecisionTree> {
    try {
      if (this._treeCache.has(sessionId)) {
        return this._treeCache.get(sessionId)!;
      }
      const events = await loadTrace(sessionId);
      const builder = new DecisionTreeBuilder(sessionId, events);
      const tree = builder.build();
      this._treeCache.set(sessionId, tree);
      return tree;
    } catch {
      const builder = new DecisionTreeBuilder(sessionId, []);
      return builder.build();
    }
  }

  /**
   * Return a rich DrillDown for the event identified by `eventId`.
   *
   * `eventId` format: "<sessionId>:<seq>"
   *
   * Derives speculation and token-budget state from the already-built
   * DecisionTree (via getDecisionTree) so that subclasses / tests can stub
   * the tree without needing a real trace file on disk.
   *
   * Never throws — returns a not-found detail on any error.
   */
  async getDrillDown(eventId: string): Promise<DecisionDetail> {
    try {
      const colonIdx = eventId.lastIndexOf(":");
      if (colonIdx < 0) {
        return this._notFoundDetail(eventId);
      }
      const sessionId = eventId.slice(0, colonIdx);
      const seqStr = eventId.slice(colonIdx + 1);
      const seq = Number(seqStr);
      if (!sessionId || Number.isNaN(seq)) {
        return this._notFoundDetail(eventId);
      }

      const tree = await this.getDecisionTree(sessionId);

      // Find the node with matching id
      const node = _findNodeById(tree.root, eventId);
      if (!node) {
        return this._notFoundDetail(eventId);
      }

      // Collect siblings (other nodes in the same turn)
      const siblings = _findSiblings(tree.root, eventId);

      // Collect all leaf nodes in the tree ordered by seq for state computation.
      // This avoids a second loadTrace() call so stubs work correctly.
      const allNodes = _collectAllNodes(tree.root);
      const speculationState = this._speculationStateFromNodes(allNodes, node.turn, seq);
      const tokenBudgetSnapshot = this._tokenBudgetFromNodes(allNodes, node.turn, seq);

      const explanation = this._buildExplanation(node, speculationState, tokenBudgetSnapshot);

      return { node, siblings, explanation, speculationState, tokenBudgetSnapshot };
    } catch {
      return this._notFoundDetail(eventId);
    }
  }

  /**
   * Export the full DecisionTree for `sessionId` as a plain JSON-serializable
   * object, suitable for third-party visualization tools.
   * Never throws.
   */
  async exportAsJSON(sessionId: string): Promise<object> {
    try {
      const tree = await this.getDecisionTree(sessionId);
      return {
        version: 1,
        sessionId: tree.sessionId,
        totalEvents: tree.totalEvents,
        turnCount: tree.turnCount,
        stats: tree.stats,
        tree: _nodeToPlain(tree.root),
      };
    } catch {
      return { version: 1, sessionId, error: "export failed" };
    }
  }

  /** Evict a cached tree (useful for tests and after new trace events are appended). */
  invalidate(sessionId: string): void {
    this._treeCache.delete(sessionId);
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private _notFoundDetail(eventId: string): DecisionDetail {
    const placeholder: DecisionTreeNode = {
      id: eventId,
      label: `(event not found: ${eventId})`,
      kind: "turn_boundary",
      turn: -1,
      seq: -1,
      children: [],
      meta: {},
    };
    return {
      node: placeholder,
      siblings: [],
      explanation: `No event found with id "${eventId}". Use /trace list to see available sessions.`,
      speculationState: { hitsSoFar: 0, missesSoFar: 0 },
      tokenBudgetSnapshot: { approxTokens: 0, compressionCount: 0 },
    };
  }

  /**
   * Compute speculation state from tree nodes.
   * Counts speculation_hit / speculation_miss nodes in `turn` with seq < beforeSeq.
   */
  private _speculationStateFromNodes(
    nodes: DecisionTreeNode[],
    turn: number,
    beforeSeq: number
  ): DecisionDetail["speculationState"] {
    let hits = 0;
    let misses = 0;
    let lastCacheType: "memory" | "persistent" | undefined;

    for (const n of nodes) {
      if (n.seq < 0 || n.seq >= beforeSeq) continue;
      if (n.turn !== turn) continue;
      if (n.kind === "speculation_hit") {
        hits++;
        if (n.meta.cacheType) lastCacheType = n.meta.cacheType;
      } else if (n.kind === "speculation_miss") {
        misses++;
      }
    }
    return { hitsSoFar: hits, missesSoFar: misses, lastCacheType };
  }

  /**
   * Compute token budget snapshot from tree nodes.
   * Uses goal_normalization and context_compression nodes with seq < beforeSeq.
   */
  private _tokenBudgetFromNodes(
    nodes: DecisionTreeNode[],
    _turn: number,
    beforeSeq: number
  ): DecisionDetail["tokenBudgetSnapshot"] {
    let approxTokens = 0;
    let compressionCount = 0;

    // Sort nodes by seq so we process them in order
    const ordered = [...nodes].filter((n) => n.seq >= 0 && n.seq < beforeSeq).sort((a, b) => a.seq - b.seq);

    for (const n of ordered) {
      if (n.kind === "goal_normalization" && n.meta.approxTokens !== undefined) {
        approxTokens = n.meta.approxTokens;
      }
      if (n.kind === "context_compression") {
        compressionCount++;
        if (n.meta.tokensAfter !== undefined) approxTokens = n.meta.tokensAfter;
      }
    }
    return { approxTokens, compressionCount };
  }

  private _buildExplanation(
    node: DecisionTreeNode,
    spec: DecisionDetail["speculationState"],
    budget: DecisionDetail["tokenBudgetSnapshot"]
  ): string {
    const parts: string[] = [];

    switch (node.kind) {
      case "tool_selection": {
        const { toolName, confidence, stepIndex, reasoningContext } = node.meta;
        parts.push(`Tool selection: ${toolName ?? "unknown"}`);
        parts.push(`  Step index : ${stepIndex ?? "?"}`);
        if (confidence !== undefined) {
          parts.push(`  Confidence : ${(confidence * 100).toFixed(0)}% (derived from reasoning context length)`);
        }
        if (reasoningContext) {
          parts.push(`  Reasoning  : "${_truncate(reasoningContext, 120)}"`);
        }
        parts.push(`  Cache state: ${spec.hitsSoFar} hits, ${spec.missesSoFar} misses in this turn`);
        if (spec.lastCacheType) {
          parts.push(`  Last cache : ${spec.lastCacheType}`);
        }
        parts.push(`  Tokens     : ~${budget.approxTokens} (compressions so far: ${budget.compressionCount})`);
        break;
      }

      case "speculation_hit": {
        const { cacheType, latencyMs } = node.meta;
        parts.push(`Speculation cache HIT — result served from ${cacheType ?? "cache"}`);
        if (latencyMs !== undefined) parts.push(`  Latency saved: ${latencyMs}ms`);
        parts.push(`  Running total this turn: ${spec.hitsSoFar} hits`);
        break;
      }

      case "speculation_miss": {
        const { latencyMs } = node.meta;
        parts.push(`Speculation cache MISS — tool executed live`);
        if (latencyMs !== undefined) parts.push(`  Actual execution: ${latencyMs}ms`);
        parts.push(`  Running total this turn: ${spec.missesSoFar} misses`);
        break;
      }

      case "context_compression": {
        const { tokensBefore, tokensAfter, blocksDropped } = node.meta;
        const reduction =
          (tokensBefore ?? 0) > 0
            ? Math.round((1 - (tokensAfter ?? 0) / (tokensBefore ?? 1)) * 100)
            : 0;
        parts.push(`Context compression triggered`);
        parts.push(`  Before    : ${tokensBefore ?? "?"} tokens`);
        parts.push(`  After     : ${tokensAfter ?? "?"} tokens (${reduction}% reduction)`);
        parts.push(`  Dropped   : ${blocksDropped ?? "?"} message blocks`);
        break;
      }

      case "goal_normalization": {
        const { approxTokens } = node.meta;
        parts.push(`Goal normalization — agent interpreted user request`);
        parts.push(`  Label         : ${_truncate(node.label, 100)}`);
        if (approxTokens !== undefined) parts.push(`  Input tokens  : ~${approxTokens}`);
        break;
      }

      default: {
        parts.push(`Event: ${node.kind}`);
        parts.push(`  Label: ${node.label}`);
        break;
      }
    }

    return parts.join("\n");
  }
}

// ── Module-level singleton ─────────────────────────────────────────────────────

let _navigatorInstance: TraceNavigator | null = null;

/** Get (or lazily create) the module-level TraceNavigator singleton. */
export function getTraceNavigator(): TraceNavigator {
  if (!_navigatorInstance) {
    _navigatorInstance = new TraceNavigator();
  }
  return _navigatorInstance;
}

/** Replace the singleton (for tests). */
export function setTraceNavigator(nav: TraceNavigator): void {
  _navigatorInstance = nav;
}

/** Reset the singleton (for tests). */
export function resetTraceNavigator(): void {
  _navigatorInstance = null;
}

// ── Internal helpers ───────────────────────────────────────────────────────────

function _truncate(s: string, max: number): string {
  if (!s) return "";
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

/** Collect every node in the tree (depth-first, including root). */
function _collectAllNodes(root: DecisionTreeNode): DecisionTreeNode[] {
  const result: DecisionTreeNode[] = [];
  function visit(n: DecisionTreeNode): void {
    result.push(n);
    for (const child of n.children) visit(child);
  }
  visit(root);
  return result;
}

function _findNodeById(root: DecisionTreeNode, id: string): DecisionTreeNode | null {
  if (root.id === id) return root;
  for (const child of root.children) {
    const found = _findNodeById(child, id);
    if (found) return found;
  }
  return null;
}

/** Return sibling nodes — nodes at the same depth that share the same parent. */
function _findSiblings(root: DecisionTreeNode, id: string): DecisionTreeNode[] {
  for (const child of root.children) {
    if (child.id === id) {
      // root's children are the siblings of this node
      return root.children.filter((c) => c.id !== id);
    }
    const found = _findSiblings(child, id);
    if (found.length > 0 || _findNodeById(child, id)) {
      // found is either populated, or the target is nested deeper — get its
      // direct parent to return siblings
      if (_findNodeById(child, id)) {
        return _getSiblingsOf(child, id);
      }
      return found;
    }
  }
  return [];
}

function _getSiblingsOf(parent: DecisionTreeNode, id: string): DecisionTreeNode[] {
  for (const child of parent.children) {
    if (child.id === id) {
      return parent.children.filter((c) => c.id !== id);
    }
    const sibs = _getSiblingsOf(child, id);
    if (sibs.length > 0 || _findNodeById(child, id)) {
      if (_findNodeById(child, id)) continue;
      return sibs;
    }
  }
  return [];
}

function _nodeToPlain(node: DecisionTreeNode): object {
  return {
    id: node.id,
    label: node.label,
    kind: node.kind,
    turn: node.turn,
    seq: node.seq,
    meta: node.meta,
    children: node.children.map(_nodeToPlain),
  };
}
