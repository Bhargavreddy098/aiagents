import { afterEach, describe, expect, it } from 'vitest';
import { createEngineHarness, TEST_TENANT, type EngineHarness } from './helpers/engine-harness.js';
import { SEARCH_TOOL_NAME, type NativeToolContext } from '../src/services/tools/native-tools.js';
import type { SearchPort, SearchQuery, SearchResult } from '../src/services/search/search-provider.js';

/**
 * The `web_search` native tool (spec §3.6).
 *
 * The spec's tool table entry is exact, so the assertions here are too:
 *
 *   | `web_search` | `{ query: string; maxResults?: number }` | `{ results: { title, url, snippet }[] }` | search, external_side_effect |
 *
 * Two things are worth more than the mapping. First, **registration is conditional**: a deployment
 * with no provider must not offer the tool at all, because a model that is offered a tool will use
 * it, and one that always fails burns a run's steps discovering what the config already knew.
 * Second, a provider failure must **propagate**. Returning `{ results: [] }` for a 401 would make
 * the model conclude the web has nothing to say about the question — a wrong answer where an error
 * was the truth.
 *
 * The provider is a recorded stand-in rather than a fake `fetch`, because what is under test is the
 * tool's own contract. The adapter's wire format is `search-provider.test.ts`'s subject.
 */

interface RecordingSearch {
  port: SearchPort;
  queries: SearchQuery[];
  /** What the next `search` returns. */
  results: SearchResult[];
  /** When set, the next `search` rejects with this. */
  failure: Error | null;
}

function recordingSearch(): RecordingSearch {
  const queries: SearchQuery[] = [];
  const recorder: RecordingSearch = {
    queries,
    results: [],
    failure: null,
    port: {
      name: 'recording',
      search: async (request) => {
        queries.push(request);
        if (recorder.failure !== null) throw recorder.failure;
        return recorder.results;
      },
    },
  };
  return recorder;
}

function ctx(): NativeToolContext {
  return { tenantId: TEST_TENANT, runId: 'run-1', stepId: 'step-1', agentId: null };
}

let harness: EngineHarness | undefined;

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

async function boot(search?: SearchPort): Promise<EngineHarness> {
  harness = await createEngineHarness(search === undefined ? {} : { search });
  return harness;
}

describe('web_search — registration', () => {
  it('is absent when the deployment has no search provider', async () => {
    const h = await boot();

    expect(h.nativeTools.has(SEARCH_TOOL_NAME)).toBe(false);
    expect(h.nativeTools.list().map((tool) => tool.name)).not.toContain(SEARCH_TOOL_NAME);
  });

  it('is present when a provider is supplied', async () => {
    const h = await boot(recordingSearch().port);

    expect(h.nativeTools.has(SEARCH_TOOL_NAME)).toBe(true);
    const descriptor = h.nativeTools.list().find((tool) => tool.name === SEARCH_TOOL_NAME);
    expect(descriptor).toBeDefined();
  });

  it('declares the spec\'s argument shape', async () => {
    const h = await boot(recordingSearch().port);
    const descriptor = h.nativeTools.list().find((tool) => tool.name === SEARCH_TOOL_NAME);

    expect(descriptor?.inputSchema).toMatchObject({
      type: 'object',
      required: ['query'],
      additionalProperties: false,
      properties: { query: { type: 'string' }, maxResults: { type: 'number' } },
    });
  });

  it('reports the spec\'s capabilities, including the side effect', async () => {
    const h = await boot(recordingSearch().port);

    // `external_side_effect` is the spec's own classification and it is not decoration: the query
    // leaves the deployment and reaches a third party, and what the tenant asked is information.
    expect(h.nativeTools.capabilitiesFor(SEARCH_TOOL_NAME, { query: 'anything' })).toEqual([
      'search',
      'external_side_effect',
    ]);
  });
});

