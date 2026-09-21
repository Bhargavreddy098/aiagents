import {
  ApiError,
  computeCost,
  type ChatMessage,
  type EmbedResult,
  type FinishReason,
  type ModelMetadata,
  type ProviderType,
  type StreamChunk,
  type StructuredOutputMode,
  type StructuredOutputRequest,
  type TokenUsage,
  type ToolCallRequest,
  type ToolDefinition,
} from '@nexs/shared';
import type { Logger } from '../../logger.js';
import type { ModelProvider } from '@prisma/client';
import type { CredentialRepository } from '../../repositories/credential.repo.js';
import type { ModelProviderRepository } from '../../repositories/model-provider.repo.js';
import type { ModelUsageRepository } from '../../repositories/model-usage.repo.js';
import type { ModelRepository, ModelWithProvider } from '../../repositories/model.repo.js';
import type { VaultService } from '../vault/vault.service.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { estimateTokens, fitToContext } from './context-budget.js';
import { createAdapterRegistry } from './adapters/index.js';
import { ProviderError } from './adapters/errors.js';
import type { AdapterContext, DiscoveredModel, FetchLike, ProviderAdapter } from './adapters/types.js';
import { DEFAULT_RETRY_POLICY, nextDelay, type RetryPolicy } from './retry.js';

/**
 * The single door to every model provider.
 *
 * The rule this class exists to enforce: **no other module may import a provider SDK,
 * read a provider API key, or know that "Anthropic" and "OpenAI" differ.** Callers ask
 * for a model and get neutral shapes back. Everything provider-shaped — the wire
 * format, the base URL, the credential, the structured-output mechanism, the retry
 * policy, the fallback chain — is decided here.
 */

/** Used when a model row has no `contextWindow`. Conservative on purpose. */
const DEFAULT_CONTEXT_WINDOW = 32_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 1024;
const MAX_CHAIN_LENGTH = 4;
const MAX_FALLBACK_DEPTH = 3;

export interface GatewayCallContext {
  tenantId: string;
  runId?: string | null;
  stepId?: string | null;
}

export interface GatewayChatRequest extends GatewayCallContext {
  modelId: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxOutputTokens?: number;
  /** Ask for JSON. The gateway chooses how the provider is made to produce it. */
  responseFormat?: StructuredOutputRequest;
  /** Overrides the resolved chain entirely. */
  fallbackModelIds?: string[];
  /**
   * Cancels the provider call.
   *
   * **Only honoured by `stream()`.** A non-streaming `chat()` that is aborted mid-flight has
   * already been billed and would have to either discard a complete answer or return a partial
   * one with no way to say so; refusing quietly is the only correct option, so it is ignored
   * rather than pretended. A stream is different: partial output is a normal outcome there, and
   * the caller has a defined response to it (persist, mark interrupted).
   *
   * This is what makes gap #21 work — the last watcher of a chat run leaving aborts the fetch
   * instead of leaving it to burn tokens into a socket nobody is reading.
   */
  signal?: AbortSignal;
}

export interface GatewayChatResult {
  content: string;
  toolCalls: ToolCallRequest[];
  finishReason: FinishReason;
  usage: TokenUsage;
  /** Which model actually served the request. */
  modelId: string;
  providerId: string;
  /** Every model tried before this one succeeded, in order. */
  attempted: string[];
  costEstimate: number;
  /** True when the budgeting ladder had to drop turns. */
  contextTrimmed: boolean;
}

export interface GatewayStreamRequest extends GatewayChatRequest {
  /** Fires once the first token is emitted, so the caller can record the model used. */
  onModelSelected?: (info: { modelId: string; providerId: string }) => void;
}

export interface GatewayEmbedRequest extends GatewayCallContext {
  modelId: string;
  input: string[];
}

export interface GatewayEmbedResponse extends EmbedResult {
  modelId: string;
  providerId: string;
  costEstimate: number;
}

