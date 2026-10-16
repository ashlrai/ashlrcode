/**
 * /tool-warmup command — run capability warm-up in background and display a
 * summary table once complete.
 */

import { theme } from "../ui/theme.ts";
import type { Command } from "./types.ts";

export function toolWarmupCommands(): Command[] {
  return [
    {
      name: "/tool-warmup",
      description: "Pre-compute and cache tool capabilities across providers",
      category: "tools",
      handler: async (_args, ctx) => {
        const {
          runCapabilityWarmUp,
          formatWarmUpSummary,
          isCacheStale,
          getAllCachedEntries,
          loadCapabilityCache,
        } = await import("../agent/tool-capability-cache.ts");

        // Ensure cache is loaded before we check staleness
        await loadCapabilityCache();

        ctx.addOutput(theme.accent("\n  Running tool capability warm-up...\n"));
        ctx.setSpinnerText("Probing providers...");
        ctx.setProcessing(true);

        const startMs = Date.now();

        try {
          const summary = await runCapabilityWarmUp((provider, done, total) => {
            ctx.setSpinnerText(`Probing ${provider} (${done}/${total})...`);
          });

          ctx.setProcessing(false);

          const table = formatWarmUpSummary(summary);
          ctx.addOutput(table);

          // Highlight any high-latency warnings
          const { HIGH_LATENCY_THRESHOLD_MS } = await import(
            "../agent/tool-capability-cache.ts"
          );
          const allEntries = getAllCachedEntries();
          const slowEntries = allEntries.filter(
            (e) => e.latencyMs > HIGH_LATENCY_THRESHOLD_MS && e.capability !== "unsupported",
          );
          if (slowEntries.length > 0) {
            ctx.addOutput(
              theme.warning(
                `  Warning: ${slowEntries.length} tool/provider combination(s) exceeded ${HIGH_LATENCY_THRESHOLD_MS}ms latency threshold.\n`,
              ),
            );
            for (const e of slowEntries) {
              ctx.addOutput(
                theme.muted(`    ${e.toolName} on ${e.provider}: ${e.latencyMs.toFixed(1)}ms\n`),
              );
            }
          }
        } catch (err) {
          ctx.setProcessing(false);
          const msg = err instanceof Error ? err.message : String(err);
          ctx.addOutput(theme.error(`\n  Warm-up failed: ${msg}\n`));
        }

        return true;
      },
    },

    {
      name: "/tool-capabilities",
      aliases: ["/capabilities"],
      description: "Show cached tool capability entries",
      category: "tools",
      handler: async (_args, ctx) => {
        const {
          loadCapabilityCache,
          getAllCachedEntries,
          isCacheStale,
          CAPABILITY_CACHE_TTL_MS,
        } = await import("../agent/tool-capability-cache.ts");

        await loadCapabilityCache();
        const entries = getAllCachedEntries();

        if (entries.length === 0) {
          ctx.addOutput(
            theme.tertiary(
              "\n  No cached capability entries. Run /tool-warmup to populate.\n",
            ),
          );
          return true;
        }

        const stale = isCacheStale();
        if (stale) {
          ctx.addOutput(
            theme.warning("\n  Cache is stale — consider running /tool-warmup to refresh.\n"),
          );
        }

        const lines: string[] = [
          "",
          `  ${entries.length} cached entries:`,
          "",
          "  " + "Provider".padEnd(14) + "Tool".padEnd(12) + "Capability".padEnd(14) + "Latency".padEnd(10) + "CostΔ",
          "  " + "─".repeat(56),
        ];

        for (const e of entries) {
          const latStr = `${e.latencyMs.toFixed(1)}ms`;
          const costStr = e.cost_delta === 0 ? "—" : `+${e.cost_delta.toFixed(2)}`;
          const age = Math.round((Date.now() - new Date(e.last_tested).getTime()) / 60_000);
          const ageStr = age < 60 ? `${age}m ago` : `${Math.round(age / 60)}h ago`;
          lines.push(
            `  ${e.provider.padEnd(14)}${e.toolName.padEnd(12)}${e.capability.padEnd(14)}${latStr.padEnd(10)}${costStr.padEnd(8)}${ageStr}`,
          );
        }
        lines.push("");

        ctx.addOutput(lines.join("\n"));
        return true;
      },
    },
  ];
}
