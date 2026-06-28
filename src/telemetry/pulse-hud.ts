/**
 * Pulse HUD — live GenAI-OpenTelemetry cost/trace visibility for autonomous runs.
 *
 * Emits one OTLP span per LLM call and per tool call from ac's autonomous loop
 * to ashlr-pulse (`POST <pulse>/api/otlp/v1/traces`), so cost / model / duration /
 * token usage stream to the Pulse dashboard in real time. Also tracks a running
 * cost/token tally for a compact in-TUI summary line.
 *
 * Design constraints:
 *  - Never throws. Any failure (no endpoint, network error, malformed config)
 *    degrades to a silent no-op — telemetry must never crash the agent.
 *  - Flag-gated. Off unless `pulseHud` is enabled in settings (or AC_FEATURE
 *    style env). Endpoint comes from settings `pulseOtlpUrl` or env
 *    `PULSE_OTLP_URL`. With no endpoint resolvable, the tracer is inert.
 *  - Batches spans and flushes opportunistically (size or time based), with a
 *    final flush at session end.
 *
 * GenAI semantic conventions (OpenTelemetry `gen_ai.*`) are used for attributes
 * so Pulse can render them with the standard GenAI-OTel views.
 */

// ── Span model ──────────────────────────────────────────────────────────────

export type SpanKindName = "llm" | "tool";

export interface SpanInput {
  /** Human/span name, e.g. "chat anthropic" or "tool Bash". */
  name: string;
  /** Logical kind — selects GenAI conventions vs tool-exec conventions. */
  kind: SpanKindName;
  /** Flat attribute bag (gen_ai.* etc). Values are string|number|boolean. */
  attrs?: Record<string, string | number | boolean | undefined>;
  /** Optional explicit duration (ms). When omitted, defaults to 0. */
  durationMs?: number;
  /** Optional error message; sets span status to ERROR. */
  error?: string;
}

interface OtlpKeyValue {
  key: string;
  value:
    | { stringValue: string }
    | { intValue: string }
    | { doubleValue: number }
    | { boolValue: boolean };
}

interface OtlpSpan {
  traceId: string; // 16-byte hex (32 chars)
  spanId: string; // 8-byte hex (16 chars)
  name: string;
  kind: number; // SpanKind enum — 3 = CLIENT (LLM/tool calls)
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpKeyValue[];
  status?: { code: number; message?: string }; // 2 = ERROR
}

// ── Config ──────────────────────────────────────────────────────────────────

export interface PulseHudConfig {
  /** Master switch. When false, the tracer is a no-op. */
  enabled: boolean;
  /** OTLP traces endpoint. Resolved from settings or PULSE_OTLP_URL. */
  endpoint?: string;
  /** Optional bearer token / api key for the OTLP endpoint. */
  apiKey?: string;
  /** Stable session id, becomes the trace id seed + gen_ai.conversation.id. */
  sessionId?: string;
  /** Flush when this many spans are buffered (default 16). */
  batchSize?: number;
  /** Flush at most this often (ms) on the time-based path (default 5000). */
  flushIntervalMs?: number;
  /** Injectable fetch for testing; defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

/** Pricing per million tokens, mirrors the provider cost-tracker tables. */
function estimateCostUSD(
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  const p = pricingFor(model);
  return (
    (inputTokens / 1_000_000) * p[0] + (outputTokens / 1_000_000) * p[1]
  );
}

// Compact pricing map (USD/M). Unknown → moderate default. Local/free → 0.
function pricingFor(model: string): [number, number] {
  const m = model.toLowerCase();
  const exact: Record<string, [number, number]> = {
    "grok-4.3": [0.2, 0.5],
    "grok-3-fast": [0.1, 0.3],
    "claude-opus-4-6-20250514": [15, 75],
    "claude-sonnet-4-6-20250514": [3, 15],
    "claude-haiku-4-5-20251001": [0.8, 4],
    "gpt-4o": [2.5, 10],
    "gpt-4o-mini": [0.15, 0.6],
    "deepseek-chat": [0.14, 0.28],
  };
  if (exact[m]) return exact[m];
  for (const [k, v] of Object.entries(exact)) {
    if (m.startsWith(k) || k.startsWith(m)) return v;
  }
  // Local models are free.
  if (/llama|mistral|mixtral|qwen|gemma|phi|codellama|starcoder|ollama/.test(m)) {
    return [0, 0];
  }
  return [1, 3];
}

// ── Hex id helpers (no crypto dep needed) ─────────────────────────────────────

function randHex(bytes: number): string {
  let s = "";
  for (let i = 0; i < bytes * 2; i++) {
    s += ((Math.random() * 16) | 0).toString(16);
  }
  return s;
}

/** Derive a stable 32-char trace id from a session id (fallback: random). */
function traceIdFromSession(sessionId?: string): string {
  if (!sessionId) return randHex(16);
  // FNV-1a-ish fold into 32 hex chars, deterministic per session.
  let h1 = 0x811c9dc5 >>> 0;
  let h2 = 0x01000193 >>> 0;
  for (let i = 0; i < sessionId.length; i++) {
    const c = sessionId.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
  }
  const seg = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
  return (seg(h1) + seg(h2) + seg(h1 ^ h2) + seg(Math.imul(h1, h2))).slice(
    0,
    32
  );
}

// ── Attribute encoding ────────────────────────────────────────────────────────

function toKeyValues(
  attrs: Record<string, string | number | boolean | undefined>
): OtlpKeyValue[] {
  const out: OtlpKeyValue[] = [];
  for (const [key, raw] of Object.entries(attrs)) {
    if (raw === undefined) continue;
    if (typeof raw === "boolean") {
      out.push({ key, value: { boolValue: raw } });
    } else if (typeof raw === "number") {
      out.push(
        Number.isInteger(raw)
          ? { key, value: { intValue: String(raw) } }
          : { key, value: { doubleValue: raw } }
      );
    } else {
      out.push({ key, value: { stringValue: raw } });
    }
  }
  return out;
}

// ── Running totals for the TUI summary ─────────────────────────────────────────

export interface HudTotals {
  llmCalls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
}

// ── Session tracer ─────────────────────────────────────────────────────────────

export class PulseHud {
  private readonly enabled: boolean;
  private readonly endpoint?: string;
  private readonly apiKey?: string;
  private readonly traceId: string;
  private readonly sessionId?: string;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly fetchImpl: typeof fetch;

