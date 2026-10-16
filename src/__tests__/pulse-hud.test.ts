import { test, expect, describe } from "bun:test";
import { PulseHud, type SpanInput } from "../telemetry/pulse-hud.ts";

/** Capture OTLP POSTs via an injected fetch. */
function makeFetch() {
  const calls: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
  const fetchImpl = (async (url: any, init: any) => {
    calls.push({
      url: String(url),
      body: JSON.parse(init?.body ?? "{}"),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const llmSpan: SpanInput = {
  name: "chat anthropic",
  kind: "llm",
  attrs: {
    "gen_ai.system": "anthropic",
    "gen_ai.request.model": "claude-sonnet-4-6-20250514",
    "gen_ai.usage.input_tokens": 1_000_000,
    "gen_ai.usage.output_tokens": 1_000_000,
  },
};

describe("PulseHud", () => {
  test("no-op when disabled — never POSTs", async () => {
    const { calls, fetchImpl } = makeFetch();
    const hud = new PulseHud({ enabled: false, endpoint: "https://pulse.test", fetchImpl });
    expect(hud.isActive()).toBe(false);
    hud.emitSpan(llmSpan);
    await hud.flush();
    expect(calls.length).toBe(0);
  });

  test("inert when no endpoint resolvable", () => {
    const prev = process.env.PULSE_OTLP_URL;
    delete process.env.PULSE_OTLP_URL;
    const hud = new PulseHud({ enabled: true });
    expect(hud.isActive()).toBe(false);
    if (prev !== undefined) process.env.PULSE_OTLP_URL = prev;
  });

  test("tracks running totals + cost even when disabled (for the TUI summary)", () => {
    const hud = new PulseHud({ enabled: false });
    hud.emitSpan(llmSpan); // 1M in + 1M out @ sonnet = $3 + $15 = $18
    hud.emitSpan({ name: "tool Bash", kind: "tool", durationMs: 5, attrs: { "gen_ai.tool.name": "Bash" } });
    expect(hud.totals.llmCalls).toBe(1);
    expect(hud.totals.toolCalls).toBe(1);
    expect(hud.totals.inputTokens).toBe(1_000_000);
    expect(hud.totals.costUSD).toBeCloseTo(18, 2);
    expect(hud.summaryLine()).toContain("1 llm");
    expect(hud.summaryLine()).toContain("1 tool");
  });

  test("appends /api/otlp/v1/traces to a base URL", async () => {
    const { calls, fetchImpl } = makeFetch();
    const hud = new PulseHud({ enabled: true, endpoint: "https://pulse.test", batchSize: 1, fetchImpl });
    expect(hud.isActive()).toBe(true);
    hud.emitSpan(llmSpan);
    await hud.flush();
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe("https://pulse.test/api/otlp/v1/traces");
  });

  test("does not double-append when given the full traces path", async () => {
    const { calls, fetchImpl } = makeFetch();
    const hud = new PulseHud({ enabled: true, endpoint: "https://pulse.test/api/otlp/v1/traces", batchSize: 1, fetchImpl });
    hud.emitSpan(llmSpan);
    await hud.flush();
    expect(calls[0]!.url).toBe("https://pulse.test/api/otlp/v1/traces");
  });

  test("emits GenAI-OTel-shaped span with gen_ai attributes", async () => {
    const { calls, fetchImpl } = makeFetch();
    const hud = new PulseHud({ enabled: true, endpoint: "https://pulse.test", batchSize: 1, sessionId: "sess-1", fetchImpl });
    hud.emitSpan(llmSpan);
    await hud.flush();

    const span = calls[0]!.body.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(span.kind).toBe(3);
    const attrKeys = span.attributes.map((a: any) => a.key);
    expect(attrKeys).toContain("gen_ai.operation.name");
    expect(attrKeys).toContain("gen_ai.request.model");
    expect(attrKeys).toContain("gen_ai.usage.input_tokens");
    expect(attrKeys).toContain("gen_ai.conversation.id");
    // resource carries service.name
    const resAttrs = calls[0]!.body.resourceSpans[0].resource.attributes.map((a: any) => a.key);
    expect(resAttrs).toContain("service.name");
  });

  test("error span sets status code 2", async () => {
    const { calls, fetchImpl } = makeFetch();
    const hud = new PulseHud({ enabled: true, endpoint: "https://pulse.test", batchSize: 1, fetchImpl });
    hud.emitSpan({ name: "tool Bash", kind: "tool", durationMs: 3, error: "boom" });
    await hud.close();
    const span = calls[0]!.body.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.status.code).toBe(2);
    expect(span.status.message).toBe("boom");
  });

  test("batches by size then flushes", async () => {
    const { calls, fetchImpl } = makeFetch();
    const hud = new PulseHud({ enabled: true, endpoint: "https://pulse.test", batchSize: 3, flushIntervalMs: 999_999, fetchImpl });
    hud.emitSpan(llmSpan);
    hud.emitSpan(llmSpan);
    expect(calls.length).toBe(0); // under batch threshold
    hud.emitSpan(llmSpan); // hits batchSize -> auto flush
    await hud.close();
    expect(calls.length).toBe(1);
    expect(calls[0]!.body.resourceSpans[0].scopeSpans[0].spans.length).toBe(3);
  });

  test("never throws when fetch rejects", async () => {
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const hud = new PulseHud({ enabled: true, endpoint: "https://pulse.test", batchSize: 1, fetchImpl });
    hud.emitSpan(llmSpan);
    // Should resolve, not reject.
    await hud.close();
    expect(hud.totals.llmCalls).toBe(1);
  });
});