export interface ModelGatewayDeps {
  models: ModelRepository;
  providers: ModelProviderRepository;
  usage: ModelUsageRepository;
  credentials: CredentialRepository;
  vault: VaultService;
  logger: Logger;
  /** Injected so tests never open a socket. */
  fetch: FetchLike;
  adapters?: Map<ProviderType, ProviderAdapter>;
  breaker?: CircuitBreaker;
  retryPolicy?: RetryPolicy;
  /** Injected so retry tests do not actually wait. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  /** Supplied by the engine (Phase 5) so long prompts can be summarised. */
  summarize?: (messages: ChatMessage[]) => Promise<string>;
}

interface Candidate {
  model: ModelWithProvider;
  provider: ModelWithProvider['provider'];
}

/**
 * Which failures say something about the *provider* rather than about this request.
 * A 400 from a malformed tool schema must not open the circuit for everyone else.
 */
function countsTowardBreaker(kind: ProviderError['kind']): boolean {
  return kind === 'rate_limited' || kind === 'unavailable' || kind === 'auth';
}

/**
 * True for failures we decided ourselves — circuit open, no adapter registered, a
 * credential row that has gone missing.
 *
 * These are configuration or policy faults. They say nothing about whether a provider
 * is healthy, so they must not move the circuit breaker, and when *every* candidate
 * fails this way, "the fallback chain was exhausted" is a misleading thing to report.
 */
function isOwnFault(err: unknown): err is ApiError {
  return err instanceof ApiError;
}

export class ModelGateway {
  private readonly models: ModelRepository;
  private readonly providers: ModelProviderRepository;
  private readonly usage: ModelUsageRepository;
  private readonly credentials: CredentialRepository;
  private readonly vault: VaultService;
  private readonly logger: Logger;
  private readonly fetch: FetchLike;
  private readonly adapters: Map<ProviderType, ProviderAdapter>;
  private readonly breaker: CircuitBreaker;
  private readonly retryPolicy: RetryPolicy;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly summarize: ((messages: ChatMessage[]) => Promise<string>) | undefined;

  constructor(deps: ModelGatewayDeps) {
    this.models = deps.models;
    this.providers = deps.providers;
    this.usage = deps.usage;
    this.credentials = deps.credentials;
    this.vault = deps.vault;
    this.logger = deps.logger;
    this.fetch = deps.fetch;
    this.adapters = deps.adapters ?? createAdapterRegistry();
    this.breaker = deps.breaker ?? new CircuitBreaker({ failureThreshold: 5, openMs: 30_000 });
    this.retryPolicy = deps.retryPolicy ?? DEFAULT_RETRY_POLICY;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
    this.summarize = deps.summarize;
  }

  /** Exposed for the health dashboard and for tests. */
  circuitSnapshot(): ReturnType<CircuitBreaker['snapshot']> {
    return this.breaker.snapshot();
  }

  /**
   * Whether a provider type has an adapter.
   *
   * The registry is private, and this is the one question a caller outside this class legitimately
   * has about it: `POST /api/providers` must refuse a type nothing can route to, because a
   * provider row with no adapter is a row that is permanently and silently dead — it appears in
   * the list, accepts a key, and fails every request with `UNSUPPORTED_CAPABILITY`.
   *
   * Deliberately a predicate rather than a `getAdapter`: handing out adapters would let a caller
   * bypass the gateway, which is the one thing this class exists to prevent.
   */
  canRoute(type: string): boolean {
    return this.adapters.has(type as ProviderType);
  }

  /**
   * The default base URL for a provider type, if the adapter defines one.
   */
  defaultBaseUrlFor(type: string): string | null {
    const adapter = this.adapters.get(type as ProviderType);
    return adapter?.defaultBaseUrl ?? null;
  }

