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
 * Anthropic Messages API.
 *
 * Three differences from the OpenAI shape are load-bearing and are the reason this is a
 * separate adapter rather than a flag on the OpenAI one:
 *   1. `system` is a top-level parameter, not a message with `role: 'system'`.
 *   2. Roles must alternate, so consecutive same-role messages have to be merged into
 *      one message with multiple content blocks.
 *   3. Tool results are `user` messages containing a `tool_result` block, not a `tool`
 *      role. And `max_tokens` is required, with no server-side default.
 *
 * There is no native JSON-schema mode, so structured output goes through `tool_forcing`.
 */

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;

interface WireMessage {
  role: 'user' | 'assistant';
  content: unknown[];
}

function toWireMessages(messages: readonly ChatMessage[]): {
  system: string | undefined;
  messages: WireMessage[];
} {
  const systemParts: string[] = [];
  const wire: WireMessage[] = [];

  const push = (role: 'user' | 'assistant', blocks: unknown[]): void => {
    const last = wire[wire.length - 1];
    // Anthropic rejects two messages of the same role in a row.
    if (last !== undefined && last.role === role) {
      last.content.push(...blocks);
      return;
    }
    wire.push({ role, content: [...blocks] });
  };

  for (const message of messages) {
    switch (message.role) {
      case 'system':
        systemParts.push(message.content);
        break;

      case 'tool':
        push('user', [
          {
            type: 'tool_result',
            tool_use_id: message.toolCallId ?? 'unknown',
            content: message.content,
          },
        ]);
        break;

      case 'assistant': {
        const blocks: unknown[] = [];
        if (message.content.length > 0) blocks.push({ type: 'text', text: message.content });
        for (const call of message.toolCalls ?? []) {
          blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args ?? {} });
        }
        // An assistant turn with neither text nor tool calls is invalid.
        if (blocks.length === 0) blocks.push({ type: 'text', text: '' });
        push('assistant', blocks);
        break;
      }

      default:
        push('user', [{ type: 'text', text: message.content }]);
        break;
    }
  }

  return { system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined, messages: wire };
}

function parseUsage(raw: unknown): TokenUsage {
  const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const input = typeof record['input_tokens'] === 'number' ? record['input_tokens'] : 0;
  const output = typeof record['output_tokens'] === 'number' ? record['output_tokens'] : 0;
  return { promptTokens: input, completionTokens: output, totalTokens: input + output };
}

