/**
 * The catalogue hooks' wire contract.
 *
 * ## Why this file exists
 *
 * Every list schema in `@nexs/shared` is `.strict()`, so a query-string key the server does not
 * recognise is a `400 VALIDATION_ERROR` — not an ignored parameter, and not an empty result. The
 * client used to send `?enabled=true` to `/api/models` and `?search=…` to `/api/tools`. Both are
 * names other schemas legitimately use — `listSchedulesSchema` really does take `enabled` — so
 * neither looked wrong where it was written. Both 400'd on every mount, and both surfaces then
 * rendered their empty state, which reads exactly like "no rows".
 *
 * The fix renamed the filters to the server's names. This file is what keeps them renamed: the
 * declared filter fields are parsed against the real schema, so a rename on *either* side fails
 * here rather than silently emptying a page.
 *
 * The negative cases at the bottom pin the trap itself, including the fact that `enabled` is
 * correct for schedules — the rule is per-resource, not "this word is banned".
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { listModelsSchema, listSchedulesSchema, listToolsSchema } from '@nexs/shared';
import type { ModelFilters, ToolFilters } from './queries';
import { useModels, useSchedules, useTools } from './queries';

// ── the API stub ──────────────────────────────────────────────────────────────

/** Every request the hooks sent, so a test can assert what actually went over the wire. */
let sent: string[] = [];

const ENVELOPES: Record<string, unknown> = {
  '/api/models': { models: [] },
  '/api/tools': { tools: [] },
  '/api/schedules': { schedules: [], total: 0 },
};

function stubApi(): void {
  sent = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = typeof input === 'string' ? input : String(input);
      sent.push(url);

      const path = new URL(url, 'http://localhost').pathname;
      const body = ENVELOPES[path];
      if (body === undefined) throw new Error(`unstubbed request: ${url}`);

      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify(body),
      };
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A fresh client per test: a shared cache would serve the second hook from the first's entry. */
function wrapper(): ({ children }: { children: ReactNode }) => ReactNode {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

// ── reading what went out ─────────────────────────────────────────────────────

function onlyRequest(): URL {
  if (sent.length !== 1) throw new Error(`expected exactly one request, saw ${sent.length}: ${sent.join(', ')}`);
  return new URL(sent[0]!, 'http://localhost');
}

/** The parameters as the server's `parseQuery` sees them: strings, straight off the URL. */
function wireParams(url: URL): Record<string, string> {
  return Object.fromEntries(url.searchParams.entries());
}

// ── the fields each interface declares ────────────────────────────────────────
//
// `Required<…>` is the point, not decoration: adding a field to `ModelFilters` without teaching
// `listModelsSchema` about it breaks this file at compile time, which is the cheapest possible
// place to find out.

const ALL_MODEL_FILTERS: Required<ModelFilters> = {
  providerId: 'provider-1',
  type: 'chat',
  status: 'available',
  enabledOnly: true,
  limit: 25,
  offset: 0,
};

const ALL_TOOL_FILTERS: Required<ToolFilters> = {
  type: 'native',
  source: 'builtin',
  status: 'enabled',
  mcpServerId: 'mcp-1',
  q: 'file',
};

// ── tests ─────────────────────────────────────────────────────────────────────

describe('the models query', () => {
  it('sends the enabled filter as `enabledOnly`, which is the name the schema knows', async () => {
    stubApi();
    renderHook(() => useModels({ enabledOnly: true }), { wrapper: wrapper() });

    await waitFor(() => expect(sent.length).toBe(1));

    const url = onlyRequest();
    expect(url.pathname).toBe('/api/models');
    expect(url.searchParams.get('enabledOnly')).toBe('true');
    // The regression, stated as an assertion.
    expect(url.searchParams.has('enabled')).toBe(false);
  });

  it('is accepted by `listModelsSchema` whatever combination of filters is used', async () => {
    stubApi();
    renderHook(() => useModels(ALL_MODEL_FILTERS), { wrapper: wrapper() });

    await waitFor(() => expect(sent.length).toBe(1));

    const parsed = listModelsSchema.safeParse(wireParams(onlyRequest()));
    // `success` first, so a failure prints the issue rather than just `false`.
    expect(parsed.success ? null : parsed.error.issues).toBeNull();
    expect(parsed.success && parsed.data.enabledOnly).toBe(true);
  });

  it('keeps an explicit `false`, which is a different query from omitting it', async () => {
    stubApi();
    renderHook(() => useModels({ enabledOnly: false }), { wrapper: wrapper() });

    await waitFor(() => expect(sent.length).toBe(1));

    const parsed = listModelsSchema.safeParse(wireParams(onlyRequest()));
    expect(parsed.success).toBe(true);
    // Not `undefined` — the URL said `false`, and the schema's `queryBoolean` must read it as
    // `false` rather than as the truthy string `'false'`.
    expect(parsed.success && parsed.data.enabledOnly).toBe(false);
  });

  it('sends no parameters at all when called bare', async () => {
    stubApi();
    renderHook(() => useModels(), { wrapper: wrapper() });

    await waitFor(() => expect(sent.length).toBe(1));

    expect(onlyRequest().search).toBe('');
  });
});

describe('the tools query', () => {
  it('sends the text filter as `q`, which is the name the schema knows', async () => {
    stubApi();
    renderHook(() => useTools({ q: 'file' }), { wrapper: wrapper() });

    await waitFor(() => expect(sent.length).toBe(1));

    const url = onlyRequest();
    expect(url.pathname).toBe('/api/tools');
    expect(url.searchParams.get('q')).toBe('file');
    expect(url.searchParams.has('search')).toBe(false);
  });

  it('is accepted by `listToolsSchema` whatever combination of filters is used', async () => {
    stubApi();
    renderHook(() => useTools(ALL_TOOL_FILTERS), { wrapper: wrapper() });

    await waitFor(() => expect(sent.length).toBe(1));

    const parsed = listToolsSchema.safeParse(wireParams(onlyRequest()));
    expect(parsed.success ? null : parsed.error.issues).toBeNull();
    expect(parsed.success && parsed.data.q).toBe('file');
  });
});

describe('the schedules query', () => {
  it('sends no filters, because the hook takes none', async () => {
    stubApi();
    renderHook(() => useSchedules(), { wrapper: wrapper() });

    await waitFor(() => expect(sent.length).toBe(1));

    const url = onlyRequest();
    expect(url.pathname).toBe('/api/schedules');
    expect(url.search).toBe('');
  });
});

describe('the trap, pinned', () => {
  it('refuses the two names this client used to send', () => {
    // If these ever start succeeding, someone relaxed `.strict()` — and with it the reason the
    // bug above was a 400 instead of a quietly wrong answer.
    expect(listModelsSchema.safeParse({ enabled: 'true' }).success).toBe(false);
    expect(listToolsSchema.safeParse({ search: 'file' }).success).toBe(false);
  });

  it('accepts `enabled` for schedules, so the rule is per-resource', () => {
    expect(listSchedulesSchema.safeParse({ enabled: 'true' }).success).toBe(true);
    // …and still refuses a name that is nobody's.
    expect(listSchedulesSchema.safeParse({ enabledOnly: 'true' }).success).toBe(false);
  });

  it('reads `false` as false, which is why `queryBoolean` is an enum and not a coercion', () => {
    const parsed = listModelsSchema.safeParse({ enabledOnly: 'false' });
    expect(parsed.success && parsed.data.enabledOnly).toBe(false);
    // `z.coerce.boolean()` would answer `true` here — the filter turning itself on.
    expect(Boolean('false')).toBe(true);
  });
});
