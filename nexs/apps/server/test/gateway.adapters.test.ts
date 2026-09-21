import { describe, expect, it } from 'vitest';
import type { ChatMessage, StreamChunk } from '@nexs/shared';
import { AnthropicAdapter } from '../src/services/gateway/adapters/anthropic.js';
import { ProviderError, classifyStatus, extractErrorMessage } from '../src/services/gateway/adapters/errors.js';
import { createAdapterRegistry } from '../src/services/gateway/adapters/index.js';
import { OpenAICompatibleAdapter } from '../src/services/gateway/adapters/openai.js';
import { iterateSseData } from '../src/services/gateway/adapters/sse.js';
import type { AdapterChatRequest } from '../src/services/gateway/adapters/types.js';
import {
  adapterContext,
  jsonResponse,
  sseResponse,
  type FetchCall,
} from './helpers/gateway-harness.js';

/**
 * The translation layer, tested directly.
 *
 * These tests exist because an adapter bug is invisible from the gateway: a request
 * that drops the `system` message or a stream that emits a half-built tool call still
 * "works" in the sense that it returns something. The assertions below are about the
 * exact bytes on the wire and the exact chunks off it.
 */

const openai = new OpenAICompatibleAdapter({
  type: 'openai',
  defaultBaseUrl: 'https://api.openai.com/v1',
});
const groq = new OpenAICompatibleAdapter({
  type: 'groq',
  defaultBaseUrl: 'https://api.groq.com/openai/v1',
});
const anthropic = new AnthropicAdapter();

function collect(chunks: StreamChunk[]): {
  text: string;
  toolCalls: Array<{ id: string; name: string; args: unknown }>;
  usage: StreamChunk & { type: 'usage' } | null;
  done: StreamChunk & { type: 'done' } | null;
} {
  return {
    text: chunks
      .filter((c): c is Extract<StreamChunk, { type: 'text' }> => c.type === 'text')
      .map((c) => c.text)
      .join(''),
    toolCalls: chunks
      .filter((c): c is Extract<StreamChunk, { type: 'tool_call' }> => c.type === 'tool_call')
      .map((c) => c.toolCall),
    usage: (chunks.find((c) => c.type === 'usage') as never) ?? null,
    done: (chunks.find((c) => c.type === 'done') as never) ?? null,
  };
}

async function drain(iterable: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of iterable) out.push(chunk);
  return out;
}

const USER_MESSAGE: ChatMessage[] = [{ role: 'user', content: 'hello' }];

function chatRequest(overrides: Partial<AdapterChatRequest> = {}): AdapterChatRequest {
  return { externalModelId: 'test-model', messages: USER_MESSAGE, ...overrides };
}

// ── SSE framing ───────────────────────────────────────────────────────────────

describe('iterateSseData', () => {
  function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let index = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index >= chunks.length) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(chunks[index]!));
        index += 1;
      },
    });
  }

  it('reassembles a frame split across a chunk boundary', async () => {
    // The boundary lands in the middle of the JSON *and* between the two newlines of
    // the frame separator — the two places a naive splitter gets wrong.
    const stream = streamOf(['data: {"a":', '1}\n', '\ndata: {"b":2}\n\n']);

    const frames: string[] = [];
    for await (const frame of iterateSseData(stream)) frames.push(frame);

    expect(frames).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('normalises CRLF line endings', async () => {
    const frames: string[] = [];
    for await (const frame of iterateSseData(streamOf(['data: {"a":1}\r\n\r\n']))) {
      frames.push(frame);
    }
    expect(frames).toEqual(['{"a":1}']);
  });

  it('flushes a trailing frame that never got its blank line', async () => {
    const frames: string[] = [];
    for await (const frame of iterateSseData(streamOf(['data: {"a":1}\n\ndata: [DONE]']))) {
      frames.push(frame);
    }
    expect(frames).toEqual(['{"a":1}', '[DONE]']);
  });

  it('ignores comment and event lines', async () => {
    const frames: string[] = [];
    for await (const frame of iterateSseData(streamOf([': keep-alive\n\nevent: ping\n\n']))) {
      frames.push(frame);
    }
    expect(frames).toEqual([]);
  });

  it('yields nothing for a null body', async () => {
    const frames: string[] = [];
    for await (const frame of iterateSseData(null)) frames.push(frame);
    expect(frames).toEqual([]);
  });
});

