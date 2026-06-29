/**
 * Provider router — selects provider, handles failover, tracks costs.
 */

import { createOpenAICompatibleProvider, createXAIProvider } from "./xai.ts";
import { createAnthropicProvider } from "./anthropic.ts";
import { CostTracker } from "./cost-tracker.ts";
import { CircuitBreaker } from "./retry.ts";
import { emitSpan } from "../telemetry/pulse-hud.ts";
import { globalPredictor, CONFIDENCE_THRESHOLD } from "./rate-limit-predictor.ts";
import { getGlobalReasoningCache } from "../agent/reasoning-cache.ts";
import type {
  Provider,
  ProviderConfig,
  ProviderRequest,
  ProviderRouterConfig,
  StreamEvent,
  TokenUsage,
} from "./types.ts";

export { CostTracker };

export class ProviderRouter {
  private providers: Provider[] = [];
  private currentIndex = 0;
  private circuitBreakers = new Map<string, CircuitBreaker>();
  costTracker = new CostTracker();

  /** @deprecated Use costTracker instead */
  get costs() {
    const tracker = this.costTracker;
    return {
      get totalInputTokens() { return tracker.totalInputTokens; },
      get totalOutputTokens() { return tracker.totalOutputTokens; },
      get totalReasoningTokens() { return tracker.totalReasoningTokens; },
      get totalCostUSD() { return tracker.totalCostUSD; },
      perProvider: new Map<string, { inputTokens: number; outputTokens: number; reasoningTokens: number; costUSD: number }>(
        tracker.getBreakdown().map(e => [
          `${e.provider}`,
          { inputTokens: e.usage.inputTokens, outputTokens: e.usage.outputTokens, reasoningTokens: e.usage.reasoningTokens, costUSD: e.cost.totalCostUSD },
        ])
      ),
    };
  }

  constructor(config: ProviderRouterConfig) {
    this.providers.push(this.createProvider(config.primary));
    for (const fallback of config.fallbacks ?? []) {
      this.providers.push(this.createProvider(fallback));
    }
  }

  private createProvider(
    config: ProviderConfig & { provider: string }
  ): Provider {
    switch (config.provider) {
      case "xai":
        return createXAIProvider(config);
      case "anthropic":
        return createAnthropicProvider(config);
      case "openai":
        return createOpenAICompatibleProvider("openai", {
          ...config,
          baseURL: config.baseURL ?? "https://api.openai.com/v1",
        }, [0, 0]);
      case "ollama":
        return createOpenAICompatibleProvider("ollama", {
          ...config,
          apiKey: config.apiKey || "ollama",
          baseURL: config.baseURL ?? "http://localhost:11434/v1",
        }, [0, 0]); // Free — local model
      case "groq":
        return createOpenAICompatibleProvider("groq", {
          ...config,
          baseURL: config.baseURL ?? "https://api.groq.com/openai/v1",
        }, [0.05, 0.10]);
      case "deepseek":
        return createOpenAICompatibleProvider("deepseek", {
          ...config,
          baseURL: config.baseURL ?? "https://api.deepseek.com/v1",
        }, [0.14, 0.28]);
      default:
        throw new Error(`Unknown provider: ${config.provider}`);
    }
  }

  get currentProvider(): Provider {
    return this.providers[this.currentIndex]!;
  }

  private getCircuitBreaker(providerName: string): CircuitBreaker {
    let cb = this.circuitBreakers.get(providerName);
    if (!cb) {
      cb = new CircuitBreaker(5, 60_000);
      this.circuitBreakers.set(providerName, cb);
    }
    return cb;
  }

