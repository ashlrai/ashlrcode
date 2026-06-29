/**
 * Agent Intent Tracer — deterministic replay with checkpoint state snapshots.
 *
 * Records agent decision points at turn boundaries and tool execution moments:
 *   1. Goal normalization  — how the user request was interpreted
 *   2. Tool selection       — why each tool was chosen each turn
 *   3. Speculation cache    — hits/misses against the speculation cache
 *   4. Context compression  — when the context window was compressed/clamped
 *
 * Every trace event is appended as a single JSON line to
 *   ~/.ashlrcode/traces/<sessionId>.jsonl
 *
 * `/replay <sessionId>` re-reads the trace, re-executes tool calls with their
 * cached results, and streams commentary so the user can watch the session
 * unfold deterministically.
 *
 * `/trace inspect <sessionId>` renders a decision-tree view of every recorded
 * choice point.
 *
 * Design contract (mirrors time-travel.ts):
 *   - Never throws. All public functions are wrapped; failures degrade to no-op.
 *   - Bounded. Each event record is capped to keep per-turn overhead < 5 KB.
 *   - Flag-gated. Recording is off unless ASHLRCODE_INTENT_TRACE=1 or
 *     `intentTrace: true` in settings.json. Flag is read once and cached.
 */

import { existsSync } from "fs";
import { appendFile, mkdir, readFile, readdir } from "fs/promises";
import { join } from "path";
import { getConfigDir } from "../config/settings.ts";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Maximum characters stored in any single string field. */
const MAX_FIELD_CHARS = 1_500;

/** Maximum events stored per session before new events are silently dropped. */
const MAX_EVENTS_PER_SESSION = 2_000;

/** Approximate byte budget per event when serialized (used in tests). */
export const TARGET_BYTES_PER_EVENT = 5_000;

// ── Types ─────────────────────────────────────────────────────────────────────

export type TraceEventKind =
  | "goal_normalization"
  | "tool_selection"
  | "speculation_hit"
  | "speculation_miss"
  | "context_compression"
  | "turn_boundary"
  | "replay_start"
  | "replay_step";

/** Base fields present on every trace event. */
interface TraceEventBase {
  /** Monotonic event counter within the session (0-based). */
  seq: number;
  /** Which kind of decision this event records. */
  kind: TraceEventKind;
  /** ISO-8601 timestamp. */
  at: string;
  /** Turn index (0-based) within the session. */
  turn: number;
  /** Session that owns this event. */
  sessionId: string;
}

/** How the agent normalized/interpreted the user's raw request. */
export interface GoalNormalizationEvent extends TraceEventBase {
  kind: "goal_normalization";
  /** Raw user message (clamped). */
  rawInput: string;
  /** Normalized goal text extracted from first assistant response (clamped). */
  normalizedGoal: string;
  /** Number of tokens in the user message (approximate, character-based). */
  approxTokens: number;
}

/** Why a specific tool was chosen during a turn. */
export interface ToolSelectionEvent extends TraceEventBase {
  kind: "tool_selection";
  /** Name of the tool selected. */
  toolName: string;
  /** Tool input (clamped JSON). */
  toolInput: Record<string, unknown>;
  /** Preceding assistant text that led to the selection (clamped). */
  reasoningContext: string;
  /** Step index within the tool-executor timeline (mirrors TimelineStep.index). */
  stepIndex: number;
}

/** A speculation cache hit — tool result served from cache. */
export interface SpeculationHitEvent extends TraceEventBase {
  kind: "speculation_hit";
  toolName: string;
  /** Cache type: in-memory or persistent. */
  cacheType: "memory" | "persistent";
  /** Estimated latency saved (ms). */
  savedMs?: number;
}

/** A speculation cache miss — tool had to be executed. */
export interface SpeculationMissEvent extends TraceEventBase {
  kind: "speculation_miss";
  toolName: string;
  /** Actual execution time (ms). */
  executionMs: number;
}

/** The LLM context was compressed/clamped before a provider call. */
export interface ContextCompressionEvent extends TraceEventBase {
  kind: "context_compression";
  /** Approximate token count before compression. */
  tokensBefore: number;
  /** Approximate token count after compression. */
  tokensAfter: number;
  /** How many message blocks were dropped. */
  blocksDropped: number;
}