// ── error classification ──────────────────────────────────────────────────────

describe('classifyStatus', () => {
  it('maps the statuses that change gateway policy', () => {
    expect(classifyStatus(429, '')).toBe('rate_limited');
    expect(classifyStatus(401, '')).toBe('auth');
    expect(classifyStatus(403, '')).toBe('auth');
    expect(classifyStatus(500, '')).toBe('unavailable');
    expect(classifyStatus(503, '')).toBe('unavailable');
    expect(classifyStatus(400, 'bad parameter')).toBe('bad_request');
  });

  it('recognises a context-length complaint hiding in a 400', () => {
    // Providers report this as prose, not a dedicated code, so the wording is the only
    // signal — and getting it right is what sends the call down the budgeting ladder.
    expect(classifyStatus(400, "This model's maximum context length is 128000 tokens")).toBe(
      'context_exceeded',
    );
    expect(classifyStatus(400, 'prompt is too long: 200000 tokens > 128000 maximum')).toBe(
      'context_exceeded',
    );
  });
});

describe('extractErrorMessage', () => {
  it('digs a message out of the shapes providers actually use', () => {
    expect(extractErrorMessage('{"error":{"message":"bad key"}}', 'fallback')).toBe('bad key');
    expect(extractErrorMessage('{"error":"bad key"}', 'fallback')).toBe('bad key');
    expect(extractErrorMessage('{"message":"bad key"}', 'fallback')).toBe('bad key');
    expect(extractErrorMessage('', 'fallback')).toBe('fallback');
    expect(extractErrorMessage('<html>500</html>', 'fallback')).toBe('<html>500</html>');
  });

  it('truncates an HTML error page rather than logging all of it', () => {
    const page = `<html>${'x'.repeat(2000)}</html>`;
    expect(extractErrorMessage(page, 'fallback').length).toBeLessThan(600);
  });
});

// ── OpenAI-compatible adapter ─────────────────────────────────────────────────

