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
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export type StopReason = "end_turn" | "tool_use" | "max_tokens";

export interface StreamEvent {
  type: "text_delta" | "tool_call_start" | "tool_call_delta" | "tool_call_end" | "message_end" | "usage";
  text?: string;
  toolCall?: Partial<ToolCall>;
  stopReason?: StopReason;
  usage?: TokenUsage;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ProviderConfig {
  apiKey: string;
  model: string;
  baseURL?: string;
  maxTokens?: number;
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
