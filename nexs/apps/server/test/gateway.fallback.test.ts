import { beforeEach, describe, expect, it } from 'vitest';
import type { ApiError, StreamChunk } from '@nexs/shared';
import {
  OPENAI_DONE,
  createHarness,
  failingSseResponse,
  jsonResponse,
  openAiChatBody,
  openAiFinishFrame,
  openAiTextFrame,
  openAiUsageFrame,
  sseResponse,
  type FetchCall,
  type Harness,
} from './helpers/gateway-harness.js';

/**
 * Fallback behaviour — the reason `ModelGateway` exists as a seam rather than callers
 * talking to providers directly.
 *
 * The property under test is not "does it retry elsewhere" but "does the caller ever
 * receive a coherent answer that no single model actually produced". The mid-stream
 * cases below are where those two questions come apart.
 */

const A = 'https://a.test/v1';
const B = 'https://b.test/v1';
const C = 'https://c.test/v1';

let harness: Harness;

beforeEach(() => {
  harness = createHarness();
});

function hits(calls: FetchCall[], base: string): FetchCall[] {
  return calls.filter((call) => call.url.startsWith(base));
}

/** Primary on provider A, fallback on provider B, both speaking the OpenAI wire format. */
async function seedPair(): Promise<{ primaryId: string; fallbackId: string }> {
  const providerA = await harness.seedProvider({
    slug: 'primary',
    type: 'openai',
    baseUrl: A,
    apiKey: 'sk-a',
  });
  const providerB = await harness.seedProvider({
    slug: 'secondary',
    type: 'groq',
    baseUrl: B,
    apiKey: 'sk-b',
  });

  const primary = await harness.seedModel({
    providerId: providerA.id,
    externalModelId: 'gpt-4o',
    name: 'primary',
  });
  const fallback = await harness.seedModel({
    providerId: providerB.id,
    externalModelId: 'llama-3.3-70b',
    name: 'secondary',
    fallbackOf: primary.id,
  });

  return { primaryId: primary.id, fallbackId: fallback.id };
}

function okBody(content: string): Response {
  return jsonResponse(openAiChatBody({ content }));
}

function collectText(chunks: StreamChunk[]): string {
  return chunks
    .filter((c): c is Extract<StreamChunk, { type: 'text' }> => c.type === 'text')
    .map((c) => c.text)
    .join('');
}

// ── non-streaming fallback ────────────────────────────────────────────────────