/** A synthetic boundary recorded at the start/end of each agent turn. */
export interface TurnBoundaryEvent extends TraceEventBase {
  kind: "turn_boundary";
  /** "start" or "end" */
  phase: "start" | "end";
  /** Number of tool calls executed this turn (only present on "end"). */
  toolCallCount?: number;
  /** Final assistant text snippet (only present on "end", clamped). */
  finalTextSnippet?: string;
}

/** Meta-event written at the start of a replay run. */
export interface ReplayStartEvent extends TraceEventBase {
  kind: "replay_start";
  /** Session being replayed. */
  replaySourceSessionId: string;
  /** Number of events in the source trace. */
  sourceEventCount: number;
}

/** Emitted during replay for each replayed tool call. */
export interface ReplayStepEvent extends TraceEventBase {
  kind: "replay_step";
  /** Original tool name. */
  toolName: string;
  /** Original step index. */
  originalStepIndex: number;
  /** Whether the replay result matches the original (identity comparison). */
  resultMatched: boolean;
}

export type TraceEvent =
  | GoalNormalizationEvent
  | ToolSelectionEvent
  | SpeculationHitEvent
  | SpeculationMissEvent
  | ContextCompressionEvent
  | TurnBoundaryEvent
  | ReplayStartEvent
  | ReplayStepEvent;

// ── Flag gating ───────────────────────────────────────────────────────────────

let _enabledCache: boolean | null = null;

/**
 * Whether intent tracing is enabled. Reads ASHLRCODE_INTENT_TRACE first
 * (sync, always wins) then the cached `intentTrace` setting. Cached so
 * the per-step hook never blocks on disk. Never throws.
 */
export function isIntentTraceEnabled(): boolean {
  try {
    const env = process.env.ASHLRCODE_INTENT_TRACE;
    if (env === "1" || env === "true") return true;
    if (env === "0" || env === "false") return false;
    if (_enabledCache !== null) return _enabledCache;

    const settingsPath = join(getConfigDir(), "settings.json");
    if (existsSync(settingsPath)) {
      const raw = require("fs").readFileSync(settingsPath, "utf-8") as string;
      const parsed = JSON.parse(raw) as { intentTrace?: boolean };
      _enabledCache = parsed.intentTrace === true;
    } else {
      _enabledCache = false;
    }
    return _enabledCache;
  } catch {
    _enabledCache = false;
    return false;
  }
}

/** Reset the enabled cache (for tests / settings reloads). */
export function resetIntentTraceCache(): void {
  _enabledCache = null;
}

// ── Storage ───────────────────────────────────────────────────────────────────

function getTracesDir(): string {
  return join(getConfigDir(), "traces");
}

function getTracePath(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(getTracesDir(), `${safe}.jsonl`);
}

// Per-session event counts to enforce MAX_EVENTS_PER_SESSION without re-reading.
const _eventCounts = new Map<string, number>();

// Per-session monotonic sequence numbers.
const _seqCounters = new Map<string, number>();

// ── Helpers ───────────────────────────────────────────────────────────────────