  private buffer: OtlpSpan[] = [];
  private lastFlush = Date.now();
  private inFlight: Promise<void> = Promise.resolve();

  readonly totals: HudTotals = {
    llmCalls: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUSD: 0,
  };

  constructor(cfg: PulseHudConfig) {
    this.endpoint = resolveEndpoint(cfg.endpoint);
    // Active only when explicitly enabled AND we have somewhere to send.
    this.enabled = !!cfg.enabled && !!this.endpoint;
    this.apiKey = cfg.apiKey ?? process.env.PULSE_OTLP_API_KEY ?? undefined;
    this.sessionId = cfg.sessionId;
    this.traceId = traceIdFromSession(cfg.sessionId);
    this.batchSize = Math.max(1, cfg.batchSize ?? 16);
    this.flushIntervalMs = Math.max(0, cfg.flushIntervalMs ?? 5000);
    this.fetchImpl = cfg.fetchImpl ?? globalThis.fetch;
  }

  /** Whether spans will actually be transmitted. */
  isActive(): boolean {
    return this.enabled;
  }

  /**
   * Emit a single span. Updates running totals regardless of transmit state
   * (so the TUI summary works even with no endpoint), then buffers + maybe
   * flushes when active. Never throws.
   */
  emitSpan(span: SpanInput): void {
    try {
      this.recordTotals(span);
      if (!this.enabled) return;

      const now = Date.now();
      const dur = Math.max(0, span.durationMs ?? 0);
      const endNano = BigInt(now) * 1_000_000n;
      const startNano = BigInt(now - dur) * 1_000_000n;

      const attrs: Record<string, string | number | boolean | undefined> = {
        "gen_ai.operation.name": span.kind === "llm" ? "chat" : "execute_tool",
        ...(this.sessionId
          ? { "gen_ai.conversation.id": this.sessionId }
          : {}),
        ...(span.attrs ?? {}),
      };

      const otlp: OtlpSpan = {
        traceId: this.traceId,
        spanId: randHex(8),
        name: span.name,
        kind: 3, // CLIENT
        startTimeUnixNano: startNano.toString(),
        endTimeUnixNano: endNano.toString(),
        attributes: toKeyValues(attrs),
        ...(span.error
          ? { status: { code: 2, message: span.error } }
          : {}),
      };

      this.buffer.push(otlp);
      if (
        this.buffer.length >= this.batchSize ||
        now - this.lastFlush >= this.flushIntervalMs
      ) {
        void this.flush();
      }
    } catch {
      // Never let telemetry crash the agent.
    }
  }

