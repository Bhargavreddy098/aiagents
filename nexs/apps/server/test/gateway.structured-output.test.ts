import { beforeEach, describe, expect, it } from 'vitest';
import type { ApiError, StructuredOutputRequest } from '@nexs/shared';
import {
  TEST_TENANT,
  createHarness,
  jsonResponse,
  openAiChatBody,
  openAiFinishFrame,
  openAiTextFrame,
  sseResponse,
  OPENAI_DONE,
  type FetchCall,
  type Harness,
} from './helpers/gateway-harness.js';

/**
 * Structured output — "give me JSON matching this schema", translated per provider.
 *
 * The contract this file protects is that the *caller* never learns which mechanism was
 * used. Three exist: OpenAI decodes against a JSON schema natively, most of the
 * OpenAI-compatible ecosystem only has function calling, and a provider with neither
 * gets the schema described in the prompt. All three must produce the same
 * `GatewayChatResult`, because the engine's plan validator parses `content` and would
 * otherwise need a branch per provider — exactly what this seam exists to prevent.
 */

const OPENAI_BASE = 'https://a.test/v1';
const GROQ_BASE = 'https://b.test/v1';

const PLAN_SCHEMA: StructuredOutputRequest = {
  name: 'Plan',
  schema: {
    type: 'object',
    properties: { steps: { type: 'array', items: { type: 'string' } } },
    required: ['steps'],
  },
};

let harness: Harness;

beforeEach(() => {
  harness = createHarness();
});

async function seed(options: {
  type: 'openai' | 'groq';
  baseUrl: string;
  structuredOutputMode?: 'json_schema' | 'tool_forcing' | 'prompt';
}): Promise<string> {
  const provider = await harness.seedProvider({
    slug: options.type === 'openai' ? 'openai' : 'groq',
    type: options.type,
    baseUrl: options.baseUrl,
    apiKey: 'sk-test',
  });
  const model = await harness.seedModel({
    providerId: provider.id,
    externalModelId: 'test-model',
    ...(options.structuredOutputMode === undefined
      ? {}
      : { structuredOutputMode: options.structuredOutputMode }),
  });
  return model.id;
}

function lastBody(): Record<string, unknown> {
  return harness.calls[harness.calls.length - 1]!.body;
}

/** A response whose content is the JSON the caller asked for. */
function schemaResponse(payload: unknown): Response {
  return jsonResponse(openAiChatBody({ content: JSON.stringify(payload) }));
}

/** A response in which the model called the named function instead. */
function toolCallResponse(name: string, args: unknown): Response {
  return jsonResponse(
    openAiChatBody({
      content: '',
      finishReason: 'tool_calls',
      toolCalls: [{ id: 'call_shim', name, args: JSON.stringify(args) }],
    }),
  );
}

// ── native json_schema ────────────────────────────────────────────────────────

describe('json_schema providers', () => {
  it('passes the schema to the provider for it to constrain decoding', async () => {
    const modelId = await seed({ type: 'openai', baseUrl: OPENAI_BASE });
    harness.onFetch(() => schemaResponse({ steps: ['a', 'b'] }));

    const result = await harness.gateway.chat({
      tenantId: TEST_TENANT,
      modelId,
      messages: [{ role: 'user', content: 'plan it' }],
      responseFormat: PLAN_SCHEMA,
    });

    expect(lastBody()['response_format']).toEqual({
      type: 'json_schema',
      json_schema: { name: 'Plan', schema: PLAN_SCHEMA.schema, strict: true },
    });
    // The content is whatever the provider produced — no shim, no unwrapping.
    expect(result.content).toBe('{"steps":["a","b"]}');
    expect(result.toolCalls).toEqual([]);
  });
});

// ── tool_forcing ──────────────────────────────────────────────────────────────