  /**
   * Read a provider's own model catalogue.
   *
   * ## Why this lives on the gateway rather than in the provider service
   *
   * Everything this needs is already here and nowhere else: the provider row, the credential
   * lookup, the vault decryption, the adapter registry and the injected `fetch`. A provider
   * service that reimplemented it would be a second module that knows how to decrypt a key —
   * which is exactly the coupling the vault seam exists to prevent, and exactly the kind of
   * duplication where one path later learns to honour a rotated credential and the other does not.
   *
   * It **does not** touch the circuit breaker, deliberately. Discovery is an operator-initiated
   * read, not traffic; letting a failed sync trip the breaker would make an unreachable catalogue
   * endpoint stop real chat traffic. And it does not retry: the operator is watching a button,
   * so failing fast with the provider's own message is more useful than three silent attempts.
   *
   * `undefined` from the adapter's `listModels` is a real answer, not an error — see the port.
   * It is reported to the caller rather than swallowed, because "this provider type cannot list
   * its models" and "this provider has no models" are different sentences and only one is true.
   */
  async discoverModels(tenantId: string, providerId: string): Promise<DiscoveredModel[]> {
    const provider = await this.providers.findById(tenantId, providerId);
    if (provider === null) {
      throw new ApiError('NOT_FOUND', 'Provider not found', { providerId });
    }

    const adapter = this.adapters.get(provider.type as ProviderType);
    if (adapter === undefined) {
      throw new ApiError(
        'UNSUPPORTED_CAPABILITY',
        `No adapter is registered for provider type "${provider.type}"`,
        { providerType: provider.type },
      );
    }
    if (adapter.listModels === undefined) {
      throw new ApiError(
        'UNSUPPORTED_CAPABILITY',
        `Provider type "${provider.type}" cannot list its models`,
        { providerType: provider.type },
      );
    }

    const context = await this.adapterContext(provider);

    return adapter.listModels(context);
  }

  /**
   * Record a candidate failure against the provider's health, but only when the failure
   * actually reflects provider health.
   */
  private noteFailure(providerKey: string, err: unknown): void {
    if (err instanceof ProviderError) {
      if (countsTowardBreaker(err.kind)) this.breaker.onFailure(providerKey);
      return;
    }
    // Our own decision, or a transport/programming error. Only the latter is a signal.
    if (isOwnFault(err)) return;
    this.breaker.onFailure(providerKey);
  }

  /**
   * The error to throw once every candidate has been tried.
   *
   * When nothing ever reached a provider, the specific fault is more useful than a
   * generic exhaustion error — an operator staring at "every model in the fallback chain
   * failed" has no way to tell a missing adapter from a genuine outage.
   */
  private exhausted(
    failures: readonly unknown[],
    lastError: unknown,
    message: string,
    details: Record<string, unknown>,
  ): ApiError {
    if (failures.length > 0 && failures.every((failure) => isOwnFault(failure))) {
      return lastError as ApiError;
    }
    return new ApiError('GATEWAY_FALLBACK_EXHAUSTED', message, {
      ...details,
      lastError: lastError instanceof Error ? lastError.message : String(lastError),
    });
  }

  /**
   * The exhaustion message, named for what actually happened.
   *
   * `fallbackModelIds: []` — the shape the chat path sends, because a turn must run on exactly
   * the model the user chose — makes the chain one model long. "Every model in the fallback
   * chain failed" then describes a chain that does not exist, and sends the reader looking for
   * fallbacks they deliberately turned off. Naming the single model is accurate, and shorter.
   */
  private exhaustionMessage(chain: readonly Candidate[]): string {
    const names = chain.map((candidate) => candidate.model.name);
    if (names.length === 0) return 'No model was available to run this request';
    if (names.length === 1) return `The model ${names[0]!} failed`;
    return `Every model in the fallback chain failed (tried ${names.length}: ${names.join(', ')})`;
  }

  // ── chat ────────────────────────────────────────────────────────────────────

  async chat(request: GatewayChatRequest): Promise<GatewayChatResult> {
    const chain = await this.resolveChain(request.tenantId, request.modelId, request.fallbackModelIds);
    const attempted: string[] = [];
    const failures: unknown[] = [];
    let lastError: unknown = null;

    for (const candidate of chain) {
      attempted.push(candidate.model.id);
      const providerKey = candidate.model.providerId;

      if (!this.breaker.tryAcquire(providerKey)) {
        this.logger.warn({ providerId: providerKey }, 'circuit open — skipping candidate');
        lastError = new ApiError(
          'MODEL_UNAVAILABLE',
          `Circuit breaker is open for provider ${candidate.model.provider.type}`,
        );
        failures.push(lastError);
        continue;
      }

      try {
        const result = await this.invokeChat(request, candidate);
        this.breaker.onSuccess(providerKey);
        return { ...result, attempted };
      } catch (err) {
        this.noteFailure(providerKey, err);
        lastError = err;
        failures.push(err);
        this.logger.warn(
          { modelId: candidate.model.id, err: err instanceof Error ? err.message : String(err) },
          'model candidate failed, trying next',
        );
      }
    }

    throw this.exhausted(failures, lastError, this.exhaustionMessage(chain), { attempted });
  }