describe('chat — falling back', () => {
  it('serves the request from the next model when the primary refuses', async () => {
    const { primaryId, fallbackId } = await seedPair();

    harness.onFetch((call) =>
      call.url.startsWith(A)
        ? jsonResponse({ error: { message: 'bad key' } }, { status: 401 })
        : okBody('from the fallback'),
    );

    const result = await harness.gateway.chat({
      tenantId: harness.fake.tenants[0]?.id ?? 'tnt_test',
      modelId: primaryId,
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(result.content).toBe('from the fallback');
    expect(result.modelId).toBe(fallbackId);
    // The caller can see which model actually served it, and what was tried first.
    expect(result.attempted).toEqual([primaryId, fallbackId]);
  });

  it('does not attempt a model whose provider is switched off', async () => {
    const { primaryId, fallbackId } = await seedPair();

    const providerB = harness.fake.tables['modelProvider']!.find(
      (row) => row['slug'] === 'secondary',
    )!;
    providerB['enabled'] = false;

    harness.onFetch((call) =>
      call.url.startsWith(A) ? jsonResponse({}, { status: 500 }) : okBody('must not be reached'),
    );

    const error = (await harness.gateway
      .chat({ tenantId: 'tnt_test', modelId: primaryId, messages: [] })
      .catch((e: unknown) => e)) as ApiError;

    // B was never a candidate, so A failing leaves nothing to fall back to.
    expect(error.code).toBe('GATEWAY_FALLBACK_EXHAUSTED');
    expect(hits(harness.calls, B)).toHaveLength(0);
    expect(fallbackId).toBeTruthy();
  });

  it('names the specific fault when nothing ever reached a provider', async () => {
    // A provider type with no adapter is a configuration mistake, not an outage. The
    // operator needs to see that, not "every model in the fallback chain failed".
    const provider = await harness.seedProvider({
      slug: 'unsupported-prov',
      type: 'custom-unsupported' as any,
      baseUrl: C,
    });
    const model = await harness.seedModel({ providerId: provider.id, externalModelId: 'custom-model' });

    harness.onFetch(() => okBody('unreachable'));

    const error = (await harness.gateway
      .chat({ tenantId: 'tnt_test', modelId: model.id, messages: [] })
      .catch((e: unknown) => e)) as ApiError;

    expect(error.code).toBe('UNSUPPORTED_CAPABILITY');
    expect(error.message).toContain('custom-unsupported');
    expect(harness.calls).toHaveLength(0);
  });

  it('reports MODEL_UNAVAILABLE when the requested model is off and nothing can stand in', async () => {
    const provider = await harness.seedProvider({ slug: 'solo', type: 'openai', baseUrl: A });
    const model = await harness.seedModel({ providerId: provider.id, externalModelId: 'm-solo' });
    harness.fake.tables['model']!.find((row) => row['id'] === model.id)!['enabled'] = false;

    const error = (await harness.gateway
      .chat({ tenantId: 'tnt_test', modelId: model.id, messages: [] })
      .catch((e: unknown) => e)) as ApiError;

    // The candidate list came out empty. "Fallback chain exhausted" would send the
    // operator looking for an outage that is not there.
    expect(error.code).toBe('MODEL_UNAVAILABLE');
    expect(error.message).toContain('disabled');
    expect(harness.calls).toHaveLength(0);
  });

  it('reports MODEL_UNAVAILABLE for a model that does not exist', async () => {
    const error = (await harness.gateway
      .chat({ tenantId: 'tnt_test', modelId: 'nope', messages: [] })
      .catch((e: unknown) => e)) as ApiError;

    expect(error.code).toBe('MODEL_UNAVAILABLE');
  });
});

// ── chain resolution ──────────────────────────────────────────────────────────

describe('resolveChain', () => {
  it('walks the fallbackOf chain breadth-first across providers', async () => {
    const pA = await harness.seedProvider({ slug: 'a', type: 'openai', baseUrl: A });
    const pB = await harness.seedProvider({ slug: 'b', type: 'groq', baseUrl: B });
    const pC = await harness.seedProvider({ slug: 'c', type: 'mistral', baseUrl: C });

    const a = await harness.seedModel({ providerId: pA.id, externalModelId: 'm-a', name: 'a' });
    const b = await harness.seedModel({
      providerId: pB.id,
      externalModelId: 'm-b',
      name: 'b',
      fallbackOf: a.id,
    });
    const c = await harness.seedModel({
      providerId: pC.id,
      externalModelId: 'm-c',
      name: 'c',
      fallbackOf: b.id,
    });

    harness.onFetch((call) => {
      if (call.url.startsWith(A)) return jsonResponse({}, { status: 500 });
      if (call.url.startsWith(B)) return jsonResponse({}, { status: 500 });
      return okBody('third time lucky');
    });

    const result = await harness.gateway.chat({
      tenantId: 'tnt_test',
      modelId: a.id,
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(result.modelId).toBe(c.id);
    expect(result.attempted).toEqual([a.id, b.id, c.id]);
  });

  it('lets an explicit fallbackModelIds list replace the chain entirely', async () => {
    const { primaryId } = await seedPair();
    const pC = await harness.seedProvider({ slug: 'c', type: 'mistral', baseUrl: C });
    const unrelated = await harness.seedModel({ providerId: pC.id, externalModelId: 'm-c' });

    harness.onFetch((call) => {
      if (call.url.startsWith(A)) return jsonResponse({}, { status: 500 });
      return okBody('explicit choice');
    });

    const result = await harness.gateway.chat({
      tenantId: 'tnt_test',
      modelId: primaryId,
      messages: [{ role: 'user', content: 'hi' }],
      fallbackModelIds: [unrelated.id],
    });

    expect(result.modelId).toBe(unrelated.id);
    // The `fallbackOf` link was ignored, so B was never contacted.
    expect(hits(harness.calls, B)).toHaveLength(0);
  });

  it('lets a tenant routing override outrank the catalogue default', async () => {
    const { primaryId } = await seedPair();
    const pC = await harness.seedProvider({ slug: 'c', type: 'mistral', baseUrl: C });
    const routed = await harness.seedModel({ providerId: pC.id, externalModelId: 'm-c' });

    await harness.fake.client.gatewayRoute.create({
      data: { tenantId: 'tnt_test', modelId: primaryId, fallbackModelId: routed.id, priority: 5 },
    });

    harness.onFetch((call) => {
      if (call.url.startsWith(A)) return jsonResponse({}, { status: 500 });
      return okBody('routed');
    });

    const result = await harness.gateway.chat({
      tenantId: 'tnt_test',
      modelId: primaryId,
      messages: [{ role: 'user', content: 'hi' }],
    });

    // An operator who configured this route meant it more than the seeded row did, so it
    // is tried before the `fallbackOf` link.
    expect(result.attempted).toEqual([primaryId, routed.id]);
    expect(result.modelId).toBe(routed.id);
  });

  it('skips a model marked unavailable rather than trying and failing it', async () => {
    const pA = await harness.seedProvider({ slug: 'a', type: 'openai', baseUrl: A });
    const pB = await harness.seedProvider({ slug: 'b', type: 'groq', baseUrl: B });
    const pC = await harness.seedProvider({ slug: 'c', type: 'mistral', baseUrl: C });

    const a = await harness.seedModel({ providerId: pA.id, externalModelId: 'm-a', name: 'a' });
    const b = await harness.seedModel({
      providerId: pB.id,
      externalModelId: 'm-b',
      name: 'b',
      fallbackOf: a.id,
    });
    await harness.seedModel({
      providerId: pC.id,
      externalModelId: 'm-c',
      name: 'c',
      fallbackOf: a.id,
    });

    // b is deprecated; both b and c name a as their fallbackOf.
    harness.fake.tables['model']!.find((row) => row['id'] === b.id)!['status'] = 'deprecated';

    harness.onFetch((call) =>
      call.url.startsWith(A) ? jsonResponse({}, { status: 500 }) : okBody('c served'),
    );

    const result = await harness.gateway.chat({
      tenantId: 'tnt_test',
      modelId: a.id,
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(result.attempted).toEqual([a.id, result.modelId]);
    expect(hits(harness.calls, B)).toHaveLength(0);
  });

  it('never mixes another tenant’s models into the chain', async () => {
    const { primaryId } = await seedPair();

    const otherProvider = await harness.seedProvider({
      tenantId: 'tnt_other',
      slug: 'other',
      type: 'openai',
      baseUrl: C,
    });
    await harness.seedModel({
      tenantId: 'tnt_other',
      providerId: otherProvider.id,
      externalModelId: 'gpt-4o',
      name: 'other tenant primary',
      fallbackOf: primaryId,
    });

    harness.onFetch(() => jsonResponse({}, { status: 500 }));

    const error = (await harness.gateway
      .chat({ tenantId: 'tnt_test', modelId: primaryId, messages: [] })
      .catch((e: unknown) => e)) as ApiError;

    expect(error.code).toBe('GATEWAY_FALLBACK_EXHAUSTED');
    expect(hits(harness.calls, C)).toHaveLength(0);
  });
});

// ── streaming fallback: the acceptance test ───────────────────────────────────

describe('stream — the primary dies mid-request', () => {
  it('completes the request from the fallback when the primary dies before emitting', async () => {
    // The plan's acceptance test, read precisely: the primary is killed mid-stream but
    // has produced nothing yet, so there is no partial answer to contradict.
    const { primaryId, fallbackId } = await seedPair();

    harness.onFetch((call) =>
      call.url.startsWith(A)
        ? failingSseResponse([], 0)
        : sseResponse([
            openAiTextFrame('the fallback '),
            openAiTextFrame('answered this'),
            openAiFinishFrame('stop'),
            openAiUsageFrame(11, 4),
            OPENAI_DONE,
          ]),
    );

    const chunks: StreamChunk[] = [];
    let selected: { modelId: string; providerId: string } | null = null;

    for await (const chunk of harness.gateway.stream({
      tenantId: 'tnt_test',
      modelId: primaryId,
      messages: [{ role: 'user', content: 'hi' }],
      onModelSelected: (info) => {
        selected = info;
      },
    })) {
      chunks.push(chunk);
    }

    expect(collectText(chunks)).toBe('the fallback answered this');
    expect(selected).toEqual({
      modelId: fallbackId,
      providerId: harness.fake.tables['model']!.find((r) => r['id'] === fallbackId)!['providerId'],
    });
    expect(hits(harness.calls, A)).toHaveLength(1);
    expect(hits(harness.calls, B)).toHaveLength(1);
  });

  it('refuses to fall back once content has reached the client', async () => {
    // The dangerous case. A second model here would splice its opening onto the first
    // model's half-sentence and present the join as one answer — a transcript that
    // never happened, with no way for the user to tell.
    const { primaryId } = await seedPair();

    harness.onFetch((call) =>
      call.url.startsWith(A)
        ? failingSseResponse([openAiTextFrame('The answer is 4')], 1)
        : sseResponse([openAiTextFrame(' totally different'), OPENAI_DONE]),
    );

    const chunks: StreamChunk[] = [];
    const error = (await (async () => {
      try {
        for await (const chunk of harness.gateway.stream({
          tenantId: 'tnt_test',
          modelId: primaryId,
          messages: [{ role: 'user', content: 'hi' }],
        })) {
          chunks.push(chunk);
        }
        return null;
      } catch (err) {
        return err;
      }
    })()) as ApiError;

    // The partial text was delivered...
    expect(collectText(chunks)).toBe('The answer is 4');
    // ...and then the call failed loudly instead of silently becoming a different answer.
    expect(error.code).toBe('PROVIDER_ERROR');
    expect(error.message).toContain('refusing to fall back');

    // The decisive assertion: the fallback was never contacted.
    expect(hits(harness.calls, A)).toHaveLength(1);
    expect(hits(harness.calls, B)).toHaveLength(0);
  });

  it('passes usage through as a chunk but does not forward it as text', async () => {
    const { primaryId } = await seedPair();

    harness.onFetch(() =>
      sseResponse([
        openAiTextFrame('hi'),
        openAiUsageFrame(9, 3),
        openAiFinishFrame('stop'),
        OPENAI_DONE,
      ]),
    );

    const chunks: StreamChunk[] = [];
    for await (const chunk of harness.gateway.stream({
      tenantId: 'tnt_test',
      modelId: primaryId,
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      chunks.push(chunk);
    }

    // The gateway consumes `usage` internally to write the ModelUsage row, so the caller
    // only ever sees text and a terminal done.
    expect(chunks.map((c) => c.type)).toEqual(['text', 'done']);
    expect(harness.fake.tables['modelUsage']).toHaveLength(1);
  });

  it('records usage exactly once, on the model that finished', async () => {
    const { primaryId, fallbackId } = await seedPair();

    harness.onFetch((call) =>
      call.url.startsWith(A)
        ? failingSseResponse([], 0)
        : sseResponse([
            openAiTextFrame('ok'),
            openAiUsageFrame(20, 5),
            openAiFinishFrame('stop'),
            OPENAI_DONE,
          ]),
    );

    for await (const _chunk of harness.gateway.stream({
      tenantId: 'tnt_test',
      modelId: primaryId,
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      // drain
    }

    const usage = harness.fake.tables['modelUsage']!;
    expect(usage).toHaveLength(1);
    expect(usage[0]!['modelId']).toBe(fallbackId);
    expect(usage[0]!['promptTokens']).toBe(20);
    expect(usage[0]!['completionTokens']).toBe(5);
  });

  it('surfaces the specific fault when every candidate fails before reaching a provider', async () => {
    const provider = await harness.seedProvider({
      slug: 'unsupported-prov',
      type: 'custom-unsupported' as any,
      baseUrl: C,
    });
    const model = await harness.seedModel({ providerId: provider.id, externalModelId: 'custom-model' });

    const error = (await (async () => {
      try {
        for await (const _chunk of harness.gateway.stream({
          tenantId: 'tnt_test',
          modelId: model.id,
          messages: [],
        })) {
          // drain
        }
        return null;
      } catch (err) {
        return err;
      }
    })()) as ApiError;

    expect(error.code).toBe('UNSUPPORTED_CAPABILITY');
  });
});

// ── the exhaustion message ────────────────────────────────────────────────────

/**
 * `fallbackModelIds: []` is what the chat path sends, because a turn must run on exactly the
 * model the user chose. That makes the chain one model long — and "every model in the fallback
 * chain failed" then names a chain that does not exist, sending the reader hunting for
 * fallbacks they deliberately turned off. The message has to match the chain it describes.
 */
describe('the exhaustion message', () => {
  it('names the single pinned model rather than a chain that does not exist', async () => {
    const { primaryId } = await seedPair();

    harness.onFetch(() => jsonResponse({ error: { message: 'bad key' } }, { status: 401 }));

    const error = (await harness.gateway
      .chat({
        tenantId: 'tnt_test',
        modelId: primaryId,
        messages: [{ role: 'user', content: 'hi' }],
        fallbackModelIds: [],
      })
      .catch((e: unknown) => e)) as ApiError;

    expect(error.code).toBe('GATEWAY_FALLBACK_EXHAUSTED');
    expect(error.message).toBe('The model primary failed');
    expect(error.message).not.toContain('fallback chain');
    // The pinned list was honoured: the `fallbackOf` model on B was never a candidate.
    expect(hits(harness.calls, B)).toHaveLength(0);
  });

  it('says the same thing on the streaming path, which is the one chat actually uses', async () => {
    const { primaryId } = await seedPair();

    harness.onFetch(() => jsonResponse({ error: { message: 'bad key' } }, { status: 401 }));

    const error = (await (async () => {
      try {
        for await (const _chunk of harness.gateway.stream({
          tenantId: 'tnt_test',
          modelId: primaryId,
          messages: [{ role: 'user', content: 'hi' }],
          fallbackModelIds: [],
        })) {
          // drain
        }
        return null;
      } catch (err) {
        return err;
      }
    })()) as ApiError;

    expect(error.code).toBe('GATEWAY_FALLBACK_EXHAUSTED');
    expect(error.message).toBe('The model primary failed');
  });

  it('still names the chain when there really is one', async () => {
    const { primaryId } = await seedPair();

    harness.onFetch(() => jsonResponse({ error: { message: 'bad key' } }, { status: 401 }));

    const error = (await harness.gateway
      .chat({ tenantId: 'tnt_test', modelId: primaryId, messages: [{ role: 'user', content: 'hi' }] })
      .catch((e: unknown) => e)) as ApiError;

    expect(error.code).toBe('GATEWAY_FALLBACK_EXHAUSTED');
    expect(error.message).toContain('Every model in the fallback chain failed (tried 2: primary, secondary)');
  });
});

// ── embeddings ────────────────────────────────────────────────────────────────

describe('embed', () => {
  it('returns vectors and records usage', async () => {
    const provider = await harness.seedProvider({ slug: 'openai', type: 'openai', baseUrl: A });
    const model = await harness.seedModel({
      providerId: provider.id,
      externalModelId: 'text-embedding-3-small',
      type: 'embedding',
      pricing: { inputPer1kTokens: 0.02, outputPer1kTokens: 0 },
    });

    harness.onFetch(() =>
      jsonResponse({
        data: [{ embedding: [0.1, 0.2, 0.3] }],
        usage: { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 },
      }),
    );

    const result = await harness.gateway.embed({
      tenantId: 'tnt_test',
      modelId: model.id,
      input: ['hello'],
    });

    expect(result.vectors).toEqual([[0.1, 0.2, 0.3]]);
    expect(result.modelId).toBe(model.id);
    expect(harness.fake.tables['modelUsage']).toHaveLength(1);
  });

  it('refuses an embedding model on a provider that has no embeddings endpoint', async () => {
    const provider = await harness.seedProvider({ slug: 'anthropic', type: 'anthropic', baseUrl: B });
    const model = await harness.seedModel({
      providerId: provider.id,
      externalModelId: 'claude-sonnet',
      type: 'embedding',
    });

    const error = (await harness.gateway
      .embed({ tenantId: 'tnt_test', modelId: model.id, input: ['x'] })
      .catch((e: unknown) => e)) as ApiError;

    expect(error.code).toBe('UNSUPPORTED_CAPABILITY');
    expect(harness.calls).toHaveLength(0);
  });
});