describe('tool_forcing providers', () => {
  it('forces a synthetic tool and turns its arguments into the content', async () => {
    const modelId = await seed({ type: 'groq', baseUrl: GROQ_BASE });
    harness.onFetch(() => toolCallResponse('Plan', { steps: ['a'] }));

    const result = await harness.gateway.chat({
      tenantId: TEST_TENANT,
      modelId,
      messages: [{ role: 'user', content: 'plan it' }],
      responseFormat: PLAN_SCHEMA,
    });

    const body = lastBody();
    // No native mode, so the schema rides along as a function definition...
    expect(body['response_format']).toBeUndefined();
    expect(body['tools']).toEqual([
      {
        type: 'function',
        function: {
          name: 'Plan',
          description: 'Return the answer as JSON matching the provided schema.',
          parameters: PLAN_SCHEMA.schema,
        },
      },
    ]);
    // ...and the model is told it has no choice.
    expect(body['tool_choice']).toEqual({ type: 'function', function: { name: 'Plan' } });

    // The caller sees the same shape as the json_schema path: JSON in `content`, and the
    // synthetic tool is not exposed as a real tool call.
    expect(result.content).toBe('{"steps":["a"]}');
    expect(result.toolCalls).toEqual([]);
    expect(result.finishReason).toBe('stop');
  });

  it('keeps real tool calls separate from the forced schema tool', async () => {
    const modelId = await seed({ type: 'groq', baseUrl: GROQ_BASE });
    harness.onFetch(() =>
      jsonResponse(
        openAiChatBody({
          content: '',
          finishReason: 'tool_calls',
          toolCalls: [
            { id: 'call_1', name: 'search', args: '{"q":"x"}' },
            { id: 'call_2', name: 'Plan', args: '{"steps":[]}' },
          ],
        }),
      ),
    );

    const result = await harness.gateway.chat({
      tenantId: TEST_TENANT,
      modelId,
      messages: [{ role: 'user', content: 'go' }],
      tools: [{ name: 'search', description: 'search', inputSchema: { type: 'object' } }],
      responseFormat: PLAN_SCHEMA,
    });

    expect(result.content).toBe('{"steps":[]}');
    expect(result.toolCalls).toEqual([{ id: 'call_1', name: 'search', args: { q: 'x' } }]);
  });

  it('fails when the model ignores the forced tool instead of returning nothing', async () => {
    const modelId = await seed({ type: 'groq', baseUrl: GROQ_BASE });
    // The model answered in prose despite being told it had exactly one option.
    harness.onFetch(() => jsonResponse(openAiChatBody({ content: 'Sure! Here is a plan.' })));

    const error = (await harness.gateway
      .chat({
        tenantId: TEST_TENANT,
        modelId,
        messages: [{ role: 'user', content: 'plan it' }],
        responseFormat: PLAN_SCHEMA,
      })
      .catch((e: unknown) => e)) as ApiError;

    // Returning the prose would hand the caller a string its JSON parser rejects, several
    // frames away from the cause. Failing here names the actual problem.
    expect(error.code).toBe('GATEWAY_FALLBACK_EXHAUSTED');
    expect(String((error.details as { lastError?: string } | undefined)?.lastError)).toContain(
      'forced structured-output tool',
    );
  });
});

// ── the per-model override ────────────────────────────────────────────────────