  private async invokeChat(
    request: GatewayChatRequest,
    candidate: Candidate,
  ): Promise<Omit<GatewayChatResult, 'attempted'>> {
    const adapter = this.adapterFor(candidate.provider);
    const ctx = await this.adapterContext(candidate.provider);
    const startedAt = this.now();

    const maxOutputTokens =
      request.maxOutputTokens ?? candidate.model.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;

    const fitted = await fitToContext(request.messages, {
      maxContextTokens: candidate.model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      maxOutputTokens,
      reserveForTools:
        request.tools === undefined ? 0 : estimateTokens(JSON.stringify(request.tools)),
      ...(this.summarize === undefined ? {} : { summarize: this.summarize }),
    });

    const call = await this.withRetry(candidate.model.providerId, () =>
      this.callChat(adapter, candidate, ctx, request, fitted.messages, maxOutputTokens),
    );

    const latencyMs = this.now() - startedAt;
    const costEstimate = await this.recordUsage(request, candidate, call.usage, latencyMs, false);

    return {
      content: call.content,
      toolCalls: call.toolCalls,
      finishReason: call.finishReason,
      usage: call.usage,
      modelId: candidate.model.id,
      providerId: candidate.model.providerId,
      costEstimate,
      contextTrimmed: fitted.droppedCount > 0,
    };
  }

  /**
   * Which structured-output mechanism to use for this model.
   *
   * The adapter's default is a statement about the provider type; `Model.metadata` can
   * override it for a single model, which is the only way to accommodate a fine-tune or
   * proxy that rejects `response_format` without mislabelling every other model on the
   * same provider.
   *
   * An override can only choose a mechanism the adapter can actually implement. Asking
   * for `json_schema` on a provider that has no native decoder is refused here rather
   * than accepted and silently ignored on the wire.
   */
  private structuredOutputFor(candidate: Candidate, adapter: ProviderAdapter): StructuredOutputMode {
    const metadata = candidate.model.metadata as ModelMetadata;
    const requested = metadata.structuredOutputMode;
    if (requested === undefined) return adapter.structuredOutput;

    if (requested === 'json_schema' && adapter.structuredOutput !== 'json_schema') {
      throw new ApiError(
        'UNSUPPORTED_CAPABILITY',
        `Provider ${candidate.model.provider.type} cannot decode a JSON schema natively; use "tool_forcing" or "prompt"`,
        { providerType: candidate.model.provider.type, requested },
      );
    }

    return requested;
  }

  /**
   * Translates "give me JSON matching this schema" into whatever the provider can do.
   *
   * With `json_schema` the request goes out unchanged. With `tool_forcing` a synthetic
   * tool is appended and forced, and its arguments become the content — so the caller
   * cannot tell which mechanism was used, which is the point.
   */
  private async callChat(
    adapter: ProviderAdapter,
    candidate: Candidate,
    ctx: AdapterContext,
    request: GatewayChatRequest,
    messages: ChatMessage[],
    maxOutputTokens: number,
  ): Promise<{ content: string; toolCalls: ToolCallRequest[]; finishReason: FinishReason; usage: TokenUsage }> {
    const base = {
      externalModelId: candidate.model.externalModelId,
      messages,
      ...(request.tools === undefined ? {} : { tools: request.tools }),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      maxOutputTokens,
    };

    if (request.responseFormat === undefined) {
      return adapter.chat(base, ctx);
    }

    // A `prompt`-mode provider gets the schema described in the prompt and the response
    // validated afterwards — there is nothing to configure on the request.
    if (this.structuredOutputFor(candidate, adapter) !== 'tool_forcing') {
      return adapter.chat({ ...base, responseFormat: request.responseFormat }, ctx);
    }

    const shim: ToolDefinition = {
      name: request.responseFormat.name,
      description: 'Return the answer as JSON matching the provided schema.',
      inputSchema: request.responseFormat.schema,
    };

    const result = await adapter.chat(
      {
        ...base,
        tools: [...(request.tools ?? []), shim],
        forceToolName: shim.name,
      },
      ctx,
    );

    const forced = result.toolCalls.find((call) => call.name === shim.name);
    if (forced === undefined) {
      throw new ProviderError(
        'bad_request',
        `Model did not return the forced structured-output tool "${shim.name}"`,
      );
    }

    return {
      content: JSON.stringify(forced.args ?? {}),
      toolCalls: result.toolCalls.filter((call) => call.name !== shim.name),
      finishReason: 'stop',
      usage: result.usage,
    };
  }

