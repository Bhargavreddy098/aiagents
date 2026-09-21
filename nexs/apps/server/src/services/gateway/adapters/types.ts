import type {
  EmbedResult,
  FinishReason,
  ProviderType,
  StreamChunk,
  StructuredOutputMode,
  StructuredOutputRequest,
  TokenUsage,
  ToolCallRequest,
  ToolDefinition,
  ChatMessage,
} from '@nexs/shared';

/** Injected so every adapter is testable without a network. */
export type FetchLike = typeof globalThis.fetch;

export interface AdapterContext {
  /** Resolved from `ModelProvider.baseUrl`, or the adapter's default when unset. */
  baseUrl: string;
  apiKey: string | null;
  organizationId?: string | null;
  projectId?: string | null;
  /** Provider-specific headers (e.g. OpenRouter attribution). */
  extraHeaders?: Record<string, string>;
  fetch: FetchLike;
  signal?: AbortSignal;
}

export interface AdapterChatRequest {
  externalModelId: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  /** Force one specific tool — how `tool_forcing` structured output is implemented. */
  forceToolName?: string;
  temperature?: number;
  maxOutputTokens?: number;
  responseFormat?: StructuredOutputRequest;
}

export interface AdapterChatResult {
  content: string;
  toolCalls: ToolCallRequest[];
  finishReason: FinishReason;
  usage: TokenUsage;
}

export interface AdapterEmbedRequest {
  externalModelId: string;
  input: string[];
}

/**
 * One model as a provider's own catalogue endpoint describes it.
 *
 * ## What is deliberately absent
 *
 * `contextWindow`, `maxOutputTokens` and `capabilities` are optional and **no adapter invents
 * them**. The OpenAI `/models` payload is `{ id, object, created, owned_by }` — there is no
 * context window in it, and a hard-coded table of "known" model windows would be wrong the week
 * after it was written while looking authoritative on a page. The spec's rule is "default
 * conservatively and let the user edit", so the fields stay unset and `Model.contextWindow`
 * stays null until someone who knows the answer fills it in.
 *
 * `type` is the one inference made, and it is a **guess stated as a guess**: a model whose id
 * contains `embed` is an embedding model, everything else is `chat`. It is a heuristic over a
 * vendor naming convention, it is marked here so the mapper can say where it came from, and it
 * is overridable with `PATCH /api/models/:id` — which is the point. A model mis-typed as `chat`
 * fails a capability assertion at call time, loudly; a model mis-typed as `embedding` never gets
 * offered, silently. So the guess leans towards the type that fails loudly.
 */
export interface DiscoveredModel {
  /** The exact provider-side id. This is what goes on the wire. */
  externalId: string;
  /** A human label, when the provider offers one. Falls back to `externalId`. */
  displayName?: string;
  type?: 'chat' | 'embedding' | 'image';
}

/**
 * The one interface the engine is allowed to know about.
 *
 * An adapter's job is translation in both directions: provider wire format in, the
 * neutral shapes above out. It must not retry, must not fall back, and must not know
 * about tenants — those are policy, and policy lives in `ModelGateway`.
 */
export interface ProviderAdapter {
  readonly type: ProviderType;
  /** The best structured-output mechanism this provider offers. */
  readonly structuredOutput: StructuredOutputMode;
  readonly supportsEmbeddings: boolean;
  readonly defaultBaseUrl: string;
  chat(request: AdapterChatRequest, ctx: AdapterContext): Promise<AdapterChatResult>;
  stream(request: AdapterChatRequest, ctx: AdapterContext): AsyncGenerator<StreamChunk>;
  embed?(request: AdapterEmbedRequest, ctx: AdapterContext): Promise<EmbedResult>;
  /**
   * The provider's catalogue, for `POST /api/providers/:id/sync`.
   *
   * Optional, and absence is a real answer: a self-hosted runtime with no `/models` endpoint
   * has nothing to sync, and the service reports that rather than pretending an empty list
   * means the provider has no models. An adapter that implements it must throw
   * `ProviderError` on a non-2xx — a catalogue fetch is a request whose caller is an operator
   * waiting for a result, not a verifier judging a status code.
   */
  listModels?(ctx: AdapterContext): Promise<DiscoveredModel[]>;
}
