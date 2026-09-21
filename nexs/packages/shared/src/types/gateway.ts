/**
 * Provider-neutral contracts for the model layer.
 *
 * The engine only ever sees these shapes. No provider-specific field (Anthropic's
 * `system` top-level parameter, OpenAI's `tool_choice`, Gemini's `parts`) is allowed
 * to leak past `ModelGateway` — that is the whole point of the seam.
 */

export type ProviderType =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'openai-compatible'
  | 'azure-openai'
  | 'groq'
  | 'mistral'
  | 'deepseek'
  | 'xai'
  | 'together'
  | 'openrouter'
  | 'local'
  | 'ollama';

/**
 * How a provider can be made to emit structured JSON. The gateway picks the best
 * available mode; callers ask for "JSON matching this schema" and never choose.
 */
export type StructuredOutputMode =
  /** Native `response_format: json_schema` — the provider constrains decoding. */
  | 'json_schema'
  /** No native mode, but tool/function calling forces the shape. */
  | 'tool_forcing'
  /** Last resort: describe the schema in the prompt and validate afterwards. */
  | 'prompt';

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** For `role: 'tool'` — which tool call this is the result of. */
  toolCallId?: string;
  name?: string;
  /**
   * Tool calls an assistant message made. Needed to round-trip a transcript back to a
   * provider: an assistant turn that requested tools must be resent with those
   * requests, or the following `tool` results have nothing to attach to.
   */
  toolCalls?: ToolCallRequest[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface ToolCallRequest {
  id: string;
  name: string;
  /** Parsed arguments. Adapters are responsible for `JSON.parse` of provider strings. */
  args: unknown;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error';

export interface StructuredOutputRequest {
  /** Name given to the schema; some providers require it. */
  name: string;
  /** JSON Schema. */
  schema: unknown;
  strict?: boolean;
}

export interface EmbedResult {
  vectors: number[][];
  usage: TokenUsage;
}

export type StreamChunk =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; toolCall: ToolCallRequest }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'done'; finishReason: FinishReason };

/**
 * Price snapshot stored on `Model.metadata`. Kept here rather than in the DB so the
 * cost formula has exactly one definition.
 */
export interface ModelPricing {
  inputPer1kTokens: number;
  outputPer1kTokens: number;
}

export interface ModelMetadata {
  pricing?: ModelPricing;
  /** Required for `type: 'embedding'` — validated at write time by the memory layer. */
  embeddingDimension?: number;
  /** Ordering within a fallback chain. Lower runs first. */
  priority?: number;
  /**
   * Overrides the provider's default structured-output mechanism for this one model.
   *
   * The default belongs to the provider type (OpenAI decodes JSON natively, most
   * OpenAI-compatible runtimes do not), but a specific model can disagree — a fine-tune
   * or a proxy that rejects `response_format`. Without this, the only fix would be to
   * reclassify the whole provider.
   */
  structuredOutputMode?: StructuredOutputMode;
  /** Free-form provider extras (e.g. azure deployment name). */
  [key: string]: unknown;
}

export function computeCost(pricing: ModelPricing | undefined, usage: TokenUsage): number {
  if (pricing === undefined) return 0;
  const input = (usage.promptTokens / 1000) * pricing.inputPer1kTokens;
  const output = (usage.completionTokens / 1000) * pricing.outputPer1kTokens;
  // Round to 6 decimals — cost is a Float column and sub-cent noise is meaningless.
  return Math.round((input + output) * 1_000_000) / 1_000_000;
}

/**
 * Provider error classes the gateway needs to tell apart. Anything else is treated as
 * a retryable transport failure.
 */
export type GatewayFailureKind =
  /** 429 — honour `Retry-After`, retry, and count toward the circuit breaker. */
  | 'rate_limited'
  /** 5xx / network — retryable. */
  | 'unavailable'
  /** 401/403 — the credential is wrong. Never retried; trips the breaker immediately. */
  | 'auth'
  /** 400 with a schema/parameter complaint — retrying cannot help. */
  | 'bad_request'
  /** Context length exceeded. Retried only after the budgeting ladder shrinks the prompt. */
  | 'context_exceeded'
  /** Anything else. */
  | 'unknown';