  // ── streaming ───────────────────────────────────────────────────────────────

  async *stream(request: GatewayStreamRequest): AsyncGenerator<StreamChunk> {
    const chain = await this.resolveChain(request.tenantId, request.modelId, request.fallbackModelIds);
    const attempted: string[] = [];
    const failures: unknown[] = [];
    let lastError: unknown = null;

    for (const candidate of chain) {
      attempted.push(candidate.model.id);
      const providerKey = candidate.model.providerId;

      if (!this.breaker.tryAcquire(providerKey)) {
        lastError = new ApiError(
          'MODEL_UNAVAILABLE',
          `Circuit breaker is open for provider ${candidate.model.provider.type}`,
        );
        failures.push(lastError);
        continue;
      }

      let emitted = false;
      let announced = false;

      try {
        for await (const chunk of this.streamOnce(request, candidate)) {
          if (!announced && (chunk.type === 'text' || chunk.type === 'tool_call')) {
            announced = true;
            request.onModelSelected?.({ modelId: candidate.model.id, providerId: candidate.model.providerId });
          }
          if (chunk.type === 'text' || chunk.type === 'tool_call') emitted = true;
          yield chunk;
        }
        this.breaker.onSuccess(providerKey);
        return;
      } catch (err) {
        this.noteFailure(providerKey, err);
        lastError = err;
        failures.push(err);

        if (emitted) {
          // Content has already reached the client. Falling back now would splice a
          // second model's output onto the first one's and present the join as a single
          // coherent answer — a transcript that never happened. Fail loudly instead; the
          // caller persists the partial and marks the message interrupted.
          throw new ApiError(
            'PROVIDER_ERROR',
            'Stream failed after content was already emitted; refusing to fall back mid-answer',
            { modelId: candidate.model.id, cause: err instanceof Error ? err.message : String(err) },
          );
        }

        this.logger.warn(
          { modelId: candidate.model.id },
          'stream failed before any content — trying next candidate',
        );
      }
    }

    throw this.exhausted(failures, lastError, this.exhaustionMessage(chain), { attempted });
  }

  private async *streamOnce(
    request: GatewayStreamRequest,
    candidate: Candidate,
  ): AsyncGenerator<StreamChunk> {
    const adapter = this.adapterFor(candidate.provider);

    // Tool-forcing cannot be applied to a stream: it needs the model to emit a tool call
    // and then we would have to withhold the arguments until the end, which is not a
    // stream. Returning unconstrained text while the caller believes it asked for a
    // schema is worse than refusing, so refuse.
    if (
      request.responseFormat !== undefined &&
      this.structuredOutputFor(candidate, adapter) !== 'json_schema'
    ) {
      throw new ApiError(
        'UNSUPPORTED_CAPABILITY',
        `Streaming structured output is not supported by provider ${candidate.model.provider.type}; use chat() instead`,
        { providerType: candidate.model.provider.type },
      );
    }

    const ctx = await this.adapterContext(candidate.provider, request.signal);
    const startedAt = this.now();

    const maxOutputTokens =
      request.maxOutputTokens ?? candidate.model.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;

    const fitted = await fitToContext(request.messages, {
      maxContextTokens: candidate.model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      maxOutputTokens,
      reserveForTools:
        request.tools === undefined ? 0 : estimateTokens(JSON.stringify(request.tools)),
      ...(this.summarize === undefined ? {} : { summarize: this.summarize }),
    });

    let usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    for await (const chunk of adapter.stream(
      {
        externalModelId: candidate.model.externalModelId,
        messages: fitted.messages,
        ...(request.tools === undefined ? {} : { tools: request.tools }),
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        ...(request.responseFormat === undefined
          ? {}
          : { responseFormat: request.responseFormat }),
        maxOutputTokens,
      },
      ctx,
    )) {
      if (chunk.type === 'usage') {
        usage = chunk.usage;
        continue; // internal bookkeeping, not something the client renders
      }
      if (chunk.type === 'done') {
        await this.recordUsage(request, candidate, usage, this.now() - startedAt, false);
      }
      yield chunk;
    }
  }

