/**
 * The sidebar.
 *
 * ## Why this file exists
 *
 * The sidebar is now the *only* surface in the product that is always on screen, and it is where
 * three separate things meet: the conversation list (data), the two link groups (navigation), and
 * the way into Settings. It replaced two components that each had their own tests — the work panel
 * and the settings card — and those tests did not survive the merge unchanged, because the
 * assertions that mattered were about a structure that no longer exists ("the destinations are not
 * in the panel", "the card opens on Escape").
 *
 * What is asserted here is what the component's own comments claim:
 *
 *  - the link groups are `SIDEBAR_GROUPS` exactly, and the nine destinations that moved into
 *    Settings are **absent** — the move is the point, so both halves are asserted;
 *  - conversations are grouped under the headings the design names, with a compact age;
 *  - a disabled or uncomputed schedule cannot appear, because there is no job list here at all;
 *  - a failed list read says so instead of rendering as an empty list;
 *  - a filter that matches nothing says *that*, rather than reporting an empty workspace;
 *  - the filter narrows the link groups too, because the input sits above both.
 *
 * Requests are stubbed at `fetch` rather than by mocking the query hooks, so the query keys, the
 * envelope shapes and the grouping all run for real. An unstubbed request throws.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { ChatSessionSummary } from '@nexs/shared';
import { SIDEBAR_GROUPS, SETTINGS_DIRECTORY } from '../../lib/navigation';
import { PIN_STORAGE_KEY } from '../../lib/pins';
import { Sidebar } from './Sidebar';

// ── fixtures ──────────────────────────────────────────────────────────────────

const NOW = new Date(2026, 8, 21, 9, 0, 0);

/** A local-time Date as the ISO string the API sends. */
function at(year: number, month: number, day: number, hour = 9): string {
  return new Date(year, month, day, hour).toISOString();
}

function session(id: string, title: string | null, updatedAt: string): ChatSessionSummary {
  return {
    id,
    title,
    agentId: null,
    createdAt: updatedAt,
    updatedAt,
    messageCount: 2,
    lastMessageAt: updatedAt,
  };
}

// ── the API stub ──────────────────────────────────────────────────────────────

interface StubRoute {
  status?: number;
  body?: unknown;
}

function stubApi(routes: Record<string, StubRoute>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const route = routes[`${method} ${url}`];
      // Loud, not silent: a sidebar that quietly fetched something unexpected should fail here
      // rather than render a plausible blank column.
      if (route === undefined) throw new Error(`unstubbed request: ${method} ${url}`);

      const status = route.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        statusText: status === 200 ? 'OK' : 'Request failed',
        text: async () => (route.body === undefined ? '' : JSON.stringify(route.body)),
      };
    }),
  );
}

/**
 * Everything the sidebar reads.
 *
 * One route. The sidebar makes exactly one request — the conversation list — which is the whole
 * argument for it being one component: the account, the notifications and the theme are panels in
 * Settings and cost nothing until you open them.
 */
function defaultRoutes(over: Record<string, StubRoute> = {}): Record<string, StubRoute> {
  return {
    'GET /api/chat/sessions': { body: { data: [] } },
    ...over,
  };
}

/** Where the router ended up, so a navigation can be asserted without leaving the component. */
function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location">{`${location.pathname}${location.search}`}</span>;
}

