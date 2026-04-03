/**
 * Provider router — selects provider, handles failover, tracks costs.
 */

import { createOpenAICompatibleProvider, createXAIProvider } from "./xai.ts";
import { createAnthropicProvider } from "./anthropic.ts";
import { CostTracker } from "./cost-tracker.ts";
import { CircuitBreaker } from "./retry.ts";
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
          { inputTokens: e.usage.inputTokens, outputTokens: e.usage.outputTokens, reasoningTokens: e.usage.reasoningTokens, costUSD: e.costUSD },
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

      try {
        for await (const event of provider.stream(request)) {
          // Track usage
          if (event.type === "usage" && event.usage) {
            this.trackUsage(provider, event.usage);
          }
          yield event;
        }
        breaker.recordSuccess();
        return; // Success — exit
      } catch (err) {
        lastError = err as Error;
        breaker.recordFailure();

        const isRateLimit =
          lastError.message.includes("429") ||
          lastError.message.includes("rate_limit") ||
          lastError.message.includes("quota");

        if (isRateLimit && i + 1 < this.providers.length) {
          console.error(
            `\n⚠ ${provider.name} rate limited, falling back to ${this.providers[i + 1]!.name}...`
          );
          this.currentIndex = i + 1;
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
  }

  getCostSummary(): string {
    return this.costTracker.formatSummary();
  }
}
