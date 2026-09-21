import type {
  ChatMessage,
  FinishReason,
  ProviderType,
  StreamChunk,
  StructuredOutputMode,
  TokenUsage,
  ToolCallRequest,
} from '@nexs/shared';
import { classifyStatus, extractErrorMessage, ProviderError } from './errors.js';
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
 * Google Gemini API adapter.
 *
 * The Gemini wire format differs from OpenAI in every structural detail:
 *   - Messages are `contents` with `role` and `parts` (not `messages` with `content` strings).
 *   - System instructions live in a top-level `system_instruction` field.
 *   - Tools are `functionDeclarations` inside a `tools` array.
 *   - Tool results are sent as `role: 'user'` with a `functionResponse` part.
 *   - The model returns `functionCall` parts rather than `tool_calls`.
 *   - Generation config is a separate top-level object.
 *   - Streaming uses `streamGenerateContent?alt=sse` instead of `stream: true`.
 *   - The list-models endpoint returns `{ models: [...] }` with `name` prefixed by `models/`.
 *
 * These are not superficial naming differences — the structure is different enough that
 * pretending Gemini is OpenAI-compatible would produce confusing 400s at runtime.
 */

// ─── Wire helpers ────────────────────────────────────────────────────────────

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: unknown };
  functionResponse?: { name: string; response: unknown };
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

function toGeminiContents(messages: readonly ChatMessage[]): {
  systemInstruction: GeminiContent | undefined;
  contents: GeminiContent[];
} {
  const systemParts: string[] = [];
  const contents: GeminiContent[] = [];

  const push = (role: 'user' | 'model', parts: GeminiPart[]): void => {
    const last = contents[contents.length - 1];
    // Gemini requires alternating roles — merge consecutive same-role turns.
    if (last !== undefined && last.role === role) {
      last.parts.push(...parts);
      return;
    }
    contents.push({ role, parts: [...parts] });
  };

  for (const message of messages) {
    switch (message.role) {
      case 'system':
        systemParts.push(message.content);
        break;

      case 'tool':
        // Tool results are sent as user messages with functionResponse parts.
        push('user', [
          {
            functionResponse: {
              name: message.name ?? 'unknown',
              response: safeParseJson(message.content),
            },
          },
        ]);
        break;

      case 'assistant': {
        const parts: GeminiPart[] = [];
        if (message.content.length > 0) parts.push({ text: message.content });
        for (const call of message.toolCalls ?? []) {
          // No parsing here, unlike `openai.ts`. OpenAI delivers a tool call's arguments as a
          // JSON *string* (`function.arguments`) and has to `JSON.parse` it; Gemini delivers a
          // `functionCall.args` **Struct**, which is already an object. A copy of OpenAI's
          // `parseJsonArgs` used to sit in this file, unused, because there is nothing for it to
          // do — this is the reason, kept so it is not copied back.
          parts.push({ functionCall: { name: call.name, args: call.args ?? {} } });
        }
        if (parts.length === 0) parts.push({ text: '' });
        push('model', parts);
        break;
      }

      default:
        push('user', [{ text: message.content }]);
        break;
    }
  }

  const systemInstruction: GeminiContent | undefined =
    systemParts.length > 0
      ? { role: 'user', parts: [{ text: systemParts.join('\n\n') }] }
      : undefined;

  return { systemInstruction, contents };
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { result: text };
  }
}

function parseFinishReason(raw: unknown): FinishReason {
  switch (raw) {
    case 'MAX_TOKENS':
      return 'length';
    case 'STOP':
      return 'stop';
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
      return 'content_filter';
    default:
      return 'stop';
  }
}

