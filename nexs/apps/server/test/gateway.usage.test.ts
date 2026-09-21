import { beforeEach, describe, expect, it } from 'vitest';
import { computeCost } from '@nexs/shared';
import {
  TEST_TENANT,
  createHarness,
  jsonResponse,
  openAiChatBody,
  openAiFinishFrame,
  openAiTextFrame,
  openAiUsageFrame,
  sseResponse,
  OPENAI_DONE,
  type Harness,
} from './helpers/gateway-harness.js';

/**
 * The accounting rule, tested at the level the dashboard depends on.
 *
 * The plan's acceptance criterion for this phase is: *`SELECT sum(prompt_tokens) FROM
 * "ModelUsage"` matches what the UI displays*. That is only a meaningful test if the
 * number on screen is read back out of the table — so the assertions below recompute the
 * SQL aggregate by hand from the rows and compare it to what the repository reports.
 *
 * There are no in-memory counters in the model layer, on purpose. A counter would be
 * lost on restart, would differ between worker processes, and could not be reproduced
 * with a query.
 */

const A = 'https://a.test/v1';

let harness: Harness;

beforeEach(() => {
  harness = createHarness();
});

interface Seeded {
  providerId: string;
  modelId: string;
}

async function seed(options: { pricing?: { inputPer1kTokens: number; outputPer1kTokens: number } } = {}): Promise<Seeded> {
  const provider = await harness.seedProvider({ slug: 'a', type: 'openai', baseUrl: A });
  const model = await harness.seedModel({
    providerId: provider.id,
    externalModelId: 'gpt-4o',
    ...(options.pricing === undefined ? {} : { pricing: options.pricing }),
  });
  return { providerId: provider.id, modelId: model.id };
}

/** The `SELECT sum(prompt_tokens) ...` the acceptance test asks for, done by hand. */
function sqlSum(column: string, tenantId = TEST_TENANT): number {
  return harness.fake.tables['modelUsage']!
    .filter((row) => row['tenantId'] === tenantId)
    .reduce((total, row) => total + ((row[column] as number | undefined) ?? 0), 0);
}

// ── the cost formula ──────────────────────────────────────────────────────────

describe('computeCost', () => {
  it('prices input and output separately', () => {
    const pricing = { inputPer1kTokens: 2.5, outputPer1kTokens: 10 };
    expect(
      computeCost(pricing, { promptTokens: 1_000, completionTokens: 500, totalTokens: 1_500 }),
    ).toBe(7.5);
  });

  it('returns zero rather than NaN when the model has no price snapshot', () => {
    // A model synced before pricing was captured must not poison every aggregate with NaN.
    expect(
      computeCost(undefined, { promptTokens: 1_000, completionTokens: 1_000, totalTokens: 2_000 }),
    ).toBe(0);
  });

  it('rounds to six decimals so sub-cent noise does not accumulate', () => {
    const cost = computeCost(
      { inputPer1kTokens: 0.15, outputPer1kTokens: 0.6 },
      { promptTokens: 1_234, completionTokens: 567, totalTokens: 1_801 },
    );
    expect(cost).toBe(0.5253);
    expect(String(cost).length).toBeLessThan(10);
  });

  it('is free for a local model priced at zero', () => {
    expect(
      computeCost(
        { inputPer1kTokens: 0, outputPer1kTokens: 0 },
        { promptTokens: 99_999, completionTokens: 99_999, totalTokens: 199_998 },
      ),
    ).toBe(0);
  });
});

// ── what a call records ───────────────────────────────────────────────────────

