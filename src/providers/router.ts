/**
 * Provider router — selects provider, handles failover, tracks costs.
 */

import { createXAIProvider } from "./xai.ts";
import { createAnthropicProvider } from "./anthropic.ts";
import type {
  Provider,
  ProviderConfig,
  ProviderRequest,
  ProviderRouterConfig,
  StreamEvent,
  TokenUsage,
} from "./types.ts";

export interface CostTracker {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalReasoningTokens: number;
  totalCostUSD: number;
  perProvider: Map<string, { inputTokens: number; outputTokens: number; reasoningTokens: number; costUSD: number }>;
}

export class ProviderRouter {
  private providers: Provider[] = [];
  private currentIndex = 0;
  costs: CostTracker = {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalReasoningTokens: 0,
    totalCostUSD: 0,
    perProvider: new Map(),
  };

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
        // OpenAI uses the same SDK as xAI, just different base URL
        return createXAIProvider({
          ...config,
          baseURL: config.baseURL ?? "https://api.openai.com/v1",
        });
      default:
        throw new Error(`Unknown provider: ${config.provider}`);
    }
  }

  get currentProvider(): Provider {
    return this.providers[this.currentIndex]!;
  }

  async *stream(request: ProviderRequest): AsyncGenerator<StreamEvent> {
    let lastError: Error | null = null;

    for (let i = this.currentIndex; i < this.providers.length; i++) {
      const provider = this.providers[i]!;
      try {
        for await (const event of provider.stream(request)) {
          // Track usage
          if (event.type === "usage" && event.usage) {
            this.trackUsage(provider, event.usage);
          }
          yield event;
        }
        return; // Success — exit
      } catch (err) {
        lastError = err as Error;
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
    this.costs.totalInputTokens += usage.inputTokens;
    this.costs.totalOutputTokens += usage.outputTokens;
    this.costs.totalReasoningTokens += usage.reasoningTokens ?? 0;

    // Include reasoning tokens in output cost (billed at output rate)
    const outputTokens = usage.outputTokens + (usage.reasoningTokens ?? 0);
    const cost =
      (usage.inputTokens / 1_000_000) * provider.pricing[0] +
      (outputTokens / 1_000_000) * provider.pricing[1];
    this.costs.totalCostUSD += cost;

    const existing = this.costs.perProvider.get(provider.name) ?? {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      costUSD: 0,
    };
    existing.inputTokens += usage.inputTokens;
    existing.outputTokens += usage.outputTokens;
    existing.reasoningTokens += usage.reasoningTokens ?? 0;
    existing.costUSD += cost;
    this.costs.perProvider.set(provider.name, existing);
  }

  getCostSummary(): string {
    const formatCost = (usd: number) =>
      usd < 0.01 ? `$${usd.toFixed(6)}` : `$${usd.toFixed(4)}`;

    const reasoning = this.costs.totalReasoningTokens > 0
      ? ` / ${this.costs.totalReasoningTokens.toLocaleString()} reasoning`
      : "";
    const lines = [
      `Total: ${formatCost(this.costs.totalCostUSD)} | ${this.costs.totalInputTokens.toLocaleString()} in / ${this.costs.totalOutputTokens.toLocaleString()} out${reasoning}`,
    ];
    for (const [name, data] of this.costs.perProvider) {
      const rTokens = data.reasoningTokens > 0 ? ` / ${data.reasoningTokens.toLocaleString()} reasoning` : "";
      lines.push(
        `  ${name}: ${data.inputTokens.toLocaleString()} in / ${data.outputTokens.toLocaleString()} out${rTokens} (${formatCost(data.costUSD)})`
      );
    }
    return lines.join("\n");
  }
}
