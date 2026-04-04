import { describe, test, expect } from "bun:test";
import { ProviderRouter, CostTracker } from "../providers/router.ts";
import type { ProviderRouterConfig } from "../providers/types.ts";

// We can't make real API calls, so we test constructor behavior,
// config validation, and cost tracker integration.

describe("ProviderRouter", () => {
  // ── Constructor ───────────────────────────────────────────────────────

  describe("constructor", () => {
    test("creates router with xai provider", () => {
      const config: ProviderRouterConfig = {
        primary: { provider: "xai", apiKey: "test-key", model: "grok-3-fast" },
      };
      const router = new ProviderRouter(config);
      expect(router.currentProvider.name).toBe("xai");
      expect(router.currentProvider.config.model).toBe("grok-3-fast");
    });

    test("creates router with anthropic provider", () => {
      const config: ProviderRouterConfig = {
        primary: { provider: "anthropic", apiKey: "test-key", model: "claude-sonnet-4-6-20250514" },
      };
      const router = new ProviderRouter(config);
      expect(router.currentProvider.name).toBe("anthropic");
    });

    test("creates router with openai provider", () => {
      const config: ProviderRouterConfig = {
        primary: { provider: "openai", apiKey: "test-key", model: "gpt-4o" },
      };
      const router = new ProviderRouter(config);
      expect(router.currentProvider.name).toBe("openai");
    });

    test("throws for unknown provider", () => {
      const config = {
        primary: { provider: "nonexistent" as any, apiKey: "key", model: "m" },
      };
      expect(() => new ProviderRouter(config)).toThrow("Unknown provider: nonexistent");
    });
  });

  // ── Cost Tracker ──────────────────────────────────────────────────────

  describe("cost tracker", () => {
    test("costTracker is initialized as CostTracker instance", () => {
      const config: ProviderRouterConfig = {
        primary: { provider: "xai", apiKey: "test-key", model: "grok-3-fast" },
      };
      const router = new ProviderRouter(config);
      expect(router.costTracker).toBeInstanceOf(CostTracker);
    });

    test("costTracker starts at zero", () => {
      const config: ProviderRouterConfig = {
        primary: { provider: "xai", apiKey: "test-key", model: "grok-3-fast" },
      };
      const router = new ProviderRouter(config);
      expect(router.costTracker.totalCostUSD).toBe(0);
      expect(router.costTracker.totalInputTokens).toBe(0);
      expect(router.costTracker.totalOutputTokens).toBe(0);
    });
  });

  // ── Provider Config ───────────────────────────────────────────────────

  describe("provider config", () => {
    test("xai provider has correct pricing", () => {
      const config: ProviderRouterConfig = {
        primary: { provider: "xai", apiKey: "test-key", model: "grok-3-fast" },
      };
      const router = new ProviderRouter(config);
      expect(router.currentProvider.pricing).toEqual([0.2, 0.5]);
    });

    test("anthropic provider has correct pricing", () => {
      const config: ProviderRouterConfig = {
        primary: { provider: "anthropic", apiKey: "test-key", model: "claude-sonnet-4-6-20250514" },
      };
      const router = new ProviderRouter(config);
      expect(router.currentProvider.pricing).toEqual([3.0, 15.0]);
    });

    test("provider config is preserved", () => {
      const config: ProviderRouterConfig = {
        primary: {
          provider: "xai",
          apiKey: "my-api-key",
          model: "grok-3-fast",
          maxTokens: 4096,
          temperature: 0.5,
        },
      };
      const router = new ProviderRouter(config);
      expect(router.currentProvider.config.apiKey).toBe("my-api-key");
      expect(router.currentProvider.config.model).toBe("grok-3-fast");
      expect(router.currentProvider.config.maxTokens).toBe(4096);
      expect(router.currentProvider.config.temperature).toBe(0.5);
    });
  });

  // ── Fallbacks ─────────────────────────────────────────────────────────

  describe("fallbacks", () => {
    test("currentProvider returns primary when no failover", () => {
      const config: ProviderRouterConfig = {
        primary: { provider: "xai", apiKey: "test-key", model: "grok-3-fast" },
        fallbacks: [
          { provider: "anthropic", apiKey: "test-key-2", model: "claude-sonnet-4-6-20250514" },
        ],
      };
      const router = new ProviderRouter(config);
      expect(router.currentProvider.name).toBe("xai");
    });

    test("accepts empty fallbacks array", () => {
      const config: ProviderRouterConfig = {
        primary: { provider: "xai", apiKey: "test-key", model: "grok-3-fast" },
        fallbacks: [],
      };
      const router = new ProviderRouter(config);
      expect(router.currentProvider.name).toBe("xai");
    });
  });

  // ── Legacy costs compat ───────────────────────────────────────────────

  describe("legacy costs interface", () => {
    test("costs getter exposes totalInputTokens", () => {
      const config: ProviderRouterConfig = {
        primary: { provider: "xai", apiKey: "test-key", model: "grok-3-fast" },
      };
      const router = new ProviderRouter(config);
      expect(router.costs.totalInputTokens).toBe(0);
      expect(router.costs.totalOutputTokens).toBe(0);
      expect(router.costs.totalCostUSD).toBe(0);
    });

    test("costs.perProvider is a Map", () => {
      const config: ProviderRouterConfig = {
        primary: { provider: "xai", apiKey: "test-key", model: "grok-3-fast" },
      };
      const router = new ProviderRouter(config);
      expect(router.costs.perProvider).toBeInstanceOf(Map);
    });
  });

  // ── Cost summary ──────────────────────────────────────────────────────

  describe("getCostSummary", () => {
    test("returns a string", () => {
      const config: ProviderRouterConfig = {
        primary: { provider: "xai", apiKey: "test-key", model: "grok-3-fast" },
      };
      const router = new ProviderRouter(config);
      expect(typeof router.getCostSummary()).toBe("string");
    });
  });
});