  private recordTotals(span: SpanInput): void {
    if (span.kind === "llm") {
      this.totals.llmCalls++;
      const inT = numAttr(span.attrs, "gen_ai.usage.input_tokens");
      const outT = numAttr(span.attrs, "gen_ai.usage.output_tokens");
      this.totals.inputTokens += inT;
      this.totals.outputTokens += outT;
      const explicit = numAttr(span.attrs, "gen_ai.usage.cost_usd");
      const model = strAttr(span.attrs, "gen_ai.request.model");
      this.totals.costUSD +=
        explicit > 0 ? explicit : estimateCostUSD(model, inT, outT);
    } else {
      this.totals.toolCalls++;
    }
  }

  /** Flush buffered spans to the OTLP endpoint. Never throws. */
  async flush(): Promise<void> {
    if (!this.enabled) return;
    // Nothing buffered, but an auto-flush may be mid-send — await it so callers
    // (and tests) see a settled state after flush() resolves.
    if (this.buffer.length === 0) {
      await this.inFlight.catch(() => {});
      return;
    }
    const spans = this.buffer;
    this.buffer = [];
    this.lastFlush = Date.now();

    const payload = {
      resourceSpans: [
        {
          resource: {
            attributes: toKeyValues({
              "service.name": "ashlrcode",
              "telemetry.sdk.name": "ashlrcode-pulse-hud",
              ...(this.sessionId ? { "session.id": this.sessionId } : {}),
            }),
          },
          scopeSpans: [
            {
              scope: { name: "ac.pulse-hud" },
              spans,
            },
          ],
        },
      ],
    };

    // Chain so a final flush() awaits any in-flight send.
    this.inFlight = this.inFlight
      .catch(() => {})
      .then(async () => {
        try {
          await this.fetchImpl(this.endpoint as string, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(this.apiKey
                ? { authorization: `Bearer ${this.apiKey}` }
                : {}),
            },
            body: JSON.stringify(payload),
          });
        } catch {
          // Drop on failure — telemetry is best-effort, never blocks the agent.
        }
      });
    await this.inFlight;
  }

  /** Final flush at session end. Never throws. */
  async close(): Promise<void> {
    try {
      await this.flush();
      await this.inFlight;
    } catch {
      /* no-op */
    }
  }

  /** Compact single-line summary for the TUI status bar. */
  summaryLine(): string {
    const t = this.totals;
    const cost = t.costUSD >= 0.01 ? `$${t.costUSD.toFixed(2)}` : `$${t.costUSD.toFixed(4)}`;
    const tok = `${fmtTokens(t.inputTokens)}/${fmtTokens(t.outputTokens)}`;
    const dot = this.enabled ? "●" : "○";
    return `${dot} pulse ${t.llmCalls} llm · ${t.toolCalls} tool · ${tok} tok · ${cost}`;
  }
}

// ── Attribute readers ──────────────────────────────────────────────────────────

function numAttr(
  attrs: Record<string, string | number | boolean | undefined> | undefined,
  key: string
): number {
  const v = attrs?.[key];
  return typeof v === "number" ? v : 0;
}

function strAttr(
  attrs: Record<string, string | number | boolean | undefined> | undefined,
  key: string
): string {
  const v = attrs?.[key];
  return typeof v === "string" ? v : "";
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
}

/** POST <pulse>/api/otlp/v1/traces — normalize a base URL into the full path. */
function resolveEndpoint(configured?: string): string | undefined {
  const raw = (configured ?? process.env.PULSE_OTLP_URL ?? "").trim();
  if (!raw) return undefined;
  // Already pointed at the traces path? Use as-is.
  if (/\/v1\/traces\/?$/.test(raw)) return raw.replace(/\/$/, "");
  // Base pulse URL → append the OTLP traces path.
  return raw.replace(/\/$/, "") + "/api/otlp/v1/traces";
}

// ── Module-level singleton (so tiny hooks can fire without plumbing) ──────────

let _hud: PulseHud | null = null;

/** Install the active session HUD. Call once during session bootstrap. */
export function initPulseHud(cfg: PulseHudConfig): PulseHud {
  _hud = new PulseHud(cfg);
  return _hud;
}

/** The active HUD, if any. */
export function getPulseHud(): PulseHud | null {
  return _hud;
}

/**
 * Tiny entry point for hook call sites. No-op when no HUD installed or
 * tracing disabled — safe to call from anywhere. Never throws.
 */
export function emitSpan(span: SpanInput): void {
  _hud?.emitSpan(span);
}

/** Reset (tests). */
export function _resetPulseHudForTests(): void {
  _hud = null;
}
