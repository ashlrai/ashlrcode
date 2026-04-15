/**
 * Context management — re-exports from @ashlr/core-efficiency.
 *
 * All three compression tiers (autoCompact, snipCompact, contextCollapse),
 * the needsCompaction helper, and the ContextConfig interface now live in
 * the shared package so ashlr-plugin can reuse them. This file stays as a
 * thin shim — every existing consumer of ashlrcode/src/agent/context.ts
 * keeps working unchanged.
 */

import { estimateTokensFromMessages } from "../utils/tokens.ts";

export {
  autoCompact,
  contextCollapse,
  DEFAULT_CONFIG,
  needsCompaction,
  snipCompact,
  type ContextConfig,
} from "@ashlr/core-efficiency/compression";
export {
  DEFAULT_CONTEXT_LIMIT,
  PROVIDER_CONTEXT_LIMITS,
  getProviderContextLimit,
  systemPromptBudget,
} from "@ashlr/core-efficiency/budget";

/** @deprecated Use estimateTokensFromMessages from ../utils/tokens.ts */
export const estimateTokens = estimateTokensFromMessages;
