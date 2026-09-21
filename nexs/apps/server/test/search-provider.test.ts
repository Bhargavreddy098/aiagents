import { describe, expect, it } from 'vitest';
import type { Logger } from '../src/logger.js';
import {
  BraveSearchProvider,
  createSearchProvider,
  parseBraveResults,
  type SearchProviderConfig,
} from '../src/services/search/search-provider.js';
import type { FetchLike } from '../src/services/gateway/adapters/types.js';

/**
 * The search provider seam (spec §3.6 — `web_search`).
 *
 * The provider is a third party, so this file is about the boundary: what is sent, what is
 * tolerated on the way back, and — most importantly — what happens when the deployment has no
 * provider at all. That last case is the one that keeps `web_search` from being offered to a model
 * that can only fail with it.
 *
 * The `fetch` is injected everywhere. There is no outbound network on this machine, and there does
 * not need to be: the adapter's whole job is translating between the vendor's wire format and a
 * neutral shape, and that translation is exactly what a fake `fetch` pins.
 */

const BASE_CONFIG: SearchProviderConfig = {
  provider: 'brave',
  apiKey: 'test-key',
  baseUrl: 'https://api.search.brave.com',
  defaultMaxResults: 5,
  maxResultsCeiling: 20,
  timeoutMs: 15_000,
  maxResponseBytes: 512 * 1024,
};

function recordingLogger(): { logger: Logger; warnings: unknown[] } {
  const warnings: unknown[] = [];
  const logger = {
    warn: (...args: unknown[]) => warnings.push(args),
    info: () => undefined,
    debug: () => undefined,
    error: () => undefined,
  } as unknown as Logger;
  return { logger, warnings };
}

function braveBody(results: Array<Record<string, unknown>>): string {
  return JSON.stringify({ web: { results } });
}

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: { 'content-type': 'application/json' },
  });
}

/** A `fetch` that records what it was called with and replies with one canned response. */
function stubFetch(response: Response | Error): { fetch: FetchLike; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), ...(init === undefined ? {} : { init }) });
    if (response instanceof Error) throw response;
    return response.clone();
  }) as unknown as FetchLike;
  return { fetch, calls };
}

describe('createSearchProvider', () => {
  it('returns nothing when no provider is configured', () => {
    const { logger } = recordingLogger();

    const provider = createSearchProvider(
      { ...BASE_CONFIG, provider: 'none', apiKey: null },
      { fetch: stubFetch(jsonResponse('{}')).fetch, logger },
    );

    // Not an error, and not a stub: absent. `NativeToolRegistry` registers `web_search` only when
    // this is a real object, so `none` means the tool does not exist in this deployment.
    expect(provider).toBeUndefined();
  });

  it('degrades to no provider when a provider is named without a key', () => {
    const { logger, warnings } = recordingLogger();

    const provider = createSearchProvider(
      { ...BASE_CONFIG, apiKey: null },
      { fetch: stubFetch(jsonResponse('{}')).fetch, logger },
    );

    expect(provider).toBeUndefined();
    // It warns rather than throwing: search is optional, and refusing to boot an API server over a
    // half-configured optional integration trades a missing feature for an outage.
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings[0])).toContain('brave');
  });

  it('builds a provider when the vendor and key are both present', () => {
    const { logger } = recordingLogger();

    const provider = createSearchProvider(BASE_CONFIG, {
      fetch: stubFetch(jsonResponse('{}')).fetch,
      logger,
    });

    expect(provider).toBeDefined();
    expect(provider?.name).toBe('brave');
  });
});