describe('OpenAICompatibleAdapter — request shape', () => {
  it('sends a bearer token and the resolved base URL', async () => {
    const calls: FetchCall[] = [];
    const ctx = adapterContext(calls, () =>
      jsonResponse({
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'hi' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );

    await openai.chat(chatRequest(), ctx);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.example.test/v1/chat/completions');
    expect(calls[0]!.headers['authorization']).toBe('Bearer sk-test-key');
  });

  it('round-trips an assistant turn that requested tools, so the results have a parent', async () => {
    const calls: FetchCall[] = [];
    const ctx = adapterContext(calls, () =>
      jsonResponse({ choices: [{ index: 0, finish_reason: 'stop', message: { content: 'ok' } }] }),
    );

    await openai.chat(
      chatRequest({
        messages: [
          { role: 'user', content: 'weather?' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'call_1', name: 'get_weather', args: { city: 'Pune' } }],
          },
          { role: 'tool', content: '{"temp":31}', toolCallId: 'call_1' },
        ],
      }),
      ctx,
    );

    const messages = calls[0]!.body['messages'] as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(3);
    expect(messages[1]!['tool_calls']).toEqual([
      { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Pune"}' } },
    ]);
    expect(messages[2]).toEqual({
      role: 'tool',
      content: '{"temp":31}',
      tool_call_id: 'call_1',
    });
  });

  it('uses native json_schema decoding on OpenAI', async () => {
    const calls: FetchCall[] = [];
    const ctx = adapterContext(calls, () => jsonResponse({ choices: [{ message: { content: '{}' } }] }));

    await openai.chat(
      chatRequest({ responseFormat: { name: 'Plan', schema: { type: 'object' }, strict: true } }),
      ctx,
    );

    expect(calls[0]!.body['response_format']).toEqual({
      type: 'json_schema',
      json_schema: { name: 'Plan', schema: { type: 'object' }, strict: true },
    });
  });

  it('does not pretend a non-OpenAI provider has native json_schema', async () => {
    const calls: FetchCall[] = [];
    const ctx = adapterContext(calls, () => jsonResponse({ choices: [{ message: { content: '{}' } }] }));

    await groq.chat(chatRequest({ responseFormat: { name: 'Plan', schema: {} } }), ctx);

    // Groq gets function calling instead — claiming `response_format` here would 400.
    expect(calls[0]!.body['response_format']).toBeUndefined();
  });

  it('forces a named tool when the gateway asks for tool_forcing', async () => {
    const calls: FetchCall[] = [];
    const ctx = adapterContext(calls, () => jsonResponse({ choices: [{ message: { content: '{}' } }] }));

    await groq.chat(
      chatRequest({
        tools: [{ name: 'respond', description: 'd', inputSchema: { type: 'object' } }],
        forceToolName: 'respond',
      }),
      ctx,
    );

    expect(calls[0]!.body['tool_choice']).toEqual({
      type: 'function',
      function: { name: 'respond' },
    });
  });

  it('asks for usage in the stream only where the provider documents it', async () => {
    const calls: FetchCall[] = [];
    const ctx = adapterContext(calls, () =>
      sseResponse(['data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n', 'data: [DONE]\n\n']),
    );

    await drain(openai.stream(chatRequest(), ctx));
    await drain(groq.stream(chatRequest(), ctx));

    expect(calls[0]!.body['stream_options']).toEqual({ include_usage: true });
    expect(calls[1]!.body['stream_options']).toBeUndefined();
  });
});

describe('OpenAICompatibleAdapter — response parsing', () => {
  it('parses content, tool calls, finish reason and usage from one response', async () => {
    const calls: FetchCall[] = [];
    const ctx = adapterContext(calls, () =>
      jsonResponse({
        choices: [
          {
            index: 0,
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                { id: 'call_a', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
      }),
    );

    const result = await openai.chat(chatRequest(), ctx);

    expect(result.toolCalls).toEqual([{ id: 'call_a', name: 'search', args: { q: 'x' } }]);
    expect(result.finishReason).toBe('tool_calls');
    expect(result.usage).toEqual({ promptTokens: 12, completionTokens: 3, totalTokens: 15 });
  });

  it('keeps malformed tool arguments rather than discarding them', async () => {
    const calls: FetchCall[] = [];
    const ctx = adapterContext(calls, () =>
      jsonResponse({
        choices: [
          {
            message: {
              content: '',
              tool_calls: [
                { id: 'call_a', type: 'function', function: { name: 'search', arguments: '{not json' } },
              ],
            },
          },
        ],
      }),
    );

    const result = await openai.chat(chatRequest(), ctx);

    // The plan validator can then reject it with the actual content in hand, which is
    // more useful than a silent `{}`.
    expect(result.toolCalls[0]!.args).toEqual({ __unparsed: '{not json' });
  });

  it('reports a missing tool-call id deterministically', async () => {
    const calls: FetchCall[] = [];
    const ctx = adapterContext(calls, () =>
      jsonResponse({
        choices: [
          { message: { content: '', tool_calls: [{ function: { name: 'search', arguments: '{}' } }] } },
        ],
      }),
    );

    const result = await openai.chat(chatRequest(), ctx);
    expect(result.toolCalls[0]!.id).toBe('call_search');
  });
});

describe('OpenAICompatibleAdapter — streaming', () => {
  it('emits text deltas in order and a terminal done chunk', async () => {
    const calls: FetchCall[] = [];
    const ctx = adapterContext(calls, () =>
      sseResponse([
        'data: {"choices":[{"index":0,"delta":{"content":"Hel"},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    );

    const parsed = collect(await drain(openai.stream(chatRequest(), ctx)));

    expect(parsed.text).toBe('Hello');
    expect(parsed.done).toEqual({ type: 'done', finishReason: 'stop' });
  });

  it('accumulates a tool call fragmented across frames and emits it whole', async () => {
    const calls: FetchCall[] = [];
    const ctx = adapterContext(calls, () =>
      sseResponse([
        // The id and name arrive on the first delta...
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_z","function":{"name":"sea","arguments":""}}]},"finish_reason":null}]}\n\n',
        // ...then the name and the arguments arrive in pieces.
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"name":"rch","arguments":"{\\"q\\":"}}]},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"cats\\"}"}}]},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    );

    const parsed = collect(await drain(openai.stream(chatRequest(), ctx)));

    // The consumer never sees a half-built call: exactly one, with the name joined and
    // the arguments parsed.
    expect(parsed.toolCalls).toEqual([{ id: 'call_z', name: 'search', args: { q: 'cats' } }]);
    expect(parsed.text).toBe('');
  });

  it('emits usage as its own chunk and never as text', async () => {
    const calls: FetchCall[] = [];
    const ctx = adapterContext(calls, () =>
      sseResponse([
        'data: {"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":2,"total_tokens":9}}\n\n',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    );

    const parsed = collect(await drain(openai.stream(chatRequest(), ctx)));

    expect(parsed.text).toBe('hi');
    expect(parsed.usage).toEqual({
      type: 'usage',
      usage: { promptTokens: 7, completionTokens: 2, totalTokens: 9 },
    });
  });

  it('survives a malformed frame in the middle of a healthy stream', async () => {
    const calls: FetchCall[] = [];
    const ctx = adapterContext(calls, () =>
      sseResponse([
        'data: {"choices":[{"index":0,"delta":{"content":"a"},"finish_reason":null}]}\n\n',
        'data: {this is not json\n\n',
        'data: {"choices":[{"index":0,"delta":{"content":"b"},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    );

    const parsed = collect(await drain(openai.stream(chatRequest(), ctx)));
    expect(parsed.text).toBe('ab');
  });

  it('infers tool_calls when a provider says stop but sent tool calls anyway', async () => {
    const calls: FetchCall[] = [];
    const ctx = adapterContext(calls, () =>
      sseResponse([
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"f","arguments":"{}"}}]},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    );

    const parsed = collect(await drain(openai.stream(chatRequest(), ctx)));
    expect(parsed.done).toEqual({ type: 'done', finishReason: 'tool_calls' });
  });

  it('accepts a stream that ends without [DONE], as long as it reported a finish reason', async () => {
    // Not every OpenAI-compatible runtime sends the sentinel; the finish reason is the
    // real signal, so the adapter must not require both.
    const calls: FetchCall[] = [];
    const ctx = adapterContext(calls, () =>
      sseResponse([
        'data: {"choices":[{"index":0,"delta":{"content":"done"},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      ]),
    );

    const parsed = collect(await drain(openai.stream(chatRequest(), ctx)));
    expect(parsed.text).toBe('done');
    expect(parsed.done).toEqual({ type: 'done', finishReason: 'stop' });
  });

  it('treats a stream cut off before any finish reason as a failure, not a short answer', async () => {
    // The socket closed mid-answer. Reporting a clean `stop` here would let half a
    // sentence be persisted and shown as the model's complete reply.
    const calls: FetchCall[] = [];
    const ctx = adapterContext(calls, () =>
      sseResponse(['data: {"choices":[{"index":0,"delta":{"content":"The answer is"},"finish_reason":null}]}\n\n']),
    );

    const chunks: StreamChunk[] = [];
    const error = (await (async () => {
      try {
        for await (const chunk of openai.stream(chatRequest(), ctx)) chunks.push(chunk);
        return null;
      } catch (err) {
        return err;
      }
    })()) as ProviderError;

    expect(collect(chunks).text).toBe('The answer is');
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.kind).toBe('unavailable');
    expect(error.message).toContain('truncated');
  });
});

describe('OpenAICompatibleAdapter — failures', () => {
  it('classifies a 429 and carries Retry-After through', async () => {
    const calls: FetchCall[] = [];
    const ctx = adapterContext(calls, () =>
      jsonResponse(
        { error: { message: 'slow down' } },
        { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '30' } },
      ),
    );

    const error = await openai.chat(chatRequest(), ctx).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).kind).toBe('rate_limited');
    expect((error as ProviderError).retryAfterMs).toBe(30_000);
    expect((error as ProviderError).retryable).toBe(true);
    expect((error as ProviderError).message).toContain('slow down');
  });

  it('does not mark an auth failure retryable', async () => {
    const calls: FetchCall[] = [];
    const ctx = adapterContext(calls, () => jsonResponse({ error: 'bad key' }, { status: 401 }));

    const error = (await openai.chat(chatRequest(), ctx).catch((e: unknown) => e)) as ProviderError;

    expect(error.kind).toBe('auth');
    // Retrying a wrong key just burns attempts; the breaker trips instead.
    expect(error.retryable).toBe(false);
  });

  it('treats a transport failure as a retryable outage', async () => {
    const calls: FetchCall[] = [];
    const ctx = adapterContext(calls, () => {
      throw new Error('ECONNREFUSED');
    });

    const error = (await openai.chat(chatRequest(), ctx).catch((e: unknown) => e)) as ProviderError;

    expect(error).toBeInstanceOf(ProviderError);
    expect(error.kind).toBe('unavailable');
    expect(error.retryable).toBe(true);
  });
});

describe('OpenAICompatibleAdapter — embeddings', () => {
  it('parses vectors and rejects a count mismatch', async () => {
    const calls: FetchCall[] = [];
    const ctx = adapterContext(calls, () =>
      jsonResponse({
        data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }],
        usage: { prompt_tokens: 4, completion_tokens: 0, total_tokens: 4 },
      }),
    );

    const result = await openai.embed!({ externalModelId: 'embed-1', input: ['a', 'b'] }, ctx);

    expect(result.vectors).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    expect(result.usage.promptTokens).toBe(4);
  });

  it('refuses a response whose vector count does not match the input count', async () => {
    const calls: FetchCall[] = [];
    const ctx = adapterContext(calls, () => jsonResponse({ data: [{ embedding: [0.1] }] }));

    const error = (await openai
      .embed!({ externalModelId: 'embed-1', input: ['a', 'b'] }, ctx)
      .catch((e: unknown) => e)) as ProviderError;

    // Silently zipping a short list would misalign every vector with its source text.
    expect(error.kind).toBe('bad_request');
    expect(error.message).toContain('1 vectors for 2 inputs');
  });
});

// ── Anthropic adapter ─────────────────────────────────────────────────────────

describe('AnthropicAdapter — request shape', () => {
  it('promotes system messages to a top-level parameter', async () => {
    const calls: FetchCall[] = [];
    const ctx = adapterContext(calls, () =>
      jsonResponse({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }),
    );

    await anthropic.chat(
      chatRequest({
        messages: [
          { role: 'system', content: 'You are terse.' },
          { role: 'system', content: 'Never apologise.' },
          { role: 'user', content: 'hi' },
        ],
      }),
      ctx,
    );

    expect(calls[0]!.body['system']).toBe('You are terse.\n\nNever apologise.');
    // ...and they must not also appear as messages.
    const messages = calls[0]!.body['messages'] as Array<{ role: string }>;
    expect(messages.map((m) => m.role)).toEqual(['user']);
  });

  it('merges consecutive same-role messages, which the API rejects otherwise', async () => {
    const calls: FetchCall[] = [];
    const ctx = adapterContext(calls, () => jsonResponse({ content: [], stop_reason: 'end_turn' }));

    await anthropic.chat(
      chatRequest({
        messages: [
          { role: 'user', content: 'first' },
          { role: 'user', content: 'second' },
        ],
      }),
      ctx,
    );

    const messages = calls[0]!.body['messages'] as Array<{ role: string; content: unknown[] }>;
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toEqual([
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ]);
  });

  it('turns a tool result into a user message with a tool_result block', async () => {
    const calls: FetchCall[] = [];
    const ctx = adapterContext(calls, () => jsonResponse({ content: [], stop_reason: 'end_turn' }));

    await anthropic.chat(
      chatRequest({
        messages: [
          {
            role: 'assistant',
            content: 'checking',
            toolCalls: [{ id: 'tu_1', name: 'get_weather', args: { city: 'Pune' } }],
          },
          { role: 'tool', content: '{"temp":31}', toolCallId: 'tu_1' },
        ],
      }),
      ctx,
    );

    const messages = calls[0]!.body['messages'] as Array<{ role: string; content: unknown[] }>;
    expect(messages[0]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'checking' },
        { type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: 'Pune' } },
      ],
    });
    expect(messages[1]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '{"temp":31}' }],
    });
  });

  it('always sends max_tokens, which has no server-side default here', async () => {
    const calls: FetchCall[] = [];
    const ctx = adapterContext(calls, () => jsonResponse({ content: [], stop_reason: 'end_turn' }));

    await anthropic.chat(chatRequest(), ctx);
    expect(calls[0]!.body['max_tokens']).toBe(4096);

    await anthropic.chat(chatRequest({ maxOutputTokens: 128 }), ctx);
    expect(calls[1]!.body['max_tokens']).toBe(128);
  });

  it('authenticates with x-api-key and the version header', async () => {
    const calls: FetchCall[] = [];
    const ctx = adapterContext(calls, () => jsonResponse({ content: [], stop_reason: 'end_turn' }));

    await anthropic.chat(chatRequest(), ctx);

    expect(calls[0]!.url).toBe('https://api.example.test/v1/messages');
    expect(calls[0]!.headers['x-api-key']).toBe('sk-test-key');
    expect(calls[0]!.headers['anthropic-version']).toBe('2023-06-01');
  });

  it('maps tool_forcing onto the Anthropic tool_choice shape', async () => {
    const calls: FetchCall[] = [];
    const ctx = adapterContext(calls, () => jsonResponse({ content: [], stop_reason: 'end_turn' }));

    await anthropic.chat(
      chatRequest({
        tools: [{ name: 'respond', description: 'd', inputSchema: { type: 'object' } }],
        forceToolName: 'respond',
      }),
      ctx,
    );

    expect(calls[0]!.body['tool_choice']).toEqual({ type: 'tool', name: 'respond' });
    expect(calls[0]!.body['tools']).toEqual([
      { name: 'respond', description: 'd', input_schema: { type: 'object' } },
    ]);
  });
});