function renderSidebar(initialEntry = '/chat'): void {
  const client = new QueryClient({
    // A retry would turn a deliberate 500 into a slow test that passes for the wrong reason.
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Sidebar />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The `<section>` whose disclosure button is this label. */
function group(label: string): HTMLElement {
  const toggle = screen.getByRole('button', { name: new RegExp(`^${label}`, 'i') });
  const owner = toggle.closest('section');
  if (owner === null) throw new Error(`no section for ${label}`);
  return owner;
}

/** The user-event instance, wired to the fake clock the suite installs. */
function user() {
  return userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  // `usePins` caches its snapshot at module scope and only drops it on a `storage` event, which is
  // also what makes pinning in a second tab work. Dispatching one is how a test starts from a
  // known set — and it exercises the same path the browser would.
  window.localStorage.clear();
  window.dispatchEvent(new StorageEvent('storage', { key: PIN_STORAGE_KEY }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ── the link groups ───────────────────────────────────────────────────────────

describe('the link groups', () => {
  it('renders SIDEBAR_GROUPS exactly, in order', async () => {
    stubApi(defaultRoutes());
    renderSidebar();

    await screen.findByPlaceholderText(/^Filter/);

    // Driven off the constant rather than a literal, so a destination added to the tree and
    // forgotten here fails this test instead of becoming reachable only by typing its URL.
    for (const section of SIDEBAR_GROUPS) {
      const owner = group(section.title);
      expect(
        within(owner)
          .getAllByRole('link')
          .map((link) => link.getAttribute('href')),
      ).toEqual(section.items.map((item) => item.path));

      for (const item of section.items) {
        expect(owner.textContent).toContain(item.label);
      }
    }
  });

  it('lists every sidebar destination once and no other', async () => {
    stubApi(defaultRoutes());
    renderSidebar();

    await screen.findByPlaceholderText(/^Filter/);

    const sidebarPaths = SIDEBAR_GROUPS.flatMap((section) =>
      section.items.map((item) => item.path),
    );

    const rendered = screen
      .getAllByRole('link')
      .map((link) => link.getAttribute('href'))
      .filter((href): href is string => href !== null);

    for (const path of sidebarPaths) {
      expect(rendered.filter((href) => href === path)).toHaveLength(1);
    }

    // And the nine that moved into Settings are not here. This is the half of the assertion that
    // would otherwise go untested: the column is only an index if it is not also the directory.
    for (const item of SETTINGS_DIRECTORY) {
      expect(rendered).not.toContain(item.path);
    }
  });

  it('marks the destination you are on, including for a nested route', async () => {
    stubApi(defaultRoutes());
    renderSidebar('/tools/t1');

    // The router matches on segment boundaries and picks the most specific route, so `/tools/t1`
    // lights up Tools — the rule this used to implement by hand.
    const tools = await screen.findByRole('link', { name: 'Tools' });
    expect(tools.getAttribute('aria-current')).toBe('page');

    // …and only that one.
    const current = screen.getAllByRole('link').filter((link) => link.getAttribute('aria-current'));
    expect(current).toHaveLength(1);
  });

  it('keeps the way into Settings in the footer', async () => {
    stubApi(defaultRoutes());
    renderSidebar();

    const settings = await screen.findByRole('link', { name: 'Settings' });
    expect(settings.getAttribute('href')).toBe('/settings');
  });
});

// ── the conversation list ─────────────────────────────────────────────────────

describe('the conversation list', () => {
  it('groups conversations under the design headings with a compact age', async () => {
    stubApi(
      defaultRoutes({
        'GET /api/chat/sessions': {
          body: {
            data: [
              session('s1', 'Friendly greeting #4', at(2026, 8, 21, 7)),
              session('s2', 'Resolve missing google-workspace scope', at(2026, 8, 20, 22)),
              session('s3', 'hi', at(2026, 4, 17)),
            ],
          },
        },
      }),
    );
    renderSidebar();

    expect(await screen.findByText('Friendly greeting #4')).toBeTruthy();
    expect(within(group('Today')).getByText('Friendly greeting #4')).toBeTruthy();
    expect(
      within(group('Yesterday')).getByText('Resolve missing google-workspace scope'),
    ).toBeTruthy();
    expect(within(group('May')).getByText('hi')).toBeTruthy();

    // `2h` and not `2 hours ago` — a sidebar row has room for a title or an age, not both.
    expect(within(group('Today')).getByText('2h')).toBeTruthy();
    expect(within(group('May')).getByText('127d')).toBeTruthy();
  });

  it('names an unnamed conversation rather than rendering a blank row', async () => {
    stubApi(
      defaultRoutes({
        'GET /api/chat/sessions': { body: { data: [session('s1', null, at(2026, 8, 21, 8))] } },
      }),
    );
    renderSidebar();

    expect(await screen.findByText('Untitled')).toBeTruthy();
  });

  it('opens a conversation by putting it in the URL', async () => {
    stubApi(
      defaultRoutes({
        'GET /api/chat/sessions': { body: { data: [session('s1', 'Alpha', at(2026, 8, 21, 8))] } },
      }),
    );
    renderSidebar();

    await user().click(await screen.findByText('Alpha'));
    expect(screen.getByTestId('location').textContent).toBe('/chat?session=s1');
  });

  it('marks the conversation the URL names as the active one', async () => {
    stubApi(
      defaultRoutes({
        'GET /api/chat/sessions': {
          body: {
            data: [
              session('s1', 'Alpha', at(2026, 8, 21, 8)),
              session('s2', 'Beta', at(2026, 8, 21, 7)),
            ],
          },
        },
      }),
    );
    renderSidebar('/chat?session=s2');

    const beta = (await screen.findByText('Beta')).closest('.session-row');
    const alpha = screen.getByText('Alpha').closest('.session-row');
    expect(beta?.getAttribute('data-active')).toBe('true');
    expect(alpha?.getAttribute('data-active')).toBeNull();
  });

  it('shows a pinned conversation in its own section, and keeps it in the dated list too', async () => {
    window.localStorage.setItem(PIN_STORAGE_KEY, JSON.stringify(['s1']));
    window.dispatchEvent(new StorageEvent('storage', { key: PIN_STORAGE_KEY }));
    stubApi(
      defaultRoutes({
        'GET /api/chat/sessions': { body: { data: [session('s1', 'Alpha', at(2026, 8, 21, 8))] } },
      }),
    );
    renderSidebar();

    // Twice on purpose: a pin is a second view of a conversation, not a move. Removing it from
    // the dated list would make pinning something feel like filing it away.
    expect((await screen.findAllByText('Alpha')).length).toBe(2);
    expect(within(group('Pinned')).getByText('Alpha')).toBeTruthy();
    expect(within(group('Today')).getByText('Alpha')).toBeTruthy();
  });

  it('says a filter matched nothing rather than reporting an empty workspace', async () => {
    stubApi(
      defaultRoutes({
        'GET /api/chat/sessions': { body: { data: [session('s1', 'Alpha', at(2026, 8, 21, 8))] } },
      }),
    );
    renderSidebar();

    await user().type(await screen.findByPlaceholderText(/^Filter/), 'zzzz');
    expect(await screen.findByText(/No conversation matches/)).toBeTruthy();
    // The workspace is not empty and the sidebar must not say it is.
    expect(screen.queryByText(/No conversations yet/)).toBeNull();
  });

  it('reports a failed read as a failure, not as an empty list', async () => {
    stubApi(defaultRoutes({ 'GET /api/chat/sessions': { status: 500 } }));
    renderSidebar();

    expect(await screen.findByText('Could not load conversations.')).toBeTruthy();
    expect(screen.queryByText(/No conversations yet/)).toBeNull();
  });
});

// ── the filter over the whole column ──────────────────────────────────────────

describe('the filter', () => {
  it('narrows the link groups as well as the list, and drops a group that empties', async () => {
    stubApi(defaultRoutes());
    renderSidebar();

    await user().type(await screen.findByPlaceholderText(/^Filter/), 'MCP');

    const capabilities = group('Capabilities');
    expect(
      within(capabilities)
        .getAllByRole('link')
        .map((link) => link.getAttribute('href')),
    ).toEqual(['/mcp']);

    // Every Schedulings row is filtered out, so the heading goes with them: an empty group is a
    // heading over a gap, and the honest reading of an empty column is "nothing matches".
    expect(screen.queryByRole('button', { name: /^Schedulings/ })).toBeNull();
  });

  it('scopes its empty message to conversations, not to the column', async () => {
    // One conversation, so the block is empty because of the *filter* rather than because the
    // workspace is new — the two cases have different messages and this is the second one.
    stubApi(
      defaultRoutes({
        'GET /api/chat/sessions': { body: { data: [session('s1', 'Alpha', at(2026, 8, 21, 8))] } },
      }),
    );
    renderSidebar();

    await user().type(await screen.findByPlaceholderText(/^Filter/), 'MCP');

    // The Sessions block is empty and says so about *conversations*. It must not say the column is
    // empty: there is a match sitting right below it, and a message that contradicted the visible
    // screen would be the kind of wrong this codebase refuses elsewhere.
    expect(await screen.findByText('No conversation matches “MCP”.')).toBeTruthy();
    expect(within(group('Capabilities')).getAllByRole('link')).toHaveLength(1);
  });

  it('is a filter, not a ranker — the list keeps its time order', async () => {
    stubApi(
      defaultRoutes({
        'GET /api/chat/sessions': {
          body: {
            data: [
              session('s1', 'Alpha', at(2026, 8, 21, 8)),
              session('s2', 'Beta', at(2026, 8, 21, 7)),
            ],
          },
        },
      }),
    );
    renderSidebar();

    await user().type(await screen.findByPlaceholderText(/^Filter/), 'a');

    const titles = screen
      .getAllByText(/^(Alpha|Beta)$/)
      .map((node) => node.textContent);
    // `Alpha` was touched most recently and comes first. Ranking by match quality would put
    // `Beta` (one `a`) behind `Alpha` (two) or the reverse depending on the scorer, and either
    // way the position in time — which is how a person recognises a conversation — is gone.
    expect(titles).toEqual(['Alpha', 'Beta']);
  });
});

// ── the lists that left ───────────────────────────────────────────────────────

describe('what is no longer in the column', () => {
  it('has no agents list and no jobs preview', async () => {
    stubApi(defaultRoutes());
    renderSidebar();

    await screen.findByPlaceholderText(/^Filter/);

    // Agents is a row in Settings now; the jobs preview duplicated `/schedules` in the one column
    // that is meant to be an index. Neither class can appear, because neither component exists.
    expect(document.querySelectorAll('.agent-row')).toHaveLength(0);
    expect(document.querySelectorAll('.job-row')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Agents' })).toBeNull();
    expect(screen.queryByText(/Scheduled jobs/)).toBeNull();
  });
});
