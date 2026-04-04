/**
 * Unified provider interface for multi-model support.
 * Normalizes Claude (Anthropic SDK) and xAI/OpenAI (OpenAI SDK) into a common streaming interface.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface Message {
  role: "user" | "assistant" | "tool";
  content: string | ContentBlock[];
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export type StopReason = "end_turn" | "tool_use" | "max_tokens";

export interface StreamEvent {
  type: "text_delta" | "thinking_delta" | "tool_call_start" | "tool_call_delta" | "tool_call_end" | "message_end" | "usage";
  text?: string;
  /** Signature for thinking blocks (Anthropic extended thinking) */
  signature?: string;
  toolCall?: Partial<ToolCall>;
  stopReason?: StopReason;
  usage?: TokenUsage;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** xAI-specific: cost in USD ticks (1 tick = $0.000001) */
  costTicks?: number;
  /** Reasoning tokens used by the model (separate from output) */
  reasoningTokens?: number;
}

export interface ProviderConfig {
  apiKey: string;
  model: string;
  baseURL?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface ProviderRequest {
  systemPrompt: string;
  messages: Message[];
  tools: ToolDefinition[];
  maxTokens?: number;
}

export interface Provider {
  name: string;
  config: ProviderConfig;
  stream(request: ProviderRequest): AsyncGenerator<StreamEvent>;
  /** Cost per million tokens [input, output] */
  pricing: [number, number];
}

export interface ProviderRouterConfig {
  primary: ProviderConfig & { provider: "xai" | "anthropic" | "openai" };
  fallbacks?: Array<ProviderConfig & { provider: "xai" | "anthropic" | "openai" }>;
}