describe('AnthropicAdapter — response parsing', () => {
  it('joins text blocks and parses tool_use blocks', async () => {
    const calls: FetchCall[] = [];
    const ctx = adapterContext(calls, () =>
      jsonResponse({
        content: [
          { type: 'text', text: 'Let me check. ' },
          { type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: 'Pune' } },
          { type: 'text', text: 'One moment.' },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 20, output_tokens: 8 },
      }),
    );

    const result = await anthropic.chat(chatRequest(), ctx);

    expect(result.content).toBe('Let me check. One moment.');
    expect(result.toolCalls).toEqual([{ id: 'tu_1', name: 'get_weather', args: { city: 'Pune' } }]);
    expect(result.finishReason).toBe('tool_calls');
    expect(result.usage).toEqual({ promptTokens: 20, completionTokens: 8, totalTokens: 28 });
  });

  it('maps max_tokens to a length finish reason', async () => {
    const calls: FetchCall[] = [];
    const ctx = adapterContext(calls, () =>
      jsonResponse({ content: [{ type: 'text', text: 'truncated' }], stop_reason: 'max_tokens' }),
    );

    expect((await anthropic.chat(chatRequest(), ctx)).finishReason).toBe('length');
  });
});

describe('AnthropicAdapter — streaming', () => {
  it('emits text deltas and assembles tool input from partial_json fragments', async () => {
    const calls: FetchCall[] = [];
    const ctx = adapterContext(calls, () =>
      sseResponse([
        'data: {"type":"message_start","message":{"usage":{"input_tokens":15,"output_tokens":0}}}\n\n',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Let me "}}\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"check."}}\n\n',
        'data: {"type":"content_block_stop","index":0}\n\n',
        'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_9","name":"get_weather"}}\n\n',
        'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":"}}\n\n',
        'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"Pune\\"}"}}\n\n',
        'data: {"type":"content_block_stop","index":1}\n\n',
        'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":12}}\n\n',
      ]),
    );

    const parsed = collect(await drain(anthropic.stream(chatRequest(), ctx)));

    expect(parsed.text).toBe('Let me check.');
    expect(parsed.toolCalls).toEqual([{ id: 'tu_9', name: 'get_weather', args: { city: 'Pune' } }]);
    expect(parsed.done).toEqual({ type: 'done', finishReason: 'tool_calls' });
    // input_tokens came from message_start, output_tokens from message_delta.
    expect(parsed.usage).toEqual({
      type: 'usage',
      usage: { promptTokens: 15, completionTokens: 12, totalTokens: 27 },
    });
  });

  it('treats a stream cut off before message_stop as a failure', async () => {
    const calls: FetchCall[] = [];
    const ctx = adapterContext(calls, () =>
      sseResponse([
        'data: {"type":"message_start","message":{"usage":{"input_tokens":4,"output_tokens":0}}}\n\n',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"half an "}}\n\n',
      ]),
    );

    const error = (await drain(anthropic.stream(chatRequest(), ctx)).catch(
      (e: unknown) => e,
    )) as ProviderError;

    expect(error).toBeInstanceOf(ProviderError);
    expect(error.message).toContain('truncated');
  });

  it('surfaces an in-stream error event as a provider error', async () => {
    const calls: FetchCall[] = [];
    const ctx = adapterContext(calls, () =>
      sseResponse([
        'data: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
        'data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
      ]),
    );

    const error = (await drain(anthropic.stream(chatRequest(), ctx)).catch(
      (e: unknown) => e,
    )) as ProviderError;

    expect(error).toBeInstanceOf(ProviderError);
    expect(error.message).toContain('Overloaded');
  });
});

