import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { StreamEvent } from "../providers/types.ts";

type Scenario = "text" | "tool" | "partial-error" | "before-start-error" | "retry";
interface FixtureResult {
  events: StreamEvent[];
  error: string | null;
  requests: number;
  input: number;
  output: number;
  calls: number;
  cost: number;
  budgetExceeded: boolean;
  alerts: string[];
}

async function runFixture(scenario: Scenario): Promise<FixtureResult> {
  const home = await mkdtemp(join(tmpdir(), "anthropic-usage-fixture-"));
  // A subprocess prevents fetch replacement, SDK imports, HOME-derived paths,
  // and predictor/registry singletons from contaminating the rest of bun test.
  const script = `
    const scenario = ${JSON.stringify(scenario)};
    const wire = [];
    const add = (event) => wire.push('event: ' + event.type + '\\ndata: ' + JSON.stringify(event) + '\\n\\n');
    const fail = () => add({ type: 'error', error: { type: 'invalid_request_error', message: 'synthetic fixture failure' } });
    if (scenario === 'before-start-error') {
      fail();
    } else {
      add({ type: 'message_start', message: {
        id: 'msg_fixture', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 2 }
      }});
      add({ type: 'content_block_start', index: 0, content_block: scenario === 'tool'
        ? { type: 'tool_use', id: 'tool_fixture', name: 'Read', input: {} }
        : { type: 'text', text: '' } });
      add({ type: 'content_block_delta', index: 0, delta: scenario === 'tool'
        ? { type: 'input_json_delta', partial_json: '{"path":"fixture.txt"}' }
        : { type: 'text_delta', text: 'Fixture answer' } });
      add({ type: 'content_block_stop', index: 0 });
      add({ type: 'message_delta', delta: { stop_reason: null, stop_sequence: null }, usage: { output_tokens: 30 } });
      if (scenario === 'partial-error') {
        fail();
      } else {
        add({ type: 'message_delta', delta: { stop_reason: null, stop_sequence: null }, usage: { output_tokens: 50 } });
        add({ type: 'message_delta', delta: { stop_reason: scenario === 'tool' ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 50 } });
        add({ type: 'message_stop' });
      }
    }
    let requests = 0;
    globalThis.fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url !== 'https://anthropic-fixture.invalid/v1/messages') throw new Error('Unexpected fixture URL');
      requests++;
      // End the first attempt after its 30-token snapshot; the next request
      // receives a fresh complete stream with cumulative output ending at 50.
      const body = scenario === 'retry' && requests === 1
        ? wire.slice(0, 5).join('') + 'event: error\\ndata: ' + JSON.stringify({
            type: 'error', error: { type: 'overloaded_error', message: 'synthetic fixture 503 failure' }
          }) + '\\n\\n'
        : wire.join('');
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    const { ProviderRouter } = await import('./src/providers/router.ts');
    const router = new ProviderRouter({ primary: {
      provider: 'anthropic', apiKey: 'sk-ant-synthetic-fixture-not-a-real-key',
      model: 'claude-sonnet-4-6', baseURL: 'https://anthropic-fixture.invalid'
    }});
    router.costTracker.budgetUSD = 0.001;
    const alerts = [];
    router.costTracker.onBudgetAlert = (alert) => alerts.push(alert.level);
    const events = [];
    let error = null;
    try {
      for await (const event of router.stream({
        systemPrompt: 'Synthetic accounting fixture',
        messages: [{ role: 'user', content: 'Fixture request' }],
        tools: scenario === 'tool' ? [{ name: 'Read', description: 'Fixture tool', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }] : []
      })) events.push(event);
    } catch (failure) {
      error = failure.message;
    }
    console.log(JSON.stringify({ events, error, requests,
      input: router.costTracker.totalInputTokens, output: router.costTracker.totalOutputTokens,
      calls: router.costTracker.getBreakdown().reduce((sum, entry) => sum + entry.calls, 0),
      cost: router.costTracker.totalCostUSD, budgetExceeded: router.costTracker.isBudgetExceeded(), alerts
    }));
  `;
  const child = Bun.spawn([process.execPath, "--no-env-file", "--eval", script], {
    cwd: dirname(dirname(import.meta.dir)),
    env: { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, "config"), PATH: "", NO_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const deadline = setTimeout(() => child.kill(), 10_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    if (exitCode !== 0) throw new Error(`Synthetic SDK fixture exited ${exitCode}: ${stderr}`);
    return JSON.parse(stdout.trim()) as FixtureResult;
  } finally {
    clearTimeout(deadline);
    await rm(home, { recursive: true, force: true });
  }
}

describe("Anthropic SDK streaming usage accounting", () => {
  for (const scenario of ["text", "tool"] as const) {
    test(`${scenario}: one final cumulative usage record drives the router ledger and budget`, async () => {
      const result = await runFixture(scenario);
      expect(result.error).toBeNull();
      expect(result.requests).toBe(1);
      expect(result.events.filter((event) => event.type === "usage")).toEqual([
        { type: "usage", usage: { inputTokens: 100, outputTokens: 50 } },
      ]);
      expect({ input: result.input, output: result.output, calls: result.calls })
        .toEqual({ input: 100, output: 50, calls: 1 });
      expect(result.cost).toBeCloseTo(0.00105, 10);
      expect(result.budgetExceeded).toBe(true);
      expect(result.alerts).toEqual(["exceeded"]);
      const ends = result.events.filter((event) => event.type === "message_end");
      expect(ends).toHaveLength(1);
      expect(ends[0]?.stopReason).toBe(scenario === "tool" ? "tool_use" : "end_turn");
      if (scenario === "tool") {
        expect(result.events.filter((event) => event.type === "tool_call_end")).toEqual([
          { type: "tool_call_end", toolCall: { id: "tool_fixture", name: "Read", input: { path: "fixture.txt" } } },
        ]);
      } else {
        expect(result.events.filter((event) => event.type === "text_delta").map((event) => event.text))
          .toEqual(["Fixture answer"]);
      }
    });
  }

  test("SDK failure retains the last known cumulative usage once", async () => {
    const result = await runFixture("partial-error");
    expect(result.error).toContain("synthetic fixture failure");
    expect(result.requests).toBe(1);
    expect(result.events.filter((event) => event.type === "usage")).toEqual([
      { type: "usage", usage: { inputTokens: 100, outputTokens: 30 } },
    ]);
    expect({ input: result.input, output: result.output, calls: result.calls })
      .toEqual({ input: 100, output: 30, calls: 1 });
    expect(result.cost).toBeCloseTo(0.00075, 10);
  });

  test("SDK failure before message_start does not invent usage or a ledger call", async () => {
    const result = await runFixture("before-start-error");
    expect(result.error).toContain("synthetic fixture failure");
    expect(result.requests).toBe(1);
    expect(result.events.filter((event) => event.type === "usage")).toEqual([]);
    expect({ input: result.input, output: result.output, calls: result.calls, cost: result.cost })
      .toEqual({ input: 0, output: 0, calls: 0, cost: 0 });
    expect(result.alerts).toEqual([]);
  });

  test("retry records the failed attempt and successful attempt separately without cumulative duplication", async () => {
    const result = await runFixture("retry");
    expect(result.error).toBeNull();
    expect(result.requests).toBe(2);
    expect(result.events.filter((event) => event.type === "usage")).toEqual([
      { type: "usage", usage: { inputTokens: 100, outputTokens: 30 } },
      { type: "usage", usage: { inputTokens: 100, outputTokens: 50 } },
    ]);
    expect({ input: result.input, output: result.output, calls: result.calls })
      .toEqual({ input: 200, output: 80, calls: 2 });
    expect(result.cost).toBeCloseTo(0.0018, 10);
    expect(result.budgetExceeded).toBe(true);
    expect(result.alerts.filter((level) => level === "exceeded")).toHaveLength(1);
    expect(result.events.filter((event) => event.type === "message_end")).toHaveLength(1);
  });
});