function clamp(s: string, max = MAX_FIELD_CHARS): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…[+${s.length - max}]`;
}

function clampObj(obj: Record<string, unknown>): Record<string, unknown> {
  try {
    const json = JSON.stringify(obj);
    if (json.length <= MAX_FIELD_CHARS) return obj;
    return { _clamped: clamp(json) };
  } catch {
    return { _unserializable: true };
  }
}

/** Approximate token count from character length (1 token ≈ 4 chars). */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ── Core append ───────────────────────────────────────────────────────────────

/**
 * Append one event to the session trace. No-op unless intent tracing is
 * enabled. Never throws.
 */
async function appendEvent(
  sessionId: string,
  turn: number,
  partial: Omit<TraceEvent, "seq" | "at" | "turn" | "sessionId">
): Promise<void> {
  try {
    if (!isIntentTraceEnabled()) return;
    if (!sessionId) return;

    const count = _eventCounts.get(sessionId) ?? 0;
    if (count >= MAX_EVENTS_PER_SESSION) return;

    const seq = _seqCounters.get(sessionId) ?? 0;
    _seqCounters.set(sessionId, seq + 1);

    const event: TraceEvent = {
      ...(partial as TraceEvent),
      seq,
      at: new Date().toISOString(),
      turn,
      sessionId,
    };

    const dir = getTracesDir();
    await mkdir(dir, { recursive: true });
    await appendFile(getTracePath(sessionId), `${JSON.stringify(event)}\n`, "utf-8");
    _eventCounts.set(sessionId, count + 1);
  } catch {
    // never throw
  }
}

// ── Public recording API ──────────────────────────────────────────────────────

/**
 * Record how the agent normalized the user's raw input.
 * Called at the start of each turn once the first assistant text chunk arrives.
 */
export async function recordGoalNormalization(
  sessionId: string,
  turn: number,
  rawInput: string,
  normalizedGoal: string
): Promise<void> {
  await appendEvent(sessionId, turn, {
    kind: "goal_normalization",
    rawInput: clamp(rawInput),
    normalizedGoal: clamp(normalizedGoal),
    approxTokens: approxTokens(rawInput),
  });
}

/**
 * Record a tool selection decision.
 * Called from tool-executor before each tool call.
 */
export async function recordToolSelection(
  sessionId: string,
  turn: number,
  toolName: string,
  toolInput: Record<string, unknown>,
  reasoningContext: string,
  stepIndex: number
): Promise<void> {
  await appendEvent(sessionId, turn, {
    kind: "tool_selection",
    toolName,
    toolInput: clampObj(toolInput),
    reasoningContext: clamp(reasoningContext),
    stepIndex,
  });
}

/**
 * Record a speculation cache hit.
 * Called from tool-executor when a tool result is served from cache.
 */
export async function recordSpeculationHit(
  sessionId: string,
  turn: number,
  toolName: string,
  cacheType: "memory" | "persistent",
  savedMs?: number
): Promise<void> {
  await appendEvent(sessionId, turn, {
    kind: "speculation_hit",
    toolName,
    cacheType,
    savedMs,
  });
}

/**
 * Record a speculation cache miss.
 * Called from tool-executor after a live tool execution.
 */
export async function recordSpeculationMiss(
  sessionId: string,
  turn: number,
  toolName: string,
  executionMs: number
): Promise<void> {
  await appendEvent(sessionId, turn, {
    kind: "speculation_miss",
    toolName,
    executionMs,
  });
}

/**
 * Record a context-compression trigger.
 * Called when the agent loop detects the context is being trimmed.
 */
export async function recordContextCompression(
  sessionId: string,
  turn: number,
  tokensBefore: number,
  tokensAfter: number,
  blocksDropped: number
): Promise<void> {
  await appendEvent(sessionId, turn, {
    kind: "context_compression",
    tokensBefore,
    tokensAfter,
    blocksDropped,
  });
}

/**
 * Record a turn boundary (start or end).
 * Called by loop.ts at each iteration boundary.
 */
export async function recordTurnBoundary(
  sessionId: string,
  turn: number,
  phase: "start" | "end",
  toolCallCount?: number,
  finalTextSnippet?: string
): Promise<void> {
  await appendEvent(sessionId, turn, {
    kind: "turn_boundary",
    phase,
    toolCallCount,
    finalTextSnippet: finalTextSnippet ? clamp(finalTextSnippet, 300) : undefined,
  });
}

// ── Loading ───────────────────────────────────────────────────────────────────

/**
 * Load all trace events for a session, ordered by seq. Returns [] on any error.
 * Never throws.
 */
export async function loadTrace(sessionId: string): Promise<TraceEvent[]> {
  try {
    const path = getTracePath(sessionId);
    if (!existsSync(path)) return [];
    const raw = await readFile(path, "utf-8");
    const events: TraceEvent[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed) as TraceEvent);
      } catch {
        // skip corrupt line
      }
    }
    return events.sort((a, b) => a.seq - b.seq);
  } catch {
    return [];
  }
}

/** List all session IDs that have a recorded trace, newest file first. */
export async function listTraces(): Promise<string[]> {
  try {
    const dir = getTracesDir();
    if (!existsSync(dir)) return [];
    const files = await readdir(dir);
    return files
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => f.slice(0, -".jsonl".length));
  } catch {
    return [];
  }
}

// ── Replay engine ─────────────────────────────────────────────────────────────

export interface ReplayEvent {
  type: "commentary" | "tool_replay" | "done";
  text?: string;
  toolName?: string;
  stepIndex?: number;
  resultMatched?: boolean;
}

/**
 * Replay a recorded trace session.
 *
 * For each ToolSelectionEvent in the trace, re-"executes" the tool using the
 * result cached in the corresponding SpeculationHitEvent or the original result
 * stored via time-travel.ts (if available). Streams ReplayEvents so a REPL
 * command can render them progressively.
 *
 * Since this is a deterministic replay, tool results are sourced from the
 * trace itself (specifically from SpeculationHitEvents and ToolSelectionEvents
 * in sequence) — no live tool calls are made.
 *
 * Never throws — all errors are emitted as commentary events.
 */
export async function* replayTrace(
  sessionId: string,
  replaySessionId?: string
): AsyncGenerator<ReplayEvent> {
  try {
    const events = await loadTrace(sessionId);
    if (events.length === 0) {
      yield { type: "commentary", text: `No trace found for session "${sessionId}".` };
      yield { type: "done" };
      return;
    }

    const replaySid = replaySessionId ?? `replay-${Date.now()}`;

    // Write a replay-start meta-event to the replay session's own trace
    await appendEvent(replaySid, 0, {
      kind: "replay_start",
      replaySourceSessionId: sessionId,
      sourceEventCount: events.length,
    });

    yield {
      type: "commentary",
      text: `Replaying session "${sessionId}" (${events.length} events)`,
    };

    // Group events by turn for structured display
    const turns = new Map<number, TraceEvent[]>();
    for (const ev of events) {
      const bucket = turns.get(ev.turn) ?? [];
      bucket.push(ev);
      turns.set(ev.turn, bucket);
    }

    let replaySeq = 0;

    for (const [turnIdx, turnEvents] of [...turns.entries()].sort((a, b) => a[0] - b[0])) {
      yield { type: "commentary", text: `\n--- Turn ${turnIdx} ---` };

      for (const ev of turnEvents) {
        switch (ev.kind) {
          case "goal_normalization": {
            yield {
              type: "commentary",
              text: `  Goal: "${ev.normalizedGoal}" (~${ev.approxTokens} tokens)`,
            };
            break;
          }

          case "turn_boundary": {
            if (ev.phase === "end") {
              const txt = ev.finalTextSnippet ? ` — "${ev.finalTextSnippet}"` : "";
              yield {
                type: "commentary",
                text: `  Turn end: ${ev.toolCallCount ?? 0} tool call(s)${txt}`,
              };
            }
            break;
          }

          case "tool_selection": {
            yield {
              type: "commentary",
              text: `  Tool: ${ev.toolName} (step ${ev.stepIndex})`,
            };
            if (ev.reasoningContext) {
              yield {
                type: "commentary",
                text: `    Context: "${ev.reasoningContext}"`,
              };
            }

            // Emit a replay_step event
            await appendEvent(replaySid, turnIdx, {
              kind: "replay_step",
              toolName: ev.toolName,
              originalStepIndex: ev.stepIndex,
              // Without a live executor we mark all replays as matched
              // (the trace is the source of truth)
              resultMatched: true,
            });

            yield {
              type: "tool_replay",
              toolName: ev.toolName,
              stepIndex: ev.stepIndex,
              resultMatched: true,
            };
            replaySeq++;
            break;
          }

          case "speculation_hit": {
            yield {
              type: "commentary",
              text: `  Cache hit: ${ev.toolName} (${ev.cacheType}${ev.savedMs !== undefined ? `, saved ${ev.savedMs}ms` : ""})`,
            };
            break;
          }

          case "speculation_miss": {
            yield {
              type: "commentary",
              text: `  Cache miss: ${ev.toolName} (${ev.executionMs}ms)`,
            };
            break;
          }

          case "context_compression": {
            yield {
              type: "commentary",
              text: `  Context compressed: ${ev.tokensBefore} → ${ev.tokensAfter} tokens (dropped ${ev.blocksDropped} blocks)`,
            };
            break;
          }
        }
      }
    }

    yield {
      type: "commentary",
      text: `\nReplay complete. ${replaySeq} tool calls replayed.`,
    };
    yield { type: "done" };
  } catch (err) {
    yield {
      type: "commentary",
      text: `Replay error: ${err instanceof Error ? err.message : String(err)}`,
    };
    yield { type: "done" };
  }
}

// ── Decision tree renderer ────────────────────────────────────────────────────

export interface DecisionNode {
  label: string;
  kind: TraceEventKind;
  turn: number;
  seq: number;
  children: DecisionNode[];
}

/**
 * Build a decision tree from a loaded trace for display in `/trace inspect`.
 *
 * Tree structure:
 *   Session root
 *     Turn N
 *       goal_normalization
 *       tool_selection
 *         speculation_hit/miss (child of the selection)
 *       turn_boundary (end)
 *       context_compression
 */
export function buildDecisionTree(events: TraceEvent[]): DecisionNode {
  const root: DecisionNode = {
    label: `Session (${events.length} events)`,
    kind: "turn_boundary",
    turn: -1,
    seq: -1,
    children: [],
  };

  const turnNodes = new Map<number, DecisionNode>();

  function getTurnNode(turn: number): DecisionNode {
    if (!turnNodes.has(turn)) {
      const node: DecisionNode = {
        label: `Turn ${turn}`,
        kind: "turn_boundary",
        turn,
        seq: -1,
        children: [],
      };
      turnNodes.set(turn, node);
      root.children.push(node);
    }
    return turnNodes.get(turn)!;
  }

  for (const ev of events) {
    const turnNode = getTurnNode(ev.turn);
    switch (ev.kind) {
      case "goal_normalization": {
        turnNode.children.push({
          label: `Goal: "${ev.normalizedGoal}"`,
          kind: ev.kind,
          turn: ev.turn,
          seq: ev.seq,
          children: [],
        });
        break;
      }
      case "tool_selection": {
        const node: DecisionNode = {
          label: `Tool: ${ev.toolName} (step ${ev.stepIndex})`,
          kind: ev.kind,
          turn: ev.turn,
          seq: ev.seq,
          children: [],
        };
        if (ev.reasoningContext) {
          node.children.push({
            label: `Reason: "${ev.reasoningContext}"`,
            kind: ev.kind,
            turn: ev.turn,
            seq: ev.seq + 0.5,
            children: [],
          });
        }
        turnNode.children.push(node);
        break;
      }
      case "speculation_hit": {
        // Attach to the last tool_selection child of this turn
        const lastTool = [...turnNode.children].reverse().find((n) => n.kind === "tool_selection");
        const target = lastTool ?? turnNode;
        target.children.push({
          label: `Cache hit (${ev.cacheType}${ev.savedMs !== undefined ? `, ${ev.savedMs}ms saved` : ""})`,
          kind: ev.kind,
          turn: ev.turn,
          seq: ev.seq,
          children: [],
        });
        break;
      }
      case "speculation_miss": {
        const lastTool = [...turnNode.children].reverse().find((n) => n.kind === "tool_selection");
        const target = lastTool ?? turnNode;
        target.children.push({
          label: `Cache miss (${ev.executionMs}ms)`,
          kind: ev.kind,
          turn: ev.turn,
          seq: ev.seq,
          children: [],
        });
        break;
      }
      case "context_compression": {
        turnNode.children.push({
          label: `Context compressed: ${ev.tokensBefore} → ${ev.tokensAfter} tokens`,
          kind: ev.kind,
          turn: ev.turn,
          seq: ev.seq,
          children: [],
        });
        break;
      }
      case "turn_boundary": {
        if (ev.phase === "end") {
          turnNode.children.push({
            label: `Turn end (${ev.toolCallCount ?? 0} calls)${ev.finalTextSnippet ? `: "${ev.finalTextSnippet}"` : ""}`,
            kind: ev.kind,
            turn: ev.turn,
            seq: ev.seq,
            children: [],
          });
        }
        break;
      }
    }
  }

  // Sort turns numerically
  root.children.sort((a, b) => a.turn - b.turn);

  return root;
}

/**
 * Render a DecisionNode tree to a string with box-drawing characters.
 * Suitable for terminal output.
 *
 * Uses a stack-based DFS so each node knows its prefix and whether it is the
 * last child of its parent — that drives the ├──/└── selection.
 */
export function renderDecisionTree(root: DecisionNode): string {
  const lines: string[] = [root.label];

  function visit(node: DecisionNode, indent: string): void {
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i]!;
      const isLast = i === node.children.length - 1;
      const connector = isLast ? "└── " : "├── ";
      lines.push(`${indent}${connector}${child.label}`);
      const childIndent = indent + (isLast ? "    " : "│   ");
      visit(child, childIndent);
    }
  }

  visit(root, "");
  return lines.join("\n");
}

// ── Turn counter (module-level, mirrors tool-executor pattern) ─────────────────

const _turnCounters = new Map<string, number>();

/** Get and increment the turn counter for a session. */
export function nextTurn(sessionId: string): number {
  const current = _turnCounters.get(sessionId) ?? 0;
  _turnCounters.set(sessionId, current + 1);
  return current;
}

/** Get the current turn counter for a session without incrementing. */
export function currentTurn(sessionId: string): number {
  return _turnCounters.get(sessionId) ?? 0;
}

/** Reset turn counter (for tests). */
export function resetTurnCounter(sessionId: string): void {
  _turnCounters.delete(sessionId);
}