describe('recording a chat call', () => {
  it('writes one row with the provider’s own token counts', async () => {
    const { providerId, modelId } = await seed();
    harness.onFetch(() =>
      jsonResponse(
        openAiChatBody({ content: 'hi', promptTokens: 1_200, completionTokens: 340 }),
      ),
    );

    const result = await harness.gateway.chat({
      tenantId: TEST_TENANT,
      modelId,
      messages: [{ role: 'user', content: 'hi' }],
    });

    const rows = harness.fake.tables['modelUsage']!;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenantId: TEST_TENANT,
      modelId,
      providerId,
      promptTokens: 1_200,
      completionTokens: 340,
      totalTokens: 1_540,
      cached: false,
      runId: null,
      stepId: null,
    });
    expect(result.usage).toEqual({ promptTokens: 1_200, completionTokens: 340, totalTokens: 1_540 });
  });

  it('uses the provider’s usage, not its own estimate', async () => {
    // The gateway estimates tokens to decide when to shrink a prompt. That estimate must
    // never reach the billing table — only the provider's own count is authoritative.
    const { modelId } = await seed();
    const longPrompt = 'x'.repeat(4_000);

    harness.onFetch(() => jsonResponse(openAiChatBody({ promptTokens: 7, completionTokens: 2 })));

    await harness.gateway.chat({
      tenantId: TEST_TENANT,
      modelId,
      messages: [{ role: 'user', content: longPrompt }],
    });

    const row = harness.fake.tables['modelUsage']![0]!;
    expect(row['promptTokens']).toBe(7);
    expect(row['promptTokens']).not.toBe(1_000);
  });

  it('computes the cost from the model’s stored price snapshot', async () => {
    const { modelId } = await seed({ pricing: { inputPer1kTokens: 2.5, outputPer1kTokens: 10 } });
    harness.onFetch(() =>
      jsonResponse(openAiChatBody({ promptTokens: 1_000, completionTokens: 500 })),
    );

    const result = await harness.gateway.chat({
      tenantId: TEST_TENANT,
      modelId,
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(result.costEstimate).toBe(7.5);
    expect(harness.fake.tables['modelUsage']![0]!['costEstimate']).toBe(7.5);
  });

  it('records zero cost for a model with no price snapshot', async () => {
    const { modelId } = await seed();
    harness.onFetch(() => jsonResponse(openAiChatBody({ promptTokens: 500, completionTokens: 500 })));

    const result = await harness.gateway.chat({
      tenantId: TEST_TENANT,
      modelId,
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(result.costEstimate).toBe(0);
    expect(harness.fake.tables['modelUsage']![0]!['costEstimate']).toBe(0);
  });

  it('measures latency against the injected clock', async () => {
    const { modelId } = await seed();

    // The harness's clock is the only clock the gateway sees, so a simulated 250 ms
    // provider round trip is measurable without actually waiting.
    harness.onFetch(() => {
      harness.advance(250);
      return jsonResponse(openAiChatBody({ content: 'hi' }));
    });

    await harness.gateway.chat({
      tenantId: TEST_TENANT,
      modelId,
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(harness.fake.tables['modelUsage']![0]!['latencyMs']).toBe(250);
  });

  it('attributes the row to a run and step when the engine supplies them', async () => {
    const { modelId } = await seed();
    harness.onFetch(() => jsonResponse(openAiChatBody({ content: 'hi' })));

    await harness.gateway.chat({
      tenantId: TEST_TENANT,
      modelId,
      messages: [{ role: 'user', content: 'hi' }],
      runId: 'run_1',
      stepId: 'step_1',
    });

    expect(harness.fake.tables['modelUsage']![0]).toMatchObject({
      runId: 'run_1',
      stepId: 'step_1',
    });
  });

  it('records a failed call as nothing at all, rather than as zero tokens', async () => {
    const { modelId } = await seed();
    harness.onFetch(() => jsonResponse({}, { status: 500 }));

    await harness.gateway
      .chat({ tenantId: TEST_TENANT, modelId, messages: [] })
      .catch(() => null);

    // A row of zeroes would be indistinguishable from a real call that used no tokens,
    // and would inflate the call count on the dashboard.
    expect(harness.fake.tables['modelUsage']).toHaveLength(0);
  });

  it('records a streaming call once, when it completes', async () => {
    const { modelId } = await seed({ pricing: { inputPer1kTokens: 1, outputPer1kTokens: 2 } });
    harness.onFetch(() =>
      sseResponse([
        openAiTextFrame('a'),
        openAiTextFrame('b'),
        openAiUsageFrame(300, 100),
        openAiFinishFrame('stop'),
        OPENAI_DONE,
      ]),
    );

    for await (const _chunk of harness.gateway.stream({
      tenantId: TEST_TENANT,
      modelId,
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      // drain
    }

    const rows = harness.fake.tables['modelUsage']!;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ promptTokens: 300, completionTokens: 100, totalTokens: 400 });
    expect(rows[0]!['costEstimate']).toBe(0.5);
  });

  it('records nothing when a stream is cut off before completing', async () => {
    const { modelId } = await seed();
    // Text arrives, then the stream closes without a finish reason — a truncated answer.
    harness.onFetch(() => sseResponse([openAiTextFrame('partial')]));

    const error = await (async () => {
      try {
        for await (const _chunk of harness.gateway.stream({
          tenantId: TEST_TENANT,
          modelId,
          messages: [{ role: 'user', content: 'hi' }],
        })) {
          // drain
        }
        return null;
      } catch (err) {
        return err;
      }
    })();

    // No `done` chunk was ever reached, so no usage was reported. Inventing a row of
    // zeroes here would claim the call was free, which is worse than not counting it.
    expect(error).not.toBeNull();
    expect(harness.fake.tables['modelUsage']).toHaveLength(0);
  });
});

// ── the acceptance test ───────────────────────────────────────────────────────

describe('aggregates reproduce with SQL', () => {
  it('reports the same prompt-token total the rows add up to', async () => {
    const { modelId } = await seed({ pricing: { inputPer1kTokens: 1, outputPer1kTokens: 1 } });

    const prompts = [1_000, 2_500, 17];
    let call = 0;
    harness.onFetch(() => {
      const promptTokens = prompts[call] ?? 0;
      call += 1;
      return jsonResponse(openAiChatBody({ promptTokens, completionTokens: 10 }));
    });

    for (let i = 0; i < prompts.length; i += 1) {
      await harness.gateway.chat({
        tenantId: TEST_TENANT,
        modelId,
        messages: [{ role: 'user', content: 'hi' }],
      });
    }

    const totals = await harness.usage.totalsForTenant(TEST_TENANT);

    // The dashboard number, recomputed from the table.
    expect(totals.promptTokens).toBe(sqlSum('promptTokens'));
    expect(totals.promptTokens).toBe(3_517);
    expect(totals.completionTokens).toBe(sqlSum('completionTokens'));
    expect(totals.totalTokens).toBe(sqlSum('totalTokens'));
    expect(totals.costEstimate).toBe(sqlSum('costEstimate'));
    expect(totals.calls).toBe(3);
    expect(harness.fake.tables['modelUsage']).toHaveLength(3);
  });

  it('returns zeroes for a tenant that has spent nothing', async () => {
    const totals = await harness.usage.totalsForTenant('tnt_quiet');

    expect(totals).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costEstimate: 0,
      calls: 0,
    });
  });

  it('breaks usage down by provider', async () => {
    const pA = await harness.seedProvider({ slug: 'a', type: 'openai', baseUrl: A });
    const pB = await harness.seedProvider({ slug: 'b', type: 'groq', baseUrl: 'https://b.test/v1' });
    const a = await harness.seedModel({ providerId: pA.id, externalModelId: 'm-a' });
    const b = await harness.seedModel({ providerId: pB.id, externalModelId: 'm-b' });

    harness.onFetch((call) =>
      jsonResponse(
        openAiChatBody({ promptTokens: call.url.startsWith(A) ? 100 : 200, completionTokens: 10 }),
      ),
    );

    await harness.gateway.chat({ tenantId: TEST_TENANT, modelId: a.id, messages: [] });
    await harness.gateway.chat({ tenantId: TEST_TENANT, modelId: b.id, messages: [] });

    const byProvider = await harness.usage.totalsByProvider(TEST_TENANT);
    const found = Object.fromEntries(byProvider.map((row) => [row.providerId, row]));

    expect(found[pA.id]).toMatchObject({ promptTokens: 100, calls: 1 });
    expect(found[pB.id]).toMatchObject({ promptTokens: 200, calls: 1 });
    // And the parts add up to the whole, which is what a dashboard drill-down assumes.
    const totals = await harness.usage.totalsForTenant(TEST_TENANT);
    expect(byProvider.reduce((sum, row) => sum + row.promptTokens, 0)).toBe(totals.promptTokens);
  });

  it('scopes totals to a single run', async () => {
    const { modelId } = await seed();
    harness.onFetch(() => jsonResponse(openAiChatBody({ promptTokens: 50, completionTokens: 5 })));

    await harness.gateway.chat({ tenantId: TEST_TENANT, modelId, messages: [], runId: 'run_a' });
    await harness.gateway.chat({ tenantId: TEST_TENANT, modelId, messages: [], runId: 'run_a' });
    await harness.gateway.chat({ tenantId: TEST_TENANT, modelId, messages: [], runId: 'run_b' });

    expect(await harness.usage.totalsForRun(TEST_TENANT, 'run_a')).toMatchObject({
      promptTokens: 100,
      calls: 2,
    });
    expect(await harness.usage.totalsForRun(TEST_TENANT, 'run_b')).toMatchObject({
      promptTokens: 50,
      calls: 1,
    });
  });

  it('scopes totals to a single model', async () => {
    const pA = await harness.seedProvider({ slug: 'a', type: 'openai', baseUrl: A });
    const a = await harness.seedModel({ providerId: pA.id, externalModelId: 'm-a' });
    const b = await harness.seedModel({ providerId: pA.id, externalModelId: 'm-b' });

    harness.onFetch(() => jsonResponse(openAiChatBody({ promptTokens: 33, completionTokens: 1 })));

    await harness.gateway.chat({ tenantId: TEST_TENANT, modelId: a.id, messages: [] });
    await harness.gateway.chat({ tenantId: TEST_TENANT, modelId: b.id, messages: [] });

    expect(await harness.usage.totalsForModel(TEST_TENANT, a.id)).toMatchObject({ promptTokens: 33 });
    expect(await harness.usage.totalsForModel(TEST_TENANT, b.id)).toMatchObject({ promptTokens: 33 });
  });

  it('never leaks another tenant’s usage into a total', async () => {
    const { modelId } = await seed();

    // A second tenant with its own provider and model. The same model id cannot be reused
    // because `findById` takes the tenant first and would (correctly) not find it.
    const otherProvider = await harness.seedProvider({
      tenantId: 'tnt_other',
      slug: 'a',
      type: 'openai',
      baseUrl: A,
    });
    const otherModel = await harness.seedModel({
      tenantId: 'tnt_other',
      providerId: otherProvider.id,
      externalModelId: 'gpt-4o',
    });

    harness.onFetch(() => jsonResponse(openAiChatBody({ promptTokens: 900, completionTokens: 1 })));

    await harness.gateway.chat({ tenantId: TEST_TENANT, modelId, messages: [] });
    await harness.gateway.chat({ tenantId: 'tnt_other', modelId: otherModel.id, messages: [] });

    // Tenant isolation is the first argument of the method and appears in the where, so
    // neither total can see the other's row.
    expect(await harness.usage.totalsForTenant(TEST_TENANT)).toMatchObject({
      promptTokens: 900,
      calls: 1,
    });
    expect(await harness.usage.totalsForTenant('tnt_other')).toMatchObject({
      promptTokens: 900,
      calls: 1,
    });
    expect(harness.fake.tables['modelUsage']).toHaveLength(2);
  });

  it('lists recent usage newest first', async () => {
    const { modelId } = await seed();

    let call = 0;
    harness.onFetch(() => {
      call += 1;
      return jsonResponse(openAiChatBody({ promptTokens: call, completionTokens: 1 }));
    });

    await harness.gateway.chat({ tenantId: TEST_TENANT, modelId, messages: [] });
    await harness.gateway.chat({ tenantId: TEST_TENANT, modelId, messages: [] });

    // Both rows landed in the same millisecond, so their `createdAt` values tie. Give
    // them distinct stamps to assert the ordering rule itself rather than the tie-break.
    const rows = harness.fake.tables['modelUsage']!;
    rows[0]!['createdAt'] = new Date('2026-01-01T00:00:00.000Z');
    rows[1]!['createdAt'] = new Date('2026-01-01T00:00:01.000Z');

    const recent = await harness.usage.recent(TEST_TENANT);
    expect(recent.map((row) => row['promptTokens'])).toEqual([2, 1]);
  });

  it('returns a stable order when rows tie on timestamp', async () => {
    const { modelId } = await seed();
    harness.onFetch(() => jsonResponse(openAiChatBody({ promptTokens: 1, completionTokens: 1 })));

    for (let i = 0; i < 3; i += 1) {
      await harness.gateway.chat({ tenantId: TEST_TENANT, modelId, messages: [] });
    }

    // Postgres may return tied rows in any order, which would make a paginated dashboard
    // list shuffle between reloads. The id breaks the tie, so two reads agree.
    const first = (await harness.usage.recent(TEST_TENANT)).map((row) => row['id']);
    const second = (await harness.usage.recent(TEST_TENANT)).map((row) => row['id']);

    expect(first).toHaveLength(3);
    expect(second).toEqual(first);
  });

  it('counts a retried call once, not once per attempt', async () => {
    const { modelId } = await seed();

    let attempt = 0;
    harness.onFetch(() => {
      attempt += 1;
      return attempt === 1
        ? jsonResponse({}, { status: 503 })
        : jsonResponse(openAiChatBody({ promptTokens: 10, completionTokens: 1 }));
    });

    await harness.gateway.chat({ tenantId: TEST_TENANT, modelId, messages: [] });

    // Two HTTP requests, one billed call. The retry is an implementation detail of the
    // gateway, not a second unit of work the customer performed.
    expect(harness.calls).toHaveLength(2);
    expect(harness.fake.tables['modelUsage']).toHaveLength(1);
  });
});