// ── registry ──────────────────────────────────────────────────────────────────

describe('createAdapterRegistry', () => {
  it('covers every provider that speaks the OpenAI wire format', () => {
    const registry = createAdapterRegistry();

    for (const type of [
      'openai',
      'azure-openai',
      'groq',
      'mistral',
      'deepseek',
      'xai',
      'together',
      'openrouter',
      'openai-compatible',
      'local',
      'ollama',
      'anthropic',
      'google',
    ] as const) {
      expect(registry.has(type), `missing adapter for ${type}`).toBe(true);
    }
  });

  it('registers Gemini with its own dedicated adapter', () => {
    const registry = createAdapterRegistry();
    expect(registry.has('google')).toBe(true);
    expect(registry.get('google')!.type).toBe('google');
    expect(registry.get('google')!.defaultBaseUrl).toBe(
      'https://generativelanguage.googleapis.com/v1beta',
    );
  });

  it('agrees with each adapter about what it is', () => {
    for (const [type, adapter] of createAdapterRegistry()) {
      expect(adapter.type).toBe(type);
    }
  });

  it('declares embeddings only where they exist', () => {
    const registry = createAdapterRegistry();
    expect(registry.get('anthropic')!.supportsEmbeddings).toBe(false);
    expect(registry.get('openai')!.supportsEmbeddings).toBe(true);
    expect(registry.get('openai')!.embed).toBeTypeOf('function');
    expect(registry.get('anthropic')!.embed).toBeUndefined();
  });

  it('prefers native json_schema only on OpenAI and Azure', () => {
    const registry = createAdapterRegistry();
    expect(registry.get('openai')!.structuredOutput).toBe('json_schema');
    expect(registry.get('azure-openai')!.structuredOutput).toBe('json_schema');
    expect(registry.get('groq')!.structuredOutput).toBe('tool_forcing');
    expect(registry.get('anthropic')!.structuredOutput).toBe('tool_forcing');
  });
});