describe('BraveSearchProvider', () => {
  it('maps the vendor document to results and sends the query and count', async () => {
    const { fetch, calls } = stubFetch(
      jsonResponse(
        braveBody([
          { title: 'EU AI Act', url: 'https://example.eu/ai-act', description: 'The regulation…' },
          { title: 'Timeline', url: 'https://example.eu/timeline', description: 'Key dates…' },
        ]),
      ),
    );
    const { logger } = recordingLogger();

    const provider = new BraveSearchProvider(BASE_CONFIG, { fetch, logger });
    const results = await provider.search({ query: 'EU AI Act obligations', maxResults: 3 });

    expect(results).toEqual([
      { title: 'EU AI Act', url: 'https://example.eu/ai-act', snippet: 'The regulation…' },
      { title: 'Timeline', url: 'https://example.eu/timeline', snippet: 'Key dates…' },
    ]);

    const sent = new URL(calls[0]!.url);
    expect(sent.pathname).toBe('/res/v1/web/search');
    expect(sent.searchParams.get('q')).toBe('EU AI Act obligations');
    expect(sent.searchParams.get('count')).toBe('3');
    expect((calls[0]!.init?.headers as Record<string, string>)['x-subscription-token']).toBe('test-key');
  });

  it('drops a result that has no URL', async () => {
    const { logger } = recordingLogger();
    const { fetch } = stubFetch(
      jsonResponse(
        braveBody([
          { title: 'No URL here', description: '…' },
          { title: 'Good', url: 'https://example.eu/ok', description: '…' },
        ]),
      ),
    );

    const results = await new BraveSearchProvider(BASE_CONFIG, { fetch, logger }).search({ query: 'q' });

    // A result with no URL cannot be cited, and an unciteable source is worse than one fewer: it
    // looks like evidence.
    expect(results).toHaveLength(1);
    expect(results[0]!.url).toBe('https://example.eu/ok');
  });

  it('treats a reply with no `web.results` as an empty search, not a parse failure', async () => {
    const { logger } = recordingLogger();
    const { fetch } = stubFetch(jsonResponse('{"query":{"original":"q"}}'));

    const results = await new BraveSearchProvider(BASE_CONFIG, { fetch, logger }).search({ query: 'q' });

    expect(results).toEqual([]);
  });

  it('throws on a non-2xx status instead of reporting no results', async () => {
    const { logger } = recordingLogger();
    const { fetch } = stubFetch(jsonResponse('{"error":"invalid token"}', 401));

    await expect(
      new BraveSearchProvider(BASE_CONFIG, { fetch, logger }).search({ query: 'q' }),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });

  it('includes the status in the failure, because 401 and 429 need different fixes', async () => {
    const { logger } = recordingLogger();
    const { fetch } = stubFetch(jsonResponse('{"error":"slow down"}', 429));

    await expect(
      new BraveSearchProvider(BASE_CONFIG, { fetch, logger }).search({ query: 'q' }),
    ).rejects.toMatchObject({ details: { status: 429 } });
  });

  it('throws on a non-JSON body', async () => {
    const { logger } = recordingLogger();
    const { fetch } = stubFetch(jsonResponse('<html>maintenance</html>'));

    await expect(
      new BraveSearchProvider(BASE_CONFIG, { fetch, logger }).search({ query: 'q' }),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });

  it('wraps a network failure rather than letting it escape as a raw error', async () => {
    const { logger } = recordingLogger();
    const { fetch } = stubFetch(new Error('ECONNREFUSED'));

    await expect(
      new BraveSearchProvider(BASE_CONFIG, { fetch, logger }).search({ query: 'q' }),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });

  it('refuses a response larger than the cap instead of truncating it', async () => {
    const { logger } = recordingLogger();
    const { fetch } = stubFetch(jsonResponse(braveBody([{ title: 'x'.repeat(500), url: 'https://e.eu/a' }])));

    await expect(
      new BraveSearchProvider({ ...BASE_CONFIG, maxResponseBytes: 100 }, { fetch, logger }).search({
        query: 'q',
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });

  it('clamps a requested count to the ceiling and floors it at one', async () => {
    const { logger } = recordingLogger();

    const over = stubFetch(jsonResponse('{}'));
    await new BraveSearchProvider(BASE_CONFIG, { fetch: over.fetch, logger }).search({
      query: 'q',
      maxResults: 500,
    });
    expect(new URL(over.calls[0]!.url).searchParams.get('count')).toBe('20');

    const under = stubFetch(jsonResponse('{}'));
    await new BraveSearchProvider(BASE_CONFIG, { fetch: under.fetch, logger }).search({
      query: 'q',
      maxResults: 0,
    });
    expect(new URL(under.calls[0]!.url).searchParams.get('count')).toBe('1');
  });

  it('falls back to the deployment default when the caller asks for nothing', async () => {
    const { logger } = recordingLogger();
    const { fetch, calls } = stubFetch(jsonResponse('{}'));

    await new BraveSearchProvider(BASE_CONFIG, { fetch, logger }).search({ query: 'q' });

    expect(new URL(calls[0]!.url).searchParams.get('count')).toBe('5');
  });

  it('stops at the limit even when the vendor returns more', async () => {
    const { logger } = recordingLogger();
    const { fetch } = stubFetch(
      jsonResponse(
        braveBody([
          { title: 'a', url: 'https://e.eu/1' },
          { title: 'b', url: 'https://e.eu/2' },
          { title: 'c', url: 'https://e.eu/3' },
        ]),
      ),
    );

    const results = await new BraveSearchProvider(
      { ...BASE_CONFIG, maxResultsCeiling: 2 },
      { fetch, logger },
    ).search({ query: 'q', maxResults: 2 });

    expect(results).toHaveLength(2);
  });
});

describe('parseBraveResults', () => {
  it('falls back to the URL as the title and empty snippet when the vendor omits them', () => {
    const results = parseBraveResults(JSON.stringify({ web: { results: [{ url: 'https://e.eu/a' }] } }), 5);

    expect(results).toEqual([{ url: 'https://e.eu/a', title: 'https://e.eu/a', snippet: '' }]);
  });

  it('skips entries that are not objects', () => {
    const results = parseBraveResults(
      JSON.stringify({ web: { results: [null, 'nope', 42, { url: 'https://e.eu/ok' }] } }),
      5,
    );

    expect(results).toHaveLength(1);
  });

  it('treats a non-object document as an error rather than as no results', () => {
    // `[]` parses but has no `web.results`, and returning "no results" for a document that is not
    // the vendor's shape would hide a broken integration behind an empty answer.
    expect(parseBraveResults('[]', 5)).toEqual([]);
    expect(() => parseBraveResults('not json', 5)).toThrow();
  });
});