  // ── embeddings ──────────────────────────────────────────────────────────────

  async embed(request: GatewayEmbedRequest): Promise<GatewayEmbedResponse> {
    const chain = await this.resolveChain(request.tenantId, request.modelId);
    const attempted: string[] = [];
    const failures: unknown[] = [];
    let lastError: unknown = null;

    for (const candidate of chain) {
      attempted.push(candidate.model.id);
      const adapter = this.adapters.get(candidate.model.provider.type as ProviderType);
      if (adapter === undefined || !adapter.supportsEmbeddings || adapter.embed === undefined) {
        lastError = new ApiError(
          'UNSUPPORTED_CAPABILITY',
          `Provider ${candidate.model.provider.type} does not support embeddings`,
        );
        failures.push(lastError);
        continue;
      }

      const providerKey = candidate.model.providerId;
      if (!this.breaker.tryAcquire(providerKey)) {
        lastError = new ApiError('MODEL_UNAVAILABLE', 'Circuit breaker is open');
        failures.push(lastError);
        continue;
      }

      const startedAt = this.now();
      try {
        const ctx = await this.adapterContext(candidate.provider);
        const result = await this.withRetry(providerKey, () =>
          adapter.embed!(
            { externalModelId: candidate.model.externalModelId, input: request.input },
            ctx,
          ),
        );
        this.breaker.onSuccess(providerKey);

        const costEstimate = await this.recordUsage(
          request,
          candidate,
          result.usage,
          this.now() - startedAt,
          false,
        );

        return {
          vectors: result.vectors,
          usage: result.usage,
          modelId: candidate.model.id,
          providerId: candidate.model.providerId,
          costEstimate,
        };
      } catch (err) {
        this.noteFailure(providerKey, err);
        lastError = err;
        failures.push(err);
      }
    }

    throw this.exhausted(failures, lastError, 'No embedding model succeeded', { attempted });
  }

  // ── internals ───────────────────────────────────────────────────────────────

  /**
   * Which adapter serves a provider.
   *
   * Takes the provider rather than the `Candidate` it used to, because discovery needs an adapter
   * for a provider that has no model row yet — which is the entire point of a sync. The narrower
   * parameter is what let `discoverModels` stop fabricating a `ModelWithProvider` to satisfy a
   * type it never used.
   */
  private adapterFor(provider: ModelProvider): ProviderAdapter {
    const adapter = this.adapters.get(provider.type as ProviderType);
    if (adapter === undefined) {
      throw new ApiError(
        'UNSUPPORTED_CAPABILITY',
        `No adapter is registered for provider type "${provider.type}"`,
        { providerType: provider.type },
      );
    }
    return adapter;
  }

  /**
   * Resolve the credential at call time, not at startup — a rotated key takes effect on
   * the next request without a restart. The plaintext never leaves this method.
   */
  private async adapterContext(provider: ModelProvider, signal?: AbortSignal): Promise<AdapterContext> {
    let apiKey: string | null = null;
    if (provider.apiKeyRef !== null && provider.apiKeyRef.length > 0) {
      const credential = await this.credentials.findById(provider.tenantId, provider.apiKeyRef);
      if (credential === null) {
        throw new ApiError('ENCRYPTION_ERROR', 'Provider references a credential that no longer exists');
      }
      apiKey = this.vault.decrypt(credential.encrypted);
    }

    const extraHeaders: Record<string, string> = {};
    if (provider.type === 'openrouter') {
      // OpenRouter attributes traffic with these; without them the app shows as unknown.
      extraHeaders['http-referer'] = 'https://nexs.local';
      extraHeaders['x-title'] = 'NEXS';
    }

    return {
      baseUrl: provider.baseUrl ?? this.adapterFor(provider).defaultBaseUrl,
      apiKey,
      organizationId: provider.organizationId,
      projectId: provider.projectId,
      extraHeaders,
      fetch: this.fetch,
      // Only `stream()` passes one; `chat()` omits it so the adapters issue an uncancellable
      // request rather than one that is cancelled without anything able to react to it.
      ...(signal === undefined ? {} : { signal }),
    };
  }