function parseUsage(raw: unknown): TokenUsage {
  const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const prompt = typeof record['promptTokenCount'] === 'number' ? record['promptTokenCount'] : 0;
  const completion =
    typeof record['candidatesTokenCount'] === 'number' ? record['candidatesTokenCount'] : 0;
  const total =
    typeof record['totalTokenCount'] === 'number' ? record['totalTokenCount'] : prompt + completion;
  return { promptTokens: prompt, completionTokens: completion, totalTokens: total };
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

export class GoogleAdapter implements ProviderAdapter {
  readonly type: ProviderType = 'google';
  readonly defaultBaseUrl = 'https://generativelanguage.googleapis.com/v1beta';
  readonly structuredOutput: StructuredOutputMode = 'tool_forcing';
  readonly supportsEmbeddings = true;

  /**
   * Gemini authenticates via `x-goog-api-key` header rather than Bearer tokens.
   */
  private headers(ctx: AdapterContext): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(ctx.extraHeaders ?? {}),
    };
    if (ctx.apiKey !== null) headers['x-goog-api-key'] = ctx.apiKey;
    return headers;
  }

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
      throw new ProviderError('unavailable', `Could not reach google: ${String(cause)}`, {
        cause,
      });
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const status = response.status;
      throw new ProviderError(
        classifyStatus(status, text),
        `google returned ${status}: ${extractErrorMessage(text, response.statusText)}`,
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

  private body(request: AdapterChatRequest, stream: boolean): Record<string, unknown> {
    const { systemInstruction, contents } = toGeminiContents(request.messages);

    const body: Record<string, unknown> = { contents };

    if (systemInstruction !== undefined) {
      body['system_instruction'] = systemInstruction;
    }

    // Generation config
    const generationConfig: Record<string, unknown> = {};
    if (request.temperature !== undefined) generationConfig['temperature'] = request.temperature;
    if (request.maxOutputTokens !== undefined)
      generationConfig['maxOutputTokens'] = request.maxOutputTokens;

    if (Object.keys(generationConfig).length > 0) {
      body['generationConfig'] = generationConfig;
    }

    // Tools (function declarations)
    if (request.tools !== undefined && request.tools.length > 0) {
      body['tools'] = [
        {
          function_declarations: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          })),
        },
      ];

      if (request.forceToolName !== undefined) {
        body['tool_config'] = {
          function_calling_config: {
            mode: 'ANY',
            allowed_function_names: [request.forceToolName],
          },
        };
      }
    }

    void stream; // Gemini uses a different endpoint for streaming, not a body flag
    return body;
  }

  /**
   * Extract the model id from Gemini's `models/gemini-xxx` name format.
   * The wire calls use just the model name without the `models/` prefix in some
   * cases, but `generateContent` uses the full path. We normalise here so the
   * caller can use either.
   */
  private modelPath(externalModelId: string): string {
    if (externalModelId.startsWith('models/')) return externalModelId;
    return `models/${externalModelId}`;
  }

  // ─── List Models ─────────────────────────────────────────────────────────

  async listModels(ctx: AdapterContext): Promise<DiscoveredModel[]> {
    const response = await this.get('/models?pageSize=1000', ctx);
    const payload: unknown = await response.json();
    const root = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
    const models = Array.isArray(root['models']) ? root['models'] : [];

    const discovered: DiscoveredModel[] = [];
    for (const entry of models) {
      if (typeof entry !== 'object' || entry === null) continue;
      const record = entry as Record<string, unknown>;

      // `name` is `models/gemini-2.0-flash` — strip the prefix for the external id.
      const name = typeof record['name'] === 'string' ? record['name'] : null;
      if (name === null) continue;
      const externalId = name.startsWith('models/') ? name.slice('models/'.length) : name;

      // Filter to models that support generateContent (chat) or embedContent (embedding).
      const methods = Array.isArray(record['supportedGenerationMethods'])
        ? (record['supportedGenerationMethods'] as string[])
        : [];

      // Must support either text generation or embeddings
      if (!methods.includes('generateContent') && !methods.includes('embedContent')) {
        continue;
      }

      // Exclude specialized modalities, WebSocket-only, or deprecated models
      if (
        externalId.includes('-tts') ||
        externalId.includes('-live') ||
        externalId.startsWith('deep-research') ||
        externalId.startsWith('antigravity-preview') ||
        externalId.startsWith('lyria') ||
        externalId.startsWith('veo-') ||
        externalId.includes('transcribe') ||
        externalId === 'gemini-2.5-flash' ||
        externalId === 'gemini-2.5-pro' ||
        externalId === 'gemini-2.5-flash-lite' ||
        externalId.startsWith('gemini-2.5-computer-use')
      ) {
        continue;
      }

      const model: DiscoveredModel = {
        externalId,
        // Gemini states the type rather than leaving it to be inferred: `supportedGenerationMethods`
        // is on the catalogue row, so a model that can embed says so. This is strictly better than
        // `guessModelType`, which the OpenAI and Anthropic adapters need because their catalogues
        // carry no such field — which is why this adapter does not import it.
        type: methods.includes('embedContent') ? 'embedding' : 'chat',
      };

      const displayName = typeof record['displayName'] === 'string' ? record['displayName'] : undefined;
      if (displayName !== undefined) model.displayName = displayName;

      discovered.push(model);
    }

    return discovered;
  }

  // ─── Chat (non-streaming) ────────────────────────────────────────────────

  async chat(request: AdapterChatRequest, ctx: AdapterContext): Promise<AdapterChatResult> {
    const modelPath = this.modelPath(request.externalModelId);
    const response = await this.post(
      `/${modelPath}:generateContent`,
      this.body(request, false),
      ctx,
    );
    const payload: unknown = await response.json();
    return this.parseResponse(payload);
  }

  private parseResponse(payload: unknown): AdapterChatResult {
    const root = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
    const candidates = Array.isArray(root['candidates']) ? root['candidates'] : [];
    const first = candidates.length > 0 && typeof candidates[0] === 'object' && candidates[0] !== null
      ? (candidates[0] as Record<string, unknown>)
      : {};

    const content = first['content'];
    const parts = typeof content === 'object' && content !== null
      ? (Array.isArray((content as Record<string, unknown>)['parts'])
        ? ((content as Record<string, unknown>)['parts'] as unknown[])
        : [])
      : [];

    let text = '';
    const toolCalls: ToolCallRequest[] = [];
    let callIndex = 0;

    for (const part of parts) {
      if (typeof part !== 'object' || part === null) continue;
      const record = part as Record<string, unknown>;

      if (typeof record['text'] === 'string') {
        text += record['text'];
      }

      const fc = record['functionCall'];
      if (typeof fc === 'object' && fc !== null) {
        const call = fc as Record<string, unknown>;
        const name = typeof call['name'] === 'string' ? call['name'] : '';
        if (name.length > 0) {
          toolCalls.push({
            id: `call_${callIndex++}`,
            name,
            args: call['args'] ?? {},
          });
        }
      }
    }

    return {
      content: text,
      toolCalls,
      finishReason: parseFinishReason(first['finishReason']),
      usage: parseUsage(root['usageMetadata']),
    };
  }

  // ─── Streaming ───────────────────────────────────────────────────────────

  async *stream(request: AdapterChatRequest, ctx: AdapterContext): AsyncGenerator<StreamChunk> {
    const modelPath = this.modelPath(request.externalModelId);
    const response = await this.post(
      `/${modelPath}:streamGenerateContent?alt=sse`,
      this.body(request, true),
      ctx,
    );

    let finishReason: FinishReason = 'stop';
    let usage: TokenUsage | null = null;
    let sawCandidate = false;

    for await (const data of iterateSseData(response.body)) {
      if (data.length === 0) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }

      const root = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};

      // Usage metadata
      if (root['usageMetadata'] !== undefined && root['usageMetadata'] !== null) {
        usage = parseUsage(root['usageMetadata']);
      }

      const candidates = Array.isArray(root['candidates']) ? root['candidates'] : [];
      const first =
        candidates.length > 0 && typeof candidates[0] === 'object' && candidates[0] !== null
          ? (candidates[0] as Record<string, unknown>)
          : null;

      if (first === null) continue;
      sawCandidate = true;

      if (first['finishReason'] !== undefined && first['finishReason'] !== null) {
        finishReason = parseFinishReason(first['finishReason']);
      }

      const content = first['content'];
      const parts =
        typeof content === 'object' && content !== null
          ? (Array.isArray((content as Record<string, unknown>)['parts'])
            ? ((content as Record<string, unknown>)['parts'] as unknown[])
            : [])
          : [];

      for (const part of parts) {
        if (typeof part !== 'object' || part === null) continue;
        const record = part as Record<string, unknown>;

        if (typeof record['text'] === 'string' && record['text'].length > 0) {
          yield { type: 'text', text: record['text'] };
        }

        const fc = record['functionCall'];
        if (typeof fc === 'object' && fc !== null) {
          const call = fc as Record<string, unknown>;
          const name = typeof call['name'] === 'string' ? call['name'] : '';
          if (name.length > 0) {
            yield {
              type: 'tool_call',
              toolCall: {
                id: `call_${name}_${Date.now()}`,
                name,
                args: call['args'] ?? {},
              },
            };
          }
        }
      }
    }

    if (!sawCandidate) {
      throw new ProviderError(
        'unavailable',
        'Stream ended without any candidates — the connection was truncated',
      );
    }

    if (usage !== null) yield { type: 'usage', usage };
    yield { type: 'done', finishReason };
  }

  // ─── Embeddings ──────────────────────────────────────────────────────────

  async embed(
    request: { externalModelId: string; input: string[] },
    ctx: AdapterContext,
  ): Promise<{ vectors: number[][]; usage: TokenUsage }> {
    const modelPath = this.modelPath(request.externalModelId);

    // Gemini's batchEmbedContents accepts multiple texts in one call.
    const response = await this.post(
      `/${modelPath}:batchEmbedContents`,
      {
        requests: request.input.map((text) => ({
          model: modelPath,
          content: { parts: [{ text }] },
        })),
      },
      ctx,
    );

    const payload: unknown = await response.json();
    const root = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
    const embeddings = Array.isArray(root['embeddings']) ? root['embeddings'] : [];

    const vectors = embeddings
      .map((entry) => {
        if (typeof entry !== 'object' || entry === null) return undefined;
        const values = (entry as Record<string, unknown>)['values'];
        return Array.isArray(values) ? values : undefined;
      })
      .filter((v): v is number[] => v !== undefined);

    if (vectors.length !== request.input.length) {
      throw new ProviderError(
        'bad_request',
        `Embedding response had ${vectors.length} vectors for ${request.input.length} inputs`,
      );
    }

    // Gemini's embed endpoint does not return token counts; provide zeros.
    return {
      vectors,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    };
  }
}