function parseStopReason(raw: unknown): FinishReason {
  switch (raw) {
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'refusal':
      return 'content_filter';
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    default:
      return 'stop';
  }
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly type: ProviderType = 'anthropic';
  /**
   * Includes the version segment, matching the OpenAI adapter's convention. Appending
   * `/v1/messages` to a base URL that already ends in `/v1` would produce `/v1/v1/...`
   * for any operator who configured the URL the way the API documents it.
   */
  readonly defaultBaseUrl = 'https://api.anthropic.com/v1';
  readonly structuredOutput: StructuredOutputMode = 'tool_forcing';
  readonly supportsEmbeddings = false;

  private body(request: AdapterChatRequest, stream: boolean): Record<string, unknown> {
    const { system, messages } = toWireMessages(request.messages);

    const body: Record<string, unknown> = {
      model: request.externalModelId,
      // Required by the API; there is no default to fall back on.
      max_tokens: request.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
      messages,
    };

    if (system !== undefined) body['system'] = system;
    if (request.temperature !== undefined) body['temperature'] = request.temperature;

    if (request.tools !== undefined && request.tools.length > 0) {
      body['tools'] = request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      }));
      body['tool_choice'] =
        request.forceToolName === undefined
          ? { type: 'auto' }
          : { type: 'tool', name: request.forceToolName };
    }

    if (stream) body['stream'] = true;

    return body;
  }

  private async post(payload: Record<string, unknown>, ctx: AdapterContext): Promise<Response> {
    const url = `${ctx.baseUrl.replace(/\/+$/, '')}/messages`;

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': ANTHROPIC_VERSION,
      ...(ctx.extraHeaders ?? {}),
    };
    if (ctx.apiKey !== null) headers['x-api-key'] = ctx.apiKey;

    let response: Response;
    try {
      response = await ctx.fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      });
    } catch (cause) {
      throw new ProviderError('unavailable', `Could not reach anthropic: ${String(cause)}`, { cause });
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new ProviderError(
        classifyStatus(response.status, text),
        `anthropic returned ${response.status}: ${extractErrorMessage(text, response.statusText)}`,
        { status: response.status, retryAfterMs: parseRetryAfter(response.headers.get('retry-after')) },
      );
    }

    return response;
  }

  /**
   * The provider's catalogue.
   *
   * Anthropic's `GET /v1/models` needs the same `x-api-key` and `anthropic-version` headers as
   * `POST /messages`, so the header block is built here rather than borrowed from `post` — which
   * is POST-shaped and would send a body this request must not have.
   *
   * The payload is `{ data: [{ id, display_name, created_at, type }] }`, where `type` is
   * `"model"` for every entry and therefore says nothing about what the model is *for*. The type
   * is guessed from the id like everywhere else.
   */
  async listModels(ctx: AdapterContext): Promise<DiscoveredModel[]> {
    const url = `${ctx.baseUrl.replace(/\/+$/, '')}/models`;

    const headers: Record<string, string> = {
      accept: 'application/json',
      'anthropic-version': ANTHROPIC_VERSION,
      ...(ctx.extraHeaders ?? {}),
    };
    if (ctx.apiKey !== null) headers['x-api-key'] = ctx.apiKey;

    let response: Response;
    try {
      response = await ctx.fetch(url, {
        method: 'GET',
        headers,
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      });
    } catch (cause) {
      throw new ProviderError('unavailable', `Could not reach anthropic: ${String(cause)}`, { cause });
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new ProviderError(
        classifyStatus(response.status, text),
        `anthropic returned ${response.status}: ${extractErrorMessage(text, response.statusText)}`,
        { status: response.status, retryAfterMs: parseRetryAfter(response.headers.get('retry-after')) },
      );
    }

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
    const response = await this.post(this.body(request, false), ctx);
    const payload: unknown = await response.json();
    const root = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};

    const blocks = Array.isArray(root['content']) ? root['content'] : [];
    let content = '';
    const toolCalls: ToolCallRequest[] = [];

    for (const block of blocks) {
      if (typeof block !== 'object' || block === null) continue;
      const record = block as Record<string, unknown>;

      if (record['type'] === 'text' && typeof record['text'] === 'string') {
        content += record['text'];
      } else if (record['type'] === 'tool_use' && typeof record['name'] === 'string') {
        toolCalls.push({
          id: typeof record['id'] === 'string' ? record['id'] : `call_${record['name']}`,
          name: record['name'],
          args: record['input'] ?? {},
        });
      }
    }

    return {
      content,
      toolCalls,
      finishReason: parseStopReason(root['stop_reason']),
      usage: parseUsage(root['usage']),
    };
  }

  async *stream(request: AdapterChatRequest, ctx: AdapterContext): AsyncGenerator<StreamChunk> {
    const response = await this.post(this.body(request, true), ctx);

    let finishReason: FinishReason = 'stop';
    let usage: TokenUsage | null = null;
    let sawToolUse = false;
    // Anthropic terminates a stream with `message_delta` carrying a `stop_reason`,
    // followed by `message_stop`. Either is enough; neither means the socket was cut and
    // what we hold is a fragment of an answer, not an answer.
    let sawTerminator = false;

    // Tool arguments stream as `input_json_delta` fragments tied to a content block
    // index; they are accumulated and emitted once the block closes.
    const openBlocks = new Map<number, { id: string; name: string; json: string }>();

    for await (const data of iterateSseData(response.body)) {
      if (data.length === 0) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }

      const root = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
      const eventType = root['type'];

      if (eventType === 'message_start') {
        const message = root['message'];
        if (typeof message === 'object' && message !== null) {
          usage = parseUsage((message as Record<string, unknown>)['usage']);
        }
        continue;
      }

      if (eventType === 'content_block_start') {
        const index = typeof root['index'] === 'number' ? root['index'] : 0;
        const block = root['content_block'];
        if (typeof block === 'object' && block !== null) {
          const record = block as Record<string, unknown>;
          if (record['type'] === 'tool_use') {
            sawToolUse = true;
            openBlocks.set(index, {
              id: typeof record['id'] === 'string' ? record['id'] : `call_${index}`,
              name: typeof record['name'] === 'string' ? record['name'] : '',
              json: '',
            });
          }
        }
        continue;
      }

      if (eventType === 'content_block_delta') {
        const index = typeof root['index'] === 'number' ? root['index'] : 0;
        const delta = root['delta'];
        if (typeof delta !== 'object' || delta === null) continue;
        const record = delta as Record<string, unknown>;

        if (record['type'] === 'text_delta' && typeof record['text'] === 'string' && record['text'].length > 0) {
          yield { type: 'text', text: record['text'] };
        } else if (record['type'] === 'input_json_delta' && typeof record['partial_json'] === 'string') {
          const open = openBlocks.get(index);
          if (open !== undefined) open.json += record['partial_json'];
        }
        continue;
      }

      if (eventType === 'content_block_stop') {
        const index = typeof root['index'] === 'number' ? root['index'] : 0;
        const open = openBlocks.get(index);
        if (open !== undefined) {
          let args: unknown = {};
          try {
            args = open.json.length === 0 ? {} : JSON.parse(open.json);
          } catch {
            args = { __unparsed: open.json };
          }
          if (open.name.length > 0) {
            yield { type: 'tool_call', toolCall: { id: open.id, name: open.name, args } };
          }
          openBlocks.delete(index);
        }
        continue;
      }

      if (eventType === 'message_delta') {
        const delta = root['delta'];
        if (typeof delta === 'object' && delta !== null) {
          const record = delta as Record<string, unknown>;
          if (record['stop_reason'] !== undefined && record['stop_reason'] !== null) {
            finishReason = parseStopReason(record['stop_reason']);
            sawTerminator = true;
          }
        }
        if (root['usage'] !== undefined && root['usage'] !== null) {
          const delta = parseUsage(root['usage']);
          usage =
            usage === null
              ? delta
              : {
                  promptTokens: usage.promptTokens,
                  completionTokens: delta.completionTokens,
                  totalTokens: usage.promptTokens + delta.completionTokens,
                };
        }
        continue;
      }

      if (eventType === 'message_stop') {
        sawTerminator = true;
        continue;
      }

      if (eventType === 'error') {
        const error = root['error'];
        const message =
          typeof error === 'object' && error !== null
            ? String((error as Record<string, unknown>)['message'] ?? 'stream error')
            : 'stream error';
        throw new ProviderError('unknown', `anthropic stream error: ${message}`);
      }
    }

    if (!sawTerminator) {
      throw new ProviderError(
        'unavailable',
        'Stream ended without a stop_reason or message_stop — the connection was truncated',
      );
    }

    if (usage !== null) yield { type: 'usage', usage };
    yield { type: 'done', finishReason: sawToolUse && finishReason === 'stop' ? 'tool_calls' : finishReason };
  }
}
