import type {
  ChatMessage,
  EmbedResult,
  FinishReason,
  ProviderType,
  StreamChunk,
  StructuredOutputMode,
  TokenUsage,
  ToolCallRequest,
} from '@nexs/shared';
import { extractErrorMessage, ProviderError, classifyStatus } from './errors.js';
import { guessModelType, readModelId, readModelLabel, unwrapCatalogue } from './discovery.js';
import { parseRetryAfter } from '../retry.js';
import { iterateSseData } from './sse.js';
import type {
  AdapterChatRequest,
  AdapterChatResult,
  AdapterContext,
  DiscoveredModel,
  ProviderAdapter,
} from './types.js';

/**
 * One adapter for the whole OpenAI wire format, which most providers now speak:
 * OpenAI itself, Azure, Groq, Mistral, DeepSeek, xAI, Together, OpenRouter, local
 * runtimes and Ollama's compatibility endpoint.
 *
 * They differ in exactly two ways that matter here, and both are constructor options
 * rather than subclasses:
 *   - which structured-output mechanism actually works (`json_schema` vs `tool_forcing`)
 *   - whether `stream_options.include_usage` is accepted (some strict providers 400 on
 *     unknown body fields, so we only send it where it is documented)
 */

function parseJsonArgs(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw ?? {};
  const trimmed = raw.trim();
  if (trimmed.length === 0) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    // Models do occasionally emit malformed JSON for tool arguments. Returning the raw
    // text (rather than `{}`) keeps the failure debuggable and lets the plan validator
    // reject it with the actual content in hand. Failing the whole call here would be
    // harsher than the situation warrants.
    return { __unparsed: trimmed };
  }
}

function toWireMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    return {
      role: 'tool',
      content: message.content,
      tool_call_id: message.toolCallId ?? 'unknown',
    };
  }

  const out: Record<string, unknown> = { role: message.role, content: message.content };

  if (message.role === 'assistant' && message.toolCalls !== undefined && message.toolCalls.length > 0) {
    out['tool_calls'] = message.toolCalls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
    }));
  }

  return out;
}

function parseToolCall(raw: unknown): ToolCallRequest | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;

  const fn = record['function'];
  if (typeof fn !== 'object' || fn === null) return null;
  const fnRecord = fn as Record<string, unknown>;

  const name = fnRecord['name'];
  if (typeof name !== 'string' || name.length === 0) return null;

  return {
    id: typeof record['id'] === 'string' && record['id'].length > 0 ? record['id'] : `call_${name}`,
    name,
    args: parseJsonArgs(fnRecord['arguments']),
  };
}

function parseFinishReason(raw: unknown): FinishReason {
  switch (raw) {
    case 'length':
      return 'length';
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case 'content_filter':
      return 'content_filter';
    case 'stop':
      return 'stop';
    default:
      return 'stop';
  }
}

function parseUsage(raw: unknown): TokenUsage {
  const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const prompt = typeof record['prompt_tokens'] === 'number' ? record['prompt_tokens'] : 0;
  const completion = typeof record['completion_tokens'] === 'number' ? record['completion_tokens'] : 0;
  const total = typeof record['total_tokens'] === 'number' ? record['total_tokens'] : prompt + completion;
  return { promptTokens: prompt, completionTokens: completion, totalTokens: total };
}

export interface OpenAIAdapterOptions {
  type: ProviderType;
  defaultBaseUrl: string;
  structuredOutput?: StructuredOutputMode;
  /** Send `stream_options: { include_usage: true }`. */
  streamUsage?: boolean;
  supportsEmbeddings?: boolean;
  /** Azure requires the deployment name in the path and an `api-key` header. */
  azure?: boolean;
}