describe('web_search — invocation', () => {
  it('returns the spec\'s result shape and names the provider', async () => {
    const search = recordingSearch();
    search.results = [
      { title: 'EU AI Act', url: 'https://example.eu/ai-act', snippet: 'Obligations…' },
      { title: 'Timeline', url: 'https://example.eu/timeline', snippet: 'Dates…' },
    ];
    const h = await boot(search.port);

    const result = (await h.nativeTools.execute(SEARCH_TOOL_NAME, { query: 'EU AI Act' }, ctx())) as {
      query: string;
      provider: string;
      results: SearchResult[];
    };

    expect(result.results).toEqual([
      { title: 'EU AI Act', url: 'https://example.eu/ai-act', snippet: 'Obligations…' },
      { title: 'Timeline', url: 'https://example.eu/timeline', snippet: 'Dates…' },
    ]);
    expect(result.query).toBe('EU AI Act');
    // The provider is reported so a run that cites a source can say how it found it.
    expect(result.provider).toBe('recording');
  });

  it('passes the query through and omits maxResults when the model did not ask', async () => {
    const search = recordingSearch();
    const h = await boot(search.port);

    await h.nativeTools.execute(SEARCH_TOOL_NAME, { query: 'a question' }, ctx());

    expect(search.queries).toHaveLength(1);
    expect(search.queries[0]!.query).toBe('a question');
    expect(search.queries[0]!.maxResults).toBeUndefined();
  });

  it('passes maxResults through to the provider, which is what clamps it', async () => {
    const search = recordingSearch();
    const h = await boot(search.port);

    await h.nativeTools.execute(SEARCH_TOOL_NAME, { query: 'q', maxResults: 3 }, ctx());

    // The tool does not clamp; the adapter does, against the deployment ceiling. Clamping in two
    // places would mean two answers to "how many results is too many".
    expect(search.queries[0]!.maxResults).toBe(3);
  });

  it('refuses a missing or empty query', async () => {
    const search = recordingSearch();
    const h = await boot(search.port);

    await expect(h.nativeTools.execute(SEARCH_TOOL_NAME, {}, ctx())).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await expect(h.nativeTools.execute(SEARCH_TOOL_NAME, { query: '' }, ctx())).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    expect(search.queries).toHaveLength(0);
  });

  it('refuses a non-string query rather than coercing it', async () => {
    const h = await boot(recordingSearch().port);

    await expect(
      h.nativeTools.execute(SEARCH_TOOL_NAME, { query: 42 }, ctx()),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('propagates a provider failure instead of reporting an empty result set', async () => {
    const search = recordingSearch();
    search.failure = new Error('the provider returned 401');
    const h = await boot(search.port);

    // The distinction that matters: "the search failed" and "the web says nothing" are different
    // answers, and only one of them is true here.
    await expect(
      h.nativeTools.execute(SEARCH_TOOL_NAME, { query: 'q' }, ctx()),
    ).rejects.toThrow('the provider returned 401');
  });

  it('returns an empty result list when the provider genuinely found nothing', async () => {
    const search = recordingSearch();
    search.results = [];
    const h = await boot(search.port);

    const result = (await h.nativeTools.execute(SEARCH_TOOL_NAME, { query: 'q' }, ctx())) as {
      results: unknown[];
    };

    expect(result.results).toEqual([]);
  });

  it('reaches the provider through the tool invoker the engine uses', async () => {
    const search = recordingSearch();
    search.results = [{ title: 't', url: 'https://e.eu/a', snippet: 's' }];
    const h = await boot(search.port);

    // Seeded as a tenant tool so the invoker resolves it to the native handler, which is the path
    // a real step takes. `invoke` takes the row id, not the name — the row is what the planner was
    // offered, and the id is what a plan step carries.
    const tool = await h.seedTool({ name: SEARCH_TOOL_NAME, source: 'builtin' });

    const outcome = await h.invoker.invoke({
      tenantId: TEST_TENANT,
      runId: 'run-1',
      stepId: 'step-1',
      agentId: null,
      toolId: tool.id,
      args: { query: 'through the invoker' },
    });

    expect(outcome.ok).toBe(true);
    expect(search.queries[0]!.query).toBe('through the invoker');
  });
});