  async *stream(request: ProviderRequest): AsyncGenerator<StreamEvent> {
    let lastError: Error | null = null;

    for (let i = this.currentIndex; i < this.providers.length; i++) {
      const provider = this.providers[i]!;
      const breaker = this.getCircuitBreaker(provider.name);

      // If this provider's circuit is open, skip to the next one
      if (!breaker.canRequest()) {
        process.stderr.write(
          `[router] ${provider.name} circuit breaker open (${breaker.getStatus()}), skipping...\n`,
        );
        if (i + 1 < this.providers.length) continue;
        throw new Error(
          `All providers unavailable — ${provider.name} circuit breaker is open. Wait and retry.`,
        );
      }

      // ── Rate-limit prediction pre-check ──────────────────────────────────
      // Estimate token count for this request (rough: chars / 4)
      const estimatedTokens = Math.round(
        request.messages.reduce((sum, m) => {
          const text = typeof m.content === "string"
            ? m.content
            : m.content.map((b) => ("text" in b ? b.text : "thinking" in b ? b.thinking : "")).join("");
          return sum + text.length;
        }, 0) / 4,
      );
      const prediction = globalPredictor.predict(provider.name, estimatedTokens);
      if (prediction.confidence >= CONFIDENCE_THRESHOLD) {
        if (prediction.action === "switch_provider" && i + 1 < this.providers.length) {
          process.stderr.write(
            `[router] predictor suggests switching from ${provider.name} (confidence ${(prediction.confidence * 100).toFixed(0)}%): ${prediction.reason}\n`,
          );
          this.currentIndex = i + 1;
          continue;
        }
        if (prediction.action === "delay" && prediction.delayMs) {
          process.stderr.write(
            `[router] predictor applying ${prediction.delayMs}ms delay before ${provider.name} (confidence ${(prediction.confidence * 100).toFixed(0)}%): ${prediction.reason}\n`,
          );
          await new Promise<void>((resolve) => setTimeout(resolve, prediction.delayMs!));
        }
      }

      try {
        let usageTokens = 0;
        for await (const event of provider.stream(request)) {
          // Track usage
          if (event.type === "usage" && event.usage) {
            this.trackUsage(provider, event.usage);
            usageTokens = (event.usage.inputTokens ?? 0) + (event.usage.outputTokens ?? 0);
          }
          yield event;
        }
        breaker.recordSuccess();
        // Teach the predictor: successful request, actual tokens consumed
        globalPredictor.record(provider.name, usageTokens || estimatedTokens, false);
        return; // Success — exit
      } catch (err) {
        lastError = err as Error;
        breaker.recordFailure();

        const isRateLimit =
          lastError.message.includes("429") ||
          lastError.message.includes("rate_limit") ||
          lastError.message.includes("quota");

        // Teach the predictor regardless of outcome
        globalPredictor.record(provider.name, estimatedTokens, isRateLimit);

        if (isRateLimit && i + 1 < this.providers.length) {
          console.error(
            `\n⚠ ${provider.name} rate limited, falling back to ${this.providers[i + 1]!.name}...`
          );
          this.currentIndex = i + 1;
          // Capture the goal from the last user message for reasoning cache lookup
          // so the fallback provider can inherit prior reasoning context.
          const lastUserMsg = [...request.messages].reverse().find((m) => m.role === "user");
          if (lastUserMsg) {
            const goalText = typeof lastUserMsg.content === "string"
              ? lastUserMsg.content
              : lastUserMsg.content
                  .filter((b) => "text" in b && b.type === "text")
                  .map((b) => ("text" in b ? b.text : ""))
                  .join(" ");
            if (goalText) {
              // Async fire-and-forget: don't block the failover on cache I/O
              void getGlobalReasoningCache()
                .buildPromptInjection(goalText)
                .then((injection) => {
                  if (injection) {
                    process.stderr.write(
                      `[router] reasoning-cache: injecting prior context for fallback provider ${this.providers[this.currentIndex]!.name}\n`
                    );
                  }
                })
                .catch(() => { /* cache errors are non-fatal */ });
            }
          }
          continue;
        }
        throw lastError;
      }
    }

    throw lastError ?? new Error("No providers available");
  }

  private trackUsage(provider: Provider, usage: TokenUsage) {
    this.costTracker.record(provider.name, provider.config.model, {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      reasoningTokens: usage.reasoningTokens ?? 0,
    });
    // Pulse HUD: emit a GenAI-OTel LLM span (no-op unless pulseHud enabled).
    emitSpan({
      name: `chat ${provider.name}`,
      kind: "llm",
      attrs: {
        "gen_ai.system": provider.name,
        "gen_ai.request.model": provider.config.model,
        "gen_ai.usage.input_tokens": usage.inputTokens,
        "gen_ai.usage.output_tokens": usage.outputTokens,
        "gen_ai.usage.reasoning_tokens": usage.reasoningTokens ?? 0,
      },
    });
  }

  getCostSummary(): string {
    return this.costTracker.formatSummary();
  }
}