export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly type: ProviderType;
  readonly defaultBaseUrl: string;
  readonly structuredOutput: StructuredOutputMode;
  readonly supportsEmbeddings: boolean;

  private readonly streamUsage: boolean;
  private readonly azure: boolean;

  constructor(options: OpenAIAdapterOptions) {
    this.type = options.type;
    this.defaultBaseUrl = options.defaultBaseUrl;
    // Only OpenAI documents native `json_schema` decoding. The rest of the
    // OpenAI-compatible ecosystem supports function calling far more reliably, so the
    // gateway is told to reach for `tool_forcing` instead of pretending otherwise.
    this.structuredOutput =
      options.structuredOutput ?? (options.type === 'openai' ? 'json_schema' : 'tool_forcing');
    this.supportsEmbeddings = options.supportsEmbeddings ?? true;
    this.streamUsage = options.streamUsage ?? options.type === 'openai';
    this.azure = options.azure ?? false;
  }

  private headers(ctx: AdapterContext): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(ctx.extraHeaders ?? {}),
    };

    if (this.azure) {
      if (ctx.apiKey !== null) headers['api-key'] = ctx.apiKey;
    } else if (ctx.apiKey !== null) {
      headers['authorization'] = `Bearer ${ctx.apiKey}`;
    }

    if (ctx.organizationId !== null && ctx.organizationId !== undefined) {
      headers['openai-organization'] = ctx.organizationId;
    }
    if (ctx.projectId !== null && ctx.projectId !== undefined) {
      headers['openai-project'] = ctx.projectId;
    }

    return headers;
  }

  private body(request: AdapterChatRequest, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.externalModelId,
      messages: request.messages.map(toWireMessage),
    };

    if (request.temperature !== undefined) body['temperature'] = request.temperature;
    if (request.maxOutputTokens !== undefined) body['max_tokens'] = request.maxOutputTokens;

    if (request.tools !== undefined && request.tools.length > 0) {
      body['tools'] = request.tools.map((tool) => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
      }));

      body['tool_choice'] =
        request.forceToolName === undefined
          ? 'auto'
          : { type: 'function', function: { name: request.forceToolName } };
    }

    if (request.responseFormat !== undefined && this.structuredOutput === 'json_schema') {
      body['response_format'] = {
        type: 'json_schema',
        json_schema: {
          name: request.responseFormat.name,
          schema: request.responseFormat.schema,
          strict: request.responseFormat.strict ?? true,
        },
      };
    }

    if (stream) {
      body['stream'] = true;
      if (this.streamUsage) body['stream_options'] = { include_usage: true };
    }

    return body;
  }

  /**
   * The one place this adapter talks to the network.
   *
   * `post` and `get` are thin wrappers over it so the transport-error and non-2xx handling exist
   * once. A second copy for `GET` would be the kind of duplication where one path learns a fix
   * (a new retry header, a new status classification) and the other does not.
   */
  private async send(
    path: string,
    ctx: AdapterContext,
    init: { method: 'GET' | 'POST'; body?: string },
  ): Promise<Response> {
    const url = `${ctx.baseUrl.replace(/\/+$/, '')}${path}`;

    let response: Response;
    try {
      response = await ctx.fetch(url, {
        method: init.method,
        headers: this.headers(ctx),
        ...(init.body === undefined ? {} : { body: init.body }),
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      });
    } catch (cause) {
      // A transport failure (DNS, refused connection, aborted) is retryable in the same
      // way a 503 is — the gateway should not have to know the difference.
      throw new ProviderError('unavailable', `Could not reach ${this.type}: ${String(cause)}`, {
        cause,
      });
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const status = response.status;
      throw new ProviderError(
        classifyStatus(status, text),
        `${this.type} returned ${status}: ${extractErrorMessage(text, response.statusText)}`,
        {
          status,
          retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
        },
      );
    }

    return response;
  }

  private post(
    path: string,
    payload: Record<string, unknown>,
    ctx: AdapterContext,
  ): Promise<Response> {
    return this.send(path, ctx, { method: 'POST', body: JSON.stringify(payload) });
  }

  private get(path: string, ctx: AdapterContext): Promise<Response> {
    return this.send(path, ctx, { method: 'GET' });
  }

  /**
   * The provider's catalogue.
   *
   * The documented OpenAI payload is `{ data: [{ id, object, created, owned_by }] }`, but this
   * adapter covers the whole compatible ecosystem, where a bare array and `{ models: [...] }`
   * both occur — see `unwrapCatalogue`. Only the id is trustworthy across all of them, so that
   * is all that is read; a display label is taken when one exists and the type is guessed from
   * the id (see `guessModelType` for why the guess leans towards `chat`).
   */
  async listModels(ctx: AdapterContext): Promise<DiscoveredModel[]> {
    const response = await this.get('/models', ctx);
    const payload: unknown = await response.json();

    const discovered: DiscoveredModel[] = [];
    for (const entry of unwrapCatalogue(payload)) {
      const externalId = readModelId(entry);
      if (externalId === null) continue;

      const model: DiscoveredModel = { externalId, type: guessModelType(externalId) };
      const label = readModelLabel(entry);
      if (label !== undefined) model.displayName = label;
      discovered.push(model);
    }

    return discovered;
  }

  async chat(request: AdapterChatRequest, ctx: AdapterContext): Promise<AdapterChatResult> {
    const response = await this.post('/chat/completions', this.body(request, false), ctx);
    const payload: unknown = await response.json();
    const root = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};

    const choices = root['choices'];
    const first = Array.isArray(choices) ? (choices[0] as Record<string, unknown> | undefined) : undefined;
    const message =
      first !== undefined && typeof first['message'] === 'object' && first['message'] !== null
        ? (first['message'] as Record<string, unknown>)
        : {};

    const rawCalls = Array.isArray(message['tool_calls']) ? message['tool_calls'] : [];
    const toolCalls = rawCalls
      .map(parseToolCall)
      .filter((call): call is ToolCallRequest => call !== null);

    return {
      content: typeof message['content'] === 'string' ? message['content'] : '',
      toolCalls,
      finishReason: parseFinishReason(first?.['finish_reason']),
      usage: parseUsage(root['usage']),
    };
  }

  async *stream(request: AdapterChatRequest, ctx: AdapterContext): AsyncGenerator<StreamChunk> {
    const response = await this.post('/chat/completions', this.body(request, true), ctx);

    let finishReason: FinishReason = 'stop';
    let usage: TokenUsage | null = null;
    // A well-formed stream always carries a `finish_reason` on its final delta. Its
    // absence means the connection was cut, and a silently truncated answer presented as
    // a complete one is the failure this whole layer exists to avoid.
    let sawFinishReason = false;
    // Tool calls arrive fragmented: the first delta carries the id and name, later ones
    // carry argument fragments, keyed by an index. They are accumulated here and only
    // emitted once the stream ends, so the consumer never sees a half-built call.
    const partials = new Map<number, { id: string; name: string; args: string }>();

    for await (const data of iterateSseData(response.body)) {
      if (data === '[DONE]') break;
      if (data.length === 0) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue; // A malformed frame should not kill an otherwise healthy stream.
      }

      const root = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
      if (root['usage'] !== undefined && root['usage'] !== null) usage = parseUsage(root['usage']);

      const choices = root['choices'];
      const first = Array.isArray(choices) ? (choices[0] as Record<string, unknown> | undefined) : undefined;
      if (first === undefined) continue;

      if (first['finish_reason'] !== undefined && first['finish_reason'] !== null) {
        finishReason = parseFinishReason(first['finish_reason']);
        sawFinishReason = true;
      }

      const delta =
        typeof first['delta'] === 'object' && first['delta'] !== null
          ? (first['delta'] as Record<string, unknown>)
          : {};

      const text = delta['content'];
      if (typeof text === 'string' && text.length > 0) yield { type: 'text', text };

      const rawCalls = Array.isArray(delta['tool_calls']) ? delta['tool_calls'] : [];
      for (const raw of rawCalls) {
        if (typeof raw !== 'object' || raw === null) continue;
        const call = raw as Record<string, unknown>;
        const index = typeof call['index'] === 'number' ? call['index'] : 0;

        const entry = partials.get(index) ?? { id: '', name: '', args: '' };
        if (typeof call['id'] === 'string' && call['id'].length > 0) entry.id = call['id'];

        const fn = call['function'];
        if (typeof fn === 'object' && fn !== null) {
          const fnRecord = fn as Record<string, unknown>;
          if (typeof fnRecord['name'] === 'string') entry.name += fnRecord['name'];
          if (typeof fnRecord['arguments'] === 'string') entry.args += fnRecord['arguments'];
        }

        partials.set(index, entry);
      }
    }

    // The stream closed without ever reporting why it stopped, so this is a truncated
    // answer. Reporting it as a clean `stop` would hand the caller half a sentence and
    // let it be persisted and displayed as the model's complete reply.
    if (!sawFinishReason) {
      throw new ProviderError(
        'unavailable',
        'Stream ended without a finish_reason — the connection was truncated',
      );
    }

    for (const [index, partial] of [...partials.entries()].sort((a, b) => a[0] - b[0])) {
      if (partial.name.length === 0) continue;
      yield {
        type: 'tool_call',
        toolCall: {
          id: partial.id.length > 0 ? partial.id : `call_${index}`,
          name: partial.name,
          args: parseJsonArgs(partial.args),
        },
      };
    }

    if (usage !== null) yield { type: 'usage', usage };
    yield { type: 'done', finishReason: finishReason === 'stop' && partials.size > 0 ? 'tool_calls' : finishReason };
  }

  async embed(
    request: { externalModelId: string; input: string[] },
    ctx: AdapterContext,
  ): Promise<EmbedResult> {
    const response = await this.post(
      '/embeddings',
      { model: request.externalModelId, input: request.input },
      ctx,
    );

    const payload: unknown = await response.json();
    const root = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
    const data = Array.isArray(root['data']) ? root['data'] : [];

    const vectors = data
      .map((item) => (typeof item === 'object' && item !== null ? (item as Record<string, unknown>)['embedding'] : undefined))
      .filter((vector): vector is number[] => Array.isArray(vector));

    if (vectors.length !== request.input.length) {
      throw new ProviderError(
        'bad_request',
        `Embedding response had ${vectors.length} vectors for ${request.input.length} inputs`,
      );
    }

    return { vectors, usage: parseUsage(root['usage']) };
  }
}