describe('Model.metadata.structuredOutputMode', () => {
  it('downgrades a model that rejects native json_schema, without reclassifying the provider', async () => {
    // A fine-tune served over the OpenAI wire format that 400s on `response_format`.
    const modelId = await seed({
      type: 'openai',
      baseUrl: OPENAI_BASE,
      structuredOutputMode: 'tool_forcing',
    });
    harness.onFetch(() => toolCallResponse('Plan', { steps: ['via tools'] }));

    const result = await harness.gateway.chat({
      tenantId: TEST_TENANT,
      modelId,
      messages: [{ role: 'user', content: 'plan it' }],
      responseFormat: PLAN_SCHEMA,
    });

    expect(lastBody()['response_format']).toBeUndefined();
    expect(lastBody()['tool_choice']).toEqual({ type: 'function', function: { name: 'Plan' } });
    expect(result.content).toBe('{"steps":["via tools"]}');
  });

  it('refuses an override the provider cannot implement, rather than ignoring it', async () => {
    // Claiming native json_schema on a provider that only has function calling would
    // otherwise be accepted here and then silently dropped on the wire — the caller would
    // get unconstrained prose believing it had asked for a schema.
    const modelId = await seed({
      type: 'groq',
      baseUrl: GROQ_BASE,
      structuredOutputMode: 'json_schema',
    });
    harness.onFetch(() => schemaResponse({ steps: ['native'] }));

    const error = (await harness.gateway
      .chat({
        tenantId: TEST_TENANT,
        modelId,
        messages: [{ role: 'user', content: 'plan it' }],
        responseFormat: PLAN_SCHEMA,
      })
      .catch((e: unknown) => e)) as ApiError;

    expect(error.code).toBe('UNSUPPORTED_CAPABILITY');
    expect(error.message).toContain('cannot decode a JSON schema natively');
    // Refused before the request went out, so nothing was spent.
    expect(harness.calls).toHaveLength(0);
  });

  it('sends nothing extra when the mode is prompt', async () => {
    // A provider with neither mechanism gets the schema described in the prompt by the
    // caller and its output validated afterwards; the request carries no hint at all.
    const modelId = await seed({
      type: 'groq',
      baseUrl: GROQ_BASE,
      structuredOutputMode: 'prompt',
    });
    harness.onFetch(() => schemaResponse({ steps: ['x'] }));

    await harness.gateway.chat({
      tenantId: TEST_TENANT,
      modelId,
      messages: [{ role: 'user', content: 'plan it' }],
      responseFormat: PLAN_SCHEMA,
    });

    expect(lastBody()['response_format']).toBeUndefined();
    expect(lastBody()['tools']).toBeUndefined();
    expect(lastBody()['tool_choice']).toBeUndefined();
  });

  it('does not affect a call that asked for no schema', async () => {
    const modelId = await seed({
      type: 'openai',
      baseUrl: OPENAI_BASE,
      structuredOutputMode: 'tool_forcing',
    });
    harness.onFetch(() => jsonResponse(openAiChatBody({ content: 'plain answer' })));

    const result = await harness.gateway.chat({
      tenantId: TEST_TENANT,
      modelId,
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(lastBody()['response_format']).toBeUndefined();
    expect(lastBody()['tools']).toBeUndefined();
    expect(result.content).toBe('plain answer');
  });
});

// ── streaming ─────────────────────────────────────────────────────────────────

describe('structured output and streaming', () => {
  it('streams a schema-constrained answer on a provider that decodes natively', async () => {
    const modelId = await seed({ type: 'openai', baseUrl: OPENAI_BASE });
    harness.onFetch(() =>
      sseResponse([
        openAiTextFrame('{"steps":'),
        openAiTextFrame('["a"]}'),
        openAiFinishFrame('stop'),
        OPENAI_DONE,
      ]),
    );

    let text = '';
    for await (const chunk of harness.gateway.stream({
      tenantId: TEST_TENANT,
      modelId,
      messages: [{ role: 'user', content: 'plan it' }],
      responseFormat: PLAN_SCHEMA,
    })) {
      if (chunk.type === 'text') text += chunk.text;
    }

    expect(text).toBe('{"steps":["a"]}');
    expect(lastBody()['response_format']).toMatchObject({ type: 'json_schema' });
  });

  it('refuses to stream a schema it cannot constrain', async () => {
    // Tool forcing needs the model to emit a tool call and the arguments withheld until
    // the end — which is not a stream. Returning unconstrained text while the caller
    // believes it asked for a schema would be the worse failure.
    const modelId = await seed({ type: 'groq', baseUrl: GROQ_BASE });

    harness.onFetch(() => sseResponse([openAiTextFrame('ignored'), openAiFinishFrame('stop'), OPENAI_DONE]));

    const error = (await (async () => {
      try {
        for await (const _chunk of harness.gateway.stream({
          tenantId: TEST_TENANT,
          modelId,
          messages: [{ role: 'user', content: 'plan it' }],
          responseFormat: PLAN_SCHEMA,
        })) {
          // drain
        }
        return null;
      } catch (err) {
        return err;
      }
    })()) as ApiError;

    expect(error.code).toBe('UNSUPPORTED_CAPABILITY');
    expect(error.message).toContain('use chat()');
    // Refused before the request went out.
    expect(harness.calls).toHaveLength(0);
  });

  it('still streams normally when no schema was requested', async () => {
    const modelId = await seed({ type: 'groq', baseUrl: GROQ_BASE });
    harness.onFetch(() =>
      sseResponse([openAiTextFrame('prose'), openAiFinishFrame('stop'), OPENAI_DONE]),
    );

    let text = '';
    for await (const chunk of harness.gateway.stream({
      tenantId: TEST_TENANT,
      modelId,
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      if (chunk.type === 'text') text += chunk.text;
    }

    expect(text).toBe('prose');
  });
});

// ── the seam itself ───────────────────────────────────────────────────────────

describe('the caller cannot tell which mechanism was used', () => {
  it('produces an identical result shape on both paths', async () => {
    const nativeId = await seed({ type: 'openai', baseUrl: OPENAI_BASE });
    const forcedId = await seed({
      type: 'groq',
      baseUrl: GROQ_BASE,
      structuredOutputMode: 'tool_forcing',
    });

    const payload = { steps: ['same', 'either', 'way'] };

    harness.onFetch((call: FetchCall) =>
      call.url.startsWith(OPENAI_BASE)
        ? schemaResponse(payload)
        : toolCallResponse('Plan', payload),
    );

    const request = {
      tenantId: TEST_TENANT,
      messages: [{ role: 'user' as const, content: 'plan it' }],
      responseFormat: PLAN_SCHEMA,
    };

    const native = await harness.gateway.chat({ ...request, modelId: nativeId });
    const forced = await harness.gateway.chat({ ...request, modelId: forcedId });

    expect(native.content).toBe(forced.content);
    expect(native.finishReason).toBe(forced.finishReason);
    expect(native.toolCalls).toEqual(forced.toolCalls);
    // Only the identity fields differ, which is the whole point of the seam.
    expect(native.modelId).not.toBe(forced.modelId);
  });
});