  private async withRetry<T>(providerKey: string, operation: () => Promise<T>): Promise<T> {
    let attempt = 0;
    let waitedMs = 0;

    for (;;) {
      attempt += 1;
      try {
        return await operation();
      } catch (err) {
        if (!(err instanceof ProviderError) || !err.retryable) throw err;

        const delay = nextDelay(
          this.retryPolicy,
          { attempt, retryAfterMs: err.retryAfterMs, waitedMs },
          this.random,
        );
        if (delay === null) throw err;

        this.logger.warn(
          { providerId: providerKey, attempt, delayMs: delay, kind: err.kind },
          'retrying provider call',
        );
        await this.sleep(delay);
        waitedMs += delay;
      }
    }
  }

  private async recordUsage(
    request: GatewayCallContext,
    candidate: Candidate,
    usage: TokenUsage,
    latencyMs: number,
    cached: boolean,
  ): Promise<number> {
    const metadata = candidate.model.metadata as ModelMetadata;
    const costEstimate = computeCost(metadata.pricing, usage);

    await this.usage.record({
      tenantId: request.tenantId,
      modelId: candidate.model.id,
      providerId: candidate.model.providerId,
      runId: request.runId ?? null,
      stepId: request.stepId ?? null,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      latencyMs,
      costEstimate,
      cached,
    });

    return costEstimate;
  }

  /**
   * Build the candidate list: primary, then tenant-level route override, then the
   * `Model.fallbackOf` chain, breadth-first and deduplicated.
   */
  private async resolveChain(
    tenantId: string,
    modelId: string,
    explicit?: string[],
  ): Promise<Candidate[]> {
    const primary = await this.models.findById(tenantId, modelId);
    if (primary === null) {
      throw new ApiError('MODEL_UNAVAILABLE', 'Model not found', { modelId });
    }

    const chain: Candidate[] = [];
    const seen = new Set<string>();

    const push = (model: ModelWithProvider | null): void => {
      if (model === null || seen.has(model.id) || chain.length >= MAX_CHAIN_LENGTH) return;
      if (!model.enabled || model.status !== 'available') return;
      if (!model.provider.enabled) return;
      seen.add(model.id);
      chain.push({ model, provider: model.provider });
    };

    push(primary);

    if (explicit !== undefined) {
      for (const id of explicit) push(await this.models.findById(tenantId, id));
      return this.requireUsable(chain, modelId);
    }

    // Tenant-level routing policy wins over the model's own default chain.
    const route = await this.models.findRoute(tenantId, primary.id);
    if (route?.fallbackModelId != null && route.fallbackModelId.length > 0) {
      push(await this.models.findById(tenantId, route.fallbackModelId));
    }

    let cursor = primary.id;
    for (let depth = 0; depth < MAX_FALLBACK_DEPTH; depth += 1) {
      const next = await this.models.findFallbacks(tenantId, cursor);
      if (next.length === 0) break;
      for (const model of next) push(model);
      cursor = next[0]!.id;
    }

    return this.requireUsable(chain, modelId);
  }

  /**
   * A model row that exists but is switched off — or whose provider is — yields an empty
   * candidate list. Reporting "the fallback chain was exhausted" would send an operator
   * hunting for an outage that is not there.
   */
  private requireUsable(chain: Candidate[], modelId: string): Candidate[] {
    if (chain.length === 0) {
      throw new ApiError(
        'MODEL_UNAVAILABLE',
        'The requested model is disabled, or its provider is disabled',
        { modelId },
      );
    }
    return chain;
  }
}
